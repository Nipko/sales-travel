import { Injectable, Logger } from '@nestjs/common';
import type { SearchContext } from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import { AuditService } from '../audit/audit.service.js';
import { ExternalOrderIntentService } from '../orders/external-order-intent.service.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import { withProviderPayloadScope } from '../provider-payloads/provider-payload-scope.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  supportsHotelBookingByClientReference,
  type ResolvedHotelProvider,
} from '../providers/hotel-provider.types.js';
import { ProviderOrderAccountUnavailableError } from '../providers/provider.types.js';
import {
  PostSaleQueueService,
  type VerifyHotelBookingJob,
} from '../queue/post-sale-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  HOTEL_BOOK_ORPHAN_ANCHOR_MS,
  HOTEL_BOOK_VERIFY_GRACE_MS,
  HOTEL_BOOK_VERIFY_STEPS,
  HOTEL_BOOK_VERIFY_SWEEP_LIMIT,
  adoptOrphan,
  classifyVerificationReadError,
  decideVerification,
  stepIsCurrent,
  sweepStep,
  verificationStepAt,
  type HotelVerificationDecision,
  type HotelVerificationEscalation,
  type HotelVerificationRead,
} from './hotel-booking-verification.js';
import {
  HotelBookingVerificationStore,
  type HotelVerificationTarget,
} from './hotel-booking-verification.store.js';
import { hotelBookProviderRaw, planBookVerification } from './hotel-booking.saga.js';
import { HcnTrackingService } from './hcn-tracking.service.js';
import { sweepRetryAt } from './sweep-retry.js';

/**
 * Verificación de una reserva de hotel cuya respuesta no llegó (docs/tbo/09 PR-4.7; 08 RF-21,
 * RF-38, RNF-10; 03 §4; 04 §7). Las decisiones están en `hotel-booking-verification.ts`; aquí sólo
 * se ejecutan.
 *
 * Tres entradas:
 *
 * 1. **La saga**, al observar un desenlace incierto: abre el calendario en la fila de seguimiento
 *    y encola el primer paso a `tf + 120 s`. Si Postgres o Redis no responden, lo dice (`tracked`,
 *    `queued`) y el barrido lo recoge después.
 * 2. **El job `verify-hotel-booking`**, un paso del calendario: lee por NUESTRA referencia y
 *    consolida, avanza, deja de preguntar o escala. Un fallo de transporte se relanza para que la
 *    cola repita la lectura; en el último intento se escala y el paso queda vencido para el barrido.
 * 3. **El barrido**, tenant por tenant: los pasos vencidos que la cola perdió y las órdenes abiertas
 *    que quedaron sin calendario. Una lectura que falla reprograma la orden con backoff (HARD-2):
 *    con la hora vieja, las mismas órdenes atascadas ocuparían cada corrida.
 *
 * Nada aquí reserva. La lectura sale con la cuenta que hizo la reserva (RF-29; D-TBO-28 A), con el
 * alcance de post-venta del breaker —frenar las ventas de un proveedor no puede impedir averiguar si
 * una reserva ya existe— y por el cupo de verificación del proveedor, que no le quita al vendedor
 * más que su techo (04 §9.5 punto 5, PV-41).
 */

/**
 * Cuánto se espera a que la cola acepte un paso. Con `REDIS_HOST` configurado y Redis caído, BullMQ
 * espera la conexión sin límite: la saga se quedaría sin su `OrderEscalated` y el barrido, colgado
 * en el primer paso que avanza. Si el job entra igual más tarde, no corre antes de su hora y
 * `stepIsCurrent` lo vuelve inofensivo.
 */
export const HOTEL_BOOK_VERIFY_ENQUEUE_WAIT_MS = 5_000;

/** Ids que viajan en el `jobId` (sin `:`) y en el payload del job; nunca PII. */
const JobIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z-]+$/);

const VerifyHotelBookingJobSchema = z
  .object({
    tenantId: z.string().uuid(),
    orderId: JobIdSchema,
    step: z
      .number()
      .int()
      .min(0)
      .max(HOTEL_BOOK_VERIFY_STEPS - 1),
    actorUserId: JobIdSchema.optional(),
  })
  .strict();

/** El payload de un job no es el que arma la cola. Rutas y códigos de Zod, nunca valores. */
export class HotelVerificationJobInvalidError extends Error {
  constructor(issues: readonly z.ZodIssue[]) {
    super(
      `job verify-hotel-booking inválido (${issues
        .map((issue) => `${issue.path.join('.') || '(raíz)'}:${issue.code}`)
        .join(', ')})`,
    );
    this.name = 'HotelVerificationJobInvalidError';
  }
}

export interface HotelVerificationScheduleInput {
  readonly tenantId: string;
  readonly orderId: string;
  /** Epoch ms del fallo observado (`tf`). */
  readonly failedAt: number;
  readonly actorUserId?: string;
}

export interface HotelVerificationScheduled {
  /** Cuándo sale la primera lectura: `tf + 120 s`. */
  readonly verifyAt: number;
  /** El calendario quedó escrito en Postgres. */
  readonly tracked: boolean;
  /** El primer paso quedó encolado. Sin Redis, `false`: lo ejecuta el barrido. */
  readonly queued: boolean;
}

/** Qué pasó con un paso. */
export type HotelVerificationOutcome =
  | 'consolidated'
  | 'advanced'
  | 'not-found'
  | 'held'
  | 'unavailable'
  /** No se hizo nada: el paso no era el vigente, u otro camino lo terminó antes. */
  | 'skipped';

export type HotelVerificationSweepReport = Record<HotelVerificationOutcome, number> & {
  examined: number;
  /** Órdenes abiertas sin calendario a las que el barrido les abrió uno. */
  adopted: number;
  /** Órdenes cuyo paso falló por algo que no es la lectura (base, cola). */
  failed: number;
};

interface Run {
  readonly tenantId: string;
  readonly target: HotelVerificationTarget;
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

function emptyReport(): HotelVerificationSweepReport {
  return {
    examined: 0,
    adopted: 0,
    failed: 0,
    consolidated: 0,
    advanced: 0,
    'not-found': 0,
    held: 0,
    unavailable: 0,
    skipped: 0,
  };
}

@Injectable()
export class HotelBookingVerificationService {
  private readonly logger = new Logger(HotelBookingVerificationService.name);

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly store: HotelBookingVerificationStore,
    private readonly intents: ExternalOrderIntentService,
    private readonly breaker: CircuitBreakerService,
    private readonly audit: AuditService,
    private readonly queue: PostSaleQueueService,
    private readonly hcn: HcnTrackingService,
  ) {}

  // ───────────────────────── 1. Desde la saga ─────────────────────────

  /**
   * Abre el calendario de una orden cuyo Book quedó incierto y encola el primer paso. Nunca lanza:
   * la saga ya tiene su desenlace y la orden `pending` con su referencia es la fuente de verdad.
   */
  async scheduleAfterUncertainBook(
    input: HotelVerificationScheduleInput,
  ): Promise<HotelVerificationScheduled> {
    const { verifyAt } = planBookVerification(input.failedAt);
    let tracked = false;
    try {
      tracked = await this.store.startCalendar(input.tenantId, input.orderId, {
        anchorAt: input.failedAt,
        step: 0,
        nextAt: verifyAt,
      });
    } catch (err) {
      this.logger.warn(
        `hotels.verify.calendar_unsaved order=${input.orderId} error=${errorName(err)}`,
      );
    }
    // Sin calendario no hay paso vigente: el job no haría nada. El barrido adopta la orden con un
    // ancla que nunca es anterior a este fallo.
    if (!tracked) return { verifyAt, tracked, queued: false };
    const queued = await this.enqueue(
      {
        tenantId: input.tenantId,
        orderId: input.orderId,
        step: 0,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      },
      verifyAt,
    );
    return { verifyAt, tracked, queued };
  }

  // ───────────────────────── 2. El job ─────────────────────────

  /**
   * Un paso del calendario. Lanza sólo para que la cola repita: un fallo de transporte con
   * intentos por delante, o la base caída.
   */
  async runJob(data: unknown, attempt: { readonly final: boolean }): Promise<void> {
    const parsed = VerifyHotelBookingJobSchema.safeParse(data);
    if (!parsed.success) throw new HotelVerificationJobInvalidError(parsed.error.issues);
    const job = parsed.data;

    const target = await this.store.findTarget(job.tenantId, job.orderId);
    if (target === undefined || !stepIsCurrent(target, job.step)) {
      this.logger.log(`hotels.verify.step_not_current order=${job.orderId} step=${job.step}`);
      return;
    }
    await this.runStep({
      tenantId: job.tenantId,
      target,
      fromStep: job.step,
      step: job.step,
      anchorAt: target.anchorAt,
      runner: 'job',
      finalAttempt: attempt.final,
      actorUserId: job.actorUserId ?? target.userId,
    });
  }

  // ───────────────────────── 3. El barrido ─────────────────────────

  /**
   * Lo vencido de un tenant. Una orden que falla no frena a las demás: si falló la lectura, se
   * reprograma con backoff; si falló la base, queda vencida y la retoma la corrida siguiente.
   */
  async sweepTenant(
    tenantId: string,
    now: number = Date.now(),
  ): Promise<HotelVerificationSweepReport> {
    const due = await this.store.listDue(tenantId, {
      dueBefore: now - HOTEL_BOOK_VERIFY_GRACE_MS,
      orphanBefore: now - HOTEL_BOOK_ORPHAN_ANCHOR_MS - HOTEL_BOOK_VERIFY_GRACE_MS,
      limit: HOTEL_BOOK_VERIFY_SWEEP_LIMIT,
    });
    const report = emptyReport();
    for (const target of due) {
      report.examined += 1;
      try {
        report[await this.sweepOne(tenantId, target, now, report)] += 1;
      } catch (err) {
        report.failed += 1;
        this.logger.warn(
          `hotels.verify.sweep_failed order=${target.orderId} error=${errorName(err)}`,
        );
      }
    }
    return report;
  }

  private async sweepOne(
    tenantId: string,
    target: HotelVerificationTarget,
    now: number,
    report: HotelVerificationSweepReport,
  ): Promise<HotelVerificationOutcome> {
    let anchorAt: number;
    let fromStep: number;
    if (target.anchorAt === null || target.step === null) {
      // RF-21 CA-2: el proceso murió entre el intent y la respuesta del Book, o no pudo escribir
      // el calendario. El ancla es el último instante en que esa reserva pudo terminar.
      const orphan = adoptOrphan(target.updatedAt, now);
      const adopted = await this.store.startCalendar(tenantId, target.orderId, {
        anchorAt: orphan.anchorAt,
        step: orphan.step,
        nextAt: orphan.at,
      });
      if (!adopted) return 'skipped';
      report.adopted += 1;
      await this.escalate(tenantId, target, target.userId, 'create-uncertain', {
        detectedBy: 'sweeper',
        step: orphan.step,
        verifyAfter: new Date(orphan.at).toISOString(),
      });
      anchorAt = orphan.anchorAt;
      fromStep = orphan.step;
    } else {
      anchorAt = target.anchorAt;
      fromStep = target.step;
    }
    const step = sweepStep(fromStep, anchorAt, now);
    const outcome = await this.runStep({
      tenantId,
      target,
      fromStep,
      step,
      anchorAt,
      runner: 'sweep',
      finalAttempt: true,
      actorUserId: target.userId,
    });
    if (outcome === 'unavailable') {
      await this.postpone(tenantId, target, { anchorAt, fromStep, step }, now);
    }
    return outcome;
  }

  /**
   * La lectura del barrido no se hizo: la próxima, con backoff y nunca después del paso siguiente
   * del calendario. El paso guardado no cambia: la lectura que falló no dijo nada.
   */
  private async postpone(
    tenantId: string,
    target: HotelVerificationTarget,
    run: { readonly anchorAt: number; readonly fromStep: number; readonly step: number },
    now: number,
  ): Promise<void> {
    const deadline = verificationStepAt(run.anchorAt, run.step + 1);
    const at = sweepRetryAt({
      now,
      dueAt: verificationStepAt(run.anchorAt, run.step) ?? now,
      ...(deadline === undefined ? {} : { deadline }),
    });
    const moved = await this.store.postpone(
      tenantId,
      target.orderId,
      { anchorAt: run.anchorAt, step: run.fromStep },
      at,
    );
    if (moved) {
      this.logger.log(
        `hotels.verify.sweep_postponed order=${target.orderId} step=${run.step} retryAt=${new Date(at).toISOString()}`,
      );
    }
  }

  // ───────────────────────── El paso ─────────────────────────

  private async runStep(run: Run): Promise<HotelVerificationOutcome> {
    const { read, error } = await this.read(run.tenantId, run.target);
    const decision = decideVerification({
      read,
      step: run.step,
      anchorAt: run.anchorAt,
      runner: run.runner,
      finalAttempt: run.finalAttempt,
    });

    switch (decision.kind) {
      case 'retry':
        // La cola repite la lectura con su backoff: es idempotente.
        throw error;
      case 'unavailable':
        if (decision.escalate) {
          await this.escalate(run.tenantId, run.target, run.actorUserId, decision.reason, {
            step: run.step,
            errorName: errorName(error),
          });
        }
        return 'unavailable';
      case 'consolidate':
        return this.consolidate(run, decision);
      case 'advance':
        return this.advance(run, decision);
      case 'not-found-yet':
        return this.notFoundYet(run);
      case 'hold':
        return this.hold(run, decision, error);
    }
  }

  private async read(tenantId: string, target: HotelVerificationTarget): Promise<ReadResult> {
    let provider: ResolvedHotelProvider;
    try {
      // La cuenta de la ORDEN, y sólo si sigue en la red del tenant: la vigente del tenant puede ser
      // otra, y leer con ésa diría "no está" de una reserva que existe (04 §9.2, PV-15).
      provider = await this.registry.forOrder(tenantId, {
        orderId: target.orderId,
        provider: target.provider,
        providerAccountId: target.providerAccountId,
      });
    } catch (err) {
      if (err instanceof ProviderOrderAccountUnavailableError) {
        return { read: { kind: 'account-changed' }, error: err };
      }
      return { read: { kind: 'failed', error: classifyVerificationReadError(err) }, error: err };
    }
    const { adapter } = provider;
    if (
      !provider.capabilities.retrieveByClientReference ||
      !supportsHotelBookingByClientReference(adapter)
    ) {
      // Un proveedor que no lee por nuestra referencia nunca va a poder verificar esta reserva.
      return { read: { kind: 'failed', error: 'permanent' } };
    }
    const ctx: SearchContext = { tenantId, requestId: target.orderId };
    try {
      // Cada RQ/RS de la lectura queda atado a su orden en la bóveda de payloads.
      const view = await withProviderPayloadScope({ tenantId, orderId: target.orderId }, () =>
        this.breaker.execute(
          provider.code,
          () =>
            adapter.getBookingByClientReference(target.bookingReference, ctx, {
              purpose: 'verification',
            }),
          { ...provider.circuit, scope: 'post-sale' },
        ),
      );
      return { read: { kind: 'read', view } };
    } catch (err) {
      return { read: { kind: 'failed', error: classifyVerificationReadError(err) }, error: err };
    }
  }

  /**
   * La encontró confirmada: el mismo CAS que la saga, con el localizador de la lectura. Después, el
   * plan del HCN, como una reserva que confirmó en línea (04 §6.3 fila 6).
   */
  private async consolidate(
    run: Run,
    decision: Extract<HotelVerificationDecision, { kind: 'consolidate' }>,
  ): Promise<HotelVerificationOutcome> {
    const { target } = run;
    const order = await this.intents.settleExternalCreateIntent(
      run.tenantId,
      { id: target.orderId },
      {
        status: 'confirmed',
        providerOrderId: decision.providerBookingId,
        providerRaw: {
          ...hotelBookProviderRaw({
            bookingReference: target.bookingReference,
            reason: 'recovered-by-reference',
            ...(decision.providerStatus === undefined
              ? {}
              : { providerStatus: decision.providerStatus }),
          }),
          recoveredBy: 'booking-reference',
        },
        errorMessage: null,
      },
    );
    // Otro camino (la saga, otro paso, una persona) ya la cerró: que emita quien la cerró.
    if (order === undefined) return 'skipped';

    try {
      await this.store.advance(run.tenantId, target.orderId, run.fromStep, {
        step: run.step + 1,
        nextAt: null,
        subStatus: null,
        ...(decision.providerStatus === undefined
          ? {}
          : { providerStatus: { value: decision.providerStatus, at: Date.now() } }),
      });
    } catch (err) {
      // La orden ya dice `confirmed`, que es lo que manda: el barrido no vuelve a mirarla.
      this.logger.warn(
        `hotels.verify.tracking_unsaved order=${target.orderId} error=${errorName(err)}`,
      );
    }
    await this.audit.emit({
      eventType: ORDER_EVENTS.verified,
      tenantId: run.tenantId,
      actorUserId: run.actorUserId,
      aggregateType: 'order',
      aggregateId: target.orderId,
      payload: {
        ...this.eventBase(target),
        verified: true,
        found: true,
        status: 'CONFIRMED',
        recoveredBy: 'booking-reference',
        providerBookingId: decision.providerBookingId,
        ...(decision.providerStatus === undefined
          ? {}
          : { providerStatus: decision.providerStatus }),
        step: run.step,
      },
    });
    await this.hcn.schedule({ tenantId: run.tenantId, orderId: target.orderId });
    return 'consolidated';
  }

  /** Todavía no aparece: el paso siguiente, a su hora. */
  private async advance(
    run: Run,
    decision: Extract<HotelVerificationDecision, { kind: 'advance' }>,
  ): Promise<HotelVerificationOutcome> {
    const won = await this.store.advance(run.tenantId, run.target.orderId, run.fromStep, {
      step: decision.step,
      nextAt: decision.at,
    });
    if (!won) return 'skipped';
    const queued = await this.enqueue(
      {
        tenantId: run.tenantId,
        orderId: run.target.orderId,
        step: decision.step,
        actorUserId: run.actorUserId,
      },
      decision.at,
    );
    if (!queued) {
      // La fila ya tiene la hora del paso: si la cola no lo despierta, lo ejecuta el barrido.
      this.logger.warn(
        `hotels.verify.step_not_queued order=${run.target.orderId} step=${decision.step}`,
      );
    }
    return 'advanced';
  }

  /**
   * No apareció en ningún paso. D-TBO-24 A: no es `failed`. La orden sigue `pending`, con la clave
   * tomada, hasta que la conciliación por fecha la cierre con evidencia fuerte.
   */
  private async notFoundYet(run: Run): Promise<HotelVerificationOutcome> {
    const won = await this.store.advance(run.tenantId, run.target.orderId, run.fromStep, {
      step: HOTEL_BOOK_VERIFY_STEPS,
      nextAt: null,
      subStatus: 'create-not-found-yet',
    });
    if (!won) return 'skipped';
    await this.escalate(run.tenantId, run.target, run.actorUserId, 'create-not-found', {
      step: run.step,
      steps: HOTEL_BOOK_VERIFY_STEPS,
    });
    return 'not-found';
  }

  /** Se deja de preguntar: lo que se leyó (o no se pudo leer) necesita una persona. */
  private async hold(
    run: Run,
    decision: Extract<HotelVerificationDecision, { kind: 'hold' }>,
    error: unknown,
  ): Promise<HotelVerificationOutcome> {
    const won = await this.store.advance(run.tenantId, run.target.orderId, run.fromStep, {
      step: run.step + 1,
      nextAt: null,
      subStatus: decision.subStatus,
      ...(decision.providerStatus === undefined
        ? {}
        : { providerStatus: { value: decision.providerStatus, at: Date.now() } }),
    });
    if (!won) return 'skipped';
    await this.escalate(run.tenantId, run.target, run.actorUserId, decision.reason, {
      step: run.step,
      ...(decision.providerStatus === undefined ? {} : { providerStatus: decision.providerStatus }),
      ...(decision.providerBookingId === undefined
        ? {}
        : { providerBookingId: decision.providerBookingId }),
      ...(error === undefined ? {} : { errorName: errorName(error) }),
    });
    return 'held';
  }

  // ───────────────────────── Piezas ─────────────────────────

  private async enqueue(job: VerifyHotelBookingJob, at: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), HOTEL_BOOK_VERIFY_ENQUEUE_WAIT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([
        this.queue.enqueueVerifyHotelBooking(job, { delayMs: Math.max(0, at - Date.now()) }),
        gaveUp,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async escalate(
    tenantId: string,
    target: HotelVerificationTarget,
    actorUserId: string,
    reason: HotelVerificationEscalation,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: target.orderId,
      payload: {
        ...this.eventBase(target),
        reason,
        // Ningún escalamiento de la verificación deja un job nuevo: el calendario vive en la fila.
        queued: false,
        ...extra,
        retryForbidden: true,
        reconciliationRequired: true,
      },
    });
  }

  /** Sin nombres, email, teléfono ni texto del proveedor: códigos, referencias y localizadores. */
  private eventBase(target: HotelVerificationTarget): Record<string, unknown> {
    return {
      provider: target.provider,
      vertical: 'hotels',
      bookingReference: target.bookingReference,
    };
  }
}
