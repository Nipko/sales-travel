import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { HcnTrackingService, type HcnSweepReport } from '../hotels/hcn-tracking.service.js';
import {
  HotelBookingVerificationService,
  type HotelVerificationSweepReport,
} from '../hotels/hotel-booking-verification.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import {
  POST_SALE_SWEEP_EVERY_MS,
  PostSaleQueueService,
} from '../queue/post-sale-queue.service.js';
import {
  ReconciliationService,
  type ReconciliationDispatchReport,
} from '../reconciliation/reconciliation.service.js';
import {
  HotelOrderCancellationService,
  type HotelCancelVerifySweepReport,
} from './hotel-order-cancellation.service.js';
import {
  POST_SALE_SWEEP_ALL_TENANTS_FAILED,
  POST_SALE_SWEEP_EVENTS,
  POST_SALE_SWEEP_JOB_ID,
  SYSTEM_JOB_AGGREGATE,
} from './post-sale-sweep-events.js';
import {
  StaleCancelClaimService,
  type StaleCancelClaimSweepReport,
} from './stale-cancel-claim.service.js';
import {
  FlightDeadlineAlertService,
  emptyDeadlineAlertReport,
  type DeadlineAlertSweepReport,
} from './flight-deadline-alert.service.js';
import { FlightTicketIssueService, type TicketIssueSweepReport } from './ticket-issue.service.js';
import { FlightServicesService, type ServicesSweepReport } from './order-services.service.js';
import { FlightTravelersService, type TravelersSweepReport } from './order-travelers.service.js';

/** Sin Redis: la primera corrida poco después de arrancar, para adoptar lo que dejó un despliegue. */
export const POST_SALE_SWEEP_FIRST_RUN_MS = 60_000;

/**
 * Cuánto se espera a que BullMQ confirme el programador antes de barrer con el temporizador. Con
 * `REDIS_HOST` configurado y Redis caído, `upsertJobScheduler` espera la conexión sin límite: sin
 * este plazo, el barrido no correría en ningún lado mientras dure la caída.
 */
export const POST_SALE_SWEEP_SCHEDULE_WAIT_MS = 30_000;

/**
 * Barrido durable de la post-venta (docs/tbo/09 PR-4.7; 08 RNF-10 punto 1, RF-21 CA 2 y 3).
 *
 * La cola despierta cada paso a su hora, pero no es la fuente de verdad: un job se pierde si Redis
 * no estaba al encolar, si el proceso murió con la reserva en vuelo o si agotó sus reintentos. Cada
 * 15 minutos, este barrido relee Postgres y ejecuta lo vencido. Hoy: los claims de cancelación que un
 * proceso dejó en vuelo, de cualquier vertical (HARD-1), que pasan a `UNVERIFIED` sin reenviar nada
 * —van primero, porque en hoteles abren la verificación de la cancelación—; la verificación de las
 * reservas de hotel sin respuesta, la de sus cancelaciones en curso o sin verificar (PR-5.3), el seguimiento
 * del HCN (PR-5.4): sus lecturas perdidas, sus entradas en ventana y las órdenes confirmadas que se
 * quedaron sin plan; y las cuentas propias del tenant que se quedaron sin conciliación del día
 * (PR-5.5), que sin Redis es la única vía por la que se concilian. Y las emisiones de tiquetes que la
 * cola perdió (SAB-08): las pedidas que nunca salieron se abandonan sin emitir nada, y las ya
 * mandadas sin desenlace pasan a conciliación; ninguna se reenvía. Y el aviso de que vence el plazo
 * de emisión de una reserva de vuelo sin tiquete, a las 24 h y a las 2 h (SAB-14).
 *
 * `orders`, `order_operations` y `hotel_order_tracking` tienen RLS forzada y la API corre como
 * `app_user`, sin rol de mantenimiento ni función que la salte: el barrido recorre los tenants uno
 * por uno, cada uno con `withTenant` (pendiente c de la Fase 5). `tenants` no tiene RLS, así que la
 * lista sale entera. Un tenant que falla no frena a los demás.
 *
 * Con Redis corre como el job `post-sale-sweeper` de un Job Scheduler de BullMQ (D-TBO-29 A): una
 * corrida por intervalo aunque haya varias réplicas. Sin Redis —o si Redis no acepta el scheduler,
 * o no contesta a tiempo— corre con un temporizador del proceso, como la purga de la bóveda de
 * payloads: es justo cuando la cola no encola nada que el barrido es la única vía de que una
 * reserva sin respuesta se lea.
 * Dos corridas a la vez no se estorban: cada paso es un CAS sobre la fila.
 *
 * Cada corrida deja su rastro en `domain_events` (POST_SALE_SWEEP_EVENTS), en la raíz `platform` y
 * sin actor: `completed` con los conteos y la duración, o `failed` con la clase del error (también si
 * no pudo revisar ningún nodo). Es lo que mira Plataforma → Sistema › Procesos para avisar si el
 * barrido dejó de correr. La emisión es best-effort, como toda auditoría: no frena ni cambia el
 * resultado de la corrida.
 */
export type PostSaleSweepReport = HotelVerificationSweepReport & {
  tenants: number;
  /** Tenants cuya consulta falló entera (la base, no una orden). */
  tenantsFailed: number;
  /** Los claims de cancelación vencidos, de todas las verticales. */
  staleCancelClaims: StaleCancelClaimSweepReport;
  /** La verificación de cancelaciones de hotel, con su propio vocabulario de desenlaces. */
  cancellations: HotelCancelVerifySweepReport;
  /** El seguimiento del HCN, con el suyo. */
  hcn: HcnSweepReport;
  /** Las conciliaciones atrasadas que se encolaron (o corrieron aquí). */
  reconciliation: ReconciliationDispatchReport;
  /** Las emisiones de tiquetes pendientes que la cola perdió. */
  ticketIssues: TicketIssueSweepReport;
  /** Los avisos de plazo de emisión por vencer. */
  deadlineAlerts: DeadlineAlertSweepReport;
  /** Los cambios de servicios adicionales que quedaron pendientes: a conciliación (SAB-20). */
  serviceChanges: ServicesSweepReport;
  /** Los cambios de datos de pasajeros que quedaron pendientes: a revisión (SAB-25). */
  travelerChanges: TravelersSweepReport;
};

@Injectable()
export class PostSaleSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PostSaleSweeper');
  private readonly timers: NodeJS.Timeout[] = [];
  private scheduleWait: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  /** La raíz `platform`, donde queda el rastro de cada corrida. No cambia: se busca una vez. */
  private platformRoot: string | undefined;

  constructor(
    private readonly db: DatabaseService,
    private readonly queue: PostSaleQueueService,
    private readonly hotelBookings: HotelBookingVerificationService,
    private readonly work: InflightWorkRegistry,
    private readonly hotelCancellations: HotelOrderCancellationService,
    private readonly hcn: HcnTrackingService,
    private readonly reconciliation: ReconciliationService,
    private readonly staleClaims: StaleCancelClaimService,
    private readonly audit: AuditService,
    /** La emisión de tiquetes (SAB-08). Opcional sólo para los dobles: en la app siempre está. */
    @Optional() private readonly ticketIssues?: FlightTicketIssueService,
    /** El aviso de plazo de emisión por vencer (SAB-14). Opcional por lo mismo. */
    @Optional() private readonly deadlineAlerts?: FlightDeadlineAlertService,
    /** Los cambios de servicios pendientes (SAB-20). Opcional para los dobles de las suites. */
    @Optional() private readonly serviceChanges?: FlightServicesService,
    /** Los cambios de datos de pasajeros pendientes (SAB-25). Opcional por lo mismo. */
    @Optional() private readonly travelerChanges?: FlightTravelersService,
  ) {}

  onApplicationBootstrap(): void {
    // Al llegar la señal y no en `onModuleDestroy`: una corrida del temporizador que empezara
    // durante el drenaje se quedaría sin pool.
    this.work.onShutdown('post-sale-sweeper-timer', () => {
      this.stopTimers();
      return Promise.resolve();
    });
    // Sin `await`: con Redis caído BullMQ espera indefinidamente, y el arranque de la API no puede
    // depender del barrido. Tampoco el barrido puede depender de esa espera.
    this.scheduleWait = setTimeout(() => {
      this.logger.warn(
        'la cola no confirmó el barrido de post-venta: corre con un temporizador del proceso hasta que confirme',
      );
      this.startTimers();
    }, POST_SALE_SWEEP_SCHEDULE_WAIT_MS).unref();
    void this.queue.scheduleSweeper().then((scheduled) => {
      clearTimeout(this.scheduleWait);
      if (scheduled) {
        // Si Redis volvió después del plazo, BullMQ ya lo corre: el temporizador sólo duplicaría
        // lecturas al proveedor.
        this.clearTimers();
        this.logger.log('barrido de post-venta programado en BullMQ');
        return;
      }
      this.logger.warn(
        'barrido de post-venta sin BullMQ: corre con un temporizador del proceso cada 15 minutos',
      );
      this.startTimers();
    });
  }

  onModuleDestroy(): void {
    this.stopTimers();
  }

  /**
   * Una corrida, con su rastro: `completed` al terminar o `failed` si se cae entera (si no se puede
   * leer la lista de tenants; el error se relanza igual, para que quien la llamó —el job de BullMQ o
   * el temporizador— lo vea) o si no pudo revisar ninguno de los nodos (`AllTenantsFailed`: el informe
   * se devuelve igual). Que fallen algunos nodos no la hace fallar: se cuentan en `tenantsFailed`.
   */
  async run(now: number = Date.now()): Promise<PostSaleSweepReport> {
    const startedAt = Date.now();
    let report: PostSaleSweepReport;
    try {
      report = await this.sweep(now);
    } catch (err) {
      await this.trace(POST_SALE_SWEEP_EVENTS.failed, { errorClass: errorName(err) });
      throw err;
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (report.tenants > 0 && report.tenantsFailed >= report.tenants) {
      await this.trace(POST_SALE_SWEEP_EVENTS.failed, {
        errorClass: POST_SALE_SWEEP_ALL_TENANTS_FAILED,
        durationMs,
        tenants: report.tenants,
        tenantsFailed: report.tenantsFailed,
      });
      return report;
    }
    await this.trace(POST_SALE_SWEEP_EVENTS.completed, {
      durationMs,
      tenants: report.tenants,
      tenantsFailed: report.tenantsFailed,
      examined: report.examined,
      adopted: report.adopted,
      staleCancelClaims: { ...report.staleCancelClaims },
      cancellations: { ...report.cancellations },
      hcn: { ...report.hcn },
      reconciliation: { ...report.reconciliation },
      ticketIssues: { ...report.ticketIssues },
      deadlineAlerts: { ...report.deadlineAlerts },
      serviceChanges: { ...report.serviceChanges },
      travelerChanges: { ...report.travelerChanges },
    });
    return report;
  }

  /**
   * El rastro de una corrida, en la raíz `platform` (la lee el superadmin con la RLS de siempre,
   * domain_events_subtree_read). Sin raíz —una base sin sembrar— queda sin tenant: no se pierde, pero
   * la consola no la ve. `AuditService.emit` no lanza, y si alguna vez lo hiciera el rastro se pierde
   * pero no la corrida: ni su informe ni el error que se relanza cambian por no haberlo escrito.
   */
  private async trace(eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.emit({
        eventType,
        tenantId: (await this.platformRootId()) ?? null,
        actorUserId: null,
        aggregateType: SYSTEM_JOB_AGGREGATE,
        aggregateId: POST_SALE_SWEEP_JOB_ID,
        payload,
      });
    } catch (err) {
      this.logger.warn(`post_sale.sweep.trace_failed event=${eventType} error=${errorName(err)}`);
    }
  }

  /**
   * La raíz `platform`, con el mismo criterio que TenantsService.platformRootId (la base admite una
   * sola, 0050). Se lee acá y no con ese servicio para no arrastrar la red y las invitaciones al
   * módulo del worker. `tenants` no tiene RLS. Si no se pudo leer, se reintenta en la próxima corrida.
   */
  private async platformRootId(): Promise<string | undefined> {
    if (this.platformRoot !== undefined) return this.platformRoot;
    try {
      const row = await this.db.db
        .selectFrom('tenants')
        .select('id')
        .where('tenant_type', '=', 'platform')
        .executeTakeFirst();
      this.platformRoot = row?.id;
    } catch (err) {
      this.logger.warn(`post_sale.sweep.platform_root_failed error=${errorName(err)}`);
    }
    return this.platformRoot;
  }

  private async sweep(now: number): Promise<PostSaleSweepReport> {
    const tenants = await this.db.db.selectFrom('tenants').select('id').orderBy('id').execute();
    const report: PostSaleSweepReport = {
      tenants: tenants.length,
      tenantsFailed: 0,
      examined: 0,
      adopted: 0,
      failed: 0,
      consolidated: 0,
      advanced: 0,
      'not-found': 0,
      held: 0,
      unavailable: 0,
      skipped: 0,
      staleCancelClaims: { examined: 0, expired: 0, skipped: 0, failed: 0 },
      cancellations: {
        examined: 0,
        failed: 0,
        closed: 0,
        advanced: 0,
        stuck: 0,
        settled: 0,
        held: 0,
        unavailable: 0,
        skipped: 0,
      },
      hcn: {
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
      },
      reconciliation: { accounts: 0, queued: 0, ran: 0, failed: 0 },
      ticketIssues: { examined: 0, abandoned: 0, reconciling: 0, skipped: 0 },
      deadlineAlerts: emptyDeadlineAlertReport(),
      serviceChanges: { examined: 0, reconciling: 0, skipped: 0 },
      travelerChanges: { examined: 0, escalated: 0, skipped: 0 },
    };

    for (const { id } of tenants) {
      // Cada barrido por separado: una verificación que no puede leer el tenant no deja sin mirar
      // a la otra.
      let failed = false;
      try {
        const stale = await this.staleClaims.sweepTenant(id, now);
        for (const key of Object.keys(stale) as (keyof StaleCancelClaimSweepReport)[]) {
          report.staleCancelClaims[key] += stale[key];
        }
      } catch (err) {
        failed = true;
        this.logger.warn(
          `post_sale.sweep.stale_cancel_claims.tenant_failed tenant=${id} error=${errorName(err)}`,
        );
      }
      try {
        const hotels = await this.hotelBookings.sweepTenant(id, now);
        for (const key of Object.keys(hotels) as (keyof HotelVerificationSweepReport)[]) {
          report[key] += hotels[key];
        }
      } catch (err) {
        failed = true;
        this.logger.warn(`post_sale.sweep.tenant_failed tenant=${id} error=${errorName(err)}`);
      }
      try {
        const cancellations = await this.hotelCancellations.sweepTenant(id, now);
        for (const key of Object.keys(cancellations) as (keyof HotelCancelVerifySweepReport)[]) {
          report.cancellations[key] += cancellations[key];
        }
      } catch (err) {
        failed = true;
        this.logger.warn(
          `post_sale.sweep.cancellations.tenant_failed tenant=${id} error=${errorName(err)}`,
        );
      }
      try {
        const hcn = await this.hcn.sweepTenant(id, now);
        for (const key of Object.keys(hcn) as (keyof HcnSweepReport)[]) {
          report.hcn[key] += hcn[key];
        }
      } catch (err) {
        failed = true;
        this.logger.warn(`post_sale.sweep.hcn.tenant_failed tenant=${id} error=${errorName(err)}`);
      }
      try {
        const reconciliation = await this.reconciliation.sweepTenant(id, now);
        for (const key of Object.keys(reconciliation) as (keyof ReconciliationDispatchReport)[]) {
          report.reconciliation[key] += reconciliation[key];
        }
      } catch (err) {
        failed = true;
        this.logger.warn(
          `post_sale.sweep.reconciliation.tenant_failed tenant=${id} error=${errorName(err)}`,
        );
      }
      if (this.ticketIssues !== undefined) {
        try {
          const issues = await this.ticketIssues.sweepTenant(id, now);
          for (const key of Object.keys(issues) as (keyof TicketIssueSweepReport)[]) {
            report.ticketIssues[key] += issues[key];
          }
        } catch (err) {
          failed = true;
          this.logger.warn(
            `post_sale.sweep.ticket_issues.tenant_failed tenant=${id} error=${errorName(err)}`,
          );
        }
      }
      // Los cambios de servicios que quedaron pendientes (SAB-20): a conciliación, sin reenviar nada.
      if (this.serviceChanges !== undefined) {
        try {
          const changes = await this.serviceChanges.sweepTenant(id, now);
          for (const key of Object.keys(changes) as (keyof ServicesSweepReport)[]) {
            report.serviceChanges[key] += changes[key];
          }
        } catch (err) {
          failed = true;
          this.logger.warn(
            `post_sale.sweep.service_changes.tenant_failed tenant=${id} error=${errorName(err)}`,
          );
        }
      }
      // Los cambios de datos de pasajeros que quedaron pendientes (SAB-25): a revisión, sin reenviar.
      if (this.travelerChanges !== undefined) {
        try {
          const changes = await this.travelerChanges.sweepTenant(id, now);
          for (const key of Object.keys(changes) as (keyof TravelersSweepReport)[]) {
            report.travelerChanges[key] += changes[key];
          }
        } catch (err) {
          failed = true;
          this.logger.warn(
            `post_sale.sweep.traveler_changes.tenant_failed tenant=${id} error=${errorName(err)}`,
          );
        }
      }
      // Después de las emisiones: una que la cola perdió y el barrido cerró ya no está en curso, y
      // la orden recupera su aviso en esta misma corrida.
      if (this.deadlineAlerts !== undefined) {
        try {
          const alerts = await this.deadlineAlerts.sweepTenant(id, now);
          for (const key of Object.keys(alerts) as (keyof DeadlineAlertSweepReport)[]) {
            report.deadlineAlerts[key] += alerts[key];
          }
        } catch (err) {
          failed = true;
          this.logger.warn(
            `post_sale.sweep.deadline_alerts.tenant_failed tenant=${id} error=${errorName(err)}`,
          );
        }
      }
      if (failed) report.tenantsFailed += 1;
    }

    if (report.examined > 0 || report.tenantsFailed > 0) {
      this.logger.log(
        `post_sale.sweep tenants=${report.tenants} examined=${report.examined} adopted=${report.adopted} consolidated=${report.consolidated} advanced=${report.advanced} notFound=${report['not-found']} held=${report.held} unavailable=${report.unavailable} failed=${report.failed} tenantsFailed=${report.tenantsFailed}`,
      );
    }
    const s = report.staleCancelClaims;
    if (s.examined > 0) {
      this.logger.warn(
        `post_sale.sweep.stale_cancel_claims examined=${s.examined} expired=${s.expired} skipped=${s.skipped} failed=${s.failed}`,
      );
    }
    const c = report.cancellations;
    if (c.examined > 0) {
      this.logger.log(
        `post_sale.sweep.cancellations examined=${c.examined} closed=${c.closed} advanced=${c.advanced} stuck=${c.stuck} settled=${c.settled} held=${c.held} unavailable=${c.unavailable} skipped=${c.skipped} failed=${c.failed}`,
      );
    }
    const h = report.hcn;
    if (h.examined > 0) {
      this.logger.log(
        `post_sale.sweep.hcn examined=${h.examined} adopted=${h.adopted} windowEntered=${h['window-entered']} received=${h.received} advanced=${h.advanced} missing=${h.missing} stopped=${h.stopped} paused=${h.paused} unavailable=${h.unavailable} skipped=${h.skipped} failed=${h.failed}`,
      );
    }
    const r = report.reconciliation;
    if (r.accounts > 0) {
      this.logger.log(
        `post_sale.sweep.reconciliation accounts=${r.accounts} queued=${r.queued} ran=${r.ran} failed=${r.failed}`,
      );
    }
    const a = report.deadlineAlerts;
    if (a.examined > 0) {
      this.logger.log(
        `post_sale.sweep.deadline_alerts examined=${a.examined} claimed=${a.claimed} mailed=${a.mailed} unmailed=${a.unmailed} retrying=${a.retrying} skipped=${a.skipped} failed=${a.failed}`,
      );
    }
    return report;
  }

  private startTimers(): void {
    if (this.stopped || this.timers.length > 0) return;
    const tick = (): void => {
      // Una corrida lenta no se solapa con la siguiente del mismo proceso.
      if (this.stopped || this.running) return;
      this.running = true;
      const sweep = this.run()
        .catch((err: unknown) => {
          this.logger.warn(`post_sale.sweep.failed error=${errorName(err)}`);
        })
        .finally(() => {
          this.running = false;
        });
      void this.work.track('post-sale-sweep', sweep);
    };
    // `unref`: un temporizador de mantenimiento no mantiene vivo al proceso durante un apagado.
    this.timers.push(setTimeout(tick, POST_SALE_SWEEP_FIRST_RUN_MS).unref());
    this.timers.push(setInterval(tick, POST_SALE_SWEEP_EVERY_MS).unref());
  }

  private stopTimers(): void {
    this.stopped = true;
    clearTimeout(this.scheduleWait);
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}
