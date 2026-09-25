import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
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

export type PostSaleJobName = (typeof POST_SALE_JOBS)[keyof typeof POST_SALE_JOBS];

export interface CancelRetryJob {
  tenantId: string;
  orderId: string;
  /**
   * La operación `cancel` de `order_operations` que se reintenta: es el intento del `jobId`. El
   * reintento reusa el mismo claim durable (`claimCancelRetry`), así que dos encolados del mismo
   * intento son el mismo job; una cancelación nueva abre otra operación y otro job.
   */
  operationId: string;
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

export interface PostSaleEnqueueOptions {
  /** Milisegundos antes de que el job pueda correr (p. ej. la relectura a 120 s de un Book incierto). */
  delayMs?: number;
}

/**
 * Entero y no negativo. Un retardo calculado que sale negativo es un error del llamador, no un
 * "ya": se rechaza en vez de adivinar qué quiso decir.
 */
export function isValidDelayMs(delayMs: number): boolean {
  return Number.isSafeInteger(delayMs) && delayMs >= 0;
}

/**
 * `jobId` determinista de la cola: `<nombre>:<orderId>:<paso>`.
 *
 * Tres segmentos exactos no es estilo: BullMQ 5.x rechaza un `jobId` con `:` que no tenga tres
 * ("Custom Id cannot contain :", `Job.validateOptions`), `add()` lo atrapa y devuelve `false`.
 * Así se perdía el reintento de toda cancelación con el antiguo `cancel:<orderId>`. Ningún
 * segmento puede traer `:`: por eso el paso de la compensación es un hash y no la lista de ítems.
 */
export function postSaleJobId(name: PostSaleJobName, orderId: string, step: string): string {
  return `${name}:${orderId}:${step}`;
}

export function cancelRetryJobId(data: CancelRetryJob): string {
  return postSaleJobId(POST_SALE_JOBS.cancel, data.orderId, data.operationId);
}

/**
 * La huella es el sha256 de la lista ORDENADA, no la lista unida con comas: un `itemId` es un id
 * del proveedor y puede traer `:` —rompería los tres segmentos— o `,` —`['a,b']` y `['a', 'b']`
 * darían la misma huella y la segunda compensación se descartaría como duplicada—.
 */
export function compensationJobId(data: CompensateJob): string {
  const huella = createHash('sha256')
    .update(JSON.stringify([...data.cancellableItemIds].sort()))
    .digest('hex');
  return postSaleJobId(POST_SALE_JOBS.compensate, data.orderId, huella);
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
    this.queue = this.createQueue(connection);
    this.logger.log('cola de reintentos de post-venta inicializada');
  }

  /** Protegido para que el test contra BullMQ real use un `prefix` propio y no la cola viva. */
  protected createQueue(connection: ConnectionOptions): Queue {
    return new Queue(POST_SALE_QUEUE, { connection });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueueCancelRetry(
    data: CancelRetryJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    // Evita dos jobs simultáneos para el mismo write. La autorización durable sigue viviendo en
    // order_operations: el jobId sólo cubre carreras mientras BullMQ conserva el job. Como el
    // intento es la operación, un reintento manual de esa misma operación no abre otra cadena
    // automática mientras BullMQ guarde el job ya terminado: agotado (`removeOnFail: 500`) o
    // cerrado sin write porque el claim lo tenía el manual (`removeOnComplete: 100`).
    return this.add(POST_SALE_JOBS.cancel, data, cancelRetryJobId(data), options);
  }

  async enqueueVerifyCreation(
    data: VerifyCreationJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    return this.add(POST_SALE_JOBS.verifyCreation, data, undefined, options);
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
  async enqueueCompensation(
    data: CompensateJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    return this.add(POST_SALE_JOBS.compensate, data, compensationJobId(data), options);
  }

  /**
   * Encolar es best-effort: un fallo de Redis no puede romper la operación principal —la reserva
   * ya existe del otro lado—. Pero devuelve `false` en vez de tragárselo, porque el saga tiene que
   * poder anotar en el `domain_event` que el paso quedó sin encolar.
   */
  private async add(
    name: PostSaleJobName,
    data: object,
    jobId: string | undefined,
    { delayMs }: PostSaleEnqueueOptions,
  ): Promise<boolean> {
    if (!this.queue) return false;
    if (delayMs !== undefined && !isValidDelayMs(delayMs)) {
      this.logger.error(`no se pudo encolar '${name}': retardo inválido (${delayMs} ms)`);
      return false;
    }
    try {
      await this.queue.add(name, data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
        ...(jobId === undefined ? {} : { jobId }),
        ...(delayMs === undefined ? {} : { delay: delayMs }),
      });
      return true;
    } catch (err) {
      this.logger.error(`no se pudo encolar '${name}': ${(err as Error).message}`);
      return false;
    }
  }
}
