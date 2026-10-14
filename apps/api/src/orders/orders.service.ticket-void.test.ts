import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  OrderCancelResult,
  OrderView,
  SearchContext,
  TicketCheckResult,
} from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  TICKET_VOID_NOT_AVAILABLE_MESSAGE,
  TicketVoidNotAvailableError,
  type OrderCancelAudit,
  type OrderCancelScope,
} from '../providers/provider.types.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { memoryHotelCancellation, type Row } from './__fixtures__/memory-hotel-cancellation.js';
import type { FlightOrderTrackingStore } from './flight-order-tracking.store.js';
import { ORDER_EVENTS } from './order-events.js';
import type { HotelOrderCancellationService } from './hotel-order-cancellation.service.js';
import { OrdersService, type OrderRow } from './orders.service.js';
import { STALE_CANCEL_CLAIM_MS, StaleCancelClaimService } from './stale-cancel-claim.service.js';
import {
  TICKET_VOID_MESSAGES,
  TICKET_VOID_REASONS,
  VOID_UNVERIFIED_LAST_ERROR,
} from './ticket-void.plan.js';

/**
 * Anular (VOID) los tiquetes de una reserva emitida por la puerta pública de `OrdersService`
 * (SAB-09). El proveedor es anónimo y contesta lo que contestaría el adapter de Sabre por el puerto
 * neutral (`cancelOrderAudited` con `ticketOperation` y `TicketingPort.checkTickets`); la base es el
 * doble con transacciones que se deshacen enteras y el índice de la cancelación pendiente (0037).
 *
 * Lo que se prueba es lo que protege el dinero: una emitida no se cancela sin decir qué pasa con
 * sus tiquetes, la anulación sólo sale con la consulta en vivo a favor, y un desenlace a medias o
 * sin confirmar se concilia y nunca se repite.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AIR = 'stub-air';
const ORDEN = 'f1';
const PNR = 'PNR123';
const TIQUETE = '0016802004060';

const PRICING = { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService;

function ordenEmitida(extra: Row = {}): Row {
  return {
    id: ORDEN,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: AIR,
    provider_order_id: PNR,
    status: 'ticketed',
    search_criteria: { origin: 'BOG', destination: 'LIM', departureDate: '2099-10-20' },
    selected_offer: { provider: { name: AIR, offerRef: 'R-1' } },
    passengers: [{ givenName: 'Ana', surname: 'Pérez', paxType: 'ADT' }],
    contact_info: { email: 'ana@x.test' },
    total_amount: 34_012,
    currency: 'USD',
    order_number: 7,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: null,
    provider_account_id: null,
    created_at: new Date('2026-10-13T00:00:00Z'),
    updated_at: new Date('2026-10-13T00:00:00Z'),
    ...extra,
  };
}

/** Lo que el proveedor contesta a la consulta de condiciones. */
function condiciones(parcial: Partial<TicketCheckResult> = {}): TicketCheckResult {
  return {
    checkedAt: '2026-10-13T15:00:00.000Z',
    tickets: [{ number: TIQUETE, voidable: 'yes', refundable: 'yes' }],
    cancelOffers: [],
    ...parcial,
  };
}

function anulada(parcial: Partial<OrderCancelAudit> = {}): OrderCancelAudit {
  return {
    result: { success: true, warnings: [] },
    audit: { audited: true, called: true, ticketOperation: 'VOID', voidedTickets: 1 },
    idempotencyKey: 'a'.repeat(64),
    verified: true,
    ...parcial,
  };
}

/** La relectura después de anular: el tiquete con el estado dado. */
function lectura(status: 'VOIDED' | 'ISSUED'): OrderView {
  return {
    found: true,
    orderId: PNR,
    pnr: PNR,
    airlineLocators: [],
    documents: [{ number: TIQUETE, kind: 'TICKET', status, travelerIndex: 0 }],
    warnings: [],
  };
}

function banco(orders: Row[] = [ordenEmitida()], capacidades = { ticketCheck: true, void: true }) {
  const mem = memoryHotelCancellation({ orders });
  const audit = new RecordingAuditService();
  const queue = new RecordingQueueService();
  const settle = vi.fn(() => Promise.resolve('released' as const));
  const holds = { settle } as unknown as BookingHoldLedger;
  const recordRead = vi.fn(() => Promise.resolve({ added: 0, statusChanged: 1 }));
  const tracking = { recordRead } as unknown as FlightOrderTrackingStore;
  const vuelos = new StubProviderFactory({ code: AIR, capabilities: capacidades });
  const adapter = vuelos.adapterFor(TENANT);
  const checkTickets = vi.fn((_orderId: string, _ctx: SearchContext) =>
    Promise.resolve(condiciones()),
  );
  const cancelOrderAudited = vi.fn(
    (_orderId: string, _ctx: SearchContext, _scope?: OrderCancelScope) =>
      Promise.resolve(anulada()),
  );
  const issueTickets = vi.fn();
  Object.assign(adapter, { checkTickets, cancelOrderAudited, issueTickets });
  adapter.retrieveForDisplay.mockResolvedValue(lectura('VOIDED'));

  const service = new OrdersService(
    mem.db,
    new FlightProviderRegistry([vuelos], { decisionFor: () => Promise.resolve(undefined) }),
    queue.asService(),
    {} as unknown as AgentCarsProviderFactory,
    audit.asService(),
    PRICING,
    undefined,
    undefined,
    holds,
    tracking,
  );
  const fila = (): OrderRow => mem.order(ORDEN) as unknown as OrderRow;
  return {
    mem,
    audit,
    queue,
    settle,
    recordRead,
    adapter,
    checkTickets,
    cancelOrderAudited,
    service,
    anular: () => service.voidTickets(TENANT, fila(), USER),
    ultima: () => mem.operations(ORDEN).at(-1),
  };
}

async function rechazo(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('se esperaba un rechazo');
    },
    (error: unknown) => error,
  );
}

describe('una reserva emitida no se cancela sin decir qué pasa con sus tiquetes', () => {
  it('la cancelación genérica de una emitida se rechaza, en tú, sin tocar al proveedor', async () => {
    const b = banco();

    const error = await rechazo(b.service.cancelOrder(TENANT, ORDEN, PNR, USER));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(TICKET_VOID_MESSAGES.ticketedCancel);
    expect(b.cancelOrderAudited).not.toHaveBeenCalled();
    expect(b.mem.operations(ORDEN)).toEqual([]);
  });

  it('con ticketOperation VOID sí pasa, y el proveedor recibe el ámbito de la anulación', async () => {
    const b = banco();

    const run = await b.service.cancelOrder(TENANT, ORDEN, PNR, USER, { ticketOperation: 'VOID' });

    expect(run.voidOutcome).toBe('VOIDED');
    expect(b.cancelOrderAudited).toHaveBeenCalledWith(
      PNR,
      { tenantId: TENANT },
      {
        ticketOperation: 'VOID',
      },
    );
  });

  it('anular una reserva que no está emitida no tiene sentido: 409', async () => {
    const b = banco([ordenEmitida({ status: 'confirmed' })]);

    const error = await rechazo(
      b.service.cancelOrder(TENANT, ORDEN, PNR, USER, { ticketOperation: 'VOID' }),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(TICKET_VOID_MESSAGES.notTicketed);
    expect(b.cancelOrderAudited).not.toHaveBeenCalled();
  });

  it('un auto emitido no tiene anulación de tiquetes: 400 antes del claim', async () => {
    const b = banco([ordenEmitida({ provider: 'agent-cars' })]);

    const error = await rechazo(
      b.service.cancelOrder(TENANT, ORDEN, PNR, USER, { ticketOperation: 'VOID' }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect(b.mem.operations(ORDEN)).toEqual([]);
  });
});

describe('voidTickets: la consulta en vivo decide antes de tocar nada', () => {
  it('anulable: anula, deja la reserva cancelada, libera la cartera y guarda los documentos', async () => {
    const b = banco();

    const reply = await b.anular();

    expect(reply).toEqual({
      outcome: 'VOIDED',
      message: TICKET_VOID_MESSAGES.voided,
      orderStatus: 'cancelled',
    });
    expect(b.checkTickets).toHaveBeenCalledWith(PNR, { tenantId: TENANT });
    expect(b.mem.order(ORDEN)?.['status']).toBe('cancelled');
    expect(b.ultima()).toMatchObject({ type: 'cancel', status: 'success' });
    expect(b.mem.result(b.ultima())).toMatchObject({
      ticketOperation: 'VOID',
      voidOutcome: 'VOIDED',
      voidedTickets: 1,
      outcome: 'SUCCEEDED',
      priorOrderStatus: 'ticketed',
    });
    expect(b.settle).toHaveBeenCalledWith(TENANT, ORDEN, USER);
    // La relectura deja los documentos en VOIDED (0082) con su evento de cambio.
    expect(b.recordRead).toHaveBeenCalledOnce();
    expect(b.audit.ofType(ORDER_EVENTS.flightDocumentsChanged)).toMatchObject([
      { payload: { source: 'void', statusChanged: 1 } },
    ]);
    expect(b.audit.ofType(ORDER_EVENTS.cancelled)).toMatchObject([
      { payload: { success: true, ticketOperation: 'VOID', voidOutcome: 'VOIDED' } },
    ]);
    expect(b.audit.ofType(ORDER_EVENTS.ticketsVoided)).toMatchObject([
      {
        aggregateId: ORDEN,
        payload: { provider: AIR, ticketOperation: 'VOID', documents: 1, testContent: false },
      },
    ]);
    // Conteos, nunca el número del tiquete.
    expect(b.audit.dump()).not.toContain(TIQUETE);
    expect(b.queue.cancels).toEqual([]);
  });

  it.each([
    [
      'un tiquete ya no es anulable',
      condiciones({
        tickets: [{ number: TIQUETE, voidable: 'no', refundable: 'yes' }],
      }),
    ],
    [
      'el proveedor no dice si se puede',
      condiciones({
        tickets: [{ number: TIQUETE, voidable: 'unknown', refundable: 'yes' }],
      }),
    ],
    [
      'sólo hay oferta de reembolso',
      condiciones({
        tickets: [],
        cancelOffers: [{ offerRef: 'R1', kind: 'REFUND' }],
      }),
    ],
    [
      'la oferta de anulación ya venció',
      condiciones({
        tickets: [],
        cancelOffers: [{ offerRef: 'V1', kind: 'VOID', expiresAt: '2020-01-01T00:00:00.000Z' }],
      }),
    ],
  ])('%s: 409 con el motivo y no se toma ningún claim', async (_caso, check) => {
    const b = banco();
    b.checkTickets.mockResolvedValue(check);

    const error = await rechazo(b.anular());

    expect(error).toBeInstanceOf(TicketVoidNotAvailableError);
    expect((error as Error).message).toBe(TICKET_VOID_NOT_AVAILABLE_MESSAGE);
    expect(b.cancelOrderAudited).not.toHaveBeenCalled();
    expect(b.mem.operations(ORDEN)).toEqual([]);
    expect(b.mem.order(ORDEN)?.['status']).toBe('ticketed');
  });

  it('con la oferta VOID vigente se anula aunque el tiquete no diga nada (carril por oferta)', async () => {
    const b = banco();
    b.checkTickets.mockResolvedValue(
      condiciones({
        tickets: [],
        cancelOffers: [{ offerRef: 'V1', kind: 'VOID', expiresAt: '2099-01-01T00:00:00.000Z' }],
      }),
    );

    await expect(b.anular()).resolves.toMatchObject({ outcome: 'VOIDED' });
  });

  it('sin la capacidad `void` del proveedor, 400 sin consultar nada', async () => {
    const b = banco([ordenEmitida()], { ticketCheck: true, void: false });

    await expect(b.anular()).rejects.toBeInstanceOf(BadRequestException);
    expect(b.checkTickets).not.toHaveBeenCalled();
  });
});

describe('voidTickets: lo que pasa después de la consulta', () => {
  it('la ventana se cierra entre la consulta y la anulación: 409, sin reintento, y sigue emitida', async () => {
    const b = banco();
    b.cancelOrderAudited.mockRejectedValue(new TicketVoidNotAvailableError());

    const error = await rechazo(b.anular());

    expect(error).toBeInstanceOf(TicketVoidNotAvailableError);
    expect(b.mem.order(ORDEN)?.['status']).toBe('ticketed');
    expect(b.ultima()).toMatchObject({ status: 'failed' });
    expect(b.mem.result(b.ultima())).toMatchObject({
      ticketOperation: 'VOID',
      voidOutcome: 'REJECTED',
      retryable: false,
      reconciliationRequired: false,
    });
    expect(b.queue.cancels).toEqual([]);
    expect(b.settle).not.toHaveBeenCalled();
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
  });

  it('la aerolínea la rechaza y la relectura muestra los tiquetes vivos: 409, sigue emitida', async () => {
    const b = banco();
    b.cancelOrderAudited.mockResolvedValue(
      anulada({ result: { success: false, warnings: [], error: 'FAILED:UNABLE_TO_VOID_TICKET' } }),
    );
    b.adapter.retrieveForDisplay.mockResolvedValue(lectura('ISSUED'));

    const error = await rechazo(b.anular());

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(TICKET_VOID_MESSAGES.rejected);
    expect((error as ConflictException).getResponse()).toMatchObject({
      reason: TICKET_VOID_REASONS.rejected,
    });
    expect(b.mem.order(ORDEN)?.['status']).toBe('ticketed');
    expect(b.mem.result(b.ultima())).toMatchObject({
      voidOutcome: 'REJECTED',
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
    });
    expect(b.audit.ofType(ORDER_EVENTS.ticketsVoided)).toEqual([]);
  });

  it('rechazada pero con un tiquete anulado en la relectura: PARTIAL, se concilia y se escala', async () => {
    const b = banco();
    b.cancelOrderAudited.mockResolvedValue(
      anulada({ result: { success: false, warnings: [], error: 'FAILED:UNABLE_TO_VOID_TICKET' } }),
    );
    b.adapter.retrieveForDisplay.mockResolvedValue(lectura('VOIDED'));

    const reply = await b.anular();

    expect(reply).toEqual({
      outcome: 'PARTIAL',
      message: TICKET_VOID_MESSAGES.unverified,
      orderStatus: 'pending',
    });
    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.mem.result(b.ultima())).toMatchObject({
      voidOutcome: 'PARTIAL',
      outcome: 'UNVERIFIED',
      reconciliationRequired: true,
      retryable: false,
    });
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { reason: 'void-partial', ticketOperation: 'VOID', voidedTickets: 1 } },
    ]);
  });

  it('el proveedor declara la anulación a medias: PARTIAL aunque la relectura falle', async () => {
    const b = banco();
    b.cancelOrderAudited.mockResolvedValue(
      anulada({ result: { success: false, warnings: [] }, partial: true }),
    );
    b.adapter.retrieveForDisplay.mockRejectedValue(new Error('socket hang up'));

    await expect(b.anular()).resolves.toMatchObject({ outcome: 'PARTIAL' });
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { reason: 'void-partial' } },
    ]);
  });

  it('rechazada y sin poder releer: UNVERIFIED, porque un rechazo no garantiza que no se anulara nada', async () => {
    const b = banco();
    b.cancelOrderAudited.mockResolvedValue(anulada({ result: { success: false, warnings: [] } }));
    b.adapter.retrieveForDisplay.mockRejectedValue(new Error('socket hang up'));

    await expect(b.anular()).resolves.toMatchObject({ outcome: 'UNVERIFIED' });
    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { reason: 'void-unverified', ticketOperation: 'VOID' } },
    ]);
  });

  it('el proveedor no dice qué pasó: UNVERIFIED, escalada, y la orden queda para conciliar', async () => {
    const b = banco();
    b.cancelOrderAudited.mockResolvedValue(
      anulada({ result: { success: false, warnings: [] }, verified: false }),
    );

    const reply = await b.anular();

    expect(reply.outcome).toBe('UNVERIFIED');
    // Sin respuesta verificable no se relee: lo concilia una persona.
    expect(b.adapter.retrieveForDisplay).not.toHaveBeenCalled();
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { reason: 'cancellation-unverified', ticketOperation: 'VOID' } },
    ]);
  });

  it('un «sí» del proveedor que no se puede verificar no libera la cartera ni da la reserva por anulada', async () => {
    // P. ej., la reserva ya estaba cancelada desde otro canal: el proveedor contesta éxito, pero
    // nada dice qué pasó con los tiquetes.
    const b = banco();
    b.cancelOrderAudited.mockResolvedValue(anulada({ verified: false }));

    await expect(b.anular()).resolves.toMatchObject({ outcome: 'UNVERIFIED' });
    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.settle).not.toHaveBeenCalled();
    expect(b.audit.ofType(ORDER_EVENTS.ticketsVoided)).toEqual([]);
    expect(b.mem.result(b.ultima())).toMatchObject({
      voidOutcome: 'UNVERIFIED',
      reconciliationRequired: true,
    });
  });

  it('rechazada con una relectura que no muestra los tiquetes: UNVERIFIED, no vuelve a emitida', async () => {
    const b = banco();
    b.cancelOrderAudited.mockResolvedValue(anulada({ result: { success: false, warnings: [] } }));
    b.adapter.retrieveForDisplay.mockResolvedValue({ ...lectura('ISSUED'), documents: [] });

    await expect(b.anular()).resolves.toMatchObject({ outcome: 'UNVERIFIED' });
    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { reason: 'void-unverified', ticketOperation: 'VOID' } },
    ]);
  });

  it('una anulación que quedó en vuelo (el proceso murió) vence como anulación sin confirmar', async () => {
    const b = banco();
    b.cancelOrderAudited.mockReturnValue(new Promise<OrderCancelAudit>(() => undefined));
    void b.anular();
    await vi.waitFor(() => expect(b.cancelOrderAudited).toHaveBeenCalledOnce());
    const barrido = new StaleCancelClaimService(b.mem.staleClaims, b.audit.asService(), {
      handles: () => false,
    } as unknown as HotelOrderCancellationService);

    await expect(
      barrido.sweepTenant(TENANT, Date.now() + STALE_CANCEL_CLAIM_MS + 60_000),
    ).resolves.toMatchObject({ expired: 1 });

    expect(b.ultima()).toMatchObject({
      status: 'failed',
      last_error: VOID_UNVERIFIED_LAST_ERROR,
    });
    expect(b.mem.result(b.ultima())).toMatchObject({
      ticketOperation: 'VOID',
      voidOutcome: 'UNVERIFIED',
      staleClaim: true,
      reconciliationRequired: true,
    });
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { reason: 'cancellation-unverified', ticketOperation: 'VOID', staleClaim: true } },
    ]);
    // En el historial sigue siendo una anulación, y no se ofrece reintentarla.
    const [op] = await b.service.listOperations(TENANT, ORDEN);
    expect(op).toMatchObject({ ticketOperation: 'VOID', retryable: false });
  });

  it('un timeout en la anulación: 409 «no reintentes», en conciliación y nunca en la cola', async () => {
    const b = banco();
    b.cancelOrderAudited.mockRejectedValue(
      Object.assign(new Error('timeout'), { path: '/v1/trip/orders/cancelBooking', status: 0 }),
    );

    const error = await rechazo(b.anular());

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(TICKET_VOID_MESSAGES.unverified);
    expect((error as ConflictException).getResponse()).toMatchObject({
      reason: TICKET_VOID_REASONS.unverified,
    });
    expect(b.mem.result(b.ultima())).toMatchObject({
      voidOutcome: 'UNVERIFIED',
      reconciliationRequired: true,
    });
    expect(b.queue.cancels).toEqual([]);
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { ticketOperation: 'VOID', threw: true } },
    ]);
  });

  it('falla la lectura previa (no salió nada): 503, NO se encola, y se puede volver a pedir', async () => {
    const b = banco();
    b.cancelOrderAudited.mockRejectedValueOnce(
      Object.assign(new Error('503'), { path: '/v1/trip/orders/getBooking', status: 503 }),
    );

    const error = await rechazo(b.anular());

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe(TICKET_VOID_MESSAGES.notSent);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      reason: TICKET_VOID_REASONS.notSent,
    });
    expect(b.queue.cancels).toEqual([]);
    expect(b.mem.order(ORDEN)?.['status']).toBe('ticketed');
    // El historial no ofrece "Reintentar": una anulación se vuelve a pedir con consulta nueva.
    const [op] = await b.service.listOperations(TENANT, ORDEN);
    expect(op).toMatchObject({ ticketOperation: 'VOID', retryable: false });
    await expect(b.service.retryOperation(TENANT, ORDEN, op!.id, USER)).rejects.toThrow(
      TICKET_VOID_MESSAGES.noRetry,
    );
    // Y el worker de reintentos tampoco la toca.
    await b.service.runCancelById(TENANT, ORDEN);
    expect(b.cancelOrderAudited).toHaveBeenCalledOnce();

    // Una anulación nueva sí sale: no queda nada que conciliar del intento anterior.
    await expect(b.anular()).resolves.toMatchObject({ outcome: 'VOIDED' });
    expect(b.cancelOrderAudited).toHaveBeenCalledTimes(2);
  });

  it('una anulación en duda bloquea la siguiente hasta conciliar', async () => {
    const b = banco();
    b.cancelOrderAudited.mockResolvedValueOnce(
      anulada({ result: { success: false, warnings: [] }, verified: false }),
    );
    await b.anular();
    // La orden quedó `pending`; aunque una persona la devuelva a `ticketed`, la operación manda.
    b.mem.order(ORDEN)!['status'] = 'ticketed';

    await expect(b.anular()).rejects.toThrow(/sin verificar/);
    expect(b.cancelOrderAudited).toHaveBeenCalledOnce();
  });

  it('dos anulaciones a la vez (doble clic): la segunda choca con el claim y no sale', async () => {
    const b = banco();
    // Las dos pestañas leyeron la reserva emitida antes de que la primera tomara el claim.
    const filaVieja = b.mem.order(ORDEN) as unknown as OrderRow;
    let liberar: (value: OrderCancelAudit) => void = () => undefined;
    b.cancelOrderAudited.mockReturnValueOnce(
      new Promise<OrderCancelAudit>((resolve) => {
        liberar = resolve;
      }),
    );
    const primera = b.service.voidTickets(TENANT, { ...filaVieja }, USER);
    await vi.waitFor(() => expect(b.cancelOrderAudited).toHaveBeenCalledOnce());

    await expect(b.service.voidTickets(TENANT, { ...filaVieja }, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    liberar(anulada());
    await expect(primera).resolves.toMatchObject({ outcome: 'VOIDED' });
    expect(b.cancelOrderAudited).toHaveBeenCalledOnce();
  });

  it('una reserva de la cuenta de pruebas también se anula, y el evento lo dice', async () => {
    const b = banco([
      ordenEmitida({
        selected_offer: { provider: { name: AIR, offerRef: 'R-1', environment: 'test' } },
      }),
    ]);

    await expect(b.anular()).resolves.toMatchObject({ outcome: 'VOIDED' });
    expect(b.audit.ofType(ORDER_EVENTS.ticketsVoided)).toMatchObject([
      { payload: { testContent: true } },
    ]);
  });
});

describe('checkTickets: la consulta sola', () => {
  it('sale con la cuenta de la reserva y devuelve lo que dijo el proveedor', async () => {
    const b = banco();
    const check = condiciones();
    b.checkTickets.mockResolvedValue(check);

    await expect(
      b.service.checkTickets(TENANT, b.mem.order(ORDEN) as unknown as OrderRow),
    ).resolves.toBe(check);
  });

  it('sin la capacidad `ticketCheck`, 400', async () => {
    const b = banco([ordenEmitida()], { ticketCheck: false, void: false });

    await expect(
      b.service.checkTickets(TENANT, b.mem.order(ORDEN) as unknown as OrderRow),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.checkTickets).not.toHaveBeenCalled();
  });

  it('un adapter sin la cancelación auditada no anula: la genérica dejaría los tiquetes vivos', async () => {
    const b = banco();
    Object.assign(b.adapter, { cancelOrderAudited: undefined });
    const cancelOrder = vi.fn(() =>
      Promise.resolve<OrderCancelResult>({ success: true, warnings: [] }),
    );
    Object.assign(b.adapter, { cancelOrder });

    await expect(b.anular()).rejects.toBeInstanceOf(BadRequestException);
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(b.mem.order(ORDEN)?.['status']).toBe('ticketed');
  });
});
