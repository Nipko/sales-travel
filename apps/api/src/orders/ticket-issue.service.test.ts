import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  OrderView,
  TicketDocument,
  TicketIssueOutcome,
  TicketIssueResult,
} from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BrandingService } from '../branding/branding.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  ProviderDisabledByPlatformError,
  ProviderOrderAccountUnavailableError,
  type ProviderCapabilities,
  type ProviderEnablementDecision,
} from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { MemoryTicketIssueStore } from './__fixtures__/memory-ticket-issue.store.js';
import type { FlightOrderTrackingStore } from './flight-order-tracking.store.js';
import { ORDER_EVENTS } from './order-events.js';
import type { OrderRow } from './orders.service.js';
import {
  ISSUE_STALE_AFTER_MS,
  ISSUE_UNVERIFIED_MESSAGE,
  ISSUE_VERIFY_DELAYS_MS,
  requestedIssueResult,
  type IssueOperationResult,
} from './ticket-issue.plan.js';
import {
  FlightTicketIssueService,
  ISSUE_CLAIM_MESSAGES,
  ISSUE_QUEUE_UNAVAILABLE_MESSAGE,
} from './ticket-issue.service.js';

/**
 * La emisión de tiquetes de una reserva confirmada (SAB-08), por la puerta pública del servicio,
 * con un proveedor ANÓNIMO (`stub-air`): nada aquí sabe de Sabre. La base es el doble en memoria
 * con las mismas CAS que Postgres; la CAS real la prueba `ticket-issue.integration.test.ts`.
 *
 * Lo que se fija, por encima de todo: nunca hay dos emisiones para la misma operación, y una
 * emisión en duda no se reenvía.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const AIR = 'stub-air';
const PNR = 'ABC123';

function fila(extra: Partial<OrderRow> = {}, environment?: 'test' | 'live'): OrderRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: AIR,
    provider_order_id: PNR,
    status: 'confirmed',
    search_criteria: { origin: 'BOG', destination: 'LIM', departureDate: '2026-12-01' },
    selected_offer: {
      provider: {
        name: AIR,
        offerRef: 'R-1',
        ...(environment === undefined ? {} : { environment }),
      },
    },
    passengers: [
      { givenName: 'Ana', surname: 'Ríos' },
      { givenName: 'Luis', surname: 'Ríos' },
    ],
    contact_info: { email: 'ana@x.test' },
    total_amount: 34012,
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

function tiquete(
  travelerIndex: number,
  status: TicketDocument['status'] = 'ISSUED',
): TicketDocument {
  return { number: `045123456789${travelerIndex}`, kind: 'TICKET', travelerIndex, status };
}

function resultado(
  outcome: TicketIssueOutcome,
  documents: TicketDocument[] = [],
  warnings: TicketIssueResult['warnings'] = [],
): TicketIssueResult {
  return {
    outcome,
    documents,
    warnings,
    issues: [],
    idempotencyKey: 'clave-1',
    formOfPaymentType: 'CASH',
  };
}

interface Opciones {
  readonly order?: OrderRow;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly decision?: ProviderEnablementDecision;
  readonly queueAccepts?: boolean;
  readonly issue?: () => Promise<TicketIssueResult>;
  readonly retrieve?: () => Promise<OrderView>;
  /** `false`: el adapter no implementa el `TicketingPort`. */
  readonly ticketing?: boolean;
}

function banco(o: Opciones = {}) {
  const store = new MemoryTicketIssueStore();
  store.addOrder(o.order ?? fila());
  const factory = new StubProviderFactory({
    code: AIR,
    capabilities: { issue: true, ...o.capabilities },
  });
  const adapter = factory.adapterFor(TENANT);
  const issueTickets = vi.fn(
    o.issue ?? (() => Promise.resolve(resultado('ISSUED', [tiquete(0), tiquete(1)]))),
  );
  const checkTickets = vi.fn(() =>
    Promise.resolve({ checkedAt: '2026-10-13T12:00:00.000Z', tickets: [], cancelOffers: [] }),
  );
  if (o.ticketing !== false) Object.assign(adapter, { issueTickets, checkTickets });
  if (o.retrieve !== undefined) adapter.retrieveForDisplay.mockImplementation(o.retrieve);
  const decisionFor = vi.fn(() => Promise.resolve(o.decision));
  const registry = new FlightProviderRegistry([factory], { decisionFor });
  const queue = new RecordingQueueService(o.queueAccepts ?? true);
  const audit = new RecordingAuditService();
  const sendToTenant = vi.fn((_tenantId: string | null, _mail: { to: string; subject: string }) =>
    Promise.resolve(true),
  );
  const recordReadWithin = vi.fn(
    (_trx: unknown, _tenantId: string, _orderId: string, read: { documents: unknown[] }) =>
      Promise.resolve({ added: read.documents.length, statusChanged: 0 }),
  );
  const recordRead = vi.fn((_tenantId: string, _orderId: string, read: { documents: unknown[] }) =>
    Promise.resolve({ added: read.documents.length, statusChanged: 0 }),
  );
  const service = new FlightTicketIssueService(
    store.asStore(),
    registry,
    queue.asService(),
    audit.asService(),
    { sendToTenant } as unknown as MailerService,
    { resolve: () => Promise.resolve(null) } as unknown as BrandingService,
    { recordReadWithin, recordRead } as unknown as FlightOrderTrackingStore,
  );
  return {
    store,
    service,
    queue,
    audit,
    adapter,
    issueTickets,
    sendToTenant,
    recordReadWithin,
    recordRead,
    decisionFor,
  };
}

type Banco = ReturnType<typeof banco>;

/** Pide la emisión y corre el job que encoló, como haría el worker. */
async function pedirYEmitir(b: Banco): Promise<string> {
  const { operationId } = await b.service.requestIssue(TENANT, fila(), USER);
  const job = b.queue.issues.at(-1);
  if (job === undefined) throw new Error('no se encoló la emisión');
  await b.service.runIssueById(job.tenantId, job.orderId, job.operationId, job.actorUserId);
  return operationId;
}

function resultadoDe(b: Banco, operationId: string): IssueOperationResult {
  const op = b.store.operation(operationId);
  if (op === undefined) throw new Error('no existe la operación');
  return op.result;
}

describe('requestIssue — el pedido sale del request', () => {
  it('toma el claim, deja el evento y encola UN job de un solo intento', async () => {
    const b = banco();

    const res = await b.service.requestIssue(TENANT, fila(), USER);

    expect(res).toEqual({ operationId: expect.any(String) as unknown, status: 'pending' });
    const op = b.store.operation(res.operationId);
    expect(op).toMatchObject({ status: 'pending', orderId: ORDER, actorUserId: USER });
    expect(op?.result).toMatchObject({ stage: 'requested', testContent: false });
    expect(b.queue.jobs).toEqual([
      {
        name: 'issue',
        data: { tenantId: TENANT, orderId: ORDER, operationId: res.operationId, actorUserId: USER },
        jobId: `issue:${ORDER}:${res.operationId}`,
        attempts: 1,
      },
    ]);
    expect(b.audit.first(ORDER_EVENTS.issueRequested)).toMatchObject({
      tenantId: TENANT,
      actorUserId: USER,
      aggregateId: ORDER,
      payload: { provider: AIR, operationId: res.operationId, testContent: false },
    });
    // Pedir no llama al proveedor: la emisión corre en el worker.
    expect(b.issueTickets).not.toHaveBeenCalled();
  });

  it('el doble clic es 409: una sola operación y un solo job', async () => {
    const b = banco();
    await b.service.requestIssue(TENANT, fila(), USER);

    await expect(b.service.requestIssue(TENANT, fila(), USER)).rejects.toThrow(
      new ConflictException(ISSUE_CLAIM_MESSAGES['already-pending']),
    );
    expect(b.store.operations.size).toBe(1);
    expect(b.queue.issues).toHaveLength(1);
  });

  it('sin cola, 503 y la operación queda fallida SIN emitir: se puede volver a pedir', async () => {
    const b = banco({ queueAccepts: false });

    await expect(b.service.requestIssue(TENANT, fila(), USER)).rejects.toThrow(
      new ServiceUnavailableException(ISSUE_QUEUE_UNAVAILABLE_MESSAGE),
    );
    const [op] = [...b.store.operations.values()];
    expect(op).toMatchObject({ status: 'failed' });
    expect(op?.result).toMatchObject({
      outcome: 'NOT_SENT',
      source: 'queue-unavailable',
      retryable: true,
      reconciliationRequired: false,
    });
    expect(b.audit.first(ORDER_EVENTS.issueFailed)?.payload).toMatchObject({
      outcome: 'NOT_SENT',
      retryable: true,
    });

    b.queue.accept(true);
    await expect(b.service.requestIssue(TENANT, fila(), USER)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('con el proveedor apagado por la plataforma, 400 y sin operación', async () => {
    const b = banco({ decision: { enabled: false, origin: 'global' } });

    await expect(b.service.requestIssue(TENANT, fila(), USER)).rejects.toBeInstanceOf(
      ProviderDisabledByPlatformError,
    );
    expect(b.store.operations.size).toBe(0);
    expect(b.queue.jobs).toEqual([]);
  });

  it('si la cuenta de la reserva ya no está, 409 y sin operación', async () => {
    const order = fila({ provider_account_id: '44444444-4444-4444-8444-444444444444' });
    const b = banco({ order });

    await expect(b.service.requestIssue(TENANT, order, USER)).rejects.toBeInstanceOf(
      ProviderOrderAccountUnavailableError,
    );
    expect(b.store.operations.size).toBe(0);
  });

  it.each([
    ['la capacidad apagada', { capabilities: { issue: false } }],
    ['un adapter sin TicketingPort', { ticketing: false }],
  ] as const)('con %s, 400 y sin operación', async (_caso, opciones) => {
    const b = banco(opciones);

    await expect(b.service.requestIssue(TENANT, fila(), USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(b.store.operations.size).toBe(0);
  });

  it('una reserva que ya no está confirmada (una cancelación en curso) no se emite', async () => {
    const b = banco({ order: fila({ status: 'pending' }) });

    await expect(b.service.requestIssue(TENANT, fila(), USER)).rejects.toThrow(
      new ConflictException(ISSUE_CLAIM_MESSAGES['not-confirmed']),
    );
  });

  it('una orden de otro tenant no existe para éste', async () => {
    const b = banco({ order: fila({ tenant_id: '99999999-9999-4999-8999-999999999999' }) });

    await expect(b.service.requestIssue(TENANT, fila(), USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('runIssueById — write-ahead y una sola emisión', () => {
  it('ISSUED: la orden queda emitida, con sus documentos, su evento y la confirmación', async () => {
    const b = banco();
    let etapaAlEmitir: string | undefined;
    b.issueTickets.mockImplementation(() => {
      etapaAlEmitir = [...b.store.operations.values()][0]?.result.stage;
      return Promise.resolve(resultado('ISSUED', [tiquete(0), tiquete(1)]));
    });

    const operationId = await pedirYEmitir(b);

    // El write-ahead: la operación ya decía `sent` cuando se llamó al proveedor.
    expect(etapaAlEmitir).toBe('sent');
    expect(b.issueTickets).toHaveBeenCalledOnce();
    expect(b.issueTickets).toHaveBeenCalledWith(
      PNR,
      { tenantId: TENANT, requestId: operationId },
      { travelerCount: 2 },
    );
    expect(b.store.order(ORDER)?.status).toBe('ticketed');
    expect(b.store.operation(operationId)).toMatchObject({ status: 'success', lastError: null });
    expect(resultadoDe(b, operationId)).toMatchObject({
      stage: 'settled',
      outcome: 'ISSUED',
      source: 'provider',
      documents: 2,
      formOfPaymentType: 'CASH',
      idempotencyKey: 'clave-1',
      retryable: false,
      reconciliationRequired: false,
    });
    const [, , , read] = b.recordReadWithin.mock.calls[0] ?? [];
    expect(read?.documents).toHaveLength(2);
    expect(b.audit.first(ORDER_EVENTS.ticketed)?.payload).toEqual({
      provider: AIR,
      operationId,
      outcome: 'ISSUED',
      documents: 2,
      // Los EMD de los servicios adicionales (SAB-20) se cuentan aparte; aquí no hay.
      emds: 0,
      formOfPaymentType: 'CASH',
      reconciled: false,
      testContent: false,
    });
    // Conteos y códigos: nunca los números de tiquete en un evento.
    expect(b.audit.dump()).not.toContain(tiquete(0).number);
    expect(b.sendToTenant).toHaveBeenCalledOnce();
    expect(b.sendToTenant.mock.calls[0]?.[1].subject).toContain('Billete emitido #7');
    expect(b.queue.issueVerifications).toEqual([]);
  });

  it('ALREADY_ISSUED cierra igual en `ticketed`, sin segunda emisión', async () => {
    const b = banco({
      issue: () => Promise.resolve(resultado('ALREADY_ISSUED', [tiquete(0), tiquete(1)])),
    });

    const operationId = await pedirYEmitir(b);

    expect(b.store.order(ORDER)?.status).toBe('ticketed');
    expect(resultadoDe(b, operationId).outcome).toBe('ALREADY_ISSUED');
    expect(b.audit.first(ORDER_EVENTS.ticketed)?.payload).toMatchObject({
      outcome: 'ALREADY_ISSUED',
    });
  });

  it('una reserva de prueba se emite, pero el pasajero no recibe el correo automático', async () => {
    const order = fila({}, 'test');
    const b = banco({ order });

    const { operationId } = await b.service.requestIssue(TENANT, order, USER);
    await b.service.runIssueById(TENANT, ORDER, operationId);

    expect(b.store.order(ORDER)?.status).toBe('ticketed');
    expect(b.sendToTenant).not.toHaveBeenCalled();
    expect(b.audit.first(ORDER_EVENTS.ticketed)?.payload).toMatchObject({ testContent: true });
  });

  it('el mismo job dos veces (o dos jobs de la misma operación) emiten UNA vez', async () => {
    const b = banco();
    const { operationId } = await b.service.requestIssue(TENANT, fila(), USER);

    await Promise.all([
      b.service.runIssueById(TENANT, ORDER, operationId),
      b.service.runIssueById(TENANT, ORDER, operationId),
    ]);
    await b.service.runIssueById(TENANT, ORDER, operationId);

    expect(b.issueTickets).toHaveBeenCalledOnce();
  });

  it('FAILED (precio cambiado): fallida y reintentable, con el motivo; la orden sigue confirmada', async () => {
    const b = banco({
      issue: () => Promise.resolve(resultado('FAILED', [], ['price-changed'])),
    });

    const operationId = await pedirYEmitir(b);

    expect(b.store.order(ORDER)?.status).toBe('confirmed');
    expect(b.store.operation(operationId)).toMatchObject({
      status: 'failed',
      lastError:
        'No se pudo emitir: el precio cambió en la aerolínea. Consulta la reserva y vuelve a cotizar antes de emitir.',
    });
    expect(resultadoDe(b, operationId)).toMatchObject({
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      warnings: ['price-changed'],
    });
    expect(b.queue.issueVerifications).toEqual([]);
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
    // El vendedor puede volver a pedirla.
    await expect(b.service.requestIssue(TENANT, fila(), USER)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('UNVERIFIED: en conciliación, prohibido reemitir, y tres relecturas a los 2, 10 y 30 min', async () => {
    const b = banco({ issue: () => Promise.resolve(resultado('UNVERIFIED', [], ['no-response'])) });

    const operationId = await pedirYEmitir(b);

    expect(b.store.operation(operationId)).toMatchObject({
      status: 'failed',
      lastError: ISSUE_UNVERIFIED_MESSAGE,
    });
    expect(resultadoDe(b, operationId)).toMatchObject({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      retryForbidden: true,
      verification: { queued: true, steps: 3 },
    });
    expect(
      b.queue.jobs
        .filter((j) => j.name === 'verify-issue')
        .map((j) => ({ jobId: j.jobId, delayMs: j.delayMs })),
    ).toEqual(
      ISSUE_VERIFY_DELAYS_MS.map((delayMs, step) => ({
        jobId: `verify-issue:${ORDER}:${operationId}-${step}`,
        delayMs,
      })),
    );
    expect(ISSUE_VERIFY_DELAYS_MS).toEqual([120_000, 600_000, 1_800_000]);
    // Sin escalada todavía: primero se relee.
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
    await expect(b.service.requestIssue(TENANT, fila(), USER)).rejects.toThrow(
      new ConflictException(ISSUE_CLAIM_MESSAGES['previous-unverified']),
    );
    expect(b.issueTickets).toHaveBeenCalledOnce();
  });

  it.each(['PARTIAL', 'NEEDS_HUMAN'] as const)(
    '%s: escala ya, guarda lo que se vio y relee; nunca reemite',
    async (outcome) => {
      const b = banco({ issue: () => Promise.resolve(resultado(outcome, [tiquete(0)])) });

      const operationId = await pedirYEmitir(b);

      expect(resultadoDe(b, operationId)).toMatchObject({
        outcome,
        reconciliationRequired: true,
        escalated: true,
      });
      expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
        provider: AIR,
        reason: 'issue-needs-human',
        operationId,
        outcome,
        retryForbidden: true,
      });
      expect(b.recordRead).toHaveBeenCalledOnce();
      expect(b.queue.issueVerifications).toHaveLength(3);
      expect(b.store.order(ORDER)?.status).toBe('confirmed');
    },
  );

  it('si el puerto lanza, no se emitió nada (su contrato): reintentable, con el motivo humanizado', async () => {
    const b = banco({ issue: () => Promise.reject(new Error('cola local vencida')) });

    const operationId = await pedirYEmitir(b);

    expect(b.store.operation(operationId)?.status).toBe('failed');
    expect(b.store.operation(operationId)?.lastError).toBe(
      `No se pudo emitir: [${AIR}] cola local vencida.`,
    );
    expect(resultadoDe(b, operationId)).toMatchObject({
      outcome: 'NOT_SENT',
      source: 'provider',
      retryable: true,
    });
    expect(b.queue.issueVerifications).toEqual([]);
  });

  it('un job que encuentra la emisión ya mandada (el worker murió) sólo relee: no reemite', async () => {
    const b = banco();
    const op = b.store.addOperation(TENANT, {
      orderId: ORDER,
      status: 'pending',
      result: { ...requestedIssueResult({ at: new Date(), testContent: false }), stage: 'sent' },
    });

    await b.service.runIssueById(TENANT, ORDER, op.id);

    expect(b.issueTickets).not.toHaveBeenCalled();
    expect(b.store.operation(op.id)).toMatchObject({ status: 'failed' });
    expect(resultadoDe(b, op.id)).toMatchObject({
      outcome: 'UNVERIFIED',
      source: 'stale-sent',
      reconciliationRequired: true,
    });
    expect(b.queue.issueVerifications).toHaveLength(3);
  });

  it('una orden que ya está emitida cierra la operación sin llamar a nadie', async () => {
    const b = banco();
    const { operationId } = await b.service.requestIssue(TENANT, fila(), USER);
    b.store.addOrder(fila({ status: 'ticketed' }));

    await b.service.runIssueById(TENANT, ORDER, operationId);

    expect(b.issueTickets).not.toHaveBeenCalled();
    expect(b.store.operation(operationId)?.status).toBe('success');
    expect(resultadoDe(b, operationId).source).toBe('already-ticketed');
  });

  it.each([
    [
      'la orden dejó de estar confirmada',
      (b: Banco) => b.store.addOrder(fila({ status: 'cancelled' })),
      'No se pudo emitir: la reserva ya no está confirmada.',
    ],
    [
      'la orden perdió su localizador',
      (b: Banco) => b.store.addOrder(fila({ provider_order_id: null })),
      'No se pudo emitir: la reserva ya no existe o no tiene localizador.',
    ],
  ])('si %s antes del job, no se emite', async (_caso, cambiar, mensaje) => {
    const b = banco();
    const { operationId } = await b.service.requestIssue(TENANT, fila(), USER);
    cambiar(b);

    await b.service.runIssueById(TENANT, ORDER, operationId);

    expect(b.issueTickets).not.toHaveBeenCalled();
    expect(b.store.operation(operationId)).toMatchObject({ status: 'failed', lastError: mensaje });
    expect(resultadoDe(b, operationId)).toMatchObject({ outcome: 'NOT_SENT', retryable: true });
  });

  it('si la plataforma apaga el proveedor con la emisión en cola, el job no emite', async () => {
    const b = banco();
    const { operationId } = await b.service.requestIssue(TENANT, fila(), USER);
    b.decisionFor.mockResolvedValue({ enabled: false, origin: 'global' });

    await b.service.runIssueById(TENANT, ORDER, operationId);

    expect(b.issueTickets).not.toHaveBeenCalled();
    expect(b.store.operation(operationId)?.lastError).toContain(
      'está deshabilitado por la plataforma',
    );
  });

  it('si la base no deja cerrar una emisión hecha, las relecturas la cierran después', async () => {
    const b = banco({
      retrieve: () =>
        Promise.resolve({
          found: true,
          orderId: PNR,
          airlineLocators: [],
          documents: [tiquete(0), tiquete(1)],
          warnings: [],
        }),
    });
    b.store.failNext('finalizeTicketed');

    const operationId = await pedirYEmitir(b);

    // Se emitió y no se pudo guardar: sigue mandada, nunca vuelve a `requested`.
    expect(b.store.operation(operationId)).toMatchObject({ status: 'pending' });
    expect(resultadoDe(b, operationId).stage).toBe('sent');
    expect(b.store.order(ORDER)?.status).toBe('confirmed');
    expect(b.queue.issueVerifications).toHaveLength(3);

    await b.service.runVerifyJob(b.queue.issueVerifications[0]?.data, { final: false });

    expect(b.store.order(ORDER)?.status).toBe('ticketed');
    expect(b.store.operation(operationId)?.status).toBe('success');
    expect(b.audit.first(ORDER_EVENTS.ticketed)?.payload).toMatchObject({ reconciled: true });
    expect(b.issueTickets).toHaveBeenCalledOnce();
  });

  it('si la orden cambió al cerrar, la emisión queda en conciliación y escala', async () => {
    const b = banco();
    const { operationId } = await b.service.requestIssue(TENANT, fila(), USER);
    b.issueTickets.mockImplementation(() => {
      b.store.addOrder(fila({ status: 'pending' }));
      return Promise.resolve(resultado('ISSUED', [tiquete(0), tiquete(1)]));
    });

    await b.service.runIssueById(TENANT, ORDER, operationId);

    expect(b.store.operation(operationId)?.status).toBe('failed');
    expect(resultadoDe(b, operationId)).toMatchObject({ reconciliationRequired: true });
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'issue-order-state-conflict',
    });
    expect(b.sendToTenant).not.toHaveBeenCalled();
  });

  it('sin cola para las relecturas, la duda escala ya: nadie la va a mirar sola', async () => {
    const b = banco({ issue: () => Promise.resolve(resultado('UNVERIFIED')) });
    const { operationId } = await b.service.requestIssue(TENANT, fila(), USER);
    b.queue.accept(false);

    await b.service.runIssueById(TENANT, ORDER, operationId);

    expect(resultadoDe(b, operationId)).toMatchObject({
      verification: { queued: false },
      escalated: true,
    });
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'issue-unverified',
      queued: false,
    });
  });

  it('una operación que no existe, o ya cerrada, no hace nada', async () => {
    const b = banco();
    await b.service.runIssueById(TENANT, ORDER, 'no-existe');
    const op = b.store.addOperation(TENANT, {
      orderId: ORDER,
      status: 'failed',
      result: requestedIssueResult({ at: new Date(), testContent: false }),
    });
    await b.service.runIssueById(TENANT, ORDER, op.id);

    expect(b.issueTickets).not.toHaveBeenCalled();
  });
});

describe('runVerifyJob — las relecturas de una emisión en duda', () => {
  const VISTA_COMPLETA: OrderView = {
    found: true,
    orderId: PNR,
    airlineLocators: [{ carrierCode: 'AA', locator: 'XYZ123' }],
    documents: [tiquete(0), tiquete(1)],
    warnings: [],
  };
  const VISTA_PARCIAL: OrderView = { ...VISTA_COMPLETA, documents: [tiquete(0)] };

  async function enDuda(o: Opciones = {}) {
    const b = banco({ issue: () => Promise.resolve(resultado('UNVERIFIED')), ...o });
    const operationId = await pedirYEmitir(b);
    const pasos = b.queue.issueVerifications.map((v) => v.data);
    return { b, operationId, pasos };
  }

  it('si la lectura ve cada pasajero emitido, la cierra en `ticketed` sin reemitir', async () => {
    const { b, operationId, pasos } = await enDuda({
      retrieve: () => Promise.resolve(VISTA_COMPLETA),
    });

    await b.service.runVerifyJob(pasos[0], { final: false });

    expect(b.store.order(ORDER)?.status).toBe('ticketed');
    expect(b.store.operation(operationId)).toMatchObject({ status: 'success', lastError: null });
    expect(resultadoDe(b, operationId)).toMatchObject({
      outcome: 'ISSUED',
      source: 'reconciliation',
      reconciliationRequired: false,
    });
    expect(b.audit.first(ORDER_EVENTS.ticketed)?.payload).toMatchObject({
      outcome: 'ISSUED',
      reconciled: true,
      documents: 2,
    });
    // Los pasos siguientes ya no leen.
    await b.service.runVerifyJob(pasos[1], { final: false });
    expect(b.adapter.retrieveForDisplay).toHaveBeenCalledOnce();
    expect(b.issueTickets).toHaveBeenCalledOnce();
    expect(b.sendToTenant).toHaveBeenCalledOnce();
  });

  it('una lectura parcial guarda lo visto y espera; la última escala', async () => {
    const { b, operationId, pasos } = await enDuda({
      retrieve: () => Promise.resolve(VISTA_PARCIAL),
    });

    await b.service.runVerifyJob(pasos[0], { final: false });
    await b.service.runVerifyJob(pasos[1], { final: false });
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
    expect(b.recordRead).toHaveBeenCalledTimes(2);

    await b.service.runVerifyJob(pasos[2], { final: false });

    expect(b.store.order(ORDER)?.status).toBe('confirmed');
    expect(resultadoDe(b, operationId)).toMatchObject({
      reconciliationRequired: true,
      verification: { exhausted: true },
    });
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'issue-unverified',
      operationId,
    });
    expect(b.issueTickets).toHaveBeenCalledOnce();
  });

  it('una lectura que falla se repite en la cola; en el último intento del último paso, escala', async () => {
    const { b, pasos } = await enDuda({
      retrieve: () => Promise.reject(new Error('proveedor caído')),
    });

    await expect(b.service.runVerifyJob(pasos[0], { final: true })).rejects.toThrow(
      'proveedor caído',
    );
    await expect(b.service.runVerifyJob(pasos[2], { final: false })).rejects.toThrow(
      'proveedor caído',
    );
    await b.service.runVerifyJob(pasos[2], { final: true });

    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'issue-unverified',
      readFailed: true,
    });
  });

  it('un payload que no es el nuestro no lee nada', async () => {
    const { b } = await enDuda({ retrieve: () => Promise.resolve(VISTA_COMPLETA) });

    await b.service.runVerifyJob({ tenantId: TENANT, orderId: ORDER, step: 9 }, { final: true });

    expect(b.adapter.retrieveForDisplay).not.toHaveBeenCalled();
  });

  it('una emisión ya cerrada no se vuelve a leer', async () => {
    const b = banco();
    const operationId = await pedirYEmitir(b);

    await b.service.runVerifyJob(
      { tenantId: TENANT, orderId: ORDER, operationId, step: 0 },
      { final: true },
    );

    expect(b.adapter.retrieveForDisplay).not.toHaveBeenCalled();
  });
});

describe('sweepTenant — lo que la cola perdió', () => {
  it('una pedida que nunca salió se abandona sin emitir; una reciente, no', async () => {
    const b = banco();
    const vieja = b.store.addOperation(TENANT, {
      orderId: ORDER,
      status: 'pending',
      result: requestedIssueResult({ at: new Date(), testContent: false }),
      updatedAt: new Date('2026-10-13T10:00:00Z'),
    });
    const ahora = Date.parse('2026-10-13T10:00:00Z') + ISSUE_STALE_AFTER_MS - 1;

    expect(await b.service.sweepTenant(TENANT, ahora)).toMatchObject({ examined: 0 });
    const report = await b.service.sweepTenant(TENANT, ahora + 2);

    expect(report).toEqual({ examined: 1, abandoned: 1, reconciling: 0, skipped: 0 });
    expect(b.store.operation(vieja.id)).toMatchObject({ status: 'failed' });
    expect(resultadoDe(b, vieja.id)).toMatchObject({
      outcome: 'NOT_SENT',
      source: 'stale-request',
      retryable: true,
    });
    // El job perdido, si aparece después, ya no emite.
    await b.service.runIssueById(TENANT, ORDER, vieja.id);
    expect(b.issueTickets).not.toHaveBeenCalled();
  });

  it('una mandada sin desenlace pasa a conciliación con sus relecturas, sin reenviarla', async () => {
    const b = banco();
    const mandada = b.store.addOperation(TENANT, {
      orderId: ORDER,
      status: 'pending',
      result: { ...requestedIssueResult({ at: new Date(), testContent: false }), stage: 'sent' },
      updatedAt: new Date('2026-10-13T10:00:00Z'),
    });

    const report = await b.service.sweepTenant(TENANT, Date.parse('2026-10-13T11:00:00Z'));

    expect(report).toEqual({ examined: 1, abandoned: 0, reconciling: 1, skipped: 0 });
    expect(resultadoDe(b, mandada.id)).toMatchObject({
      outcome: 'UNVERIFIED',
      source: 'stale-sent',
      reconciliationRequired: true,
    });
    expect(b.queue.issueVerifications).toHaveLength(3);
    expect(b.issueTickets).not.toHaveBeenCalled();
  });
});
