import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from '../auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { SabreHttpClient } from '../http/sabre-http.client';
import {
  SABRE_ASYNC_UPDATE_WAIT_MS_DEFAULT,
  SABRE_ASYNC_UPDATE_WAIT_MS_MAX,
  SABRE_CARD_FORM_OF_PAYMENT_TYPE,
  SABRE_CREATE_BOOKING_PATH,
  SABRE_CREATE_ERROR_POLICIES,
  SABRE_DEFAULT_ERROR_POLICY,
  SABRE_FULFILL_ONLY_FORM_OF_PAYMENT_TYPES,
  SABRE_PANLESS_FORM_OF_PAYMENT_TYPES,
  SabreCreateBookingError,
  buildSabreCreateBookingRequest,
  resolveErrorHandlingPolicy,
  type SabreCreateBookingInput,
  type SabreCreateBookingOptions,
  type SabreFormOfPayment,
} from './create.request.builder';

/**
 * Los tests de este archivo son de un builder que **crea reservas**. Dos reglas de método:
 *
 * 1. Los de seguridad entran por la **puerta pública**: el anti-PAN se mide sobre el body
 *    SERIALIZADO que sale de `SabreHttpClient.postJson`, no sobre el objeto que devuelve el
 *    builder. Un JSON.stringify propio en el test mediría el test, no el cable.
 * 2. Los valores del payload son **centinelas únicos** para poder buscarlos dentro de cualquier
 *    mensaje de error y demostrar que no se filtran.
 */

const PII = {
  givenName: 'Juanito',
  surname: 'Perezosa',
  birthDate: '1980-12-02',
  documentNumber: 'XZ9871PASAPORTE',
  email: 'centinela.pax@ejemplo.test',
  phone: '+57-3001234567',
  loyaltyNumber: '998877665544',
} as const;

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    ...overrides,
  };
}

/** Un NDC mínimo y legal: es el carril con menos campos obligatorios. */
function ndcInput(overrides: Partial<SabreCreateBookingInput> = {}): SabreCreateBookingInput {
  return {
    product: {
      kind: 'ndc',
      offerId: 'dx369rfr7jt8dnd2i0-1',
      selectedOfferItems: ['dx369rfr7jt8dnd2i0-1-1'],
    },
    travelers: [
      {
        providerTravelerId: 'dx369rfr7jt8dnd2i0-1-1-1',
        givenName: PII.givenName,
        surname: PII.surname,
        birthDate: PII.birthDate,
        passengerCode: 'ADT',
      },
    ],
    contactInfo: { emails: [PII.email], phones: [PII.phone] },
    ...overrides,
  };
}

function atpcoInput(overrides: Partial<SabreCreateBookingInput> = {}): SabreCreateBookingInput {
  return {
    product: {
      kind: 'atpco',
      flights: [
        {
          flightNumber: 462,
          airlineCode: 'AV',
          fromAirportCode: 'BOG',
          toAirportCode: 'LIM',
          departureDate: '2026-09-14',
          departureTime: '09:15',
          bookingClass: 'Y',
          flightStatusCode: 'NN',
        },
      ],
    },
    travelers: [
      { givenName: PII.givenName, surname: PII.surname, passengerCode: 'ADT' },
      { givenName: 'Otra', surname: 'Persona', passengerCode: 'ADT' },
    ],
    ...overrides,
  };
}

function build(
  input: SabreCreateBookingInput,
  options: SabreCreateBookingOptions = {},
  cfg: SabreConfig = config(),
): ReturnType<typeof buildSabreCreateBookingRequest> {
  return buildSabreCreateBookingRequest(input, cfg, options);
}

/** Manda el plan por el cliente real y devuelve el body TAL COMO SALE AL CABLE. */
async function serializedBodyOnTheWire(
  input: SabreCreateBookingInput,
  options: SabreCreateBookingOptions = {},
  cfg: SabreConfig = config(),
): Promise<string> {
  const plan = buildSabreCreateBookingRequest(input, cfg, options);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: SabreFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ confirmationId: 'PYMUEZ', booking: { bookingId: 'PYMUEZ' } }), {
        status: 200,
      }),
    );
  };
  const tokens: SabreTokenProvider = {
    getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
    invalidate: () => Promise.resolve(),
  };
  const http = new SabreHttpClient(cfg, tokens, { fetch: fetchImpl, uuid: () => 'conv-fijo' });

  await http.postJson(plan.path, plan.body);

  const sent = calls[0];
  if (sent === undefined) throw new Error('el cliente no llegó a hacer la llamada');
  const body = sent.init.body;
  if (typeof body !== 'string') throw new Error('el body serializado no es una cadena');
  return body;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('se esperaba un error y no lo hubo');
}

// ---------------------------------------------------------------------------------------------
// D1 — sin PAN, y que el error sea de compilación
// ---------------------------------------------------------------------------------------------

describe('D1 — el body no puede llevar datos de tarjeta', () => {
  it('los campos de tarjeta no compilan dentro de una forma de pago (barrera de tipos)', () => {
    // Si alguien borra los `?: never` de `SabreFormOfPaymentPanFree`, estas tres líneas empiezan a
    // compilar y `tsc` falla por un `@ts-expect-error` sin usar. La defensa está fijada por el
    // compilador, no por una aserción de runtime que se pueda relajar.
    // @ts-expect-error cardNumber no existe en ninguna variante de SabreFormOfPayment (D1)
    const conPan: SabreFormOfPayment = { type: 'CASH', cardNumber: '4537156488578956' };
    // @ts-expect-error cardSecurityCode tampoco (D1)
    const conCvv: SabreFormOfPayment = { type: 'CASH', cardSecurityCode: '123' };
    // @ts-expect-error PAYMENTCARD no es miembro de la unión: no se puede ni nombrar (D1)
    const conTarjeta: SabreFormOfPayment = { type: 'PAYMENTCARD' };

    expect([conPan, conCvv, conTarjeta]).toHaveLength(3);
  });

  it('el body SERIALIZADO que sale por postJson no contiene ni una clave de tarjeta', async () => {
    const body = await serializedBodyOnTheWire(
      ndcInput({
        travelers: [
          {
            givenName: PII.givenName,
            surname: PII.surname,
            passengerCode: 'ADT',
            identityDocuments: [
              {
                documentType: 'PASSPORT',
                documentNumber: PII.documentNumber,
                expiryDate: '2030-01-01',
              },
            ],
            loyaltyPrograms: [{ programNumber: PII.loyaltyNumber, supplierCode: 'AV' }],
          },
        ],
      }),
    );

    for (const forbidden of [
      'cardNumber',
      'cardSecurityCode',
      'cardTypeCode',
      'cardHolder',
      'authentications',
      'virtualCard',
      'billingAddress',
      SABRE_CARD_FORM_OF_PAYMENT_TYPE,
    ]) {
      expect(body).not.toContain(forbidden);
    }
    // El bloque de pago se inspecciona además por ESTRUCTURA, no sólo por nombres prohibidos: una
    // cadena con forma de PAN (`^[0-9]{12,19}`, `:5314`) no puede esconderse en él.
    //
    // La comprobación de dígitos NO se hace sobre el body entero a propósito: un número de
    // fidelización legítimo tiene 12-15 dígitos (el ejemplo oficial es `002001557133728`), así que
    // una regla así daría falso positivo sobre datos que sí deben viajar — y un guard que grita en
    // cada reserva se acaba desactivando.
    const sent = JSON.parse(body) as { payment?: unknown };
    const paymentBlock = JSON.stringify(sent.payment);
    expect(paymentBlock).toBe('{"formsOfPayment":[{"type":"CASH"}]}');
    expect(/[0-9]{12,19}/.test(paymentBlock)).toBe(false);
  });

  it('una forma de pago con cardNumber colada desde JavaScript se rechaza en voz alta', () => {
    const smuggled = {
      type: 'CASH',
      cardNumber: '4537156488578956',
    } as unknown as SabreFormOfPayment;
    const message = messageOf(() => build(ndcInput({ formsOfPayment: [smuggled] })));

    expect(message).toContain('formsOfPayment');
    // Y el número no viaja en el mensaje: los errores de forma nombran campo y código, no valores.
    expect(message).not.toContain('4537156488578956');
  });

  it('ON_ACCOUNT no es una forma de pago legal al RESERVAR: sólo existe al emitir', () => {
    expect(SABRE_PANLESS_FORM_OF_PAYMENT_TYPES).not.toContain('ON_ACCOUNT');
    expect(SABRE_FULFILL_ONLY_FORM_OF_PAYMENT_TYPES).toContain('ON_ACCOUNT');

    const onAccount = { type: 'ON_ACCOUNT' } as unknown as SabreFormOfPayment;
    expect(() => build(ndcInput({ formsOfPayment: [onAccount] }))).toThrow(SabreCreateBookingError);
  });

  it('sin formas de pago declaradas el default del ACL es CASH', () => {
    const plan = build(ndcInput());
    expect(plan.body.payment).toEqual({ formsOfPayment: [{ type: 'CASH' }] });
  });

  it('omitPayment deja la reserva sin bloque payment, que es el caso mayoritario', () => {
    const plan = build(ndcInput(), { omitPayment: true });
    expect(plan.body.payment).toBeUndefined();
  });

  it('omitPayment junto a formsOfPayment es contradictorio y falla', () => {
    expect(() =>
      build(ndcInput({ formsOfPayment: [{ type: 'CASH' }] }), { omitPayment: true }),
    ).toThrow(SabreCreateBookingError);
  });
});

// ---------------------------------------------------------------------------------------------
// errorHandlingPolicy — explícito siempre
// ---------------------------------------------------------------------------------------------

describe('errorHandlingPolicy', () => {
  it('va SIEMPRE en el body, y sin tolerancias es exactamente HALT_ON_ERROR', async () => {
    const plan = build(ndcInput());
    expect(plan.body.errorHandlingPolicy).toEqual([SABRE_DEFAULT_ERROR_POLICY]);

    const body = await serializedBodyOnTheWire(ndcInput());
    expect(body).toContain('"errorHandlingPolicy":["HALT_ON_ERROR"]');
  });

  it('cada tolerancia de dominio se traduce a su política del contrato', () => {
    const plan = build(ndcInput(), { partialFailureTolerance: ['SEAT'] });
    expect(plan.body.errorHandlingPolicy).toEqual(['DO_NOT_HALT_ON_SEAT_BOOKING_ERROR']);
  });

  it('HALT_ON_ERROR no se mezcla con ningún DO_NOT_HALT_ON_*: sería pedir parar y seguir', () => {
    const plan = build(ndcInput(), {
      partialFailureTolerance: ['SEAT', 'HOTEL', 'ANCILLARY'],
    });
    expect(plan.body.errorHandlingPolicy).not.toContain('HALT_ON_ERROR');
  });

  it('HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR es una política MÁS estricta y sí se combina', () => {
    const plan = build(atpcoInput(), {
      partialFailureTolerance: ['SEAT'],
      haltOnInvalidConnectingTime: true,
    });
    expect([...plan.body.errorHandlingPolicy].sort()).toEqual(
      ['DO_NOT_HALT_ON_SEAT_BOOKING_ERROR', 'HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR'].sort(),
    );
  });

  it('el orden es el del enum del contrato y no el de quien llama: dos llamadas equivalentes producen el mismo array', () => {
    const a = resolveErrorHandlingPolicy(['SEAT', 'HOTEL'], false);
    const b = resolveErrorHandlingPolicy(['HOTEL', 'SEAT'], false);
    expect(a).toEqual(b);
    expect(a).toEqual(['DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR', 'DO_NOT_HALT_ON_SEAT_BOOKING_ERROR']);
  });

  it('las tolerancias repetidas no duplican políticas', () => {
    expect(resolveErrorHandlingPolicy(['SEAT', 'SEAT'], false)).toEqual([
      'DO_NOT_HALT_ON_SEAT_BOOKING_ERROR',
    ]);
  });

  it('la política aplicada vuelve en el plan, para que el domain_event pueda citarla', () => {
    const plan = build(ndcInput(), { partialFailureTolerance: ['PRICING'] });
    expect(plan.errorHandlingPolicy).toEqual(['DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR']);
    expect(plan.errorHandlingPolicy).toBe(plan.body.errorHandlingPolicy);
  });

  it('las ocho políticas del contrato están, ni una más ni una menos', () => {
    expect(SABRE_CREATE_ERROR_POLICIES).toHaveLength(8);
    expect(SABRE_CREATE_ERROR_POLICIES[0]).toBe('HALT_ON_ERROR');
  });

  it('una tolerancia que no existe en el vocabulario se rechaza', () => {
    expect(() =>
      build(ndcInput(), {
        partialFailureTolerance: ['LO_QUE_SEA'] as unknown as ['SEAT'],
      }),
    ).toThrow(SabreCreateBookingError);
  });
});

// ---------------------------------------------------------------------------------------------
// asynchronousUpdateWaitTime — explícito y nunca 0
// ---------------------------------------------------------------------------------------------

describe('asynchronousUpdateWaitTime', () => {
  it('va siempre en el body con el default explícito, nunca el 0 del contrato', async () => {
    const body = await serializedBodyOnTheWire(ndcInput());
    expect(body).toContain(
      `"asynchronousUpdateWaitTime":${String(SABRE_ASYNC_UPDATE_WAIT_MS_DEFAULT)}`,
    );
    expect(body).not.toContain('"asynchronousUpdateWaitTime":0');
  });

  it('0 se rechaza: con 0 la respuesta puede llegar antes de que la reserva esté completa', () => {
    expect(() => build(ndcInput(), { asynchronousUpdateWaitTimeMs: 0 })).toThrow(
      SabreCreateBookingError,
    );
  });

  it('por encima del techo del contrato (10.000 ms) se rechaza', () => {
    expect(() =>
      build(ndcInput(), { asynchronousUpdateWaitTimeMs: SABRE_ASYNC_UPDATE_WAIT_MS_MAX + 1 }),
    ).toThrow(SabreCreateBookingError);
  });

  it('un valor explícito se respeta y vuelve en el plan', () => {
    const plan = build(ndcInput(), { asynchronousUpdateWaitTimeMs: 5_000 });
    expect(plan.body.asynchronousUpdateWaitTime).toBe(5_000);
    expect(plan.asynchronousUpdateWaitTimeMs).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Índices: TODO pasa por indices.ts
// ---------------------------------------------------------------------------------------------

describe('índices 1-based', () => {
  it('el travelerIndex de un asiento NDC es la posición del array + 1', () => {
    const plan = build(
      ndcInput({
        travelers: [
          { givenName: 'Uno', surname: 'Uno', passengerCode: 'ADT' },
          { givenName: 'Dos', surname: 'Dos', passengerCode: 'ADT' },
          { givenName: 'Tres', surname: 'Tres', passengerCode: 'ADT' },
        ],
        product: {
          kind: 'ndc',
          offerId: 'oferta-1',
          selectedOfferItems: ['item-1'],
          seatOffers: [{ seatOfferId: 'seat-1', number: '12A', travelerPosition: 2 }],
        },
      }),
    );

    expect(plan.body.flightOffer?.seatOffers?.[0]?.travelerIndex).toBe(3);
  });

  it('una posición que no existe en el array muere aquí y no viaja a Sabre', () => {
    expect(() =>
      build(
        ndcInput({
          product: {
            kind: 'ndc',
            offerId: 'oferta-1',
            selectedOfferItems: ['item-1'],
            seatOffers: [{ seatOfferId: 'seat-1', number: '12A', travelerPosition: 7 }],
          },
        }),
      ),
    ).toThrow(/no existe en una lista/);
  });

  it('infantTravelerIndex apunta al infante y se convierte por el mismo camino', () => {
    const plan = build(
      atpcoInput({
        travelers: [
          { givenName: 'Adulto', surname: 'Mayor', passengerCode: 'ADT', linkedInfantPosition: 1 },
          { givenName: 'Bebe', surname: 'Menor', passengerCode: 'INF', birthDate: '2025-06-01' },
        ],
      }),
    );
    expect(plan.body.travelers?.[0]?.infantTravelerIndex).toBe(2);
    expect(plan.body.travelers?.[1]?.infantTravelerIndex).toBeUndefined();
  });

  it('formOfPaymentIndices se acota contra el array real de formas de pago', () => {
    const plan = build(
      atpcoInput({
        formsOfPayment: [{ type: 'CASH' }, { type: 'CHECK' }],
        travelers: [
          { givenName: 'Uno', surname: 'Uno', passengerCode: 'ADT', formOfPaymentPositions: [1] },
        ],
      }),
    );
    expect(plan.body.travelers?.[0]?.formOfPaymentIndices).toEqual([2]);
  });

  it('un índice de forma de pago fuera del array no llega al cable', () => {
    expect(() =>
      build(
        atpcoInput({
          formsOfPayment: [{ type: 'CASH' }],
          travelers: [
            { givenName: 'Uno', surname: 'Uno', passengerCode: 'ADT', formOfPaymentPositions: [3] },
          ],
        }),
      ),
    ).toThrow();
  });

  it('flightIndices de un documento se convierte contra los vuelos declarados', () => {
    const plan = build(
      atpcoInput({
        product: {
          kind: 'atpco',
          flights: [
            {
              flightNumber: 1,
              airlineCode: 'AV',
              fromAirportCode: 'BOG',
              toAirportCode: 'LIM',
              departureDate: '2026-09-14',
              departureTime: '09:15',
              bookingClass: 'Y',
              flightStatusCode: 'NN',
            },
            {
              flightNumber: 2,
              airlineCode: 'AV',
              fromAirportCode: 'LIM',
              toAirportCode: 'BOG',
              departureDate: '2026-09-20',
              departureTime: '18:15',
              bookingClass: 'Y',
              flightStatusCode: 'NN',
            },
          ],
        },
        travelers: [
          {
            givenName: 'Uno',
            surname: 'Uno',
            passengerCode: 'ADT',
            identityDocuments: [{ documentType: 'PASSPORT', flightPositions: [1] }],
          },
        ],
      }),
    );
    expect(plan.body.travelers?.[0]?.identityDocuments?.[0]?.flightIndices).toEqual([2]);
  });

  it('en NDC, flightPositions sin segmentCount se rechaza en vez de inventar el tramo', () => {
    const message = messageOf(() =>
      build(
        ndcInput({
          travelers: [
            {
              givenName: 'Uno',
              surname: 'Uno',
              passengerCode: 'ADT',
              identityDocuments: [
                {
                  documentType: 'VISA',
                  flightPositions: [0],
                  hostCountryCode: 'US',
                  issueDate: '2025-01-01',
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(message).toContain('segmentCount');
  });

  it('primaryFormOfPayment del pricing es un índice, no un objeto', () => {
    const plan = build(
      atpcoInput({
        formsOfPayment: [{ type: 'CASH' }, { type: 'INVOICE' }],
        product: {
          kind: 'atpco',
          flights: [
            {
              flightNumber: 462,
              airlineCode: 'AV',
              fromAirportCode: 'BOG',
              toAirportCode: 'LIM',
              departureDate: '2026-09-14',
              departureTime: '09:15',
              bookingClass: 'Y',
              flightStatusCode: 'NN',
            },
          ],
          pricing: [{ primaryFormOfPaymentPosition: 1, validatingAirlineCode: 'AV' }],
        },
      }),
    );
    expect(plan.body.flightDetails?.flightPricing?.[0]?.qualifiers?.payment).toEqual({
      primaryFormOfPayment: 2,
    });
  });

  it('un secondaryFormOfPayment sin primary se rechaza: primary es el único required', () => {
    expect(() =>
      build(
        atpcoInput({
          formsOfPayment: [{ type: 'CASH' }, { type: 'INVOICE' }],
          product: {
            kind: 'atpco',
            flights: [
              {
                flightNumber: 1,
                airlineCode: 'AV',
                fromAirportCode: 'BOG',
                toAirportCode: 'LIM',
                departureDate: '2026-09-14',
                departureTime: '09:15',
                bookingClass: 'Y',
                flightStatusCode: 'NN',
              },
            ],
            pricing: [{ secondaryFormOfPaymentPosition: 1 }],
          },
        }),
      ),
    ).toThrow(SabreCreateBookingError);
  });
});

// ---------------------------------------------------------------------------------------------
// Requisitos por aerolínea: la tabla decide, el builder obedece
// ---------------------------------------------------------------------------------------------

describe('requisitos por aerolínea', () => {
  const baseBaInput = (): SabreCreateBookingInput =>
    ndcInput({
      carriers: ['BA'],
      agency: { contactInfo: { emails: ['agencia@ejemplo.test'] } },
      travelers: [
        {
          givenName: PII.givenName,
          surname: PII.surname,
          passengerCode: 'ADT',
          title: 'Congressman',
          identityDocuments: [
            {
              documentType: 'PASSPORT',
              documentNumber: PII.documentNumber,
              citizenshipCountryCode: 'CO',
            },
          ],
        },
      ],
    });

  it('BA sin citizenshipCountryCode no se manda: Sabre la rechazaría', () => {
    const input = baseBaInput();
    const traveler = input.travelers[0];
    if (traveler === undefined) throw new Error('fixture roto');
    const message = messageOf(() =>
      build({
        ...input,
        travelers: [
          {
            ...traveler,
            identityDocuments: [{ documentType: 'PASSPORT', documentNumber: PII.documentNumber }],
          },
        ],
      }),
    );

    expect(message).toContain('BA_CITIZENSHIP_COUNTRY_CODE');
    expect(message).toContain('citizenshipCountryCode');
  });

  it('el mensaje del requisito nombra campos e índices y NINGÚN valor del payload', () => {
    const input = baseBaInput();
    const traveler = input.travelers[0];
    if (traveler === undefined) throw new Error('fixture roto');
    const message = messageOf(() =>
      build({
        ...input,
        travelers: [
          {
            ...traveler,
            title: undefined,
            identityDocuments: [{ documentType: 'PASSPORT', documentNumber: PII.documentNumber }],
          },
        ],
      }),
    );

    for (const value of Object.values(PII)) {
      expect(message).not.toContain(value);
    }
  });

  it('con el requisito cumplido, la reserva se construye', () => {
    const plan = build(baseBaInput());
    expect(plan.body.flightOffer?.offerId).toBe('dx369rfr7jt8dnd2i0-1');
    expect(plan.carriers).toEqual(['BA']);
  });

  it('un requisito advisory avisa en el plan y NO bloquea la venta', () => {
    // El teléfono de agencia con formato legacy incumple `AGENCY_PHONE_COUNTRY_CODE_FORMAT`, que es
    // advisory a propósito: docs/sabre/04 §4.2 deja ABIERTO si AF lo acepta.
    const plan = build(
      ndcInput({
        agency: { contactInfo: { phones: ['11234+15551239999789'] } },
      }),
    );
    expect(plan.advisories.map((item) => item.id)).toContain('AGENCY_PHONE_COUNTRY_CODE_FORMAT');
    expect(plan.advisories.every((item) => item.severity === 'advisory')).toBe(true);
  });

  it('las aerolíneas de un ATPCO salen de los propios vuelos, sin que nadie las declare', () => {
    const plan = build(atpcoInput());
    expect(plan.carriers).toEqual(['AV']);
  });

  it('los códigos declarados se normalizan a mayúsculas y se deduplican', () => {
    const plan = build(atpcoInput({ carriers: ['av', 'AV'] }));
    expect(plan.carriers).toEqual(['AV']);
  });
});

// ---------------------------------------------------------------------------------------------
// Forma del body y topes del contrato
// ---------------------------------------------------------------------------------------------

describe('forma del body', () => {
  it('la ruta es la del contrato', () => {
    expect(build(ndcInput()).path).toBe(SABRE_CREATE_BOOKING_PATH);
    expect(SABRE_CREATE_BOOKING_PATH).toBe('/v1/trip/orders/createBooking');
  });

  it('NDC emite flightOffer y NUNCA flightDetails', () => {
    const plan = build(ndcInput());
    expect(plan.body.flightOffer).toBeDefined();
    expect(plan.body.flightDetails).toBeUndefined();
  });

  it('ATPCO emite flightDetails y NUNCA flightOffer', () => {
    const plan = build(atpcoInput());
    expect(plan.body.flightDetails).toBeDefined();
    expect(plan.body.flightOffer).toBeUndefined();
  });

  it('un input con los dos bloques a la vez no se puede construir', () => {
    const both = {
      ...ndcInput(),
      product: { kind: 'ndc', offerId: 'o-1', selectedOfferItems: ['i-1'], flights: [] },
    } as unknown as SabreCreateBookingInput;
    expect(() => build(both)).toThrow(SabreCreateBookingError);
  });

  it('más de 9 selectedOfferItems se rechaza: es el techo duro de una orden NDC', () => {
    const items = Array.from({ length: 10 }, (_unused, i) => `item-${String(i)}`);
    expect(() =>
      build(ndcInput({ product: { kind: 'ndc', offerId: 'o-1', selectedOfferItems: items } })),
    ).toThrow(SabreCreateBookingError);
  });

  it('más de 16 vuelos se rechaza: es el techo duro de segmentos por PNR', () => {
    const flight = {
      flightNumber: 1,
      airlineCode: 'AV',
      fromAirportCode: 'BOG',
      toAirportCode: 'LIM',
      departureDate: '2026-09-14',
      departureTime: '09:15',
      bookingClass: 'Y',
      flightStatusCode: 'NN',
    } as const;
    expect(() =>
      build(
        atpcoInput({
          product: { kind: 'atpco', flights: Array.from({ length: 17 }, () => flight) },
        }),
      ),
    ).toThrow(SabreCreateBookingError);
  });

  it('flightNumber sale como ENTERO, no como la cadena de los 20 requests de la colección', async () => {
    const body = await serializedBodyOnTheWire(atpcoInput());
    expect(body).toContain('"flightNumber":462');
    expect(body).not.toContain('"flightNumber":"462"');
  });

  it('un apellido con dígitos se rechaza, y el mensaje no lo repite', () => {
    const message = messageOf(() =>
      build(
        ndcInput({ travelers: [{ givenName: 'Ana', surname: 'Perez2', passengerCode: 'ADT' }] }),
      ),
    );
    expect(message).toContain('surname');
    expect(message).not.toContain('Perez2');
  });

  it('un título fuera del enum cerrado de 18 valores se rechaza', () => {
    expect(() =>
      build(
        ndcInput({
          travelers: [
            {
              givenName: 'Ana',
              surname: 'Perez',
              passengerCode: 'ADT',
              title: 'Excelentísima' as 'Mr',
            },
          ],
        }),
      ),
    ).toThrow(SabreCreateBookingError);
  });

  it('Congressman SÍ es un título legal: está en TitleEnum', () => {
    const plan = build(
      ndcInput({
        travelers: [
          { givenName: 'Ana', surname: 'Perez', passengerCode: 'ADT', title: 'Congressman' },
        ],
      }),
    );
    expect(plan.body.travelers?.[0]?.title).toBe('Congressman');
  });

  it('commissionAmount y commissionPercentage no se pueden combinar', () => {
    expect(() =>
      build(
        atpcoInput({
          product: {
            kind: 'atpco',
            flights: [
              {
                flightNumber: 1,
                airlineCode: 'AV',
                fromAirportCode: 'BOG',
                toAirportCode: 'LIM',
                departureDate: '2026-09-14',
                departureTime: '09:15',
                bookingClass: 'Y',
                flightStatusCode: 'NN',
              },
            ],
            pricing: [{ commissionAmount: '30.00', commissionPercentage: '10.00' }],
          },
        }),
      ),
    ).toThrow(SabreCreateBookingError);
  });

  it('priceComparisons con amount y percent a la vez se rechaza', () => {
    expect(() =>
      build(
        atpcoInput({
          product: {
            kind: 'atpco',
            flights: [
              {
                flightNumber: 1,
                airlineCode: 'AV',
                fromAirportCode: 'BOG',
                toAirportCode: 'LIM',
                departureDate: '2026-09-14',
                departureTime: '09:15',
                bookingClass: 'Y',
                flightStatusCode: 'NN',
              },
            ],
            pricing: [
              {
                priceComparisons: [
                  {
                    desiredAmount: '100.00',
                    comparisonType: 'INCREASE_BY_AMOUNT',
                    amount: '10.00',
                    percent: '5.00',
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).toThrow(SabreCreateBookingError);
  });

  it('un seatOfferId en un asiento ATPCO se rechaza: ese campo es del carril NDC', () => {
    const message = messageOf(() =>
      build(
        atpcoInput({
          product: {
            kind: 'atpco',
            flights: [
              {
                flightNumber: 1,
                airlineCode: 'AV',
                fromAirportCode: 'BOG',
                toAirportCode: 'LIM',
                departureDate: '2026-09-14',
                departureTime: '09:15',
                bookingClass: 'Y',
                flightStatusCode: 'NN',
                seats: [{ seatOfferId: 'no-va-aqui', number: '12A', travelerPosition: 0 }],
              },
            ],
          },
        }),
      ),
    );
    expect(message).toContain('seatOfferId');
  });

  it('la fecha de retención es YYYY-MM-DD, no ISO-8601 con hora', () => {
    expect(() => build(ndcInput({ retentionEndDate: '2027-06-21T00:00:00.000Z' }))).toThrow(
      SabreCreateBookingError,
    );
    const plan = build(ndcInput({ retentionEndDate: '2027-06-21' }));
    expect(plan.body.retentionEndDate).toBe('2027-06-21');
  });
});

// ---------------------------------------------------------------------------------------------
// targetPcc — el gancho consolidador, con su freno
// ---------------------------------------------------------------------------------------------

describe('targetPcc', () => {
  it('sin grupo configurado no sale al cable: dejaría el contexto cambiado sin revertirlo', () => {
    const message = messageOf(() => build(ndcInput({ targetPcc: 'G7RE' })));
    expect(message).toContain('targetPcc');
  });

  it('con sabreGroup configurado sí se emite', () => {
    const plan = build(ndcInput({ targetPcc: 'G7RE' }), {}, config({ sabreGroup: 'G7RE' }));
    expect(plan.body.targetPcc).toBe('G7RE');
  });

  it('un PCC que no cumple el patrón del contrato se rechaza', () => {
    expect(() =>
      build(ndcInput({ targetPcc: 'demasiado-largo' }), {}, config({ sabreGroup: 'G7RE' })),
    ).toThrow(SabreCreateBookingError);
  });
});

// ---------------------------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------------------------

describe('PII', () => {
  it('ningún mensaje de error del builder repite un valor del payload', () => {
    const inputs: Array<() => unknown> = [
      () => build(ndcInput({ retentionEndDate: 'no-es-fecha' })),
      () => build(ndcInput({ contactInfo: { emails: ['esto-no-es-un-email'] } })),
      () =>
        build(
          ndcInput({
            travelers: [
              {
                givenName: PII.givenName,
                surname: PII.surname,
                passengerCode: 'ADT',
                identityDocuments: [{ documentType: 'PASSPORT', documentNumber: 'CC-1234-567' }],
              },
            ],
          }),
        ),
    ];

    for (const fn of inputs) {
      const message = messageOf(fn);
      for (const value of Object.values(PII)) expect(message).not.toContain(value);
      expect(message).not.toContain('CC-1234-567');
      expect(message).not.toContain('esto-no-es-un-email');
    }
  });
});
