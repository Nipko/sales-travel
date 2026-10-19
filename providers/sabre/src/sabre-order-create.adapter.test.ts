import type { Offer, Segment } from '@sales-travel/canonical';
import type { LoggerPort } from '@sales-travel/core';
import {
  OrderCreateNotSentError,
  type OrderCreateRequest,
  type OrderCreateResult,
  type SearchContext,
} from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import priceFixture from './__fixtures__/price-oneway-adult-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_NDC_PAYMENT_TIME_LIMIT_RAW_KEY } from './booking/ticketing-policy';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SABRE_FLIGHT_CHECK_RAW_KEYS } from './flight-check/response.mapper';
import { SabreHttpClient } from './http/sabre-http.client';
import { SABRE_RAW_KEYS } from './price/request.builder';
import { mapSabrePriceResponse } from './price/response.mapper';
import {
  SABRE_BOOKING_USE_CASES,
  SABRE_DEFAULT_BOOKING_USE_CASE,
  SABRE_PASSIVE_FLIGHT_STATUS_CODE,
  SABRE_TOLERANCE_BY_USE_CASE,
  SabreOrderCreateAdapter,
  classifySabrePartialFailure,
  type SabreBookingUseCase,
  type SabreOrderCreateDeps,
  type SabreOrderCreateOptions,
  type SabreOrderCreateOutcome,
} from './sabre-order-create.adapter';

/**
 * Los tests del adapter de creación, y una sola regla de método: **todo entra por la puerta
 * pública**.
 *
 * Cada caso construye el adapter de verdad, con el `SabreHttpClient` de verdad, y espía el `fetch`.
 * Lo que se afirma sobre el cable es el `init.body` que llega a `fetch` —los bytes literales—, no
 * el objeto que devuelve el builder. Es la cicatriz de este paquete: dos veces hubo código correcto
 * que producción no ejecutaba porque el test llamaba a la función interna en vez de a la que corre.
 *
 * Y el `200` con `booking` + `errors[]` de los casos de fallo parcial no está simulado a medias:
 * pasa por el clasificador de sobres real del cliente HTTP. Si ese clasificador volviera a lanzar
 * ante la respuesta legítima de una reserva con tolerancia parcial, estos tests se ponen rojos aquí
 * —donde importa— y no en un test de la función interna.
 */

const TENANT_ID = 'e6f1c2b0-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const OFFER_ID = '3b9a0f7e-2c1d-4b5a-9e8f-7d6c5b4a3210';

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

interface Wire {
  readonly outcome: SabreOrderCreateOutcome;
  /** El body EXACTO que llegó a `fetch`, ya deserializado. */
  readonly body: Record<string, unknown>;
  /** Los bytes, para cuando lo que importa es que una clave no esté. */
  readonly raw: string;
}

/** Manda la reserva por el adapter y el cliente reales y devuelve lo que salió y lo que volvió. */
async function book(
  request: OrderCreateRequest,
  response: unknown,
  options: SabreOrderCreateOptions = {},
  setup: { readonly cfg?: Partial<SabreConfig>; readonly deps?: SabreOrderCreateDeps } = {},
): Promise<Wire> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: SabreFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
  };
  const cfg: SabreConfig = { ...config(), ...setup.cfg };
  const http = new SabreHttpClient(cfg, tokens, { fetch: fetchImpl, uuid: () => 'conv-fijo' });
  const adapter = new SabreOrderCreateAdapter(cfg, http, setup.deps);
  const ctx: SearchContext = { tenantId: TENANT_ID, requestId: 'req-1' };

  const outcome = await adapter.createBooking(request, ctx, options);

  const sent = calls.at(-1);
  if (sent === undefined) throw new Error('el adapter no llegó a hacer la llamada');
  const raw = sent.init.body;
  if (typeof raw !== 'string') throw new Error('el body serializado no es una cadena');
  return { outcome, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

// ---------------------------------------------------------------------------------------------
// Ofertas y pasajeros
// ---------------------------------------------------------------------------------------------

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    carrier: 'AV',
    flightNumber: '0462',
    origin: 'BOG',
    destination: 'LIM',
    departureAt: '2026-09-14T09:15:00-05:00',
    arrivalAt: '2026-09-14T12:05:00-05:00',
    durationMinutes: 170,
    cabin: 'economy',
    bookingClass: 'Y',
    ...overrides,
  };
}

/** ATPCO: itinerario en el body, sin cadena de identificadores de `offers/price`. */
function atpcoOffer(): Offer {
  return {
    id: OFFER_ID,
    tenantId: TENANT_ID,
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'ATPCO-1', source: 'ATPCO' },
    total: { amountMinor: 45_000_00, currency: 'COP' },
    baseFare: { amountMinor: 38_000_00, currency: 'COP' },
    taxes: { amountMinor: 7_000_00, currency: 'COP' },
    itineraries: [{ segments: [segment()], totalDurationMinutes: 170, stops: 0 }],
    fetchedAt: '2026-08-26T12:00:00-05:00',
    expiresAt: '2026-08-26T12:30:00-05:00',
  };
}

/** NDC: la oferta ya pasó por `offers/price` y trae la cadena entera. */
function ndcOffer(): Offer {
  return {
    ...atpcoOffer(),
    provider: {
      name: 'sabre',
      offerRef: 'NDC-1',
      source: 'NDC',
      raw: {
        [SABRE_RAW_KEYS.priceOfferId]: 'dx369rfr7jt8dnd2i0-1',
        [SABRE_RAW_KEYS.priceOfferItemIds]: ['dx369rfr7jt8dnd2i0-1-1'],
        [SABRE_RAW_KEYS.pricePassengerIds]: ['Passenger1'],
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
  };
}

/** ATPCO ya revalidado: Flight Check entrega handles compatibles con Booking Management. */
function flightCheckedOffer(): Offer {
  return {
    ...atpcoOffer(),
    provider: {
      name: 'sabre',
      offerRef: 'ATPCO-CHECKED-1',
      source: 'ATPCO',
      raw: {
        [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferId]: 'checked-offer-1',
        [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferItemIds]: ['checked-offer-1-1'],
      },
    },
  };
}

function request(offer: Offer): OrderCreateRequest {
  return {
    offer,
    criteria: {
      origin: 'BOG',
      destination: 'LIM',
      departureDate: '2026-09-14',
      paxCount: { adults: 1, children: 0, infants: 0 },
      currency: 'COP',
    },
    passengers: [
      {
        paxId: 'pax-1',
        requestedTravelerIndex: 0,
        paxType: 'ADT',
        givenName: 'Juanito',
        surname: 'Perezosa',
        birthdate: '1980-12-02',
        gender: 'M',
        citizenshipCountryCode: 'CO',
        identityDoc: {
          type: 'CC',
          number: 'XZ9871',
          issuingCountryCode: 'CO',
          expiryDate: '2030-01-01',
        },
      },
    ],
    contactInfo: { email: 'centinela.pax@ejemplo.test', phone: '+57 (300) 123 4567' },
  };
}

// ---------------------------------------------------------------------------------------------
// Respuestas del proveedor
// ---------------------------------------------------------------------------------------------

const CONFIRMED_RESPONSE = {
  confirmationId: 'PYMUEZ',
  booking: {
    bookingId: 'PYMUEZ',
    flights: [{ itemId: 'F1', flightStatusCode: 'HK', flightStatusName: 'Confirmed' }],
  },
};

/**
 * El desenlace que produce elegir `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`: `200`, reserva dentro, vuelo
 * confirmado, asiento cancelado y el error del asiento al lado.
 */
const SEAT_FAILED_RESPONSE = {
  confirmationId: 'PYMUEZ',
  booking: {
    bookingId: 'PYMUEZ',
    flights: [
      {
        itemId: 'F1',
        flightStatusCode: 'HK',
        flightStatusName: 'Confirmed',
        seats: [{ number: '12A', statusCode: 'UC', statusName: 'Cancelled' }],
      },
    ],
  },
  errors: [
    {
      category: 'APPLICATION_ERROR',
      type: 'UNABLE_TO_BOOK_SEATS_NOT_AVAILABLE',
      description: 'One or some of the seats are not available.',
    },
  ],
};

/** El mismo `200` con reserva, pero lo cancelado es el VUELO: eso es de lo que depende la compra. */
const FLIGHT_FAILED_RESPONSE = {
  confirmationId: 'PYMUEZ',
  booking: {
    bookingId: 'PYMUEZ',
    flights: [
      { itemId: 'F1', flightStatusCode: 'HK', flightStatusName: 'Confirmed' },
      { itemId: 'F2', flightStatusCode: 'UC', flightStatusName: 'Cancelled' },
    ],
  },
  errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_SELL_SEGMENT' }],
};

// ---------------------------------------------------------------------------------------------
// 1. Toda reserva ATPCO sale COTIZADA
// ---------------------------------------------------------------------------------------------

describe('cotización ATPCO', () => {
  it('flightDetails llega al cable con flightPricing, no sólo con flights', async () => {
    const wire = await book(request(atpcoOffer()), CONFIRMED_RESPONSE);

    const details = wire.body['flightDetails'] as Record<string, unknown>;
    // La medición que abrió esta tanda: `flightDetails` llegaba con UNA sola clave.
    expect(Object.keys(details).sort()).toEqual(['flightPricing', 'flights']);
    // `[{}]` es «cotiza con defaults» (docs/sabre/04 §3.3.2). Su ausencia total sería «reserva sin
    // cotizar», que es una reserva sin precio garantizado.
    expect(details['flightPricing']).toEqual([{}]);
    expect(wire.raw).toContain('"flightPricing":[{}]');
  });

  it('cotiza en todas las formas de itinerario, no sólo en la de un tramo', async () => {
    // Ida y vuelta con escala: dos itinerarios, tres tramos, un solo bloque de cotización. Si la
    // cotización dependiera de la forma del itinerario, alguno de estos tres cuerpos saldría sin
    // precio garantizado y el cliente pagaría la diferencia.
    const offer: Offer = {
      ...atpcoOffer(),
      itineraries: [
        {
          segments: [
            segment(),
            segment({ origin: 'LIM', destination: 'SCL', flightNumber: '0631' }),
          ],
          totalDurationMinutes: 400,
          stops: 1,
        },
        {
          segments: [segment({ origin: 'SCL', destination: 'BOG', flightNumber: '0632' })],
          totalDurationMinutes: 300,
          stops: 0,
        },
      ],
    };

    const wire = await book(request(offer), CONFIRMED_RESPONSE);
    const details = wire.body['flightDetails'] as Record<string, unknown>;

    expect((details['flights'] as unknown[]).length).toBe(3);
    expect(details['flightPricing']).toEqual([{}]);
  });

  it('la pasiva NO se cotiza: el segmento se reservó fuera de Sabre y no hay nada que cotizar', async () => {
    const wire = await book(request(atpcoOffer()), CONFIRMED_RESPONSE, {
      flightStatusCode: SABRE_PASSIVE_FLIGHT_STATUS_CODE,
    });

    const details = wire.body['flightDetails'] as Record<string, unknown>;
    expect(details['flightPricing']).toBeUndefined();
    expect(Object.keys(details)).toEqual(['flights']);
  });

  it('la pasiva se reconoce normalizada: yk minúscula es la misma pasiva', async () => {
    const wire = await book(request(atpcoOffer()), CONFIRMED_RESPONSE, {
      flightStatusCode: ' yk ',
    });
    expect(
      (wire.body['flightDetails'] as Record<string, unknown>)['flightPricing'],
    ).toBeUndefined();
  });

  it('NDC no lleva flightPricing: el precio vive dentro de la oferta que ya pasó por price', async () => {
    const wire = await book(request(ndcOffer()), CONFIRMED_RESPONSE);

    expect(wire.body['flightDetails']).toBeUndefined();
    expect(wire.body['flightOffer']).toEqual({
      offerId: 'dx369rfr7jt8dnd2i0-1',
      selectedOfferItems: ['dx369rfr7jt8dnd2i0-1-1'],
    });
    expect(wire.raw).not.toContain('flightPricing');
  });

  it('NDC enlaza el traveler con el id de price por requestedTravelerIndex y tipo', async () => {
    const wire = await book(request(ndcOffer()), CONFIRMED_RESPONSE);
    const travelers = wire.body['travelers'] as Array<Record<string, unknown>>;
    expect(travelers[0]?.['id']).toBe('Passenger1');
  });

  it('NDC sin binding de pasajero falla antes de tocar la red', async () => {
    const offer = ndcOffer();
    const raw = { ...(offer.provider.raw ?? {}) };
    delete raw[SABRE_RAW_KEYS.pricePassengerBindings];
    await expect(
      book(request({ ...offer, provider: { ...offer.provider, raw } }), CONFIRMED_RESPONSE),
    ).rejects.toThrow(/pricePassengerBindings/);
  });

  it('NDC sin requestedTravelerIndex explícito no cae al orden del array', async () => {
    const input = request(ndcOffer());
    const passenger = input.passengers[0];
    if (passenger === undefined) throw new Error('fixture sin pasajero');
    const { requestedTravelerIndex: _removed, ...withoutIndex } = passenger;
    await expect(
      book({ ...input, passengers: [withoutIndex] }, CONFIRMED_RESPONSE),
    ).rejects.toThrow(/requestedTravelerIndex único/);
  });

  it('un providerPaxId manual que contradice price falla cerrado', async () => {
    const input = request(ndcOffer());
    const passenger = input.passengers[0];
    if (passenger === undefined) throw new Error('fixture sin pasajero');
    await expect(
      book(
        { ...input, passengers: [{ ...passenger, providerPaxId: 'StalePassenger' }] },
        CONFIRMED_RESPONSE,
      ),
    ).rejects.toThrow(/providerPaxId contradice/);
  });

  it('dos adultos se ordenan por índice explícito aunque el formulario los mande al revés', async () => {
    const offer = ndcOffer();
    const raw = {
      ...(offer.provider.raw ?? {}),
      [SABRE_RAW_KEYS.pricePassengerIds]: ['Passenger1', 'Passenger2'],
      [SABRE_RAW_KEYS.pricePassengerBindings]: [
        {
          pricePassengerId: 'Passenger1',
          requestedTravelerIndex: 0,
          paxType: 'ADT',
          requestedPtc: 'ADT',
          pricedPtc: 'ADT',
        },
        {
          pricePassengerId: 'Passenger2',
          requestedTravelerIndex: 1,
          paxType: 'ADT',
          requestedPtc: 'ADT',
          pricedPtc: 'ADT',
        },
      ],
    };
    const input = request({ ...offer, provider: { ...offer.provider, raw } });
    const first = input.passengers[0];
    if (first === undefined) throw new Error('fixture sin pasajero');
    const second = {
      ...first,
      paxId: 'pax-2',
      requestedTravelerIndex: 1,
      givenName: 'Maria',
    };
    const wire = await book(
      {
        ...input,
        criteria: {
          ...input.criteria,
          paxCount: { adults: 2, children: 0, infants: 0 },
        },
        passengers: [second, first],
      },
      CONFIRMED_RESPONSE,
    );
    const travelers = wire.body['travelers'] as Array<Record<string, unknown>>;
    expect(travelers.map((traveler) => traveler['id'])).toEqual(['Passenger1', 'Passenger2']);
    expect(travelers.map((traveler) => traveler['givenName'])).toEqual(['Juanito', 'Maria']);
  });

  it('binding duplicado o incompleto no autoriza Create Booking', async () => {
    const offer = ndcOffer();
    const raw = {
      ...(offer.provider.raw ?? {}),
      [SABRE_RAW_KEYS.pricePassengerIds]: ['Passenger1', 'Passenger2'],
      [SABRE_RAW_KEYS.pricePassengerBindings]: [
        {
          pricePassengerId: 'Passenger1',
          requestedTravelerIndex: 0,
          paxType: 'ADT',
          requestedPtc: 'ADT',
          pricedPtc: 'ADT',
        },
        {
          pricePassengerId: 'Passenger2',
          requestedTravelerIndex: 0,
          paxType: 'ADT',
          requestedPtc: 'ADT',
          pricedPtc: 'ADT',
        },
      ],
    };
    const input = request({ ...offer, provider: { ...offer.provider, raw } });
    const first = input.passengers[0];
    if (first === undefined) throw new Error('fixture sin pasajero');
    await expect(
      book(
        {
          ...input,
          criteria: {
            ...input.criteria,
            paxCount: { adults: 2, children: 0, infants: 0 },
          },
          passengers: [first, { ...first, paxId: 'pax-2', requestedTravelerIndex: 1 }],
        },
        CONFIRMED_RESPONSE,
      ),
    ).rejects.toThrow(/ambiguo|no coincide/);
  });

  it('ATPCO revalidado con Flight Check reserva por flightDetails, como la colección, no por sus handles', async () => {
    // CERT (H-06, docs/sabre/12 §3): `flightOffer` con la oferta de Flight Check pasa la validación
    // y cae en DOWNLINE_SERVICE_ERROR con JA y con LA.
    const wire = await book(request(flightCheckedOffer()), CONFIRMED_RESPONSE, {
      ticketing: {},
    });

    expect(wire.body['flightOffer']).toBeUndefined();
    expect(wire.raw).not.toContain('checked-offer-1');
    const details = wire.body['flightDetails'] as Record<string, unknown>;
    expect(details['flightPricing']).toEqual([{}]);
    expect(flightsOf(wire)).toHaveLength(1);
    const travelers = wire.body['travelers'] as Array<Record<string, unknown>>;
    expect(travelers[0]).not.toHaveProperty('id');
    // Por `flightDetails` la política de emisión sí viaja (verificado en la colección, 04 §7.6).
    expect(agencyOf(wire)['ticketingPolicy']).toBe('TICKETING_TIME_LIMIT');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. La tolerancia se elige por caso de uso, viaja, y vuelve
// ---------------------------------------------------------------------------------------------

describe('caso de uso y tolerancia a fallo parcial', () => {
  it('sin caso de uso declarado nada es accesorio: HALT_ON_ERROR al cable', async () => {
    const wire = await book(request(ndcOffer()), CONFIRMED_RESPONSE);

    expect(wire.raw).toContain('"errorHandlingPolicy":["HALT_ON_ERROR"]');
    expect(wire.outcome.useCase).toBe(SABRE_DEFAULT_BOOKING_USE_CASE);
    expect(wire.outcome.partialFailureTolerance).toEqual([]);
  });

  it('FLIGHT_WITH_EXTRAS manda las dos políticas del extra y ninguna más', async () => {
    const wire = await book(request(ndcOffer()), CONFIRMED_RESPONSE, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    expect(wire.body['errorHandlingPolicy']).toEqual([
      'DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR',
      'DO_NOT_HALT_ON_SEAT_BOOKING_ERROR',
    ]);
    // Lo que NUNCA puede salir por este puerto: tolerar el fallo de la cotización deja el PNR sin
    // price quote, y el precio es aquello de lo que la compra depende.
    expect(wire.raw).not.toContain('DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR');
    expect(wire.raw).not.toContain('DO_NOT_HALT_ON_IDENTITY_DOCUMENT_WARNING');
    expect(wire.raw).not.toContain('DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR');
    expect(wire.raw).not.toContain('DO_NOT_HALT_ON_CAR_BOOKING_ERROR');
  });

  it('ningún caso de uso puede tolerar PRICING ni el aviso de documento', () => {
    for (const useCase of SABRE_BOOKING_USE_CASES) {
      const tolerance: readonly string[] = SABRE_TOLERANCE_BY_USE_CASE[useCase];
      expect(tolerance).not.toContain('PRICING');
      expect(tolerance).not.toContain('IDENTITY_DOC_WARNING');
    }
  });

  it('un caso de uso que no existe no compila, y desde JavaScript se rechaza', async () => {
    // @ts-expect-error el caso de uso es un enum cerrado: 'PAQUETE' no es uno de ellos
    const noCompila: SabreBookingUseCase = 'PAQUETE';
    expect(noCompila).toBe('PAQUETE');

    // Y falla con el error TIPADO del adapter, no con un `TypeError` de indexar un objeto: el
    // mensaje nombra el campo y enumera los casos legales.
    await expect(
      book(request(ndcOffer()), CONFIRMED_RESPONSE, {
        useCase: 'PAQUETE' as SabreBookingUseCase,
      }),
    ).rejects.toThrow(OrderCreateNotSentError);
  });

  it('la decisión vuelve en el resultado y en el provider_raw, para que el domain_event la cite', async () => {
    const wire = await book(request(ndcOffer()), CONFIRMED_RESPONSE, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    expect(wire.outcome.useCase).toBe('FLIGHT_WITH_EXTRAS');
    expect(wire.outcome.partialFailureTolerance).toEqual(['ANCILLARY', 'SEAT']);
    expect(wire.outcome.providerRaw['useCase']).toBe('FLIGHT_WITH_EXTRAS');
    expect(wire.outcome.providerRaw['partialFailureTolerance']).toEqual(['ANCILLARY', 'SEAT']);
    expect(wire.outcome.providerRaw['errorHandlingPolicy']).toEqual([
      'DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR',
      'DO_NOT_HALT_ON_SEAT_BOOKING_ERROR',
    ]);
    expect(wire.outcome.providerRaw['dependencyFailed']).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Un fallo de accesorio NUNCA cancela el producto
// ---------------------------------------------------------------------------------------------

describe('veredicto de fallo parcial', () => {
  it('el asiento falla y el vuelo queda: la compra NO se compensa', async () => {
    const wire = await book(request(ndcOffer()), SEAT_FAILED_RESPONSE, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    expect(wire.outcome.result.outcome).toBe('PARTIAL');
    expect(wire.outcome.result.pnr).toBe('PYMUEZ');
    expect(wire.outcome.failures.accessoryFailures).toEqual(['seat']);
    expect(wire.outcome.failures.dependencyFailures).toEqual([]);
    // La afirmación que sostiene la regla: cancelar aquí dejaría al cliente sin viaje por un extra.
    expect(wire.outcome.failures.dependencyFailed).toBe(false);
  });

  it('el MISMO asiento fallido con FLIGHT_ONLY sí obliga a compensar: nada era accesorio', async () => {
    const wire = await book(request(ndcOffer()), SEAT_FAILED_RESPONSE, { useCase: 'FLIGHT_ONLY' });

    // La sonda: el veredicto depende de lo que se ELIGIÓ, no de lo que devolvió el proveedor. Si
    // el caso de uso no cambiara nada, estas dos afirmaciones no podrían diferir de las de arriba.
    expect(wire.outcome.failures.accessoryFailures).toEqual([]);
    expect(wire.outcome.failures.dependencyFailures).toEqual(['seat']);
    expect(wire.outcome.failures.dependencyFailed).toBe(true);
  });

  it('un vuelo cancelado es una dependencia, y ningún caso de uso lo vuelve accesorio', async () => {
    for (const useCase of SABRE_BOOKING_USE_CASES) {
      const wire = await book(request(ndcOffer()), FLIGHT_FAILED_RESPONSE, { useCase });
      expect(wire.outcome.failures.dependencyFailures).toEqual(['flight']);
      expect(wire.outcome.failures.dependencyFailed).toBe(true);
    }
  });

  it('una reserva confirmada no dispara nada', async () => {
    const wire = await book(request(ndcOffer()), CONFIRMED_RESPONSE, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    expect(wire.outcome.result.outcome).toBe('CONFIRMED');
    expect(wire.outcome.failures).toEqual({
      accessoryFailures: [],
      dependencyFailures: [],
      dependencyFailed: false,
      hasUnattributedErrors: false,
    });
  });

  it('errores que no marcan ningún ítem no se atribuyen: se señalan, no se compensan a ciegas', async () => {
    const wire = await book(
      request(ndcOffer()),
      {
        confirmationId: 'PYMUEZ',
        booking: { bookingId: 'PYMUEZ' },
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_BOOK_SEATS_NOT_AVAILABLE' }],
      },
      { useCase: 'FLIGHT_WITH_EXTRAS' },
    );

    expect(wire.outcome.result.outcome).toBe('PARTIAL');
    // No se inventa una atribución: el veredicto dice «no lo sé» en vez de decidir por su cuenta.
    expect(wire.outcome.failures.dependencyFailed).toBe(false);
    expect(wire.outcome.failures.hasUnattributedErrors).toBe(true);
    expect(wire.outcome.providerRaw['hasUnattributedErrors']).toBe(true);
  });

  it('UNCONFIRMED no es FAILED: una lista de espera no cuenta como fallo de nada', () => {
    const result: OrderCreateResult = {
      outcome: 'PARTIAL',
      items: [
        { kind: 'flight', status: 'UNCONFIRMED', statusCode: 'HL' },
        { kind: 'seat', status: 'UNCONFIRMED' },
      ],
      issues: [],
    };

    expect(classifySabrePartialFailure(result, ['SEAT'])).toEqual({
      accessoryFailures: [],
      dependencyFailures: [],
      dependencyFailed: false,
      hasUnattributedErrors: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Lo que el provider_raw puede llevar
// ---------------------------------------------------------------------------------------------

describe('provider_raw', () => {
  it('el veredicto y la decisión son vocabulario cerrado: ni PII ni texto libre del proveedor', async () => {
    const wire = await book(request(ndcOffer()), SEAT_FAILED_RESPONSE, {
      useCase: 'FLIGHT_WITH_EXTRAS',
    });

    const raw = JSON.stringify(wire.outcome.providerRaw);
    // Los datos del pasajero que SÍ viajaron en el request no vuelven al evento.
    expect(raw).not.toContain('Juanito');
    expect(raw).not.toContain('Perezosa');
    expect(raw).not.toContain('XZ9871');
    expect(raw).not.toContain('centinela.pax@ejemplo.test');
    // Ni la descripción libre que mandó Sabre con el error del asiento.
    expect(raw).not.toContain('One or some of the seats');
    expect(wire.outcome.providerRaw['accessoryFailures']).toEqual(['seat']);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Política y plazo de emisión (SAB-06)
// ---------------------------------------------------------------------------------------------

/** Reloj fijo de los casos de emisión: martes 13 de octubre de 2026, 12:00 UTC (07:00 en Bogotá). */
const AHORA = new Date('2026-10-13T12:00:00.000Z');
const reloj: SabreOrderCreateDeps = { now: () => AHORA };

/** ATPCO revalidado por Flight Check, con el plazo de pago que guardó el mapper (UTC). */
function flightCheckedOfferWithDeadline(paymentTimeLimit: string): Offer {
  const base = flightCheckedOffer();
  return {
    ...base,
    provider: {
      ...base.provider,
      raw: {
        ...base.provider.raw,
        [SABRE_FLIGHT_CHECK_RAW_KEYS.paymentTimeLimit]: paymentTimeLimit,
      },
    },
  };
}

function agencyOf(wire: Wire): Record<string, unknown> {
  const agency = wire.body['agency'];
  if (agency === undefined || agency === null || typeof agency !== 'object') {
    throw new Error('el body no llevó bloque agency');
  }
  return agency as Record<string, unknown>;
}

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, lines };
}

describe('política y plazo de emisión', () => {
  it('con plazo: el carril verificado sin tarjeta —CASH más TICKETING_TIME_LIMIT— llega al cable', async () => {
    // El plazo de Flight Check es el 15 a las 03:00 UTC; menos 2 h de margen son las 01:00 UTC del
    // 15, que en Bogotá (UTC-5) son las 20:00 del 14. El cambio de día es la sonda: con la hora UTC
    // el plazo saldría un día tarde.
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: {}, receivedFrom: 'PLANETOUR' },
      { deps: reloj },
    );

    // La forma del ejemplo verificado de punta a punta (docs/sabre/04 §7.6): ni más ni menos.
    expect(agencyOf(wire)).toEqual({
      ticketingPolicy: 'TICKETING_TIME_LIMIT',
      ticketingTimeLimitPolicy: {
        airlineCode: 'AV',
        ticketingDate: '2026-10-14',
        ticketingTime: '20:00',
      },
    });
    expect(wire.body['payment']).toEqual({ formsOfPayment: [{ type: 'CASH' }] });
    expect(wire.body['receivedFrom']).toBe('PLANETOUR');
    expect(wire.outcome.ticketing).toEqual({
      policy: 'TICKETING_TIME_LIMIT',
      requestedPolicy: 'TICKETING_TIME_LIMIT',
      deadline: {
        date: '2026-10-14',
        time: '20:00',
        pccTimeZone: 'America/Bogota',
        source: 'PROVIDER',
      },
    });
  });

  it('el margen y la zona son los de la cuenta, no constantes del adapter', async () => {
    // 23:59:30 UTC del 14 menos 6 h = 17:59:30 UTC = 12:59 en Lima (UTC-5) y 19:59 en Madrid
    // (UTC+2 en octubre). Los segundos se truncan: 12:59, nunca 13:00.
    const offer = flightCheckedOfferWithDeadline('2026-10-14T23:59:30.000Z');
    const lima = await book(
      request(offer),
      CONFIRMED_RESPONSE,
      { ticketing: { leadHours: 6, pccTimeZone: 'America/Lima' } },
      { deps: reloj },
    );
    const madrid = await book(
      request(offer),
      CONFIRMED_RESPONSE,
      { ticketing: { leadHours: 6, pccTimeZone: 'Europe/Madrid' } },
      { deps: reloj },
    );

    expect(agencyOf(lima)['ticketingTimeLimitPolicy']).toMatchObject({
      ticketingDate: '2026-10-14',
      ticketingTime: '12:59',
    });
    expect(agencyOf(madrid)['ticketingTimeLimitPolicy']).toMatchObject({
      ticketingDate: '2026-10-14',
      ticketingTime: '19:59',
    });
  });

  it('sin margen pedido, el plazo es el del proveedor', async () => {
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: { leadHours: 0 } },
      { deps: reloj },
    );
    expect(agencyOf(wire)['ticketingTimeLimitPolicy']).toMatchObject({
      ticketingDate: '2026-10-14',
      ticketingTime: '22:00',
    });
  });

  it('si el margen no cabe, se pide el plazo del proveedor y no uno ya vencido', async () => {
    // Plazo en una hora, margen de dos: plazo menos margen ya pasó. Pedirlo vencería la reserva al
    // crearla; se pide el del proveedor y se dice de dónde salió.
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-13T13:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: { leadHours: 2 } },
      { deps: reloj },
    );
    expect(agencyOf(wire)['ticketingTimeLimitPolicy']).toMatchObject({
      ticketingDate: '2026-10-13',
      ticketingTime: '08:00',
    });
    expect(wire.outcome.ticketing?.deadline?.source).toBe('PROVIDER_NO_MARGIN');
  });

  it.each([
    ['vencido hace un minuto', '2026-10-13T11:59:00.000Z'],
    ['que vence justo ahora', '2026-10-13T12:00:00.000Z'],
  ])(
    'un plazo del proveedor %s no sale: el PNR nacería sin tiempo para emitir',
    async (_c, plazo) => {
      // Por la puerta pública y contando lo que llega a `fetch`: «no sale» es que no hubo POST.
      const calls: string[] = [];
      const cfg = config();
      const http = new SabreHttpClient(cfg, tokens, {
        fetch: (url) => {
          calls.push(url);
          return Promise.resolve(new Response(JSON.stringify(CONFIRMED_RESPONSE), { status: 200 }));
        },
        uuid: () => 'conv-fijo',
      });
      const adapter = new SabreOrderCreateAdapter(cfg, http, reloj);

      const thrown = await adapter
        .createBooking(
          request(flightCheckedOfferWithDeadline(plazo)),
          { tenantId: TENANT_ID, requestId: 'req-1' },
          { ticketing: {} },
        )
        .catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
      expect((thrown as Error).message).toContain('ya venció');
      expect(calls).toEqual([]);
    },
  );

  it('sin plazo del proveedor y con el vuelo antes de 24 h, el plazo es la salida menos el margen', async () => {
    // Sale a las 20:00 de Bogotá del mismo día (01:00 UTC del 14). Ahora + 24 h serían las 07:00
    // del 14, con el avión ya en el aire: se pide la salida menos 2 h, las 18:00 del 13.
    const base = atpcoOffer();
    const wire = await book(
      request({
        ...base,
        itineraries: [
          {
            segments: [segment({ departureAt: '2026-10-13T20:00:00-05:00' })],
            totalDurationMinutes: 170,
            stops: 0,
          },
        ],
      }),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: reloj },
    );
    expect(agencyOf(wire)['ticketingTimeLimitPolicy']).toMatchObject({
      ticketingDate: '2026-10-13',
      ticketingTime: '18:00',
    });
    expect(wire.outcome.ticketing?.deadline?.source).toBe('FALLBACK_BEFORE_DEPARTURE');
  });

  it('sin plazo del proveedor y con el vuelo dentro del margen, el plazo es la salida', async () => {
    // Sale a las 08:00 de Bogotá (13:00 UTC), una hora después de ahora: el margen de 2 h no cabe.
    const base = atpcoOffer();
    const wire = await book(
      request({
        ...base,
        itineraries: [
          {
            segments: [segment({ departureAt: '2026-10-13T08:00:00-05:00' })],
            totalDurationMinutes: 170,
            stops: 0,
          },
        ],
      }),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: reloj },
    );
    expect(wire.outcome.ticketing?.deadline).toMatchObject({
      date: '2026-10-13',
      time: '08:00',
      source: 'FALLBACK_BEFORE_DEPARTURE',
    });
  });

  it('sin plazo del proveedor y con el vuelo después de 24 h, el plazo sigue siendo ahora + 24 h', async () => {
    const base = atpcoOffer();
    const wire = await book(
      request({
        ...base,
        itineraries: [
          {
            segments: [segment({ departureAt: '2026-10-20T09:15:00-05:00' })],
            totalDurationMinutes: 170,
            stops: 0,
          },
        ],
      }),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: reloj },
    );
    expect(wire.outcome.ticketing?.deadline).toMatchObject({
      date: '2026-10-14',
      time: '07:00',
      source: 'FALLBACK_WINDOW',
    });
  });

  it('sin plazo del proveedor, ahora + 24 h en la hora de la oficina', async () => {
    const wire = await book(
      request(atpcoOffer()),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: { now: () => new Date('2026-10-13T12:34:56.000Z') } },
    );
    expect(agencyOf(wire)['ticketingTimeLimitPolicy']).toEqual({
      airlineCode: 'AV',
      ticketingDate: '2026-10-14',
      ticketingTime: '07:34',
    });
    expect(wire.outcome.ticketing?.deadline?.source).toBe('FALLBACK_WINDOW');
  });

  it('un plazo sin zona no se convierte: cuenta como «sin plazo»', async () => {
    // Una hora sin offset es la de algún reloj que no conocemos; inventarle la zona sería pedir
    // otra hora como plazo.
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-14T20:00:00')),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: reloj },
    );
    expect(wire.outcome.ticketing?.deadline).toMatchObject({
      date: '2026-10-14',
      time: '07:00',
      source: 'FALLBACK_WINDOW',
    });
  });

  it('NDC toma el plazo de offers/price, con su offset', async () => {
    const offer = ndcOffer();
    const wire = await book(
      request({
        ...offer,
        provider: {
          ...offer.provider,
          raw: {
            ...offer.provider.raw,
            // 18:30 en São Paulo (UTC-3) = 21:30 UTC = 16:30 en Bogotá; menos 2 h, 14:30.
            [SABRE_NDC_PAYMENT_TIME_LIMIT_RAW_KEY]: '2026-10-14T18:30:00-03:00',
          },
        },
      }),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: reloj },
    );
    expect(agencyOf(wire)).toEqual({
      ticketingPolicy: 'TICKETING_TIME_LIMIT',
      ticketingTimeLimitPolicy: {
        airlineCode: 'AV',
        ticketingDate: '2026-10-14',
        ticketingTime: '14:30',
      },
    });
  });

  it('la llave NDC es la que de verdad escribe el mapper de offers/price', () => {
    // Sin esto, renombrar la llave en el mapper dejaría a NDC siempre en «sin plazo» con los
    // tests de arriba en verde, porque construyen la oferta a mano.
    const payload = structuredClone(priceFixture) as {
      response: { offers: Array<Record<string, unknown>> };
    };
    const first = payload.response.offers[0];
    if (first === undefined) throw new Error('fixture sin ofertas');
    first['paymentTimeLimitDateTime'] = '2024-12-12T23:59:00Z';
    const mapped = mapSabrePriceResponse(payload, {
      tenantId: TENANT_ID,
      fetchedAt: '2024-12-12T02:45:00.000Z',
      requestedTravelers: [
        {
          requestPassengerId: 'Passenger1',
          requestedTravelerIndex: 0,
          paxType: 'ADT',
          requestedPtc: 'ADT',
        },
      ],
    });
    const priced = mapped.priced[0];
    if (priced === undefined) throw new Error('el mapper no revalidó la oferta');

    const cfg = config();
    const adapter = new SabreOrderCreateAdapter(
      cfg,
      new SabreHttpClient(cfg, tokens, { fetch: () => Promise.reject(new Error('sin red')) }),
      { now: () => new Date('2024-12-12T02:45:00.000Z') },
    );
    const plan = adapter.plan(request(priced.offer), { ticketing: {} });

    // 23:59 UTC menos 2 h = 21:59 UTC = 16:59 en Bogotá.
    expect(plan.ticketing?.deadline).toEqual({
      date: '2024-12-12',
      time: '16:59',
      pccTimeZone: 'America/Bogota',
      source: 'PROVIDER',
    });
  });

  it('la aerolínea del plazo es la validadora de la tarifa cuando la oferta la trae', async () => {
    const offer = flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z');
    const wire = await book(
      request({
        ...offer,
        provider: {
          ...offer.provider,
          raw: { ...offer.provider.raw, validatingCarrierCode: 'LA' },
        },
      }),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: reloj },
    );
    expect(agencyOf(wire)['ticketingTimeLimitPolicy']).toMatchObject({ airlineCode: 'LA' });
  });

  it('emisión futura: la reserva queda para el PCC de emisión de la cuenta, sin plazo propio', async () => {
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: { policy: 'FUTURE_TICKETING' } },
      { cfg: { ticketingPcc: 'T1CK' }, deps: reloj },
    );

    expect(agencyOf(wire)).toEqual({
      ticketingPolicy: 'FUTURE_TICKETING',
      futureTicketingPolicy: { ticketingPcc: 'T1CK' },
    });
    expect(wire.outcome.ticketing).toEqual({
      policy: 'FUTURE_TICKETING',
      requestedPolicy: 'FUTURE_TICKETING',
    });
    // El PCC viaja al proveedor, que es su destino; a la orden no.
    expect(JSON.stringify(wire.outcome.providerRaw)).not.toContain('T1CK');
    expect(wire.outcome.providerRaw['ticketingPolicy']).toBe('FUTURE_TICKETING');
  });

  it('emisión futura con el PCC de emisión tecleado en minúsculas: sale en mayúsculas', async () => {
    // La bóveda sólo exige 3 o 4 caracteres. Sin normalizar, el builder rechaza el patrón del
    // contrato y la cuenta no podría reservar nada.
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: { policy: 'FUTURE_TICKETING' } },
      { cfg: { ticketingPcc: ' t1ck ' }, deps: reloj },
    );
    expect(agencyOf(wire)).toEqual({
      ticketingPolicy: 'FUTURE_TICKETING',
      futureTicketingPolicy: { ticketingPcc: 'T1CK' },
    });
  });

  it('emisión futura con un PCC de emisión fuera del contrato cae a «con plazo» sin nombrarlo', async () => {
    const { logger, lines } = spyLogger();
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: { policy: 'FUTURE_TICKETING' } },
      { cfg: { ticketingPcc: 'Q-7X' }, deps: { ...reloj, logger } },
    );

    expect(agencyOf(wire)['ticketingPolicy']).toBe('TICKETING_TIME_LIMIT');
    expect(wire.outcome.ticketing).toMatchObject({
      policy: 'TICKETING_TIME_LIMIT',
      requestedPolicy: 'FUTURE_TICKETING',
      fallback: 'INVALID_TICKETING_PCC',
    });
    const aviso = lines.find((l) => l.message === 'sabre.createBooking.ticketingPolicyFallback');
    expect(aviso?.meta).toMatchObject({ reason: 'INVALID_TICKETING_PCC' });
    expect(JSON.stringify(lines)).not.toContain('Q-7X');
    expect(wire.raw).not.toContain('Q-7X');
    expect(JSON.stringify(wire.outcome.providerRaw)).not.toContain('Q-7X');
  });

  it('emisión futura sin PCC de emisión cae a «con plazo» y lo avisa sin nombrar oficinas', async () => {
    const { logger, lines } = spyLogger();
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: { policy: 'FUTURE_TICKETING' } },
      { deps: { ...reloj, logger } },
    );

    expect(agencyOf(wire)['ticketingPolicy']).toBe('TICKETING_TIME_LIMIT');
    expect(agencyOf(wire)).not.toHaveProperty('futureTicketingPolicy');
    expect(wire.outcome.ticketing).toMatchObject({
      policy: 'TICKETING_TIME_LIMIT',
      requestedPolicy: 'FUTURE_TICKETING',
      fallback: 'NO_TICKETING_PCC',
    });
    expect(wire.outcome.providerRaw['ticketingPolicyFallback']).toBe('NO_TICKETING_PCC');

    const aviso = lines.find((l) => l.message === 'sabre.createBooking.ticketingPolicyFallback');
    expect(aviso?.level).toBe('warn');
    expect(aviso?.meta).toMatchObject({
      requestedPolicy: 'FUTURE_TICKETING',
      appliedPolicy: 'TICKETING_TIME_LIMIT',
      reason: 'NO_TICKETING_PCC',
    });
    const creacion = lines.find((l) => l.message === 'sabre.createBooking');
    expect(creacion?.meta).toMatchObject({
      ticketingPolicy: 'TICKETING_TIME_LIMIT',
      ticketingPolicyFallback: 'NO_TICKETING_PCC',
      ticketingDeadlineSource: 'PROVIDER',
    });
    expect(JSON.stringify(lines)).not.toContain('ZZZZ');
  });

  it('el provider_raw cita la política y el plazo pedido, en vocabulario cerrado', async () => {
    const wire = await book(
      request(flightCheckedOfferWithDeadline('2026-10-15T03:00:00.000Z')),
      CONFIRMED_RESPONSE,
      { ticketing: {} },
      { deps: reloj },
    );
    expect(wire.outcome.providerRaw['ticketingPolicy']).toBe('TICKETING_TIME_LIMIT');
    expect(wire.outcome.providerRaw['ticketingDeadline']).toEqual({
      date: '2026-10-14',
      time: '20:00',
      pccTimeZone: 'America/Bogota',
      source: 'PROVIDER',
    });
    expect(wire.outcome.providerRaw).not.toHaveProperty('ticketingPolicyFallback');
  });

  it('dos fuentes para la política se rechazan antes de la red', async () => {
    const thrown = await book(request(atpcoOffer()), CONFIRMED_RESPONSE, {
      ticketing: {},
      agency: { ticketingPolicy: 'TODAY' },
    }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
    expect((thrown as Error).message).toContain('una sola fuente');
  });

  it('una configuración inválida no sale: nombra los campos, nunca los valores', async () => {
    const thrown = await book(request(atpcoOffer()), CONFIRMED_RESPONSE, {
      ticketing: { leadHours: 99, pccTimeZone: 'Marte/Base_Alfa' },
    }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
    const message = (thrown as Error).message;
    expect(message).toContain('leadHours');
    expect(message).toContain('pccTimeZone');
    expect(message).not.toContain('Marte');
    expect(message).not.toContain('99');
  });

  it('sin `ticketing` no se inventa una política: el bloque agency no sale', async () => {
    const wire = await book(request(atpcoOffer()), CONFIRMED_RESPONSE);
    expect(wire.body).not.toHaveProperty('agency');
    expect(wire.outcome).not.toHaveProperty('ticketing');
    expect(wire.outcome.providerRaw).not.toHaveProperty('ticketingPolicy');
  });

  it('otros campos de agency conviven con la política de la cuenta', async () => {
    const wire = await book(
      request(atpcoOffer()),
      CONFIRMED_RESPONSE,
      { ticketing: {}, agency: { contactInfo: { emails: ['agencia@ejemplo.test'] } } },
      { deps: reloj },
    );
    expect(agencyOf(wire)).toMatchObject({
      contactInfo: { emails: ['agencia@ejemplo.test'] },
      ticketingPolicy: 'TICKETING_TIME_LIMIT',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// SAB-16 — asientos al reservar
// ---------------------------------------------------------------------------------------------

/** Dos tramos ATPCO sin Flight Check: el bloque `flightDetails`, un vuelo por tramo. */
function atpcoTwoSegments(): Offer {
  const base = atpcoOffer();
  return {
    ...base,
    itineraries: [
      {
        segments: [
          segment(),
          segment({
            flightNumber: '0081',
            origin: 'LIM',
            destination: 'CUZ',
            departureAt: '2026-09-14T14:00:00-05:00',
            arrivalAt: '2026-09-14T15:20:00-05:00',
            durationMinutes: 80,
          }),
        ],
        totalDurationMinutes: 365,
        stops: 1,
      },
    ],
  };
}

/** Dos adultos y un infante: el formulario los manda en otro orden que la búsqueda. */
function withFamily(input: OrderCreateRequest): OrderCreateRequest {
  const adult = input.passengers[0];
  if (adult === undefined) throw new Error('fixture sin pasajero');
  const second = { ...adult, paxId: 'pax-2', requestedTravelerIndex: 1, givenName: 'Maria' };
  const infant = {
    ...adult,
    paxId: 'pax-3',
    requestedTravelerIndex: 2,
    paxType: 'INF' as const,
    givenName: 'Lucia',
    birthdate: '2026-01-10',
  };
  return {
    ...input,
    criteria: { ...input.criteria, paxCount: { adults: 2, children: 0, infants: 1 } },
    passengers: [second, adult, infant],
  };
}

type SeatPedido = NonNullable<OrderCreateRequest['seats']>[number];

function seatRequest(over: Partial<SeatPedido> = {}): SeatPedido {
  return { passengerIndex: 0, segmentRef: 0, legIndex: 0, row: 12, column: 'C', ...over };
}

/** La reserva confirmada con los asientos que se le pasen en su vuelo. */
function confirmedWithSeats(seats: readonly unknown[]): Record<string, unknown> {
  return {
    confirmationId: 'PYMUEZ',
    booking: {
      bookingId: 'PYMUEZ',
      flights: [{ itemId: 'F1', flightStatusCode: 'HK', flightStatusName: 'Confirmed', seats }],
    },
  };
}

function flightsOf(wire: Wire): Array<Record<string, unknown>> {
  return (wire.body['flightDetails'] as { flights: Array<Record<string, unknown>> }).flights;
}

describe('SAB-16 — los asientos viajan en el bloque de la reserva', () => {
  it('flightDetails: cada asiento en SU vuelo, por número y viajero, sin id de oferta', async () => {
    const input = withFamily(request(atpcoTwoSegments()));
    const wire = await book(
      {
        ...input,
        seats: [
          seatRequest({ passengerIndex: 0, segmentRef: 0, row: 12, column: 'C' }),
          seatRequest({ passengerIndex: 1, segmentRef: 0, row: 12, column: 'D' }),
          seatRequest({ passengerIndex: 0, segmentRef: 1, row: 4, column: 'A', offerRef: 'x-1' }),
        ],
      },
      CONFIRMED_RESPONSE,
    );

    const flights = flightsOf(wire);
    // El formulario mandó a María primero: el viajero sale de requestedTravelerIndex, no del orden.
    expect(flights[0]?.['seats']).toEqual([
      { number: '12C', travelerIndex: 2 },
      { number: '12D', travelerIndex: 1 },
    ]);
    expect(flights[1]?.['seats']).toEqual([{ number: '4A', travelerIndex: 2 }]);
    expect(wire.raw).not.toContain('seatOfferId');
    expect(wire.raw).not.toContain('changeOfGaugeSeats');
  });

  it('con asientos el caso de uso es FLIGHT_WITH_EXTRAS: un asiento caído no tumba el vuelo', async () => {
    const wire = await book(
      { ...request(atpcoOffer()), seats: [seatRequest()] },
      confirmedWithSeats([{ number: '12C', statusCode: 'HK', statusName: 'Confirmed' }]),
    );
    expect(wire.body['errorHandlingPolicy']).toContain('DO_NOT_HALT_ON_SEAT_BOOKING_ERROR');
    expect(wire.outcome.useCase).toBe('FLIGHT_WITH_EXTRAS');
    expect(wire.outcome.seats).toEqual({ requested: 1, notConfirmed: 0 });
    expect(wire.outcome.result.outcome).toBe('CONFIRMED');
  });

  it('sin asientos nada cambia: FLIGHT_ONLY y HALT_ON_ERROR, como antes', async () => {
    const wire = await book({ ...request(atpcoOffer()), seats: [] }, CONFIRMED_RESPONSE);
    expect(wire.body['errorHandlingPolicy']).toEqual(['HALT_ON_ERROR']);
    expect(wire.outcome.useCase).toBe('FLIGHT_ONLY');
    expect(wire.raw).not.toContain('"seats"');
    expect(wire.outcome.providerRaw).not.toHaveProperty('seatsRequested');
  });

  it('el caso de uso declarado manda sobre el que sugieren los asientos', async () => {
    const wire = await book(
      { ...request(atpcoOffer()), seats: [seatRequest()] },
      CONFIRMED_RESPONSE,
      { useCase: 'FLIGHT_ONLY' },
    );
    expect(wire.body['errorHandlingPolicy']).toEqual(['HALT_ON_ERROR']);
  });

  it('cambio de equipo en flightDetails: el segundo avión va en changeOfGaugeSeats', async () => {
    const wire = await book(
      {
        ...request(atpcoOffer()),
        seats: [seatRequest({ legIndex: 0 }), seatRequest({ legIndex: 1, row: 30, column: 'C' })],
      },
      CONFIRMED_RESPONSE,
    );
    const flight = flightsOf(wire)[0];
    expect(flight?.['seats']).toEqual([{ number: '12C', travelerIndex: 1 }]);
    expect(flight?.['changeOfGaugeSeats']).toEqual([{ number: '30C', travelerIndex: 1 }]);
  });

  it('cambio de equipo con asiento en un solo avión no sale: Sabre exige los dos', async () => {
    await expect(
      book(
        { ...request(atpcoOffer()), seats: [seatRequest({ legIndex: 1, row: 30 })] },
        CONFIRMED_RESPONSE,
      ),
    ).rejects.toThrow(OrderCreateNotSentError);
  });

  it('ATPCO revalidado con Flight Check: el asiento va por número en flights[].seats', async () => {
    const wire = await book(
      { ...request(flightCheckedOffer()), seats: [seatRequest({ offerRef: 'seat-offer-12c' })] },
      CONFIRMED_RESPONSE,
    );
    expect(wire.body['flightOffer']).toBeUndefined();
    expect(flightsOf(wire)[0]?.['seats']).toEqual([{ number: '12C', travelerIndex: 1 }]);
  });

  it('flightOffer (NDC): el viajero es el del binding de price', async () => {
    const wire = await book(
      { ...request(ndcOffer()), seats: [seatRequest({ offerRef: 'ndc-seat-1' })] },
      CONFIRMED_RESPONSE,
    );
    expect((wire.body['flightOffer'] as Record<string, unknown>)['seatOffers']).toEqual([
      { seatOfferId: 'ndc-seat-1', number: '12C', travelerIndex: 1 },
    ]);
  });
});

describe('SAB-16 — lo que no se puede pedir no sale al cable', () => {
  async function refused(input: OrderCreateRequest): Promise<unknown> {
    return book(input, CONFIRMED_RESPONSE).catch((err: unknown) => err);
  }

  it('un asiento de flightOffer sin la oferta del asiento del mapa', async () => {
    const thrown = await refused({ ...request(ndcOffer()), seats: [seatRequest()] });
    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
    expect((thrown as Error).message).toMatch(/seatOfferId/);
  });

  it('el segundo avión de un cambio de equipo en flightOffer, que no tiene campo', async () => {
    const thrown = await refused({
      ...request(ndcOffer()),
      seats: [
        seatRequest({ offerRef: 'a-1' }),
        seatRequest({ legIndex: 1, row: 30, offerRef: 'a-2' }),
      ],
    });
    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
  });

  it('un infante en brazos, que no ocupa asiento', async () => {
    const thrown = await refused({
      ...withFamily(request(atpcoOffer())),
      seats: [seatRequest({ passengerIndex: 2 })],
    });
    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
    expect((thrown as Error).message).toMatch(/infante/);
  });

  it('un pasajero que la reserva no tiene', async () => {
    const thrown = await refused({
      ...request(atpcoOffer()),
      seats: [seatRequest({ passengerIndex: 4 })],
    });
    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
  });

  it('un tramo que la oferta no tiene', async () => {
    const thrown = await refused({
      ...request(atpcoOffer()),
      seats: [seatRequest({ segmentRef: 1 })],
    });
    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
  });

  it('dos asientos para el mismo pasajero en el mismo avión, o el mismo asiento dos veces', async () => {
    const family = withFamily(request(atpcoOffer()));
    for (const seats of [
      [seatRequest(), seatRequest({ column: 'D' })],
      [seatRequest({ passengerIndex: 0 }), seatRequest({ passengerIndex: 1 })],
    ]) {
      expect(await refused({ ...family, seats })).toBeInstanceOf(OrderCreateNotSentError);
    }
  });

  it('una fila o una columna que no forman un número de asiento', async () => {
    for (const seat of [seatRequest({ row: 0 }), seatRequest({ column: 'cc' })]) {
      const thrown = await refused({ ...request(atpcoOffer()), seats: [seat] });
      expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
    }
  });
});

describe('SAB-16 — cada asiento pedido tiene que volver', () => {
  it('confirmado sin el asiento pedido (SEAT_NOT_ALLOWED_FOR_BOOKING es un aviso): PARTIAL con el asiento FAILED', async () => {
    const wire = await book(
      { ...request(atpcoOffer()), seats: [seatRequest()] },
      {
        ...CONFIRMED_RESPONSE,
        errors: [{ category: 'WARNING', type: 'SEAT_NOT_ALLOWED_FOR_BOOKING' }],
      },
    );

    expect(wire.outcome.result.outcome).toBe('PARTIAL');
    expect(wire.outcome.result.items).toEqual([
      {
        kind: 'flight',
        providerItemId: 'F1',
        status: 'CONFIRMED',
        statusCode: 'HK',
        message: 'Confirmed',
      },
      { kind: 'seat', status: 'FAILED', seatNumber: '12C' },
    ]);
    expect(wire.outcome.seats).toEqual({ requested: 1, notConfirmed: 1 });
    // El vuelo no se compensa por el asiento: es accesorio en FLIGHT_WITH_EXTRAS.
    expect(wire.outcome.failures.dependencyFailed).toBe(false);
    expect(wire.outcome.result.compensation).toBeUndefined();
    expect(wire.outcome.providerRaw).toMatchObject({ seatsRequested: 1, seatsNotConfirmed: 1 });
  });

  it('el asiento devuelto con otro número tampoco cuenta como el pedido', async () => {
    const wire = await book(
      { ...request(atpcoOffer()), seats: [seatRequest()] },
      confirmedWithSeats([{ number: '14A', statusCode: 'HK', statusName: 'Confirmed' }]),
    );
    expect(wire.outcome.result.outcome).toBe('PARTIAL');
    expect(wire.outcome.result.items.filter((item) => item.kind === 'seat')).toEqual([
      {
        kind: 'seat',
        status: 'CONFIRMED',
        statusCode: 'HK',
        message: 'Confirmed',
        seatNumber: '14A',
      },
      { kind: 'seat', status: 'FAILED', seatNumber: '12C' },
    ]);
  });

  it('el asiento denegado por la aerolínea no se duplica: sale una vez, FAILED, con su número', async () => {
    const wire = await book(
      { ...request(atpcoOffer()), seats: [seatRequest({ row: 12, column: 'A' })] },
      SEAT_FAILED_RESPONSE,
    );
    expect(wire.outcome.result.items.filter((item) => item.kind === 'seat')).toEqual([
      {
        kind: 'seat',
        status: 'FAILED',
        statusCode: 'UC',
        message: 'Cancelled',
        seatNumber: '12A',
      },
    ]);
    expect(wire.outcome.seats).toEqual({ requested: 1, notConfirmed: 1 });
  });

  it('sin vuelos en la respuesta no hay con qué cruzar: lo resuelve la lectura de cierre', async () => {
    const wire = await book(
      { ...request(atpcoOffer()), seats: [seatRequest()] },
      { confirmationId: 'PYMUEZ' },
    );
    expect(wire.outcome.result.outcome).toBe('PENDING');
    expect(wire.outcome.result.items).toEqual([]);
  });

  it('el viajero del asiento devuelto se cruza por posición: el de otro pasajero no vale', async () => {
    const input = withFamily(request(atpcoOffer()));
    // Pedido para Juanito (posición 1 en travelers); la respuesta trae el 12C en la posición 0.
    const wire = await book(
      { ...input, seats: [seatRequest({ passengerIndex: 0 })] },
      confirmedWithSeats([{ number: '12C', statusCode: 'HK', statusName: 'Confirmed' }]),
    );
    expect(wire.outcome.result.outcome).toBe('PARTIAL');
    expect(wire.outcome.seats.notConfirmed).toBe(1);
  });

  it('el vuelo del asiento devuelto también se cruza: el 12C del otro tramo no es el pedido', async () => {
    // Pedido en el primer tramo; la respuesta trae los dos vuelos y el 12C colgando del segundo.
    const wire = await book(
      { ...request(atpcoTwoSegments()), seats: [seatRequest({ segmentRef: 0 })] },
      {
        confirmationId: 'PYMUEZ',
        booking: {
          bookingId: 'PYMUEZ',
          flights: [
            { itemId: 'F1', flightStatusCode: 'HK', flightStatusName: 'Confirmed' },
            {
              itemId: 'F2',
              flightStatusCode: 'HK',
              flightStatusName: 'Confirmed',
              seats: [{ number: '12C', statusCode: 'HK', statusName: 'Confirmed' }],
            },
          ],
        },
      },
    );
    expect(wire.outcome.result.outcome).toBe('PARTIAL');
    expect(wire.outcome.result.items.at(-1)).toEqual({
      kind: 'seat',
      status: 'FAILED',
      seatNumber: '12C',
    });
    expect(wire.outcome.seats.notConfirmed).toBe(1);
  });

  it('el rechazo del asiento sale atribuido al asiento; uno de otra cosa, no', async () => {
    // Es lo que lee el saga para cerrar «el vuelo sí, el asiento no» sin tapar un error del PNR.
    const wire = await book(
      { ...request(atpcoOffer()), seats: [seatRequest()] },
      {
        ...CONFIRMED_RESPONSE,
        errors: [
          { category: 'APPLICATION_ERROR', type: 'UNABLE_TO_BOOK_SEATS_NOT_AVAILABLE' },
          { category: 'APPLICATION_ERROR', type: 'DOWNLINE_SERVICE_ERROR' },
        ],
      },
    );
    expect(wire.outcome.result.issues.map((issue) => issue.itemKind)).toEqual(['seat', undefined]);
  });
});
