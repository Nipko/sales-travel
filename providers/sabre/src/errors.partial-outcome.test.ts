/**
 * EL DESENLACE PARCIAL — que un `200` con reserva dentro y `errors[]` al lado llegue al mapper.
 *
 * ## Qué fallo fija este fichero
 *
 * `createBooking` y `cancelBooking` aceptan `errorHandlingPolicy` en la request, y seis de sus ocho
 * valores son `DO_NOT_HALT_ON_*`. La forma que produce elegir eso —reserva **y** `errors[]` en el
 * mismo `200`— la declara el contrato (`booking-management-v1.yml:804-829` y `:440-487`), y el
 * clasificador endurecido durante doce rondas la lanzaba como `SabreApiError` **antes** de que el
 * mapper corriera. Consecuencia medida: todo el éxito parcial de `create.response.mapper.ts` era
 * inalcanzable, `mapSabreCancelResponse` sólo podía devolver `CANCELLED`, y un `confirmationId` que
 * llegara dentro de un sobre rechazado se perdía — un PNR huérfano que sólo encuentra una persona.
 *
 * ## Cómo se mide
 *
 * Todo entra por `SabreHttpClient.postJson`. Ninguna función interna se llama a mano, con UNA
 * excepción nombrada: el bloque que mide el DEFAULT del clasificador sin contexto de operación, que
 * por construcción no se puede alcanzar desde el cliente —el cliente siempre pasa la ruta— y que es
 * justo la propiedad de fallar cerrado que hay que fijar.
 *
 * Y la reachability no se mide con un booleano del cliente: se mide **haciendo correr los mappers
 * de verdad** sobre `result.data`. Que `postJson` resuelva no demuestra que el mapper decida; que
 * `mapSabreCreateBookingResponse` devuelva `PARTIAL` con el PNR dentro, sí.
 */

import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_CANCEL_BOOKING_PATH } from './booking/cancel.request.builder';
import { mapSabreCancelResponse } from './booking/cancel.response.mapper';
import { SABRE_CREATE_BOOKING_PATH } from './booking/create.request.builder';
import { mapSabreCreateBookingResponse } from './booking/create.response.mapper';
import { SABRE_HOSTS, type SabreConfig } from './config';
import {
  SABRE_MAPPABLE_PARTIAL_KINDS,
  SABRE_PARTIAL_OUTCOME_CONTRACTS,
  SabreApiError,
  classifySabreEnvelope,
} from './errors';
import { SabreHttpClient, type SabreResult } from './http/sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';
const GET_BOOKING_PATH = '/v1/trip/orders/getBooking';

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'U9PK',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'parcial',
  };
}

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-PARCIAL-SECRETO'),
  invalidate: () => Promise.resolve(),
};

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly meta: string;
}

interface Outcome {
  /** `postJson` lanzó. */
  readonly rejected: boolean;
  readonly error?: SabreApiError;
  readonly result?: SabreResult<unknown>;
  readonly logs: readonly LogLine[];
  /** Cuántas veces se llamó al `fetch`. Una escritura no se reintenta ni tolerada ni rechazada. */
  readonly calls: number;
}

async function post(payload: unknown, path: string): Promise<Outcome> {
  const logs: LogLine[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push({ level, message, meta: JSON.stringify(meta ?? {}) });
    };
  const logger: LoggerPort = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };

  let calls = 0;
  const fetchImpl: SabreFetch = () => {
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  };

  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-parcial',
  });

  try {
    const result = await http.postJson<unknown>(path, {});
    return { rejected: false, result, logs, calls };
  } catch (error) {
    if (!(error instanceof SabreApiError)) throw error;
    return { rejected: true, error, logs, calls };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Los sobres. Se escriben una vez y se mutan de UNA cosa en el bloque 3.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * El caso del founder, tal cual: vuelo CONFIRMADO (`HK`) y asiento denegado (`No Seat`), con el
 * `errors[]` que produce haber pedido `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`.
 */
const CREATE_PARTIAL_SEAT = {
  timestamp: '2026-08-26T10:17:18',
  confirmationId: 'GLEBNY',
  booking: {
    bookingId: 'GLEBNY',
    flights: [
      {
        itemId: '1',
        flightStatusCode: 'HK',
        flightStatusName: 'Confirmed',
        seats: [{ number: '12A', statusCode: 'NO', statusName: 'No Seat' }],
      },
    ],
  },
  errors: [
    {
      category: 'APPLICATION_ERROR',
      type: 'UNABLE_TO_BOOK_SEAT',
      description: 'Seat 12A is no longer available for Ana Perez',
      fieldPath: 'flights[0].seats',
    },
  ],
};

/**
 * El ejemplo OFICIAL de `NO_ITEMS_CANCELLED`, copiado de
 * `help-documentation-cancel-booking-examples.txt` (use case 8, `HALT_ON_ERROR` + void). Es el
 * sobre que la cabecera de `cancel.response.mapper.ts` citaba como «comprobado: el clasificador
 * lanza antes de que este mapper vea nada».
 */
const CANCEL_NO_ITEMS_CANCELLED = {
  request: {
    confirmationId: 'MFLSHG',
    retrieveBooking: false,
    flightTicketOperation: 'VOID',
    cancelAll: false,
    flights: [{ itemId: '7' }, { itemId: '19' }],
  },
  errors: [
    {
      category: 'WARNING',
      type: 'NO_ITEMS_CANCELLED',
      description: 'Nothing was cancelled - cancellation was interrupted due to errors',
    },
    {
      category: 'CANCELLATION_ERROR',
      type: 'UNABLE_TO_VOID_TICKET',
      description: 'The ticket does not match the segments selected for cancellation.',
      fieldPath: 'cancelBookingRequest.flights',
      fieldName: 'itemId',
      fieldValue: '[1251237703376, 6071237703375]',
    },
  ],
};

/* ────────────────────────────────────────────────────────────────────────────
 * (1) LA RAÍZ — el desenlace parcial llega al mapper y el mapper decide
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(1) un createBooking con reserva y errors[] llega al mapper', () => {
  it('postJson entrega el cuerpo en vez de lanzar', async () => {
    const outcome = await post(CREATE_PARTIAL_SEAT, SABRE_CREATE_BOOKING_PATH);
    expect(outcome.rejected, 'el sobre legítimo de éxito parcial se rechazó').toBe(false);
    expect(outcome.result?.data).toEqual(CREATE_PARTIAL_SEAT);
  });

  it('y el mapper decide el desenlace: PARTIAL con el PNR dentro, jamás FAILED', async () => {
    const outcome = await post(CREATE_PARTIAL_SEAT, SABRE_CREATE_BOOKING_PATH);
    const mapped = mapSabreCreateBookingResponse(outcome.result?.data);

    // La regla del founder, medida extremo a extremo: el fallo del ACCESORIO no tumba el producto.
    expect(mapped.order.outcome).toBe('PARTIAL');
    expect(mapped.order.pnr).toBe('GLEBNY');
    expect(mapped.order.items.find((item) => item.kind === 'flight')?.status).toBe('CONFIRMED');
    expect(mapped.order.items.find((item) => item.kind === 'seat')?.status).toBe('FAILED');
  });

  it('el fallo NO se pierde: viaja en `partialOutcome` y el veredicto sigue diciendo `ok: false`', async () => {
    const outcome = await post(CREATE_PARTIAL_SEAT, SABRE_CREATE_BOOKING_PATH);

    expect(outcome.result?.partialOutcome.map((issue) => issue.type)).toEqual([
      'UNABLE_TO_BOOK_SEAT',
    ]);
    // Tolerar no es aprobar: el clasificador sigue diciendo que este sobre no está limpio.
    const verdict = classifySabreEnvelope(CREATE_PARTIAL_SEAT, { path: SABRE_CREATE_BOOKING_PATH });
    expect(verdict.ok).toBe(false);
    expect(verdict.partialOutcome).toBe(true);
    expect(verdict.failures).toHaveLength(1);
  });

  it('un sobre LIMPIO sigue saliendo con `partialOutcome` vacío', async () => {
    const outcome = await post(
      { confirmationId: 'GLEBNY', booking: { bookingId: 'GLEBNY' } },
      SABRE_CREATE_BOOKING_PATH,
    );
    expect(outcome.rejected).toBe(false);
    expect(outcome.result?.partialOutcome).toEqual([]);
  });

  it('la entrega tolerada NO reintenta la escritura', async () => {
    const outcome = await post(CREATE_PARTIAL_SEAT, SABRE_CREATE_BOOKING_PATH);
    expect(outcome.calls).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) SIN RESERVA UTILIZABLE, SIGUE LANZANDO
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(2) un createBooking con errors[] y sin localizador sigue lanzando', () => {
  const SIN_LOCALIZADOR: ReadonlyArray<readonly [string, unknown]> = [
    ['sólo errors[]', { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] }],
    [
      'booking sin bookingId',
      { booking: {}, errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] },
    ],
    [
      'booking con bookingId vacío',
      {
        booking: { bookingId: '' },
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }],
      },
    ],
    [
      'confirmationId fuera de la forma del contrato (minúsculas)',
      {
        confirmationId: 'glebny',
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }],
      },
    ],
    [
      'confirmationId demasiado corto (el contrato exige 6)',
      {
        confirmationId: 'GLEBN',
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }],
      },
    ],
    [
      'confirmationId con separador: no es un localizador, es una tirada',
      {
        confirmationId: 'SMITH/JOHNMR',
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }],
      },
    ],
    [
      'el localizador está, pero anidado donde el mapper no lo lee',
      {
        data: { confirmationId: 'GLEBNY' },
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }],
      },
    ],
  ];

  it.each(SIN_LOCALIZADOR)('%s → SabreApiError', async (_name, payload) => {
    const outcome = await post(payload, SABRE_CREATE_BOOKING_PATH);
    expect(outcome.rejected).toBe(true);
    expect(outcome.error?.status).toBe(200);
    expect(outcome.calls).toBe(1);
  });

  it('y el localizador que sí pasa es exactamente el que el mapper sabe leer', async () => {
    // La contraparte de la lista de arriba: `booking.bookingId` es el segundo carril del contrato
    // (`Booking.bookingId`, `^[A-Z0-9]{6,14}$`) y también sostiene la tolerancia por sí solo.
    const outcome = await post(
      {
        booking: { bookingId: '1SXXX1A2B3C4D' },
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_BOOK_HOTEL' }],
      },
      SABRE_CREATE_BOOKING_PATH,
    );
    expect(outcome.rejected).toBe(false);
    expect(mapSabreCreateBookingResponse(outcome.result?.data).order.orderId).toBe('1SXXX1A2B3C4D');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) SÓLO SE PERDONA EL PORTADOR DE LA RAÍZ
 *
 * Cada caso es el sobre tolerado del bloque (1) con UNA cosa cambiada. Si alguno resolviera, la
 * tolerancia no sería «el desenlace que el contrato declara» sino un agujero.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(3) todo lo que no sea el `errors` de la raíz sigue rechazando', () => {
  const CON_LOCALIZADOR = { confirmationId: 'GLEBNY', booking: { bookingId: 'GLEBNY' } };

  const MUTACIONES: ReadonlyArray<readonly [string, unknown]> = [
    [
      'un error ENTERRADO bajo booking, además del portador',
      {
        ...CON_LOCALIZADOR,
        booking: {
          bookingId: 'GLEBNY',
          detail: { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] },
        },
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_BOOK_SEAT' }],
      },
    ],
    [
      'un `status: NotProcessed` fuera del portador',
      { ...CON_LOCALIZADOR, status: 'NotProcessed', errors: [{ category: 'A', type: 'B' }] },
    ],
    [
      'un `fault` fuera del portador',
      {
        ...CON_LOCALIZADOR,
        fault: { faultcode: 'soap:Server' },
        errors: [{ category: 'A', type: 'B' }],
      },
    ],
    [
      '`error` en SINGULAR no es la clave que el contrato declara',
      { ...CON_LOCALIZADOR, error: 'invalid_grant' },
    ],
    [
      '`errorList` tampoco lo es',
      { ...CON_LOCALIZADOR, errorList: [{ category: 'A', type: 'B' }] },
    ],
    [
      '`applicationError` tampoco lo es',
      { ...CON_LOCALIZADOR, applicationError: { type: 'UNABLE_TO_CREATE' } },
    ],
    [
      'un `messages[]` sin severidad fuera del portador',
      {
        ...CON_LOCALIZADOR,
        messages: [{ content: 'Booking could not be completed' }],
        errors: [{ category: 'A', type: 'B' }],
      },
    ],
    [
      'una clave no-ASCII en la raíz (la «е» es cirílica)',
      { ...CON_LOCALIZADOR, ['еrrors']: [{ category: 'A', type: 'B' }] },
    ],
    [
      'el portador anidado en vez de en la raíz',
      {
        ...CON_LOCALIZADOR,
        wrapper: { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] },
      },
    ],
    [
      'un `ApplicationResults.Success` prestado no compra nada en una operación de dinero',
      {
        ...CON_LOCALIZADOR,
        ApplicationResults: {
          Success: [{ SystemSpecificResults: [{ Message: [{ code: 'ERR.0161' }] }] }],
        },
        errors: [{ category: 'A', type: 'B' }],
      },
    ],
  ];

  it.each(MUTACIONES)('%s → SabreApiError', async (_name, payload) => {
    const outcome = await post(payload, SABRE_CREATE_BOOKING_PATH);
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toBeInstanceOf(SabreApiError);
  });

  it('la guarda de profundidad manda sobre la tolerancia: no verificable nunca se entrega', async () => {
    // Dos sitios donde el sobre se vuelve no verificable, y los dos tienen que rechazar. El SEGUNDO
    // es el que mide la guarda de `exhaustive` por sí sola: si lo que agota la profundidad está
    // DENTRO del portador, el residuo —que es el sobre sin el portador— sale limpio y exhaustivo,
    // así que el re-recorrido no puede verlo. Medido con sonda: quitando `if (!verdict.exhaustive)`
    // de `isDeclaredPartialOutcome`, este caso —y sólo éste— se entrega como desenlace parcial con
    // el subárbol de `errors[]` sin mirar. Un sobre que no se pudo terminar de leer no tiene
    // desenlace: tiene incógnitas.
    let deep: unknown = { leaf: true };
    for (let index = 0; index < 80; index += 1) deep = { wrap: deep };

    // Y en las DOS operaciones: el carril sin localizador no tiene una guarda distinta.
    for (const path of [SABRE_CREATE_BOOKING_PATH, SABRE_CANCEL_BOOKING_PATH]) {
      for (const payload of [
        { ...CON_LOCALIZADOR, deep, errors: [{ category: 'WARNING', type: 'UNABLE_TO_CANCEL' }] },
        { ...CON_LOCALIZADOR, errors: [deep] },
      ]) {
        const outcome = await post(payload, path);
        expect(outcome.rejected, `${path} ${Object.keys(payload).join(',')}`).toBe(true);
      }
    }
  });

  it('el portador tiene que tener la forma que el contrato declara: un array', async () => {
    // Medido: sin esta condición, `{"errors":{…}}` —la forma que produce un carril XML/SOAP— se
    // entregaba como desenlace de una cancelación. El contrato dice `errors: type: array` en las
    // dos respuestas; lo que no es un array no es el desenlace declarado, es un sobre desconocido.
    const item = { category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' };
    for (const [path, payload] of [
      [SABRE_CREATE_BOOKING_PATH, { ...CON_LOCALIZADOR, errors: item }],
      [SABRE_CREATE_BOOKING_PATH, { ...CON_LOCALIZADOR, errors: 'UNABLE_TO_CREATE' }],
      [SABRE_CANCEL_BOOKING_PATH, { errors: item }],
      [SABRE_CANCEL_BOOKING_PATH, { errors: 'NO_ITEMS_CANCELLED' }],
      // Dos portadores y uno mal formado: se quitan los dos del residuo, así que perdonar el
      // segundo sería perdonar contenido sin haberlo mirado.
      [SABRE_CANCEL_BOOKING_PATH, { errors: [item], Errors: item }],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      const outcome = await post(payload, path);
      expect(outcome.rejected, `${path} ${JSON.stringify(payload)}`).toBe(true);
    }
  });

  it('sin portador en la raíz no hay tolerancia que aplicar', async () => {
    // El sobre falla por otra vía y el localizador no lo salva: la tolerancia es del portador
    // declarado, no un salvoconducto del `confirmationId`.
    const outcome = await post(
      { ...CON_LOCALIZADOR, status: 'Incomplete' },
      SABRE_CREATE_BOOKING_PATH,
    );
    expect(outcome.rejected).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (4) cancelBooking — las seis ramas del mapper vuelven a ser alcanzables
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(4) mapSabreCancelResponse ya puede devolver algo que no sea CANCELLED', () => {
  it('el ejemplo OFICIAL de NO_ITEMS_CANCELLED llega al mapper', async () => {
    const outcome = await post(CANCEL_NO_ITEMS_CANCELLED, SABRE_CANCEL_BOOKING_PATH);
    expect(outcome.rejected, 'el ejemplo oficial se rechazó').toBe(false);

    const detail = mapSabreCancelResponse(outcome.result?.data, {
      requestedPolicy: 'HALT_ON_ERROR',
    });

    // ⚠️ El desenlace es `FAILED`, **no** `NOTHING_CANCELLED`, y no es un fallo de este cambio: el
    // sobre oficial trae DOS items y sólo uno es `category: WARNING`. `resolveOutcome` da prioridad
    // a `errors[]` no-warning, así que el `CANCELLATION_ERROR/UNABLE_TO_VOID_TICKET` manda. Eso es
    // política del mapper y se mide aquí para no volver a suponerla.
    //
    // Lo que este bloque fija es lo otro: el mapper AHORA VE el sobre, y con él ve el
    // `NO_ITEMS_CANCELLED` que dice que hubo rollback y que no hay nada que reconciliar. Antes ese
    // dato no salía del clasificador.
    expect(detail.outcome).toBe('FAILED');
    expect(detail.success).toBe(false);
    expect(detail.warnings.map((issue) => issue.type)).toEqual(['NO_ITEMS_CANCELLED']);
    expect(detail.errors.map((issue) => issue.type)).toEqual(['UNABLE_TO_VOID_TICKET']);
  });

  /** Un sobre por rama, con el vocabulario que el propio mapper declara. */
  const RAMAS: ReadonlyArray<readonly [string, unknown]> = [
    ['CANCELLED', { request: { confirmationId: 'MFLSHG' }, voidedTickets: ['0017544536141'] }],
    [
      'ALREADY_CANCELLED',
      { errors: [{ category: 'APPLICATION_ERROR', type: 'BOOKING_ALREADY_CANCELED' }] },
    ],
    ['PARTIALLY_CANCELLED', { errors: [{ category: 'WARNING', type: 'UNABLE_TO_CANCEL' }] }],
    ['NOTHING_CANCELLED', { errors: [{ category: 'WARNING', type: 'NO_ITEMS_CANCELLED' }] }],
    ['UNVERIFIED', { errors: [{ category: 'WARNING', type: 'UNABLE_TO_RETRIEVE_BOOKING' }] }],
    ['FAILED', { errors: [{ category: 'CANCELLATION_ERROR', type: 'UNABLE_TO_CANCEL' }] }],
  ];

  it.each(RAMAS)('la rama %s se alcanza por la puerta pública', async (expected, payload) => {
    const outcome = await post(payload, SABRE_CANCEL_BOOKING_PATH);
    expect(outcome.rejected, `${expected}: postJson lanzó antes de llegar al mapper`).toBe(false);
    expect(
      mapSabreCancelResponse(outcome.result?.data, { requestedPolicy: 'ALLOW_PARTIAL_CANCEL' })
        .outcome,
    ).toBe(expected);
  });

  it('las seis ramas del vocabulario del mapper quedan cubiertas', () => {
    // Si alguien añade una rama nueva al mapper, este número deja de cuadrar y hay que decidir a
    // mano si su sobre es alcanzable. Es la misma disciplina que la guarda anti-recurrencia.
    expect(new Set(RAMAS.map(([name]) => name)).size).toBe(6);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (5) EL CARRIL SIN LOCALIZADOR CONSERVA LA CLASIFICACIÓN DE INFRAESTRUCTURA
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(5) en cancelBooking sólo se tolera lo que un mapper puede leer', () => {
  const NO_TOLERADOS: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      'entitlement: es alta comercial, no un desenlace',
      { errors: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }] },
      'ENTITLEMENT',
    ],
    [
      'error de servidor dentro del 200: cuenta para el breaker',
      { errors: [{ category: 'INTERNAL_SERVER_ERROR', type: 'PROCESSING_ERROR' }] },
      'UPSTREAM',
    ],
    [
      'carril de sesión ATH: Sabre pide reintentar la transacción',
      { errors: [{ category: 'APPLICATION_ERROR', type: 'ATH_TOKEN_FAILURE' }] },
      'SESSION',
    ],
    [
      'el sistema de fondo no pudo procesar',
      { errors: [{ category: 'APPLICATION_ERROR', type: 'FAULT_RESPONSE' }] },
      'UPSTREAM',
    ],
  ];

  it.each(NO_TOLERADOS)('%s → SabreApiError con kind %s', async (_name, payload, kind) => {
    const outcome = await post(payload, SABRE_CANCEL_BOOKING_PATH);
    expect(outcome.rejected).toBe(true);
    expect(outcome.error?.failure.kind).toBe(kind);
  });

  it('un item sin las dos casillas que el contrato exige no es un `Error` del contrato', async () => {
    // `Error` declara `category` y `type` como `required` (`:4271-4302`). Y esto cierra de paso, sin
    // lista que mantener, todas las categorías que el clasificador SINTETIZA: ninguna trae `type`.
    for (const payload of [
      { errors: ['Booking failed'] },
      { errors: [{ category: 'WARNING' }] },
      { errors: [{ type: 'NO_ITEMS_CANCELLED' }] },
      { errors: [{ status: 'NotProcessed' }] },
      { errors: [42] },
    ]) {
      const outcome = await post(payload, SABRE_CANCEL_BOOKING_PATH);
      expect(outcome.rejected, JSON.stringify(payload)).toBe(true);
    }
  });

  it('el mismo entitlement CON localizador sí se entrega, y es una decisión, no un descuido', async () => {
    // El coste está escrito en `SabrePartialOutcomeEvidence`: con localizador hay un PNR ahí fuera y
    // tirarlo es irreversible, así que se entrega y el entitlement viaja por el log y por
    // `partialUnauthorized` en vez de por el breaker.
    const outcome = await post(
      {
        confirmationId: 'GLEBNY',
        errors: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
      },
      SABRE_CREATE_BOOKING_PATH,
    );

    expect(outcome.rejected).toBe(false);
    expect(outcome.result?.partialUnauthorized).toHaveLength(1);
    expect(outcome.logs.some((line) => line.message === 'sabre.http.entitlement_parcial')).toBe(
      true,
    );
  });

  it('las clases tolerables son dos y están dichas, no inferidas', () => {
    expect([...SABRE_MAPPABLE_PARTIAL_KINDS].sort()).toEqual(['BUSINESS', 'HUMAN_REVIEW']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (6) EL EJE FALLA CERRADO
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(6) el desenlace parcial sólo existe donde el contrato lo declara', () => {
  it('la lista es cerrada y son las dos operaciones que tienen mapper', () => {
    expect(SABRE_PARTIAL_OUTCOME_CONTRACTS.map((contract) => contract.path)).toEqual([
      SABRE_CREATE_BOOKING_PATH,
      SABRE_CANCEL_BOOKING_PATH,
    ]);
  });

  it('el MISMO sobre se invierte según la operación', async () => {
    const aceptadas: string[] = [];
    for (const path of [
      SABRE_CREATE_BOOKING_PATH,
      SHOP_PATH,
      GET_BOOKING_PATH,
      '/v1/ancillaries/remove',
      '/v5/get/hotelavail',
      '/v1/trip/orders/fulfillFlightTickets',
      '/v1/trip/orders/modifyBooking',
      '/',
    ]) {
      if (!(await post(CREATE_PARTIAL_SEAT, path)).rejected) aceptadas.push(path);
    }
    expect(aceptadas).toEqual([SABRE_CREATE_BOOKING_PATH]);
  });

  it('la ruta se reconoce con la caja del contrato, con query y con barra final', async () => {
    for (const path of [
      '/v1/trip/orders/createBooking',
      '/v1/trip/orders/createbooking',
      '/v1/trip/orders/createBooking/',
      '/v1/trip/orders/createBooking?trace=1',
      '/v1/trip/orders/createBooking#tramo',
    ]) {
      expect((await post(CREATE_PARTIAL_SEAT, path)).rejected, path).toBe(false);
    }
  });

  it('una ruta que sólo CONTIENE la operación no hereda su permiso', async () => {
    const outcome = await post(CREATE_PARTIAL_SEAT, '/v1/trip/orders/createBooking/v5/offers/shop');
    expect(outcome.rejected).toBe(true);
  });

  it('sin contexto de operación el default es NO tolerar', () => {
    // Único bloque que no entra por `postJson`, y a propósito: el cliente siempre pasa la ruta, así
    // que este default sólo lo ve quien llame a la función a pelo — y es justo donde un olvido
    // tendría que fallar cerrado.
    const verdict = classifySabreEnvelope(CREATE_PARTIAL_SEAT);
    expect(verdict.ok).toBe(false);
    expect(verdict.partialOutcome).toBe(false);
  });

  it('un sobre limpio nunca marca desenlace parcial', () => {
    const verdict = classifySabreEnvelope(
      { confirmationId: 'GLEBNY' },
      { path: SABRE_CREATE_BOOKING_PATH },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.partialOutcome).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (7) EL CABLEADO — qué sale por el log de una entrega tolerada
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(7) una entrega tolerada se ve en el log, y no lleva texto libre', () => {
  it('se loguea como `warn`, no como `ok`', async () => {
    const outcome = await post(CREATE_PARTIAL_SEAT, SABRE_CREATE_BOOKING_PATH);
    const parcial = outcome.logs.find((line) => line.message === 'sabre.http.desenlace_parcial');

    expect(parcial?.level).toBe('warn');
    expect(outcome.logs.some((line) => line.message === 'sabre.http.ok')).toBe(false);
    expect(parcial?.meta).toContain('UNABLE_TO_BOOK_SEAT');
    expect(parcial?.meta).toContain('envelopeNodes');
  });

  it('el log del desenlace parcial no publica la prosa del proveedor', async () => {
    const outcome = await post(CREATE_PARTIAL_SEAT, SABRE_CREATE_BOOKING_PATH);
    const dump = outcome.logs.map((line) => line.meta).join('');

    expect(dump).not.toContain('Ana Perez');
    expect(dump).not.toContain('no longer available');
  });

  it('un sobre limpio sigue logueando `sabre.http.ok` con sus nodos', async () => {
    const outcome = await post({ confirmationId: 'GLEBNY' }, SABRE_CREATE_BOOKING_PATH);
    const ok = outcome.logs.find((line) => line.message === 'sabre.http.ok');
    expect(ok?.level).toBe('debug');
    expect(ok?.meta).toContain('envelopeNodes');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (8) LA BATERÍA HOSTIL, POR LAS DOS RUTAS DE DINERO
 *
 * Los sobres de `envelope-bypass.e2e.test.ts` se miden aquí otra vez y también por
 * `cancelBooking`, que es la ruta que este cambio abre y que hasta ahora nadie barría.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(8) los sobres hostiles siguen bloqueados en createBooking y en cancelBooking', () => {
  const HOSTILES: ReadonlyArray<readonly [string, unknown]> = [
    ['errors[] a profundidad >= 4', { a: { b: { c: { d: { errors: [{ category: 'A' }] } } } } }],
    [
      'errors[] dentro de un elemento de array',
      { orders: [{ confirmationId: 'ABC123' }, { errors: [{ category: 'A', type: 'B' }] }] },
    ],
    [
      'ApplicationResults NotProcessed dentro de un array',
      { results: [{ ApplicationResults: { status: 'NotProcessed' } }] },
    ],
    ['errors: ["texto plano"]', { errors: ['Booking failed: no seats available'] }],
    ['errors como objeto', { errors: { category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' } }],
    ['soapFault', { soapFault: { faultstring: 'Backend unavailable' } }],
    ['error como cadena suelta', { error: 'invalid_grant' }],
    ['messages[] sin severity ni type', { messages: [{ content: 'Booking failed' }] }],
    ['messages[] con code ERR.* de hoteles', { messages: [{ code: 'ERR.0161' }] }],
    ['status NotProcessed en la raiz', { status: 'NotProcessed', data: {} }],
    ['errors[] dentro de un `status` objeto', { status: { errors: [{ category: 'A' }] } }],
    ['Fault de SOAP con faultcode', { Fault: { faultcode: 'soap:Server' } }],
    ['exception sin campos reconocibles', { exception: { message: 'NullPointerException' } }],
    ['clave con sufijo Error', { bookingApplicationError: { type: 'UNABLE_TO_CREATE' } }],
    // La «е» es CIRÍLICA: se lee `errors` en pantalla y no lo es. No puede perdonarse en ninguna
    // de las dos operaciones, porque perdonar es perdonar una clave que el contrato declara.
    ['clave no-ASCII que finge ser el portador', { ['еrrors']: [{ category: 'A', type: 'B' }] }],
    ['cuerpo vacio', {}],
    ['escalar', 'OK'],
    [
      'Errors sepultado bajo dos arrays',
      { trip: { orders: [{ orderItems: [{ detail: { Errors: [{ category: 'A' }] } }] }] } },
    ],
  ];

  it.each(HOSTILES)('%s se rechaza en createBooking', async (_name, payload) => {
    const outcome = await post(payload, SABRE_CREATE_BOOKING_PATH);
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toBeInstanceOf(SabreApiError);
    expect(outcome.calls).toBe(1);
  });

  it.each(HOSTILES)('%s se rechaza en cancelBooking', async (_name, payload) => {
    const outcome = await post(payload, SABRE_CANCEL_BOOKING_PATH);
    expect(outcome.rejected).toBe(true);
    expect(outcome.error).toBeInstanceOf(SabreApiError);
    expect(outcome.calls).toBe(1);
  });

  it('los mismos hostiles CON un localizador prestado tampoco pasan', async () => {
    // El localizador no es un salvoconducto: sólo cuenta cuando TODO el fallo está en el portador
    // de la raíz. Se excluyen del barrido los sobres cuyo problema ESTÁ en ese portador —los dos
    // `errors` de la raíz y las formas que no son objeto—, porque ésos, con localizador delante,
    // son exactamente el desenlace parcial que este cambio existe para entregar; el bloque (3) los
    // mide uno a uno. El resto entierra el problema en otro sitio y sigue rechazando.
    const fuera = new Set([
      'errors: ["texto plano"]',
      'errors como objeto',
      'cuerpo vacio',
      'escalar',
    ]);

    for (const [name, payload] of HOSTILES) {
      if (fuera.has(name)) continue;
      const record = payload as Record<string, unknown>;
      const outcome = await post(
        { confirmationId: 'GLEBNY', booking: { bookingId: 'GLEBNY' }, ...record },
        SABRE_CREATE_BOOKING_PATH,
      );
      expect(outcome.rejected, name).toBe(true);
    }
  });

  it('y el sobre EXCLUIDO del barrido se entrega a propósito, con su coste medido', async () => {
    // `errors: ["texto plano"]` con localizador delante: el array es la forma que el contrato
    // declara y el problema está donde el contrato dice que estará. Se entrega, el Zod del mapper
    // rechaza el elemento suelto y `salvageLocator` conserva el PNR — que es todo el objetivo.
    const outcome = await post(
      { confirmationId: 'GLEBNY', errors: ['Booking failed: no seats available'] },
      SABRE_CREATE_BOOKING_PATH,
    );

    expect(outcome.rejected).toBe(false);
    const mapped = mapSabreCreateBookingResponse(outcome.result?.data);
    expect(mapped.order.outcome).toBe('PARTIAL');
    expect(mapped.order.pnr).toBe('GLEBNY');
  });
});
