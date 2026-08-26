import { describe, expect, it } from 'vitest';
import { parseSabreIndex } from '../indices';
import {
  SABRE_CANCEL_BOOKING_PATH,
  SABRE_CANCEL_DEFAULT_POLICY,
  SABRE_CHECK_FLIGHT_TICKETS_PATH,
  SABRE_QUEUE_NUMBER_MAX,
  SABRE_QUEUE_NUMBER_MIN,
  SabreCancelBookingBuildError,
  buildSabreCancelBookingRequest,
  describeSabreCancelRequest,
  readSabreTicketCheck,
  requiresTicketCheck,
  sabreCancelIdempotencyKey,
} from './cancel.request.builder';
import type {
  SabreCancelBookingOptions,
  SabreCancelBookingRequest,
  SabreCancelRule,
  SabreCancelSegmentRef,
  SabreTicketCheckEvidence,
} from './cancel.request.builder';
import type { SabreBookingItem } from './get.response.mapper';

const PNR = 'GLEBNY';

const atpcoFlight: SabreBookingItem = { itemId: '1', kind: 'FLIGHT', lane: 'ATPCO' };
const ndcFlight: SabreBookingItem = { itemId: '7', kind: 'FLIGHT', lane: 'NDC' };
const otherNdcFlight: SabreBookingItem = { itemId: '8', kind: 'FLIGHT', lane: 'NDC' };
const hotel: SabreBookingItem = { itemId: '42', kind: 'HOTEL' };

/** Respuesta de `checkFlightTickets` con una oferta de cancelación NDC vigente. */
function checkTicketsResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-26T10:00:00Z',
    request: { confirmationId: PNR },
    tickets: [{ number: '0167489825830', isVoidable: false, isRefundable: true }],
    cancelOffers: [
      {
        offerType: 'REFUND',
        offerItemId: 'cb7778589bcbklg7tkkp8sdo50',
        offerExpirationDate: '2026-08-30',
        offerExpirationTime: '09:25',
      },
    ],
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}): SabreTicketCheckEvidence {
  return readSabreTicketCheck(checkTicketsResponse(overrides), { confirmationId: PNR });
}

function ruleOf(run: () => unknown): SabreCancelRule {
  try {
    run();
  } catch (error) {
    if (error instanceof SabreCancelBookingBuildError) return error.rule;
    throw error;
  }
  throw new Error('no lanzó: se esperaba un SabreCancelBookingBuildError');
}

describe('cancelBooking — CRITERIO DE SALIDA: NDC no se cancela sin checkFlightTickets previo', () => {
  const ndcCancelAll: SabreCancelBookingOptions = {
    confirmationId: PNR,
    scope: 'ALL',
    content: { items: [ndcFlight], isTicketed: true },
  };

  it('sin la evidencia, la construcción FALLA', () => {
    // Ésta es la prueba del criterio de salida de la Fase 3. Cancelar contenido NDC sin haber
    // comprobado el estado del billete es mandar una cancelación a ciegas sobre un documento que
    // puede estar emitido: es como se pierde dinero de verdad.
    expect(ruleOf(() => buildSabreCancelBookingRequest(ndcCancelAll))).toBe(
      'NDC_CANCEL_WITHOUT_TICKET_CHECK',
    );
  });

  it('con la evidencia, se construye', () => {
    const request = buildSabreCancelBookingRequest({
      ...ndcCancelAll,
      ticketCheck: evidence(),
      offerItemId: 'cb7778589bcbklg7tkkp8sdo50',
      now: '2026-08-26T12:00:00Z',
    });
    expect(request.cancelAll).toBe(true);
    expect(request.offerItemId).toBe('cb7778589bcbklg7tkkp8sdo50');
  });

  it('la evidencia no se puede fabricar a mano: sólo la produce readSabreTicketCheck', () => {
    // @ts-expect-error un objeto literal no lleva la marca `__sabreTicketCheck` que pone el lector.
    const forged: SabreTicketCheckEvidence = {
      confirmationId: PNR,
      checkedAt: '2026-08-26T10:00:00Z',
      cancelOffers: [],
      tickets: [],
    };
    expect(forged.confirmationId).toBe(PNR);
  });

  it('fail-closed: un vuelo cuyo carril no conocemos también exige la comprobación', () => {
    // "No sé si es NDC" se trata como "puede serlo". El coste de equivocarse hacia este lado es
    // una llamada de lectura; hacia el otro, un billete emitido cancelado a ciegas.
    const unknownLane: SabreBookingItem = { itemId: '1', kind: 'FLIGHT' };
    expect(requiresTicketCheck({ items: [unknownLane] })).toBe(true);
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: { items: [unknownLane] },
        }),
      ),
    ).toBe('NDC_CANCEL_WITHOUT_TICKET_CHECK');
  });

  it('fail-closed: reserva emitida cuya lectura no vio vuelos', () => {
    expect(requiresTicketCheck({ items: [hotel], isTicketed: true })).toBe(true);
  });

  it('contenido ATPCO sin emitir NO exige la comprobación', () => {
    expect(requiresTicketCheck({ items: [atpcoFlight, hotel], isTicketed: false })).toBe(false);
    expect(() =>
      buildSabreCancelBookingRequest({
        confirmationId: PNR,
        scope: 'ALL',
        content: { items: [atpcoFlight], isTicketed: false },
      }),
    ).not.toThrow();
  });

  it('una reserva sólo de hotel, sin emitir, tampoco', () => {
    expect(requiresTicketCheck({ items: [hotel] })).toBe(false);
  });
});

describe('cancelBooking — la evidencia se ata a SU reserva', () => {
  it('una evidencia de otra reserva se rechaza al leerla', () => {
    expect(
      ruleOf(() =>
        readSabreTicketCheck(checkTicketsResponse({ request: { confirmationId: 'OTHER1' } }), {
          confirmationId: PNR,
        }),
      ),
    ).toBe('TICKET_CHECK_FOR_ANOTHER_BOOKING');
  });

  it('y también al construir, si se cambia el PNR por el camino', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: 'ZZZ999',
          scope: 'ALL',
          content: { items: [ndcFlight] },
          ticketCheck: evidence(),
        }),
      ),
    ).toBe('TICKET_CHECK_FOR_ANOTHER_BOOKING');
  });

  it('una respuesta que no es un CheckTicketsResponse no produce evidencia', () => {
    expect(ruleOf(() => readSabreTicketCheck('OK', { confirmationId: PNR }))).toBe(
      'TICKET_CHECK_MALFORMED',
    );
  });

  it('sin eco de confirmationId la evidencia vale: el eco es opcional en el contrato', () => {
    const read = readSabreTicketCheck(checkTicketsResponse({ request: {} }), {
      confirmationId: PNR,
    });
    expect(read.confirmationId).toBe(PNR);
    expect(read.cancelOffers).toHaveLength(1);
  });

  it('el checkedAt sale del timestamp de la respuesta', () => {
    expect(evidence().checkedAt).toBe('2026-08-26T10:00:00Z');
  });
});

describe('cancelBooking — la oferta de cancelación no se inventa ni se recicla', () => {
  it('un offerItemId que no salió del check se rechaza', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: { items: [ndcFlight] },
          ticketCheck: evidence(),
          offerItemId: 'inventado-0000',
        }),
      ),
    ).toBe('OFFER_ITEM_ID_NOT_OFFERED');
  });

  it('una oferta caducada se rechaza', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: { items: [ndcFlight] },
          ticketCheck: evidence(),
          offerItemId: 'cb7778589bcbklg7tkkp8sdo50',
          // La oferta caduca el 2026-08-30 a las 09:25 UTC.
          now: '2026-08-30T09:26:00Z',
        }),
      ),
    ).toBe('CANCEL_OFFER_EXPIRED');
  });

  it('justo antes de caducar, todavía vale', () => {
    expect(() =>
      buildSabreCancelBookingRequest({
        confirmationId: PNR,
        scope: 'ALL',
        content: { items: [ndcFlight] },
        ticketCheck: evidence(),
        offerItemId: 'cb7778589bcbklg7tkkp8sdo50',
        now: '2026-08-30T09:24:00Z',
      }),
    ).not.toThrow();
  });

  it('offerItemId y flightTicketOperation son excluyentes (RF-10 CA-2)', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: { items: [ndcFlight] },
          ticketCheck: evidence(),
          offerItemId: 'cb7778589bcbklg7tkkp8sdo50',
          ticketOperation: 'REFUND',
        }),
      ),
    ).toBe('INVALID_FLAGS_COMBINATION');
  });
});

describe('cancelBooking — las órdenes NDC se cancelan enteras', () => {
  it('dejar un segmento NDC vivo se rechaza antes de llamar', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ITEMS',
          items: [{ itemId: ndcFlight.itemId, kind: 'FLIGHT' }],
          content: { items: [ndcFlight, otherNdcFlight] },
          ticketCheck: evidence(),
        }),
      ),
    ).toBe('NDC_ORDER_PARTIAL_CANCEL');
  });

  it('seleccionarlos todos sí vale', () => {
    expect(() =>
      buildSabreCancelBookingRequest({
        confirmationId: PNR,
        scope: 'ITEMS',
        items: [
          { itemId: ndcFlight.itemId, kind: 'FLIGHT' },
          { itemId: otherNdcFlight.itemId, kind: 'FLIGHT' },
        ],
        content: { items: [ndcFlight, otherNdcFlight] },
        ticketCheck: evidence(),
      }),
    ).not.toThrow();
  });

  it('cancelar sólo el hotel de una reserva con NDC no toca la orden NDC', () => {
    expect(() =>
      buildSabreCancelBookingRequest({
        confirmationId: PNR,
        scope: 'ITEMS',
        items: [{ itemId: hotel.itemId, kind: 'HOTEL' }],
        content: { items: [ndcFlight, hotel] },
        ticketCheck: evidence(),
      }),
    ).not.toThrow();
  });
});

describe('cancelBooking — combinaciones que el catálogo oficial rechaza', () => {
  const atpco = { items: [atpcoFlight, hotel], isTicketed: false };

  it('cancelAll con listas: INVALID_FLAGS_COMBINATION', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          items: [{ itemId: '1', kind: 'FLIGHT' }],
          content: atpco,
        }),
      ),
    ).toBe('INVALID_FLAGS_COMBINATION');
  });

  it('sin cancelAll y sin nada que cancelar: CANCEL_DATA_MISSING', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({ confirmationId: PNR, scope: 'ITEMS', content: atpco }),
      ),
    ).toBe('CANCEL_DATA_MISSING');
  });

  it('cancelAll con notificación por correo: INVALID_FLAGS_COMBINATION', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: atpco,
          notification: { email: 'ITINERARY' },
        }),
      ),
    ).toBe('INVALID_FLAGS_COMBINATION');
  });

  it('un segmento sin id ni sequence: SEGMENT_REFERENCE_MISSING', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'SEGMENTS',
          segments: [{}],
          content: atpco,
        }),
      ),
    ).toBe('SEGMENT_REFERENCE_MISSING');
  });

  it('un itemId numérico se rechaza: el contrato lo declara string', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ITEMS',
          // Así llega desde JavaScript sin tipos, que es por donde entra de verdad.
          items: [{ itemId: 9 as unknown as string, kind: 'FLIGHT' }],
          content: atpco,
        }),
      ),
    ).toBe('ITEM_ID_INVALID');
  });

  it('receivedFrom se acota a un identificador: no es un campo de texto libre', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: atpco,
          receivedFrom: 'Cancelado por Ana Pérez, pasajera del vuelo <script>',
        }),
      ),
    ).toBe('RECEIVED_FROM_INVALID');
  });

  it('queuePlacement admite entre 1 y 3 colas', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: atpco,
          notification: { queueNumbers: [1, 2, 3, 4] },
        }),
      ),
    ).toBe('INVALID_FLAGS_COMBINATION');
  });

  it('la retención exige fecha y etiqueta válidas', () => {
    expect(
      ruleOf(() =>
        buildSabreCancelBookingRequest({
          confirmationId: PNR,
          scope: 'ALL',
          content: atpco,
          retention: { endDate: '30/01/2026', label: 'RETENTION DATE' },
        }),
      ),
    ).toBe('RETENTION_INVALID');
  });
});

describe('cancelBooking — el cuerpo que sale', () => {
  const atpco = { items: [atpcoFlight, hotel], isTicketed: false };

  it('la política de errores viaja SIEMPRE explícita', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ALL',
      content: atpco,
    });
    // El default del contrato es el mismo, pero es una promesa del proveedor que puede cambiar de
    // versión, y de este flag depende si la cancelación multi-producto hace rollback.
    expect(request.errorHandlingPolicy).toBe(SABRE_CANCEL_DEFAULT_POLICY);
    expect(request.errorHandlingPolicy).toBe('HALT_ON_ERROR');
    expect(request.cancelAll).toBe(true);
    expect(request.retrieveBooking).toBe(false);
  });

  it('la variante del Package Studio: vuelos + hoteles + coches por itemId', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ITEMS',
      items: [
        { itemId: '1', kind: 'FLIGHT' },
        { itemId: '42', kind: 'HOTEL' },
        { itemId: '22', kind: 'CAR' },
      ],
      content: { items: [atpcoFlight, hotel, { itemId: '22', kind: 'CAR' }] },
    });
    expect(request.flights).toEqual([{ itemId: '1' }]);
    expect(request.hotels).toEqual([{ itemId: '42' }]);
    expect(request.cars).toEqual([{ itemId: '22' }]);
    expect(request.cancelAll).toBe(false);
  });

  it('los segmentos por sequence pasan por indices.ts', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'SEGMENTS',
      segments: [{ sequence: parseSabreIndex(1) }, { id: 'A38' }],
      content: atpco,
    });
    expect(request.segments).toEqual([{ sequence: 1 }, { id: 'A38' }]);
  });

  it('no se puede colar una posición de array como sequence', () => {
    // @ts-expect-error `sequence` es `SabreIndex`: un entero escrito a mano —o una posición de
    // array— no compila, y el único camino legal pasa por `indices.ts`.
    const forbidden: SabreCancelSegmentRef = { sequence: 1 };
    expect(forbidden.sequence).toBe(1);
  });

  it('sólo emite campos del contrato', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ALL',
      content: atpco,
      ticketOperation: 'VOID',
      targetPcc: 'G7RE',
      receivedFrom: 'agencia-042',
      voidNonElectronicTickets: true,
      refundDocumentsType: 'Tickets and EMDs',
    });
    expect(Object.keys(request).sort()).toEqual([
      'bookingSource',
      'cancelAll',
      'confirmationId',
      'errorHandlingPolicy',
      'flightTicketOperation',
      'receivedFrom',
      'refundDocumentsType',
      'retrieveBooking',
      'targetPcc',
      'voidNonElectronicTickets',
    ]);
  });
});

describe('cancelBooking — idempotencia', () => {
  const atpco = { items: [atpcoFlight, hotel] };

  const twoItems = (order: 'asc' | 'desc'): SabreCancelBookingOptions => ({
    confirmationId: PNR,
    scope: 'ITEMS',
    items:
      order === 'asc'
        ? [
            { itemId: '1', kind: 'FLIGHT' as const },
            { itemId: '2', kind: 'FLIGHT' as const },
          ]
        : [
            { itemId: '2', kind: 'FLIGHT' as const },
            { itemId: '1', kind: 'FLIGHT' as const },
          ],
    content: {
      items: [
        { itemId: '1', kind: 'FLIGHT', lane: 'ATPCO' },
        { itemId: '2', kind: 'FLIGHT', lane: 'ATPCO' },
      ],
    },
  });

  it('dos construcciones idénticas dan la misma clave', () => {
    const one = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ALL',
      content: atpco,
    });
    const other = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ALL',
      content: atpco,
    });
    expect(sabreCancelIdempotencyKey(one)).toBe(sabreCancelIdempotencyKey(other));
  });

  it('el orden de la lista de ítems NO cambia la clave: es la misma operación', () => {
    const ascending = buildSabreCancelBookingRequest(twoItems('asc'));
    const descending = buildSabreCancelBookingRequest(twoItems('desc'));
    expect(ascending.flights).toEqual(descending.flights);
    expect(sabreCancelIdempotencyKey(ascending)).toBe(sabreCancelIdempotencyKey(descending));
  });

  it('cancelar otra cosa da otra clave', () => {
    const all = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ALL',
      content: atpco,
    });
    const partial = buildSabreCancelBookingRequest(twoItems('asc'));
    expect(sabreCancelIdempotencyKey(all)).not.toBe(sabreCancelIdempotencyKey(partial));
  });

  it('la clave es un sha256 hexadecimal', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ALL',
      content: atpco,
    });
    expect(sabreCancelIdempotencyKey(request)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cancelBooking — el log no lleva identificadores', () => {
  it('describe cuenta la forma, no los valores', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ITEMS',
      items: [{ itemId: '42', kind: 'HOTEL' }],
      content: { items: [hotel] },
      targetPcc: 'G7RE',
    });
    const described = JSON.stringify(describeSabreCancelRequest(request));
    expect(described).not.toContain(PNR);
    expect(described).not.toContain('G7RE');
    expect(described).toContain('"hotels":1');
  });

  it('cancelar por sequence deja el aviso escrito en el log', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'SEGMENTS',
      segments: [{ sequence: parseSabreIndex(3) }],
      content: { items: [hotel] },
    });
    // La posición se renumera entre la lectura y la cancelación: quien la use tiene que verlo.
    expect(describeSabreCancelRequest(request)['advisory']).toContain('sequence');
  });

  it('cancelar por id no lo deja', () => {
    const request = buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'SEGMENTS',
      segments: [{ id: 'A38' }],
      content: { items: [hotel] },
    });
    expect(describeSabreCancelRequest(request)['advisory']).toBeUndefined();
  });
});

describe('cancelBooking — las rutas son las del contrato', () => {
  it('cancelBooking y checkFlightTickets cuelgan de basePath /v1/trip/orders', () => {
    expect(SABRE_CANCEL_BOOKING_PATH).toBe('/v1/trip/orders/cancelBooking');
    expect(SABRE_CHECK_FLIGHT_TICKETS_PATH).toBe('/v1/trip/orders/checkFlightTickets');
  });
});

/**
 * La cota del VALOR de la cola, que faltaba mientras la del TAMAÑO del array ya estaba.
 *
 * `Queue.queueNumber` — `booking-management-v1.yml:4558-4563`: `integer`, `minimum: 0`,
 * `maximum: 999`; `NotificationQueue` (`:8586-8591`) lo hereda por `allOf`. Un `queueNumber`
 * fuera de rango no rompe la cancelación: la reserva se encola donde nadie la mira, que es un
 * fallo silencioso y por eso más caro.
 *
 * Todo entra por {@link buildSabreCancelBookingRequest}, la puerta pública del builder.
 */
describe('cancelBooking — el rango de queueNumber, no sólo cuántas colas', () => {
  const atpcoContent = { items: [atpcoFlight] };

  function cancelWithQueues(queueNumbers: readonly number[]): SabreCancelBookingRequest {
    return buildSabreCancelBookingRequest({
      confirmationId: PNR,
      scope: 'ALL',
      content: atpcoContent,
      notification: { queueNumbers },
    });
  }

  it('las cotas son las del contrato', () => {
    expect(SABRE_QUEUE_NUMBER_MIN).toBe(0);
    expect(SABRE_QUEUE_NUMBER_MAX).toBe(999);
  });

  it('los dos extremos del rango pasan', () => {
    expect(cancelWithQueues([0, 999]).notification).toEqual({
      queuePlacement: [{ queueNumber: 0 }, { queueNumber: 999 }],
    });
  });

  it('una cola por encima del máximo se rechaza ANTES de salir al cable', () => {
    expect(ruleOf(() => cancelWithQueues([1000]))).toBe('QUEUE_NUMBER_INVALID');
  });

  it('una cola negativa se rechaza', () => {
    expect(ruleOf(() => cancelWithQueues([-1]))).toBe('QUEUE_NUMBER_INVALID');
  });

  it('la validación mira TODAS las colas, no sólo la primera', () => {
    expect(ruleOf(() => cancelWithQueues([12, 4000]))).toBe('QUEUE_NUMBER_INVALID');
  });

  it('el contrato dice `integer`: ni decimales ni NaN ni Infinity', () => {
    for (const value of [12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        ruleOf(() => cancelWithQueues([value])),
        String(value),
      ).toBe('QUEUE_NUMBER_INVALID');
    }
  });

  it('el mensaje nombra la cota y NUNCA el valor: esta línea acaba en un log', () => {
    try {
      cancelWithQueues([424242]);
      throw new Error('no lanzó');
    } catch (error) {
      expect(error).toBeInstanceOf(SabreCancelBookingBuildError);
      expect((error as Error).message).not.toContain('424242');
      expect((error as Error).message).toContain('999');
    }
  });

  it('el rechazo por rango es un motivo PROPIO, no el de la combinación de flags', () => {
    // Son dos fallos distintos y el saga los cuenta distinto: uno es «mandaste demasiadas
    // colas», el otro «mandaste una cola que no existe».
    expect(ruleOf(() => cancelWithQueues([1, 2, 3, 4]))).toBe('INVALID_FLAGS_COMBINATION');
    expect(ruleOf(() => cancelWithQueues([1000]))).toBe('QUEUE_NUMBER_INVALID');
  });
});
