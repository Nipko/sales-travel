import { describe, expect, it } from 'vitest';
import type { HotelOffer, HotelRoompack } from '../actions';
import { hotelCardSummary, perNightOf, stayShortLabel } from './hotel-card-summary';
import {
  DEFAULT_RESULTS_STATE,
  NO_FILTERS,
  activeFilterChips,
  activeFilterCount,
  applyResultsFilters,
  effectiveFilters,
  parseResultsQuery,
  priceStep,
  queryWithResults,
  resultHotelsOf,
  resultsFacets,
  sortResults,
  starsOf,
  wideningSuggestions,
  withMaxTotal,
  type ResultsFilters,
} from './hotel-results-filters';

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

function tarifa(
  id: string,
  saleMinor: number,
  extra: Partial<HotelRoompack> & { providerName?: string } = {},
): HotelRoompack {
  const { providerName = 'tbo-hotels', ...rest } = extra;
  return {
    id,
    provider: { name: providerName, offerRef: `${id}-REF` },
    board: 'RO',
    rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: saleMinor, currency: 'COP' }, taxesDetail: [] },
    ...rest,
  };
}

const reembolsable = {
  cancellation: {
    refundable: true,
    status: 'fully_refundable' as const,
    policySource: 'search-indicative' as const,
    freeCancellationUntilLocal: '2026-10-10T00:00:00',
    rules: [
      { type: 'Percentage', fromLocalDateTime: '2026-09-29T00:00:00', penaltyPercentage: 0 },
      { type: 'Percentage', fromLocalDateTime: '2026-10-10T00:00:00', penaltyPercentage: 100 },
    ],
  },
};

function hotel(hotelId: string, stars: number | undefined, roompacks: HotelRoompack[]): HotelOffer {
  return { hotelId, name: `Hotel ${hotelId}`, ...(stars ? { stars } : {}), roompacks };
}

const OFFERS: HotelOffer[] = [
  // A: 3★, sólo no reembolsable, solo alojamiento.
  hotel('A', 3, [tarifa('A1', 300_000_00)]),
  // B: 5★, no reembolsable barata con desayuno y reembolsable cara.
  hotel('B', 5, [
    tarifa('B1', 900_000_00, { board: 'BB' }),
    tarifa('B2', 1_200_000_00, { board: 'BB', ...reembolsable }),
  ]),
  // C: 4★, reembolsable, todo incluido, de otro proveedor.
  hotel('C', 4, [
    tarifa('C1', 600_000_00, { board: 'AI', providerName: 'despegar-hotels', ...reembolsable }),
  ]),
  // D: sin categoría.
  hotel('D', undefined, [tarifa('D1', 150_000_00)]),
];

const HOTELS = resultHotelsOf(OFFERS, true, NOW);

function ids(filters: ResultsFilters): string[] {
  return applyResultsFilters(HOTELS, filters).map((f) => f.hotel.offer.hotelId);
}

describe('la URL de los resultados', () => {
  it('sin parámetros: recomendados, en lista y sin filtros', () => {
    expect(parseResultsQuery('')).toEqual(DEFAULT_RESULTS_STATE);
  });

  it('ida y vuelta, sin tocar los demás parámetros de la página', () => {
    const state = {
      sort: 'precio-asc' as const,
      view: 'mapa' as const,
      filters: {
        maxTotal: { currency: 'COP', amountMinor: 500_000_00 },
        stars: [4, 5],
        boards: ['BB' as const, 'AI' as const],
        refundableOnly: true,
        providers: ['tbo-hotels'],
      },
    };
    const query = queryWithResults('?moneda=USD&cliente=abc', state);
    expect(query).toBe(
      '?moneda=USD&cliente=abc&orden=precio-asc&vista=mapa&precioMax=COP-50000000&estrellas=5%2C4&regimen=BB%2CAI&reembolsable=1&proveedor=tbo-hotels',
    );
    expect(parseResultsQuery(query)).toEqual({
      ...state,
      filters: { ...state.filters, stars: [5, 4] },
    });
  });

  it('lo que está en su valor por defecto no se escribe, y se borra lo que había', () => {
    expect(queryWithResults('?orden=estrellas&reembolsable=1', DEFAULT_RESULTS_STATE)).toBe('');
    expect(queryWithResults('?moneda=USD', DEFAULT_RESULTS_STATE)).toBe('?moneda=USD');
  });

  it('lo que no se entiende se ignora', () => {
    expect(
      parseResultsQuery(
        '?orden=barato&vista=satelite&precioMax=COP-abc&estrellas=9,x,4&regimen=XX,BB&reembolsable=si&proveedor=<script>,tbo-hotels',
      ),
    ).toEqual({
      sort: 'recomendados',
      view: 'lista',
      filters: {
        stars: [4],
        boards: ['BB'],
        refundableOnly: false,
        providers: ['tbo-hotels'],
      },
    });
  });
});

describe('starsOf', () => {
  it('redondea a 1-5; sin dato o 0 es "sin categoría"', () => {
    expect(starsOf({ stars: 4.4 })).toBe(4);
    expect(starsOf({ stars: 7 })).toBe(5);
    expect(starsOf({ stars: 0 })).toBe(0);
    expect(starsOf({})).toBe(0);
  });
});

describe('applyResultsFilters', () => {
  it('sin filtros, todos en el orden recibido', () => {
    expect(ids(NO_FILTERS)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('solo reembolsables: el hotel queda con SUS tarifas reembolsables', () => {
    const out = applyResultsFilters(HOTELS, { ...NO_FILTERS, refundableOnly: true });
    expect(out.map((f) => f.hotel.offer.hotelId)).toEqual(['B', 'C']);
    const b = out[0];
    expect(b?.rates.map((r) => r.row.pack.id)).toEqual(['B2']);
    expect(b?.hiddenRates).toBe(1);
  });

  it('estrellas, con "sin categoría" como 0', () => {
    expect(ids({ ...NO_FILTERS, stars: [5, 4] })).toEqual(['B', 'C']);
    expect(ids({ ...NO_FILTERS, stars: [0] })).toEqual(['D']);
  });

  it('régimen y proveedor', () => {
    expect(ids({ ...NO_FILTERS, boards: ['BB'] })).toEqual(['B']);
    expect(ids({ ...NO_FILTERS, providers: ['despegar-hotels'] })).toEqual(['C']);
  });

  it('precio de venta máximo por la estadía', () => {
    const max = { currency: 'COP', amountMinor: 600_000_00 };
    expect(ids({ ...NO_FILTERS, maxTotal: max })).toEqual(['A', 'C', 'D']);
  });

  it('los filtros se suman', () => {
    expect(ids({ ...NO_FILTERS, refundableOnly: true, boards: ['AI'] })).toEqual(['C']);
    expect(ids({ ...NO_FILTERS, refundableOnly: true, stars: [3] })).toEqual([]);
  });
});

describe('effectiveFilters', () => {
  it('un tope en otra moneda (de otra búsqueda) no se aplica', () => {
    const f = { ...NO_FILTERS, maxTotal: { currency: 'USD', amountMinor: 100_00 } };
    expect(effectiveFilters(f, 'COP', true).maxTotal).toBeUndefined();
    expect(effectiveFilters(f, 'USD', true).maxTotal).toEqual(f.maxTotal);
  });

  it('sin divulgación no se filtra por proveedor', () => {
    const f = { ...NO_FILTERS, providers: ['tbo-hotels'] };
    expect(effectiveFilters(f, 'COP', false).providers).toEqual([]);
  });
});

describe('sortResults', () => {
  const all = applyResultsFilters(HOTELS, NO_FILTERS);
  const order = (sort: Parameters<typeof sortResults>[1]) =>
    sortResults(all, sort).map((f) => f.hotel.offer.hotelId);

  it('recomendados es el orden de la respuesta', () => {
    expect(order('recomendados')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('por precio, con la tarifa más barata que cumple los filtros', () => {
    expect(order('precio-asc')).toEqual(['D', 'A', 'C', 'B']);
    expect(order('precio-desc')).toEqual(['B', 'C', 'A', 'D']);
  });

  it('más estrellas primero; a igual categoría, la más barata', () => {
    expect(order('estrellas')).toEqual(['B', 'C', 'A', 'D']);
  });

  it('por precio, el de las tarifas filtradas', () => {
    const refundable = applyResultsFilters(HOTELS, { ...NO_FILTERS, refundableOnly: true });
    expect(sortResults(refundable, 'precio-asc').map((f) => f.hotel.offer.hotelId)).toEqual([
      'C',
      'B',
    ]);
  });
});

describe('resultsFacets', () => {
  it('rango de precios, opciones y cuántos hoteles deja cada una', () => {
    const facets = resultsFacets(HOTELS, NO_FILTERS, true);
    expect(facets.currency).toBe('COP');
    expect(facets.price).toEqual({ min: 150_000_00, max: 1_200_000_00 });
    expect(facets.stars.map((s) => [s.value, s.count])).toEqual([
      [5, 1],
      [4, 1],
      [3, 1],
      [0, 1],
    ]);
    expect(facets.boards.map((b) => [b.value, b.label, b.count])).toEqual([
      ['RO', 'Solo alojamiento', 2],
      ['BB', 'Desayuno', 1],
      ['AI', 'Todo incluido', 1],
    ]);
    expect(facets.refundable).toBe(2);
    expect(facets.providers.map((p) => p.value)).toEqual(['despegar-hotels', 'tbo-hotels']);
  });

  it('los conteos respetan los demás filtros', () => {
    const facets = resultsFacets(HOTELS, { ...NO_FILTERS, refundableOnly: true }, true);
    expect(facets.boards.find((b) => b.value === 'RO')?.count).toBe(0);
    expect(facets.boards.find((b) => b.value === 'BB')?.count).toBe(1);
  });

  it('una opción elegida que no aparece igual se ofrece, para poder quitarla', () => {
    const facets = resultsFacets(HOTELS, { ...NO_FILTERS, boards: ['HB'] }, true);
    expect(facets.boards.find((b) => b.value === 'HB')).toEqual({
      value: 'HB',
      label: 'Media pensión',
      count: 0,
    });
  });

  it('sin divulgación no hay sección de proveedor', () => {
    expect(resultsFacets(HOTELS, NO_FILTERS, false).providers).toEqual([]);
  });
});

describe('el deslizador de precio', () => {
  it('un paso redondo', () => {
    expect(priceStep({ min: 150_000_00, max: 1_200_000_00 })).toBe(2_000_000);
    expect(priceStep({ min: 100, max: 100 })).toBe(1);
  });

  it('en el último paso no hay tope; por debajo del mínimo, el mínimo', () => {
    const facets = { currency: 'COP', price: { min: 100, max: 1_000 } };
    expect(withMaxTotal(NO_FILTERS, 1_000, facets).maxTotal).toBeUndefined();
    // Paso de 10: 995 no es un paso del deslizador, pero es su último tramo.
    expect(withMaxTotal(NO_FILTERS, 995, facets).maxTotal).toBeUndefined();
    expect(withMaxTotal(NO_FILTERS, 990, facets).maxTotal).toEqual({
      currency: 'COP',
      amountMinor: 990,
    });
    expect(withMaxTotal(NO_FILTERS, 50, facets).maxTotal).toEqual({
      currency: 'COP',
      amountMinor: 100,
    });
    expect(withMaxTotal(NO_FILTERS, 500, facets).maxTotal).toEqual({
      currency: 'COP',
      amountMinor: 500,
    });
  });
});

describe('lo que está puesto y cómo ampliar', () => {
  const filters: ResultsFilters = {
    maxTotal: { currency: 'COP', amountMinor: 200_000_00 },
    stars: [5],
    boards: ['AI'],
    refundableOnly: true,
    providers: ['despegar-hotels'],
  };

  it('una pastilla por filtro, cada una sabe quitarse', () => {
    const chips = activeFilterChips(filters, resultsFacets(HOTELS, filters, true));
    expect(chips.map((c) => c.label)).toEqual([
      expect.stringMatching(/^Hasta /),
      'Solo reembolsables',
      '5 estrellas',
      'Todo incluido',
      'Despegar Hotels',
    ]);
    expect(chips[1]?.without.refundableOnly).toBe(false);
    expect(activeFilterCount(filters)).toBe(5);
  });

  it('sin resultados, propone quitar lo que más muestra, sin proponer lo que no muestra nada', () => {
    const f: ResultsFilters = { ...NO_FILTERS, refundableOnly: true, stars: [3] };
    expect(ids(f)).toEqual([]);
    const out = wideningSuggestions(HOTELS, f);
    expect(out.map((w) => [w.id, w.count])).toEqual([
      ['estrellas', 2],
      ['reembolsable', 1],
    ]);
  });
});

describe('hotelCardSummary', () => {
  it('precio por noche y total de la tarifa más barata que cumple los filtros', () => {
    const [b] = applyResultsFilters(HOTELS, { ...NO_FILTERS, stars: [5] });
    const s = hotelCardSummary(b!, 3);
    expect(s.headline?.row.pack.id).toBe('B1');
    expect(s.total).toEqual({ amountMinor: 900_000_00, currency: 'COP' });
    expect(s.perNight).toEqual({ amountMinor: 300_000_00, currency: 'COP' });
    expect(s.refund).toEqual({ tone: 'warning', label: 'No reembolsable' });
    // La no reembolsable pone el precio: la reembolsable del mismo hotel se nombra.
    expect(s.refundableFrom?.row.pack.id).toBe('B2');
    expect(s.noRefundableAtAll).toBe(false);
  });

  it('aviso de un hotel sin NINGUNA tarifa reembolsable', () => {
    const [a] = applyResultsFilters(HOTELS, NO_FILTERS);
    const s = hotelCardSummary(a!, 3);
    expect(s.noRefundableAtAll).toBe(true);
    expect(s.refundableFrom).toBeUndefined();
  });

  it('una vencida no pone el precio si hay otra vigente', () => {
    const [, b] = applyResultsFilters(HOTELS, NO_FILTERS);
    const s = hotelCardSummary(b!, 3, (r) => r.row.pack.id === 'B1');
    expect(s.headline?.row.pack.id).toBe('B2');
    expect(s.headlineExpired).toBe(false);
    expect(s.refund).toEqual({ tone: 'success', label: 'Cancelación gratis' });
  });

  it('si vencieron todas, la más barata marcada como vencida', () => {
    const [, b] = applyResultsFilters(HOTELS, NO_FILTERS);
    const s = hotelCardSummary(b!, 3, () => true);
    expect(s.headline?.row.pack.id).toBe('B1');
    expect(s.headlineExpired).toBe(true);
  });

  it('promoción y cargos en el hotel de la tarifa del precio', () => {
    const offer = hotel('P', 4, [
      tarifa('P1', 100_00, {
        rooms: [{ name: 'Doble', reference: 1, bedOptions: [], promotions: ['20 % off'] }],
        atPropertyCharges: [
          { description: 'Tasa', amount: { amountMinor: 5_00, currency: 'USD' } },
        ],
      }),
    ]);
    const [p] = applyResultsFilters(resultHotelsOf([offer], false, NOW), NO_FILTERS);
    const s = hotelCardSummary(p!, 1);
    expect(s.promotion).toBe('20 % off');
    expect(s.atHotelCharges).toBe(true);
  });
});

describe('perNightOf y stayShortLabel', () => {
  it('sin centavos en el total, sin centavos por noche; si no, a la unidad menor', () => {
    expect(perNightOf({ amountMinor: 2_110_000_00, currency: 'COP' }, 3)).toEqual({
      amountMinor: 703_333_00,
      currency: 'COP',
    });
    expect(perNightOf({ amountMinor: 100_01, currency: 'USD' }, 3)).toEqual({
      amountMinor: 33_34,
      currency: 'USD',
    });
    expect(perNightOf({ amountMinor: 100, currency: 'COP' }, undefined)).toBeUndefined();
    expect(perNightOf({ amountMinor: 100, currency: 'COP' }, 0)).toBeUndefined();
  });

  it('noches y, con más de una, habitaciones', () => {
    expect(stayShortLabel(3, 1)).toBe('3 noches');
    expect(stayShortLabel(1, 2)).toBe('1 noche · 2 habitaciones');
    expect(stayShortLabel(undefined, undefined)).toBe('');
  });
});
