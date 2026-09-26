import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import {
  HotelBookingVerificationService,
  type HotelVerificationSweepReport,
} from '../hotels/hotel-booking-verification.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import {
  POST_SALE_SWEEP_EVERY_MS,
  PostSaleQueueService,
} from '../queue/post-sale-queue.service.js';

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
 * 15 minutos, este barrido relee Postgres y ejecuta lo vencido. Hoy: la verificación de las reservas
 * de hotel sin respuesta. El seguimiento del HCN y la verificación de cancelaciones se suman aquí
 * con sus PR.
 *
 * `orders` y `hotel_order_tracking` tienen RLS forzada y la API corre como `app_user`, sin rol de
 * mantenimiento: el barrido recorre los tenants uno por uno, cada uno con `withTenant`. `tenants`
 * no tiene RLS, así que la lista sale entera. Un tenant que falla no frena a los demás.
 *
 * Con Redis corre como el job `post-sale-sweeper` de un Job Scheduler de BullMQ (D-TBO-29 A): una
 * corrida por intervalo aunque haya varias réplicas. Sin Redis —o si Redis no acepta el scheduler,
 * o no contesta a tiempo— corre con un temporizador del proceso, como la purga de la bóveda de
 * payloads: es justo cuando la cola no encola nada que el barrido es la única vía de que una
 * reserva sin respuesta se lea.
 * Dos corridas a la vez no se estorban: cada paso es un CAS sobre la fila.
 */
export type PostSaleSweepReport = HotelVerificationSweepReport & {
  tenants: number;
  /** Tenants cuya consulta falló entera (la base, no una orden). */
  tenantsFailed: number;
};

@Injectable()
export class PostSaleSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PostSaleSweeper');
  private readonly timers: NodeJS.Timeout[] = [];
  private scheduleWait: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly queue: PostSaleQueueService,
    private readonly hotelBookings: HotelBookingVerificationService,
    private readonly work: InflightWorkRegistry,
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

  async run(now: number = Date.now()): Promise<PostSaleSweepReport> {
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
    };

    for (const { id } of tenants) {
      try {
        const hotels = await this.hotelBookings.sweepTenant(id, now);
        for (const key of Object.keys(hotels) as (keyof HotelVerificationSweepReport)[]) {
          report[key] += hotels[key];
        }
      } catch (err) {
        report.tenantsFailed += 1;
        this.logger.warn(`post_sale.sweep.tenant_failed tenant=${id} error=${errorName(err)}`);
      }
    }

    if (report.examined > 0 || report.tenantsFailed > 0) {
      this.logger.log(
        `post_sale.sweep tenants=${report.tenants} examined=${report.examined} adopted=${report.adopted} consolidated=${report.consolidated} advanced=${report.advanced} notFound=${report['not-found']} held=${report.held} unavailable=${report.unavailable} failed=${report.failed} tenantsFailed=${report.tenantsFailed}`,
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
