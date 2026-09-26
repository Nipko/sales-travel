import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { HotelBookingVerificationService } from '../hotels/hotel-booking-verification.service.js';
import {
  POST_SALE_JOBS,
  POST_SALE_QUEUE,
  type CancelRetryJob,
  type CompensateJob,
  type VerifyCreationJob,
  type VerifyHotelBookingJob,
} from '../queue/post-sale-queue.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { redisConnection } from '../queue/redis-connection.js';
import { OrdersService } from './orders.service.js';
import { PostSaleSweeper } from './post-sale-sweeper.js';

/** El barrido no lleva datos: lee lo vencido de Postgres. */
export type PostSaleSweepJob = Record<string, never>;

export type PostSaleJob =
  | CancelRetryJob
  | VerifyCreationJob
  | CompensateJob
  | VerifyHotelBookingJob
  | PostSaleSweepJob;

/** A quién le toca cada job. Cada uno decide con sus funciones puras; el worker sólo enruta. */
export interface PostSaleJobHandlers {
  readonly orders: Pick<OrdersService, 'runCancelById' | 'verifyCreationById' | 'runCompensation'>;
  readonly hotelBookings: Pick<HotelBookingVerificationService, 'runJob'>;
  readonly sweeper: Pick<PostSaleSweeper, 'run'>;
}

/** Cuántos intentos lleva el job en BullMQ: `made` son los fallidos antes de éste. */
export interface PostSaleJobAttempt {
  readonly made: number;
  readonly max: number;
}

/**
 * El enrutado de un job a su paso, **sin BullMQ**.
 *
 * Está fuera de la clase por la misma razón por la que las decisiones del saga están fuera del
 * runner (D9): es lo único de este fichero que tiene comportamiento, y atarlo a un `Worker` lo
 * dejaría sólo probable con un Redis levantado — o sea, sin probar. Cuando Temporal sustituya a
 * BullMQ, esta función se reusa tal cual.
 *
 * Un nombre desconocido LANZA en vez de terminar en verde: un `default: return` daría por hecho
 * un job que nadie ejecutó, y la compensación de una reserva quedaría sin hacer mientras la cola
 * dice que todo salió bien.
 */
export async function runPostSaleJob(
  handlers: PostSaleJobHandlers,
  name: string,
  data: PostSaleJob,
  attempt: PostSaleJobAttempt = { made: 0, max: 1 },
): Promise<void> {
  const { orders } = handlers;
  switch (name) {
    case POST_SALE_JOBS.cancel: {
      const { tenantId, orderId } = data as CancelRetryJob;
      await orders.runCancelById(tenantId, orderId);
      return;
    }
    case POST_SALE_JOBS.verifyCreation: {
      const { tenantId, orderId, actorUserId } = data as VerifyCreationJob;
      await orders.verifyCreationById(tenantId, orderId, actorUserId);
      return;
    }
    case POST_SALE_JOBS.compensate: {
      const { tenantId, orderId, cancellableItemIds, actorUserId } = data as CompensateJob;
      await orders.runCompensation(tenantId, orderId, cancellableItemIds, actorUserId);
      return;
    }
    case POST_SALE_JOBS.verifyHotelBooking:
      // El payload se valida en el servicio: viene de Redis, no de nuestro tipo.
      await handlers.hotelBookings.runJob(data, { final: attempt.made + 1 >= attempt.max });
      return;
    case POST_SALE_JOBS.sweeper:
      await handlers.sweeper.run();
      return;
    default:
      throw new Error(`job de post-venta desconocido: '${name}'`);
  }
}

/**
 * Runner in-process de la post-venta y de los pasos diferidos del saga de creación (D9: sobre el
 * BullMQ que ya existe; Temporal entra antes del primer reembolso real).
 *
 * Aquí NO vive ninguna decisión. Este fichero enruta por nombre de job y llama a `OrdersService`
 * (que consulta el saga puro de `order-create.saga.ts`), a la verificación de reservas de hotel
 * (`hotel-booking-verification.ts`) o al barrido. Es la condición que hace barata la migración a
 * Temporal: cuando llegue, se reescribe este fichero y nada más — la lógica que decide si hay que
 * compensar una reserva, o si una reserva sin respuesta existe, no se toca.
 *
 * BullMQ maneja backoff y reintentos (5 intentos exponenciales). Un rechazo de NEGOCIO no lanza,
 * así que termina el job sin reintentar; sólo los fallos transitorios se propagan. Sin Redis, el
 * worker no arranca (degradación elegante) y los pasos quedan para el reintento manual.
 */
@Injectable()
export class PostSaleWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PostSaleWorker');
  private worker: Worker | null = null;

  private readonly handlers: PostSaleJobHandlers;

  constructor(
    orders: OrdersService,
    hotelBookings: HotelBookingVerificationService,
    sweeper: PostSaleSweeper,
    private readonly work: InflightWorkRegistry,
  ) {
    this.handlers = { orders, hotelBookings, sweeper };
  }

  onModuleInit(): void {
    const connection = redisConnection();
    if (!connection) return;

    const worker = new Worker(
      POST_SALE_QUEUE,
      (job: Job<PostSaleJob>) =>
        runPostSaleJob(this.handlers, job.name, job.data, {
          made: job.attemptsMade,
          max: job.opts.attempts ?? 1,
        }),
      { connection, concurrency: 4 },
    );
    this.worker = worker;
    // Al llegar la SIGTERM y no en `onModuleDestroy`: Nest destruye `DatabaseService` antes que
    // este módulo, y un cancel o una compensación a medias se quedaría sin pool después de haber
    // llamado al proveedor. `close()` es idempotente: el de `onModuleDestroy` espera al mismo.
    this.work.onShutdown('post-sale-worker', () => worker.close());

    this.worker.on('failed', (job, err) => {
      this.logger.warn(
        `job ${job?.name ?? '?'} ${job?.id} falló (intento ${job?.attemptsMade}): ${err.message}`,
      );
    });
    this.worker.on('completed', (job) => {
      this.logger.log(`job ${job.name} ${job.id} completado`);
    });

    this.logger.log('worker de post-venta y sagas activo');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
