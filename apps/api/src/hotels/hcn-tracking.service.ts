import { Injectable, Logger } from '@nestjs/common';
import type { HotelBookingView, SearchContext } from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import { AuditService } from '../audit/audit.service.js';
import type { HcnState } from '../database/database.types.js';
import { hotelOrderEventFields } from '../orders/hotel-order-events.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import { withProviderPayloadScope } from '../provider-payloads/provider-payload-scope.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import type { ResolvedHotelProvider } from '../providers/hotel-provider.types.js';
import { ProviderOrderAccountUnavailableError } from '../providers/provider.types.js';
import { PostSaleQueueService, type HcnCheckJob } from '../queue/post-sale-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  HCN_CHECK_GRACE_MS,
  HCN_READS,
  HCN_SWEEP_LIMIT,
  decideHcnRead,
  hcnBornOutOfWindow,
  hcnCheckIn,
  hcnCheckIsCurrent,
  hcnGate,
  hcnPlanAtWindowEntry,
  openHcnTracking,
  type HcnCheckIn,
  type HcnMissingReason,
  type HcnReadDecision,
} from './hcn-plan.js';
import {
  classifyVerificationReadError,
  type HotelVerificationRead,
} from './hotel-booking-verification.js';
import type { HotelOrderAction, HotelOrderPlan } from './hotel-order-state.js';
import {
  HcnTrackingStore,
  type HcnExpectation,
  type HcnReadWrite,
  type HcnTarget,
  type HcnWrite,
} from './hcn-tracking.store.js';

/**
 * El seguimiento del número de confirmación del hotel, HCN (docs/tbo/09 PR-5.4; 08 RF-27, RNF-10;
 * 04 §8; D-TBO-27 A, D-TBO-29 A). Las decisiones están en `hcn-plan.ts`; aquí sólo se ejecutan.
 *
 * Tres entradas:
 *
 * 1. **La confirmación** (la saga del Book o la verificación que recupera una reserva): abre el plan
 *    en la fila de seguimiento y encola la primera lectura a la hora del SLA. Nunca lanza.
 * 2. **El job `hcn-check`**, una lectura del plan: por el localizador, con la cuenta que hizo la
 *    reserva. "Todavía sin HCN" no es un error: registra la lectura y encola la siguiente a la hora.
 *    Un fallo de transporte sí se relanza para que la cola repita ESA lectura, que no cuenta.
 * 3. **El barrido**, tenant por tenant: abre el plan de las órdenes confirmadas que se quedaron sin
 *    él, hace entrar en ventana las reservas lejanas (PV-38) y ejecuta las lecturas que la cola
 *    perdió.
 *
 * El seguimiento se corta cuando la reserva se cancela (lo corta la cancelación, y aquí si se la
 * encuentra cancelada), cuando termina el día de entrada o cuando llega el HCN. Agotado el plan se
 * emite `HotelConfirmationNumberMissing` y se crea la tarea de operaciones `hcn-ticket`, sin PII:
 * una persona escala a TBO por el canal comercial (D-TBO-27 A). Nunca cambia `orders.status`.
 */

/** Cuánto se espera a que la cola acepte una lectura (el mismo motivo que en la verificación). */
export const HCN_ENQUEUE_WAIT_MS = 5_000;

/** Ids que viajan en el payload del job; nunca PII. */
const JobIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z-]+$/);

const HcnCheckJobSchema = z
  .object({
    tenantId: z.string().uuid(),
    orderId: JobIdSchema,
    attempt: z
      .number()
      .int()
      .min(0)
      .max(HCN_READS - 1),
  })
  .strict();

/** Lo que la tabla de 04 §6.3 manda a una persona: queda en el log con el id y códigos. */
const LOGGED_ACTIONS: ReadonlySet<HotelOrderAction> = new Set([
  'human-review',
  'urgent-human-review',
  'notify-agency',
  'voucher-alert',
]);

/** Lo que puede ir a la tarea de operaciones desde las columnas de la orden: códigos, no texto. */
const CODE = /^[0-9A-Za-z._-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** El payload de un job no es el que arma la cola. Rutas y códigos de Zod, nunca valores. */
export class HcnCheckJobInvalidError extends Error {
  constructor(issues: readonly z.ZodIssue[]) {
    super(
      `job hcn-check inválido (${issues
        .map((issue) => `${issue.path.join('.') || '(raíz)'}:${issue.code}`)
        .join(', ')})`,
    );
    this.name = 'HcnCheckJobInvalidError';
  }
}

/** Qué dejó `schedule`. */
export interface HcnScheduled {
  /** El plan quedó abierto por esta llamada. */
  readonly opened: boolean;
  /** La primera lectura quedó encolada. Sin Redis, `false`: la ejecuta el barrido. */
  readonly queued: boolean;
}

/** Qué pasó con una orden en el barrido o en un job. */
export type HcnOutcome =
  | 'received'
  | 'advanced'
  | 'missing'
  | 'stopped'
  | 'paused'
  | 'unavailable'
  | 'window-entered'
  /** No se hizo nada: la lectura no era la vigente, u otro camino la registró antes. */
  | 'skipped';

export type HcnSweepReport = Record<HcnOutcome, number> & {
  examined: number;
  /** Órdenes confirmadas sin plan a las que el barrido les abrió uno. */
  adopted: number;
  /** Órdenes cuyo paso falló por algo que no es la lectura (base, cola). */
  failed: number;
};

interface Run {
  readonly tenantId: string;
  readonly target: HcnTarget;
  readonly runner: 'job' | 'sweep';
  readonly finalAttempt: boolean;
}

interface ReadResult {
  readonly read: HotelVerificationRead;
  /** El error de la lectura, para relanzarlo a la cola o nombrarlo en el evento. */
  readonly error?: unknown;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

function emptyReport(): HcnSweepReport {
  return {
    examined: 0,
    adopted: 0,
    failed: 0,
    received: 0,
    advanced: 0,
    missing: 0,
    stopped: 0,
    paused: 0,
    unavailable: 0,
    'window-entered': 0,
    skipped: 0,
  };
}

/** `YYYY-MM-DD` del día anterior a `now` en UTC: el check-in más viejo que puede seguir en curso. */
function dayBefore(now: number): string {
  return new Date(now - 86_400_000).toISOString().slice(0, 10);
}

function checkInOf(target: HcnTarget): HcnCheckIn | undefined {
  return target.checkinDate === null ? undefined : hcnCheckIn(target.checkinDate);
}

function codeOrNull(value: string | null, pattern: RegExp): string | null {
  return value !== null && pattern.test(value) ? value : null;
}

/** Lo que una lectura deja en la fila, según la tabla de 04 §6.3. */
function readWriteOf(plan: HotelOrderPlan, at: number): HcnReadWrite {
  return {
    at,
    ...(plan.record === undefined ? {} : { record: plan.record }),
    ...(plan.subStatus === 'keep' ? {} : { subStatus: plan.subStatus }),
    ...(plan.hcn === undefined ? {} : { hcn: plan.hcn.hcn }),
  };
}

@Injectable()
export class HcnTrackingService {
  private readonly logger = new Logger(HcnTrackingService.name);

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly store: HcnTrackingStore,
    private readonly breaker: CircuitBreakerService,
    private readonly audit: AuditService,
    private readonly queue: PostSaleQueueService,
  ) {}

  // ───────────────────────── 1. Desde la confirmación ─────────────────────────

  /**
   * Abre el plan de una orden recién confirmada y encola su primera lectura. Nunca lanza: la
   * reserva ya está confirmada, y si esto falla el barrido la encuentra sin plan y lo abre.
   */
  async schedule(input: {
    readonly tenantId: string;
    readonly orderId: string;
  }): Promise<HcnScheduled> {
    try {
      const target = await this.store.findTarget(input.tenantId, input.orderId);
      if (target === undefined) return { opened: false, queued: false };
      return await this.open(input.tenantId, target, Date.now());
    } catch (err) {
      this.logger.warn(`hcn.schedule_failed order=${input.orderId} error=${errorName(err)}`);
      return { opened: false, queued: false };
    }
  }

  // ───────────────────────── 2. El job ─────────────────────────

  /**
   * Una lectura del plan. Lanza sólo para que la cola repita: un fallo de transporte con intentos
   * por delante, o la base caída.
   */
  async runJob(data: unknown, attempt: { readonly final: boolean }): Promise<void> {
    const parsed = HcnCheckJobSchema.safeParse(data);
    if (!parsed.success) throw new HcnCheckJobInvalidError(parsed.error.issues);
    const job = parsed.data;

    const target = await this.store.findTarget(job.tenantId, job.orderId);
    if (target === undefined || !hcnCheckIsCurrent(target.tracking, job.attempt, Date.now())) {
      this.logger.log(`hcn.check_not_current order=${job.orderId} attempt=${job.attempt}`);
      return;
    }
    await this.runStep({
      tenantId: job.tenantId,
      target,
      runner: 'job',
      finalAttempt: attempt.final,
    });
  }

  // ───────────────────────── 3. El barrido ─────────────────────────

  /**
   * Lo pendiente de un tenant. Una orden que falla no frena a las demás: queda como estaba y la
   * retoma la corrida siguiente.
   */
  async sweepTenant(tenantId: string, now: number = Date.now()): Promise<HcnSweepReport> {
    const report = emptyReport();

    const unplanned = await this.store.listUnplanned(tenantId, {
      providers: this.readableProviders(),
      checkinFrom: dayBefore(now),
      limit: HCN_SWEEP_LIMIT,
    });
    for (const target of unplanned) {
      report.examined += 1;
      try {
        const { opened } = await this.open(tenantId, target, now);
        if (opened) report.adopted += 1;
        else report.skipped += 1;
      } catch (err) {
        report.failed += 1;
        this.logger.warn(`hcn.adopt_failed order=${target.orderId} error=${errorName(err)}`);
      }
    }

    const due = await this.store.listDue(tenantId, {
      scheduledBefore: now - HCN_CHECK_GRACE_MS,
      windowBefore: now,
      limit: HCN_SWEEP_LIMIT,
    });
    for (const target of due) {
      report.examined += 1;
      try {
        report[await this.sweepOne(tenantId, target)] += 1;
      } catch (err) {
        report.failed += 1;
        this.logger.warn(`hcn.sweep_failed order=${target.orderId} error=${errorName(err)}`);
      }
    }
    return report;
  }

  private async sweepOne(tenantId: string, target: HcnTarget): Promise<HcnOutcome> {
    if (target.tracking.state !== 'out-of-window') {
      return this.runStep({ tenantId, target, runner: 'sweep', finalAttempt: true });
    }
    const entryAt = target.tracking.nextAt;
    // El CHECK de 0042 no deja una entrada en ventana sin hora; si faltara, no hay desde dónde contar.
    if (entryAt === null) return 'skipped';
    const entered = hcnPlanAtWindowEntry(entryAt);
    const won = await this.store.advance(
      tenantId,
      target.orderId,
      { state: 'out-of-window', attempts: target.tracking.attempts },
      { state: 'scheduled', priority: entered.priority, attempts: 0, nextAt: entered.firstCheckAt },
    );
    if (!won) return 'skipped';
    await this.enqueue({ tenantId, orderId: target.orderId, attempt: 0 }, entered.firstCheckAt);
    return 'window-entered';
  }

  // ───────────────────────── El plan ─────────────────────────

  private async open(tenantId: string, target: HcnTarget, now: number): Promise<HcnScheduled> {
    if (
      target.status !== 'confirmed' ||
      target.providerOrderId === null ||
      target.tracking.state !== null ||
      !this.readableProviders().includes(target.provider)
    ) {
      return { opened: false, queued: false };
    }
    const checkIn = checkInOf(target);
    if (checkIn === undefined) {
      // No se puede ubicar el SLA. La orden la escribió otra versión del código: la mira una persona.
      this.logger.warn(`hcn.unplannable provider=${target.provider} order=${target.orderId}`);
      return { opened: false, queued: false };
    }
    const opening = openHcnTracking({ bookedAt: target.createdAt, checkIn, now });
    const opened = await this.store.open(tenantId, target.orderId, opening);
    if (!opened || opening.state !== 'scheduled') return { opened, queued: false };
    const queued = await this.enqueue(
      { tenantId, orderId: target.orderId, attempt: 0 },
      opening.nextAt,
    );
    return { opened, queued };
  }

  private async runStep(run: Run): Promise<HcnOutcome> {
    const { tenantId, target } = run;
    const { attempts } = target.tracking;
    const from: HcnExpectation = { state: 'scheduled', attempts };
    const checkIn = checkInOf(target);

    const gate = hcnGate({ status: target.status, now: Date.now(), endsAt: checkIn?.endsAt });
    if (gate.kind === 'stop') {
      const won = await this.store.advance(tenantId, target.orderId, from, {
        state: 'stopped',
        attempts,
        nextAt: null,
      });
      if (won) this.logger.log(`hcn.stopped order=${target.orderId} reason=${gate.reason}`);
      return won ? 'stopped' : 'skipped';
    }
    if (gate.kind === 'pause') {
      // Sin job: el de esta lectura ya corrió y su `jobId` sigue tomado. La retoma el barrido.
      const won = await this.store.advance(tenantId, target.orderId, from, {
        state: 'scheduled',
        attempts,
        nextAt: gate.until,
      });
      return won ? 'paused' : 'skipped';
    }

    const { read, error } = await this.read(tenantId, target);
    const decision = decideHcnRead({
      order: target.snapshot,
      read,
      attempt: attempts,
      bornOutOfWindow: checkIn !== undefined && hcnBornOutOfWindow(target.createdAt, checkIn),
      now: Date.now(),
      runner: run.runner,
      finalAttempt: run.finalAttempt,
    });
    const view = read.kind === 'read' ? read.view : undefined;

    switch (decision.kind) {
      case 'retry':
        // La cola repite la lectura con su backoff: es idempotente y no cuenta como intento.
        throw error;
      case 'unavailable':
        if (decision.escalate) await this.escalate(run, decision.reason, errorName(error));
        return 'unavailable';
      case 'received':
      case 'stop':
      case 'next':
        return this.afterRead(run, decision, view);
      case 'missing':
        return this.missing(run, decision, view);
    }
  }

  /** Una lectura que dice algo del HCN: se registra con CAS, se emite y, si toca, se sigue. */
  private async afterRead(
    run: Run,
    decision: Extract<HcnReadDecision, { kind: 'received' | 'stop' | 'next' }>,
    view: HotelBookingView | undefined,
  ): Promise<HcnOutcome> {
    const { tenantId, target } = run;
    const attempts = target.tracking.attempts + 1;
    const state: HcnState =
      decision.kind === 'received'
        ? 'received'
        : decision.kind === 'stop'
          ? 'stopped'
          : 'scheduled';
    const nextAt = decision.kind === 'next' ? decision.at : null;
    const won = await this.store.advance(tenantId, target.orderId, this.expectation(target), {
      state,
      attempts,
      nextAt,
      read: readWriteOf(decision.plan, Date.now()),
    });
    if (!won) return 'skipped';
    await this.emitPlan(run, decision.plan, view, attempts);
    if (nextAt === null) return decision.kind === 'received' ? 'received' : 'stopped';

    const queued = await this.enqueue(
      { tenantId, orderId: target.orderId, attempt: attempts },
      nextAt,
    );
    if (!queued) {
      // La fila ya tiene la hora de la lectura: si la cola no la despierta, la ejecuta el barrido.
      this.logger.warn(`hcn.check_not_queued order=${target.orderId} attempt=${attempts}`);
    }
    return 'advanced';
  }

  /** Se deja de preguntar: evento y, salvo PV-38, la tarea de operaciones en la misma transacción. */
  private async missing(
    run: Run,
    decision: Extract<HcnReadDecision, { kind: 'missing' }>,
    view: HotelBookingView | undefined,
  ): Promise<HcnOutcome> {
    const { tenantId, target } = run;
    const { plan } = decision;
    // Sólo una lectura hecha cuenta como intento del plan.
    const attempts = target.tracking.attempts + (plan === undefined ? 0 : 1);
    const write: HcnWrite = {
      state: 'missing',
      attempts,
      nextAt: null,
      ...(plan === undefined ? {} : { read: readWriteOf(plan, Date.now()) }),
      ...(decision.ticket ? { ticket: this.ticketOf(target, decision.reason, attempts) } : {}),
    };
    const from =
      plan === undefined
        ? { state: 'scheduled' as const, attempts: target.tracking.attempts }
        : this.expectation(target);
    const won = await this.store.advance(tenantId, target.orderId, from, write);
    if (!won) return 'skipped';
    if (plan !== undefined) await this.emitPlan(run, plan, view, attempts);
    await this.audit.emit({
      eventType: ORDER_EVENTS.hotelConfirmationNumberMissing,
      tenantId,
      actorUserId: target.userId,
      aggregateType: 'order',
      aggregateId: target.orderId,
      payload: {
        ...this.eventBase(target),
        confirmationNumber: target.providerOrderId,
        priority: target.tracking.priority,
        attempts,
        reason: decision.reason,
        ticketOpened: decision.ticket,
      },
    });
    this.logger.warn(
      `hcn.missing provider=${target.provider} order=${target.orderId} reason=${decision.reason} ticket=${decision.ticket}`,
    );
    return 'missing';
  }

  private async read(tenantId: string, target: HcnTarget): Promise<ReadResult> {
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
      // Leer con otra cuenta diría "no está" de una reserva que existe (04 §9.2, PV-15).
      if (err instanceof ProviderOrderAccountUnavailableError) {
        return { read: { kind: 'account-changed' }, error: err };
      }
      return { read: { kind: 'failed', error: classifyVerificationReadError(err) }, error: err };
    }
    if (!provider.capabilities.retrieve) return { read: { kind: 'failed', error: 'permanent' } };
    const ctx: SearchContext = { tenantId, requestId: target.orderId };
    try {
      // Post-venta: frenar las ventas de un proveedor no puede impedir leer lo que ya se vendió.
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

  /** Proveedores de hoteles cuyas reservas se pueden leer: los únicos con HCN que seguir. */
  private readableProviders(): string[] {
    return this.registry
      .registered()
      .map((r) => r.code)
      .filter((code) => this.registry.capabilitiesOf(code)?.retrieve === true);
  }

  /** El CAS de una escritura con lectura: el plan y lo que la fila decía de la reserva. */
  private expectation(target: HcnTarget): HcnExpectation {
    const { subStatus, providerStatus, hcn } = target.snapshot;
    return {
      state: 'scheduled',
      attempts: target.tracking.attempts,
      snapshot: { subStatus, providerStatus, hcn },
    };
  }

  /**
   * La tarea de operaciones (04 §8.6): localizadores, hotel, fechas y prioridad. Ningún nombre ni
   * contacto: quien la abre los lee de la orden, con RLS. Lo que viene de la orden pasa sólo si
   * tiene forma de código o de fecha.
   */
  private ticketOf(
    target: HcnTarget,
    reason: HcnMissingReason,
    attempts: number,
  ): Record<string, unknown> {
    return {
      vertical: 'hotels',
      provider: target.provider,
      reason,
      priority: target.tracking.priority,
      attempts,
      confirmationNumber: codeOrNull(target.providerOrderId, CODE),
      bookingReference: codeOrNull(target.bookingReference, CODE),
      hotelId: codeOrNull(target.hotelId, CODE),
      checkinDate: codeOrNull(target.checkinDate, ISO_DATE),
      checkoutDate: codeOrNull(target.checkoutDate, ISO_DATE),
    };
  }

  private async emitPlan(
    run: Run,
    plan: HotelOrderPlan,
    view: HotelBookingView | undefined,
    attempt: number,
  ): Promise<void> {
    const { target } = run;
    for (const event of plan.events) {
      await this.audit.emit({
        eventType: event.type,
        tenantId: run.tenantId,
        actorUserId: target.userId,
        aggregateType: 'order',
        aggregateId: target.orderId,
        payload: {
          ...this.eventBase(target),
          ...hotelOrderEventFields(event, {
            providerAccountId: target.providerAccountId,
            providerOrderId: target.providerOrderId,
            view,
          }),
          priority: target.tracking.priority,
          attempt,
        },
      });
    }
    for (const action of plan.actions.filter((a) => LOGGED_ACTIONS.has(a))) {
      this.logger.warn(`hcn.${action} provider=${target.provider} order=${target.orderId}`);
    }
  }

  private async escalate(
    run: Run,
    reason: Extract<HcnReadDecision, { kind: 'unavailable' }>['reason'],
    error: string,
  ): Promise<void> {
    const { target } = run;
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId: run.tenantId,
      actorUserId: target.userId,
      aggregateType: 'order',
      aggregateId: target.orderId,
      payload: {
        ...this.eventBase(target),
        reason,
        // El plan vive en la fila: la lectura queda vencida y la retoma el barrido.
        queued: false,
        attempt: target.tracking.attempts,
        errorName: error,
        retryForbidden: true,
        reconciliationRequired: true,
      },
    });
  }

  private async enqueue(job: HcnCheckJob, at: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), HCN_ENQUEUE_WAIT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([
        this.queue.enqueueHcnCheck(job, { delayMs: Math.max(0, at - Date.now()) }),
        gaveUp,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sin nombres, email ni texto del proveedor: códigos, localizadores y referencias. */
  private eventBase(target: HcnTarget): Record<string, unknown> {
    return {
      provider: target.provider,
      vertical: 'hotels',
      source: 'hcn',
      ...(target.providerOrderId === null ? {} : { providerBookingId: target.providerOrderId }),
      ...(target.bookingReference === null ? {} : { bookingReference: target.bookingReference }),
    };
  }
}
