import { describe, expect, it } from 'vitest';
import type { HotelOffer, HotelRoompack } from '../../actions';
import type { HotelContentResult, HotelDetailRatesResult } from '../actions';
import type { HotelContent } from './hotel-content-view';
import {
  contentToShow,
  detailHeader,
  detailRatesView,
  emptyRatesView,
  factsByProvider,
  formatStayDate,
  staySummary,
  stayNights,
} from './hotel-detail-view';

const DESPEGAR = { provider: 'despegar-hotels', hotelId: '555' };
const TBO = { provider: 'tbo-hotels', hotelId: '1402689' };

function pack(id: string, provider: string, saleMinor: number): HotelRoompack {
  return {
    id,
    provider: { name: provider, offerRef: `${id}-REF` },
    board: 'BB',
    rooms: [{ name: 'Doble', reference: 1, bedOptions: [] }],
    cancellation: { refundable: true, status: 'partially_refundable', rules: [] },
    price: { total: { amountMinor: saleMinor - 50_00, currency: 'USD' }, taxesDetail: [] },
    pricing: { costMinor: saleMinor, finalMinor: saleMinor, ownMarkupMinor: 0, currency: 'USD' },
  };
}

function offer(hotelId: string, roompacks: HotelRoompack[], extra: Partial<HotelOffer> = {}) {
  return { hotelId, roompacks, ...extra };
}

function content(extra: Partial<HotelContent>): HotelContent {
  return {
    providerCode: 'tbo-hotels',
    hotelId: '1402689',
    requestedLang: 'es',
    lang: 'es',
    origin: 'catalog',
    name: null,
    stars: null,
    address: null,
    zipcode: null,
    countryCode: null,
    location: null,
    descriptionHtml: null,
    sections: [],
    facilities: [],
    attractionsHtml: null,
    images: [],
    phone: null,
    websiteUrl: null,
    checkInTime: null,
    checkOutTime: null,
    ...extra,
  };
}

const RATES: HotelDetailRatesResult = {
  ok: true,
  receivedAt: 1,
  outcomes: [
    {
      ref: DESPEGAR,
      offer: offer('555', [pack('D1', 'despegar-hotels', 300_00)], {
        name: 'Hotel Plaza',
        address: 'Av. 5',
      }),
    },
    {
      ref: TBO,
      offer: offer(
        '1402689',
        [pack('T1', 'tbo-hotels', 250_00), pack('T2', 'tbo-hotels', 400_00)],
        {
          name: 'Plaza Hotel & Suites',
        },
      ),
    },
  ],
};

describe('detailRatesView — RF-40 CA 4 en la lista de tarifas del detalle', () => {
  it('con el ajuste encendido, cada tarifa lleva la pastilla de SU proveedor', () => {
    const view = detailRatesView(RATES, true);
    expect(view.rows.map((r) => [r.pack.id, r.providerLabel])).toEqual([
      ['T1', 'TBO Holidays'],
      ['D1', 'Despegar Hotels'],
      ['T2', 'TBO Holidays'],
    ]);
    expect(new Set(view.rows.map((r) => r.providerLabel)).size).toBe(2);
  });

  it('apagado: ninguna pastilla ni nombre de proveedor (RF-40 CA 6)', () => {
    const view = detailRatesView(RATES, false);
    expect(view.rows.every((r) => r.providerLabel === undefined)).toBe(true);
  });

  it('de la más barata a la más cara por precio de VENTA, todas en el contador', () => {
    const view = detailRatesView(RATES, false);
    expect(view.rows.map((r) => r.sale.amountMinor)).toEqual([250_00, 300_00, 400_00]);
    expect(view.offers[0]?.roompacks).toHaveLength(3);
    expect(view.answered).toBe(2);
    expect(view.failed).toEqual([]);
  });

  it('un proveedor que falla no tapa al otro, y se dice cuál faltó', () => {
    const partial: HotelDetailRatesResult = {
      ...RATES,
      outcomes: [RATES.outcomes[0]!, { ref: TBO, error: 'TBO no respondió a tiempo.' }],
    };
    const view = detailRatesView(partial, false);
    expect(view.rows.map((r) => r.pack.id)).toEqual(['D1']);
    expect(view.failed).toEqual([{ code: 'tbo-hotels', reason: 'TBO no respondió a tiempo.' }]);
  });
});

describe('emptyRatesView — sin tarifas', () => {
  it('distingue "no hay lugar" de "no respondieron"', () => {
    expect(emptyRatesView({ answered: 2, failed: [] }).title).toBe(
      'Este hotel no tiene disponibilidad para estas fechas.',
    );
    expect(emptyRatesView({ answered: 1, failed: [{ code: 'x', reason: 'y' }] }).hint).toMatch(
      /antes de decirle al cliente que no hay lugar/,
    );
    expect(emptyRatesView({ answered: 0, failed: [{ code: 'x', reason: 'y' }] }).title).toBe(
      'No pudimos traer las tarifas de este hotel.',
    );
  });
});

describe('detailHeader y factsByProvider — de qué hotel es la página y con qué nombre se reserva', () => {
  const CONTENT: HotelContentResult = {
    ok: true,
    outcomes: [
      { ref: DESPEGAR, error: 'x' },
      {
        ref: TBO,
        content: content({ name: 'Plaza Hotel & Suites', address: 'Calle 1', stars: 4 }),
      },
    ],
  };

  it('el encabezado es del PRIMER hotel de la clave: su ficha y, si no, su búsqueda', () => {
    expect(detailHeader([DESPEGAR, TBO], CONTENT, RATES)).toEqual({
      name: 'Hotel Plaza',
      address: 'Av. 5',
    });
    expect(detailHeader([TBO, DESPEGAR], CONTENT, RATES)).toMatchObject({
      name: 'Plaza Hotel & Suites',
      stars: 4,
      address: 'Calle 1',
    });
    expect(detailHeader([TBO], undefined, undefined).name).toBe('Hotel 1402689');
  });

  it('cada proveedor con sus propios datos', () => {
    const facts = factsByProvider([DESPEGAR, TBO], CONTENT, RATES);
    expect(facts.get('despegar-hotels')).toEqual({ name: 'Hotel Plaza', address: 'Av. 5' });
    expect(facts.get('tbo-hotels')).toEqual({ name: 'Plaza Hotel & Suites', address: 'Calle 1' });
  });
});

describe('contentToShow — qué ficha se pinta en un hotel que venden varios', () => {
  const EMPTY_DESPEGAR = content({
    providerCode: 'despegar-hotels',
    hotelId: '555',
    lang: null,
    origin: 'none',
    name: 'Hotel Plaza',
  });
  const RICH_TBO = content({
    images: ['https://img.example/1.jpg'],
    descriptionHtml: '<p>Frente al parque.</p>',
  });

  it('la del primer hotel de la clave cuando tiene algo que contar', () => {
    const own = content({ providerCode: 'despegar-hotels', hotelId: '555', facilities: ['Wifi'] });
    const result: HotelContentResult = {
      ok: true,
      outcomes: [
        { ref: DESPEGAR, content: own },
        { ref: TBO, content: RICH_TBO },
      ],
    };
    expect(contentToShow([DESPEGAR, TBO], result)).toBe(own);
  });

  it('si el primero respondió vacío, la del siguiente que sí tiene fotos o descripción', () => {
    const result: HotelContentResult = {
      ok: true,
      outcomes: [
        { ref: DESPEGAR, content: EMPTY_DESPEGAR },
        { ref: TBO, content: RICH_TBO },
      ],
    };
    expect(contentToShow([DESPEGAR, TBO], result)).toBe(RICH_TBO);
  });

  it('si ninguno tiene nada, la del primero: la pantalla dice que no hay ficha', () => {
    const result: HotelContentResult = {
      ok: true,
      outcomes: [
        { ref: DESPEGAR, content: EMPTY_DESPEGAR },
        { ref: TBO, error: 'x' },
      ],
    };
    expect(contentToShow([DESPEGAR, TBO], result)).toBe(EMPTY_DESPEGAR);
  });

  it('si la del primero falló, ninguna: el fallo no se tapa con la de otro proveedor', () => {
    const result: HotelContentResult = {
      ok: true,
      outcomes: [
        { ref: DESPEGAR, error: 'x' },
        { ref: TBO, content: RICH_TBO },
      ],
    };
    expect(contentToShow([DESPEGAR, TBO], result)).toBeUndefined();
    expect(contentToShow([DESPEGAR, TBO], undefined)).toBeUndefined();
  });
});

describe('staySummary — la estadía cotizada a la vista (D-TBO-14 A)', () => {
  it('fechas, noches, habitaciones, huéspedes y nacionalidad', () => {
    const summary = staySummary(
      {
        checkinDate: '2026-10-12',
        checkoutDate: '2026-10-15',
        rooms: [
          { adults: 2, childrenAges: [5] },
          { adults: 1, childrenAges: [] },
        ],
        guestNationality: 'CO',
        refundableOnly: true,
      },
      (code) => (code === 'CO' ? 'Colombia' : code),
    );
    expect(summary).toEqual({
      dates: '12 oct 2026 → 15 oct 2026',
      nights: 3,
      details: '3 noches · 2 habitaciones · 3 adultos · 1 niño · solo reembolsables',
      nationality: 'Colombia',
    });
  });

  it('fechas del calendario, sin pasar por la zona del navegador', () => {
    expect(formatStayDate('2026-01-01')).toBe('1 ene 2026');
    expect(formatStayDate('mañana')).toBe('mañana');
    expect(stayNights({ checkinDate: '2026-03-28', checkoutDate: '2026-03-30' })).toBe(2);
  });
});
