import { Money, OfferSchema, type Offer } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import adultFixture from '../__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from '../__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from '../__fixtures__/v5-roundtrip-family-200.json';
import {
  SABRE_ATPCO_OFFER_TTL_SECONDS,
  SabreShopMappingError,
  addDaysToIsoDate,
  canonicalPaxType,
  mapSabreShopResponse,
  resolveOfferExpiry,
  type SabreMapWarning,
  type SabreShopMapResult,
} from './response.mapper';

/**
 * Los tres fixtures son los **ejemplos de respuesta oficiales** de Bargain Finder Max v5,
 * extraídos sin tocar de `docs/sabre/evidence/specs/bargain-finder-max-v5.yml` (`:139-591`,
 * `:678-1355`, `:1466-2308`). Son contenido ATPCO puro: en las 2.188 líneas que ocupan no aparece
 * `offer`, `timeToLive`, `distributionModel` ni `source` ni una sola vez — que es justamente la
 * razón por la que la rama ATPCO se puede escribir hoy y la NDC no (docs/sabre/11 §6.2).
 */
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const FETCHED_AT = '2026-08-26T12:00:00.000Z';

type Json = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function run(raw: unknown, overrides: { offerTtlSeconds?: number } = {}): SabreShopMapResult {
  return mapSabreShopResponse(raw, {
    tenantId: TENANT_ID,
    fetchedAt: FETCHED_AT,
    ...overrides,
  });
}

function onlyOffer(result: SabreShopMapResult): Offer {
  expect(result.offers).toHaveLength(1);
  const offer = result.offers[0];
  if (!offer) throw new Error('sin oferta');
  return offer;
}

function codes(warnings: readonly SabreMapWarning[]): string[] {
  return warnings.map((w) => w.code);
}

/** Navega el fixture clonado hasta el `pricingInformation[0]` del primer itinerario. */
function firstPricing(payload: Json): Json {
  const body = payload['groupedItineraryResponse'] as Json;
  const groups = body['itineraryGroups'] as Json[];
  const itineraries = (groups[0] as Json)['itineraries'] as Json[];
  return ((itineraries[0] as Json)['pricingInformation'] as Json[])[0] as Json;
}

function passengerInfos(payload: Json): Json[] {
  const fare = firstPricing(payload)['fare'] as Json;
  return (fare['passengerInfoList'] as Json[]).map((entry) => entry['passengerInfo'] as Json);
}

const FIXTURES = [
  ['adulto RT (v5.yml:139)', adultFixture],
  ['niño + equipaje (v5.yml:678)', childFixture],
  ['familia con infante (v5.yml:1466)', familyFixture],
] as const;

// ---------------------------------------------------------------------------
// Criterio de salida de la Fase 1: Offer[] válido para los tres ejemplos oficiales
// ---------------------------------------------------------------------------

describe('criterio de salida — los 3 ejemplos oficiales producen Offer válido', () => {
  it.each(FIXTURES)('%s', (_name, fixture) => {
    const result = run(clone(fixture));

    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(OfferSchema.safeParse(offer).success).toBe(true);
    }
    expect(result.degraded).toBe(false);
    // Ninguna oferta descartada: si el mapper tira algo de un ejemplo oficial, está roto.
    expect(codes(result.warnings)).not.toContain('offer-invalid');
    expect(codes(result.warnings)).not.toContain('segment-invalid');
    expect(codes(result.warnings)).not.toContain('itinerary-invalid');
  });

  it('los tres son ATPCO puro: ni un `timeToLive` ni un `offer` en el payload', () => {
    for (const [, fixture] of FIXTURES) {
      const serialized = JSON.stringify(fixture);
      expect(serialized).not.toContain('"timeToLive"');
      expect(serialized).not.toContain('"distributionModel"');
      expect(serialized).not.toContain('"offer"');
    }
  });

  it('el proveedor y el carril quedan declarados', () => {
    const offer = onlyOffer(run(clone(adultFixture)));
    expect(offer.provider.name).toBe('sabre');
    expect(offer.provider.source).toBe('ATPCO');
    expect(offer.products).toEqual(['flight']);
    expect(offer.tenantId).toBe(TENANT_ID);
    expect(offer.fetchedAt).toBe(FETCHED_AT);
  });
});

// ---------------------------------------------------------------------------
// TRAMPA 1 — baseFare NO es baseFareAmount
// ---------------------------------------------------------------------------

describe('trampa 1 — `baseFare` sale de equivalentAmount, nunca de baseFareAmount', () => {
  it('ejemplo 1: 58 USD, no 235 PLN', () => {
    const offer = onlyOffer(run(clone(adultFixture)));
    expect(offer.total).toEqual({ amountMinor: 13180, currency: 'USD' });
    expect(offer.taxes).toEqual({ amountMinor: 7380, currency: 'USD' });
    expect(offer.baseFare).toEqual({ amountMinor: 5800, currency: 'USD' });
    // `baseFareAmount` es 235 en `baseFareCurrency: PLN`. Ni el importe ni la moneda.
    expect(offer.baseFare.amountMinor).not.toBe(23500);
    expect(offer.baseFare.currency).not.toBe('PLN');
  });

  it('ejemplo 3: la publicación es USD y la venta EUR — gana EUR', () => {
    const offer = onlyOffer(run(clone(familyFixture)));
    expect(offer.total).toEqual({ amountMinor: 326838, currency: 'EUR' });
    expect(offer.baseFare).toEqual({ amountMinor: 296400, currency: 'EUR' });
    expect(offer.taxes).toEqual({ amountMinor: 30438, currency: 'EUR' });
    // 3231.6 USD es `baseFareAmount`: coger ese campo daría un total en una unidad inexistente.
    expect(offer.baseFare.amountMinor).not.toBe(323160);
  });

  it.each(FIXTURES)('%s: base + impuestos = total, y Money.add no lanza', (_name, fixture) => {
    for (const offer of run(clone(fixture)).offers) {
      expect(offer.baseFare.currency).toBe(offer.total.currency);
      expect(offer.taxes.currency).toBe(offer.total.currency);
      // Si alguien cambiara `baseFare` a `baseFareAmount`, esta línea lanza por currency mismatch.
      expect(Money.add(offer.baseFare, offer.taxes)).toEqual(offer.total);
    }
  });

  it('la base por pax tampoco es baseFareAmount', () => {
    const child = onlyOffer(run(clone(childFixture)));
    const breakdown = child.fareBreakdown ?? [];
    const adt = breakdown.find((entry) => entry.paxType === 'ADT');
    const chd = breakdown.find((entry) => entry.paxType === 'CHD');
    expect(adt?.basePerPax).toEqual({ amountMinor: 5400, currency: 'EUR' });
    expect(chd?.basePerPax).toEqual({ amountMinor: 4100, currency: 'EUR' });
    // 235 PLN y 177 PLN son los `baseFareAmount` de esos mismos pasajeros.
    expect(adt?.basePerPax.amountMinor).not.toBe(23500);
    expect(chd?.basePerPax.amountMinor).not.toBe(17700);
  });

  it('si `equivalentCurrency` no coincide con la de los impuestos, se deriva restando', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const fare = passengerInfos(payload)[0]?.['passengerTotalFare'] as Json;
    fare['equivalentCurrency'] = 'PLN';
    fare['equivalentAmount'] = 235;

    const result = run(payload);
    const offer = onlyOffer(result);
    const adt = (offer.fareBreakdown ?? [])[0];
    expect(adt?.basePerPax).toEqual({ amountMinor: 5800, currency: 'USD' });
    expect(codes(result.warnings)).toContain('pax-base-fare-derived');
  });
});

// ---------------------------------------------------------------------------
// TRAMPA 2 — la contradicción del contrato, defendida en runtime
// ---------------------------------------------------------------------------

describe('trampa 2 — invariante basePerPax + taxesPerPax === totalFare', () => {
  it.each(FIXTURES)('%s: los passengerTotalFare oficiales cuadran, sin warning', (_n, fixture) => {
    const result = run(clone(fixture));
    expect(codes(result.warnings)).not.toContain('pax-base-fare-derived');
    expect(codes(result.warnings)).not.toContain('offer-base-fare-derived');
  });

  it.each(FIXTURES)('%s: Σ paxCount × (base + tax) === total de la oferta', (_n, fixture) => {
    for (const offer of run(clone(fixture)).offers) {
      const sum = (offer.fareBreakdown ?? []).reduce(
        (acc, entry) =>
          acc + entry.paxCount * (entry.basePerPax.amountMinor + entry.taxesPerPax.amountMinor),
        0,
      );
      expect(sum).toBe(offer.total.amountMinor);
    }
  });

  it('si la descripción del contrato fuera literal, la base se deriva y se avisa', () => {
    // "Equivalent amount - includes taxes and additional charges" (`v5.yml:8565`). Aquí se simula
    // esa lectura: equivalentAmount = totalFare. Sin la defensa, el desglose contaría 73,80 USD de
    // impuestos dos veces y el vendedor vería 205,60 USD por pasajero en una oferta de 131,80.
    const payload = clone(adultFixture) as unknown as Json;
    const fare = passengerInfos(payload)[0]?.['passengerTotalFare'] as Json;
    fare['equivalentAmount'] = 131.8;

    const result = run(payload);
    const adt = (onlyOffer(result).fareBreakdown ?? [])[0];
    expect(adt?.basePerPax).toEqual({ amountMinor: 5800, currency: 'USD' });
    expect(adt?.taxesPerPax).toEqual({ amountMinor: 7380, currency: 'USD' });
    expect(codes(result.warnings)).toContain('pax-base-fare-derived');
  });

  it('el desajuste nunca pasa en silencio: hay warning con la ruta del pasajero', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const fare = passengerInfos(payload)[0]?.['passengerTotalFare'] as Json;
    fare['equivalentAmount'] = 999;

    const warning = run(payload).warnings.find((w) => w.code === 'pax-base-fare-derived');
    expect(warning?.path).toContain('passengerInfoList[0]');
  });

  it('el mismo invariante protege el total de la oferta', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const totalFare = firstPricing(payload)['fare'] as Json;
    (totalFare['totalFare'] as Json)['equivalentAmount'] = 131.8;

    const result = run(payload);
    expect(onlyOffer(result).baseFare).toEqual({ amountMinor: 5800, currency: 'USD' });
    expect(codes(result.warnings)).toContain('offer-base-fare-derived');
  });

  it('un céntimo de deriva no gasta un warning, pero sí hace cuadrar la suma', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const fare = passengerInfos(payload)[0]?.['passengerTotalFare'] as Json;
    fare['equivalentAmount'] = 57.99;

    const result = run(payload);
    const adt = (onlyOffer(result).fareBreakdown ?? [])[0];
    expect(adt?.basePerPax).toEqual({ amountMinor: 5800, currency: 'USD' });
    expect(codes(result.warnings)).not.toContain('pax-base-fare-derived');
  });

  it('dos céntimos ya son desajuste declarado', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const fare = passengerInfos(payload)[0]?.['passengerTotalFare'] as Json;
    fare['equivalentAmount'] = 57.98;

    expect(codes(run(payload).warnings)).toContain('pax-base-fare-derived');
  });

  it('sin `equivalentAmount` se deriva restando, también con warning', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const fare = passengerInfos(payload)[0]?.['passengerTotalFare'] as Json;
    delete fare['equivalentAmount'];

    const result = run(payload);
    const adt = (onlyOffer(result).fareBreakdown ?? [])[0];
    expect(adt?.basePerPax).toEqual({ amountMinor: 5800, currency: 'USD' });
    expect(codes(result.warnings)).toContain('pax-base-fare-derived');
  });
});

// ---------------------------------------------------------------------------
// TRAMPA 3 — la fecha del tramo sale de legDescriptions POR POSICIÓN
// ---------------------------------------------------------------------------

describe('trampa 3 — fechas por posición, no por `ref`', () => {
  it('ejemplo 1: legs=[{ref:2},{ref:1}] y aun así la ida es la del legDescriptions[0]', () => {
    const offer = onlyOffer(run(clone(adultFixture)));
    const [outbound, inbound] = offer.itineraries ?? [];

    // legDescriptions[0] = 2026-09-11 WAW→SPU. Indexar por `ref` daría 2026-09-18: ida y vuelta
    // intercambiadas, sin excepción ninguna.
    expect(outbound?.segments[0]?.origin).toBe('WAW');
    expect(outbound?.segments[0]?.destination).toBe('SPU');
    expect(outbound?.segments[0]?.departureAt).toBe('2026-09-11T14:20:00+02:00');
    expect(outbound?.segments[0]?.arrivalAt).toBe('2026-09-11T16:20:00+02:00');

    expect(inbound?.segments[0]?.origin).toBe('SPU');
    expect(inbound?.segments[0]?.destination).toBe('WAW');
    expect(inbound?.segments[0]?.departureAt).toBe('2026-09-18T17:10:00+02:00');
    expect(inbound?.segments[0]?.arrivalAt).toBe('2026-09-18T19:05:00+02:00');
  });

  it('ejemplo 3: dos husos distintos en el mismo segmento se conservan tal cual', () => {
    const offer = onlyOffer(run(clone(familyFixture)));
    const outbound = (offer.itineraries ?? [])[0];
    expect(outbound?.segments[0]?.departureAt).toBe('2026-06-04T09:55:00-05:00');
    expect(outbound?.segments[0]?.arrivalAt).toBe('2026-06-04T11:32:00-07:00');
    expect((offer.itineraries ?? [])[1]?.segments[0]?.departureAt).toBe(
      '2026-06-11T12:11:00-07:00',
    );
  });

  it('`departureDateAdjustment` empuja la salida al día siguiente', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    const legDescs = body['legDescs'] as Json[];
    ((legDescs[1] as Json)['schedules'] as Json[])[0] = { ref: 2, departureDateAdjustment: 1 };

    const outbound = (onlyOffer(run(payload)).itineraries ?? [])[0];
    expect(outbound?.segments[0]?.departureAt).toBe('2026-09-12T14:20:00+02:00');
  });

  it('vuelo nocturno con cambio de día: `arrival.dateAdjustment` mueve sólo la llegada', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    const schedules = body['scheduleDescs'] as Json[];
    const nightbound = schedules[1] as Json;
    (nightbound['departure'] as Json)['time'] = '23:50:00+02:00';
    nightbound['arrival'] = { airport: 'SPU', time: '01:20:00+02:00', dateAdjustment: 1 };

    const outbound = (onlyOffer(run(payload)).itineraries ?? [])[0];
    expect(outbound?.segments[0]?.departureAt).toBe('2026-09-11T23:50:00+02:00');
    expect(outbound?.segments[0]?.arrivalAt).toBe('2026-09-12T01:20:00+02:00');
  });

  it('los dos ajustes se acumulan y cruzan el fin de año', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    const groups = body['itineraryGroups'] as Json[];
    const legDescriptions = ((groups[0] as Json)['groupDescription'] as Json)[
      'legDescriptions'
    ] as Json[];
    (legDescriptions[0] as Json)['departureDate'] = '2026-12-31';

    const legDescs = body['legDescs'] as Json[];
    ((legDescs[1] as Json)['schedules'] as Json[])[0] = { ref: 2, departureDateAdjustment: 1 };
    const schedules = body['scheduleDescs'] as Json[];
    (schedules[1] as Json)['arrival'] = {
      airport: 'SPU',
      time: '02:20:00+02:00',
      dateAdjustment: 1,
    };

    const outbound = (onlyOffer(run(payload)).itineraries ?? [])[0];
    expect(outbound?.segments[0]?.departureAt).toBe('2027-01-01T14:20:00+02:00');
    expect(outbound?.segments[0]?.arrivalAt).toBe('2027-01-02T02:20:00+02:00');
  });

  it('un `legs[].ref` que no resuelve descarta la oferta con warning, no la inventa', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    const groups = body['itineraryGroups'] as Json[];
    const itineraries = (groups[0] as Json)['itineraries'] as Json[];
    ((itineraries[0] as Json)['legs'] as Json[])[0] = { ref: 99 };

    const result = run(payload);
    expect(result.offers).toHaveLength(0);
    expect(codes(result.warnings)).toContain('leg-ref-unresolved');
  });

  it('si `legs[].departureDate` contradice a `legDescriptions[]`, se avisa', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    const groups = body['itineraryGroups'] as Json[];
    const itineraries = (groups[0] as Json)['itineraries'] as Json[];
    // `LegIDType.departureDate` viene como datetime (`v5.yml:4264`), no como fecha civil.
    ((itineraries[0] as Json)['legs'] as Json[])[0] = {
      ref: 2,
      departureDate: '2026-09-13T00:00:00.000Z',
    };

    const result = run(payload);
    expect(codes(result.warnings)).toContain('departure-date-conflict');
    // Gana la posición: la fecha publicada del tramo 0.
    expect((onlyOffer(result).itineraries ?? [])[0]?.segments[0]?.departureAt).toBe(
      '2026-09-11T14:20:00+02:00',
    );
  });

  it('una hora sin offset no se completa a ciegas: se descarta y se avisa', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    const schedules = body['scheduleDescs'] as Json[];
    // `Arrival.time` documenta `'01:05:00'` sin offset (`v5.yml:2540`).
    (schedules[1] as Json)['arrival'] = { airport: 'SPU', time: '16:20:00' };

    const result = run(payload);
    expect(result.offers).toHaveLength(0);
    expect(codes(result.warnings)).toContain('missing-utc-offset');
  });
});

describe('addDaysToIsoDate', () => {
  it.each([
    ['2026-09-11', 0, '2026-09-11'],
    ['2026-09-11', 1, '2026-09-12'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-06-04', 2, '2026-06-06'],
  ])('%s %+d → %s', (date, days, expected) => {
    expect(addDaysToIsoDate(date, days)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// TRAMPA 4 — passengerNumber es CANTIDAD y el paxType se repite
// ---------------------------------------------------------------------------

describe('trampa 4 — agrupar sumando, nunca indexar por paxType', () => {
  it('ejemplo 3: ADT ×2 + ADT ×1 = una entrada de 3, no una de 1 que pisa a la otra', () => {
    const offer = onlyOffer(run(clone(familyFixture)));
    const breakdown = offer.fareBreakdown ?? [];
    const adults = breakdown.filter((entry) => entry.paxType === 'ADT');

    expect(adults).toHaveLength(1);
    expect(adults[0]?.paxCount).toBe(3);
    expect(adults[0]?.basePerPax).toEqual({ amountMinor: 98800, currency: 'EUR' });
    expect(adults[0]?.taxesPerPax).toEqual({ amountMinor: 10146, currency: 'EUR' });

    const infants = breakdown.filter((entry) => entry.paxType === 'INF');
    expect(infants).toHaveLength(1);
    expect(infants[0]?.paxCount).toBe(1);
    expect(infants[0]?.basePerPax).toEqual({ amountMinor: 0, currency: 'EUR' });

    // La prueba aritmética de que `passengerNumber` es cantidad: 3 × 1089,46 = 3268,38.
    expect(3 * (98800 + 10146)).toBe(offer.total.amountMinor);
  });

  it('dos grupos del mismo paxType a precios distintos siguen siendo dos entradas', () => {
    const payload = clone(familyFixture) as unknown as Json;
    const second = passengerInfos(payload)[1];
    const fare = second?.['passengerTotalFare'] as Json;
    fare['totalFare'] = 1200.46;
    fare['equivalentAmount'] = 1099;
    fare['totalTaxAmount'] = 101.46;

    const breakdown = onlyOffer(run(payload)).fareBreakdown ?? [];
    const adults = breakdown.filter((entry) => entry.paxType === 'ADT');
    expect(adults).toHaveLength(2);
    expect(adults.map((entry) => entry.paxCount).sort()).toEqual([1, 2]);
  });

  it('ejemplo 2: `C06` es un niño, no un código desconocido', () => {
    const breakdown = onlyOffer(run(clone(childFixture))).fareBreakdown ?? [];
    expect(breakdown.map((entry) => entry.paxType).sort()).toEqual(['ADT', 'CHD']);
    expect(breakdown.every((entry) => entry.paxCount === 1)).toBe(true);
  });

  it('un PTC que no sabemos encajar se descarta con warning: nunca se fuerza a ADT', () => {
    const payload = clone(childFixture) as unknown as Json;
    const second = passengerInfos(payload)[1];
    if (second) second['passengerType'] = 'ZZZ';

    const result = run(payload);
    const breakdown = onlyOffer(result).fareBreakdown ?? [];
    expect(breakdown.map((entry) => entry.paxType)).toEqual(['ADT']);
    const warning = result.warnings.find((w) => w.code === 'pax-type-unmapped');
    expect(warning?.detail).toBe('ZZZ');
  });

  it('sin `passengerNumber` se asume 1 y se avisa, en vez de romper el desglose', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const first = passengerInfos(payload)[0];
    if (first) delete first['passengerNumber'];

    const result = run(payload);
    expect((onlyOffer(result).fareBreakdown ?? [])[0]?.paxCount).toBe(1);
    expect(codes(result.warnings)).toContain('pax-count-missing');
  });

  it.each([
    ['ADT', 'ADT'],
    ['CNN', 'CHD'],
    ['CHD', 'CHD'],
    ['C06', 'CHD'],
    ['C11', 'CHD'],
    ['INF', 'INF'],
    ['INS', 'INF'],
  ] as const)('canonicalPaxType(%s) = %s', (code, expected) => {
    expect(canonicalPaxType(code)).toBe(expected);
  });

  it.each([['ZZZ'], ['SRC'], ['YTH'], [undefined]])('canonicalPaxType(%s) = null', (code) => {
    expect(canonicalPaxType(code)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TRAMPA 5 — expiresAt de ATPCO es política nuestra
// ---------------------------------------------------------------------------

describe('trampa 5 — `expiresAt` de ATPCO se etiqueta como política propia', () => {
  it.each(FIXTURES)('%s: fetchedAt + 90 s y `platform-policy`', (_n, fixture) => {
    for (const offer of run(clone(fixture)).offers) {
      expect(offer.expiresAtSource).toBe('platform-policy');
      expect(offer.expiresAt).toBe('2026-08-26T12:01:30.000Z');
      expect(new Date(offer.expiresAt).getTime() - new Date(offer.fetchedAt).getTime()).toBe(
        SABRE_ATPCO_OFFER_TTL_SECONDS * 1000,
      );
    }
  });

  it('el TTL de política es configurable, pero la etiqueta no cambia', () => {
    const offer = onlyOffer(run(clone(adultFixture), { offerTtlSeconds: 45 }));
    expect(offer.expiresAt).toBe('2026-08-26T12:00:45.000Z');
    expect(offer.expiresAtSource).toBe('platform-policy');
  });

  it('sólo un `offer.timeToLive` real autoriza a decir `provider`', () => {
    expect(resolveOfferExpiry({}, FETCHED_AT, 90)).toEqual({
      expiresAt: '2026-08-26T12:01:30.000Z',
      expiresAtSource: 'platform-policy',
    });
    expect(resolveOfferExpiry({ offer: { timeToLive: 600 } }, FETCHED_AT, 90)).toEqual({
      expiresAt: '2026-08-26T12:10:00.000Z',
      expiresAtSource: 'provider',
    });
    // Un TTL de 0 o negativo no es un TTL: cae a política, no a "vence ya" del proveedor.
    expect(resolveOfferExpiry({ offer: { timeToLive: 0 } }, FETCHED_AT, 90).expiresAtSource).toBe(
      'platform-policy',
    );
  });
});

// ---------------------------------------------------------------------------
// Rama NDC: punto de extensión, no mapeo silencioso
// ---------------------------------------------------------------------------

describe('rama NDC', () => {
  it('el contenido NDC se descarta con warning en vez de mapearse con reglas de ATPCO', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const pricing = firstPricing(payload);
    pricing['distributionModel'] = 'NDC';
    pricing['offer'] = { offerId: 'do3385fr4jsvzb1i30-1', source: 'NDC', timeToLive: 1255 };

    const result = run(payload);
    expect(result.offers).toHaveLength(0);
    const warning = result.warnings.find((w) => w.code === 'ndc-content-skipped');
    expect(warning?.detail).toBe('NDC');
  });

  it('`API` no es NDC: se mapea y conserva su carril declarado', () => {
    const payload = clone(adultFixture) as unknown as Json;
    firstPricing(payload)['distributionModel'] = 'API';
    expect(onlyOffer(run(payload)).provider.source).toBe('API');
  });
});

// ---------------------------------------------------------------------------
// Segmentos, itinerarios y datos de apoyo
// ---------------------------------------------------------------------------

describe('segmentos e itinerarios', () => {
  it('un `Itinerary` canónico = un `leg` de Sabre', () => {
    const offer = onlyOffer(run(clone(adultFixture)));
    expect(offer.itineraries).toHaveLength(2);
    expect(offer.itineraries?.[0]?.totalDurationMinutes).toBe(120);
    expect(offer.itineraries?.[1]?.totalDurationMinutes).toBe(115);
    expect(offer.itineraries?.[0]?.stops).toBe(0);
  });

  it('la cabina y la clase salen del árbol de PRECIO, no del de horario', () => {
    const segment = (onlyOffer(run(clone(adultFixture))).itineraries ?? [])[0]?.segments[0];
    expect(segment?.cabin).toBe('economy');
    // `bookingCode`, no `ResBookDesigCode` — que ni está en el esquema v5 ni en los ejemplos.
    expect(segment?.bookingClass).toBe('O');
    expect(JSON.stringify(adultFixture)).not.toContain('ResBookDesigCode');
  });

  it('el número de vuelo entero se convierte a string y el codeshare se conserva', () => {
    const segment = (onlyOffer(run(clone(adultFixture))).itineraries ?? [])[0]?.segments[0];
    expect(segment?.carrier).toBe('LO');
    expect(segment?.flightNumber).toBe('575');
    expect(segment?.operatingCarrier).toBe('LO');
    expect(segment?.operatingFlightNumber).toBe('575');
    expect(segment?.aircraft).toBe('E75');
    expect(segment?.durationMinutes).toBe(120);
  });

  it('`stops` cuenta conexiones MÁS escalas técnicas', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    (body['scheduleDescs'] as Json[]).forEach((schedule) => {
      schedule['stopCount'] = 1;
    });
    const legDescs = body['legDescs'] as Json[];
    (legDescs[1] as Json)['schedules'] = [{ ref: 2 }, { ref: 1 }];
    (legDescs[1] as Json)['elapsedTime'] = 300;
    // Un segmento de horario más exige un segmento tarificado más: la correspondencia es posicional.
    const components = passengerInfos(payload)[0]?.['fareComponents'] as Json[];
    ((components[0] as Json)['segments'] as Json[]).push({
      segment: { bookingCode: 'O', cabinCode: 'Y' },
    });

    const outbound = (onlyOffer(run(payload)).itineraries ?? [])[0];
    // 2 segmentos → 1 conexión, más 1 escala técnica en cada uno.
    expect(outbound?.segments).toHaveLength(2);
    expect(outbound?.stops).toBe(3);
  });

  it('si faltan segmentos tarificados no se reutiliza el anterior: se descarta y se avisa', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const first = passengerInfos(payload)[0];
    if (first) first['fareComponents'] = [(first['fareComponents'] as Json[])[0] as Json];

    const result = run(payload);
    expect(result.offers).toHaveLength(0);
    expect(codes(result.warnings)).toContain('priced-segment-missing');
  });

  it('una cabina desconocida descarta la oferta en vez de adivinarla', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const first = passengerInfos(payload)[0];
    const components = first?.['fareComponents'] as Json[];
    (((components[0] as Json)['segments'] as Json[])[0] as Json)['segment'] = {
      bookingCode: 'O',
      cabinCode: 'Q',
    };

    const result = run(payload);
    expect(result.offers).toHaveLength(0);
    const warning = result.warnings.find((w) => w.code === 'segment-invalid');
    expect(warning?.detail).toContain('Q');
  });
});

describe('políticas y datos del proveedor', () => {
  it('sin `penaltiesInfo` sólo se afirma lo que dice `nonRefundable`', () => {
    const offer = onlyOffer(run(clone(adultFixture)));
    expect(offer.policies).toEqual({ changeable: false, refundable: false });
  });

  it('con `penaltiesInfo` gana la aplicabilidad `Before`', () => {
    const offer = onlyOffer(run(clone(familyFixture)));
    expect(offer.policies).toEqual({ changeable: true, refundable: true });
  });

  it('`penaltiesInfo` de la rama NDC (nivel pricingInformation) también se lee', () => {
    const payload = clone(adultFixture) as unknown as Json;
    firstPricing(payload)['penaltiesInfo'] = {
      penalties: [
        { type: 'Refund', applicability: 'Before', refundable: true },
        { type: 'Refund', applicability: 'After', refundable: false },
        { type: 'Exchange', applicability: 'Before', changeable: false },
      ],
    };
    expect(onlyOffer(run(payload)).policies).toEqual({ changeable: false, refundable: true });
  });

  it('`raw` transporta el itinerario y el PCC, y nunca credenciales', () => {
    const raw = onlyOffer(run(clone(adultFixture))).provider.raw ?? {};
    expect(Array.isArray(raw['flights'])).toBe(true);
    expect(raw['flights']).toHaveLength(2);
    expect(raw['validatingCarrierCode']).toBe('LO');
    expect(raw['lastTicketDate']).toBe('2026-11-21');
    expect(raw['pricingSubsource']).toBe('HPIS');
    // El `raw` viaja al navegador dentro de la Offer: nada que se parezca a un secreto.
    const serialized = JSON.stringify(raw).toLowerCase();
    for (const forbidden of ['password', 'secret', 'authorization', 'access_token', 'epr']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('el equipaje facturado se conserva en `raw` y `Offer.baggage` no se inventa', () => {
    const result = run(clone(adultFixture));
    const offer = onlyOffer(result);
    // `Offer.baggage` obliga a declarar `carryOn` y `personalItem`, que el carril ATPCO no trae.
    expect(offer.baggage).toBeUndefined();
    expect(codes(result.warnings)).toContain('baggage-not-mapped');
    expect(offer.provider.raw?.['baggageAllowance']).toEqual([
      { paxType: 'ADT', pieceCount: 0, weight: null, unit: null },
      { paxType: 'ADT', pieceCount: 0, weight: null, unit: null },
    ]);
  });

  it('`fareFamily` sólo aparece si Sabre declara marca', () => {
    expect(onlyOffer(run(clone(adultFixture))).fareFamily).toBeUndefined();

    const payload = clone(adultFixture) as unknown as Json;
    firstPricing(payload)['brand'] = 'Flex';
    expect(onlyOffer(run(payload)).fareFamily).toEqual({ name: 'Flex', cabin: 'economy' });
  });

  it('`fees` sólo aparece si Sabre devuelve algún fee no nulo', () => {
    expect(onlyOffer(run(clone(adultFixture))).fees).toBeUndefined();

    const payload = clone(adultFixture) as unknown as Json;
    const totalFare = (firstPricing(payload)['fare'] as Json)['totalFare'] as Json;
    totalFare['serviceFeeAmount'] = 12.5;
    totalFare['creditCardFeeAmount'] = 2.5;
    expect(onlyOffer(run(payload)).fees).toEqual({ amountMinor: 1500, currency: 'USD' });
  });
});

// ---------------------------------------------------------------------------
// Borde: validación Zod y degradación declarada
// ---------------------------------------------------------------------------

describe('borde del proveedor', () => {
  it('un payload fuera de contrato lanza `SabreShopMappingError`', () => {
    expect(() => run({ nope: true })).toThrow(SabreShopMappingError);
    expect(() => run(null)).toThrow(SabreShopMappingError);
  });

  it('el error lleva rutas de Zod, nunca valores del payload', () => {
    let message = '';
    try {
      run({ groupedItineraryResponse: { version: '5', messages: 'PEREZ/JUAN MR' } });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('groupedItineraryResponse.messages');
    expect(message).not.toContain('PEREZ');
  });

  it('una respuesta sin itinerarios no es un error: son cero ofertas', () => {
    const result = run({ groupedItineraryResponse: { version: '5', messages: [] } });
    expect(result.offers).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it('un `severity` distinto de `Info` marca degradación y se propaga', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    (body['messages'] as Json[]).push({
      severity: 'Warning',
      type: 'SERVER',
      code: 'DEPRECATED',
      text: '139817283450172656',
    });

    const result = run(payload);
    expect(result.degraded).toBe(true);
    const warning = result.warnings.find((w) => w.code === 'provider-message');
    expect(warning?.detail).toBe('Warning/SERVER/DEPRECATED');
    // El `text` del proveedor es texto libre: no entra en un warning que se loguea.
    expect(JSON.stringify(result.warnings)).not.toContain('139817283450172656');
  });

  it('`legMissed` y `soldOut` son "te devolví menos de lo que había"', () => {
    const payload = clone(adultFixture) as unknown as Json;
    const body = payload['groupedItineraryResponse'] as Json;
    body['statistics'] = { itineraryCount: 1, legMissed: 2, soldOut: 0 };

    const result = run(payload);
    expect(result.degraded).toBe(true);
    expect(result.statistics?.legMissed).toBe(2);
    expect(codes(result.warnings)).toContain('provider-degraded');
  });

  it('cada oferta recibe un id propio', () => {
    const first = onlyOffer(run(clone(adultFixture)));
    const second = onlyOffer(run(clone(adultFixture)));
    expect(first.id).not.toBe(second.id);
  });
});
