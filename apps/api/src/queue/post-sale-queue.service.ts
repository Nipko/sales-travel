import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { redisConnection } from './redis-connection.js';

export const POST_SALE_QUEUE = 'post-sale-retry';

/**
 * Nombres de job de la cola. Constantes y no literales: el `Worker` enruta por este nombre y un
 * job con el nombre mal escrito no falla — se ejecuta con la rama equivocada, o con ninguna.
 */
export const POST_SALE_JOBS = {
  cancel: 'cancel',
  /** Lectura de cierre de una creación que no se pudo verificar en línea (saga, paso 2). */
  verifyCreation: 'verify-creation',
  /** Compensación SELECTIVA por `itemId` de un éxito parcial (saga, paso 3). */
  compensate: 'compensate',
} as const;

export interface CancelRetryJob {
  tenantId: string;
  orderId: string;
  type: 'cancel';
}

/** Reintento de la lectura de cierre. El saga la exige; si falló en línea, se reintenta aquí. */
export interface VerifyCreationJob {
  tenantId: string;
  orderId: string;
  /** Quién originó la reserva. Viaja para que el `domain_event` del reintento conserve el actor. */
  actorUserId?: string;
}

/**
 * Compensación selectiva. `cancellableItemIds` viaja en el job y NUNCA se recalcula en el worker:
 * son los ítems que el proveedor declaró cancelables en el momento de la creación, y volver a
 * derivarlos horas después contra un estado que ya cambió es como se cancela lo que sí estaba bien.
 */
export interface CompensateJob {
  tenantId: string;
  orderId: string;
  cancellableItemIds: string[];
  reason: string;
  actorUserId?: string;
}

/**
 * Cola de post-venta y de sagas de reserva (BullMQ sobre Redis) — D9: las sagas con dinero corren
 * sobre esta cola, no sobre Temporal, hasta que Temporal entre antes del primer reembolso real.
 *
 * Sólo se encolan fallos TRANSITORIOS y pasos pendientes; los rechazos de negocio NO se
 * reintentan. Si no hay Redis configurado, `enqueue*` es no-op y devuelve `false` — la
 * degradación es elegante pero **visible**: el llamador sabe que el paso quedó sin encolar y lo
 * registra, en vez de creer que hay un reintento que no existe.
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

  async enqueueCancelRetry(data: CancelRetryJob): Promise<boolean> {
    return this.add(POST_SALE_JOBS.cancel, data);
  }

  async enqueueVerifyCreation(data: VerifyCreationJob): Promise<boolean> {
    return this.add(POST_SALE_JOBS.verifyCreation, data);
  }

  /**
   * Encola una compensación con un `jobId` DETERMINISTA: la misma orden y los mismos ítems no se
   * encolan dos veces mientras el job siga vivo en la cola.
   *
   * Es una salvaguarda de la COLA, no una clave de idempotencia de negocio, y la diferencia
   * importa: BullMQ olvida el `jobId` en cuanto el job sale (`removeOnComplete: 100`), así que
   * esto no protege de un reencolado semanas después. La clave duradera es la que emite el
   * proveedor —`sabreCancelIdempotencyKey`, el sha256 del cuerpo canónico— y esa vive en el
   * `domain_event` de la cancelación, que es append-only.
   */
  async enqueueCompensation(data: CompensateJob): Promise<boolean> {
    const huella = [...data.cancellableItemIds].sort().join(',');
    return this.add(POST_SALE_JOBS.compensate, data, {
      jobId: `${POST_SALE_JOBS.compensate}:${data.orderId}:${huella}`,
    });
  }

  /**
   * Encolar es best-effort: un fallo de Redis no puede romper la operación principal —la reserva
   * ya existe del otro lado—. Pero devuelve `false` en vez de tragárselo, porque el saga tiene que
   * poder anotar en el `domain_event` que el paso quedó sin encolar.
   */
  private async add(name: string, data: object, extra: { jobId?: string } = {}): Promise<boolean> {
    if (!this.queue) return false;
    try {
      await this.queue.add(name, data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
        ...extra,
      });
      return true;
    } catch (err) {
      this.logger.error(`no se pudo encolar '${name}': ${(err as Error).message}`);
      return false;
    }
  }
}
