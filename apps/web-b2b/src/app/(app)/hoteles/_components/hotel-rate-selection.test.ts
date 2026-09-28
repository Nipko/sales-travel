import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../actions';
import { encodeHotelKey } from './hotel-key';
import {
  checkoutHref,
  hotelLinkOf,
  offerReferenceOf,
  parseOfferReference,
  parseRateSelections,
  RATE_SELECTION_MAX_ENTRIES,
  RATE_SELECTION_TTL_MS,
  rateSelectionFor,
  rateSelectionOf,
  withRateSelection,
  type RateSelection,
} from './hotel-rate-selection';

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const SEARCH_ID = 'b1d4c1c2-6a8e-4c7f-9d0e-3f2a1b0c9d8e';
const HOTEL_KEY = encodeHotelKey([{ provider: 'tbo-hotels', hotelId: '1402689' }]) ?? '';
const SEARCH_TOKEN = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

const STAY = {
  checkinDate: '2026-10-12',
  checkoutDate: '2026-10-15',
  rooms: [
    { adults: 2, childrenAges: [5] },
    { adults: 1, childrenAges: [] },
  ],
  guestNationality: 'CO',
  refundableOnly: false,
};

const TBO_PACK: Pick<HotelRoompack, 'provider'> = {
  provider: {
    name: 'tbo-hotels',
    offerRef: '1402689!TB!1!TB!3f9c',
    raw: { searchId: SEARCH_ID },
  },
};

function selection(savedAt: number, overrides: Partial<RateSelection> = {}): RateSelection {
  return {
    reference: {
      providerCode: 'tbo-hotels',
      searchId: SEARCH_ID,
      offerRef: '1402689!TB!1!TB!3f9c',
    },
    hotelKey: HOTEL_KEY,
    searchToken: SEARCH_TOKEN,
    stay: STAY,
    showProviderInResults: false,
    hotel: { name: 'Hotel Plaza', address: 'Calle 1 # 2-3' },
    shownSale: { amountMinor: 32134, currency: 'USD' },
    savedAt,
    ...overrides,
  };
}

describe('parseOfferReference — lo único que el PreBook neutral recibe', () => {
  it('acepta la referencia con los formatos del API', () => {
    expect(
      parseOfferReference({ providerCode: 'tbo-hotels', searchId: SEARCH_ID, offerRef: 'A!B' }),
    ).toEqual({ providerCode: 'tbo-hotels', searchId: SEARCH_ID, offerRef: 'A!B' });
  });

  it('descarta lo que venga de más: nada de precio ni ocupación del navegador (RF-08 CA-4)', () => {
    const ref = parseOfferReference({
      providerCode: 'tbo-hotels',
      searchId: SEARCH_ID,
      offerRef: 'A',
      total: 1,
      rooms: [],
    });
    expect(ref).toEqual({ providerCode: 'tbo-hotels', searchId: SEARCH_ID, offerRef: 'A' });
  });

  it('rechaza lo que el API rechazaría', () => {
    const ok = { providerCode: 'tbo-hotels', searchId: SEARCH_ID, offerRef: 'A' };
    expect(parseOfferReference({ ...ok, providerCode: 'TBO' })).toBeUndefined();
    expect(parseOfferReference({ ...ok, providerCode: 'x' })).toBeUndefined();
    expect(parseOfferReference({ ...ok, searchId: '../x' })).toBeUndefined();
    expect(parseOfferReference({ ...ok, searchId: 'a'.repeat(65) })).toBeUndefined();
    expect(parseOfferReference({ ...ok, offerRef: '' })).toBeUndefined();
    expect(parseOfferReference({ ...ok, offerRef: 'x'.repeat(256) })).toBeUndefined();
    expect(parseOfferReference(null)).toBeUndefined();
    expect(parseOfferReference('tbo-hotels')).toBeUndefined();
  });
});

describe('offerReferenceOf — qué tarifas se revalidan por el PreBook neutral', () => {
  it('una tarifa con contexto de búsqueda en el servidor', () => {
    expect(offerReferenceOf(TBO_PACK)).toEqual({
      providerCode: 'tbo-hotels',
      searchId: SEARCH_ID,
      offerRef: '1402689!TB!1!TB!3f9c',
    });
  });

  it('una de Despegar, que reserva por su flujo propio, no (D-TBO-08 A)', () => {
    expect(
      offerReferenceOf({
        provider: { name: 'despegar-hotels', offerRef: 'CH-1', raw: { choiceId: 'CH-1' } },
      }),
    ).toBeUndefined();
  });

  it('una tarifa que no dice de dónde es, tampoco', () => {
    expect(offerReferenceOf({})).toBeUndefined();
  });
});

describe('rateSelectionOf — la tarifa elegida en el detalle', () => {
  const input = {
    pack: TBO_PACK,
    sale: { amountMinor: 32134, currency: 'USD' },
    hotelKey: HOTEL_KEY,
    searchToken: SEARCH_TOKEN,
    stay: STAY,
    showProviderInResults: true,
    sellerFacts: { name: 'Plaza Hotel & Suites' },
    shownFacts: { name: 'Hotel Plaza', address: 'Calle 1 # 2-3' },
    nowMs: NOW,
  };

  it('guarda el hotel con el nombre del proveedor que lo vende, y lo que falte del encabezado', () => {
    expect(rateSelectionOf(input)).toEqual({
      reference: {
        providerCode: 'tbo-hotels',
        searchId: SEARCH_ID,
        offerRef: '1402689!TB!1!TB!3f9c',
      },
      hotelKey: HOTEL_KEY,
      searchToken: SEARCH_TOKEN,
      stay: STAY,
      showProviderInResults: true,
      hotel: { name: 'Plaza Hotel & Suites', address: 'Calle 1 # 2-3' },
      shownSale: { amountMinor: 32134, currency: 'USD' },
      savedAt: NOW,
    });
  });

  it('sin referencia neutral no hay elección', () => {
    expect(
      rateSelectionOf({
        ...input,
        pack: { provider: { name: 'despegar-hotels', offerRef: 'CH-1' } },
      }),
    ).toBeUndefined();
  });

  it('sin búsqueda de origen, sin identificador', () => {
    expect(rateSelectionOf({ ...input, searchToken: undefined })?.searchToken).toBeUndefined();
  });
});

describe('parseRateSelections — lo guardado no se da por bueno', () => {
  it('lee lo que se guardó', () => {
    const raw = JSON.stringify({ [SEARCH_TOKEN]: selection(NOW) });
    expect(parseRateSelections(raw)).toEqual({ [SEARCH_TOKEN]: selection(NOW) });
  });

  it('una entrada rota se descarta sin tirar las demás', () => {
    const other = '11111111-2222-4333-8444-555555555555';
    const raw = JSON.stringify({
      [SEARCH_TOKEN]: selection(NOW),
      [other]: { ...selection(NOW), reference: { providerCode: 'tbo-hotels' } },
      'no es token': selection(NOW),
    });
    expect(Object.keys(parseRateSelections(raw))).toEqual([SEARCH_TOKEN]);
  });

  it('descarta estadía sin nacionalidad, clave ajena o precio ilegible', () => {
    const bad = [
      { ...selection(NOW), stay: { ...STAY, guestNationality: '' } },
      { ...selection(NOW), hotelKey: '../../admin' },
      { ...selection(NOW), shownSale: { amountMinor: 1.5, currency: 'USD' } },
      { ...selection(NOW), shownSale: { amountMinor: 100, currency: 'usd' } },
    ];
    for (const entry of bad) {
      expect(parseRateSelections(JSON.stringify({ [SEARCH_TOKEN]: entry }))).toEqual({});
    }
  });

  it('la divulgación sólo con `true` (RF-40)', () => {
    const raw = JSON.stringify({
      [SEARCH_TOKEN]: { ...selection(NOW), showProviderInResults: 'true' },
    });
    expect(parseRateSelections(raw)[SEARCH_TOKEN]?.showProviderInResults).toBe(false);
  });

  it('JSON inválido o vacío: nada', () => {
    expect(parseRateSelections(null)).toEqual({});
    expect(parseRateSelections('{')).toEqual({});
    expect(parseRateSelections('[]')).toEqual({});
  });
});

describe('withRateSelection / rateSelectionFor — vigencia y tope', () => {
  it('olvida las vencidas y las que pasan del tope, de la más vieja a la más nueva', () => {
    let entries: Record<string, RateSelection> = {};
    for (let i = 0; i < RATE_SELECTION_MAX_ENTRIES + 3; i += 1) {
      const token = `token-${String(i).padStart(4, '0')}`;
      entries = withRateSelection(entries, token, selection(NOW + i), NOW + i);
    }
    expect(Object.keys(entries)).toHaveLength(RATE_SELECTION_MAX_ENTRIES);
    expect(entries['token-0000']).toBeUndefined();
    expect(
      entries[`token-${String(RATE_SELECTION_MAX_ENTRIES + 2).padStart(4, '0')}`],
    ).toBeDefined();
  });

  it('pasada la hora, la elección ya no se ofrece', () => {
    const entries = { [SEARCH_TOKEN]: selection(NOW) };
    expect(rateSelectionFor(entries, SEARCH_TOKEN, NOW + RATE_SELECTION_TTL_MS)).toBeDefined();
    expect(
      rateSelectionFor(entries, SEARCH_TOKEN, NOW + RATE_SELECTION_TTL_MS + 1),
    ).toBeUndefined();
  });
});

describe('enlaces', () => {
  it('el checkout lleva sólo el identificador de la elección', () => {
    expect(checkoutHref(SEARCH_TOKEN)).toBe(`/hoteles/checkout?tarifa=${SEARCH_TOKEN}`);
  });

  it('volver al hotel lleva su búsqueda si la hubo', () => {
    expect(hotelLinkOf(selection(NOW))).toEqual({
      pathname: `/hoteles/${HOTEL_KEY}`,
      query: { busqueda: SEARCH_TOKEN },
    });
    expect(hotelLinkOf({ hotelKey: HOTEL_KEY })).toEqual({ pathname: `/hoteles/${HOTEL_KEY}` });
  });
});
