import { createElement, type ButtonHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HotelOffer, HotelRoompack } from '../actions';
import { encodeHotelKey } from './hotel-key';
import { HotelResultCard, HotelResultRates } from './hotel-result-card';
import { RATE_SELECTION_STORAGE_KEY, parseRateSelections } from './hotel-rate-selection';
import {
  NO_FILTERS,
  applyResultsFilters,
  resultHotelsOf,
  resultsFacets,
  type FilteredHotel,
  type ResultRate,
  type ResultsFilters,
} from './hotel-results-filters';
import { ResultsFiltersPanel } from './hotel-results-filters-panel';
import { HotelResultsMap } from './hotel-results-map';
import { detailLinkForOffer, type HotelDetailLink, type HotelStay } from './hotel-search-handoff';

/*
 * La tarjeta y el panel de filtros en su primer pintado: lo que el vendedor no puede pasar por alto
 * de una tarifa no reembolsable (pedido del founder del 2026-09-29) y que la divulgación de
 * proveedor se respeta.
 *
 * Sin navegador, el clic en «Reservar» se hace con el manejador que recibió el botón: el botón del
 * design system se reemplaza por uno que lo anota y pinta lo mismo que importa acá.
 */

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  toastError: vi.fn(),
  clicks: [] as Array<() => void>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('../../../../components/ui/button', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: ({
      onClick,
      className: _className,
      size: _size,
      variant: _variant,
      ...rest
    }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
      if (onClick) mocks.clicks.push(() => onClick({} as never));
      return h('button', rest);
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.clicks.length = 0;
});

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const noop = () => undefined;

function tarifa(id: string, saleMinor: number, extra: Partial<HotelRoompack> = {}): HotelRoompack {
  return {
    id,
    provider: { name: 'tbo-hotels', offerRef: `${id}-REF` },
    board: 'RO',
    rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: saleMinor, currency: 'COP' }, taxesDetail: [] },
    ...extra,
  };
}

const SOLO_NR: HotelOffer = {
  hotelId: '1',
  name: 'Hotel Solo No Reembolsable',
  stars: 3,
  address: 'Calle 10 # 5-72, La Candelaria',
  roompacks: [tarifa('A', 690_000_00), tarifa('B', 750_000_00, { board: 'BB' })],
};

function itemOf(offer: HotelOffer, showProvider = false): FilteredHotel {
  const [item] = applyResultsFilters(resultHotelsOf([offer], showProvider, NOW), NO_FILTERS);
  return item!;
}

function card(offer: HotelOffer, showProvider: boolean): string {
  return renderToStaticMarkup(
    createElement(HotelResultCard, {
      item: itemOf(offer, showProvider),
      photo: undefined,
      nights: 3,
      rooms: 1,
      stay: undefined,
      searchToken: undefined,
      showProvider,
    }),
  );
}

describe('HotelResultCard', () => {
  it('"No reembolsable" a la vista y el aviso de que el hotel no tiene ninguna reembolsable', () => {
    const html = card(SOLO_NR, false);
    expect(html).toContain('No reembolsable');
    expect(html).toContain('var(--color-warning)');
    expect(html).toContain(
      'Este hotel no tiene tarifas reembolsables para estas fechas: si se cancela, se cobra el 100 %.',
    );
  });

  it('precio por noche grande, el total de la estadía y la zona en vez del ID técnico', () => {
    const html = card(SOLO_NR, false);
    expect(html).toMatch(/230\.000(,00)?\s*COP/);
    expect(html).toMatch(/Total 3 noches:.*690\.000(,00)?\s*COP/);
    expect(html).toContain('Calle 10 # 5-72, La Candelaria');
    expect(html).not.toContain('ID 1');
    // El botón despliega habitaciones, y debajo dice cuántos tipos y cuántas tarifas hay.
    expect(html).toMatch(/>Ver habitaciones<svg/);
    expect(html).toMatch(
      /aria-describedby="([^"]+)".*<p id="\1"[^>]*>1 tipo de habitación · 2 tarifas<\/p>/,
    );
  });

  it('sin divulgación no hay pastilla de proveedor; con ella, la de la tarifa del precio', () => {
    expect(card(SOLO_NR, false)).not.toContain('Proveedor: ');
    expect(card(SOLO_NR, true)).toContain('Proveedor: ');
  });
});

function panel(filters: ResultsFilters): string {
  const hotels = resultHotelsOf([SOLO_NR], false, NOW);
  return renderToStaticMarkup(
    createElement(ResultsFiltersPanel, {
      facets: resultsFacets(hotels, filters, false),
      filters,
      onChange: noop,
    }),
  );
}

describe('HotelResultCard — "Nuevo"', () => {
  it('sólo los que llegaron con el último "Ver más hoteles" llevan la marca, fuera del título', () => {
    const nuevo = renderToStaticMarkup(
      createElement(HotelResultCard, {
        item: itemOf(SOLO_NR),
        photo: undefined,
        fresh: true,
        stay: undefined,
        searchToken: undefined,
        showProvider: false,
      }),
    );
    expect(nuevo).toContain('Nuevo');
    // El título dice sólo el nombre: el foco que llega a él no lee "Nuevo" como parte del hotel.
    expect(nuevo).toMatch(/<h3[^>]*>Hotel Solo No Reembolsable<\/h3>/);

    expect(card(SOLO_NR, false)).not.toContain('Nuevo');
  });
});

describe('ResultsFiltersPanel', () => {
  it('"Solo reembolsables" sin hoteles que mostrar no se puede marcar', () => {
    const html = panel(NO_FILTERS);
    expect(html).toMatch(/<input type="checkbox" disabled=""[^>]*\/>.*Solo reembolsables/);
  });

  it('marcado desde la URL aunque no deje hoteles: se puede desmarcar', () => {
    const html = panel({ ...NO_FILTERS, refundableOnly: true });
    const input = /<input type="checkbox"([^>]*)\/><span[^>]*>Solo reembolsables/.exec(html)?.[1];
    expect(input).toContain('checked=""');
    expect(input).not.toContain('disabled');
  });

  it('sin divulgación no hay sección de proveedor', () => {
    expect(panel(NO_FILTERS)).not.toContain('Proveedor');
  });

  it('el deslizador de precio dice su valor a un lector de pantalla', () => {
    const html = panel(NO_FILTERS);
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-valuetext="Sin tope"');
  });
});

// ───────────────────────── Reservar desde el listado ─────────────────────────

const SEARCH_ID = 'srch_01J9ZK4Q';
const SEARCH_TOKEN = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const STAY: HotelStay = {
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-13',
  rooms: [{ adults: 2, childrenAges: [] }],
  guestNationality: 'CO',
  refundableOnly: false,
};

/** Una tarifa de TBO tal como la deja el API: con el contexto de su búsqueda para el PreBook. */
function tarifaTbo(
  id: string,
  saleMinor: number,
  extra: Partial<HotelRoompack> = {},
): HotelRoompack {
  return tarifa(id, saleMinor, {
    provider: { name: 'tbo-hotels', offerRef: `${id}-REF`, raw: { searchId: SEARCH_ID } },
    ...extra,
  });
}

const REFUNDABLE = {
  refundable: true,
  status: 'fully_refundable',
  rules: [],
} as const satisfies HotelRoompack['cancellation'];

const TBO_HOTEL: HotelOffer = {
  hotelId: '1',
  name: 'Hotel Plaza TBO',
  stars: 4,
  address: 'Carrera 7 # 12-30',
  roompacks: [
    tarifaTbo('A', 690_000_00, { cancellation: REFUNDABLE }),
    tarifaTbo('B', 750_000_00, { board: 'BB' }),
  ],
};

function memoryStorage({ failOnWrite = false } = {}) {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failOnWrite) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
}

function rates(
  offer: HotelOffer,
  extra: {
    isExpired?: (rate: ResultRate) => boolean;
    nonRefundableBlocked?: boolean;
    stay?: HotelStay;
    nights?: number;
    rooms?: number;
    detailHref?: HotelDetailLink;
    showProvider?: boolean;
  } = {},
): string {
  const showProvider = extra.showProvider ?? false;
  return renderToStaticMarkup(
    createElement(HotelResultRates, {
      item: itemOf(offer, showProvider),
      isExpired: extra.isExpired ?? (() => false),
      nonRefundableBlocked: extra.nonRefundableBlocked ?? false,
      stay: 'stay' in extra ? extra.stay : STAY,
      searchToken: SEARCH_TOKEN,
      showProvider,
      ...(extra.nights === undefined ? {} : { nights: extra.nights }),
      ...(extra.rooms === undefined ? {} : { rooms: extra.rooms }),
      ...(extra.detailHref === undefined ? {} : { detailHref: extra.detailHref }),
    }),
  );
}

/** Los botones «Reservar» pintados, con su atributo `disabled` si lo llevan. */
function bookButtons(html: string): string[] {
  return html.match(/<button[^>]*>Reservar<span class="sr-only">[^<]*<\/span><\/button>/g) ?? [];
}

describe('HotelResultRates — Reservar desde la tarjeta', () => {
  it('la tarjeta de TBO desplegada tiene un «Reservar» por tarifa, con la tarifa en su nombre', () => {
    const html = rates(TBO_HOTEL);
    const buttons = bookButtons(html);
    expect(buttons).toHaveLength(2);
    expect(buttons.some((b) => b.includes('disabled'))).toBe(false);
    // Con el hotel: en la página hay varios «Reservar» de varios hoteles.
    expect(buttons[0]).toMatch(
      /: Solo alojamiento, Doble estándar, 690\.000(,00)?\s*COP, en Hotel Plaza TBO<\/span>/,
    );
    expect(html).toContain(
      'Las condiciones de cancelación exactas y el precio final se confirman al revisar la tarifa, antes de cargar los huéspedes.',
    );
  });

  it('el clic guarda la tarifa en "hoteles:tarifas" y va al checkout', () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });

    rates(TBO_HOTEL);
    expect(mocks.clicks).toHaveLength(2);
    mocks.clicks[0]!();

    expect(mocks.push).toHaveBeenCalledTimes(1);
    const href = mocks.push.mock.calls[0]?.[0] as string;
    const token = /^\/hoteles\/checkout\?tarifa=([^&]+)$/.exec(href)?.[1];
    expect(token).toBeDefined();
    const saved = parseRateSelections(storage.getItem(RATE_SELECTION_STORAGE_KEY))[token!];
    expect(saved).toMatchObject({
      reference: { providerCode: 'tbo-hotels', searchId: SEARCH_ID, offerRef: 'A-REF' },
      hotelKey: encodeHotelKey([{ provider: 'tbo-hotels', hotelId: '1' }]),
      searchToken: SEARCH_TOKEN,
      stay: STAY,
      hotel: { name: 'Hotel Plaza TBO', address: 'Carrera 7 # 12-30' },
      shownSale: { amountMinor: 690_000_00, currency: 'COP' },
    });
  });

  it('sin almacenamiento, avisa y se queda en la lista', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage({ failOnWrite: true }) });

    rates(TBO_HOTEL);
    mocks.clicks[0]!();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('una tarifa sin contexto de búsqueda (Despegar) dice que no se reserva desde el panel', () => {
    const html = rates({
      ...TBO_HOTEL,
      roompacks: [tarifaTbo('A', 690_000_00), tarifa('D', 700_000_00)],
    });
    expect(bookButtons(html)).toHaveLength(1);
    expect(html).toContain('Esta tarifa todavía no se puede reservar desde el panel.');
  });

  it('sin la estadía de la búsqueda, ninguna se lleva al checkout ni sale la nota', () => {
    const html = rates(TBO_HOTEL, { stay: undefined });
    expect(bookButtons(html)).toHaveLength(0);
    expect(html).not.toContain('antes de cargar los huéspedes');
  });

  it('la tarifa vencida sale con el botón deshabilitado', () => {
    const html = rates(TBO_HOTEL, { isExpired: (r) => r.row.pack.id === 'B' });
    const [a, b] = bookButtons(html);
    expect(a).not.toContain('disabled');
    expect(b).toContain('disabled=""');
    expect(html).toContain('Vencida');
  });

  it('con las no reembolsables bloqueadas, esas no tienen botón y se marcan', () => {
    const html = rates(TBO_HOTEL, { nonRefundableBlocked: true });
    expect(bookButtons(html)).toHaveLength(1);
    expect(html).toContain('No disponible para tu agencia');
  });

  it('si todas quedan bloqueadas, tampoco sale la nota de qué pasa al reservar', () => {
    const html = rates(
      { ...TBO_HOTEL, roompacks: [tarifaTbo('B', 750_000_00)] },
      { nonRefundableBlocked: true },
    );
    expect(bookButtons(html)).toHaveLength(0);
    expect(html).not.toContain('antes de cargar los huéspedes');
  });
});

// ───────────────────────── Habitaciones por tipo ─────────────────────────

/** Una tarifa de TBO de UNA habitación con nombre, id de tipo y lo que haga falta. */
function plan(
  id: string,
  saleMinor: number,
  name: string,
  extra: Partial<HotelRoompack> = {},
  room: Partial<HotelRoompack['rooms'][number]> = {},
): HotelRoompack {
  return tarifaTbo(id, saleMinor, {
    rooms: [{ name, reference: 1, bedOptions: [], ...room }],
    ...extra,
  });
}

/** Cinco tipos de habitación; el primero, con cuatro planes. */
const CINCO_TIPOS: HotelOffer = {
  ...TBO_HOTEL,
  roompacks: [
    plan(
      'E1',
      600_000_00,
      'Estándar',
      {},
      {
        roomTypeId: '10',
        bedOptions: ['1 cama king'],
        occupancy: { adults: 2, childrenAges: [] },
      },
    ),
    plan('E2', 650_000_00, 'Estándar', { board: 'BB' }, { roomTypeId: '10' }),
    plan('E3', 700_000_00, 'ESTANDAR', { board: 'HB' }),
    plan(
      'E4',
      750_000_00,
      'Estándar',
      { board: 'AI', cancellation: REFUNDABLE },
      {
        roomTypeId: '10',
      },
    ),
    plan('S', 800_000_00, 'Superior', {}, { roomTypeId: '20' }),
    plan('D', 900_000_00, 'Deluxe', {}, { roomTypeId: '30' }),
    plan('J', 1_000_000_00, 'Junior Suite', {}, { roomTypeId: '40' }),
    plan('P', 1_200_000_00, 'Suite Presidencial', {}, { roomTypeId: '50' }),
  ],
};

/** Los títulos de los grupos, en orden, con el nivel de su encabezado. */
function groupHeadings(html: string): string[] {
  return [
    ...html.matchAll(
      /<section aria-labelledby="([^"]+)"[^>]*>.*?<(h\d) id="\1"[^>]*>([^<]*)<\/\2>/g,
    ),
  ].map((m) => `${m[2]}:${m[3]}`);
}

describe('HotelResultRates — habitaciones por tipo', () => {
  it('tres tipos a la vista, cada uno con su encabezado, y el enlace a la ficha para el resto', () => {
    const html = rates(CINCO_TIPOS, {
      nights: 3,
      rooms: 1,
      detailHref: detailLinkForOffer(CINCO_TIPOS, SEARCH_TOKEN),
    });
    // Bajo el nombre del hotel (h3) de la tarjeta.
    expect(groupHeadings(html)).toEqual(['h4:Estándar', 'h4:Superior', 'h4:Deluxe']);
    expect(html).not.toContain('Junior Suite');
    expect(html).toMatch(
      /<a [^>]*target="_blank"[^>]*href="\/hoteles\/[^"?]+\?busqueda=[^"]+"[^>]*>Ver los 5 tipos de habitación en la ficha<svg/,
    );
    expect(html).toContain(
      '<span class="sr-only"> de Hotel Plaza TBO (se abre en otra pestaña)</span>',
    );
    expect(html).not.toContain('Ver todos los tipos');
  });

  it('sin ficha, «Ver todos los tipos» los despliega en la tarjeta', () => {
    const html = rates(CINCO_TIPOS, { nights: 3 });
    expect(html).toMatch(
      /<button type="button" aria-expanded="false" aria-controls="[^"]+"[^>]*>Ver todos los tipos<svg/,
    );
    expect(html).not.toContain('en la ficha');
  });

  it('el tipo dice camas y ocupación, su «desde» por noche y el total de la estadía', () => {
    const html = rates(CINCO_TIPOS, { nights: 3, rooms: 1 });
    expect(html).toContain('1 cama king · 2 adultos');
    expect(html).toMatch(/desde <span[^>]*>200\.000(,00)?\s*COP<\/span> por noche/);
    expect(html).toMatch(/Total 3 noches: <span[^>]*>600\.000(,00)?\s*COP<\/span>/);
  });

  it('tres planes por tipo con su «Reservar»; el resto, detrás de «Ver 1 tarifa más»', () => {
    const html = rates(CINCO_TIPOS, { nights: 3 });
    const estandar = /<section[^>]*>.*?<\/section>/.exec(html)?.[0] ?? '';
    const buttons = bookButtons(estandar);
    expect(buttons).toHaveLength(3);
    // El que no trae id se suma por su nombre al tipo 10; el cuarto plan espera.
    expect(estandar).toContain('Media pensión');
    expect(estandar).not.toContain('Todo incluido');
    expect(estandar).toMatch(
      /<button type="button" aria-expanded="false" aria-controls="[^"]+"[^>]*>Ver 1 tarifa más de esta habitación<svg/,
    );
    expect(buttons[0]).toMatch(
      /: Solo alojamiento, Estándar, 600\.000(,00)?\s*COP, en Hotel Plaza TBO<\/span>/,
    );
    // Cada plan con su precio por noche y su total.
    expect(estandar).toMatch(
      />200\.000(,00)?\s*COP<\/p><p[^>]*>por noche<\/p><p[^>]*>Total 600\.000(,00)?\s*COP<\/p>/,
    );
  });

  it('varias habitaciones: «2 × Doble», una línea por habitación y el total de las dos', () => {
    const doble = (id: string, sale: number, board: HotelRoompack['board']) =>
      tarifaTbo(id, sale, {
        board,
        rooms: [
          {
            name: 'Doble',
            reference: 1,
            bedOptions: [],
            occupancy: { adults: 2, childrenAges: [] },
          },
          {
            name: 'Doble',
            reference: 2,
            bedOptions: [],
            occupancy: { adults: 1, childrenAges: [5] },
          },
        ],
      });
    const html = rates(
      { ...TBO_HOTEL, roompacks: [doble('A', 1_200_000_00, 'RO'), doble('B', 1_300_000_00, 'BB')] },
      { nights: 3, rooms: 2 },
    );
    expect(groupHeadings(html)).toEqual(['h4:2 × Doble']);
    expect(html).toContain('Habitación 1: Doble · 2 adultos');
    expect(html).toContain('Habitación 2: Doble · 1 adulto, 1 niño (5 años)');
    expect(html).toMatch(/Total 3 noches · 2 habitaciones: <span[^>]*>1\.200\.000(,00)?\s*COP/);
    expect(bookButtons(html)).toHaveLength(2);
  });

  it('promoción y cargos en el hotel a la vista; el detalle, en «Ver condiciones»', () => {
    const html = rates(
      {
        ...TBO_HOTEL,
        roompacks: [
          plan(
            'A',
            690_000_00,
            'Doble',
            {
              atPropertyCharges: [
                { description: 'Tasa municipal', amount: { amountMinor: 20_00, currency: 'USD' } },
              ],
              inclusionText: 'Wifi',
            },
            { promotions: ['10 % de descuento'] },
          ),
        ],
      },
      { nights: 3 },
    );
    expect(html).toContain('10 % de descuento');
    expect(html).toContain('Cargos en el hotel');
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Ver condiciones<span class="sr-only">/);
    expect(html).toMatch(
      /<details.*Incluye: Wifi.*A pagar en el hotel, aparte del total.*Tasa municipal.*<\/details>/,
    );
  });

  it('un plan sin nada que agregar no abre «Ver condiciones»', () => {
    expect(rates(TBO_HOTEL, { nights: 3 })).not.toContain('Ver condiciones');
  });

  it('dos proveedores en el mismo tipo: cada plan con la pastilla de SU proveedor', () => {
    const html = rates(
      {
        ...TBO_HOTEL,
        roompacks: [
          plan('T', 690_000_00, 'Doble estándar'),
          tarifa('D', 700_000_00, {
            provider: { name: 'despegar-hotels', offerRef: 'D-REF' },
            rooms: [{ name: 'DOBLE ESTÁNDAR', reference: 1, bedOptions: [] }],
          }),
        ],
      },
      { nights: 3, showProvider: true },
    );
    expect(groupHeadings(html)).toEqual(['h4:Doble estándar']);
    expect(html).toContain('TBO Holidays');
    expect(html).toContain('Despegar Hotels');
  });
});

describe('HotelResultCard — botones', () => {
  it('«Ver hotel y habitaciones» como botón secundario, en otra pestaña', () => {
    const html = renderToStaticMarkup(
      createElement(HotelResultCard, {
        item: itemOf(TBO_HOTEL),
        photo: undefined,
        nights: 3,
        rooms: 1,
        detailHref: detailLinkForOffer(TBO_HOTEL, SEARCH_TOKEN),
        stay: STAY,
        searchToken: SEARCH_TOKEN,
        showProvider: false,
      }),
    );
    expect(html).toContain('Ver habitaciones');
    expect(html).toMatch(
      /<a [^>]*target="_blank"[^>]*>Ver hotel y habitaciones<svg[^>]*>.*?<\/svg><span class="sr-only"> Hotel Plaza TBO \(se abre en otra pestaña\)<\/span><\/a>/,
    );
    expect(html).toContain(`busqueda=${SEARCH_TOKEN}`);
    // Plegada no pinta las tarifas: el «Reservar» aparece al desplegarlas.
    expect(bookButtons(html)).toHaveLength(0);
  });
});

describe('HotelResultsMap', () => {
  it('cada hotel lleva a su ficha con «Ver hotel», en otra pestaña', () => {
    const html = renderToStaticMarkup(
      createElement(HotelResultsMap, {
        items: [itemOf(TBO_HOTEL)],
        photos: new Map(),
        nights: 3,
        searchToken: SEARCH_TOKEN,
      }),
    );
    expect(html).toMatch(/<a [^>]*href="\/hoteles\/[^"?]+\?busqueda=[^"]+"[^>]*>Ver hotel<svg/);
    expect(html).toContain(
      '<span class="sr-only"> Hotel Plaza TBO (se abre en otra pestaña)</span>',
    );
  });

  it('sin la búsqueda de origen no ofrece la ficha: no sabría qué estadía cotizar', () => {
    const html = renderToStaticMarkup(
      createElement(HotelResultsMap, { items: [itemOf(TBO_HOTEL)], photos: new Map(), nights: 3 }),
    );
    expect(html).not.toContain('Ver hotel');
  });
});
