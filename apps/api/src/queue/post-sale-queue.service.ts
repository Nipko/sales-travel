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
  /**
   * Un paso del calendario que lee por NUESTRA referencia una reserva de hotel cuya respuesta no
   * llegó (docs/tbo/08 RF-21). Sólo lee: la reserva nunca se reenvía desde la cola, que reintenta.
   */
  verifyHotelBooking: 'verify-hotel-booking',
  /**
   * Un paso del calendario que relee una reserva de hotel cuya cancelación quedó en curso o sin
   * verificar (docs/tbo/04 §4.4). Sólo lee: la cancelación nunca se reenvía desde la cola.
   */
  verifyCancellation: 'verify-cancellation',
  /**
   * Una lectura del plan del número de confirmación del hotel (HCN, docs/tbo/04 §8). Sólo lee: el
   * plan y sus intentos viven en la fila de seguimiento, no en la cola.
   */
  hcnCheck: 'hcn-check',
  /** El barrido periódico que ejecuta lo que la cola perdió (RNF-10: Postgres manda). */
  sweeper: 'post-sale-sweeper',
  /**
   * La conciliación de UNA cuenta de proveedor contra nuestras órdenes (docs/tbo/04 §9). Lee al
   * proveedor; nunca crea ni cancela nada en él.
   */
  reconcileAccount: 'reconcile-provider-account',
  /** El disparo diario que encola una conciliación por cuenta (D-TBO-29 A). */
  reconcileAccounts: 'reconcile-provider-accounts',
} as const;

export type PostSaleJobName = (typeof POST_SALE_JOBS)[keyof typeof POST_SALE_JOBS];

/** Cada cuánto corre el barrido (docs/tbo/08 RNF-10 punto 1). */
export const POST_SALE_SWEEP_EVERY_MS = 15 * 60_000;

/**
 * Cuándo corre la conciliación diaria: 04:30 UTC, después del sync de inventario de las 03:30
 * (docs/tbo/04 §9.6). La hora es arbitraria.
 */
export const RECONCILIATION_DAILY_CRON = '30 4 * * *';

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

/**
 * Un paso de la verificación de una reserva de hotel. Sin datos personales: el job sólo dice qué
 * orden y qué paso; lo demás se lee de Postgres, que es quien decide si el paso sigue vigente.
 */
export interface VerifyHotelBookingJob {
  tenantId: string;
  orderId: string;
  /** Índice del paso en el calendario: es el tercer segmento del `jobId`. */
  step: number;
  actorUserId?: string;
}

/**
 * Un paso de la verificación de una cancelación de hotel. Sin datos personales: qué orden, qué
 * calendario y qué paso; lo demás se lee de Postgres, que decide si el paso sigue vigente.
 */
export interface VerifyCancellationJob {
  tenantId: string;
  orderId: string;
  /** Índice del paso en el calendario. */
  step: number;
  /**
   * Epoch ms del ancla del calendario. Una cancelación nueva de la misma orden abre otro
   * calendario, y el job de un calendario anterior no puede ejecutar el paso del nuevo.
   */
  anchorAt: number;
  actorUserId?: string;
}

/**
 * Una lectura del plan del HCN. Sin datos personales: qué orden y cuántas lecturas se hicieron antes
 * de ésta; la fila de seguimiento decide si la lectura sigue vigente.
 */
export interface HcnCheckJob {
  tenantId: string;
  orderId: string;
  /** Lecturas ya hechas (0 = la del SLA): es el tercer segmento del `jobId`. */
  attempt: number;
}

/**
 * La conciliación de UNA cuenta. Sin datos de reservas: qué cuenta, de quién y por qué corre; lo
 * demás se lee del proveedor y de Postgres.
 */
export interface ReconcileProviderAccountJob {
  /** Dueño de la cuenta: la corrida es suya y se registra en su tenant. */
  ownerTenantId: string;
  accountId: string;
  providerCode: string;
  trigger: 'scheduled' | 'sweep' | 'forced';
  /**
   * Tercer segmento del `jobId`, sin `:`: el día de la corrida programada (`YYYY-MM-DD`), la hora
   * del barrido que la recupera (`YYYY-MM-DDTHH`) o el minuto del botón (`m<minutos>`). Dos disparos
   * del mismo turno son el mismo job mientras BullMQ lo conserve.
   */
  slot: string;
  /** Quien apretó el botón de operaciones. */
  requestedBy?: string;
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
 * Un job por paso: el mismo paso encolado dos veces (la saga y el barrido, o un reintento del
 * encolado) es el mismo job mientras BullMQ lo conserve.
 */
export function verifyHotelBookingJobId(data: VerifyHotelBookingJob): string {
  return postSaleJobId(POST_SALE_JOBS.verifyHotelBooking, data.orderId, String(data.step));
}

/**
 * Un job por paso Y por calendario: `<paso>-<ancla>` en el tercer segmento. Con sólo el paso, el job
 * de una cancelación anterior que BullMQ todavía conserva haría descartar el de la nueva.
 */
export function verifyCancellationJobId(data: VerifyCancellationJob): string {
  return postSaleJobId(
    POST_SALE_JOBS.verifyCancellation,
    data.orderId,
    `${data.step}-${data.anchorAt}`,
  );
}

/**
 * Un job por lectura del plan. Una orden tiene un solo plan de HCN en su vida (la fila nunca lo
 * reabre), así que el número de lectura alcanza para no duplicar ni pisar.
 */
export function hcnCheckJobId(data: HcnCheckJob): string {
  return postSaleJobId(POST_SALE_JOBS.hcnCheck, data.orderId, String(data.attempt));
}

/** Una conciliación por cuenta y por turno: `reconcile-provider-account:<cuenta>:<turno>`. */
export function reconcileAccountJobId(data: ReconcileProviderAccountJob): string {
  return postSaleJobId(POST_SALE_JOBS.reconcileAccount, data.accountId, data.slot);
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
   * Encola un paso de la verificación de una reserva de hotel, con el retardo hasta su hora. Los
   * `attempts` de la cola son reintentos de ESA lectura ante un fallo de transporte; el calendario
   * lo lleva la fila de seguimiento, no BullMQ.
   */
  async enqueueVerifyHotelBooking(
    data: VerifyHotelBookingJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    return this.add(
      POST_SALE_JOBS.verifyHotelBooking,
      data,
      verifyHotelBookingJobId(data),
      options,
    );
  }

  /**
   * Encola un paso de la verificación de una cancelación de hotel, con el retardo hasta su hora.
   * Como la del Book: los `attempts` repiten ESA lectura; el calendario lo lleva la fila.
   */
  async enqueueVerifyCancellation(
    data: VerifyCancellationJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    return this.add(
      POST_SALE_JOBS.verifyCancellation,
      data,
      verifyCancellationJobId(data),
      options,
    );
  }

  /**
   * Encola una lectura del plan del HCN, con el retardo hasta su hora (hasta 5 días en P5). Los
   * `attempts` de la cola repiten ESA lectura ante un fallo de transporte y no cuentan como
   * lecturas del plan.
   */
  async enqueueHcnCheck(data: HcnCheckJob, options: PostSaleEnqueueOptions = {}): Promise<boolean> {
    return this.add(POST_SALE_JOBS.hcnCheck, data, hcnCheckJobId(data), options);
  }

  /**
   * Encola la conciliación de una cuenta. Los `attempts` de la cola repiten la corrida ante un fallo
   * de transporte; cada intento es una corrida registrada aparte.
   */
  async enqueueReconcileAccount(data: ReconcileProviderAccountJob): Promise<boolean> {
    return this.add(POST_SALE_JOBS.reconcileAccount, data, reconcileAccountJobId(data), {});
  }

  /**
   * Programa el disparo diario de la conciliación con un Job Scheduler de BullMQ (D-TBO-29 A),
   * idempotente como el del barrido. Un intento por día: si falla, el barrido de post-venta encola
   * las cuentas que se quedaron sin corrida.
   */
  async scheduleReconciliation(pattern: string = RECONCILIATION_DAILY_CRON): Promise<boolean> {
    if (!this.queue) return false;
    try {
      await this.queue.upsertJobScheduler(
        POST_SALE_JOBS.reconcileAccounts,
        { pattern, tz: 'UTC' },
        {
          name: POST_SALE_JOBS.reconcileAccounts,
          data: {},
          opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
        },
      );
      return true;
    } catch (err) {
      this.logger.error(`no se pudo programar la conciliación: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Programa el barrido periódico con un Job Scheduler de BullMQ (D-TBO-29 A). Es idempotente: el
   * id del programador es el nombre del job, así que cada arranque de la API lo actualiza en vez de
   * sumar otro. Un intento por corrida: si falla, la próxima corrida vuelve a mirar lo mismo.
   */
  async scheduleSweeper(everyMs: number = POST_SALE_SWEEP_EVERY_MS): Promise<boolean> {
    if (!this.queue) return false;
    if (!isValidDelayMs(everyMs) || everyMs === 0) {
      this.logger.error(`no se pudo programar el barrido: intervalo inválido (${everyMs} ms)`);
      return false;
    }
    try {
      await this.queue.upsertJobScheduler(
        POST_SALE_JOBS.sweeper,
        { every: everyMs },
        {
          name: POST_SALE_JOBS.sweeper,
          data: {},
          opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
        },
      );
      return true;
    } catch (err) {
      this.logger.error(`no se pudo programar el barrido: ${(err as Error).message}`);
      return false;
    }
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
