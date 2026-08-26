import { OfferSchema, type Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  SABRE_MOCK_CARRIER,
  SABRE_MOCK_CONNECTION,
  SABRE_MOCK_OFFER_REF_PREFIX,
  SABRE_MOCK_RAW_FLAG,
  buildMockOffers,
  isSabreMockOffer,
} from './fixtures';
import { SABRE_ATPCO_OFFER_TTL_SECONDS, SABRE_PROVIDER_NAME } from './shop/response.mapper';

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const NOW_MS = Date.parse('2026-08-26T12:00:00.000Z');

let counter = 0;
function deps(): { now: () => number; uuid: () => string } {
  counter = 0;
  return {
    now: () => NOW_MS,
    uuid: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
  };
}

function criteria(overrides: Partial<FlightSearchCriteria> = {}): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-09-11',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
    ...overrides,
  };
}

function build(overrides: Partial<FlightSearchCriteria> = {}): Offer[] {
  return buildMockOffers(criteria(overrides), TENANT_ID, deps());
}

describe('buildMockOffers — validez canónica', () => {
  it('las tres ofertas pasan OfferSchema', () => {
    const offers = build({ returnDate: '2026-09-18' });
    expect(offers).toHaveLength(3);
    for (const offer of offers) {
      expect(() => OfferSchema.parse(offer)).not.toThrow();
    }
  });

  it('respeta origen, destino y fechas de los criterios', () => {
    const offers = build({ returnDate: '2026-09-18' });
    for (const offer of offers) {
      const [outbound, inbound] = offer.itineraries ?? [];
      expect(outbound).toBeDefined();
      expect(inbound).toBeDefined();
      expect(outbound?.segments[0]?.origin).toBe('BOG');
      expect(outbound?.segments.at(-1)?.destination).toBe('LIM');
      expect(outbound?.segments[0]?.departureAt.slice(0, 10)).toBe('2026-09-11');
      expect(inbound?.segments[0]?.origin).toBe('LIM');
      expect(inbound?.segments.at(-1)?.destination).toBe('BOG');
      expect(inbound?.segments[0]?.departureAt.slice(0, 10)).toBe('2026-09-18');
    }
  });

  it('un solo trayecto produce un solo itinerario', () => {
    for (const offer of build()) {
      expect(offer.itineraries).toHaveLength(1);
    }
  });

  it('usa la moneda pedida en total, base, impuestos y desglose', () => {
    for (const offer of build({ currency: 'COP' })) {
      expect(offer.total.currency).toBe('COP');
      expect(offer.baseFare.currency).toBe('COP');
      expect(offer.taxes.currency).toBe('COP');
      for (const entry of offer.fareBreakdown ?? []) {
        expect(entry.basePerPax.currency).toBe('COP');
        expect(entry.taxesPerPax.currency).toBe('COP');
      }
    }
  });
});

describe('buildMockOffers — no puede pasar por real', () => {
  // El fallback a mock es silencioso por diseño (basta con que falte una credencial). Si además
  // las ofertas tuvieran pinta de reales, un vendedor podría cotizarlas a un cliente.
  it('ninguna aerolínea real aparece como emisora', () => {
    for (const offer of build({ returnDate: '2026-09-18' })) {
      for (const itinerary of offer.itineraries ?? []) {
        for (const segment of itinerary.segments) {
          expect(segment.carrier).toBe(SABRE_MOCK_CARRIER);
          expect(segment.operatingCarrier).toBeUndefined();
        }
      }
    }
  });

  it('la escala usa el código sintético, no un hub real', () => {
    const withStop = build().find((offer) => (offer.itineraries?.[0]?.stops ?? 0) > 0);
    expect(withStop).toBeDefined();
    const segments = withStop?.itineraries?.[0]?.segments ?? [];
    expect(segments).toHaveLength(2);
    expect(segments[0]?.destination).toBe(SABRE_MOCK_CONNECTION);
    expect(segments[1]?.origin).toBe(SABRE_MOCK_CONNECTION);
  });

  it('el offerRef lleva prefijo de mock y la raw lleva la bandera', () => {
    for (const offer of build()) {
      expect(offer.provider.name).toBe(SABRE_PROVIDER_NAME);
      expect(offer.provider.offerRef.startsWith(SABRE_MOCK_OFFER_REF_PREFIX)).toBe(true);
      expect(offer.provider.raw?.[SABRE_MOCK_RAW_FLAG]).toBe(true);
      expect(isSabreMockOffer(offer)).toBe(true);
    }
  });

  it('isSabreMockOffer es false para una oferta sin la bandera', () => {
    const offer = build()[0];
    expect(offer).toBeDefined();
    if (!offer) return;
    const sinRaw: Offer = { ...offer, provider: { ...offer.provider, raw: {} } };
    expect(isSabreMockOffer(sinRaw)).toBe(false);
  });
});

describe('buildMockOffers — expiración', () => {
  it('nunca declara TTL de proveedor: no hubo proveedor', () => {
    for (const offer of build()) {
      expect(offer.expiresAtSource).toBe('platform-policy');
    }
  });

  it('aplica la política de 90 s sobre el instante inyectado', () => {
    for (const offer of build()) {
      expect(offer.fetchedAt).toBe('2026-08-26T12:00:00.000Z');
      expect(Date.parse(offer.expiresAt) - Date.parse(offer.fetchedAt)).toBe(
        SABRE_ATPCO_OFFER_TTL_SECONDS * 1000,
      );
    }
  });

  it('admite un TTL propio para dev', () => {
    const offers = buildMockOffers(criteria(), TENANT_ID, { ...deps(), offerTtlSeconds: 600 });
    for (const offer of offers) {
      expect(Date.parse(offer.expiresAt) - Date.parse(offer.fetchedAt)).toBe(600_000);
    }
  });
});

describe('buildMockOffers — aritmética de precio', () => {
  const cases: ReadonlyArray<readonly [string, FlightSearchCriteria['paxCount']]> = [
    ['1 ADT', { adults: 1, children: 0, infants: 0 }],
    ['2 ADT + 1 CHD', { adults: 2, children: 1, infants: 0 }],
    ['2 ADT + 2 CHD + 1 INF', { adults: 2, children: 2, infants: 1 }],
  ];

  it.each(cases)('%s: total = base + impuestos', (_name, paxCount) => {
    for (const offer of build({ paxCount, returnDate: '2026-09-18' })) {
      expect(offer.total.amountMinor).toBe(offer.baseFare.amountMinor + offer.taxes.amountMinor);
    }
  });

  it.each(cases)('%s: Σ paxCount × (base + tax) === total', (_name, paxCount) => {
    for (const offer of build({ paxCount, returnDate: '2026-09-18' })) {
      const breakdown = offer.fareBreakdown ?? [];
      const sum = breakdown.reduce(
        (acc, entry) =>
          acc + entry.paxCount * (entry.basePerPax.amountMinor + entry.taxesPerPax.amountMinor),
        0,
      );
      expect(sum).toBe(offer.total.amountMinor);
    }
  });

  it('sólo declara los tipos de pasajero pedidos', () => {
    const soloAdultos = build({ paxCount: { adults: 3, children: 0, infants: 0 } });
    for (const offer of soloAdultos) {
      expect((offer.fareBreakdown ?? []).map((entry) => entry.paxType)).toEqual(['ADT']);
      expect(offer.fareBreakdown?.[0]?.paxCount).toBe(3);
    }

    const familia = build({ paxCount: { adults: 2, children: 1, infants: 1 } });
    for (const offer of familia) {
      expect((offer.fareBreakdown ?? []).map((entry) => entry.paxType)).toEqual([
        'ADT',
        'CHD',
        'INF',
      ]);
    }
  });

  it('el ida y vuelta cuesta más que el solo ida', () => {
    const oneWay = build();
    const roundTrip = build({ returnDate: '2026-09-18' });
    for (let i = 0; i < oneWay.length; i += 1) {
      const cheap = oneWay[i];
      const expensive = roundTrip[i];
      expect(cheap).toBeDefined();
      expect(expensive).toBeDefined();
      expect(expensive?.total.amountMinor).toBeGreaterThan(cheap?.total.amountMinor ?? 0);
    }
  });
});

describe('buildMockOffers — coherencia de los segmentos', () => {
  it('llegada = salida + duración, y las escalas no se solapan', () => {
    for (const offer of build({ returnDate: '2026-09-18' })) {
      for (const itinerary of offer.itineraries ?? []) {
        let previousArrival = 0;
        for (const segment of itinerary.segments) {
          const departure = Date.parse(segment.departureAt);
          const arrival = Date.parse(segment.arrivalAt);
          expect(arrival - departure).toBe(segment.durationMinutes * 60_000);
          expect(departure).toBeGreaterThanOrEqual(previousArrival);
          previousArrival = arrival;
        }
      }
    }
  });

  it('stops es el número de escalas y la duración total cubre la espera', () => {
    for (const offer of build()) {
      for (const itinerary of offer.itineraries ?? []) {
        expect(itinerary.stops).toBe(itinerary.segments.length - 1);
        const flying = itinerary.segments.reduce((acc, seg) => acc + seg.durationMinutes, 0);
        expect(itinerary.totalDurationMinutes).toBeGreaterThanOrEqual(flying);
      }
    }
  });

  it('las tres variantes son distinguibles y una es de cabina superior', () => {
    const offers = build();
    const refs = offers.map((offer) => offer.provider.offerRef);
    expect(new Set(refs).size).toBe(3);
    expect(offers.some((offer) => offer.fareFamily?.cabin === 'business')).toBe(true);
    expect(offers.some((offer) => offer.policies?.refundable === true)).toBe(true);
    expect(offers.some((offer) => offer.policies?.refundable === false)).toBe(true);
  });
});
