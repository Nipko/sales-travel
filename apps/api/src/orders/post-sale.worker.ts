import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  POST_SALE_JOBS,
  POST_SALE_QUEUE,
  type CancelRetryJob,
  type CompensateJob,
  type VerifyCreationJob,
} from '../queue/post-sale-queue.service.js';
import { redisConnection } from '../queue/redis-connection.js';
import { OrdersService } from './orders.service.js';

export type PostSaleJob = CancelRetryJob | VerifyCreationJob | CompensateJob;

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
  orders: OrdersService,
  name: string,
  data: PostSaleJob,
): Promise<void> {
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
    default:
      throw new Error(`job de post-venta desconocido: '${name}'`);
  }
}

/**
 * Runner in-process de la post-venta y de los pasos diferidos del saga de creación (D9: sobre el
 * BullMQ que ya existe; Temporal entra antes del primer reembolso real).
 *
 * Aquí NO vive ninguna decisión. Este fichero enruta por nombre de job y llama a `OrdersService`,
 * que a su vez consulta el saga puro de `order-create.saga.ts`. Es la condición que hace barata
 * la migración a Temporal: cuando llegue, se reescribe este fichero y nada más — la lógica que
 * decide si hay que compensar una reserva no se toca.
 *
 * BullMQ maneja backoff y reintentos (5 intentos exponenciales). Un rechazo de NEGOCIO no lanza,
 * así que termina el job sin reintentar; sólo los fallos transitorios se propagan. Sin Redis, el
 * worker no arranca (degradación elegante) y los pasos quedan para el reintento manual.
 */
@Injectable()
export class PostSaleWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PostSaleWorker');
  private worker: Worker | null = null;

  constructor(private readonly orders: OrdersService) {}

  onModuleInit(): void {
    const connection = redisConnection();
    if (!connection) return;

    this.worker = new Worker(
      POST_SALE_QUEUE,
      (job: Job<PostSaleJob>) => runPostSaleJob(this.orders, job.name, job.data),
      { connection, concurrency: 4 },
    );

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
