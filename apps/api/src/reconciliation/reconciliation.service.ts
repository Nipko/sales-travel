import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { HotelBookingSummary, HotelBookingView, SearchContext } from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import { AuditService } from '../audit/audit.service.js';
import type { ReconciliationItemAction } from '../database/database.types.js';
import { classifyVerificationReadError } from '../hotels/hotel-booking-verification.js';
import { hotelBookProviderRaw } from '../hotels/hotel-booking.saga.js';
import { HOTEL_CANCEL_VERIFY_FIRST_MS } from '../hotels/hotel-cancellation-verification.js';
import {
  planHotelOrderObservation,
  type HotelOrderAction,
  type HotelOrderPlan,
} from '../hotels/hotel-order-state.js';
import { HcnTrackingService } from '../hotels/hcn-tracking.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { ExternalOrderIntentService } from '../orders/external-order-intent.service.js';
import { HotelOrderCancellationStore } from '../orders/hotel-order-cancellation.store.js';
import { hotelOrderEventFields } from '../orders/hotel-order-events.js';
import {
  HotelOrderTrackingStore,
  type HotelOrderReadTarget,
} from '../orders/hotel-order-tracking.store.js';
import {
  ORDER_EVENTS,
  publicProviderStatus,
  type ReconciliationDiscrepancyKind,
} from '../orders/order-events.js';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import { withProviderPayloadScope } from '../provider-payloads/provider-payload-scope.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { supportsHotelBookingsByDate } from '../providers/hotel-provider.types.js';
import {
  PostSaleQueueService,
  type ReconcileProviderAccountJob,
} from '../queue/post-sale-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  RECONCILIATION_TZ_SLACK_DAYS,
  addDays,
  observedStatus,
  planReconciliation,
  planReconciliationWindows,
  reconciliationDedupeKey,
  utcDay,
  type ReconciliationFinding,
  type ReconciliationOrder,
  type ReconciliationWindow,
} from './reconciliation.plan.js';
import {
  ReconciliationStore,
  type ReconciliationItemInput,
  type ReconciliationItemRow,
  type ReconciliationRunRow,
} from './reconciliation.store.js';

/**
 * La conciliación diaria de una cuenta de proveedor contra nuestras órdenes (docs/tbo/09 PR-5.5;
 * 04 §9; 08 RF-28; D-TBO-24 A, D-TBO-27 A, D-TBO-28 A, D-TBO-29 A). Las decisiones están en
 * `reconciliation.plan.ts`; aquí sólo se leen, se llaman y se ejecutan.
 *
 * Una corrida, por cuenta y no por tenant:
 *
 * 1. Abre la corrida en el tenant del dueño de la cuenta (una sola en curso por cuenta, 0047).
 * 2. Recorre los tenants de la red del dueño, cada uno con su contexto (`withTenant`), y junta las
 *    órdenes hechas con ESA cuenta que hay que cubrir. Nunca salta la RLS (pendiente c).
 * 3. Pide las ventanas de fechas de creación (tramos A y B) con la cuenta del dueño. Si una sola no
 *    vuelve entera y válida, la corrida termina sin cambiar nada.
 * 4. Cruza y clasifica (R1 a R8) y ejecuta. Toda divergencia de estado se confirma antes con una
 *    lectura de la reserva, con la cuenta de la orden y sólo si sigue en la red de su tenant
 *    (`registry.forOrder`, pendiente a). Lo de una orden va al tenant de la orden; una reserva sin
 *    orden (R2) y los montos del proveedor (R6), sólo al dueño de la cuenta.
 *
 * Nada aquí crea ni cancela en el proveedor. Las lecturas van con el alcance de post-venta del
 * breaker —frenar las ventas de un proveedor no impide saber qué reservas tiene— y por el cupo de
 * fondo del proveedor, que cede ante las ventas (04 §9.5 punto 5, PV-41).
 *
 * Tres disparos: el planificador diario de BullMQ (04:30 UTC), el barrido de post-venta que recupera
 * las cuentas que se quedaron sin corrida (y la única vía sin Redis) y el botón de operaciones.
 */

/** Una corrida `running` más vieja que esto se da por abandonada: el proceso murió. */
export const RECONCILIATION_RUN_STALE_MS = 60 * 60_000;

/** Desde qué minuto del día (UTC) una cuenta sin corrida se considera atrasada: 04:30 + 30 min. */
export const RECONCILIATION_SWEEP_FROM_MS = 5 * 60 * 60_000;

/** Cuántas corridas por día, como mucho, dispara el barrido para una cuenta. */
export const RECONCILIATION_SWEEP_MAX_RUNS_PER_DAY = 3;

/** Cuánto espera el barrido entre dos corridas de la misma cuenta. */
export const RECONCILIATION_SWEEP_RETRY_AFTER_MS = 60 * 60_000;

/** Desde cuándo cuentan las corridas del día: 04:30 UTC, la hora del planificador. */
const DAILY_AT_MS = (4 * 60 + 30) * 60_000;

/** Cuánto se espera a que la cola acepte un job (mismo motivo que en la verificación del Book). */
export const RECONCILIATION_ENQUEUE_WAIT_MS = 5_000;

/** Evento de auditoría del botón de operaciones. */
export const RECONCILIATION_REQUESTED_EVENT = 'ProviderReconciliationRequested';

/** Lo que ve el vendedor en la orden que la conciliación cerró como no hecha (D-TBO-24 A). */
const INTENT_ABSENT_MESSAGE =
  'El proveedor no tiene esta reserva: la conciliación no la encontró en su listado del día en que se pidió. Podés volver a reservar.';

const JobSchema = z
  .object({
    ownerTenantId: z.string().uuid(),
    accountId: z.string().uuid(),
    providerCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    trigger: z.enum(['scheduled', 'sweep', 'forced']),
    slot: z.string().regex(/^[0-9A-Za-z-]{1,40}$/),
    requestedBy: z.string().uuid().optional(),
  })
  .strict();

/** El payload de un job no es el que arma la cola. Rutas y códigos de Zod, nunca valores. */
export class ReconciliationJobInvalidError extends Error {
  constructor(issues: readonly z.ZodIssue[]) {
    super(
      `job reconcile-provider-account inválido (${issues
        .map((issue) => `${issue.path.join('.') || '(raíz)'}:${issue.code}`)
        .join(', ')})`,
    );
    this.name = 'ReconciliationJobInvalidError';
  }
}

/** El proveedor resuelto no lista reservas por fecha: la cuenta no se puede conciliar. */
export class ReconciliationNotSupportedError extends Error {
  constructor(readonly providerCode: string) {
    super(`el proveedor '${providerCode}' no lista reservas por fecha`);
    this.name = 'ReconciliationNotSupportedError';
  }
}

/**
 * El adapter devolvió otra ventana que la pedida, o una fila fuera de ella: la respuesta no vale y la
 * corrida se descarta (08 RF-28 CA). El adapter ya lo exige; esto lo comprueba en el borde.
 */
export class ReconciliationWindowMismatchError extends Error {
  constructor(readonly issue: 'range' | 'booking-date') {
    super(`ventana de la conciliación inválida (${issue})`);
    this.name = 'ReconciliationWindowMismatchError';
  }
}

/** Ya hay una corrida en curso para la cuenta. */
export class ReconciliationRunningError extends ConflictException {
  readonly reason = 'RECONCILIATION_RUNNING';

  constructor() {
    super(
      'Ya hay una conciliación en curso para esta cuenta. Esperá a que termine para pedir otra.',
    );
    this.name = 'ReconciliationRunningError';
  }
}

/** Qué pasó con una divergencia. */
export type ReconciliationOutcome =
  | ReconciliationItemAction
  /** Una cancelación nuestra (o un reembolso) que el proveedor ya terminó se cerró, sin ítem. */
  | 'settled'
  /** La lectura no confirmó lo que decía el listado (PV-33): no se cambió nada. */
  | 'unconfirmed'
  /** La lectura no se pudo hacer: la próxima corrida lo vuelve a intentar. */
  | 'unavailable'
  /** Ya estaba registrada: no se vuelve a avisar. */
  | 'duplicate'
  /** Otro camino la cambió antes. */
  | 'skipped'
  /** Algo que no es la lectura falló (la base). */
  | 'error';

export type ReconciliationRunStatusOutcome = 'completed' | 'invalid' | 'failed' | 'busy';

export interface ReconciliationRunReport {
  readonly runId?: string;
  readonly status: ReconciliationRunStatusOutcome;
  readonly windows: readonly ReconciliationWindow[];
  readonly rowsRead: number;
  readonly matched: number;
  /** Divergencias clasificadas (sin contar los cierres sin ítem). */
  readonly discrepancies: number;
  readonly findings: Readonly<Record<string, number>>;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly held: Readonly<Record<string, number>>;
  readonly errorClass?: string;
}

export interface ReconcileAccountInput {
  readonly ownerTenantId: string;
  readonly accountId: string;
  readonly providerCode: string;
  readonly trigger: ReconcileProviderAccountJob['trigger'];
  readonly requestedBy?: string;
  readonly now?: number;
  /** Relanzar un fallo transitorio de la lectura para que la cola repita la corrida. */
  readonly rethrowTransient?: boolean;
}

export interface ReconciliationDispatchReport {
  accounts: number;
  queued: number;
  /** Corridas que se ejecutaron en este proceso porque la cola no las aceptó. */
  ran: number;
  failed: number;
}

export interface ReconciliationForced {
  readonly accountId: string;
  readonly providerCode: string;
  /** `false`: sin cola, corre en este proceso en segundo plano. */
  readonly queued: boolean;
}

export interface ReconciliationReport {
  readonly runs: readonly ReconciliationRunRow[];
  /** Los ítems que ve el dueño de la cuenta: reservas externas (R2) y montos (R6). */
  readonly items: readonly ReconciliationItemRow[];
}

interface RunContext {
  readonly runId: string;
  readonly ownerTenantId: string;
  readonly accountId: string;
  readonly providerCode: string;
  readonly requestedBy?: string;
  readonly now: number;
  readonly windows: readonly ReconciliationWindow[];
}

/** Una orden de hotel leída con el tenant fijado, y ese tenant: la lectura y sus eventos van con él. */
type OrderTarget = HotelOrderReadTarget & { readonly tenantId: string };

type ReadResult =
  | { readonly kind: 'read'; readonly view: HotelBookingView }
  | { readonly kind: 'failed'; readonly error: unknown };

function errorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

/** Lo que un error dice de la corrida, sin mensajes del proveedor: la clase, y sus `ruta:código`. */
function errorClassOf(err: unknown): string {
  const issues = (err as { issues?: unknown } | null)?.issues;
  const refs =
    Array.isArray(issues) && issues.every((i) => typeof i === 'string')
      ? ` [${issues.slice(0, 5).join(', ')}]`
      : '';
  return `${errorName(err)}${refs}`.slice(0, 200);
}

/** Una respuesta que no vale entera: la corrida se descarta, y repetirla no la arregla. */
function isInvalidWindow(err: unknown): boolean {
  return /(?:Mapping|Build|Mismatch)Error$/.test(errorName(err));
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

const KEY = (value: string): string => value.trim().toUpperCase();

/** Instante desde el que cuentan las corridas del día de `now`: las 04:30 UTC. */
export function reconciliationDayStart(now: number): number {
  return Date.parse(`${utcDay(now)}T00:00:00Z`) + DAILY_AT_MS;
}

/**
 * ¿Ya es hora de que el barrido recupere las corridas del día? Desde las 05:00 UTC: media hora
 * después del planificador, para no pisar una corrida que la cola todavía está por tomar.
 */
export function reconciliationSweepOpen(now: number): boolean {
  return now >= Date.parse(`${utcDay(now)}T00:00:00Z`) + RECONCILIATION_SWEEP_FROM_MS;
}

/**
 * ¿El barrido tiene que disparar la corrida de una cuenta? Sólo en su horario, si no hay una
 * terminada (ni una viva) desde las 04:30 UTC, no se intentaron ya tres y la última empezó hace más
 * de una hora.
 */
export function reconciliationSweepDue(
  runs: readonly { readonly status: string; readonly startedAt: number }[],
  now: number,
): boolean {
  if (!reconciliationSweepOpen(now)) return false;
  if (runs.some((r) => r.status === 'completed')) return false;
  if (runs.some((r) => r.status === 'running' && r.startedAt > now - RECONCILIATION_RUN_STALE_MS)) {
    return false;
  }
  if (runs.length >= RECONCILIATION_SWEEP_MAX_RUNS_PER_DAY) return false;
  return !runs.some((r) => r.startedAt > now - RECONCILIATION_SWEEP_RETRY_AFTER_MS);
}

/** Lo que el dueño de la cuenta ve de una reserva sin orden (D-TBO-27 A): sin `TripName` ni PII. */
function externalDetails(b: HotelBookingSummary): Record<string, unknown> {
  return {
    bookingDate: b.bookingDate,
    providerStatus: observedStatus(b),
    ...(b.refundAwaited === true ? { refundAwaited: true } : {}),
    ...(b.bookingReference === undefined ? {} : { bookingReference: b.bookingReference }),
    ...(b.hotelId === undefined ? {} : { hotelId: b.hotelId }),
    ...(b.checkinDate === undefined ? {} : { checkinDate: b.checkinDate }),
    ...(b.checkoutDate === undefined ? {} : { checkoutDate: b.checkoutDate }),
    ...(b.total === undefined ? {} : { total: b.total }),
    ...(b.agencyCommission === undefined ? {} : { agencyCommission: b.agencyCommission }),
    ...(b.currency === undefined ? {} : { currency: b.currency }),
    ...(b.agencyName === undefined ? {} : { agencyName: b.agencyName }),
    ...(b.providerRecordId === undefined ? {} : { providerRecordId: b.providerRecordId }),
  };
}

const HUMAN_ACTIONS: ReadonlySet<HotelOrderAction> = new Set([
  'human-review',
  'urgent-human-review',
]);

@Injectable()
export class ReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly creds: ProviderCredentialsService,
    private readonly store: ReconciliationStore,
    private readonly tracking: HotelOrderTrackingStore,
    private readonly cancellations: HotelOrderCancellationStore,
    private readonly intents: ExternalOrderIntentService,
    private readonly holds: BookingHoldLedger,
    private readonly hcn: HcnTrackingService,
    private readonly breaker: CircuitBreakerService,
    private readonly audit: AuditService,
    private readonly queue: PostSaleQueueService,
    private readonly work: InflightWorkRegistry,
  ) {}

  onApplicationBootstrap(): void {
    // Sin `await`: con Redis caído BullMQ espera la conexión sin límite, y el arranque de la API no
    // puede depender de eso. Sin planificador, el barrido de post-venta dispara lo atrasado.
    void this.queue.scheduleReconciliation().then((scheduled) => {
      if (scheduled) this.logger.log('conciliación diaria programada en BullMQ');
      else {
        this.logger.warn(
          'conciliación diaria sin BullMQ: la dispara el barrido de post-venta a partir de las 05:00 UTC',
        );
      }
    });
  }

  // ───────────────────────── Disparos ─────────────────────────

  /**
   * El job diario del planificador: una conciliación por cuenta activa de un proveedor que concilia,
   * tenant por tenant. Lo que la cola no acepta corre en este proceso.
   */
  async runDaily(now: number = Date.now()): Promise<ReconciliationDispatchReport> {
    const providers = this.registry.reconcilableProviders();
    const report = { accounts: 0, queued: 0, ran: 0, failed: 0 };
    if (providers.length === 0) return report;
    for (const tenantId of await this.store.allTenants()) {
      let accounts: { id: string; providerCode: string }[];
      try {
        accounts = await this.creds.listActiveOwnAccounts(tenantId, providers);
      } catch (err) {
        report.failed += 1;
        this.logger.warn(
          `reconciliation.daily.tenant_failed tenant=${tenantId} error=${errorName(err)}`,
        );
        continue;
      }
      for (const account of accounts) {
        report.accounts += 1;
        const outcome = await this.dispatch(
          {
            ownerTenantId: tenantId,
            accountId: account.id,
            providerCode: account.providerCode,
            trigger: 'scheduled',
            slot: utcDay(now),
          },
          now,
        );
        report[outcome] += 1;
      }
    }
    return report;
  }

  /**
   * Las cuentas propias de un tenant que se quedaron sin corrida hoy: el planificador no corrió, la
   * cola perdió el job o la corrida falló. Postgres manda (RNF-10).
   */
  async sweepTenant(
    tenantId: string,
    now: number = Date.now(),
  ): Promise<ReconciliationDispatchReport> {
    const report = { accounts: 0, queued: 0, ran: 0, failed: 0 };
    const providers = this.registry.reconcilableProviders();
    if (providers.length === 0) return report;
    if (!reconciliationSweepOpen(now)) return report;
    const since = reconciliationDayStart(now);
    for (const account of await this.creds.listActiveOwnAccounts(tenantId, providers)) {
      const runs = await this.store.listRuns(tenantId, account.id, { since, limit: 10 });
      const due = reconciliationSweepDue(
        runs.map((r) => ({ status: r.status, startedAt: r.startedAt.getTime() })),
        now,
      );
      if (!due) continue;
      report.accounts += 1;
      const hour = new Date(now).toISOString().slice(11, 13);
      const outcome = await this.dispatch(
        {
          ownerTenantId: tenantId,
          accountId: account.id,
          providerCode: account.providerCode,
          trigger: 'sweep',
          slot: `${utcDay(now)}T${hour}`,
        },
        now,
      );
      report[outcome] += 1;
    }
    return report;
  }

  /**
   * El job `reconcile-provider-account`. Lanza sólo para que la cola repita: un fallo transitorio de
   * la lectura con intentos por delante.
   */
  async runJob(data: unknown, attempt: { readonly final: boolean }): Promise<void> {
    const parsed = JobSchema.safeParse(data);
    if (!parsed.success) throw new ReconciliationJobInvalidError(parsed.error.issues);
    const job = parsed.data;
    const now = Date.now();
    if (job.trigger !== 'forced') {
      // El planificador y el barrido pueden encolar la misma cuenta el mismo día: una basta.
      const runs = await this.store.listRuns(job.ownerTenantId, job.accountId, {
        since: reconciliationDayStart(now),
        limit: 10,
      });
      if (runs.some((r) => r.status === 'completed')) {
        this.logger.log(`reconciliation.job.already_done account=${job.accountId}`);
        return;
      }
    }
    await this.reconcileAccount({
      ownerTenantId: job.ownerTenantId,
      accountId: job.accountId,
      providerCode: job.providerCode,
      trigger: job.trigger,
      ...(job.requestedBy === undefined ? {} : { requestedBy: job.requestedBy }),
      now,
      rethrowTransient: !attempt.final,
    });
  }

  /**
   * El botón de operaciones "forzar conciliación" (D-TBO-24 A): acorta la espera de una reserva
   * bloqueada hasta la próxima corrida diaria. Sólo sobre una cuenta activa del tenant.
   *
   * @throws NotFoundException si la cuenta no es una cuenta activa del tenant de un proveedor que
   *   concilia.
   * @throws ReconciliationRunningError si ya hay una corrida en curso.
   */
  async force(
    ownerTenantId: string,
    accountId: string,
    requestedBy: string,
  ): Promise<ReconciliationForced> {
    const accounts = await this.creds.listActiveOwnAccounts(
      ownerTenantId,
      this.registry.reconcilableProviders(),
    );
    const account = accounts.find((a) => a.id === accountId);
    if (account === undefined) {
      throw new NotFoundException(
        'No encontramos una cuenta activa de este tenant, de un proveedor que se concilie, con ese id.',
      );
    }
    const now = Date.now();
    const [latest] = await this.store.listRuns(ownerTenantId, accountId, { limit: 1 });
    if (
      latest?.status === 'running' &&
      latest.startedAt.getTime() > now - RECONCILIATION_RUN_STALE_MS
    ) {
      throw new ReconciliationRunningError();
    }
    const job: ReconcileProviderAccountJob = {
      ownerTenantId,
      accountId,
      providerCode: account.providerCode,
      trigger: 'forced',
      // Un clic doble en el mismo minuto es el mismo job.
      slot: `m${Math.floor(now / 60_000)}`,
      requestedBy,
    };
    const queued = await this.enqueue(job);
    if (!queued) {
      // Sin cola: corre en este proceso y en segundo plano; la corrida queda registrada igual.
      void this.work
        .track('reconciliation', this.reconcileAccount({ ...job, now }))
        .catch((err: unknown) => {
          this.logger.warn(
            `reconciliation.forced_failed account=${accountId} error=${errorName(err)}`,
          );
        });
    }
    await this.audit.emit({
      eventType: RECONCILIATION_REQUESTED_EVENT,
      tenantId: ownerTenantId,
      actorUserId: requestedBy,
      aggregateType: 'provider_account',
      aggregateId: accountId,
      payload: { providerCode: account.providerCode, queued },
    });
    return { accountId, providerCode: account.providerCode, queued };
  }

  /** Las últimas corridas de una cuenta y lo que el dueño ve de ellas (el reporte de D-TBO-27 A). */
  async report(
    ownerTenantId: string,
    accountId: string,
    limit = 10,
  ): Promise<ReconciliationReport> {
    const runs = await this.store.listRuns(ownerTenantId, accountId, { limit });
    const items = await this.store.listItems(
      ownerTenantId,
      runs.map((r) => r.id),
    );
    return { runs, items };
  }

  // ───────────────────────── La corrida ─────────────────────────

  async reconcileAccount(input: ReconcileAccountInput): Promise<ReconciliationRunReport> {
    const now = input.now ?? Date.now();
    const runId = await this.store.startRun(input.ownerTenantId, {
      accountId: input.accountId,
      providerCode: input.providerCode,
      trigger: input.trigger,
      ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      staleBefore: now - RECONCILIATION_RUN_STALE_MS,
    });
    const empty = {
      windows: [],
      rowsRead: 0,
      matched: 0,
      discrepancies: 0,
      findings: {},
      outcomes: {},
      held: {},
    };
    if (runId === undefined) {
      this.logger.log(`reconciliation.busy account=${input.accountId}`);
      return { status: 'busy', ...empty };
    }

    const query = { provider: input.providerCode, accountId: input.accountId };
    let windows: readonly ReconciliationWindow[] = [];
    const bookings: HotelBookingSummary[] = [];
    let orders: ReconciliationOrder[] = [];
    let uncovered = 0;
    try {
      const provider = await this.registry.forAccount(input.ownerTenantId, {
        provider: input.providerCode,
        accountId: input.accountId,
      });
      const { adapter } = provider;
      if (!provider.capabilities.reconcileByDate || !supportsHotelBookingsByDate(adapter)) {
        throw new ReconciliationNotSupportedError(provider.code);
      }

      const network = await this.store.networkOf(input.ownerTenantId);
      const checkoutFrom = addDays(utcDay(now), -1);
      for (const tenantId of network) {
        orders.push(...(await this.store.listAnchors(tenantId, { ...query, checkoutFrom })));
      }
      const planned = planReconciliationWindows({
        now,
        anchors: orders.map((o) => o.createdAt),
        maxDays: adapter.maxBookingDateWindowDays,
      });
      windows = planned.windows;
      uncovered = planned.uncovered;

      const ctx: SearchContext = { tenantId: input.ownerTenantId, requestId: runId };
      for (const window of windows) {
        const result = await this.breaker.execute(
          provider.code,
          () => adapter.listBookingsByDate({ from: window.from, to: window.to }, ctx),
          { ...provider.circuit, scope: 'post-sale' },
        );
        if (result.range.from !== window.from || result.range.to !== window.to) {
          throw new ReconciliationWindowMismatchError('range');
        }
        if (result.bookings.some((b) => b.bookingDate < window.from || b.bookingDate > window.to)) {
          throw new ReconciliationWindowMismatchError('booking-date');
        }
        bookings.push(...result.bookings);
      }

      const locators = bookings.map((b) => b.providerBookingId);
      const references = bookings.flatMap((b) =>
        b.bookingReference === undefined ? [] : [b.bookingReference],
      );
      if (bookings.length > 0) {
        for (const tenantId of network) {
          orders = [
            ...orders,
            ...(await this.store.listByKeys(tenantId, { ...query, locators, references })),
          ];
        }
      }
    } catch (err) {
      const status = isInvalidWindow(err) ? 'invalid' : 'failed';
      const errorClass = errorClassOf(err);
      await this.store.finishRun(input.ownerTenantId, runId, {
        status,
        windows,
        rowsRead: bookings.length,
        rowsMatched: 0,
        discrepancies: 0,
        summary: { uncovered },
        errorClass,
      });
      this.logger.warn(
        `reconciliation.run_${status} account=${input.accountId} run=${runId} error=${errorClass}`,
      );
      if (
        status === 'failed' &&
        input.rethrowTransient === true &&
        classifyVerificationReadError(err) === 'transient'
      ) {
        throw err;
      }
      return { runId, status, ...empty, windows, rowsRead: bookings.length, errorClass };
    }

    const plan = planReconciliation({ now, windows, bookings, orders });
    const run: RunContext = {
      runId,
      ownerTenantId: input.ownerTenantId,
      accountId: input.accountId,
      providerCode: input.providerCode,
      ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      now,
      windows,
    };
    const findings: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    const held: Record<string, number> = {};
    for (const h of plan.held) increment(held, h.reason);
    for (const finding of plan.findings) {
      increment(findings, finding.kind);
      let outcome: ReconciliationOutcome;
      try {
        outcome = await this.execute(run, finding);
      } catch (err) {
        outcome = 'error';
        this.logger.warn(
          `reconciliation.finding_failed kind=${finding.kind} run=${runId} error=${errorName(err)}`,
        );
      }
      increment(outcomes, outcome);
    }
    const discrepancies = plan.findings.filter((f) => f.kind !== 'settle').length;
    await this.store.finishRun(input.ownerTenantId, runId, {
      status: 'completed',
      windows,
      rowsRead: bookings.length,
      rowsMatched: plan.matched,
      discrepancies,
      summary: {
        findings,
        outcomes,
        held,
        ambiguous: plan.ambiguous,
        uncovered,
        referenceEvidence: plan.referenceEvidence,
      },
    });
    this.logger.log(
      `reconciliation.run_completed account=${input.accountId} run=${runId} windows=${windows.length} rows=${bookings.length} matched=${plan.matched} discrepancies=${discrepancies} held=${plan.held.length} ambiguous=${plan.ambiguous}`,
    );
    return {
      runId,
      status: 'completed',
      windows,
      rowsRead: bookings.length,
      matched: plan.matched,
      discrepancies,
      findings,
      outcomes,
      held,
    };
  }

  // ───────────────────────── Cada divergencia ─────────────────────────

  private async execute(
    run: RunContext,
    finding: ReconciliationFinding,
  ): Promise<ReconciliationOutcome> {
    switch (finding.kind) {
      case 'R2':
        return this.reportExternal(run, finding.booking);
      case 'R5':
        return this.failIntent(run, finding.order);
      case 'R6':
        return this.recordPrice(run, finding);
      case 'R8':
        return this.recordStuckCancellation(run, finding.order, finding.booking);
      case 'R1':
        return this.recover(run, finding.order, finding.booking);
      case 'R3':
      case 'R4':
      case 'R7':
      case 'settle':
        return this.confirmAndApply(run, finding.kind, finding.order, finding.booking);
    }
  }

  /** R2: una reserva de la cuenta sin orden nuestra. Sólo al dueño de la cuenta (D-TBO-27 A). */
  private async reportExternal(
    run: RunContext,
    booking: HotelBookingSummary,
  ): Promise<ReconciliationOutcome> {
    const observed = observedStatus(booking);
    const inserted = await this.store.recordItem(run.ownerTenantId, {
      runId: run.runId,
      accountId: run.accountId,
      providerCode: run.providerCode,
      kind: 'R2',
      severity: 'info',
      action: 'reported',
      providerBookingId: booking.providerBookingId,
      dedupeKey: reconciliationDedupeKey(
        'R2',
        { providerBookingId: booking.providerBookingId },
        observed,
      ),
      details: externalDetails(booking),
    });
    if (!inserted) return 'duplicate';
    await this.audit.emit({
      eventType: ORDER_EVENTS.providerBookingUnmatched,
      tenantId: run.ownerTenantId,
      actorUserId: run.requestedBy ?? null,
      aggregateType: 'provider_account',
      aggregateId: run.accountId,
      payload: {
        provider: run.providerCode,
        accountId: run.accountId,
        source: 'reconciliation',
        runId: run.runId,
        confirmationNumber: booking.providerBookingId,
        providerStatus: observed,
        bookingDate: booking.bookingDate,
      },
    });
    return 'reported';
  }

  /**
   * R6: sólo se registra (PV-32, Q-89). Los montos son del dueño de la cuenta y quedan con él; la
   * orden recibe el aviso sin montos.
   */
  private async recordPrice(
    run: RunContext,
    finding: Extract<ReconciliationFinding, { kind: 'R6' }>,
  ): Promise<ReconciliationOutcome> {
    const { order, booking, price } = finding;
    const inserted = await this.store.recordItem(run.ownerTenantId, {
      runId: run.runId,
      accountId: run.accountId,
      providerCode: run.providerCode,
      kind: 'R6',
      severity: 'info',
      action: 'recorded',
      providerBookingId: booking.providerBookingId,
      dedupeKey: reconciliationDedupeKey(
        'R6',
        { providerBookingId: booking.providerBookingId },
        price.observed,
      ),
      details: {
        bookingDate: booking.bookingDate,
        total: price.total,
        ...(price.agencyCommission === undefined
          ? {}
          : { agencyCommission: price.agencyCommission }),
        ...(price.providerNet === undefined ? {} : { providerNet: price.providerNet }),
        storedNet: price.storedNet,
      },
    });
    if (!inserted) return 'duplicate';
    await this.emitDiscrepancy(run, order, 'R6', 'info', booking.providerBookingId);
    return 'recorded';
  }

  /** R8: una cancelación nuestra sin terminar después de 72 h. Ticket al proveedor, sin cambios. */
  private async recordStuckCancellation(
    run: RunContext,
    order: ReconciliationOrder,
    booking: HotelBookingSummary,
  ): Promise<ReconciliationOutcome> {
    const inserted = await this.store.recordItem(order.tenantId, {
      runId: run.runId,
      accountId: run.accountId,
      providerCode: run.providerCode,
      kind: 'R8',
      severity: 'warning',
      action: 'review',
      orderId: order.orderId,
      providerBookingId: booking.providerBookingId,
      dedupeKey: reconciliationDedupeKey(
        'R8',
        { orderId: order.orderId },
        String(order.cancelSince ?? ''),
      ),
      details: {
        providerStatus: observedStatus(booking),
        ...(order.cancelSince === null
          ? {}
          : { cancelSince: new Date(order.cancelSince).toISOString() }),
      },
    });
    if (!inserted) return 'duplicate';
    await this.emitDiscrepancy(run, order, 'R8', 'warning', booking.providerBookingId);
    this.logger.warn(
      `reconciliation.R8 provider=${run.providerCode} order=${order.orderId} run=${run.runId}`,
    );
    return 'review';
  }

  /**
   * R5 (D-TBO-24 A): una respuesta válida que cubre el día de creación del intent tampoco lo tiene.
   * Pasa a `failed` con el mismo CAS que la saga, se libera la clave y la retención de la cartera.
   */
  private async failIntent(
    run: RunContext,
    order: ReconciliationOrder,
  ): Promise<ReconciliationOutcome> {
    const target = await this.targetOf(order);
    if (
      target === undefined ||
      target.status !== 'pending' ||
      target.providerOrderId !== null ||
      target.bookingReference === null ||
      target.providerAccountId !== run.accountId ||
      target.snapshot.providerStatus !== null
    ) {
      return 'skipped';
    }
    const settled = await this.intents.settleExternalCreateIntent(
      order.tenantId,
      { id: order.orderId },
      {
        status: 'failed',
        providerRaw: {
          ...hotelBookProviderRaw({
            bookingReference: target.bookingReference,
            reason: 'not-found-by-reconciliation',
          }),
          closedBy: 'reconciliation',
        },
        errorMessage: INTENT_ABSENT_MESSAGE,
      },
    );
    // Otro camino (la verificación, una persona) la cerró antes.
    if (settled === undefined) return 'skipped';

    const { subStatus, providerStatus, hcn, hcnState } = target.snapshot;
    try {
      await this.tracking.recordRead(order.tenantId, order.orderId, {
        source: 'reconciliation',
        at: run.now,
        subStatus: null,
        expected: { subStatus, providerStatus, hcn, hcnState },
      });
    } catch (err) {
      // La orden ya dice `failed`, que es lo que manda.
      this.logger.warn(
        `reconciliation.tracking_unsaved order=${order.orderId} error=${errorName(err)}`,
      );
    }

    const day = utcDay(order.createdAt);
    const evidence = run.windows
      .filter(
        (w) =>
          w.from <= addDays(day, RECONCILIATION_TZ_SLACK_DAYS) &&
          w.to >= addDays(day, -RECONCILIATION_TZ_SLACK_DAYS),
      )
      .map((w) => `${w.from}/${w.to}`);
    await this.recordItemAfterChange(order.tenantId, {
      runId: run.runId,
      accountId: run.accountId,
      providerCode: run.providerCode,
      kind: 'R5',
      severity: 'warning',
      action: 'failed',
      orderId: order.orderId,
      dedupeKey: reconciliationDedupeKey('R5', { orderId: order.orderId }),
      details: { createdDay: day, windows: evidence },
    });
    const actorUserId = run.requestedBy ?? target.userId;
    const base = this.eventBase(run, target);
    await this.audit.emit({
      eventType: ORDER_EVENTS.created,
      tenantId: order.tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: order.orderId,
      payload: { ...base, outcome: 'FAILED', reason: 'not-found-by-reconciliation' },
    });
    await this.audit.emit({
      eventType: ORDER_EVENTS.reconciliationDiscrepancy,
      tenantId: order.tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: order.orderId,
      payload: {
        ...base,
        kind: 'R5',
        severity: 'warning',
        accountId: run.accountId,
        resolution: 'failed',
        windows: evidence,
      },
    });
    await this.releaseHold(run, target, 'failed');
    return 'failed';
  }

  /**
   * R1: un intent sin localizador que el proveedor sí tiene. Se confirma con la lectura por el
   * localizador de la fila y, si es la nuestra y está confirmada, se consolida como lo hace la
   * verificación, con `recoveredBy: 'reconciliation'`.
   */
  private async recover(
    run: RunContext,
    order: ReconciliationOrder,
    booking: HotelBookingSummary,
  ): Promise<ReconciliationOutcome> {
    const target = await this.targetOf(order);
    if (
      target === undefined ||
      target.status !== 'pending' ||
      target.providerOrderId !== null ||
      target.bookingReference === null ||
      target.providerAccountId !== run.accountId
    ) {
      return 'skipped';
    }
    const read = await this.read(run, target, booking.providerBookingId);
    if (read.kind === 'failed') return this.unavailable(run, target, read.error);
    const { view } = read;
    if (!view.found) return 'unconfirmed';

    if (
      view.bookingReference !== undefined &&
      KEY(view.bookingReference) !== KEY(target.bookingReference)
    ) {
      // La fila cruzó por referencia y la lectura dice que la reserva es de otra: una persona.
      const inserted = await this.store.recordItem(order.tenantId, {
        runId: run.runId,
        accountId: run.accountId,
        providerCode: run.providerCode,
        kind: 'R1',
        severity: 'warning',
        action: 'review',
        orderId: order.orderId,
        providerBookingId: booking.providerBookingId,
        dedupeKey: reconciliationDedupeKey('R1', { orderId: order.orderId }, 'reference-mismatch'),
        details: { issue: 'reference-mismatch' },
      });
      if (inserted) {
        await this.emitPlan(run, target, booking.providerBookingId, view, [
          { type: ORDER_EVENTS.escalated, reason: 'verified-status-unexpected' },
        ]);
      }
      return 'review';
    }

    const plan = planHotelOrderObservation(target.snapshot, {
      kind: 'recovered',
      read: view,
      by: 'reconciliation',
    });
    const expected = this.expectedOf(target);
    if (plan.actions.includes('consolidate-intent')) {
      const locator = view.providerBookingId?.trim() || booking.providerBookingId;
      const settled = await this.intents.settleExternalCreateIntent(
        order.tenantId,
        { id: order.orderId },
        {
          status: 'confirmed',
          providerOrderId: locator,
          providerRaw: {
            ...hotelBookProviderRaw({
              bookingReference: target.bookingReference,
              reason: 'recovered-by-reconciliation',
              ...(view.providerStatus === undefined ? {} : { providerStatus: view.providerStatus }),
            }),
            recoveredBy: 'reconciliation',
          },
          errorMessage: null,
        },
      );
      if (settled === undefined) return 'skipped';
      try {
        await this.tracking.recordRead(order.tenantId, order.orderId, {
          source: 'reconciliation',
          at: run.now,
          ...(plan.record === undefined ? {} : { record: plan.record }),
          subStatus: null,
          ...(plan.hcn === undefined ? {} : { hcn: plan.hcn }),
          expected,
        });
      } catch (err) {
        this.logger.warn(
          `reconciliation.tracking_unsaved order=${order.orderId} error=${errorName(err)}`,
        );
      }
      await this.recordItemAfterChange(order.tenantId, {
        runId: run.runId,
        accountId: run.accountId,
        providerCode: run.providerCode,
        kind: 'R1',
        severity: 'warning',
        action: 'recovered',
        orderId: order.orderId,
        providerBookingId: locator,
        dedupeKey: reconciliationDedupeKey('R1', { orderId: order.orderId }, 'recovered'),
        details: { providerStatus: publicProviderStatus(view.providerStatus, true) },
      });
      await this.emitPlan(run, { ...target, providerOrderId: locator }, locator, view, plan.events);
      await this.hcn.schedule({ tenantId: order.tenantId, orderId: order.orderId });
      return 'recovered';
    }

    // La encontró, pero cancelada o con un estado raro: se registra y la mira una persona.
    const won = await this.tracking.recordRead(order.tenantId, order.orderId, {
      source: 'reconciliation',
      at: run.now,
      ...(plan.record === undefined ? {} : { record: plan.record }),
      ...(plan.subStatus === 'keep' ? {} : { subStatus: plan.subStatus }),
      expected,
    });
    if (!won) return 'skipped';
    const inserted = await this.store.recordItem(order.tenantId, {
      runId: run.runId,
      accountId: run.accountId,
      providerCode: run.providerCode,
      kind: 'R1',
      severity: 'warning',
      action: 'review',
      orderId: order.orderId,
      providerBookingId: booking.providerBookingId,
      dedupeKey: reconciliationDedupeKey(
        'R1',
        { orderId: order.orderId },
        this.observedFromRead(view),
      ),
      details: { providerStatus: this.observedFromRead(view) },
    });
    if (inserted) await this.emitPlan(run, target, booking.providerBookingId, view, plan.events);
    this.logActions(run, target, plan);
    return 'review';
  }

  /**
   * R3, R4, R7 y los cierres sin ítem: lo que dijo el listado se confirma leyendo la reserva
   * (PV-33) y se aplica la tabla de 04 §6.3 con la fuente `reconciliation`, que es la que puede
   * cerrar una divergencia. Nunca se reenvía un Cancel (R4).
   */
  private async confirmAndApply(
    run: RunContext,
    kind: 'R3' | 'R4' | 'R7' | 'settle',
    order: ReconciliationOrder,
    booking: HotelBookingSummary,
  ): Promise<ReconciliationOutcome> {
    const target = await this.targetOf(order);
    if (
      target === undefined ||
      target.status !== order.status ||
      target.providerAccountId !== run.accountId
    ) {
      return 'skipped';
    }
    const read = await this.read(run, target, booking.providerBookingId);
    if (read.kind === 'failed') return this.unavailable(run, target, read.error);
    const { view } = read;
    if (!view.found) return 'unconfirmed';

    const plan = planHotelOrderObservation(target.snapshot, {
      kind: 'read',
      source: 'reconciliation',
      read: view,
    });
    const to =
      plan.orderStatus === 'keep' || plan.orderStatus === 'prior' ? undefined : plan.orderStatus;
    const verify = plan.actions.includes('verify-cancellation');
    const calendar = verify
      ? { anchorAt: run.now, nextAt: run.now + HOTEL_CANCEL_VERIFY_FIRST_MS }
      : undefined;
    const expected = this.expectedOf(target);

    let won: boolean;
    if ((to !== undefined && to !== target.status) || calendar !== undefined) {
      won = await this.cancellations.transitionByReading(order.tenantId, order.orderId, {
        from: target.status,
        to: to ?? target.status,
        expected,
        write: {
          at: run.now,
          source: 'reconciliation',
          ...(plan.record === undefined ? {} : { record: plan.record }),
          ...(plan.subStatus === 'keep' ? {} : { subStatus: plan.subStatus }),
          ...(plan.hcn === undefined ? {} : { hcn: plan.hcn }),
          stopHcn: plan.actions.includes('stop-hcn'),
          ...(calendar === undefined ? {} : { openCalendar: calendar }),
        },
      });
    } else {
      won = await this.tracking.recordRead(order.tenantId, order.orderId, {
        source: 'reconciliation',
        at: run.now,
        ...(plan.record === undefined ? {} : { record: plan.record }),
        ...(plan.subStatus === 'keep' ? {} : { subStatus: plan.subStatus }),
        ...(plan.hcn === undefined ? {} : { hcn: plan.hcn }),
        expected,
      });
    }
    if (!won) return 'skipped';

    const moved = to !== undefined && to !== target.status;
    if (to === 'cancelled' && moved) await this.releaseHold(run, target, 'cancelled');
    if (calendar !== undefined) {
      const queued = await this.enqueueVerifyCancellation(order.tenantId, order.orderId, calendar);
      if (!queued) {
        // La fila ya tiene la hora del paso: si la cola no lo despierta, lo ejecuta el barrido.
        this.logger.warn(`reconciliation.cancel_verify_not_queued order=${order.orderId}`);
      }
    }

    const action = this.itemActionOf(kind, plan, moved ? to : undefined, calendar !== undefined);
    let inserted = false;
    if (action !== undefined && kind !== 'settle') {
      const observed = this.observedFromRead(view);
      inserted = await this.recordItemAfterChange(order.tenantId, {
        runId: run.runId,
        accountId: run.accountId,
        providerCode: run.providerCode,
        kind,
        severity: kind === 'R4' ? 'critical' : 'warning',
        action,
        orderId: order.orderId,
        providerBookingId: booking.providerBookingId,
        dedupeKey: reconciliationDedupeKey(
          kind,
          { providerBookingId: booking.providerBookingId },
          observed,
        ),
        details: { providerStatus: observed },
      });
    }
    // Lo que cambió la orden avisa una vez por el CAS; lo que sólo se registra, una vez por el ítem.
    if (moved || action === undefined || kind === 'settle' || inserted) {
      await this.emitPlan(run, target, booking.providerBookingId, view, plan.events);
    }
    this.logActions(run, target, plan);

    if (kind === 'settle') return moved ? 'settled' : 'recorded';
    return action ?? 'unconfirmed';
  }

  /** Qué hizo la conciliación con una divergencia confirmada; `undefined` = la lectura no la confirmó. */
  private itemActionOf(
    kind: 'R3' | 'R4' | 'R7' | 'settle',
    plan: HotelOrderPlan,
    movedTo: string | undefined,
    verifying: boolean,
  ): ReconciliationItemAction | undefined {
    if (movedTo === 'cancelled') return 'cancelled';
    if (verifying) return 'cancellation-verifying';
    if (plan.actions.some((a) => HUMAN_ACTIONS.has(a))) return 'review';
    // R3 que la lectura ve vigente, R4 que la ve cancelada, R7 con un estado conocido: nada que decir.
    return kind === 'settle' ? 'recorded' : undefined;
  }

  // ───────────────────────── Piezas ─────────────────────────

  /** La orden y su seguimiento, leídos otra vez con el tenant de la orden fijado. */
  private async targetOf(order: ReconciliationOrder): Promise<OrderTarget | undefined> {
    const found = await this.tracking.findReadTarget(order.tenantId, order.orderId);
    return found === undefined ? undefined : { ...found, tenantId: order.tenantId };
  }

  /**
   * Lee la reserva por el localizador con la cuenta de la ORDEN y sólo si sigue en la red de su
   * tenant (`forOrder`, pendiente a): la misma cuenta que se concilia, pero con la regla de la
   * post-venta. Atada a la orden en la bóveda de payloads.
   */
  private async read(run: RunContext, target: OrderTarget, locator: string): Promise<ReadResult> {
    try {
      const provider = await this.registry.forOrder(target.tenantId, {
        orderId: target.orderId,
        provider: target.provider,
        providerAccountId: target.providerAccountId,
      });
      if (!provider.capabilities.retrieve) {
        return { kind: 'failed', error: new ReconciliationNotSupportedError(provider.code) };
      }
      const { tenantId } = target;
      const ctx: SearchContext = { tenantId, requestId: target.orderId };
      // Un job: por el cupo de fondo del proveedor, que cede ante las ventas (PV-41).
      const view = await withProviderPayloadScope({ tenantId, orderId: target.orderId }, () =>
        this.breaker.execute(
          provider.code,
          () => provider.adapter.getBooking(locator, ctx, { purpose: 'background' }),
          { ...provider.circuit, scope: 'post-sale' },
        ),
      );
      return { kind: 'read', view };
    } catch (err) {
      return { kind: 'failed', error: err };
    }
  }

  /**
   * El ítem de algo que ya se escribió en la orden. No lanza: si el registro falla, los eventos y la
   * liberación de la retención que siguen tienen que salir igual, porque la orden ya cambió y la
   * próxima corrida no la vuelve a ver en el mismo estado. `false` = no quedó registrado.
   */
  private async recordItemAfterChange(
    tenantId: string,
    item: ReconciliationItemInput,
  ): Promise<boolean> {
    try {
      return await this.store.recordItem(tenantId, item);
    } catch (err) {
      this.logger.warn(
        `reconciliation.item_unsaved kind=${item.kind} order=${item.orderId ?? '-'} run=${item.runId} error=${errorName(err)}`,
      );
      return false;
    }
  }

  private unavailable(run: RunContext, target: OrderTarget, err: unknown): ReconciliationOutcome {
    this.logger.warn(
      `reconciliation.read_unavailable provider=${run.providerCode} order=${target.orderId} run=${run.runId} error=${errorName(err)}`,
    );
    return 'unavailable';
  }

  private expectedOf(
    target: HotelOrderReadTarget,
  ): Pick<HotelOrderReadTarget['snapshot'], 'subStatus' | 'providerStatus' | 'hcn' | 'hcnState'> {
    const { subStatus, providerStatus, hcn, hcnState } = target.snapshot;
    return { subStatus, providerStatus, hcn, hcnState };
  }

  private observedFromRead(view: HotelBookingView): string {
    return publicProviderStatus(
      view.providerStatus ?? view.status,
      view.status !== undefined && view.status !== 'UNKNOWN',
    );
  }

  private async emitDiscrepancy(
    run: RunContext,
    order: ReconciliationOrder,
    kind: ReconciliationDiscrepancyKind,
    severity: 'info' | 'warning' | 'critical',
    locator: string,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.reconciliationDiscrepancy,
      tenantId: order.tenantId,
      actorUserId: run.requestedBy ?? order.userId,
      aggregateType: 'order',
      aggregateId: order.orderId,
      payload: {
        provider: run.providerCode,
        vertical: 'hotels',
        source: 'reconciliation',
        runId: run.runId,
        kind,
        severity,
        accountId: run.accountId,
        confirmationNumber: locator,
        ...(order.bookingReference === null ? {} : { bookingReference: order.bookingReference }),
      },
    });
  }

  /** Los eventos que decidió la tabla, sin nombres, email ni texto del proveedor. */
  private async emitPlan(
    run: RunContext,
    target: OrderTarget,
    locator: string,
    view: HotelBookingView,
    events: HotelOrderPlan['events'],
  ): Promise<void> {
    const { tenantId } = target;
    for (const event of events) {
      await this.audit.emit({
        eventType: event.type,
        tenantId,
        actorUserId: run.requestedBy ?? target.userId,
        aggregateType: 'order',
        aggregateId: target.orderId,
        payload: {
          ...this.eventBase(run, target),
          providerBookingId: locator,
          ...hotelOrderEventFields(event, {
            providerAccountId: run.accountId,
            providerOrderId: target.providerOrderId ?? locator,
            view,
          }),
        },
      });
    }
  }

  private eventBase(run: RunContext, target: HotelOrderReadTarget): Record<string, unknown> {
    return {
      provider: run.providerCode,
      vertical: 'hotels',
      source: 'reconciliation',
      runId: run.runId,
      ...(target.providerOrderId === null ? {} : { providerBookingId: target.providerOrderId }),
      ...(target.bookingReference === null ? {} : { bookingReference: target.bookingReference }),
    };
  }

  /**
   * Libera la retención de la cartera de una orden que quedó `cancelled` o `failed`. Si no se puede,
   * la orden queda con la retención tomada y se escala; el rechazo desde Carteras la libera.
   */
  private async releaseHold(
    run: RunContext,
    target: OrderTarget,
    closedAs: 'cancelled' | 'failed',
  ): Promise<void> {
    const { tenantId } = target;
    const actor = run.requestedBy ?? target.userId;
    try {
      if (closedAs === 'cancelled')
        await this.holds.releaseCancelled(tenantId, target.orderId, actor);
      else await this.holds.releaseFailed(tenantId, target.orderId, actor);
    } catch (err) {
      this.logger.warn(
        `reconciliation.hold_release_failed provider=${run.providerCode} order=${target.orderId} error=${errorName(err)}`,
      );
      await this.audit.emit({
        eventType: ORDER_EVENTS.escalated,
        tenantId,
        actorUserId: actor,
        aggregateType: 'order',
        aggregateId: target.orderId,
        payload: {
          ...this.eventBase(run, target),
          reason: 'portfolio-hold-release-failed',
          queued: false,
          errorName: errorName(err),
        },
      });
    }
  }

  /** Lo que necesita una persona queda en el log con el id de la orden y códigos, nada más. */
  private logActions(run: RunContext, target: OrderTarget, plan: HotelOrderPlan): void {
    for (const action of plan.actions) {
      if (
        action === 'human-review' ||
        action === 'urgent-human-review' ||
        action === 'notify-agency'
      ) {
        this.logger.warn(
          `reconciliation.${action} provider=${run.providerCode} order=${target.orderId} run=${run.runId}`,
        );
      }
    }
  }

  private async dispatch(
    job: ReconcileProviderAccountJob,
    now: number,
  ): Promise<'queued' | 'ran' | 'failed'> {
    if (await this.enqueue(job)) return 'queued';
    try {
      // Sin cola: corre aquí. Sin relanzar: la próxima pasada del barrido lo vuelve a intentar.
      await this.reconcileAccount({ ...job, now });
      return 'ran';
    } catch (err) {
      this.logger.warn(
        `reconciliation.dispatch_failed account=${job.accountId} error=${errorName(err)}`,
      );
      return 'failed';
    }
  }

  private async enqueue(job: ReconcileProviderAccountJob): Promise<boolean> {
    return this.withEnqueueWait(this.queue.enqueueReconcileAccount(job));
  }

  private async enqueueVerifyCancellation(
    tenantId: string,
    orderId: string,
    calendar: { readonly anchorAt: number; readonly nextAt: number },
  ): Promise<boolean> {
    return this.withEnqueueWait(
      this.queue.enqueueVerifyCancellation(
        { tenantId, orderId, step: 0, anchorAt: calendar.anchorAt },
        { delayMs: Math.max(0, calendar.nextAt - Date.now()) },
      ),
    );
  }

  /**
   * Con `REDIS_HOST` configurado y Redis caído, BullMQ espera la conexión sin límite: pasado el plazo
   * se da por no encolado y quien llama sigue por su vía de respaldo.
   */
  private async withEnqueueWait(enqueued: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), RECONCILIATION_ENQUEUE_WAIT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([enqueued, gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  }
}
