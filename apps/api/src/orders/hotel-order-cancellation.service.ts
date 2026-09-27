import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { HotelBookingView, HotelCancelResult, SearchContext } from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import type { Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { DB, OrderStatus } from '../database/database.types.js';
import {
  classifyVerificationReadError,
  type HotelVerificationRead,
} from '../hotels/hotel-booking-verification.js';
import {
  HOTEL_CANCEL_VERIFY_FIRST_MS,
  HOTEL_CANCEL_VERIFY_GRACE_MS,
  HOTEL_CANCEL_VERIFY_STEPS,
  HOTEL_CANCEL_VERIFY_SWEEP_LIMIT,
  cancellationStepIsCurrent,
  decideCancellationVerification,
  sweepCancellationStep,
  type HotelCancelVerifyEscalation,
} from '../hotels/hotel-cancellation-verification.js';
import {
  estimateHotelCancellationPenalty,
  hotelCancelObservationOf,
  hotelCancellationSnapshotOf,
  settleHotelCancel,
  type HotelCancelOutcome,
  type HotelCancellationEstimate,
} from '../hotels/hotel-cancellation.js';
import type { HotelOrderPlan } from '../hotels/hotel-order-state.js';
import { HotelProviderCapabilityError } from '../hotels/hotel-provider-errors.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { withProviderPayloadScope } from '../provider-payloads/provider-payload-scope.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import type { ResolvedHotelProvider } from '../providers/hotel-provider.types.js';
import { ProviderOrderAccountUnavailableError } from '../providers/provider.types.js';
import {
  PostSaleQueueService,
  type VerifyCancellationJob,
} from '../queue/post-sale-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type { CancelRetryPolicy } from './cancel-retry-policy.js';
import {
  HotelOrderCancellationStore,
  type HotelCancelTarget,
  type HotelCancelTrackingWrite,
} from './hotel-order-cancellation.store.js';
import { hotelOrderEventFields } from './hotel-order-events.js';
import { ORDER_EVENTS, publicProviderStatus } from './order-events.js';

/**
 * La cancelación de una orden de hotel (docs/tbo/09 PR-5.3; 08 RF-25, RF-38; 04 §4.4; D-TBO-25 A,
 * D-TBO-26 A, D-TBO-28 A).
 *
 * `OrdersService` sigue siendo el dueño de la operación `cancel`: el claim durable, la política de
 * reintentos, el cierre y `OrderCancellationAttempted` son los mismos que en vuelos. Esto pone lo
 * que es de hoteles:
 *
 * 1. **El pedido**, con la cuenta que hizo la reserva y sólo si sigue en la red del tenant
 *    (`registry.forOrder`; pendiente a), por el breaker con alcance de post-venta y atado a la orden
 *    en la bóveda de payloads.
 * 2. **Qué queda de la orden** con la respuesta (la tabla de 04 §6.3): aceptada y ya cancelada,
 *    `cancelled`; aceptada y en curso (o sin lectura que lo diga), `pending` con la "Cancelación en
 *    curso"; rechazada, el estado de antes. La fila de seguimiento se escribe en la MISMA
 *    transacción que cierra la operación.
 * 3. **`verify-cancellation`**: la lectura que cierra una cancelación en curso o sin verificar, sólo
 *    en la dirección segura, con su calendario en Postgres (0046) y un paso por job.
 * 4. **La retención de la cartera** se libera cuando la orden queda `cancelled`, la cierre quien la
 *    cierre (la respuesta o la verificación).
 * 5. **El presupuesto de la petición** (HARD-1): pasado, se responde "Cancelación en curso" y la
 *    cancelación sigue en el proceso con su claim.
 *
 * Nada aquí manda un segundo Cancel.
 */

/** Cuánto se espera a que la cola acepte un paso (mismo motivo que en la verificación del Book). */
export const HOTEL_CANCEL_VERIFY_ENQUEUE_WAIT_MS = 5_000;

/**
 * Cuánto espera la petición HTTP que cancela antes de responder "Cancelación en curso" (HARD-1).
 * Cloudflare corta a los 100 s, y la cancelación de TBO puede pasarlos: lectura previa con tres
 * intentos de 30 s, el Cancel con 60 s y la lectura posterior, más el cupo de la cuenta. 45 s
 * deja fuera de la petición sólo las cancelaciones lentas, con margen para el claim y la
 * respuesta.
 */
export const HOTEL_CANCEL_SYNC_BUDGET_MS = 45_000;

/**
 * El aviso de una cancelación que sigue después de responder. `success: true` con
 * `settlement: 'in-progress'` es "Cancelación en curso": quedó en manos de la plataforma, con su
 * claim, y el desenlace se lee en la orden. No es un error.
 */
export const HOTEL_CANCEL_STILL_RUNNING = 'CANCELLATION_STILL_RUNNING';

/** Token DI opcional de {@link HotelCancelOptions}. En producción no se provee. */
export const HOTEL_CANCEL_OPTIONS = 'HOTEL_CANCEL_OPTIONS';

export interface HotelCancelOptions {
  /** Presupuesto de la petición HTTP; por defecto {@link HOTEL_CANCEL_SYNC_BUDGET_MS}. */
  readonly syncBudgetMs?: number;
}

/** Lo que salió de esperar la cancelación dentro del presupuesto. */
export type HotelCancelWithinBudget<T> =
  | { readonly settled: true; readonly value: T }
  /** El presupuesto se agotó: la cancelación sigue en vuelo. */
  | { readonly settled: false };

const OPERATION = 'la cancelación de la reserva';

/** Ids que viajan en el payload del job; nunca PII. */
const JobIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z-]+$/);

const VerifyCancellationJobSchema = z
  .object({
    tenantId: z.string().uuid(),
    orderId: JobIdSchema,
    step: z
      .number()
      .int()
      .min(0)
      .max(HOTEL_CANCEL_VERIFY_STEPS - 1),
    anchorAt: z.number().int().nonnegative(),
    actorUserId: JobIdSchema.optional(),
  })
  .strict();

/** El payload de un job no es el que arma la cola. Rutas y códigos de Zod, nunca valores. */
export class HotelCancelVerifyJobInvalidError extends Error {
  constructor(issues: readonly z.ZodIssue[]) {
    super(
      `job verify-cancellation inválido (${issues
        .map((issue) => `${issue.path.join('.') || '(raíz)'}:${issue.code}`)
        .join(', ')})`,
    );
    this.name = 'HotelCancelVerifyJobInvalidError';
  }
}

/** La orden de hotel tal como la ve `OrdersService` al cancelarla. */
export interface HotelOrderToCancel {
  readonly id: string;
  readonly provider: string;
  readonly provider_account_id: string | null;
  readonly selected_offer: unknown;
}

/** Lo que salió del pedido al proveedor. */
export interface HotelCancelAttempt {
  readonly target: HotelCancelTarget;
  readonly result: HotelCancelResult;
  readonly estimate: HotelCancellationEstimate;
}

/** La respuesta ya decidida: lo que `OrdersService` escribe, emite y devuelve. */
export interface HotelCancelSettled {
  readonly target: HotelCancelTarget;
  readonly outcome: HotelCancelOutcome;
  /** Lo que sale por la API: códigos, nunca texto del proveedor ni un estado fuera de su enum. */
  readonly result: HotelCancelResult;
  /** Se escribe en la transacción que cierra la operación `cancel`. */
  readonly tracking: HotelCancelTrackingWrite;
  /** Vocabulario cerrado: va al resultado durable de la operación y a su `domain_event`. */
  readonly record: Readonly<Record<string, unknown>>;
  /** La lectura posterior al Cancel, si la hubo. */
  readonly view?: HotelBookingView;
}

/** Qué pasó con un paso de la verificación. */
export type HotelCancelVerifyOutcome =
  | 'closed'
  | 'advanced'
  | 'stuck'
  | 'settled'
  | 'held'
  | 'unavailable'
  /** No se hizo nada: el paso no era el vigente, u otro camino lo terminó antes. */
  | 'skipped';

export type HotelCancelVerifySweepReport = Record<HotelCancelVerifyOutcome, number> & {
  examined: number;
  /** Órdenes cuyo paso falló por algo que no es la lectura (base, cola). */
  failed: number;
};

interface VerifyRun {
  readonly tenantId: string;
  readonly target: HotelCancelTarget;
  /** El paso guardado en la fila: el CAS se hace contra éste. */
  readonly fromStep: number;
  /** El paso que se ejecuta (el barrido puede saltar pasos vencidos). */
  readonly step: number;
  readonly anchorAt: number;
  readonly runner: 'job' | 'sweep';
  readonly finalAttempt: boolean;
  readonly actorUserId: string;
}

interface ReadResult {
  readonly read: HotelVerificationRead;
  /** El error de la lectura, para relanzarlo a la cola o nombrarlo en el evento. */
  readonly error?: unknown;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

function emptyReport(): HotelCancelVerifySweepReport {
  return {
    examined: 0,
    failed: 0,
    closed: 0,
    advanced: 0,
    stuck: 0,
    settled: 0,
    held: 0,
    unavailable: 0,
    skipped: 0,
  };
}

/** La estimación como puede quedar en una fila durable o en un evento: montos y códigos. */
function estimateRecord(estimate: HotelCancellationEstimate): Record<string, unknown> {
  if (estimate.kind === 'unavailable') return { kind: estimate.kind, reason: estimate.reason };
  return { ...estimate };
}

/** Un plan de la tabla como escritura de la fila de seguimiento. */
function trackingOf(
  plan: HotelOrderPlan,
  at: number,
  source: HotelCancelTrackingWrite['source'],
): HotelCancelTrackingWrite {
  return {
    at,
    source,
    ...(plan.record === undefined ? {} : { record: plan.record }),
    ...(plan.subStatus === 'keep' ? {} : { subStatus: plan.subStatus }),
    ...(plan.hcn === undefined ? {} : { hcn: plan.hcn }),
    ...(plan.actions.includes('stop-hcn') ? { stopHcn: true } : {}),
  };
}

@Injectable()
export class HotelOrderCancellationService {
  private readonly logger = new Logger(HotelOrderCancellationService.name);
  private readonly syncBudgetMs: number;

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly store: HotelOrderCancellationStore,
    private readonly breaker: CircuitBreakerService,
    private readonly audit: AuditService,
    private readonly queue: PostSaleQueueService,
    private readonly holds: BookingHoldLedger,
    /** Opcional sólo para los dobles: en la app es global (`LifecycleModule`). */
    @Optional() private readonly inflight?: InflightWorkRegistry,
    @Optional() @Inject(HOTEL_CANCEL_OPTIONS) options?: HotelCancelOptions,
  ) {
    const budget = options?.syncBudgetMs;
    this.syncBudgetMs =
      budget !== undefined && Number.isFinite(budget) && budget >= 0
        ? budget
        : HOTEL_CANCEL_SYNC_BUDGET_MS;
  }

  /** `orders.provider` es un proveedor de hoteles: su cancelación pasa por aquí. */
  handles(provider: string): boolean {
    return this.registry.capabilitiesOf(provider) !== undefined;
  }

  /**
   * La penalidad que se muestra antes de confirmar (RF-25; D-TBO-26 A), con el snapshot del PreBook
   * que la orden guardó. No llama al proveedor.
   */
  estimate(
    order: Pick<HotelOrderToCancel, 'selected_offer'>,
    now: number = Date.now(),
  ): HotelCancellationEstimate {
    return estimateHotelCancellationPenalty({
      snapshot: hotelCancellationSnapshotOf(order.selected_offer),
      now,
    });
  }

  /**
   * Antes de tomar el claim: la cuenta de la reserva sigue disponible y el proveedor cancela. Así el
   * vendedor recibe el motivo real (409 de cuenta, 400 de capacidad) y no queda una operación
   * fallida en el historial por algo que nunca salió.
   */
  async assertCancellable(tenantId: string, order: HotelOrderToCancel): Promise<void> {
    await this.providerFor(tenantId, order);
  }

  /** Dentro del claim: la orden queda en manos de esta cancelación. */
  markRequested(trx: Transaction<DB>, tenantId: string, orderId: string): Promise<void> {
    return this.store.markRequested(trx, tenantId, orderId);
  }

  /** Dentro de la transacción que cierra la operación `cancel`. */
  writeTracking(
    trx: Transaction<DB>,
    tenantId: string,
    orderId: string,
    write: HotelCancelTrackingWrite,
  ): Promise<void> {
    return this.store.writeOutcome(trx, tenantId, orderId, write);
  }

  /**
   * El pedido al proveedor. Lanza lo que lanza el ACL, sin reenvolverlo: la política de
   * cancelaciones clasifica por la forma del error (04 §4.3).
   */
  async send(tenantId: string, order: HotelOrderToCancel): Promise<HotelCancelAttempt> {
    // La orden se relee con el tenant fijado antes de llamar: una de otra agencia no existe aunque
    // las dos reserven con la misma cuenta heredada (RF-29 CA 3).
    const target = await this.store.findTarget(tenantId, order.id);
    const locator = target?.providerOrderId;
    if (target === undefined || locator === null || locator === undefined) {
      throw new NotFoundException('La reserva no existe o no tiene localizador.');
    }
    const provider = await this.providerFor(tenantId, order);
    const estimate = this.estimate(order);
    const ctx: SearchContext = { tenantId, requestId: target.orderId };
    const result = await withProviderPayloadScope({ tenantId, orderId: target.orderId }, () =>
      this.breaker.execute(
        provider.code,
        () => provider.adapter.cancelBooking({ providerBookingId: locator }, ctx),
        { ...provider.circuit, scope: 'post-sale' },
      ),
    );
    return { target, result, estimate };
  }

  /** La respuesta del proveedor, decidida con la tabla de 04 §6.3. Sin I/O. */
  settle(attempt: HotelCancelAttempt, prior: OrderStatus, now: number): HotelCancelSettled {
    const { target, result, estimate } = attempt;
    const outcome = settleHotelCancel(target.snapshot, prior, result);
    const { plan } = outcome;
    const view = hotelCancelObservationOf(result).read ?? undefined;
    const providerStatus =
      result.providerStatus === undefined
        ? undefined
        : publicProviderStatus(
            result.providerStatus,
            result.bookingStatus !== undefined && result.bookingStatus !== 'UNKNOWN',
          );
    const status = {
      ...(result.bookingStatus === undefined ? {} : { bookingStatus: result.bookingStatus }),
      ...(providerStatus === undefined ? {} : { providerStatus }),
      ...(result.refundAwaited === true ? { refundAwaited: true } : {}),
    };
    const settlement = result.success ? { settlement: outcome.settlement } : {};
    const penalty = estimate.kind === 'estimated' ? { estimatedPenalty: estimate.penalty } : {};
    const verify = plan.actions.includes('verify-cancellation');

    return {
      target,
      outcome,
      // `refundAmount` nunca: el proveedor no lo informa y la estimación no es dato suyo (04 §4.5).
      result: {
        success: result.success,
        warnings: [...result.warnings],
        ...(result.error === undefined ? {} : { error: result.error }),
        ...settlement,
        ...penalty,
        ...status,
      },
      tracking: {
        ...trackingOf(plan, now, 'cancel'),
        // El claim es de esta cancelación: ningún desenlace lo deja puesto.
        subStatus: plan.subStatus === 'keep' ? null : plan.subStatus,
        ...(verify
          ? { openCalendar: { anchorAt: now, nextAt: now + HOTEL_CANCEL_VERIFY_FIRST_MS } }
          : {}),
      },
      record: {
        vertical: 'hotels',
        ...settlement,
        ...status,
        warnings: [...result.warnings],
        ...(result.error === undefined ? {} : { errorCode: result.error }),
        estimate: estimateRecord(estimate),
        verifyScheduled: verify,
      },
      ...(view === undefined ? {} : { view }),
    };
  }

  /**
   * Lo que deja en el seguimiento un pedido que lanzó. Sin saber si se aplicó (fila 13 de 04 §6.3),
   * "cancelación sin verificar" y la lectura que la cierra en la dirección segura (PV-B); si no
   * salió o se rechazó, el claim se suelta y la orden vuelve a su estado.
   */
  thrownTracking(failure: CancelRetryPolicy, now: number): HotelCancelTrackingWrite {
    if (!failure.reconciliationRequired) return { at: now, source: 'cancel', subStatus: null };
    return {
      at: now,
      source: 'cancel',
      subStatus: 'cancel-unverified',
      openCalendar: { anchorAt: now, nextAt: now + HOTEL_CANCEL_VERIFY_FIRST_MS },
    };
  }

  /**
   * Después de cerrar la operación: los eventos de la tabla, la primera lectura de la verificación
   * y la retención de la cartera. Nunca lanza: la cancelación ya quedó escrita.
   */
  async afterSettled(
    tenantId: string,
    settled: HotelCancelSettled,
    actorUserId: string | undefined,
  ): Promise<void> {
    const { target, outcome } = settled;
    const actor = actorUserId ?? target.userId;
    for (const event of outcome.plan.events) {
      // `OrderCancellationAttempted` lo emite `OrdersService`, con el resto de la operación.
      if (event.type === ORDER_EVENTS.cancelled) continue;
      await this.audit.emit({
        eventType: event.type,
        tenantId,
        actorUserId: actor,
        aggregateType: 'order',
        aggregateId: target.orderId,
        payload: {
          ...this.eventBase(target, 'cancel'),
          ...hotelOrderEventFields(event, {
            providerAccountId: target.providerAccountId,
            providerOrderId: target.providerOrderId,
            ...(settled.view === undefined ? {} : { view: settled.view }),
          }),
        },
      });
    }
    await this.scheduleVerification(tenantId, target, settled.tracking, actor);
    if (outcome.orderStatus === 'cancelled') await this.releaseHold(tenantId, target, actor);
    this.logActions(target, outcome.plan, 'cancel');
  }

  /**
   * Después de un pedido que lanzó, o de un claim que el barrido dio por vencido: la primera
   * lectura, si se abrió el calendario.
   */
  async afterThrow(
    tenantId: string,
    order: Pick<HotelOrderToCancel, 'id' | 'provider'>,
    write: HotelCancelTrackingWrite,
    actorUserId: string,
  ): Promise<void> {
    await this.scheduleVerification(
      tenantId,
      { orderId: order.id, provider: order.provider },
      write,
      actorUserId,
    );
  }

  // ───────────────────────── El presupuesto de la petición (HARD-1) ─────────────────────────

  /**
   * Espera `work` hasta `startedAt` + el presupuesto. Si termina antes, devuelve su valor o relanza
   * su error, como si no hubiera presupuesto. Si no, la deja seguir: queda registrada para el
   * apagado ordenado y su desenlace, que ya escribe la operación, sólo va al log.
   */
  async withinBudget<T>(
    work: Promise<T>,
    startedAt: number,
    target: { readonly orderId: string; readonly provider: string },
  ): Promise<HotelCancelWithinBudget<T>> {
    const tracked = this.inflight?.track('hotel-cancel', work) ?? work;
    const outcome = tracked.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(
        () => resolve(undefined),
        Math.max(0, startedAt + this.syncBudgetMs - Date.now()),
      );
      // La espera no retiene el proceso: la cancelación ya está registrada para el apagado.
      timer.unref();
    });
    try {
      const first = await Promise.race([outcome, expired]);
      if (first === undefined) {
        this.logger.warn(
          `hotels.cancel.budget_exhausted provider=${target.provider} order=${target.orderId} budgetMs=${this.syncBudgetMs}`,
        );
        void outcome.then((late) => {
          this.logger.log(
            `hotels.cancel.finished_after_response provider=${target.provider} order=${target.orderId} outcome=${late.ok ? 'answered' : errorName(late.error)}`,
          );
        });
        return { settled: false };
      }
      if (!first.ok) throw first.error;
      return { settled: true, value: first.value };
    } finally {
      clearTimeout(timer);
    }
  }

  /** "Cancelación en curso": lo que responde la petición cuando se agotó su presupuesto. */
  stillRunning(order: Pick<HotelOrderToCancel, 'selected_offer'>): HotelCancelResult {
    const estimate = this.estimate(order);
    return {
      success: true,
      settlement: 'in-progress',
      warnings: [HOTEL_CANCEL_STILL_RUNNING],
      ...(estimate.kind === 'estimated' ? { estimatedPenalty: estimate.penalty } : {}),
    };
  }

  // ───────────────────────── verify-cancellation ─────────────────────────

  /**
   * Un paso del calendario. Lanza sólo para que la cola repita: un fallo de transporte con intentos
   * por delante, o la base caída.
   */
  async runJob(data: unknown, attempt: { readonly final: boolean }): Promise<void> {
    const parsed = VerifyCancellationJobSchema.safeParse(data);
    if (!parsed.success) throw new HotelCancelVerifyJobInvalidError(parsed.error.issues);
    const job = parsed.data;

    const target = await this.store.findTarget(job.tenantId, job.orderId);
    if (
      target === undefined ||
      !cancellationStepIsCurrent(target.calendar, job.step, job.anchorAt)
    ) {
      this.logger.log(
        `hotels.cancel_verify.step_not_current order=${job.orderId} step=${job.step}`,
      );
      return;
    }
    await this.runStep({
      tenantId: job.tenantId,
      target,
      fromStep: job.step,
      step: job.step,
      anchorAt: job.anchorAt,
      runner: 'job',
      finalAttempt: attempt.final,
      actorUserId: job.actorUserId ?? target.userId,
    });
  }

  /**
   * Los pasos vencidos de un tenant que la cola perdió. Una orden que falla no frena a las demás:
   * queda vencida y la retoma la corrida siguiente.
   */
  async sweepTenant(
    tenantId: string,
    now: number = Date.now(),
  ): Promise<HotelCancelVerifySweepReport> {
    const due = await this.store.listDue(tenantId, {
      dueBefore: now - HOTEL_CANCEL_VERIFY_GRACE_MS,
      limit: HOTEL_CANCEL_VERIFY_SWEEP_LIMIT,
    });
    const report = emptyReport();
    for (const target of due) {
      report.examined += 1;
      const { anchorAt, step } = target.calendar;
      // El CHECK de 0046 lo garantiza: un paso vencido tiene ancla y paso.
      if (anchorAt === null || step === null) {
        report.skipped += 1;
        continue;
      }
      try {
        const outcome = await this.runStep({
          tenantId,
          target,
          fromStep: step,
          step: sweepCancellationStep(step, anchorAt, now),
          anchorAt,
          runner: 'sweep',
          finalAttempt: true,
          actorUserId: target.userId,
        });
        report[outcome] += 1;
      } catch (err) {
        report.failed += 1;
        this.logger.warn(
          `hotels.cancel_verify.sweep_failed order=${target.orderId} error=${errorName(err)}`,
        );
      }
    }
    return report;
  }

  private async runStep(run: VerifyRun): Promise<HotelCancelVerifyOutcome> {
    const { tenantId, target } = run;
    const { read, error } = await this.read(tenantId, target);
    const decision = decideCancellationVerification({
      order: target.snapshot,
      read,
      step: run.step,
      anchorAt: run.anchorAt,
      runner: run.runner,
      finalAttempt: run.finalAttempt,
    });
    const now = Date.now();
    const view = read.kind === 'read' ? read.view : undefined;

    switch (decision.kind) {
      case 'retry':
        // La cola repite la lectura con su backoff: es idempotente.
        throw error;
      case 'unavailable':
        if (decision.escalate) {
          await this.escalate(run, decision.reason, {
            step: run.step,
            errorName: errorName(error),
          });
        }
        return 'unavailable';
      case 'hold': {
        const won = await this.store.advance(tenantId, target.orderId, run.fromStep, {
          step: run.step + 1,
          nextAt: null,
        });
        if (!won) return 'skipped';
        await this.escalate(run, decision.reason, {
          step: run.step,
          ...(error === undefined ? {} : { errorName: errorName(error) }),
        });
        return 'held';
      }
      case 'close': {
        const won = await this.store.close(
          tenantId,
          target.orderId,
          run.fromStep,
          trackingOf(decision.plan, now, 'verify'),
        );
        if (!won) return 'skipped';
        await this.emitPlan(run, decision.plan, view);
        await this.releaseHold(tenantId, target, run.actorUserId);
        return 'closed';
      }
      case 'advance': {
        const won = await this.store.advance(tenantId, target.orderId, run.fromStep, {
          step: decision.step,
          nextAt: decision.at,
          write: trackingOf(decision.plan, now, 'verify'),
        });
        if (!won) return 'skipped';
        await this.emitPlan(run, decision.plan, view);
        const queued = await this.enqueue(
          {
            tenantId,
            orderId: target.orderId,
            step: decision.step,
            anchorAt: run.anchorAt,
            actorUserId: run.actorUserId,
          },
          decision.at,
        );
        if (!queued) {
          // La fila ya tiene la hora del paso: si la cola no lo despierta, lo ejecuta el barrido.
          this.logger.warn(
            `hotels.cancel_verify.step_not_queued order=${target.orderId} step=${decision.step}`,
          );
        }
        return 'advanced';
      }
      case 'stuck': {
        const won = await this.store.advance(tenantId, target.orderId, run.fromStep, {
          step: HOTEL_CANCEL_VERIFY_STEPS,
          nextAt: null,
          write: trackingOf(decision.plan, now, 'verify'),
        });
        if (!won) return 'skipped';
        await this.emitPlan(run, decision.plan, view);
        await this.escalate(run, 'cancellation-stuck', {
          step: run.step,
          steps: HOTEL_CANCEL_VERIFY_STEPS,
          // Un "no la encontré" no tiene estado que informar.
          ...(view === undefined || !view.found
            ? {}
            : {
                providerStatus: publicProviderStatus(
                  view.providerStatus,
                  view.status !== undefined && view.status !== 'UNKNOWN',
                ),
              }),
        });
        return 'stuck';
      }
      case 'settle': {
        const won = await this.store.advance(tenantId, target.orderId, run.fromStep, {
          step: run.step + 1,
          nextAt: null,
          write: trackingOf(decision.plan, now, 'verify'),
        });
        if (!won) return 'skipped';
        await this.emitPlan(run, decision.plan, view);
        this.logActions(target, decision.plan, 'verify');
        return 'settled';
      }
    }
  }

  private async read(tenantId: string, target: HotelCancelTarget): Promise<ReadResult> {
    const locator = target.providerOrderId;
    // Sin localizador no hay nada que leer, ahora ni después.
    if (locator === null) return { read: { kind: 'failed', error: 'permanent' } };
    let provider: ResolvedHotelProvider;
    try {
      provider = await this.registry.forOrder(tenantId, {
        orderId: target.orderId,
        provider: target.provider,
        providerAccountId: target.providerAccountId,
      });
    } catch (err) {
      // Leer con otra cuenta diría "no está" de una reserva que puede existir (04 §9.2, PV-15).
      if (err instanceof ProviderOrderAccountUnavailableError) {
        return { read: { kind: 'account-changed' }, error: err };
      }
      return { read: { kind: 'failed', error: classifyVerificationReadError(err) }, error: err };
    }
    if (!provider.capabilities.retrieve) return { read: { kind: 'failed', error: 'permanent' } };
    const ctx: SearchContext = { tenantId, requestId: target.orderId };
    try {
      const view = await withProviderPayloadScope({ tenantId, orderId: target.orderId }, () =>
        this.breaker.execute(provider.code, () => provider.adapter.getBooking(locator, ctx), {
          ...provider.circuit,
          scope: 'post-sale',
        }),
      );
      return { read: { kind: 'read', view } };
    } catch (err) {
      return { read: { kind: 'failed', error: classifyVerificationReadError(err) }, error: err };
    }
  }

  // ───────────────────────── Piezas ─────────────────────────

  private async providerFor(
    tenantId: string,
    order: HotelOrderToCancel,
  ): Promise<ResolvedHotelProvider> {
    const provider = await this.registry.forOrder(tenantId, {
      orderId: order.id,
      provider: order.provider,
      providerAccountId: order.provider_account_id,
    });
    if (!provider.capabilities.cancel)
      throw new HotelProviderCapabilityError(provider.code, OPERATION);
    return provider;
  }

  private async scheduleVerification(
    tenantId: string,
    target: Pick<HotelCancelTarget, 'orderId' | 'provider'>,
    write: HotelCancelTrackingWrite,
    actorUserId: string,
  ): Promise<void> {
    const calendar = write.openCalendar;
    if (calendar === undefined) return;
    const queued = await this.enqueue(
      { tenantId, orderId: target.orderId, step: 0, anchorAt: calendar.anchorAt, actorUserId },
      calendar.nextAt,
    );
    if (!queued) {
      this.logger.warn(
        `hotels.cancel_verify.step_not_queued provider=${target.provider} order=${target.orderId} step=0`,
      );
    }
  }

  private async emitPlan(
    run: VerifyRun,
    plan: HotelOrderPlan,
    view: HotelBookingView | undefined,
  ): Promise<void> {
    for (const event of plan.events) {
      await this.audit.emit({
        eventType: event.type,
        tenantId: run.tenantId,
        actorUserId: run.actorUserId,
        aggregateType: 'order',
        aggregateId: run.target.orderId,
        payload: {
          ...this.eventBase(run.target, 'verify'),
          ...hotelOrderEventFields(event, {
            providerAccountId: run.target.providerAccountId,
            providerOrderId: run.target.providerOrderId,
            ...(view === undefined ? {} : { view }),
          }),
          step: run.step,
        },
      });
    }
  }

  /**
   * La orden ya figura cancelada: la retención de la cartera se libera. Si no se puede, la orden
   * queda cancelada con la retención tomada y se escala; el rechazo desde Carteras la libera sin
   * tocar al proveedor.
   */
  private async releaseHold(
    tenantId: string,
    target: Pick<HotelCancelTarget, 'orderId' | 'provider' | 'bookingReference'>,
    createdBy: string,
  ): Promise<void> {
    try {
      await this.holds.releaseCancelled(tenantId, target.orderId, createdBy);
    } catch (err) {
      this.logger.warn(
        `hotels.cancel.hold_release_failed provider=${target.provider} order=${target.orderId} error=${errorName(err)}`,
      );
      await this.audit.emit({
        eventType: ORDER_EVENTS.escalated,
        tenantId,
        actorUserId: createdBy,
        aggregateType: 'order',
        aggregateId: target.orderId,
        payload: {
          provider: target.provider,
          vertical: 'hotels',
          ...(target.bookingReference === null
            ? {}
            : { bookingReference: target.bookingReference }),
          reason: 'portfolio-hold-release-failed',
          queued: false,
          errorName: errorName(err),
        },
      });
    }
  }

  private async escalate(
    run: VerifyRun,
    reason: HotelCancelVerifyEscalation,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId: run.tenantId,
      actorUserId: run.actorUserId,
      aggregateType: 'order',
      aggregateId: run.target.orderId,
      payload: {
        ...this.eventBase(run.target, 'verify'),
        reason,
        // Ningún escalamiento de la verificación deja un job nuevo: el calendario vive en la fila.
        queued: false,
        ...extra,
        retryForbidden: true,
        reconciliationRequired: true,
      },
    });
  }

  private async enqueue(job: VerifyCancellationJob, at: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), HOTEL_CANCEL_VERIFY_ENQUEUE_WAIT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([
        this.queue.enqueueVerifyCancellation(job, { delayMs: Math.max(0, at - Date.now()) }),
        gaveUp,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sin nombres, email ni texto del proveedor: códigos, localizadores y referencias. */
  private eventBase(
    target: Pick<HotelCancelTarget, 'provider' | 'providerOrderId' | 'bookingReference'>,
    source: 'cancel' | 'verify',
  ): Record<string, unknown> {
    return {
      provider: target.provider,
      vertical: 'hotels',
      source,
      ...(target.providerOrderId === null ? {} : { providerBookingId: target.providerOrderId }),
      ...(target.bookingReference === null ? {} : { bookingReference: target.bookingReference }),
    };
  }

  /** Lo que necesita una persona queda en el log con el id de la orden y códigos, nada más. */
  private logActions(
    target: Pick<HotelCancelTarget, 'orderId' | 'provider'>,
    plan: HotelOrderPlan,
    source: 'cancel' | 'verify',
  ): void {
    for (const action of plan.actions) {
      if (
        action === 'human-review' ||
        action === 'urgent-human-review' ||
        action === 'notify-agency'
      ) {
        this.logger.warn(
          `hotels.${source}.${action} provider=${target.provider} order=${target.orderId}`,
        );
      }
    }
  }
}
