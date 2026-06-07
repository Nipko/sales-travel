import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { POST_SALE_QUEUE, type CancelRetryJob } from '../queue/post-sale-queue.service.js';
import { redisConnection } from '../queue/redis-connection.js';
import { OrdersService } from './orders.service.js';

/**
 * Worker in-process de reintentos de post-venta. Reintenta cancelaciones que fallaron por causas
 * transitorias; cada intento queda registrado en `order_operations`. BullMQ maneja el backoff y los
 * reintentos (5 intentos exponenciales). Si la cancelación devuelve un rechazo de negocio (no lanza),
 * el job se da por terminado sin reintentar. Sin Redis, el worker no arranca (degradación elegante).
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
      async (job: Job<CancelRetryJob>) => {
        const { tenantId, orderId } = job.data;
        await this.orders.runCancelById(tenantId, orderId);
      },
      { connection, concurrency: 4 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.warn(
        `reintento de cancelación ${job?.id} falló (intento ${job?.attemptsMade}): ${err.message}`,
      );
    });
    this.worker.on('completed', (job) => {
      this.logger.log(`reintento de cancelación ${job.id} completado`);
    });

    this.logger.log('worker de reintentos de post-venta activo');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
