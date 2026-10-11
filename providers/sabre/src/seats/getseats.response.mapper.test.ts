import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SeatMapSchema, type Offer, type Seat, type SeatMap } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { buildSabreGetSeatsRequest } from './getseats.request.builder';
import {
  SabreGetSeatsMappingError,
  SabreGetSeatsRejectedError,
  mapSabreGetSeatsResponse,
  type SabreGetSeatsMapContext,
  type SabreGetSeatsMapResult,
} from './getseats.response.mapper';

/**
 * Los cuatro fixtures son las respuestas OFICIALES de Get Seats v3, copiadas sin tocar un valor
 * (sólo reindentadas por prettier) de `docs/sabre/evidence/specs/help/get-seats-agency-3.0/`:
 *
 * | fixture                                   | origen                                                   |
 * | ----------------------------------------- | -------------------------------------------------------- |
 * | `getseats-payload-200.json`               | `get-seats-v3-get-seats-payload.txt:100-10366`           |
 * | `getseats-ndc-offer-id-200.json`          | `get-seats-v3-get-seats-ndc-offer-id.txt:21-3334`        |
 * | `getseats-ndc-offer-id-loyalty-200.json`  | `get-seats-v3-get-seats-ndc-offer-id-loyalty-data.txt:27-4283` |
 * | `getseats-payload-2pax-2seg-200.json`     | `get-seats-v3-get-seats-payload-2pax-2seg.txt:188-911`   |
 *
 * El último NO es v3: la página «2pax 2seg» de la documentación v3 todavía publica el contrato v1
 * (`aLaCarteOffer`, docs/sabre/03 §4.1). Está aquí para probar que el mapper lo rechaza con
 * nombre propio en vez de devolver un mapa vacío.
 *
 * Ningún ejemplo oficial trae cambio de equipo, un `1` sobre un asiento libre ni importes en
 * texto: esos casos se DERIVAN de un fixture oficial y van marcados como sintéticos.
 */

type Json = Record<string, unknown>;

const TENANT_ID = '11111111-2222-4333-8444-555555555555';

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf8')) as Json;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function responseOf(body: Json): Json {
  return body['response'] as Json;
}

function criteria(adults = 1, children = 0, infants = 0): FlightSearchCriteria {
  return {
    origin: 'SCL',
    destination: 'LIM',
    departureDate: '2026-03-02',
    paxCount: { adults, children, infants },
    currency: 'USD',
  };
}

interface SegmentInput {
  readonly carrier: string;
  readonly flightNumber: string;
  readonly origin: string;
  readonly destination: string;
  readonly departureAt: string;
  readonly arrivalAt: string;
  readonly bookingClass?: string;
}

function offerWith(itineraries: readonly (readonly SegmentInput[])[], source = 'ATPCO'): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT_ID,
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'seat-map-test', source },
    total: { amountMinor: 77700, currency: 'USD' },
    baseFare: { amountMinor: 70000, currency: 'USD' },
    taxes: { amountMinor: 7700, currency: 'USD' },
    itineraries: itineraries.map((segments) => ({
      totalDurationMinutes: 120,
      stops: segments.length - 1,
      segments: segments.map((segment) => ({
        carrier: segment.carrier,
        flightNumber: segment.flightNumber,
        origin: segment.origin,
        destination: segment.destination,
        departureAt: segment.departureAt,
        arrivalAt: segment.arrivalAt,
        durationMinutes: 120,
        cabin: 'economy' as const,
        bookingClass: segment.bookingClass ?? 'Y',
      })),
    })),
    fetchedAt: '2026-02-20T12:00:00.000Z',
    expiresAt: '2026-02-20T12:20:00.000Z',
  };
}

/** La oferta que corresponde al request del ejemplo oficial de payload: LA640 y LA477. */
function latamOffer(): Offer {
  return {
    ...offerWith([
      [
        {
          carrier: 'LA',
          flightNumber: '640',
          origin: 'SCL',
          destination: 'LIM',
          departureAt: '2026-03-02T13:40:00-03:00',
          arrivalAt: '2026-03-02T15:30:00-05:00',
        },
      ],
      [
        {
          carrier: 'LA',
          flightNumber: '477',
          origin: 'SCL',
          destination: 'EZE',
          departureAt: '2026-03-04T16:01:00-03:00',
          arrivalAt: '2026-03-04T18:04:00-03:00',
        },
      ],
    ]),
    fareComponents: [
      { fareBasisCode: 'YOWLGN3', brand: { code: 'EOU' }, segmentRefs: [0] },
      { fareBasisCode: 'YOWLGN4', brand: { code: 'EOU' }, segmentRefs: [1] },
    ],
  };
}

/** El contexto sale del builder REAL: así el test prueba también que los ids casan. */
function payloadContext(offer: Offer, paxCount = criteria(2)): SabreGetSeatsMapContext {
  const plan = buildSabreGetSeatsRequest(offer, paxCount);
  return {
    basis: offer,
    segmentIndexById: plan.segmentIndexById,
    passengerIndexById: plan.passengerIndexById,
  };
}

function ndcContext(
  offer: Offer,
  passengers: Record<string, number> = { Passenger1: 0 },
): SabreGetSeatsMapContext {
  return {
    basis: offer,
    segmentIndexById: new Map(),
    passengerIndexById: new Map(Object.entries(passengers)),
  };
}

/** BA5 LHR-HND del ejemplo NDC, precedido de un tramo que no tiene mapa. */
function britishOffer(departureAt = '2026-03-19T11:45:00+00:00'): Offer {
  return offerWith(
    [
      [
        {
          carrier: 'BA',
          flightNumber: '463',
          origin: 'MAD',
          destination: 'LHR',
          departureAt: '2026-03-19T07:00:00+01:00',
          arrivalAt: '2026-03-19T08:30:00+00:00',
        },
        {
          carrier: 'BA',
          flightNumber: '5',
          origin: 'LHR',
          destination: 'HND',
          departureAt,
          arrivalAt: '2026-03-20T10:25:00+09:00',
          bookingClass: 'H',
        },
      ],
    ],
    'NDC',
  );
}

/** QF500 SYD-BNE del ejemplo NDC con datos de viajero frecuente. */
function qantasOffer(): Offer {
  return offerWith(
    [
      [
        {
          carrier: 'QF',
          flightNumber: '500',
          origin: 'SYD',
          destination: 'BNE',
          departureAt: '2026-03-16T06:05:00+11:00',
          arrivalAt: '2026-03-16T06:35:00+10:00',
        },
      ],
    ],
    'NDC',
  );
}

function seatAt(map: SeatMap, segmentRef: number, row: number, column: string, legIndex = 0): Seat {
  const segment = map.segments.find(
    (item) => item.segmentRef === segmentRef && item.legIndex === legIndex,
  );
  const seat = segment?.cabins
    .flatMap((cabin) => cabin.rows)
    .find((item) => item.number === row)
    ?.seats.find((item) => item.column === column);
  if (seat === undefined) {
    throw new Error(`no hay asiento ${String(row)}${column} en ${String(segmentRef)}`);
  }
  return seat;
}

function rowAt(map: SeatMap, segmentRef: number, row: number) {
  const found = map.segments
    .find((item) => item.segmentRef === segmentRef)
    ?.cabins.flatMap((cabin) => cabin.rows)
    .find((item) => item.number === row);
  if (found === undefined) throw new Error(`no hay fila ${String(row)}`);
  return found;
}

function allSeats(map: SeatMap): Seat[] {
  return map.segments.flatMap((segment) =>
    segment.cabins.flatMap((cabin) => cabin.rows.flatMap((row) => row.seats)),
  );
}

function codes(result: SabreGetSeatsMapResult): string[] {
  return result.warnings.map((warning) => warning.code);
}

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

// ---------------------------------------------------------------------------------------------
// ATPCO por payload — ejemplo oficial: 2 adultos, LA640 SCL-LIM y LA477 SCL-EZE
// ---------------------------------------------------------------------------------------------

describe('payload ATPCO (ejemplo oficial)', () => {
  const offer = latamOffer();
  const result = mapSabreGetSeatsResponse(
    fixture('getseats-payload-200.json'),
    payloadContext(offer),
  );
  const map = result.seatMap;

  it('ubica los dos mapas en los dos segmentos de la oferta, sin cambio de equipo', () => {
    expect(
      map.segments.map(({ segmentRef, legIndex, changeOfGauge, cabins }) => ({
        segmentRef,
        legIndex,
        changeOfGauge,
        cabins: cabins.length,
      })),
    ).toEqual([
      { segmentRef: 0, legIndex: 0, changeOfGauge: false, cabins: 1 },
      { segmentRef: 1, legIndex: 0, changeOfGauge: false, cabins: 1 },
    ]);
    expect(result.droppedSeatMaps).toBe(0);
    expect(result.offerId).toBe('ih5d79946bb5lczk7mlj969ap0');
  });

  it('pinta la cabina: turista, columnas A-F con pasillo tras la C, filas 5 a 30', () => {
    for (const segment of map.segments) {
      const cabin = segment.cabins[0]!;
      expect(cabin.cabin).toBe('economy');
      expect(cabin.columns).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      expect(cabin.aisleAfter).toEqual(['C']);
      expect(cabin.rows.map((row) => row.number)).toEqual(
        Array.from({ length: 26 }, (_, index) => index + 5),
      );
      // `cabinLayout.seatCount: 156` del propio fixture: no se perdió ni se inventó un asiento.
      expect(cabin.rows.reduce((sum, row) => sum + row.seats.length, 0)).toBe(156);
    }
  });

  it('el precio va POR PASAJERO: el asiento 5A tiene un offerItem para cada adulto', () => {
    expect(seatAt(map, 0, 5, 'A')).toEqual({
      column: 'A',
      available: true,
      characteristics: ['WINDOW', 'EXTRA_LEGROOM'],
      adultOnly: false,
      infantAllowed: true,
      offers: [
        { passengerIndex: 0, price: usd(5200), offerRef: 'ih5d79946bb5lczk7mlj969ap0-18' },
        { passengerIndex: 1, price: usd(5200), offerRef: 'ih5d79946bb5lczk7mlj969ap0-25' },
      ],
    });
    // Otro tramo, otro precio para el mismo asiento: el mapa no se aplana entre segmentos.
    expect(seatAt(map, 1, 5, 'A').offers.map((offer) => offer.price)).toEqual([
      usd(3700),
      usd(3700),
    ]);
  });

  it('traduce ubicación por código PADIS: W ventana, 9 centro, A pasillo', () => {
    expect(seatAt(map, 0, 20, 'A').characteristics).toEqual(['WINDOW']);
    expect(seatAt(map, 0, 20, 'B').characteristics).toEqual(['MIDDLE']);
    expect(seatAt(map, 0, 20, 'C').characteristics).toEqual(['AISLE']);
    expect(seatAt(map, 0, 20, 'D').characteristics).toEqual(['AISLE']);
  });

  it('filas 11 y 12 de salida de emergencia: sólo adultos y sin infante en brazos', () => {
    for (const row of [11, 12]) {
      for (const seat of rowAt(map, 0, row).seats) {
        expect(seat.characteristics).toContain('EXIT_ROW');
        expect(seat.adultOnly).toBe(true);
        expect(seat.infantAllowed).toBe(false);
      }
    }
    expect(seatAt(map, 0, 13, 'A')).toMatchObject({
      adultOnly: false,
      infantAllowed: true,
      characteristics: ['WINDOW'],
    });
  });

  it('distingue sin cargo (0) de precio no informado (ausente)', () => {
    // Fila 11: Sabre la ofrece a 0 USD. Es la única forma de decir «gratis».
    expect(seatAt(map, 0, 11, 'A').offers.map((offer) => offer.price)).toEqual([usd(0), usd(0)]);
    // 5C apunta a `priceDefinitions` `{ "totalPrice": {} }` (sin moneda ni importe): se puede
    // ofrecer, pero su precio NO es cero y no puede salir como gratis.
    const fiveC = seatAt(map, 0, 5, 'C');
    expect(fiveC.available).toBe(true);
    expect(fiveC.offers).toEqual([
      { passengerIndex: 0, offerRef: 'ih5d79946bb5lczk7mlj969ap0-24' },
      { passengerIndex: 1, offerRef: 'ih5d79946bb5lczk7mlj969ap0-32' },
    ]);
  });

  it('avisa una vez por offerItem sin precio, no una por asiento', () => {
    // Los ids 8, 16, 24 y 32 son los únicos `priceDefinitions` vacíos del ejemplo.
    expect(result.warnings).toEqual(
      ['7', '15', '23', '31'].map((index) => ({
        code: 'seat-price-undetermined',
        path: `response.offerItems.${index}`,
        detail: 'sin moneda',
      })),
    );
    expect(map.warnings).toEqual(['seat-price-undetermined']);
  });

  it('cumple el contrato canónico y no arrastra los nombres de los pasajeros', () => {
    expect(SeatMapSchema.safeParse(map).success).toBe(true);
    const serialized = JSON.stringify(result);
    for (const name of ['Edmunt', 'Marianna', 'Kolodziej']) {
      expect(serialized).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// NDC por offerId — ejemplo oficial: BA5 LHR-HND, 1 adulto
// ---------------------------------------------------------------------------------------------

describe('NDC por offerId (ejemplo oficial)', () => {
  const offer = britishOffer();
  const result = mapSabreGetSeatsResponse(
    fixture('getseats-ndc-offer-id-200.json'),
    ndcContext(offer),
  );
  const map = result.seatMap;

  it('casa el segmento BA0005 con el vuelo de la oferta, no por posición', () => {
    expect(map.segments.map((segment) => segment.segmentRef)).toEqual([1]);
    expect(result.warnings).toEqual([]);
    expect(map.warnings).toEqual([]);
  });

  it('cabina M es turista, 3-3-3 con pasillos tras la C y tras la F', () => {
    const cabin = map.segments[0]!.cabins[0]!;
    expect(cabin.cabin).toBe('economy');
    expect(cabin.columns).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'H', 'J', 'K']);
    expect(cabin.aisleAfter).toEqual(['C', 'F']);
    expect(cabin.rows.map((row) => row.number)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 30),
    );
  });

  it('un asiento ocupado (O) no está disponible ni lleva ofertas', () => {
    expect(seatAt(map, 1, 30, 'D')).toEqual({
      column: 'D',
      available: false,
      characteristics: ['AISLE', 'EXIT_ROW'],
      adultOnly: true,
      infantAllowed: false,
      offers: [],
    });
    expect(allSeats(map).filter((seat) => !seat.available)).toHaveLength(18);
  });

  it('cuna (B) y precio en la moneda de la aerolínea', () => {
    expect(seatAt(map, 1, 30, 'E').characteristics).toContain('BASSINET');
    expect(seatAt(map, 1, 30, 'A')).toMatchObject({
      available: true,
      adultOnly: true,
      offers: [
        {
          passengerIndex: 0,
          price: { amountMinor: 16200, currency: 'AUD' },
          offerRef: 'ih5d79946bb5lczk7mljae35t0-5',
        },
      ],
    });
  });

  it('sin vínculo con el pasajero, ningún asiento se ofrece y se avisa una sola vez', () => {
    const orphan = mapSabreGetSeatsResponse(
      fixture('getseats-ndc-offer-id-200.json'),
      ndcContext(offer, {}),
    );
    expect(allSeats(orphan.seatMap).some((seat) => seat.available)).toBe(false);
    expect(codes(orphan)).toEqual(['seat-offer-passenger-unknown']);
  });

  it('un vuelo que no está en la oferta descarta el mapa entero', () => {
    const otherDay = mapSabreGetSeatsResponse(
      fixture('getseats-ndc-offer-id-200.json'),
      ndcContext(britishOffer('2026-03-20T11:45:00+00:00')),
    );
    expect(otherDay.seatMap.segments).toEqual([]);
    expect(otherDay.droppedSeatMaps).toBe(1);
    expect(otherDay.warnings).toEqual([
      { code: 'seat-map-segment-unmatched', path: 'response.seatMaps.0.segmentRef' },
    ]);
  });

  it('dos segmentos idénticos en la oferta son ambiguos: no se elige uno al azar', () => {
    const base = britishOffer();
    const twice: Offer = {
      ...base,
      itineraries: [...(base.itineraries ?? []), ...(base.itineraries ?? [])],
    };
    const ambiguous = mapSabreGetSeatsResponse(
      fixture('getseats-ndc-offer-id-200.json'),
      ndcContext(twice),
    );
    expect(ambiguous.seatMap.segments).toEqual([]);
    expect(codes(ambiguous)).toEqual(['seat-map-segment-unmatched']);
  });
});

// ---------------------------------------------------------------------------------------------
// NDC con viajero frecuente — el ejemplo con más códigos PADIS: Q, Z, 1, 1A, 1D, 1W, IE
// ---------------------------------------------------------------------------------------------

describe('códigos PADIS (ejemplo oficial NDC con viajero frecuente)', () => {
  const offer = qantasOffer();
  const body = fixture('getseats-ndc-offer-id-loyalty-200.json');
  const result = mapSabreGetSeatsResponse(body, ndcContext(offer));
  const map = result.seatMap;

  it('Q («no hay asiento») es un hueco del layout, no un asiento ocupado', () => {
    expect(rowAt(map, 0, 20).seats.map((seat) => seat.column)).toEqual(['A', 'B']);
    expect(rowAt(map, 0, 21).seats).toEqual([]);
  });

  it('Z (bloqueado) no se ofrece aunque traiga offerItem', () => {
    expect(seatAt(map, 0, 4, 'A')).toMatchObject({ available: false, offers: [] });
    expect(seatAt(map, 0, 10, 'C')).toMatchObject({ available: false, offers: [] });
  });

  it('1W: ventanilla sin ventana NO se promete como ventana', () => {
    // 9A trae a la vez `W` (Window) y `1W` (WindowSeatWithoutWindow).
    expect(seatAt(map, 0, 9, 'A').characteristics).not.toContain('WINDOW');
    expect(seatAt(map, 0, 9, 'B').characteristics).toEqual(['MIDDLE']);
  });

  it('fila 13: salida, no reclina, más espacio, sólo adultos, sin infante', () => {
    expect(seatAt(map, 0, 13, 'A')).toEqual({
      column: 'A',
      available: true,
      characteristics: ['WINDOW', 'EXIT_ROW', 'EXTRA_LEGROOM', 'NO_RECLINE'],
      adultOnly: true,
      infantAllowed: false,
      offers: [{ passengerIndex: 0, price: usd(3000), offerRef: 'ih6b6ccd76bdvsjhgmlkxo6qc0-2' }],
    });
  });

  it('1D (no reclina) se muestra pero no restringe a nadie', () => {
    expect(seatAt(map, 0, 12, 'C')).toMatchObject({
      available: true,
      characteristics: ['AISLE', 'NO_RECLINE'],
      adultOnly: false,
      infantAllowed: true,
    });
  });

  it('asiento libre sin cargo y filas sobre el ala sin tratamiento especial', () => {
    expect(seatAt(map, 0, 6, 'A').offers).toEqual([
      { passengerIndex: 0, price: usd(0), offerRef: 'ih6b6ccd76bdvsjhgmlkxo6qc0-1' },
    ]);
    expect(seatAt(map, 0, 15, 'A')).toMatchObject({
      characteristics: ['WINDOW'],
      adultOnly: false,
    });
  });

  it('[sintético] un 1 (RestrictedGeneral) sobre un asiento libre lo deja fuera de venta', () => {
    const variant = clone(body);
    const seat = seatNode(variant, 0, 4, 'A');
    seat['occupationStatusCode'] = 'F';
    const mapped = mapSabreGetSeatsResponse(variant, ndcContext(offer));
    expect(seatAt(mapped.seatMap, 0, 4, 'A')).toMatchObject({ available: false, offers: [] });
  });

  it('[sintético] 1A solo prohíbe el infante; IE solo, el niño', () => {
    const variant = clone(body);
    addCode(seatNode(variant, 0, 7, 'A'), '1A');
    addCode(seatNode(variant, 0, 7, 'B'), 'IE');
    const mapped = mapSabreGetSeatsResponse(variant, ndcContext(offer)).seatMap;
    expect(seatAt(mapped, 0, 7, 'A')).toMatchObject({ adultOnly: false, infantAllowed: false });
    expect(seatAt(mapped, 0, 7, 'B')).toMatchObject({ adultOnly: true, infantAllowed: true });
  });

  it('[sintético] isOperative:false y un asiento sólo de exhibición no se venden', () => {
    const variant = clone(body);
    seatNode(variant, 0, 7, 'C')['isOperative'] = false;
    const displayOnly = seatNode(variant, 0, 7, 'D');
    displayOnly['displayOnlyItemRefIds'] = displayOnly['offerItemRefIds'];
    delete displayOnly['offerItemRefIds'];
    const mapped = mapSabreGetSeatsResponse(variant, ndcContext(offer)).seatMap;
    expect(seatAt(mapped, 0, 7, 'C').available).toBe(false);
    expect(seatAt(mapped, 0, 7, 'D').available).toBe(false);
    expect(seatAt(mapped, 0, 7, 'E').available).toBe(true);
  });
});

function seatNode(body: Json, mapIndex: number, row: number, column: string): Json {
  const seatMaps = responseOf(body)['seatMaps'] as Json[];
  const compartments = seatMaps[mapIndex]!['cabinCompartments'] as Json[];
  for (const compartment of compartments) {
    for (const seatRow of compartment['seatRows'] as Json[]) {
      if (seatRow['row'] !== row) continue;
      const seat = (seatRow['seats'] as Json[]).find((item) => item['column'] === column);
      if (seat !== undefined) return seat;
    }
  }
  throw new Error(`fixture sin asiento ${String(row)}${column}`);
}

function addCode(seat: Json, code: string): void {
  (seat['characteristics'] as Json[]).push({ code });
}

// ---------------------------------------------------------------------------------------------
// El ejemplo «2pax 2seg» de la documentación v3 es contrato v1
// ---------------------------------------------------------------------------------------------

describe('contrato v1 (ejemplo oficial «2pax 2seg»)', () => {
  it('se rechaza con nombre propio, sin valores de la respuesta en el mensaje', () => {
    let caught: unknown;
    try {
      mapSabreGetSeatsResponse(
        fixture('getseats-payload-2pax-2seg-200.json'),
        payloadContext(latamOffer()),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SabreGetSeatsMappingError);
    const error = caught as SabreGetSeatsMappingError;
    expect(error.issues[0]).toBe('response.aLaCarteOffer:legacy_v1_contract');
    expect(error.issues).toContain('response.segments:invalid_type');
    // Nombres, programa y números de viajero frecuente del ejemplo: nada de eso sale.
    for (const value of ['GOLD', 'SILVER', 'SABRE', '7570011066', '3250011685']) {
      expect(error.message).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Cambio de equipo — ningún ejemplo oficial lo trae: se deriva del de payload
// ---------------------------------------------------------------------------------------------

describe('[sintético] cambio de equipo', () => {
  function withSecondAircraft(flag: boolean): Json {
    const body = fixture('getseats-payload-200.json');
    const response = responseOf(body);
    const segment = (response['segments'] as Json[])[0]!;
    segment['isChangeOfGauge'] = flag;
    segment['flightLegs'] = [
      { id: '0', departureAirportCode: 'SCL', arrivalAirportCode: 'ANF', aircraftCode: '320' },
      { id: '1', departureAirportCode: 'ANF', arrivalAirportCode: 'LIM', aircraftCode: '321' },
    ];
    const seatMaps = response['seatMaps'] as Json[];
    const second = clone(seatMaps[0]!);
    second['flightLegRef'] = '1';
    seatMaps.splice(1, 0, second);
    return body;
  }

  it('dos aviones en el mismo segmento: dos mapas, legIndex 0 y 1, ambos marcados', () => {
    const result = mapSabreGetSeatsResponse(withSecondAircraft(true), payloadContext(latamOffer()));
    expect(
      result.seatMap.segments.map(({ segmentRef, legIndex, changeOfGauge }) => ({
        segmentRef,
        legIndex,
        changeOfGauge,
      })),
    ).toEqual([
      { segmentRef: 0, legIndex: 0, changeOfGauge: true },
      { segmentRef: 0, legIndex: 1, changeOfGauge: true },
      { segmentRef: 1, legIndex: 0, changeOfGauge: false },
    ]);
  });

  it('se marca aunque Sabre no lo declare, si el segmento trae dos flightLegs', () => {
    const result = mapSabreGetSeatsResponse(
      withSecondAircraft(false),
      payloadContext(latamOffer()),
    );
    expect(result.seatMap.segments.filter((segment) => segment.changeOfGauge)).toHaveLength(2);
  });

  it('un mapa sin flightLegRef en un segmento de dos aviones no se adivina', () => {
    const body = withSecondAircraft(true);
    delete ((responseOf(body)['seatMaps'] as Json[])[0] as Json)['flightLegRef'];
    const result = mapSabreGetSeatsResponse(body, payloadContext(latamOffer()));
    expect(codes(result)).toContain('seat-map-leg-unmatched');
    expect(result.seatMap.segments.map((segment) => segment.legIndex)).toEqual([1, 0]);
  });

  it('sin flightLegs, un segundo mapa del mismo segmento es un duplicado, no otro avión', () => {
    const body = fixture('getseats-payload-200.json');
    const response = responseOf(body);
    delete ((response['segments'] as Json[])[0] as Json)['flightLegs'];
    const seatMaps = response['seatMaps'] as Json[];
    const copy = clone(seatMaps[0]!);
    seatMaps.push(copy);
    const result = mapSabreGetSeatsResponse(body, payloadContext(latamOffer()));
    // Sin flightLegs el segundo mapa cae al avión 0: es un duplicado, no un segundo avión.
    expect(codes(result)).toContain('seat-map-duplicate');
    expect(result.seatMap.segments.map((segment) => segment.changeOfGauge)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------------------------
// Bordes del contrato, sobre una respuesta mínima derivada del ejemplo NDC
// ---------------------------------------------------------------------------------------------

/**
 * Respuesta v3 mínima con la forma del ejemplo NDC: un segmento, un pasajero, una cabina 2-2 y una
 * fila con dos asientos ofrecidos. Cada test cambia SÓLO lo que mide.
 */
function minimal(): Json {
  return {
    response: {
      offerId: 'offer-1',
      segments: [
        {
          id: 'S1',
          bookingAirlineCode: 'QF',
          bookingFlightNumber: 500,
          departureAirportCode: 'SYD',
          arrivalAirportCode: 'BNE',
          departureDate: '2026-03-16',
          flightLegs: [{ id: 'L1', departureAirportCode: 'SYD', arrivalAirportCode: 'BNE' }],
        },
      ],
      passengers: [{ id: 'Passenger1', passengerType: 'ADT', givenName: 'ANA', surname: 'ROJAS' }],
      serviceDefinitions: [{ id: 'sd-1' }],
      priceDefinitions: [
        { id: 'p1', currencyCode: 'USD', totalPrice: { amount: 12.5 } },
        { id: 'p2', currencyCode: 'USD', totalPrice: { amount: '100.00' } },
      ],
      offerItems: [
        {
          id: 'item-1',
          serviceDefinitionRef: 'sd-1',
          priceDefinitionRef: 'p1',
          segmentRefs: ['S1'],
          passengerRefs: ['Passenger1'],
        },
        {
          id: 'item-2',
          serviceDefinitionRef: 'sd-1',
          priceDefinitionRef: 'p2',
          segmentRefs: ['S1'],
          passengerRefs: ['Passenger1'],
        },
      ],
      seatMaps: [
        {
          segmentRef: 'S1',
          cabinCompartments: [
            {
              cabinCode: 'C',
              cabinLayout: {
                columns: [
                  { id: 'A', position: ['W'] },
                  { id: 'C', position: ['A'] },
                  { id: 'D', position: ['A'] },
                  { id: 'F', position: ['W'] },
                ],
                rows: { firstRow: 1, lastRow: 1 },
              },
              seatRows: [
                {
                  row: 1,
                  seats: [
                    {
                      column: 'A',
                      occupationStatusCode: 'F',
                      characteristics: [{ code: 'W' }],
                      offerItemRefIds: ['item-1'],
                    },
                    {
                      column: 'C',
                      occupationStatusCode: 'F',
                      characteristics: [{ code: 'A' }],
                      offerItemRefIds: ['item-2'],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function mapMinimal(body: Json = minimal()): SabreGetSeatsMapResult {
  return mapSabreGetSeatsResponse(body, ndcContext(qantasOffer()));
}

function compartment(body: Json): Json {
  const seatMap = (responseOf(body)['seatMaps'] as Json[])[0]!;
  return (seatMap['cabinCompartments'] as Json[])[0]!;
}

function firstRowSeats(body: Json): Json[] {
  return ((compartment(body)['seatRows'] as Json[])[0]!['seats'] as Json[]) ?? [];
}

function priceDefinition(body: Json, index: number): Json {
  return (responseOf(body)['priceDefinitions'] as Json[])[index]!;
}

describe('importes', () => {
  it('número JSON e importe en texto se convierten sin coma flotante', () => {
    const map = mapMinimal().seatMap;
    expect(seatAt(map, 0, 1, 'A').offers[0]?.price).toEqual(usd(1250));
    expect(seatAt(map, 0, 1, 'C').offers[0]?.price).toEqual(usd(10000));
    expect(map.segments[0]?.cabins[0]?.cabin).toBe('business');
  });

  it.each([
    ['tercer decimal distinto de cero', '12.345'],
    ['negativo', '-5'],
    ['notación exponencial', 1e21],
    ['texto que no es número', 'gratis'],
  ])('%s: precio no informado, nunca redondeado ni regalado', (_caso, amount) => {
    const body = minimal();
    priceDefinition(body, 0)['totalPrice'] = { amount };
    const result = mapMinimal(body);
    const seat = seatAt(result.seatMap, 0, 1, 'A');
    expect(seat.available).toBe(true);
    expect(seat.offers).toEqual([{ passengerIndex: 0, offerRef: 'item-1' }]);
    expect(result.warnings).toEqual([
      {
        code: 'seat-price-undetermined',
        path: 'response.offerItems.0',
        detail: 'importe no representable',
      },
    ]);
  });

  it('19.99 como número JSON da 1999 exactos (en coma flotante, 19.99 * 100 no lo da)', () => {
    const body = minimal();
    priceDefinition(body, 0)['totalPrice'] = { amount: 19.99 };
    expect(19.99 * 100).not.toBe(1999);
    expect(seatAt(mapMinimal(body).seatMap, 0, 1, 'A').offers[0]?.price).toEqual(usd(1999));
  });

  it('un tercer decimal en cero sí es representable', () => {
    const body = minimal();
    priceDefinition(body, 0)['totalPrice'] = { amount: '12.340' };
    expect(seatAt(mapMinimal(body).seatMap, 0, 1, 'A').offers[0]?.price).toEqual(usd(1234));
  });

  it.each([
    ['sin priceDefinitionRef', (body: Json) => delete offerItem(body, 0)['priceDefinitionRef']],
    ['priceDefinition ausente', (body: Json) => (offerItem(body, 0)['priceDefinitionRef'] = 'x')],
    ['sin moneda', (body: Json) => delete priceDefinition(body, 0)['currencyCode']],
    ['sin importe', (body: Json) => (priceDefinition(body, 0)['totalPrice'] = {})],
  ])('%s: precio no informado', (detail, mutate) => {
    const body = minimal();
    mutate(body);
    const result = mapMinimal(body);
    expect(seatAt(result.seatMap, 0, 1, 'A').offers[0]?.price).toBeUndefined();
    expect(result.warnings).toEqual([
      { code: 'seat-price-undetermined', path: 'response.offerItems.0', detail },
    ]);
  });
});

function offerItem(body: Json, index: number): Json {
  return (responseOf(body)['offerItems'] as Json[])[index]!;
}

describe('ofertas de cada asiento', () => {
  it('un offerItem que no existe deja el asiento sin oferta y se avisa', () => {
    const body = minimal();
    firstRowSeats(body)[0]!['offerItemRefIds'] = ['nope'];
    const result = mapMinimal(body);
    expect(seatAt(result.seatMap, 0, 1, 'A')).toMatchObject({ available: false, offers: [] });
    expect(codes(result)).toEqual(['seat-offer-item-missing']);
  });

  it('un offerItem de otro segmento no se aplica a este mapa', () => {
    const body = minimal();
    offerItem(body, 0)['segmentRefs'] = ['S9'];
    const result = mapMinimal(body);
    expect(seatAt(result.seatMap, 0, 1, 'A').available).toBe(false);
    expect(codes(result)).toEqual(['seat-offer-segment-mismatch']);
  });

  it('dos offerItems para el mismo pasajero en un asiento: gana el primero', () => {
    const body = minimal();
    firstRowSeats(body)[0]!['offerItemRefIds'] = ['item-1', 'item-2'];
    const result = mapMinimal(body);
    expect(seatAt(result.seatMap, 0, 1, 'A').offers).toEqual([
      { passengerIndex: 0, price: usd(1250), offerRef: 'item-1' },
    ]);
    expect(codes(result)).toEqual(['seat-offer-duplicate-passenger']);
  });

  it('un offerItem compartido por dos pasajeros da una oferta a cada uno', () => {
    const body = minimal();
    offerItem(body, 0)['passengerRefs'] = ['Passenger2', 'Passenger1'];
    const result = mapSabreGetSeatsResponse(
      body,
      ndcContext(qantasOffer(), { Passenger1: 0, Passenger2: 1 }),
    );
    expect(seatAt(result.seatMap, 0, 1, 'A').offers.map((offer) => offer.passengerIndex)).toEqual([
      0, 1,
    ]);
  });
});

describe('layout', () => {
  it('sin cabinLayout usa columnIds y deduce los pasillos de los asientos', () => {
    const body = minimal();
    const cabin = compartment(body);
    delete cabin['cabinLayout'];
    cabin['columnIds'] = ['A', 'C', 'D', 'F'];
    firstRowSeats(body).push({
      column: 'D',
      occupationStatusCode: 'O',
      characteristics: [{ code: 'A' }],
    });
    const result = mapMinimal(body);
    expect(result.seatMap.segments[0]?.cabins[0]).toMatchObject({
      columns: ['A', 'C', 'D', 'F'],
      aisleAfter: ['C'],
    });
  });

  it('sin cabinLayout ni columnIds, las columnas salen de los asientos en orden', () => {
    const body = minimal();
    delete compartment(body)['cabinLayout'];
    firstRowSeats(body).reverse();
    const cabin = mapMinimal(body).seatMap.segments[0]?.cabins[0];
    expect(cabin?.columns).toEqual(['A', 'C']);
    expect(cabin?.rows[0]?.seats.map((seat) => seat.column)).toEqual(['A', 'C']);
  });

  it('sin columnas de ningún lado la cabina no se puede pintar y el mapa se descarta', () => {
    const body = minimal();
    const cabin = compartment(body);
    delete cabin['cabinLayout'];
    cabin['seatRows'] = [];
    const result = mapMinimal(body);
    expect(result.seatMap.segments).toEqual([]);
    expect(codes(result)).toEqual(['cabin-columns-missing', 'seat-map-empty']);
  });

  it('una cabina sin filas no llega al canónico', () => {
    const body = minimal();
    compartment(body)['seatRows'] = [];
    const result = mapMinimal(body);
    expect(result.seatMap.segments).toEqual([]);
    expect(codes(result)).toEqual(['seat-map-empty']);
  });

  it('sin código de ubicación, la posición de la columna dice ventana o pasillo', () => {
    const body = minimal();
    firstRowSeats(body).forEach((seat) => delete seat['characteristics']);
    const map = mapMinimal(body).seatMap;
    expect(seatAt(map, 0, 1, 'A').characteristics).toEqual(['WINDOW']);
    expect(seatAt(map, 0, 1, 'C').characteristics).toEqual(['AISLE']);
  });

  it('posición como texto suelto (forma v1) y fila como texto de dígitos', () => {
    const body = minimal();
    const layout = compartment(body)['cabinLayout'] as Json;
    layout['columns'] = [
      { id: 'A', position: 'W' },
      { id: 'C', position: 'A' },
      { id: 'D', position: 'A' },
      { id: 'F', position: 'W' },
      { id: 'a', position: 'W' },
      { id: 'A', position: 'A' },
    ];
    ((compartment(body)['seatRows'] as Json[])[0] as Json)['row'] = '7';
    const cabin = mapMinimal(body).seatMap.segments[0]?.cabins[0];
    expect(cabin?.aisleAfter).toEqual(['C']);
    expect(cabin?.columns).toEqual(['A', 'C', 'D', 'F']);
    expect(cabin?.rows.map((row) => row.number)).toEqual([7]);
  });

  it('código de cabina desconocido: la cabina queda sin traducir y se avisa con el código', () => {
    const body = minimal();
    compartment(body)['cabinCode'] = 'Q';
    const result = mapMinimal(body);
    expect(result.seatMap.segments[0]?.cabins[0]?.cabin).toBeUndefined();
    expect(result.warnings).toEqual([
      {
        code: 'cabin-code-unknown',
        path: 'response.seatMaps.0.cabinCompartments.0.cabinCode',
        detail: 'Q',
      },
    ]);
  });

  it('sin código de cabina también se avisa', () => {
    const body = minimal();
    delete compartment(body)['cabinCode'];
    expect(codes(mapMinimal(body))).toEqual(['cabin-code-unknown']);
  });

  it('fila repetida, columna repetida y columna no declarada se descartan con aviso', () => {
    const body = minimal();
    const rows = compartment(body)['seatRows'] as Json[];
    rows.push(clone(rows[0]!));
    const seats = firstRowSeats(body);
    seats.push(clone(seats[0]!));
    seats.push({ column: 'Z', occupationStatusCode: 'F', offerItemRefIds: ['item-1'] });
    const result = mapMinimal(body);
    expect(codes(result)).toEqual([
      'seat-column-duplicate',
      'seat-column-unlisted',
      'seat-row-duplicate',
    ]);
    expect(rowAt(result.seatMap, 0, 1).seats.map((seat) => seat.column)).toEqual(['A', 'C']);
  });

  it('el código 8 («no hay asiento aquí») es un hueco como la Q', () => {
    const body = minimal();
    addCode(firstRowSeats(body)[1]!, '8');
    expect(rowAt(mapMinimal(body).seatMap, 0, 1).seats.map((seat) => seat.column)).toEqual(['A']);
  });

  it('salida de emergencia declarada sólo en la fila', () => {
    const body = minimal();
    ((compartment(body)['seatRows'] as Json[])[0] as Json)['characteristics'] = [{ code: 'E' }];
    expect(seatAt(mapMinimal(body).seatMap, 0, 1, 'C')).toMatchObject({
      characteristics: ['AISLE', 'EXIT_ROW'],
      adultOnly: true,
      infantAllowed: false,
    });
  });
});

describe('sobre de la respuesta', () => {
  it('warnings[] de Sabre se cuenta sin copiar su texto', () => {
    const body = minimal();
    body['warnings'] = [{ category: 'X', type: 'Y', fieldValue: 'ANA ROJAS' }];
    const result = mapMinimal(body);
    expect(result.seatMap.warnings).toEqual(['provider-warning']);
    expect(JSON.stringify(result)).not.toContain('ROJAS');
  });

  it('errors[] es un rechazo, aunque venga con un mapa', () => {
    const body = minimal();
    body['errors'] = [{ category: 'BAD_REQUEST', type: 'X' }];
    expect(() => mapMinimal(body)).toThrow(SabreGetSeatsRejectedError);
  });

  it('sin response ni errors no hay nada que mapear', () => {
    expect(() => mapMinimal({})).toThrow(/response:required/);
  });

  it('una respuesta que no es un objeto está fuera de contrato', () => {
    expect(() => mapMinimal('OK' as unknown as Json)).toThrow(SabreGetSeatsMappingError);
    expect(() => mapMinimal({ response: 'x' })).toThrow(SabreGetSeatsMappingError);
  });

  it('los nombres de pasajero de la respuesta no llegan al resultado', () => {
    expect(JSON.stringify(mapMinimal())).not.toContain('ROJAS');
  });

  it('un contexto corrupto no produce un canónico inválido: falla fuerte', () => {
    expect(() =>
      mapSabreGetSeatsResponse(minimal(), ndcContext(qantasOffer(), { Passenger1: -1 })),
    ).toThrow(/canonical\.segments\.0\.cabins\.0\.rows\.0\.seats\.0\.offers\.0\.passengerIndex/);
  });
});

// ---------------------------------------------------------------------------------------------
// El contrato canónico se defiende solo
// ---------------------------------------------------------------------------------------------

describe('SeatMapSchema', () => {
  function validMap(): SeatMap {
    return mapMinimal().seatMap;
  }

  it('acepta lo que entrega el ACL', () => {
    expect(SeatMapSchema.safeParse(validMap()).success).toBe(true);
  });

  it.each<[string, (map: SeatMap) => void]>([
    [
      'disponible sin ofertas',
      (map) => (map.segments[0]!.cabins[0]!.rows[0]!.seats[0]!.offers = []),
    ],
    [
      'ofertas en un asiento no disponible',
      (map) => (map.segments[0]!.cabins[0]!.rows[0]!.seats[0]!.available = false),
    ],
    [
      'dos ofertas para el mismo pasajero',
      (map) => {
        const seat = map.segments[0]!.cabins[0]!.rows[0]!.seats[0]!;
        seat.offers = [...seat.offers, ...seat.offers];
      },
    ],
    ['columnas repetidas', (map) => map.segments[0]!.cabins[0]!.columns.push('A')],
    [
      'pasillo tras una columna que no existe',
      (map) => map.segments[0]!.cabins[0]!.aisleAfter.push('Z'),
    ],
    [
      'fila repetida',
      (map) => {
        const rows = map.segments[0]!.cabins[0]!.rows;
        rows.push(structuredClone(rows[0]!));
      },
    ],
    [
      'asiento en una columna no declarada',
      (map) => (map.segments[0]!.cabins[0]!.rows[0]!.seats[0]!.column = 'Z'),
    ],
    [
      'dos mapas para el mismo avión del mismo segmento',
      (map) => map.segments.push(structuredClone(map.segments[0]!)),
    ],
  ])('rechaza %s', (_caso, mutate) => {
    const map = validMap();
    mutate(map);
    expect(SeatMapSchema.safeParse(map).success).toBe(false);
  });
});
