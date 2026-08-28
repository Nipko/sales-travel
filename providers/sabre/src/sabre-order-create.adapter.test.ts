import type { Offer, Segment } from '@sales-travel/canonical';
import type { OrderCreateRequest, OrderCreateResult, SearchContext } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SABRE_FLIGHT_CHECK_RAW_KEYS } from './flight-check/response.mapper';
import { SabreHttpClient } from './http/sabre-http.client';
import { SABRE_RAW_KEYS } from './price/request.builder';
import {
  SABRE_BOOKING_USE_CASES,
  SABRE_DEFAULT_BOOKING_USE_CASE,
  SABRE_PASSIVE_FLIGHT_STATUS_CODE,
  SABRE_TOLERANCE_BY_USE_CASE,
  SabreOrderCreateAdapter,
  SabreOrderCreateInputError,
  classifySabrePartialFailure,
  type SabreBookingUseCase,
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
): Promise<Wire> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: SabreFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
  };
  const cfg = config();
  const http = new SabreHttpClient(cfg, tokens, { fetch: fetchImpl, uuid: () => 'conv-fijo' });
  const adapter = new SabreOrderCreateAdapter(cfg, http);
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

  it('ATPCO revalidado reserva exactamente los handles de Flight Check', async () => {
    const wire = await book(request(flightCheckedOffer()), CONFIRMED_RESPONSE);

    expect(wire.body['flightDetails']).toBeUndefined();
    expect(wire.body['flightOffer']).toEqual({
      offerId: 'checked-offer-1',
      selectedOfferItems: ['checked-offer-1-1'],
    });
  });

  it('ATPCO con media cadena de Flight Check falla antes de salir al cable', async () => {
    const checked = flightCheckedOffer();
    const offer: Offer = {
      ...checked,
      provider: {
        ...checked.provider,
        raw: { [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferId]: 'checked-offer-1' },
      },
    };

    await expect(book(request(offer), CONFIRMED_RESPONSE)).rejects.toThrow(
      /mitad de la cadena de identificadores de Flight Check/,
    );
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
    ).rejects.toThrow(SabreOrderCreateInputError);
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
