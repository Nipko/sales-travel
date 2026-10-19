import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import {
  faresForLeg,
  groupByLeg,
  isRoundTripResult,
  legFare,
  mergeReturns,
  returnsFromSearch,
} from './leg-selection';

function segment(flightNumber: string, origin: string, destination: string, day: string) {
  return {
    carrier: 'LA',
    flightNumber,
    origin,
    destination,
    departureAt: `${day}T07:00:00-05:00`,
    arrivalAt: `${day}T11:10:00-05:00`,
    durationMinutes: 250,
    cabin: 'economy',
    bookingClass: 'Q',
  };
}

/** Ida y vuelta BOG-MIA con una marca por trayecto, como las devuelve Sabre en CERT. */
function combo(args: {
  ida: string;
  vuelta: string;
  marcaIda: [string, string];
  marcaVuelta: [string, string];
  total: number;
}): Offer {
  return {
    id: `${args.ida}-${args.marcaIda[0]}-${args.vuelta}-${args.marcaVuelta[0]}`,
    tenantId: 't',
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'x' },
    total: { amountMinor: args.total, currency: 'USD' },
    baseFare: { amountMinor: args.total - 100, currency: 'USD' },
    taxes: { amountMinor: 100, currency: 'USD' },
    itineraries: [
      {
        segments: [segment(args.ida, 'BOG', 'MIA', '2026-11-12')],
        totalDurationMinutes: 250,
        stops: 0,
      },
      {
        segments: [segment(args.vuelta, 'MIA', 'BOG', '2026-11-19')],
        totalDurationMinutes: 250,
        stops: 0,
      },
    ],
    fareComponents: [
      { brand: { code: args.marcaIda[0], name: args.marcaIda[1] }, segmentRefs: [0] },
      { brand: { code: args.marcaVuelta[0], name: args.marcaVuelta[1] }, segmentRefs: [1] },
    ],
    fetchedAt: '2026-10-19T00:00:00Z',
    expiresAt: '2026-10-19T00:30:00Z',
  };
}

const LIGHT: [string, string] = ['SL', 'LIGHT'];
const STANDARD: [string, string] = ['KM', 'STANDARD'];

// Los números de la sonda de CERT del 2026-10-19 (docs/sabre/15 §2.5).
const LIGHT_LIGHT = combo({
  ida: '4402',
  vuelta: '4403',
  marcaIda: LIGHT,
  marcaVuelta: LIGHT,
  total: 42_553,
});
const STD_LIGHT = combo({
  ida: '4402',
  vuelta: '4403',
  marcaIda: STANDARD,
  marcaVuelta: LIGHT,
  total: 44_303,
});
const LIGHT_STD = combo({
  ida: '4402',
  vuelta: '4403',
  marcaIda: LIGHT,
  marcaVuelta: STANDARD,
  total: 44_303,
});
const LIGHT_OTRA = combo({
  ida: '4402',
  vuelta: '9719',
  marcaIda: LIGHT,
  marcaVuelta: LIGHT,
  total: 42_553,
});
const OTRA_IDA = combo({
  ida: '9745',
  vuelta: '4403',
  marcaIda: LIGHT,
  marcaVuelta: LIGHT,
  total: 42_553,
});

describe('legFare: la tarifa de cada trayecto por separado', () => {
  it('lee la marca de los componentes de ESE trayecto', () => {
    expect(legFare(STD_LIGHT, 0)).toEqual({ key: 'KM', code: 'KM', name: 'STANDARD' });
    expect(legFare(STD_LIGHT, 1)).toEqual({ key: 'SL', code: 'SL', name: 'LIGHT' });
  });

  it('sin componentes usa la familia de la oferta (LATAM NDC)', () => {
    const { fareComponents: _sin, ...latam } = LIGHT_LIGHT;
    expect(legFare({ ...latam, fareFamily: { name: 'PLUS', cabin: 'economy' } }, 1).name).toBe(
      'PLUS',
    );
  });
});

describe('groupByLeg / faresForLeg: primero la ida, con sus tarifas', () => {
  const resultados = [STD_LIGHT, LIGHT_LIGHT, LIGHT_OTRA, OTRA_IDA, LIGHT_STD];

  it('agrupa por el vuelo de ida, no por el itinerario completo', () => {
    const grupos = groupByLeg(resultados, 0);
    expect(grupos).toHaveLength(2);
    const la4402 = grupos.find((g) => g.key.startsWith('LA4402'))!;
    expect(la4402.offers).toHaveLength(4);
    expect(la4402.offers[0]!.total.amountMinor).toBe(42_553);
  });

  it('una tarjeta por tarifa de ida, con el «desde» de la combinación más barata', () => {
    const la4402 = groupByLeg(resultados, 0).find((g) => g.key.startsWith('LA4402'))!;
    const tarifas = faresForLeg(la4402.offers, 0);
    expect(tarifas.map((o) => legFare(o, 0).name)).toEqual(['LIGHT', 'STANDARD']);
    expect(tarifas.map((o) => o.total.amountMinor)).toEqual([42_553, 44_303]);
  });
});

describe('después la vuelta, con la ida y su tarifa fijas', () => {
  it('sólo combinaciones con la misma ida Y la misma tarifa de ida', () => {
    const vueltas = returnsFromSearch(
      [STD_LIGHT, LIGHT_LIGHT, LIGHT_OTRA, OTRA_IDA, LIGHT_STD],
      LIGHT_LIGHT,
    );
    expect(vueltas.map((o) => o.id).sort()).toEqual(
      [LIGHT_LIGHT.id, LIGHT_OTRA.id, LIGHT_STD.id].sort(),
    );
  });

  it('tarifas de vuelta por vuelo: LIGHT y STANDARD en LA4403, cada una con su total', () => {
    const vueltas = returnsFromSearch([LIGHT_LIGHT, LIGHT_STD, LIGHT_OTRA], LIGHT_LIGHT);
    const la4403 = groupByLeg(vueltas, 1).find((g) => g.key.startsWith('LA4403'))!;
    expect(
      faresForLeg(la4403.offers, 1).map((o) => [legFare(o, 1).name, o.total.amountMinor]),
    ).toEqual([
      ['LIGHT', 42_553],
      ['STANDARD', 44_303],
    ]);
  });

  it('las ancladas mandan y no se duplican con las de la primera búsqueda', () => {
    const ancladaMasNueva = {
      ...LIGHT_LIGHT,
      id: 'anclada',
      total: { amountMinor: 43_000, currency: 'USD' },
    };
    const juntas = mergeReturns([ancladaMasNueva], [LIGHT_LIGHT, LIGHT_OTRA]);
    expect(juntas.map((o) => o.id)).toEqual(['anclada', LIGHT_OTRA.id]);
  });
});

describe('isRoundTripResult', () => {
  it('distingue ida y vuelta de solo ida', () => {
    expect(isRoundTripResult([LIGHT_LIGHT])).toBe(true);
    expect(
      isRoundTripResult([{ ...LIGHT_LIGHT, itineraries: LIGHT_LIGHT.itineraries!.slice(0, 1) }]),
    ).toBe(false);
  });
});
