import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OrderView, TicketIssueResult } from '@sales-travel/domain';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { BrandingService } from '../branding/branding.service.js';
import type { OrderOperationStatus } from '../database/database.types.js';
import { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  supportsTicketing,
  type FlightProviderAdapter,
  type OrderProviderRef,
  type ResolvedProvider,
} from '../providers/provider.types.js';
import { PostSaleQueueService } from '../queue/post-sale-queue.service.js';
import {
  FlightOrderTrackingStore,
  flightReadOf,
  type FlightOrderRead,
} from './flight-order-tracking.store.js';
import { isTestContentOrder, sendAutomaticFlightConfirmation } from './order-confirmation-mail.js';
import { ORDER_EVENTS, type TicketIssueEscalationReason } from './order-events.js';
import type { OrderRow } from './orders.service.js';
import {
  ISSUE_NOT_SENT_REASONS,
  ISSUE_STALE_AFTER_MS,
  ISSUE_UNVERIFIED_MESSAGE,
  ISSUE_VERIFY_DELAYS_MS,
  auditableIssueTypes,
  decideIssue,
  formOfPaymentOf,
  issueFailureMessage,
  knownIssueWarnings,
  requestedIssueResult,
  ticketCoverage,
  travelerCountOf,
  type IssueOperationResult,
  type IssueSettlementSource,
} from './ticket-issue.plan.js';
import {
  TicketIssueStore,
  type IssueClaimRefusal,
  type IssueOperationRecord,
} from './ticket-issue.store.js';

/** Lo que el vendedor lee cuando no se toma el claim de una emisión nueva. */
export const ISSUE_CLAIM_MESSAGES: Readonly<Record<IssueClaimRefusal, string>> = {
  'not-found': 'La reserva no existe o no tiene localizador.',
  'not-confirmed': 'Sólo se puede emitir una reserva confirmada.',
  'already-pending': 'Ya hay una emisión en curso para esta reserva.',
  'already-issued': 'La reserva ya registra una emisión. Consulta su estado antes de seguir.',
  'previous-unverified':
    'La emisión anterior quedó sin confirmar. No vuelvas a emitir: revisamos la reserva con la aerolínea.',
  'services-pending':
    'Hay un cambio de servicios adicionales en curso en esta reserva. Espera a que termine antes de emitir.',
  'services-unverified':
    'Un cambio de servicios adicionales quedó sin confirmar. Antes de emitir lo revisamos con la aerolínea.',
};

export const ISSUE_QUEUE_UNAVAILABLE_MESSAGE =
  'No pudimos iniciar la emisión: la cola de post-venta no está disponible. No se emitió nada; intenta de nuevo en unos minutos.';

/** El payload de una relectura viene de Redis, no de nuestro tipo: se valida antes de usarlo. */
const VerifyIssueJobSchema = z.object({
  tenantId: z.string().uuid(),
  orderId: z.string().uuid(),
  operationId: z.string().uuid(),
  step: z
    .number()
    .int()
    .min(0)
    .max(ISSUE_VERIFY_DELAYS_MS.length - 1),
});

/** Lo que dejó el barrido de UN tenant. */
export interface TicketIssueSweepReport {
  examined: number;
  /** Pedidas que nunca llegaron a salir: falladas sin emitir nada, se pueden volver a pedir. */
  abandoned: number;
  /** Mandadas y sin desenlace: en conciliación, con sus relecturas. */
  reconciling: number;
  skipped: number;
}

/** El desenlace que se cierra en `ticketed`, con lo que cita el evento. */
interface TicketedClose {
  readonly outcome: 'ISSUED' | 'ALREADY_ISSUED';
  readonly reconciled: boolean;
  readonly read: FlightOrderRead;
}

function accountRef(order: OrderRow): OrderProviderRef {
  return {
    orderId: order.id,
    provider: order.provider,
    providerAccountId: order.provider_account_id ?? null,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : 'UnknownError';
}

/**
 * La emisión de tiquetes de una reserva de vuelo confirmada (SAB-08), fuera del request.
 *
 *   requestIssue   → claim durable (0083) + evento + job `issue` en la cola, y 202 al vendedor.
 *   runIssueById   → el job: write-ahead (`stage: 'sent'`) y UNA llamada al `TicketingPort`.
 *   runVerifyJob   → las relecturas de una emisión en duda (2, 10 y 30 min). Sólo leen.
 *   sweepTenant    → lo que la cola perdió: pedidas que nunca salieron y mandadas sin desenlace.
 *
 * La garantía contra la doble emisión NO es el `jobId` de BullMQ, que olvida los jobs terminados:
 * es el índice parcial de 0083 (una escritura pendiente por orden) más el write-ahead. Una ejecución
 * que encuentra la emisión ya mandada sólo relee la reserva. Nunca hay dos `issueTickets` para la
 * misma operación, y una operación en duda bloquea pedir otra hasta conciliarla.
 *
 * Neutral de proveedor: decide por la capacidad `issue` y por el `TicketingPort` del adapter.
 */
@Injectable()
export class FlightTicketIssueService {
  private readonly logger = new Logger('FlightTicketIssue');

  constructor(
    private readonly store: TicketIssueStore,
    private readonly registry: FlightProviderRegistry,
    private readonly queue: PostSaleQueueService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly branding: BrandingService,
    /** Donde quedan los documentos (0082). En la app siempre está. */
    @Optional() private readonly tracking?: FlightOrderTrackingStore,
  ) {}

  /**
   * Pide la emisión de una orden que el controlador ya leyó con el tenant fijado y validó
   * (localizador, `confirmed`, capacidad y total). Corta antes del claim si la plataforma apagó el
   * proveedor (400) o la cuenta de la reserva ya no está (409).
   *
   * @throws ConflictException (409) si hay otra emisión en curso o la anterior quedó en duda.
   * @throws ServiceUnavailableException (503) si la cola no aceptó el job: no se emitió nada.
   */
  async requestIssue(
    tenantId: string,
    order: OrderRow,
    actorUserId: string,
  ): Promise<{ operationId: string; status: 'pending' }> {
    const provider = await this.registry.forOrderSale(tenantId, accountRef(order));
    if (provider.capabilities.issue !== true || !supportsTicketing(provider.adapter)) {
      throw new BadRequestException(
        `La operación no está disponible para reservas de proveedor '${order.provider}'.`,
      );
    }

    const testContent = isTestContentOrder(order);
    const requested = requestedIssueResult({ at: new Date(), testContent });
    const claim = await this.store.claim(tenantId, order.id, actorUserId, requested);
    if (!claim.claimed) {
      const message = ISSUE_CLAIM_MESSAGES[claim.refusal];
      throw claim.refusal === 'not-found'
        ? new NotFoundException(message)
        : new ConflictException(message);
    }
    const operationId = claim.operationId;

    await this.audit.emit({
      eventType: ORDER_EVENTS.issueRequested,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { provider: order.provider, operationId, testContent },
    });

    const queued = await this.queue.enqueueIssue({
      tenantId,
      orderId: order.id,
      operationId,
      actorUserId,
    });
    if (!queued) {
      // Sin job no hay quien la emita. Se abandona SÓLO si sigue sin salir: si la cola la aceptó
      // igual y un worker ya la tomó, sigue su curso.
      const abandoned = await this.store.settle(
        tenantId,
        operationId,
        { from: ['pending'], stage: 'requested' },
        'failed',
        this.notSentResult(requested, 'queue-unavailable'),
        issueFailureMessage(ISSUE_NOT_SENT_REASONS.queueUnavailable),
      );
      if (abandoned) {
        await this.emitFailed(tenantId, order, operationId, actorUserId, {
          outcome: 'NOT_SENT',
          source: 'queue-unavailable',
          retryable: true,
          reconciliationRequired: false,
        });
        throw new ServiceUnavailableException(ISSUE_QUEUE_UNAVAILABLE_MESSAGE);
      }
    }
    this.logger.log(
      `flights.issue.requested provider=${order.provider} order=${order.id} op=${operationId} queued=${String(queued)}`,
    );
    return { operationId, status: 'pending' };
  }

  /**
   * El job `issue`. No lanza después del write-ahead: todo desenlace queda en la operación. Antes,
   * un fallo de la base sí sale a BullMQ (un intento, sin reintento) y la operación queda pedida
   * para el barrido.
   */
  async runIssueById(
    tenantId: string,
    orderId: string,
    operationId: string,
    actorUserId?: string,
  ): Promise<void> {
    const op = await this.store.getOperation(tenantId, orderId, operationId);
    if (op === undefined || op.status !== 'pending') return;
    const actor = op.actorUserId ?? actorUserId;
    const order = await this.store.findOrder(tenantId, orderId);

    if (op.result.stage !== 'requested') {
      // Alguien ya la mandó (un worker que murió en plena llamada): sólo se relee, nunca se reemite.
      await this.reconcileInterrupted(tenantId, orderId, order?.provider ?? null, op, 'stale-sent');
      return;
    }
    if (!order?.provider_order_id) {
      await this.abandon(tenantId, orderId, null, op, ISSUE_NOT_SENT_REASONS.orderMissing, actor);
      return;
    }
    if (order.status === 'ticketed') {
      await this.closeAlreadyTicketed(tenantId, order, op);
      return;
    }
    if (order.status !== 'confirmed') {
      await this.abandon(
        tenantId,
        order.id,
        order.provider,
        op,
        ISSUE_NOT_SENT_REASONS.orderNotConfirmed,
        actor,
      );
      return;
    }
    // La capacidad se vuelve a mirar en el job: apagar la emisión corta también lo que está en cola.
    if (this.registry.capabilitiesOf(order.provider)?.issue !== true) {
      await this.abandon(
        tenantId,
        order.id,
        order.provider,
        op,
        ISSUE_NOT_SENT_REASONS.capabilityOff,
        actor,
      );
      return;
    }

    let provider: ResolvedProvider<FlightProviderAdapter>;
    try {
      provider = await this.registry.forOrderSale(tenantId, accountRef(order));
    } catch (error) {
      await this.abandon(
        tenantId,
        order.id,
        order.provider,
        op,
        this.reasonOf(order.provider, error),
        actor,
      );
      return;
    }
    const adapter = provider.adapter;
    if (!supportsTicketing(adapter)) {
      await this.abandon(
        tenantId,
        order.id,
        order.provider,
        op,
        ISSUE_NOT_SENT_REASONS.noTicketingPort,
        actor,
      );
      return;
    }

    // Write-ahead: desde aquí la emisión pudo ocurrir. Sólo una ejecución lo gana.
    const sent: IssueOperationResult = {
      ...op.result,
      stage: 'sent',
      sentAt: new Date().toISOString(),
    };
    if (!(await this.store.markSent(tenantId, op.id, sent))) return;

    let result: TicketIssueResult;
    try {
      result = await adapter.issueTickets(
        order.provider_order_id,
        { tenantId, requestId: op.id },
        { travelerCount: travelerCountOf(order.passengers) },
      );
    } catch (error) {
      // El contrato del puerto: si lanza, no se emitió nada. Se puede volver a pedir.
      const settled = await this.store.settle(
        tenantId,
        op.id,
        { from: ['pending'], stage: 'sent' },
        'failed',
        this.notSentResult(sent, 'provider'),
        issueFailureMessage(this.reasonOf(order.provider, error)),
      );
      if (settled) {
        await this.emitFailed(tenantId, order, op.id, actor, {
          outcome: 'NOT_SENT',
          source: 'provider',
          retryable: true,
          reconciliationRequired: false,
          errorName: errorName(error),
        });
      }
      return;
    }
    await this.applyResult(tenantId, order, op.id, sent, result, actor);
  }

  /**
   * El job `verify-issue`: relee la reserva de una emisión en duda. Si cada pasajero tiene su
   * tiquete emitido, la cierra en `ticketed`. Si no, espera la próxima; la última escala. Un fallo
   * de la lectura sale a la cola, que repite ESTA lectura; en el último intento del último paso,
   * escala igual.
   */
  async runVerifyJob(data: unknown, attempt: { readonly final: boolean }): Promise<void> {
    const parsed = VerifyIssueJobSchema.safeParse(data);
    if (!parsed.success) {
      this.logger.warn('flights.issue.verify.invalid_job');
      return;
    }
    const { tenantId, orderId, operationId, step } = parsed.data;
    const lastStep = step >= ISSUE_VERIFY_DELAYS_MS.length - 1;

    const op = await this.store.getOperation(tenantId, orderId, operationId);
    if (op === undefined || op.status === 'success') return;
    const order = await this.store.findOrder(tenantId, orderId);
    if (!order?.provider_order_id) {
      if (lastStep) await this.exhaust(tenantId, orderId, order?.provider ?? null, op, {});
      return;
    }
    if (order.status === 'ticketed') {
      await this.closeAlreadyTicketed(tenantId, order, op);
      return;
    }

    let view: OrderView;
    try {
      // Una lectura es post-venta: sale con la cuenta de la reserva aunque la plataforma haya
      // apagado el proveedor para ventas nuevas.
      const provider = await this.registry.forOrder(tenantId, accountRef(order));
      view = await provider.adapter.retrieveForDisplay(order.provider_order_id, { tenantId });
    } catch (error) {
      if (lastStep && attempt.final) {
        await this.exhaust(tenantId, order.id, order.provider, op, {
          readFailed: true,
          errorName: errorName(error),
        });
        return;
      }
      throw error;
    }

    const documents = view.found ? (view.documents ?? []) : [];
    if (view.found && ticketCoverage(documents, travelerCountOf(order.passengers)) === 'COMPLETE') {
      try {
        await this.finalize(
          tenantId,
          order,
          op,
          {
            ...op.result,
            stage: 'settled',
            settledAt: new Date().toISOString(),
            outcome: 'ISSUED',
            source: 'reconciliation',
            documents: documents.length,
            retryable: false,
            reconciliationRequired: false,
            retryForbidden: false,
          },
          { outcome: 'ISSUED', reconciled: true, read: flightReadOf(view, new Date()) },
          op.actorUserId ?? undefined,
        );
      } catch (error) {
        // La cola repite esta lectura; en el último intento del último paso lo mira una persona.
        if (!(lastStep && attempt.final)) throw error;
        await this.exhaust(tenantId, order.id, order.provider, op, {
          closeFailed: true,
          errorName: errorName(error),
        });
      }
      return;
    }
    await this.recordSeen(tenantId, order, view);
    if (lastStep) await this.exhaust(tenantId, order.id, order.provider, op, { step });
  }

  /**
   * Lo que la cola perdió en este tenant: emisiones pendientes desde hace más de
   * {@link ISSUE_STALE_AFTER_MS}. Las que nunca salieron se abandonan (se pueden volver a pedir);
   * las ya mandadas pasan a conciliación con sus relecturas. Nada se reenvía.
   */
  async sweepTenant(tenantId: string, now: number = Date.now()): Promise<TicketIssueSweepReport> {
    const report: TicketIssueSweepReport = {
      examined: 0,
      abandoned: 0,
      reconciling: 0,
      skipped: 0,
    };
    const stale = await this.store.listStale(tenantId, new Date(now - ISSUE_STALE_AFTER_MS));
    for (const op of stale) {
      report.examined += 1;
      const order = await this.store.findOrder(tenantId, op.orderId);
      const provider = order?.provider ?? null;
      if (op.result.stage === 'requested') {
        const done = await this.store.settle(
          tenantId,
          op.id,
          { from: ['pending'], stage: 'requested' },
          'failed',
          this.notSentResult(op.result, 'stale-request'),
          issueFailureMessage(ISSUE_NOT_SENT_REASONS.staleRequest),
        );
        if (!done) {
          report.skipped += 1;
          continue;
        }
        report.abandoned += 1;
        await this.emitFailed(tenantId, { id: op.orderId, provider }, op.id, op.actorUserId, {
          outcome: 'NOT_SENT',
          source: 'stale-request',
          retryable: true,
          reconciliationRequired: false,
        });
        continue;
      }
      const moved = await this.reconcileInterrupted(
        tenantId,
        op.orderId,
        provider,
        op,
        'stale-sent',
      );
      if (moved) report.reconciling += 1;
      else report.skipped += 1;
    }
    if (report.examined > 0) {
      this.logger.warn(
        `flights.issue.sweep tenant=${tenantId} examined=${report.examined} abandoned=${report.abandoned} reconciling=${report.reconciling} skipped=${report.skipped}`,
      );
    }
    return report;
  }

  // -------------------------------------------------------------------------------------------
  // Desenlaces
  // -------------------------------------------------------------------------------------------

  private async applyResult(
    tenantId: string,
    order: OrderRow,
    operationId: string,
    sent: IssueOperationResult,
    result: TicketIssueResult,
    actorUserId: string | undefined | null,
  ): Promise<void> {
    const decision = decideIssue(result);
    const formOfPaymentType = formOfPaymentOf(result.formOfPaymentType);
    const settled: IssueOperationResult = {
      ...sent,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome: result.outcome,
      source: 'provider',
      documents: result.documents.length,
      ...(formOfPaymentType === undefined ? {} : { formOfPaymentType }),
      warnings: knownIssueWarnings(result.warnings),
      issueTypes: auditableIssueTypes(result.issues),
      idempotencyKey: result.idempotencyKey,
    };
    this.logger.log(
      `flights.issue.result provider=${order.provider} order=${order.id} op=${operationId} outcome=${result.outcome} documents=${result.documents.length}`,
    );

    if (decision.kind === 'ticketed') {
      try {
        await this.finalize(
          tenantId,
          order,
          { id: operationId, result: sent },
          { ...settled, retryable: false, reconciliationRequired: false, retryForbidden: false },
          {
            outcome: decision.outcome,
            reconciled: false,
            read: flightReadOf(
              { found: true, airlineLocators: [], documents: [...result.documents], warnings: [] },
              new Date(),
            ),
          },
          actorUserId ?? undefined,
        );
      } catch (error) {
        // Se emitió y no se pudo guardar. La operación sigue mandada: las relecturas la cierran
        // (verán los tiquetes), y si la cola tampoco está, el barrido la pasa a conciliación.
        this.logger.warn(
          `flights.issue.finalize_failed provider=${order.provider} order=${order.id} op=${operationId} error=${errorName(error)}`,
        );
        await this.scheduleVerification(tenantId, order.id, order.provider, operationId, {
          status: 'pending',
          result: sent,
          actorUserId,
        });
      }
      return;
    }

    if (decision.kind === 'rejected') {
      const done = await this.store.settle(
        tenantId,
        operationId,
        { from: ['pending'], stage: 'sent' },
        'failed',
        { ...settled, retryable: true, reconciliationRequired: false, retryForbidden: false },
        decision.message,
      );
      if (done) {
        await this.emitFailed(tenantId, order, operationId, actorUserId, {
          outcome: result.outcome,
          source: 'provider',
          retryable: true,
          reconciliationRequired: false,
          warnings: settled.warnings ?? [],
          issueTypes: settled.issueTypes ?? [],
        });
      }
      return;
    }

    // En duda: nunca se reenvía. Se guarda lo que se vio, se escala si hace falta y se relee.
    const reconciling: IssueOperationResult = {
      ...settled,
      retryable: false,
      reconciliationRequired: true,
      retryForbidden: true,
      escalated: decision.escalateNow,
    };
    const done = await this.store.settle(
      tenantId,
      operationId,
      { from: ['pending'], stage: 'sent' },
      'failed',
      reconciling,
      ISSUE_UNVERIFIED_MESSAGE,
    );
    if (!done) return;
    // Los tiquetes que sí salieron quedan a la vista. Sin documentos no hay nada que guardar: la
    // respuesta de una emisión no es una lectura de la reserva.
    if (result.documents.length > 0) {
      await this.recordSeen(tenantId, order, {
        found: true,
        airlineLocators: [],
        documents: [...result.documents],
        warnings: [],
      });
    }
    await this.emitFailed(tenantId, order, operationId, actorUserId, {
      outcome: result.outcome,
      source: 'provider',
      retryable: false,
      reconciliationRequired: true,
      warnings: reconciling.warnings ?? [],
      issueTypes: reconciling.issueTypes ?? [],
    });
    if (decision.escalateNow) {
      await this.escalate(tenantId, order.id, order.provider, operationId, 'issue-needs-human', {
        outcome: result.outcome,
        actorUserId,
      });
    }
    await this.scheduleVerification(tenantId, order.id, order.provider, operationId, {
      status: 'failed',
      result: reconciling,
      actorUserId,
    });
  }

  /**
   * El cierre en `ticketed`, todo en una transacción (store). Si la orden cambió de estado en el
   * medio, se concilia y se escala. Si la transacción falla, LANZA: la emisión igual ocurrió, y
   * quien llama decide cómo se vuelve a intentar el cierre (relecturas, o el reintento de la suya).
   */
  private async finalize(
    tenantId: string,
    order: OrderRow,
    op: Pick<IssueOperationRecord, 'id' | 'result'>,
    result: IssueOperationResult,
    close: TicketedClose,
    actorUserId: string | undefined,
  ): Promise<void> {
    const documents = close.read.documents.length;
    // Los EMD de los servicios adicionales (SAB-20) salen en la misma emisión: se cuentan aparte.
    const emds = close.read.documents.filter((document) => document.kind === 'EMD').length;
    const outcome = await this.store.finalizeTicketed(
      tenantId,
      order.id,
      op.id,
      result,
      async (trx, row) => {
        const changes =
          this.tracking === undefined
            ? { added: 0, statusChanged: 0 }
            : await this.tracking.recordReadWithin(trx, tenantId, row.id, close.read);
        await this.audit.emitWithin(trx, {
          eventType: ORDER_EVENTS.ticketed,
          tenantId,
          actorUserId,
          aggregateType: 'order',
          aggregateId: row.id,
          payload: {
            provider: row.provider,
            operationId: op.id,
            outcome: close.outcome,
            documents,
            emds,
            ...(result.formOfPaymentType === undefined
              ? {}
              : { formOfPaymentType: result.formOfPaymentType }),
            reconciled: close.reconciled,
            testContent: isTestContentOrder(row),
          },
        });
        if (changes.added + changes.statusChanged > 0) {
          await this.audit.emitWithin(trx, {
            eventType: ORDER_EVENTS.flightDocumentsChanged,
            tenantId,
            actorUserId,
            aggregateType: 'order',
            aggregateId: row.id,
            payload: {
              provider: row.provider,
              source: 'issue',
              added: changes.added,
              statusChanged: changes.statusChanged,
            },
          });
        }
      },
    );

    if (outcome.kind === 'already') return;
    if (outcome.kind === 'order-changed') {
      const conflict: IssueOperationResult = {
        ...result,
        retryable: false,
        reconciliationRequired: true,
        retryForbidden: true,
        escalated: true,
      };
      await this.store.settle(
        tenantId,
        op.id,
        { from: ['pending', 'failed'] },
        'failed',
        conflict,
        ISSUE_UNVERIFIED_MESSAGE,
      );
      await this.escalate(tenantId, order.id, order.provider, op.id, 'issue-order-state-conflict', {
        outcome: close.outcome,
        actorUserId,
      });
      return;
    }

    this.logger.log(
      `flights.issue.ticketed provider=${order.provider} order=${order.id} op=${op.id} documents=${documents} reconciled=${String(close.reconciled)}`,
    );
    await this.confirm(tenantId, outcome.order);
  }

  /** La orden ya estaba emitida (otra vía la emitió): la operación se cierra sin llamar a nadie. */
  private async closeAlreadyTicketed(
    tenantId: string,
    order: OrderRow,
    op: IssueOperationRecord,
  ): Promise<void> {
    await this.store.settle(
      tenantId,
      op.id,
      { from: ['pending', 'failed'] },
      'success',
      {
        ...op.result,
        stage: 'settled',
        settledAt: new Date().toISOString(),
        outcome: op.result.outcome ?? 'ALREADY_ISSUED',
        source: 'already-ticketed',
        retryable: false,
        reconciliationRequired: false,
        retryForbidden: false,
      },
      null,
    );
    this.logger.log(`flights.issue.already_ticketed provider=${order.provider} order=${order.id}`);
  }

  /** Una emisión que nunca salió: fallida y reintentable, con el motivo. */
  private async abandon(
    tenantId: string,
    orderId: string,
    provider: string | null,
    op: IssueOperationRecord,
    reason: string,
    actorUserId: string | undefined | null,
  ): Promise<void> {
    const done = await this.store.settle(
      tenantId,
      op.id,
      { from: ['pending'], stage: 'requested' },
      'failed',
      this.notSentResult(op.result, 'pre-check'),
      issueFailureMessage(reason),
    );
    if (!done) return;
    await this.emitFailed(tenantId, { id: orderId, provider }, op.id, actorUserId, {
      outcome: 'NOT_SENT',
      source: 'pre-check',
      retryable: true,
      reconciliationRequired: false,
    });
  }

  /**
   * Una emisión mandada que quedó sin desenlace (el worker murió, o la cola la perdió): pasa a
   * conciliación y se relee. `false` si otra ejecución ya la movió.
   */
  private async reconcileInterrupted(
    tenantId: string,
    orderId: string,
    provider: string | null,
    op: IssueOperationRecord,
    source: IssueSettlementSource,
  ): Promise<boolean> {
    const result: IssueOperationResult = {
      ...op.result,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome: 'UNVERIFIED',
      source,
      warnings: ['no-response'],
      retryable: false,
      reconciliationRequired: true,
      retryForbidden: true,
    };
    // La CAS va sólo por el estado: desde `sent` no se vuelve a `requested`, y una etapa ilegible
    // (`persistedIssueResult` la lee como `sent`) no puede quedarse pendiente para siempre.
    const done = await this.store.settle(
      tenantId,
      op.id,
      { from: ['pending'] },
      'failed',
      result,
      ISSUE_UNVERIFIED_MESSAGE,
    );
    if (!done) return false;
    await this.emitFailed(tenantId, { id: orderId, provider }, op.id, op.actorUserId, {
      outcome: 'UNVERIFIED',
      source,
      retryable: false,
      reconciliationRequired: true,
    });
    await this.scheduleVerification(tenantId, orderId, provider, op.id, {
      status: 'failed',
      result,
      actorUserId: op.actorUserId,
    });
    return true;
  }

  /**
   * Encola las tres relecturas. Si la cola no las acepta, nadie va a mirar sola esta reserva: se
   * escala ya, en vez de dejarla en duda en silencio.
   */
  private async scheduleVerification(
    tenantId: string,
    orderId: string,
    provider: string | null,
    operationId: string,
    current: {
      readonly status: OrderOperationStatus;
      readonly result: IssueOperationResult;
      readonly actorUserId: string | undefined | null;
    },
  ): Promise<void> {
    let queued = true;
    for (const [step, delayMs] of ISSUE_VERIFY_DELAYS_MS.entries()) {
      const accepted = await this.queue.enqueueVerifyIssue(
        { tenantId, orderId, operationId, step },
        { delayMs },
      );
      queued = queued && accepted;
    }
    const escalateNow = !queued && current.result.escalated !== true;
    try {
      await this.store.updateResult(tenantId, operationId, current.status, {
        ...current.result,
        verification: { queued, steps: ISSUE_VERIFY_DELAYS_MS.length },
        ...(escalateNow ? { escalated: true } : {}),
      });
    } catch (error) {
      this.logger.warn(
        `flights.issue.verification_unsaved order=${orderId} op=${operationId} error=${errorName(error)}`,
      );
    }
    if (escalateNow) {
      await this.escalate(tenantId, orderId, provider, operationId, 'issue-unverified', {
        queued: false,
        actorUserId: current.actorUserId,
      });
    }
  }

  /** Se agotaron las relecturas sin ver la reserva emitida: lo mira una persona. */
  private async exhaust(
    tenantId: string,
    orderId: string,
    provider: string | null,
    op: IssueOperationRecord,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const result: IssueOperationResult = {
      ...op.result,
      stage: 'settled',
      outcome: op.result.outcome ?? 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      retryForbidden: true,
      escalated: true,
      verification: {
        queued: op.result.verification?.queued ?? true,
        steps: op.result.verification?.steps ?? ISSUE_VERIFY_DELAYS_MS.length,
        exhausted: true,
      },
    };
    if (op.status === 'pending') {
      await this.store.settle(
        tenantId,
        op.id,
        { from: ['pending'] },
        'failed',
        result,
        ISSUE_UNVERIFIED_MESSAGE,
      );
    } else {
      await this.store.updateResult(tenantId, op.id, op.status, result);
    }
    await this.escalate(tenantId, orderId, provider, op.id, 'issue-unverified', {
      ...detail,
      outcome: result.outcome,
      actorUserId: op.actorUserId,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Efectos secundarios: eventos, documentos vistos y la confirmación al pasajero
  // -------------------------------------------------------------------------------------------

  private notSentResult(
    base: IssueOperationResult,
    source: IssueSettlementSource,
  ): IssueOperationResult {
    return {
      ...base,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome: 'NOT_SENT',
      source,
      retryable: true,
      reconciliationRequired: false,
      retryForbidden: false,
    };
  }

  private async emitFailed(
    tenantId: string,
    order: { readonly id: string; readonly provider: string | null },
    operationId: string,
    actorUserId: string | undefined | null,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.issueFailed,
      tenantId,
      actorUserId: actorUserId ?? null,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { provider: order.provider, operationId, ...payload },
    });
  }

  private async escalate(
    tenantId: string,
    orderId: string,
    provider: string | null,
    operationId: string,
    reason: TicketIssueEscalationReason,
    detail: Readonly<Record<string, unknown>> & { readonly actorUserId?: string | null },
  ): Promise<void> {
    const { actorUserId, ...rest } = detail;
    this.logger.warn(
      `flights.issue.escalated provider=${provider ?? 'unknown'} order=${orderId} op=${operationId} reason=${reason}`,
    );
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId,
      actorUserId: actorUserId ?? null,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {
        provider,
        reason,
        operationId,
        retryForbidden: true,
        reconciliationRequired: true,
        ...rest,
      },
    });
  }

  /**
   * Guarda los documentos que se vieron sin cerrar nada (una emisión parcial o en duda). Best-effort:
   * la decisión ya está tomada y escrita en la operación.
   */
  private async recordSeen(tenantId: string, order: OrderRow, view: OrderView): Promise<void> {
    if (this.tracking === undefined || !view.found) return;
    try {
      const changes = await this.tracking.recordRead(
        tenantId,
        order.id,
        flightReadOf(view, new Date()),
      );
      if (changes.added + changes.statusChanged === 0) return;
      await this.audit.emit({
        eventType: ORDER_EVENTS.flightDocumentsChanged,
        tenantId,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          provider: order.provider,
          source: 'issue',
          added: changes.added,
          statusChanged: changes.statusChanged,
        },
      });
    } catch (error) {
      this.logger.warn(
        `flights.issue.tracking_unsaved provider=${order.provider} order=${order.id} error=${errorName(error)}`,
      );
    }
  }

  /** «Billete emitido» al pasajero, salvo una reserva de prueba. Nunca rompe la emisión. */
  private async confirm(tenantId: string, order: OrderRow): Promise<void> {
    try {
      await sendAutomaticFlightConfirmation(
        { mailer: this.mailer, branding: this.branding },
        tenantId,
        order,
      );
    } catch (error) {
      this.logger.warn(
        `flights.issue.confirmation_failed provider=${order.provider} order=${order.id} error=${errorName(error)}`,
      );
    }
  }

  /**
   * El motivo de un fallo para el vendedor: el mensaje de nuestras excepciones HTTP (cuenta no
   * disponible, proveedor apagado), o el traductor del proveedor, que no hace eco de su texto.
   */
  private reasonOf(provider: string, error: unknown): string {
    if (error instanceof HttpException) return error.message;
    return this.registry.humanizeError(provider, error);
  }
}
