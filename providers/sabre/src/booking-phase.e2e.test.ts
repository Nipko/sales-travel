import type { Offer } from '@sales-travel/canonical';
import type { LoggerPort } from '@sales-travel/core';
import type {
  FlightSearchCriteria,
  OrderCreateRequest,
  OrderCreateResult,
  Passenger,
  SearchContext,
} from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import multipaxFixture from './__fixtures__/price-multipax-2adt-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import {
  SABRE_CANCEL_BOOKING_PATH,
  SABRE_CHECK_FLIGHT_TICKETS_PATH,
} from './booking/cancel.request.builder';
import {
  SABRE_ASYNC_UPDATE_WAIT_MS_DEFAULT,
  SABRE_CREATE_BOOKING_PATH,
  SABRE_ERROR_POLICY_BY_TOLERANCE,
  SabreCreateBookingError,
  buildSabreCreateBookingRequest,
} from './booking/create.request.builder';
import { SABRE_GET_BOOKING_PATH } from './booking/get.request.builder';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { SabreIndexError } from './indices';
import { SABRE_PRICE_PATH, SABRE_RAW_KEYS } from './price/request.builder';
import {
  SabreCardBinPricingDeniedError,
  SabreOfferPriceAdapter,
} from './sabre-offer-price.adapter';
import { SABRE_BOOKING_USE_CASES, SabreOrderCreateAdapter } from './sabre-order-create.adapter';
import { SabreOrderManageAdapter } from './sabre-order-manage.adapter';
import { mapSabreShopResponse } from './shop/response.mapper';

/**
 * LA FASE DE RESERVA, EXTREMO A EXTREMO, POR LA PUERTA PÚBLICA.
 *
 * ## Por qué existe este fichero
 *
 * Antes de él, un `grep` sobre los ficheros de test del paquete devolvía **cero** llamadas a
 * `.createBooking(`, `.cancelBooking(` y `.priceOffer(`. Todo lo probado eran builders y mappers
 * **por separado**, y este paquete tiene una cicatriz entera hecha exactamente de eso: dos mitades
 * que funcionan solas y no casan. La última instancia la causó el propio endurecimiento — el
 * clasificador de sobres, correcto para BUSCAR, rechazaba la respuesta LEGÍTIMA de una reserva con
 * tolerancia parcial (`booking` + `errors[]`), así que el éxito parcial era inalcanzable en
 * producción y la compensación del accesorio no se ejecutaba nunca.
 *
 * Aquí no se llama a una sola función interna. Se entra por el adapter —o, cuando lo que se mide es
 * una conversión que ningún adapter alimenta, por `SabreHttpClient.postJson`— y **siempre se mide el
 * cuerpo serializado que llega al cable** y el resultado que sale por la puerta.
 *
 * ## Por qué el arnés no puede pasar por casualidad
 *
 * `wire()` sólo contesta las rutas que el test preparó, y tantas veces como las preparó. Si el ACL
 * llama a otra ruta, o a la misma de más, el `fetch` falso **lanza**. Las aserciones sobre
 * `harness.paths()` fijan además la secuencia completa: un paso que desaparezca —el
 * `checkFlightTickets` previo a una cancelación NDC, por ejemplo— no puede pasar inadvertido porque
 * la lista deja de coincidir. Y la sonda «el arnés se pone rojo si el ACL no sale al cable»
 * comprueba que estas aserciones no están mirando un `calls` vacío.
 */

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const NOW_MS = Date.parse('2026-08-26T12:00:00.000Z');
const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'req-e2e' };

/** El PNR con el que responde el `createBooking` de todos estos tests. `^[A-Z0-9]{6,}$`. */
const PNR = 'QWERTY';

/**
 * PII de verdad, con la forma que exigen los patrones del contrato. Está centralizada para que el
 * bloque de privacidad pueda buscar CADA valor dentro de los logs: una lista de literales sueltos
 * por test es una lista que se queda corta en cuanto alguien añade un campo.
 */
const PII = {
  givenName: 'MARIA',
  surname: 'QUISPE',
  birthdate: '1990-05-14',
  document: 'AB1234567',
  secondGivenName: 'JORGE',
  secondSurname: 'MAMANI',
  secondBirthdate: '1985-11-02',
  secondDocument: 'CD7654321',
  email: 'maria.quispe@example.com',
  phone: '+51 (1) 555-0142',
} as const;

/** Todos los valores de {@link PII}, para barrer un log entero sin olvidarse de ninguno. */
const PII_VALUES: readonly string[] = Object.values(PII);

/** `ZZZZ` es el PCC falso: ningún PCC de tercero vive en el código de este repo. */
function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
    ...overrides,
  };
}

interface LogCall {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, calls };
}

const fakeTokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------------------------
// El arnés
// ---------------------------------------------------------------------------------------------

interface WireCall {
  readonly path: string;
  /** El cuerpo tal y como salió de `JSON.stringify`. Es lo que de verdad viaja. */
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

interface Harness {
  readonly calls: readonly WireCall[];
  readonly logs: readonly LogCall[];
  readonly http: SabreHttpClient;
  readonly price: SabreOfferPriceAdapter;
  readonly create: SabreOrderCreateAdapter;
  readonly manage: SabreOrderManageAdapter;
  /** La secuencia de rutas que el ACL tocó, en orden. */
  paths(): string[];
  /** El único cuerpo que se mandó a esa ruta. Lanza si hubo cero o más de uno. */
  bodyAt(path: string): Record<string, unknown>;
}

/**
 * Monta los tres adapters sobre un `fetch` interceptado.
 *
 * `routes` es una cola por ruta: el n-ésimo `POST` a una ruta recibe su n-ésima respuesta. Una ruta
 * sin respuesta preparada —o agotada— **lanza**, que es lo que impide que un test siga verde cuando
 * el ACL deja de llamar a lo que el test cree.
 */
function wire(routes: Record<string, readonly Reply[]>, cfg: SabreConfig = config()): Harness {
  const calls: WireCall[] = [];
  const { logger, calls: logs } = spyLogger();
  const queues = new Map<string, Reply[]>(
    Object.entries(routes).map(([path, replies]) => [path, [...replies]]),
  );

  const fetchImpl: SabreFetch = (url, init) => {
    const path = new URL(url).pathname;
    const raw = typeof init.body === 'string' ? init.body : '';
    calls.push({ path, raw, body: JSON.parse(raw) as Record<string, unknown> });
    const next = queues.get(path)?.shift();
    if (next === undefined) {
      throw new Error(`el ACL llamó a ${path}, que este test no preparó (o ya agotó)`);
    }
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  };

  const http = new SabreHttpClient(cfg, fakeTokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
    now: () => NOW_MS,
  });

  return {
    calls,
    logs,
    http,
    price: new SabreOfferPriceAdapter(cfg, http, { logger, now: () => NOW_MS }),
    create: new SabreOrderCreateAdapter(cfg, http, { logger }),
    manage: new SabreOrderManageAdapter(cfg, http, { logger, now: () => NOW_MS }),
    paths: () => calls.map((call) => call.path),
    bodyAt: (path) => {
      const matches = calls.filter((call) => call.path === path);
      const only = matches[0];
      if (only === undefined || matches.length !== 1) {
        throw new Error(
          `se esperaba exactamente un POST a ${path}, hubo ${String(matches.length)}`,
        );
      }
      return only.body;
    },
  };
}

/**
 * Los ids que la orden declara deshacibles, o lista vacía.
 *
 * Se lee así —y no comparando el bloque entero— porque lo que estos tests miden es **qué ids hay**,
 * no si el bloque se publica: la regla del fundador se rompe cuando aparece un id que un accesorio
 * caído no podía aportar, y eso se ve igual con bloque presente que ausente.
 */
function compensationIds(result: OrderCreateResult): readonly string[] {
  return result.compensation?.cancellableItemIds ?? [];
}

/** Lee una ruta con puntos dentro del cuerpo serializado. Los índices de array son otro tramo. */
function at(body: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, body);
}

// ---------------------------------------------------------------------------------------------
// Entradas del dominio
// ---------------------------------------------------------------------------------------------

const CRITERIA: FlightSearchCriteria = {
  origin: 'JFK',
  destination: 'SFO',
  departureDate: '2024-02-11',
  paxCount: { adults: 2, children: 0, infants: 0 },
  currency: 'USD',
};

/** `offerItemId` del shop con la forma del contrato (`^[a-zA-Z0-9]{1,30}(-[0-9]{1,10}){2}$`). */
const SHOP_OFFER_ITEM_ID = 'dd07bbd7fb57jkq5llq1qhzkd6-1-1';

function shopOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT_ID,
    products: ['flight'],
    provider: {
      name: 'sabre',
      offerRef: 'shop-ref',
      source: 'NDC',
      raw: { [SABRE_RAW_KEYS.shopOfferItemIds]: [SHOP_OFFER_ITEM_ID] },
    },
    total: { amountMinor: 23780, currency: 'USD' },
    baseFare: { amountMinor: 19348, currency: 'USD' },
    taxes: { amountMinor: 4432, currency: 'USD' },
    itineraries: [
      {
        segments: [
          {
            carrier: 'AA',
            flightNumber: '76',
            origin: 'JFK',
            destination: 'SFO',
            departureAt: '2024-02-11T06:00:00-05:00',
            arrivalAt: '2024-02-11T09:43:00-08:00',
            durationMinutes: 403,
            cabin: 'economy',
            bookingClass: 'B',
          },
        ],
        totalDurationMinutes: 403,
        stops: 0,
      },
    ],
    fetchedAt: '2026-08-26T11:30:00.000Z',
    expiresAt: '2026-08-26T11:31:30.000Z',
    expiresAtSource: 'platform-policy',
    ...overrides,
  };
}

/** La misma oferta SIN los ids de `offers/price`: el carril ATPCO se elige por lo que falta. */
function atpcoOffer(): Offer {
  return shopOffer({
    provider: { name: 'sabre', offerRef: 'shop-ref', source: 'ATPCO', raw: {} },
  });
}

/** Cambia el transportista de todos los tramos, para disparar su fila de requisitos. */
function withCarrier(offer: Offer, carrier: string): Offer {
  return {
    ...offer,
    itineraries: (offer.itineraries ?? []).map((itinerary) => ({
      ...itinerary,
      segments: itinerary.segments.map((segment) => ({ ...segment, carrier })),
    })),
  };
}

function passengers(): Passenger[] {
  return [
    {
      paxId: 'PAX-1',
      paxType: 'ADT',
      title: 'Mrs',
      givenName: PII.givenName,
      surname: PII.surname,
      birthdate: PII.birthdate,
      gender: 'F',
      citizenshipCountryCode: 'PE',
      identityDoc: {
        type: 'P',
        number: PII.document,
        issuingCountryCode: 'PE',
        expiryDate: '2030-01-31',
      },
    },
    {
      paxId: 'PAX-2',
      paxType: 'ADT',
      title: 'Mr',
      givenName: PII.secondGivenName,
      surname: PII.secondSurname,
      birthdate: PII.secondBirthdate,
      gender: 'M',
      citizenshipCountryCode: 'PE',
      identityDoc: {
        type: 'P',
        number: PII.secondDocument,
        issuingCountryCode: 'PE',
        expiryDate: '2031-03-15',
      },
    },
  ];
}

function orderRequest(
  offer: Offer,
  overrides: Partial<OrderCreateRequest> = {},
): OrderCreateRequest {
  return {
    offer,
    criteria: CRITERIA,
    passengers: passengers(),
    contactInfo: { email: PII.email, phone: PII.phone },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Respuestas del proveedor
// ---------------------------------------------------------------------------------------------

function priceResponse(): unknown {
  return structuredClone(multipaxFixture);
}

/** Un `createBooking` limpio: PNR, un vuelo `HK`, sin `errors[]`. */
function createConfirmed(): unknown {
  return {
    timestamp: '2026-08-26T12:00:00',
    confirmationId: PNR,
    booking: {
      bookingId: PNR,
      flights: [{ itemId: '1', flightStatusCode: 'HK', flightStatusName: 'Confirmed' }],
    },
  };
}

/**
 * El desenlace que la cicatriz de esta ronda dejaba inalcanzable: **200 con `booking` Y `errors[]`**,
 * que es exactamente lo que produce haber pedido `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`.
 */
function createPartialSeat(): unknown {
  return {
    timestamp: '2026-08-26T12:00:00',
    confirmationId: PNR,
    booking: {
      bookingId: PNR,
      flights: [
        {
          itemId: '1',
          flightStatusCode: 'HK',
          flightStatusName: 'Confirmed',
          seats: [{ number: '12A', statusCode: 'UC', statusName: 'No Seat' }],
        },
      ],
    },
    errors: [
      {
        category: 'APPLICATION_ERROR',
        type: 'UNABLE_TO_BOOK_SEAT',
        description: `no seat for ${PII.surname}`,
        fieldPath: 'flightOffer.seatOffers',
        fieldValue: PII.document,
      },
    ],
  };
}

/** Un ítem de producto CANCELABLE que sí se cayó: tiene `itemId` propio. */
function createPartialHotel(): unknown {
  return {
    timestamp: '2026-08-26T12:00:00',
    confirmationId: PNR,
    booking: {
      bookingId: PNR,
      flights: [{ itemId: '1', flightStatusCode: 'HK', flightStatusName: 'Confirmed' }],
      hotels: [{ itemId: '2', hotelStatusCode: 'UC', hotelStatusName: 'Cancelled' }],
    },
    errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_BOOK_HOTEL' }],
  };
}

/** Errores sin ningún ítem que los explique: la decisión NO está tomada. */
function createPartialUnattributed(): unknown {
  return {
    timestamp: '2026-08-26T12:00:00',
    confirmationId: PNR,
    booking: { bookingId: PNR },
    errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_PROCESS' }],
  };
}

/** Localizador y nada más: la redisplay no se sincronizó a tiempo. */
function createPending(): unknown {
  return { timestamp: '2026-08-26T12:00:00', confirmationId: PNR, booking: { bookingId: PNR } };
}

/** Forma del contrato, sin localizador y sin `errors[]`: no hay nada creado que reconciliar. */
function createFailed(): unknown {
  return { timestamp: '2026-08-26T12:00:00' };
}

interface BookingViewOptions {
  readonly lane?: 'NDC' | 'ATPCO' | 'LCC';
  readonly isTicketed?: boolean;
}

function bookingView(options: BookingViewOptions = {}): unknown {
  return {
    bookingId: PNR,
    isCancelable: true,
    isTicketed: options.isTicketed ?? true,
    flights: [
      {
        itemId: '1',
        confirmationId: 'AB123',
        airlineCode: 'AA',
        sourceType: options.lane ?? 'NDC',
        flightStatusCode: 'HK',
        flightStatusName: 'Confirmed',
      },
    ],
    flightTickets: [{ number: '0012345678901', travelerIndex: 1 }],
    travelers: [{}, {}],
  };
}

function ticketCheck(confirmationId: string = PNR): unknown {
  return {
    timestamp: '2026-08-26T12:00:01',
    request: { confirmationId },
    tickets: [{ number: '0012345678901', isVoidable: true, isRefundable: false }],
    cancelOffers: [
      {
        offerItemId: 'OI-1',
        offerType: 'CANCEL',
        offerExpirationDate: '2026-08-27',
        offerExpirationTime: '23:59',
      },
    ],
  };
}

/** Cancelación limpia: el fabricante declara éxito cuando `errors[]` no viene. */
function cancelled(): unknown {
  return { timestamp: '2026-08-26T12:00:02' };
}

/** Segundo intento del mismo paso del saga. */
function alreadyCancelled(): unknown {
  return {
    timestamp: '2026-08-26T12:00:03',
    errors: [{ category: 'APPLICATION_ERROR', type: 'BOOKING_ALREADY_CANCELED' }],
  };
}

// ---------------------------------------------------------------------------------------------
// 1. El camino feliz completo, con la cadena de identificadores efímeros
// ---------------------------------------------------------------------------------------------

describe('la cadena completa: price → createBooking → getBooking → cancelBooking', () => {
  it('los identificadores del paso anterior son LOS QUE VIAJAN en el siguiente', async () => {
    const harness = wire({
      [SABRE_PRICE_PATH]: [ok(priceResponse())],
      [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())],
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView()), ok(bookingView())],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok(ticketCheck())],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled())],
    });

    // 1. Revalidar. Los ids que salen del shop son los que se mandan.
    const quote = await harness.price.priceQuote(shopOffer(), CTX);
    expect(at(harness.bodyAt(SABRE_PRICE_PATH), 'query.0.offerItemId')).toEqual([
      SHOP_OFFER_ITEM_ID,
    ]);

    // 2. Reservar CON LA OFERTA REVALIDADA. El carril NDC se elige porque la oferta trae los ids de
    //    price; si el mapper no los hubiera escrito, el adapter caería a ATPCO y estas aserciones
    //    se pondrían rojas.
    const providerPaxIds = quote.handles.passengerIds;
    const withProviderIds = passengers().map((passenger, position) => {
      const providerPaxId = providerPaxIds[position];
      return providerPaxId === undefined ? passenger : { ...passenger, providerPaxId };
    });
    const outcome = await harness.create.createBooking(
      orderRequest(quote.offer, { passengers: withProviderIds }),
      CTX,
    );

    const createBody = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(at(createBody, 'flightOffer.offerId')).toBe(quote.handles.offerId);
    expect(at(createBody, 'flightOffer.selectedOfferItems')).toEqual(quote.handles.offerItemIds);
    expect(at(createBody, 'travelers.0.id')).toBe(providerPaxIds[0]);
    expect(at(createBody, 'travelers.1.id')).toBe(providerPaxIds[1]);
    // `flightDetails` es mutuamente excluyente con `flightOffer`: mandar los dos reserva otra cosa.
    expect(createBody['flightDetails']).toBeUndefined();

    // 3. Leer con el localizador que devolvió la creación, no con uno recordado.
    expect(outcome.result.pnr).toBe(PNR);
    const view = await harness.manage.retrieveForDisplay(outcome.result.pnr ?? '', CTX);
    expect(view.found).toBe(true);
    expect(view.airlineLocators).toEqual([{ carrierCode: 'AA', locator: 'AB123' }]);

    // 4. Cancelar. El adapter relee, comprueba billetes y sólo entonces cancela.
    const cancel = await harness.manage.cancelBooking(outcome.result.pnr ?? '', CTX);
    expect(cancel.result.success).toBe(true);

    expect(harness.paths()).toEqual([
      SABRE_PRICE_PATH,
      SABRE_CREATE_BOOKING_PATH,
      SABRE_GET_BOOKING_PATH,
      SABRE_GET_BOOKING_PATH,
      SABRE_CHECK_FLIGHT_TICKETS_PATH,
      SABRE_CANCEL_BOOKING_PATH,
    ]);
    for (const path of [SABRE_CHECK_FLIGHT_TICKETS_PATH, SABRE_CANCEL_BOOKING_PATH]) {
      expect(at(harness.bodyAt(path), 'confirmationId')).toBe(PNR);
    }
  });

  it('createBooking no devuelve firma: modificar exige encadenar getBooking', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX);

    expect(outcome.hasBookingSignature).toBe(false);
    expect(outcome.result.revision).toBeUndefined();
  });

  it('el arnés se pone rojo si el ACL no sale al cable: la sonda anti-tautología', async () => {
    // Sin este test, todas las aserciones sobre `bodyAt(...)` podrían estar mirando un `calls` vacío.
    const harness = wire({ [SABRE_PRICE_PATH]: [ok(priceResponse())] });

    await expect(harness.create.createBooking(orderRequest(shopOffer()), CTX)).rejects.toThrow(
      SabreApiError,
    );
    expect(harness.paths()).toEqual([SABRE_CREATE_BOOKING_PATH]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Los cuatro desenlaces, y que no se confundan entre sí
// ---------------------------------------------------------------------------------------------

describe('los desenlaces de createBooking salen cada uno con su forma', () => {
  it('CONFIRMED: todo confirmado, sin incidencias y sin nada que compensar', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX);

    expect(outcome.result.outcome).toBe('CONFIRMED');
    expect(outcome.result.items).toEqual([
      {
        kind: 'flight',
        providerItemId: '1',
        status: 'CONFIRMED',
        statusCode: 'HK',
        message: 'Confirmed',
      },
    ]);
    expect(outcome.result.issues).toEqual([]);
    // Nada se cayó, así que no hay compensación que disparar.
    expect(outcome.failures.dependencyFailed).toBe(false);
    expect(outcome.failures.accessoryFailures).toEqual([]);
  });

  it('PARTIAL con el ASIENTO fuera: el vuelo sigue confirmado y el asiento no arrastra nada', async () => {
    const limpio = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const clean = await limpio.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createPartialSeat())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    expect(outcome.result.outcome).toBe('PARTIAL');
    expect(outcome.result.pnr).toBe(PNR);
    expect(outcome.result.items).toHaveLength(2);
    expect(outcome.result.items.find((item) => item.kind === 'flight')?.status).toBe('CONFIRMED');
    const seat = outcome.result.items.find((item) => item.kind === 'seat');
    expect(seat?.status).toBe('FAILED');

    // LA REGLA DEL FUNDADOR, medida por la puerta pública. `Seat` (`:2409-2444`) no declara
    // `itemId` y `CancelBookingRequest` no tiene carril de asientos, así que lo ÚNICO que un
    // asiento caído podría aportar a la lista de compensación es el `itemId` del VUELO al que
    // cuelga — o sea, cancelar el vuelo porque falló el asiento. Dos comprobaciones lo cierran:
    // el asiento no tiene id que aportar, y la lista de cancelables es EXACTAMENTE la misma que
    // la de la misma reserva sin el fallo.
    expect(seat?.providerItemId).toBeUndefined();
    expect(compensationIds(outcome.result)).toEqual(compensationIds(clean.result));
    expect(compensationIds(outcome.result)).not.toContain('12A');

    expect(outcome.failures.accessoryFailures).toEqual(['seat']);
    expect(outcome.failures.dependencyFailures).toEqual([]);
    expect(outcome.failures.dependencyFailed).toBe(false);
  });

  it('el MISMO cuerpo con otro caso de uso sí dispara compensación: la tolerancia decide', async () => {
    // Sin esta pareja, el test de arriba no demostraría nada: un `dependencyFailed: false` constante
    // pasaría igual. Aquí el asiento NO se declaró accesorio y el veredicto se invierte.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createPartialSeat())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_ONLY',
    });

    expect(outcome.failures.accessoryFailures).toEqual([]);
    expect(outcome.failures.dependencyFailures).toEqual(['seat']);
    expect(outcome.failures.dependencyFailed).toBe(true);
  });

  it('PARTIAL con un producto cancelable caído: eso sí deja algo que deshacer', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createPartialHotel())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    expect(outcome.result.outcome).toBe('PARTIAL');
    expect(outcome.result.items.find((item) => item.kind === 'flight')?.status).toBe('CONFIRMED');
    expect(outcome.result.items.find((item) => item.kind === 'hotel')?.status).toBe('FAILED');
    // El hotel FALLÓ: no llegó a crearse y no hay nada que cancelarle. Lo deshacible es lo que sí
    // existe, ítem a ítem — nunca un `cancelAll` ciego.
    expect(compensationIds(outcome.result)).toEqual(['1']);
    // Y un hotel no está entre los accesorios de ningún caso de uso del carril aéreo.
    expect(outcome.failures.dependencyFailures).toEqual(['hotel']);
    expect(outcome.failures.dependencyFailed).toBe(true);
  });

  it('PARTIAL sin ítem que explique el error: la decisión NO se toma aquí', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createPartialUnattributed())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    expect(outcome.result.outcome).toBe('PARTIAL');
    expect(outcome.failures.hasUnattributedErrors).toBe(true);
    // No se compensa por sospecha: se relee con getBooking. Compensar de más cancela un vuelo bueno.
    expect(outcome.failures.dependencyFailed).toBe(false);
    expect(outcome.result.compensation).toBeUndefined();
  });

  it('PENDING: hay localizador y todavía no hay contenido; NO es un fallo', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createPending())] });
    const { result } = await harness.create.createBooking(orderRequest(shopOffer()), CTX);

    expect(result.outcome).toBe('PENDING');
    expect(result.pnr).toBe(PNR);
    expect(result.items).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.compensation).toBeUndefined();
  });

  it('FAILED: sin localizador no hay nada creado que reconciliar', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createFailed())] });
    const { result } = await harness.create.createBooking(orderRequest(shopOffer()), CTX);

    expect(result.outcome).toBe('FAILED');
    expect(result.pnr).toBeUndefined();
    expect(result.orderId).toBeUndefined();
    expect(result.compensation).toBeUndefined();
  });

  it('los cuatro son distinguibles: cuatro cuerpos, cuatro desenlaces distintos', async () => {
    const bodies = [createConfirmed(), createPartialSeat(), createPending(), createFailed()];
    const outcomes: string[] = [];
    for (const body of bodies) {
      const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(body)] });
      const { result } = await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
        useCase: 'FLIGHT_WITH_EXTRAS',
      });
      outcomes.push(result.outcome);
    }
    expect(outcomes).toEqual(['CONFIRMED', 'PARTIAL', 'PENDING', 'FAILED']);
    expect(new Set(outcomes).size).toBe(4);
  });

  it('un desenlace parcial se loguea en warn, con el caso de uso y con la política que se mandó', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createPartialSeat())] });
    await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    const line = harness.logs.find((call) => call.message === 'sabre.createBooking');
    expect(line?.level).toBe('warn');
    expect(line?.meta?.['useCase']).toBe('FLIGHT_WITH_EXTRAS');
    expect(line?.meta?.['errorHandlingPolicy']).toEqual([
      SABRE_ERROR_POLICY_BY_TOLERANCE.ANCILLARY,
      SABRE_ERROR_POLICY_BY_TOLERANCE.SEAT,
    ]);
    // El cliente HTTP tiene que haberlo visto también: entregar el cuerpo NO es decir que fue bien.
    expect(harness.logs.some((call) => call.message === 'sabre.http.desenlace_parcial')).toBe(true);
  });

  it('sin localizador, un errors[] NO se tolera: el coste está dicho entero', async () => {
    // La evidencia que permite entregar un `createBooking` con `errors[]` es el LOCALIZADOR. Sin
    // él no hay PNR que salvar, y el sobre vuelve a ser un rechazo clasificado.
    const harness = wire({
      [SABRE_CREATE_BOOKING_PATH]: [
        ok({ errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_BOOK_FLIGHT' }] }),
      ],
    });

    await expect(harness.create.createBooking(orderRequest(shopOffer()), CTX)).rejects.toThrow(
      SabreApiError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Lo que el contrato exige en el cable
// ---------------------------------------------------------------------------------------------

describe('lo que el contrato exige que salga en el cuerpo de createBooking', () => {
  it('errorHandlingPolicy y asynchronousUpdateWaitTime están SIEMPRE, y la espera nunca es 0', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    await harness.create.createBooking(orderRequest(shopOffer()), CTX);

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(body['errorHandlingPolicy']).toEqual(['HALT_ON_ERROR']);
    expect(body['asynchronousUpdateWaitTime']).toBe(SABRE_ASYNC_UPDATE_WAIT_MS_DEFAULT);
    expect(body['asynchronousUpdateWaitTime']).not.toBe(0);
    // Y en el cuerpo SERIALIZADO, no sólo en el objeto: un `undefined` desaparece al stringificar.
    const raw = harness.calls[0]?.raw ?? '';
    expect(raw).toContain('"errorHandlingPolicy"');
    expect(raw).toContain('"asynchronousUpdateWaitTime"');
  });

  it('el caso de uso se traduce al enum del contrato, en su orden, y sin HALT_ON_ERROR', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
      asynchronousUpdateWaitTimeMs: 4500,
    });

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(body['errorHandlingPolicy']).toEqual([
      SABRE_ERROR_POLICY_BY_TOLERANCE.ANCILLARY,
      SABRE_ERROR_POLICY_BY_TOLERANCE.SEAT,
    ]);
    // Pedir parar y seguir a la vez es lo que nadie puede interpretar.
    expect(body['errorHandlingPolicy']).not.toContain('HALT_ON_ERROR');
    expect(body['asynchronousUpdateWaitTime']).toBe(4500);
    // Y lo que se decidió viaja al `domain_event`, no sólo al cable.
    expect(outcome.useCase).toBe('FLIGHT_WITH_EXTRAS');
    expect(outcome.asynchronousUpdateWaitTimeMs).toBe(4500);
    expect(outcome.providerRaw['errorHandlingPolicy']).toEqual(body['errorHandlingPolicy']);
  });

  it('ningún caso de uso puede declarar tolerancia a un bloque que este carril no construye', async () => {
    // `flightOffer`/`flightDetails` y nada más: un `DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR` en un body
    // sin bloque de hotel es una opción aceptada y sin efecto, que parece que hace algo.
    const prohibidas = ['DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR', 'DO_NOT_HALT_ON_CAR_BOOKING_ERROR'];
    for (const useCase of SABRE_BOOKING_USE_CASES) {
      const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
      await harness.create.createBooking(orderRequest(shopOffer()), CTX, { useCase });

      const policy = harness.bodyAt(SABRE_CREATE_BOOKING_PATH)['errorHandlingPolicy'];
      expect(Array.isArray(policy)).toBe(true);
      for (const prohibida of prohibidas) {
        expect(policy).not.toContain(prohibida);
      }
    }
  });

  it('una espera de 0 muere ANTES del cable: el contrato la admite y nosotros no', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });

    await expect(
      harness.create.createBooking(orderRequest(shopOffer()), CTX, {
        asynchronousUpdateWaitTimeMs: 0,
      }),
    ).rejects.toThrow(SabreCreateBookingError);
    expect(harness.calls).toHaveLength(0);
  });

  it('el carril ATPCO sale cotizado: una reserva sin price quote emite a otra tarifa', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    await harness.create.createBooking(orderRequest(atpcoOffer()), CTX);

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(body['flightOffer']).toBeUndefined();
    expect(at(body, 'flightDetails.flights.0.airlineCode')).toBe('AA');
    // `[{}]` es «cotiza con defaults»; omitir el bloque es «reserva sin cotizar».
    expect(at(body, 'flightDetails.flightPricing')).toEqual([{}]);
  });

  it('los índices salen 1-based con varios pasajeros, y un 0 no puede escribirse', async () => {
    // Se entra por `SabreHttpClient.postJson` —la otra puerta pública— porque el puerto del dominio
    // no transporta asientos ni posiciones de forma de pago, así que `SabreOrderCreateAdapter` no
    // llega a emitir ningún índice. Lo que se mide sigue siendo el cuerpo del cable.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const traveler = (givenName: string) => ({ givenName, surname: 'TEST', passengerCode: 'ADT' });

    const plan = buildSabreCreateBookingRequest(
      {
        product: {
          kind: 'ndc',
          offerId: 'OFFER-1',
          selectedOfferItems: ['ITEM-1'],
          seatOffers: [
            { seatOfferId: 'SEAT-OFFER-A', travelerPosition: 0 },
            { seatOfferId: 'SEAT-OFFER-C', travelerPosition: 2 },
          ],
          segmentCount: 1,
        },
        travelers: [traveler('UNO'), traveler('DOS'), traveler('TRES')],
        carriers: ['AA'],
      },
      config(),
      { partialFailureTolerance: ['SEAT'], asynchronousUpdateWaitTimeMs: 2000 },
    );
    await harness.http.postJson(plan.path, plan.body);

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(at(body, 'travelers')).toHaveLength(3);
    // 0 → 1 y 2 → 3. Un off-by-one aquí no lanza y no aparece en ningún camino feliz: el asiento
    // queda asignado al pasajero equivocado y se descubre en el aeropuerto.
    expect(at(body, 'flightOffer.seatOffers.0.travelerIndex')).toBe(1);
    expect(at(body, 'flightOffer.seatOffers.1.travelerIndex')).toBe(3);
    expect(harness.calls[0]?.raw).not.toContain('"travelerIndex":0');
  });

  it('una posición que no existe muere antes del cable, no como índice inventado', () => {
    expect(() =>
      buildSabreCreateBookingRequest(
        {
          product: {
            kind: 'ndc',
            offerId: 'OFFER-1',
            selectedOfferItems: ['ITEM-1'],
            seatOffers: [{ seatOfferId: 'SEAT-OFFER-X', travelerPosition: 3 }],
            segmentCount: 1,
          },
          travelers: [{ givenName: 'UNO', surname: 'TEST' }],
          carriers: ['AA'],
        },
        config(),
        {},
      ),
    ).toThrow(SabreIndexError);
  });

  it('BA: sin tratamiento ni correo de agencia la reserva NO sale al cable', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const sinTitulo = passengers().map(({ title: _title, ...rest }) => rest);

    await expect(
      harness.create.createBooking(
        orderRequest(withCarrier(shopOffer(), 'BA'), { passengers: sinTitulo }),
        CTX,
      ),
    ).rejects.toThrow(SabreCreateBookingError);
    // Un rechazo del proveedor podría llegar con un PNR a medias; éste no llega con nada.
    expect(harness.calls).toHaveLength(0);
  });

  it('BA: con lo que exige, los campos por aerolínea viajan en el cuerpo', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const outcome = await harness.create.createBooking(
      orderRequest(withCarrier(shopOffer(), 'BA')),
      CTX,
      {
        agency: {
          contactInfo: {
            emails: ['ops@agencia.example'],
            phones: ['11234+15551239999789'],
            includePhoneLabel: true,
          },
        },
      },
    );

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(at(body, 'travelers.0.title')).toBe('Mrs');
    expect(at(body, 'travelers.0.identityDocuments.0.citizenshipCountryCode')).toBe('PE');
    expect(at(body, 'agency.contactInfo.emails')).toEqual(['ops@agencia.example']);
    expect(outcome.carriers).toEqual(['BA']);
    // El teléfono legacy no cumple el formato de la guía de errores: avisa, no bloquea, y el aviso
    // nombra el CAMPO, nunca el número.
    expect(outcome.advisories).toEqual([
      'AGENCY_PHONE_COUNTRY_CODE_FORMAT/*/agency.contactInfo.phones/advisory',
    ]);
    expect(JSON.stringify(outcome.advisories)).not.toContain('5551239999789');
  });

  it('el paxType del dominio se traduce al PTC de Sabre: CHD no es CNN por casualidad', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const [adult] = passengers();
    if (adult === undefined) throw new Error('sin pasajeros');
    const child: Passenger = { ...adult, paxId: 'PAX-3', paxType: 'CHD' };

    await harness.create.createBooking(
      orderRequest(shopOffer(), { passengers: [adult, child] }),
      CTX,
    );

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(at(body, 'travelers.0.passengerCode')).toBe('ADT');
    expect(at(body, 'travelers.1.passengerCode')).toBe('CNN');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Anti-PAN sobre el cuerpo real de los tres endpoints
// ---------------------------------------------------------------------------------------------

/** Claves que un cuerpo de salida de esta fase no puede llevar (D1, PCI SAQ-A). */
const CARD_KEY = /card|cvv|cvc|securitycode|unmaskpayment/i;

/** Una tirada contigua de 12-19 dígitos es la forma de un PAN (`^[0-9]{12,19}$` del contrato). */
const PAN_SHAPE = /\d{12,19}/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let position = digits.length - 1; position >= 0; position -= 1) {
    const char = digits[position];
    if (char === undefined) return false;
    let value = Number(char);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Todas las claves del cuerpo, a cualquier profundidad. */
function keysOf(value: unknown, sink: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, sink);
    return sink;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      sink.push(key);
      keysOf(child, sink);
    }
  }
  return sink;
}

describe('anti-PAN sobre el cuerpo real de price, createBooking y cancelBooking', () => {
  it('el detector de PAN reconoce un PAN: la sonda del propio guardia', () => {
    // Sin esto, `expect(runs.filter(luhn)).toEqual([])` podría estar pasando porque el detector no
    // detecta nada.
    expect('{"n":"4111111111111111"}'.match(PAN_SHAPE)?.filter(luhn)).toEqual(['4111111111111111']);
    expect(CARD_KEY.test('cardNumber')).toBe(true);
  });

  it('ningún cuerpo de la fase lleva clave de tarjeta ni una tirada con forma de PAN', async () => {
    const harness = wire({
      [SABRE_PRICE_PATH]: [ok(priceResponse())],
      [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())],
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView({ lane: 'ATPCO', isTicketed: false }))],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled())],
    });

    const quote = await harness.price.priceQuote(shopOffer(), CTX);
    await harness.create.createBooking(orderRequest(quote.offer), CTX);
    await harness.manage.cancelBooking(PNR, CTX);

    expect(harness.paths()).toEqual([
      SABRE_PRICE_PATH,
      SABRE_CREATE_BOOKING_PATH,
      SABRE_GET_BOOKING_PATH,
      SABRE_CANCEL_BOOKING_PATH,
    ]);

    for (const call of harness.calls) {
      expect(keysOf(call.body).filter((key) => CARD_KEY.test(key))).toEqual([]);
      expect((call.raw.match(PAN_SHAPE) ?? []).filter(luhn)).toEqual([]);
    }
  });

  it('una tarjeta en el request del dominio NO llega al cable: el adapter ni la mira', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    // `OrderCreateRequest.payment` admite tarjeta en el tipo del dominio. Sabre no la ve.
    const request = orderRequest(shopOffer(), {
      payment: {
        type: 'Credit Card',
        card: {
          brandCode: 'VI',
          holderName: `${PII.givenName} ${PII.surname}`,
          number: '4111111111111111',
          expirationDate: '2030-01',
          securityCode: '737',
        },
        amount: 237.8,
        currency: 'USD',
      },
    });

    await harness.create.createBooking(request, CTX);

    const call = harness.calls[0];
    if (call === undefined) throw new Error('sin llamada al cable');
    expect(call.raw).not.toContain('4111111111111111');
    expect(call.raw).not.toContain('"737"');
    expect(keysOf(call.body).filter((key) => CARD_KEY.test(key))).toEqual([]);
    // Lo que sí sale es la forma de pago sin PAN que fija D1.
    expect(at(call.body, 'payment.formsOfPayment')).toEqual([{ type: 'CASH' }]);
  });

  it('tarificar con BIN se rechaza por tenant y no toca la red (D1)', async () => {
    const harness = wire({ [SABRE_PRICE_PATH]: [ok(priceResponse())] });

    await expect(
      harness.price.priceQuote(shopOffer(), CTX, {
        formOfPayment: { subCode: 'VI', binNumber: '411111' },
      }),
    ).rejects.toThrow(SabreCardBinPricingDeniedError);
    expect(harness.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. La cancelación NDC y su idempotencia
// ---------------------------------------------------------------------------------------------

describe('cancelar: el checkFlightTickets previo y el segundo intento del saga', () => {
  it('contenido NDC: la comprobación de billetes va ANTES, y la cancelación después', async () => {
    const harness = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView({ lane: 'NDC' }))],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok(ticketCheck())],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled())],
    });

    const cancel = await harness.manage.cancelBooking(PNR, CTX);

    expect(harness.paths()).toEqual([
      SABRE_GET_BOOKING_PATH,
      SABRE_CHECK_FLIGHT_TICKETS_PATH,
      SABRE_CANCEL_BOOKING_PATH,
    ]);
    expect(cancel.ticketCheckPerformed).toBe(true);
    expect(cancel.outcome).toBe('CANCELLED');
    // Explícito siempre, aunque coincida con el default del contrato: de este flag depende que la
    // cancelación multi-producto haga rollback.
    expect(harness.bodyAt(SABRE_CANCEL_BOOKING_PATH)['errorHandlingPolicy']).toBe('HALT_ON_ERROR');
  });

  it('contenido ATPCO sin emitir: no se paga una comprobación que la regla no pide', async () => {
    const harness = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView({ lane: 'ATPCO', isTicketed: false }))],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled())],
    });

    const cancel = await harness.manage.cancelBooking(PNR, CTX);

    expect(harness.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_CANCEL_BOOKING_PATH]);
    expect(cancel.ticketCheckPerformed).toBe(false);
  });

  it('una evidencia DE OTRA RESERVA no cancela nada: peor que ninguna es la que pasa el control', async () => {
    const harness = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView({ lane: 'NDC' }))],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok(ticketCheck('OTRAPNR'))],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled())],
    });

    await expect(harness.manage.cancelBooking(PNR, CTX)).rejects.toThrow(
      /TICKET_CHECK_FOR_ANOTHER_BOOKING/,
    );
    // Lo que importa no es el error: es que `cancelBooking` NO aparece en el cable.
    expect(harness.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_CHECK_FLIGHT_TICKETS_PATH]);
  });

  it('una comprobación ilegible tampoco deja cancelar a ciegas', async () => {
    const harness = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView({ lane: 'NDC' }))],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok({ tickets: 'no es un array' })],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled())],
    });

    await expect(harness.manage.cancelBooking(PNR, CTX)).rejects.toThrow(/TICKET_CHECK_MALFORMED/);
    expect(harness.paths()).not.toContain(SABRE_CANCEL_BOOKING_PATH);
  });

  it('cancelar dos veces es idempotente: misma clave, mismo estado final, cero reembolso extra', async () => {
    const harness = wire({
      [SABRE_GET_BOOKING_PATH]: [
        ok(bookingView({ lane: 'NDC' })),
        ok(bookingView({ lane: 'NDC' })),
      ],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok(ticketCheck()), ok(ticketCheck())],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled()), ok(alreadyCancelled())],
    });

    const first = await harness.manage.cancelBooking(PNR, CTX);
    const second = await harness.manage.cancelBooking(PNR, CTX);

    // La clave es el hash del cuerpo canónico: el saga reconoce que es EL MISMO paso.
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    // Y los dos cuerpos que salieron al cable son idénticos byte a byte.
    const bodies = harness.calls
      .filter((call) => call.path === SABRE_CANCEL_BOOKING_PATH)
      .map((call) => call.raw);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);

    // Mismo resultado de dominio; lo que cambia es que la segunda vez no se reembolsa nada.
    expect(first.result.success).toBe(true);
    expect(second.result.success).toBe(true);
    expect(first.outcome).toBe('CANCELLED');
    expect(second.outcome).toBe('ALREADY_CANCELLED');
    expect(second.detail.refunds).toEqual([]);
  });

  it('la cancelación no se reintenta aunque quien llame jure que es idempotente', async () => {
    // `cancelBooking` está en `SABRE_NON_IDEMPOTENT_PATHS`. Un 503 sale como error a la primera: si
    // hubiera reintento, la segunda respuesta preparada se consumiría y no lanzaría.
    const harness = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView({ lane: 'ATPCO', isTicketed: false }))],
      [SABRE_CANCEL_BOOKING_PATH]: [
        { status: 503, body: { message: 'service unavailable' } },
        ok(cancelled()),
      ],
    });

    await expect(harness.manage.cancelBooking(PNR, CTX)).rejects.toThrow(SabreApiError);
    expect(harness.paths().filter((path) => path === SABRE_CANCEL_BOOKING_PATH)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. PII: nada del cuerpo de reserva llega a un log ni al mensaje de un error
// ---------------------------------------------------------------------------------------------

describe('PII: el cuerpo de reserva no sale por el log', () => {
  it('la cadena entera no deja un solo dato de pasajero en el log', async () => {
    const harness = wire({
      [SABRE_PRICE_PATH]: [ok(priceResponse())],
      [SABRE_CREATE_BOOKING_PATH]: [ok(createPartialSeat())],
      [SABRE_GET_BOOKING_PATH]: [ok(bookingView({ lane: 'NDC' }))],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok(ticketCheck())],
      [SABRE_CANCEL_BOOKING_PATH]: [ok(cancelled())],
    });

    const quote = await harness.price.priceQuote(shopOffer(), CTX);
    await harness.create.createBooking(orderRequest(quote.offer), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });
    await harness.manage.cancelBooking(PNR, CTX, { surname: PII.surname });

    // Sanidad: si el log estuviera vacío, esta comprobación sería vacua.
    expect(harness.logs.length).toBeGreaterThan(3);
    const dumped = JSON.stringify(harness.logs);
    for (const value of PII_VALUES) {
      expect(dumped).not.toContain(value);
    }
    // El apellido se manda como control de acceso ligero y vuelve en el eco; del log sólo sale que
    // se usó, nunca cuál.
    const read = harness.logs.find((call) => call.message === 'sabre.getBooking');
    expect(read?.meta?.['withSurnameCheck']).toBe(true);
  });

  it('provider_raw es lista blanca: ni texto libre del proveedor ni el valor que rechazó', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createPartialSeat())] });
    const outcome = await harness.create.createBooking(orderRequest(shopOffer()), CTX, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    const dumped = JSON.stringify(outcome.providerRaw);
    // `description` es texto libre del proveedor y `fieldValue` es el dato que MANDAMOS devuelto
    // tal cual: un número de pasaporte. Ninguno de los dos se persiste.
    expect(dumped).not.toContain(PII.surname);
    expect(dumped).not.toContain(PII.document);
    expect(dumped).not.toContain('fieldValue');
    expect(dumped).not.toContain('description');
    // Y lo que sí se persiste sigue estando: el desenlace es auditable.
    expect(outcome.providerRaw['outcome']).toBe('PARTIAL');
    expect(outcome.providerRaw['pnr']).toBe(PNR);
    expect(at(outcome.providerRaw, 'issues.0.type')).toBe('UNABLE_TO_BOOK_SEAT');
  });

  it('el eco del request dentro de un rechazo no saca nombres, fechas ni documentos', async () => {
    // `CreateBookingResponse.request` es una copia íntegra del payload enviado (`:827`). Si el sobre
    // se rechaza, ese eco es lo que alimenta `SabreApiError`.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [rejectionEchoing()] });

    const error = await harness.create
      .createBooking(orderRequest(shopOffer()), CTX)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SabreApiError);
    const api = error as SabreApiError;
    for (const value of [PII.givenName, PII.surname, PII.birthdate, PII.document]) {
      expect(api.message).not.toContain(value);
      expect(api.body).not.toContain(value);
    }
  });

  it('HALLAZGO ABIERTO: las claves PLURALES del contrato (emails/phones) NO se redactan', async () => {
    // ⚠️ Este test fija el comportamiento ACTUAL, que es un defecto REPORTADO, no un invariante que
    // se quiera conservar. `redaction.ts` conoce `email`/`phone` en singular, pero los nombres que
    // usa el contrato —y que este propio ACL construye— son `contactInfo.emails[]`,
    // `travelers[].emails[]` y `travelers[].phones[].number`. Como `createBooking` y `getBooking`
    // hacen eco de la request, un rechazo mete el correo y el teléfono del pasajero en
    // `SabreApiError.message` y en `.body`.
    //
    // Cuando se cierre el hueco en `redaction.ts`, este test se pondrá rojo: hay que invertir las
    // dos aserciones a `not.toContain` y moverlas al test de arriba, que es donde pertenecen.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [rejectionEchoing()] });

    const error = await harness.create
      .createBooking(orderRequest(shopOffer()), CTX)
      .then(() => null)
      .catch((caught: unknown) => caught);

    const api = error as SabreApiError;
    expect(api.body).toContain(PII.email);
    expect(api.body).toContain('+5115550142');
  });
});

/**
 * Un rechazo del proveedor que hace eco del cuerpo de reserva con los NOMBRES DE CAMPO DEL
 * CONTRATO. La forma importa: `emails`/`phones` en plural son las que emite el builder, y son
 * justamente las que el redactor no conoce.
 */
function rejectionEchoing(): Reply {
  return {
    status: 400,
    body: {
      errors: [{ category: 'BAD_REQUEST', type: 'REQUIRED_FIELD_MISSING' }],
      request: {
        contactInfo: { emails: [PII.email], phones: ['+5115550142'] },
        travelers: [
          {
            givenName: PII.givenName,
            surname: PII.surname,
            birthDate: PII.birthdate,
            identityDocuments: [{ documentNumber: PII.document }],
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// La costura que nadie cruzaba: una oferta SALIDA DEL MAPPER, no escrita a mano
// ---------------------------------------------------------------------------------------------

/**
 * Todo lo de arriba reserva `shopOffer()`, que es un `Offer` escrito a mano en este fichero.
 * Está bien para probar los desenlaces, y es ciego a la única pregunta que importa en producción:
 * **¿lo que produce la búsqueda se puede reservar?**
 *
 * Entre las dos mitades hay una traducción real —`mapSabreShopResponse` decide `bookingClass`,
 * `flightNumber` como texto, las horas locales con offset, y qué va en `provider.raw`— y
 * `productOf` vuelve a leer todo eso. Dos mitades que nadie cruzó es exactamente la forma que
 * tenía la avería que trajo aquí: reservar fallaba con `SabreCreateBookingError`, o sea el body
 * ni salía al cable, y los 2.374 tests del paquete seguían verdes.
 */
describe('reservar LO QUE DEVUELVE LA BÚSQUEDA, no una oferta de laboratorio', () => {
  /** La primera oferta del fixture real de BFM, pasada por el mapper de verdad. */
  function ofertaDeBusqueda(): Offer {
    const mapped = mapSabreShopResponse(structuredClone(adultFixture), {
      tenantId: TENANT_ID,
      currency: 'USD',
      fetchedAt: '2026-08-26T12:00:00.000Z',
    });
    const first = mapped.offers[0];
    if (first === undefined) throw new Error('el fixture de shop no produjo ninguna oferta');
    return first;
  }

  it('la oferta del mapper llega entera al body de createBooking', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const offer = ofertaDeBusqueda();

    const outcome = await harness.create.createBooking(orderRequest(offer), CTX);
    expect(outcome.result.outcome).toBe('CONFIRMED');

    // Sin ids de `offers/price`, el carril correcto es ATPCO: se reserva por `flightDetails`,
    // no por `flightOffer`. Reservar por el carril equivocado reservaría otra cosa.
    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(at(body, 'flightOffer')).toBeUndefined();
    expect(at(body, 'flightDetails.flights.0.airlineCode')).toBe(
      (offer.itineraries ?? [])[0]?.segments[0]?.carrier,
    );
    // Y cotiza: `flightPricing` ausente es «reserva sin price quote», que deja al PNR con un
    // precio distinto del que se le dio al cliente.
    expect(at(body, 'flightDetails.flightPricing')).toHaveLength(1);
  });

  it('cada segmento que produjo el mapper es reservable: nada se pierde en la traducción', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const offer = ofertaDeBusqueda();
    const segmentos = (offer.itineraries ?? []).flatMap((it) => it.segments);

    await harness.create.createBooking(orderRequest(offer), CTX);

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    const flights = at(body, 'flightDetails.flights') as unknown[];
    // Un segmento que se cae por el camino es un tramo que el pasajero no tiene reservado.
    expect(flights).toHaveLength(segmentos.length);
    expect(segmentos.length).toBeGreaterThan(1);

    // Y cada uno lleva su número como ENTERO: el mapper lo produce como texto y el builder lo
    // exige numérico. Es una de las traducciones que ningún test cruzaba.
    for (const [i, flight] of flights.entries()) {
      const f = flight as Record<string, unknown>;
      expect(typeof f.flightNumber).toBe('number');
      expect(String(f.flightNumber)).toBe(segmentos[i]!.flightNumber);
      expect(f.bookingClass).toBe(segmentos[i]!.bookingClass);
    }
  });
});

/**
 * Todos los pasajeros de este fichero viajan con PASAPORTE y con vencimiento. Por eso nadie vio
 * lo que sigue: en Colombia el documento del 95% de los pasajeros es la CÉDULA, y una cédula
 * **no vence**.
 *
 * El puerto de dominio declaraba `expiryDate` obligatorio, así que el formulario —que sólo pide
 * vencimiento para pasaporte, porque es el único que lo tiene— rellenaba `''` para satisfacer el
 * tipo. Esa cadena vacía cruzaba entera hasta el builder y Sabre rechazaba la reserva con
 * `travelers.0.identityDocuments.0.expiryDate:invalid_string`. Nadie podía reservar.
 */
describe('documentos sin vencimiento: la cédula no vence, y eso no es un error', () => {
  function conCedula(expiryDate?: string): Passenger[] {
    const [first, ...rest] = passengers();
    return [
      {
        ...first!,
        citizenshipCountryCode: 'CO',
        identityDoc: {
          type: 'CC',
          number: '1020304050',
          issuingCountryCode: 'CO',
          ...(expiryDate === undefined ? {} : { expiryDate }),
        },
      },
      ...rest,
    ];
  }

  it('sin vencimiento NO se manda documento: a medias es lo que Sabre rechaza', async () => {
    // En los 26 documentos ATPCO reales de la colección, los que llevan número llevan
    // vencimiento —21 de 21, sin una excepción— porque el documento se convierte en un SSR DOCS,
    // que es de formato fijo. Un número sin vencimiento no compone un DOCS.
    //
    // Y omitirlo no es una rareza: 9 de las 23 reservas ATPCO no llevan NINGÚN documento. En un
    // vuelo doméstico no hay APIS que declarar.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });

    const outcome = await harness.create.createBooking(
      orderRequest(shopOffer(), { passengers: conCedula() }),
      CTX,
    );

    expect(outcome.result.outcome).toBe('CONFIRMED');
    expect(
      at(harness.bodyAt(SABRE_CREATE_BOOKING_PATH), 'travelers.0.identityDocuments'),
    ).toBeUndefined();
  });

  it('pero el pasajero SIGUE identificado: el traveler lleva nombre, nacimiento y género', async () => {
    // Omitir el documento no puede degradar la reserva a un pasajero anónimo.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const [pax] = conCedula();

    await harness.create.createBooking(orderRequest(shopOffer(), { passengers: conCedula() }), CTX);

    const traveler = at(harness.bodyAt(SABRE_CREATE_BOOKING_PATH), 'travelers.0');
    expect(traveler).toMatchObject({
      givenName: pax!.givenName,
      surname: pax!.surname,
      birthDate: pax!.birthdate,
    });
  });

  it('el `""` del formulario se trata igual que la ausencia, no como un vencimiento', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });

    const outcome = await harness.create.createBooking(
      orderRequest(shopOffer(), { passengers: conCedula('') }),
      CTX,
    );

    expect(outcome.result.outcome).toBe('CONFIRMED');
    expect(
      at(harness.bodyAt(SABRE_CREATE_BOOKING_PATH), 'travelers.0.identityDocuments'),
    ).toBeUndefined();
  });

  it('CON vencimiento el documento viaja ENTERO, con la residencia incluida', async () => {
    // La otra mitad, y la que impide «arreglarlo» omitiendo siempre el documento: completo hay
    // que mandarlo, o un vuelo internacional se queda sin APIS.
    //
    // `residenceCountryCode` es el último campo que nos faltaba frente a los ejemplos reales:
    // 22/26 lo llevan y en todos los pasaportes vale lo mismo que el país emisor.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });

    await harness.create.createBooking(
      orderRequest(shopOffer(), { passengers: conCedula('2033-07-09') }),
      CTX,
    );

    expect(
      at(harness.bodyAt(SABRE_CREATE_BOOKING_PATH), 'travelers.0.identityDocuments.0'),
    ).toMatchObject({
      expiryDate: '2033-07-09',
      documentType: 'NATIONAL_ID_CARD',
      documentNumber: '1020304050',
      issuingCountryCode: 'CO',
      residenceCountryCode: 'CO',
    });
  });
});

/**
 * El documento tiene que decir DE QUIÉN es.
 *
 * Sabre rechazaba la reserva con `MANDATORY_DATA_MISSING` sobre
 * `CreateBookingRequest.travelers[0].identityDocuments[0]`, sin nombrar el campo. No lo exige el
 * esquema —su único `required` es `documentType`— sino el carrier, así que no hay contrato que
 * leer: hay que mirar qué mandan los requests que funcionan.
 *
 * De los 115 documentos de los `createBooking` reales de la colección, los 45 pasaportes llevan
 * `givenName`, `surname`, `birthDate` y `gender` SIN EXCEPCIÓN. Nosotros mandábamos sólo el
 * número y el país.
 */
describe('el documento identifica a su titular, no sólo al documento', () => {
  it('lleva nombre, apellido, nacimiento y género, como los 45 pasaportes de la colección', async () => {
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const [pax] = passengers();

    await harness.create.createBooking(orderRequest(shopOffer()), CTX);

    const doc = at(harness.bodyAt(SABRE_CREATE_BOOKING_PATH), 'travelers.0.identityDocuments.0');
    expect(doc).toMatchObject({
      givenName: pax!.givenName,
      surname: pax!.surname,
      birthDate: pax!.birthdate,
      gender: 'FEMALE',
    });
  });

  it('el género del documento es el MISMO que el del traveler, no uno inventado', async () => {
    // Dos fuentes del mismo dato en el mismo body es la forma de que se desincronicen. Salen del
    // mismo `genderOf`, y esto lo fija.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });

    await harness.create.createBooking(orderRequest(shopOffer()), CTX);

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(at(body, 'travelers.0.identityDocuments.0.gender')).toBe(at(body, 'travelers.0.gender'));
    expect(at(body, 'travelers.0.identityDocuments.0.birthDate')).toBe(
      at(body, 'travelers.0.birthDate'),
    );
  });

  it('un INFANTE lleva su género de infante también en el documento', async () => {
    // `INFANT_FEMALE`/`INFANT_MALE` son los que exige Secure Flight para lap children. Si el
    // documento dijera `FEMALE` a secas, las dos mitades del body se contradirían.
    const harness = wire({ [SABRE_CREATE_BOOKING_PATH]: [ok(createConfirmed())] });
    const [pax, ...resto] = passengers();
    const infante: Passenger[] = [{ ...pax!, paxType: 'INF', gender: 'M' }, ...resto];

    await harness.create.createBooking(orderRequest(shopOffer(), { passengers: infante }), CTX);

    const body = harness.bodyAt(SABRE_CREATE_BOOKING_PATH);
    expect(at(body, 'travelers.0.identityDocuments.0.gender')).toBe('INFANT_MALE');
    expect(at(body, 'travelers.0.gender')).toBe('INFANT_MALE');
  });
});
