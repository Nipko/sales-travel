import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { redisConnection } from './redis-connection.js';

export const POST_SALE_QUEUE = 'post-sale-retry';

export interface CancelRetryJob {
  tenantId: string;
  orderId: string;
  type: 'cancel';
}

/**
 * Cola de reintentos de post-venta (BullMQ sobre Redis). Sólo encola fallos TRANSITORIOS
 * (el proveedor lanzó excepción: red/timeout/5xx) — los rechazos de negocio (p.ej. 933) NO se
 * reintentan. Si no hay Redis configurado, `enqueue*` es no-op (queda el reintento manual).
 */
@Injectable()
export class PostSaleQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PostSaleQueue');
  private queue: Queue | null = null;

  onModuleInit(): void {
    const connection = redisConnection();
    if (!connection) {
      this.logger.warn(
        'REDIS_HOST no configurado: reintentos automáticos de post-venta deshabilitados (queda el reintento manual).',
      );
      return;
    }
    this.queue = new Queue(POST_SALE_QUEUE, { connection });
    this.logger.log('cola de reintentos de post-venta inicializada');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueueCancelRetry(data: CancelRetryJob): Promise<void> {
    if (!this.queue) return;
    try {
      await this.queue.add('cancel', data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    } catch (err) {
      // Encolar es best-effort: un fallo de Redis no debe romper la operación principal.
      this.logger.error(`no se pudo encolar el reintento: ${(err as Error).message}`);
    }
  }
}
