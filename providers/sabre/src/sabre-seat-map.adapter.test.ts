import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Offer } from '@sales-travel/canonical';
import type { LoggerPort } from '@sales-travel/core';
import type { FlightSearchCriteria, SearchContext, SeatMapPort } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError, SabreConfigError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { SABRE_RAW_KEYS } from './price/request.builder';
import {
  SabreSeatMapAdapter,
  SabreSeatMapEmptyError,
  SabreSeatMapTenantMismatchError,
} from './sabre-seat-map.adapter';
import {
  SABRE_GETSEATS_NDC_OFFER_PATH,
  SABRE_GETSEATS_PAYLOAD_PATH,
  SabreGetSeatsRequestError,
} from './seats/getseats.request.builder';
import { SabreGetSeatsMappingError } from './seats/getseats.response.mapper';

/**
 * EL MAPA DE ASIENTOS POR LA PUERTA PÚBLICA.
 *
 * Nada de `postJson` simulado: el adapter corre sobre un `SabreHttpClient` real con un `fetch`
 * interceptado, que es por donde pasan de verdad la clasificación del sobre, los reintentos y la
 * redacción del log. Se mide el cuerpo SERIALIZADO que llega al cable y lo que sale por el puerto.
 *
 * El `fetch` falso sólo contesta lo que el test preparó y tantas veces como lo preparó: una llamada
 * de más, o a otra ruta, lanza. Los fixtures son las respuestas oficiales de Get Seats v3 (ver la
 * cabecera de `seats/getseats.response.mapper.test.ts` para el origen línea a línea).
 */

type Json = Record<string, unknown>;

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'req-seats' };
const TOKEN = 'ATK-SUPERSECRETO';
const PCC = 'ZZZZ';

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as Json;
}

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: PCC,
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
    ...overrides,
  };
}

function criteria(adults = 2, children = 0, infants = 0): FlightSearchCriteria {
  return {
    origin: 'SCL',
    destination: 'LIM',
    departureDate: '2026-03-02',
    paxCount: { adults, children, infants },
    currency: 'USD',
  };
}

/** La oferta del ejemplo oficial de payload: LA640 SCL-LIM y LA477 SCL-EZE. */
function latamOffer(overrides: Partial<Offer> = {}): Offer {
  const segment = (
    flightNumber: string,
    destination: string,
    departureAt: string,
    arrivalAt: string,
  ) => ({
    carrier: 'LA',
    flightNumber,
    origin: 'SCL',
    destination,
    departureAt,
    arrivalAt,
    durationMinutes: 120,
    cabin: 'economy' as const,
    bookingClass: 'Y',
  });
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT_ID,
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'cached', source: 'ATPCO' },
    total: { amountMinor: 77700, currency: 'USD' },
    baseFare: { amountMinor: 70000, currency: 'USD' },
    taxes: { amountMinor: 7700, currency: 'USD' },
    itineraries: [
      {
        totalDurationMinutes: 230,
        stops: 0,
        segments: [segment('640', 'LIM', '2026-03-02T13:40:00-03:00', '2026-03-02T15:30:00-05:00')],
      },
      {
        totalDurationMinutes: 123,
        stops: 0,
        segments: [segment('477', 'EZE', '2026-03-04T16:01:00-03:00', '2026-03-04T18:04:00-03:00')],
      },
    ],
    fareComponents: [
      { fareBasisCode: 'YOWLGN3', brand: { code: 'EOU' }, segmentRefs: [0] },
      { fareBasisCode: 'YOWLGN4', brand: { code: 'EOU' }, segmentRefs: [1] },
    ],
    fetchedAt: '2026-02-20T12:00:00.000Z',
    expiresAt: '2026-02-20T12:20:00.000Z',
    ...overrides,
  };
}

/** BA5 LHR-HND del ejemplo NDC, ya pasado por Offer Price. */
function britishPricedOffer(): Offer {
  return latamOffer({
    provider: {
      name: 'sabre',
      offerRef: 'priced',
      source: 'NDC',
      raw: {
        [SABRE_RAW_KEYS.priceOfferId]: 'ih5d79946bb5sp4lsmlj89kj27-1',
        [SABRE_RAW_KEYS.pricePassengerBindings]: [
          {
            pricePassengerId: 'Passenger1',
            requestedTravelerIndex: 0,
            paxType: 'ADT',
            requestedPtc: 'ADT',
            pricedPtc: 'ADT',
          },
        ],
      },
    },
    itineraries: [
      {
        totalDurationMinutes: 760,
        stops: 0,
        segments: [
          {
            carrier: 'BA',
            flightNumber: '5',
            origin: 'LHR',
            destination: 'HND',
            departureAt: '2026-03-19T11:45:00+00:00',
            arrivalAt: '2026-03-20T10:25:00+09:00',
            durationMinutes: 760,
            cabin: 'economy',
            bookingClass: 'H',
          },
        ],
      },
    ],
    fareComponents: undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// El arnés
// ---------------------------------------------------------------------------------------------

interface LogCall {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

interface WireCall {
  readonly path: string;
  readonly raw: string;
  readonly headers: Record<string, string>;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): Reply => ({ status: 200, body });

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve(TOKEN),
  invalidate: () => Promise.resolve(),
};

function wire(routes: Record<string, readonly Reply[]>, cfg: SabreConfig = config()) {
  const calls: WireCall[] = [];
  const logs: LogCall[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  const queues = new Map(Object.entries(routes).map(([path, replies]) => [path, [...replies]]));

  const fetchImpl: SabreFetch = (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      raw: typeof init.body === 'string' ? init.body : '',
      headers: { ...(init.headers as Record<string, string>) },
    });
    const next = queues.get(path)?.shift();
    if (next === undefined) {
      throw new Error(`el ACL llamó a ${path}, que este test no preparó (o ya agotó)`);
    }
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  };

  const http = new SabreHttpClient(cfg, tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const adapter = new SabreSeatMapAdapter(cfg, http, { logger });
  return { adapter, calls, logs, port: adapter as SeatMapPort };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba un rechazo');
}

/** Todo lo que el paquete mandó al transporte de logs, serializado para barrerlo de una vez. */
function logText(logs: readonly LogCall[]): string {
  return JSON.stringify(logs);
}

// ---------------------------------------------------------------------------------------------
// Camino feliz
// ---------------------------------------------------------------------------------------------

describe('SabreSeatMapAdapter — ATPCO por payload', () => {
  it('una llamada a byReservationPayload y el mapa canónico por el puerto del dominio', async () => {
    const h = wire({ [SABRE_GETSEATS_PAYLOAD_PATH]: [ok(fixture('getseats-payload-200.json'))] });
    const map = await h.port.getSeatMap(latamOffer(), criteria(), CTX);

    expect(h.calls.map((call) => call.path)).toEqual([SABRE_GETSEATS_PAYLOAD_PATH]);
    expect(map.segments.map((segment) => segment.segmentRef)).toEqual([0, 1]);
    expect(map.segments[0]?.cabins[0]?.rows[0]?.seats[0]?.offers).toEqual([
      {
        passengerIndex: 0,
        price: { amountMinor: 5200, currency: 'USD' },
        offerRef: 'ih5d79946bb5lczk7mlj969ap0-18',
      },
      {
        passengerIndex: 1,
        price: { amountMinor: 5200, currency: 'USD' },
        offerRef: 'ih5d79946bb5lczk7mlj969ap0-25',
      },
    ]);
    expect(map.warnings).toEqual(['seat-price-undetermined']);
  });

  it('el cuerpo que viaja es el del ejemplo oficial sin nombres, sin PCC y sin tarjeta', async () => {
    const h = wire({ [SABRE_GETSEATS_PAYLOAD_PATH]: [ok(fixture('getseats-payload-200.json'))] });
    await h.adapter.getSeatMap(latamOffer(), criteria(2, 0, 1), CTX);

    const sent = JSON.parse(h.calls[0]!.raw) as Json;
    expect(Object.keys(sent).sort()).toEqual([
      'currencyCode',
      'fareComponents',
      'passengers',
      'returnSeatMapsOnlyForSegmentRefs',
      'segments',
    ]);
    expect(sent['passengers']).toEqual([
      {
        id: 'passenger_1',
        passengerType: 'ADT',
        fareSegmentAssociation: [
          { segmentRef: 'segment_1', fareComponentRef: 'fareComponent1' },
          { segmentRef: 'segment_2', fareComponentRef: 'fareComponent2' },
        ],
        isAccompaniedByInfant: true,
      },
      {
        id: 'passenger_2',
        passengerType: 'ADT',
        fareSegmentAssociation: [
          { segmentRef: 'segment_1', fareComponentRef: 'fareComponent1' },
          { segmentRef: 'segment_2', fareComponentRef: 'fareComponent2' },
        ],
      },
    ]);
    // v3 lee el PCC de la sesión ATK: si apareciera en el cuerpo, alguien copió el v1.
    expect(h.calls[0]!.raw).not.toContain(PCC);
    for (const key of ['givenName', 'surname', 'loyalty', 'card', 'formOfPayment', 'party']) {
      expect(h.calls[0]!.raw.toLowerCase()).not.toContain(key.toLowerCase());
    }
    expect(h.calls[0]!.raw).not.toMatch(/\d{12,19}/);
  });

  it('correlaciona con el requestId del llamador y loguea sólo conteos', async () => {
    const h = wire({ [SABRE_GETSEATS_PAYLOAD_PATH]: [ok(fixture('getseats-payload-200.json'))] });
    const read = await h.adapter.readSeatMap(latamOffer(), criteria(), CTX);

    expect(read.conversationId).toBe('sales-travel-req-seats');
    expect(h.calls[0]!.headers['Conversation-ID']).toBe('sales-travel-req-seats');
    expect(read.mode).toBe('payload');
    expect(read.offerId).toBe('ih5d79946bb5lczk7mlj969ap0');

    const okLog = h.logs.find((log) => log.message === 'sabre.seat_map.ok');
    expect(okLog?.level).toBe('debug');
    expect(okLog?.meta).toMatchObject({
      mode: 'payload',
      segments: 2,
      displayOnlySegments: 0,
      droppedSeatMaps: 0,
      seats: 312,
      availableSeats: 312,
      warnings: { 'seat-price-undetermined': 4 },
      partialUnauthorized: 0,
    });
    // Ni el token, ni los nombres que trae la respuesta, ni ids de oferta llegan al log.
    const text = logText(h.logs);
    for (const value of [TOKEN, 'Edmunt', 'Kolodziej', 'Marianna', 'ih5d79946bb5lczk7mlj969ap0']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('SabreSeatMapAdapter — correlación sin requestId', () => {
  it('sin requestId el cliente genera el Conversation-ID con el prefijo de la cuenta', async () => {
    const h = wire({ [SABRE_GETSEATS_PAYLOAD_PATH]: [ok(fixture('getseats-payload-200.json'))] });
    const read = await h.adapter.readSeatMap(latamOffer(), criteria(), { tenantId: TENANT_ID });
    expect(read.conversationId).toBe('sales-travel-conv-fijo');
  });
});

describe('SabreSeatMapAdapter — NDC por offerId', () => {
  it('manda sólo el offerId de Offer Price y casa el segmento por vuelo', async () => {
    const h = wire({
      [SABRE_GETSEATS_NDC_OFFER_PATH]: [ok(fixture('getseats-ndc-offer-id-200.json'))],
    });
    const read = await h.adapter.readSeatMap(britishPricedOffer(), criteria(1), CTX);

    expect(h.calls.map((call) => call.path)).toEqual([SABRE_GETSEATS_NDC_OFFER_PATH]);
    expect(JSON.parse(h.calls[0]!.raw)).toEqual({ offerId: 'ih5d79946bb5sp4lsmlj89kj27-1' });
    expect(read.mode).toBe('ndc-offer');
    expect(read.seatMap.segments.map((segment) => segment.segmentRef)).toEqual([0]);
    expect(read.seatMap.segments[0]?.cabins[0]?.aisleAfter).toEqual(['C', 'F']);
  });
});

// ---------------------------------------------------------------------------------------------
// Defensas: cada una se puso en rojo mutando el código que mide (ver el informe del paquete)
// ---------------------------------------------------------------------------------------------

describe('SabreSeatMapAdapter — defensas', () => {
  it('es una lectura: un 503 se reintenta y el segundo intento entrega el mapa', async () => {
    const h = wire({
      [SABRE_GETSEATS_PAYLOAD_PATH]: [
        { status: 503, body: { message: 'unavailable' } },
        ok(fixture('getseats-payload-200.json')),
      ],
    });
    const map = await h.adapter.getSeatMap(latamOffer(), criteria(), CTX);
    expect(h.calls).toHaveLength(2);
    expect(map.segments).toHaveLength(2);
  });

  it('un 200 con errors[] es un rechazo del proveedor, no un mapa vacío', async () => {
    const h = wire({
      [SABRE_GETSEATS_PAYLOAD_PATH]: [
        ok({
          errors: [
            {
              category: 'BAD_REQUEST',
              type: 'SEAT_MAP_NOT_AVAILABLE',
              description: 'Seat map not available for Edmunt Kolodziej',
            },
          ],
        }),
      ],
    });
    const error = await rejection(() => h.adapter.getSeatMap(latamOffer(), criteria(), CTX));
    expect(error).toBeInstanceOf(SabreApiError);
    expect(h.calls).toHaveLength(1);
    expect(logText(h.logs)).not.toContain('Kolodziej');
  });

  it('el entitlement parcial llega al vendedor como aviso del mapa', async () => {
    const body = fixture('getseats-payload-200.json');
    body['warnings'] = [{ category: 'UNAUTHORIZED', type: 'SEATS_NOT_AUTHORIZED_FOR_CARRIER' }];
    const h = wire({ [SABRE_GETSEATS_PAYLOAD_PATH]: [ok(body)] });
    const map = await h.adapter.getSeatMap(latamOffer(), criteria(), CTX);
    expect(map.warnings).toEqual([
      'provider-warning',
      'seat-price-undetermined',
      'seat-map-partial-unauthorized',
    ]);
  });

  it('sin credenciales falla antes del cable', async () => {
    const h = wire({}, config({ password: '' }));
    const error = await rejection(() => h.adapter.getSeatMap(latamOffer(), criteria(), CTX));
    expect(error).toBeInstanceOf(SabreConfigError);
    expect(h.calls).toEqual([]);
  });

  it('una oferta de otro tenant no se consulta con esta cuenta', async () => {
    const h = wire({});
    const error = await rejection(() =>
      h.adapter.getSeatMap(
        latamOffer({ tenantId: '99999999-2222-4333-8444-555555555555' }),
        criteria(),
        CTX,
      ),
    );
    expect(error).toBeInstanceOf(SabreSeatMapTenantMismatchError);
    expect(h.calls).toEqual([]);
  });

  it('una oferta que no se puede consultar no sale al cable', async () => {
    const offer = latamOffer();
    offer.itineraries![0]!.segments[0]!.flightNumber = '640A';
    const h = wire({});
    const error = await rejection(() => h.adapter.getSeatMap(offer, criteria(), CTX));
    expect(error).toBeInstanceOf(SabreGetSeatsRequestError);
    expect(h.calls).toEqual([]);
  });

  it('ningún mapa ubicable en la oferta: error, nunca «no quedan asientos»', async () => {
    const h = wire({
      [SABRE_GETSEATS_NDC_OFFER_PATH]: [ok(fixture('getseats-ndc-offer-id-200.json'))],
    });
    const offer = britishPricedOffer();
    offer.itineraries![0]!.segments[0]!.flightNumber = '7';
    const error = await rejection(() => h.adapter.getSeatMap(offer, criteria(1), CTX));
    expect(error).toBeInstanceOf(SabreSeatMapEmptyError);
    expect((error as SabreSeatMapEmptyError).droppedSeatMaps).toBe(1);
    const empty = h.logs.find((log) => log.message === 'sabre.seat_map.empty');
    expect(empty?.level).toBe('warn');
    expect(empty?.meta).toMatchObject({ warnings: { 'seat-map-segment-unmatched': 1 } });
  });

  it('libres y ninguno atribuible: el tramo sale como sólo exhibición y se loguea en warn', async () => {
    const h = wire({
      [SABRE_GETSEATS_NDC_OFFER_PATH]: [ok(fixture('getseats-ndc-offer-id-200.json'))],
    });
    const offer = britishPricedOffer();
    // Offer Price emitió otro id de pasajero que el que nombra el mapa: ninguna oferta se atribuye.
    offer.provider.raw = {
      ...offer.provider.raw,
      [SABRE_RAW_KEYS.pricePassengerBindings]: [
        {
          pricePassengerId: 'PassengerX',
          requestedTravelerIndex: 0,
          paxType: 'ADT',
          requestedPtc: 'ADT',
          pricedPtc: 'ADT',
        },
      ],
    };
    const map = await h.port.getSeatMap(offer, criteria(1), CTX);

    expect(map.segments.map((segment) => segment.displayOnly)).toEqual([true]);
    expect(map.warnings).toEqual(['seat-offer-passenger-unknown', 'seat-map-display-only']);
    const logged = h.logs.find((log) => log.message === 'sabre.seat_map.display_only');
    expect(logged?.level).toBe('warn');
    expect(logged?.meta).toMatchObject({ displayOnlySegments: 1, availableSeats: 0 });
    expect(h.logs.some((log) => log.message === 'sabre.seat_map.ok')).toBe(false);
  });

  it('si el PCC sólo tiene getseats v1, el error lo dice con nombre propio', async () => {
    const h = wire({
      [SABRE_GETSEATS_PAYLOAD_PATH]: [ok(fixture('getseats-payload-2pax-2seg-200.json'))],
    });
    const error = await rejection(() => h.adapter.getSeatMap(latamOffer(), criteria(), CTX));
    expect(error).toBeInstanceOf(SabreGetSeatsMappingError);
    expect((error as SabreGetSeatsMappingError).issues[0]).toBe(
      'response.aLaCarteOffer:legacy_v1_contract',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// D1 — barrido de salida: un PAN inyectado en cualquier hoja de texto de la entrada no llega al
// cable. Va aquí y no en `pan-egress.guard.test.ts` para no chocar con la otra línea de trabajo;
// la regla es la misma: se miden los bytes que salen por `SabreHttpClient.postJson`.
// ---------------------------------------------------------------------------------------------

/** PAN de prueba público de la industria. No es de nadie. */
const TEST_PAN = '4111111111111111';

type LeafPath = readonly (string | number)[];

function stringLeaves(value: unknown, path: LeafPath = []): LeafPath[] {
  if (typeof value === 'string') return [path];
  if (Array.isArray(value))
    return value.flatMap((item, index) => stringLeaves(item, [...path, index]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, [...path, key]));
  }
  return [];
}

function setLeaf(root: unknown, path: LeafPath, value: string): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]!] = value;
}

type Outcome = 'rejected' | 'dropped' | 'carried';

/** Corre el adapter con el PAN en `path` y dice qué pasó en el cable. Nunca devuelve el valor. */
async function sweepOne(
  base: { offer: Offer; criteria: FlightSearchCriteria },
  path: LeafPath,
): Promise<Outcome> {
  const input = structuredClone(base);
  setLeaf(input, path, TEST_PAN);
  const h = wire({
    [SABRE_GETSEATS_PAYLOAD_PATH]: [ok(fixture('getseats-payload-200.json'))],
    [SABRE_GETSEATS_NDC_OFFER_PATH]: [ok(fixture('getseats-ndc-offer-id-200.json'))],
  });
  try {
    await h.adapter.getSeatMap(input.offer, input.criteria, CTX);
  } catch {
    // Que el mapa falle después del cable no importa aquí: se mide lo que salió.
  }
  if (h.calls.length === 0) return 'rejected';
  return h.calls.some((call) => call.raw.includes(TEST_PAN)) ? 'carried' : 'dropped';
}

async function sweep(base: { offer: Offer; criteria: FlightSearchCriteria }) {
  const outcomes = new Map<string, Outcome>();
  for (const path of stringLeaves(base)) {
    outcomes.set(path.join('.'), await sweepOne(base, path));
  }
  return outcomes;
}

/** Cada campo opcional que el builder puede mandar, relleno. */
function maximalLatamOffer(): Offer {
  const offer = latamOffer();
  for (const segment of offer.itineraries!.flatMap((itinerary) => itinerary.segments)) {
    segment.operatingCarrier = 'LA';
    segment.operatingFlightNumber = segment.flightNumber;
    segment.aircraft = '320';
  }
  offer.fareComponents = offer.fareComponents!.map((component) => ({
    ...component,
    brand: { code: 'EOU', name: 'LIGHT' },
    bookingClasses: ['Y'],
    origin: 'SCL',
  }));
  return offer;
}

describe('SabreSeatMapAdapter — D1: ningún PAN de la entrada llega al cable', () => {
  it('payload: cada hoja de la oferta y los criterios se rechaza o se omite, ninguna viaja', async () => {
    const outcomes = await sweep({ offer: maximalLatamOffer(), criteria: criteria(2, 1, 1) });
    expect([...outcomes].filter(([, outcome]) => outcome === 'carried')).toEqual([]);
    // El barrido no es hueco: las dos ramas que no viajan aparecen, y por las razones esperadas.
    expect(outcomes.get('offer.itineraries.0.segments.0.carrier')).toBe('rejected');
    expect(outcomes.get('offer.itineraries.0.segments.0.flightNumber')).toBe('rejected');
    expect(outcomes.get('offer.fareComponents.0.fareBasisCode')).toBe('dropped');
    expect(outcomes.get('offer.fareComponents.0.brand.code')).toBe('dropped');
    expect(outcomes.get('offer.itineraries.0.segments.0.aircraft')).toBe('dropped');
    expect(outcomes.size).toBeGreaterThan(30);
  });

  it('NDC: tampoco el offerId ni el binding de pasajeros sacan el PAN al cable', async () => {
    const outcomes = await sweep({ offer: britishPricedOffer(), criteria: criteria(1) });
    expect([...outcomes].filter(([, outcome]) => outcome === 'carried')).toEqual([]);
    expect(outcomes.get(`offer.provider.raw.${SABRE_RAW_KEYS.priceOfferId}`)).toBe('rejected');
    expect(
      outcomes.get(
        `offer.provider.raw.${SABRE_RAW_KEYS.pricePassengerBindings}.0.pricePassengerId`,
      ),
    ).toBe('dropped');
  });
});
