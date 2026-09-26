import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { redisConnection } from '../queue/redis-connection.js';
import { ProviderPayloadsService } from './provider-payloads.service.js';

export const PROVIDER_PAYLOADS_QUEUE = 'provider-payloads';
export const PROVIDER_PAYLOADS_PURGE_JOB = 'purge-expired';
export const PROVIDER_PAYLOADS_PURGE_SCHEDULER = 'provider-payloads-purge';

/** Una vez por día, 03:17 UTC: madrugada en LATAM y lejos de la hora en punto de otros cron. */
export const PROVIDER_PAYLOADS_PURGE_PATTERN = '17 3 * * *';

/** Sin Redis: primera corrida poco después de arrancar, y después cada 24 h. */
export const PROVIDER_PAYLOADS_PURGE_FIRST_RUN_MS = 5 * 60_000;
export const PROVIDER_PAYLOADS_PURGE_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Purga diaria de la bóveda de payloads (D9: sobre BullMQ).
 *
 * Con Redis, un `upsertJobScheduler` idempotente: cada réplica lo declara al arrancar y BullMQ
 * corre UNA purga por día aunque haya varias. Sin Redis —o si Redis no acepta el scheduler—, un
 * temporizador en el proceso. A diferencia de los reintentos de post-venta, aquí no hay
 * "degradación elegante" posible: sin purga, los datos de huéspedes se quedarían más de lo
 * prometido, así que falta Redis y la purga igual corre. Correrla de más no cuesta nada: sólo
 * borra lo vencido y dos corridas a la vez no se estorban (`SKIP LOCKED` en 0043).
 */
@Injectable()
export class ProviderPayloadsPurgeScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProviderPayloadsPurge');
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(private readonly payloads: ProviderPayloadsService) {}

  onModuleInit(): void {
    const connection = redisConnection();
    if (connection === null) {
      this.logger.warn(
        'REDIS_HOST no configurado: la purga de la bóveda de payloads corre con un temporizador del proceso',
      );
      this.startTimers();
      return;
    }
    this.queue = this.createQueue(connection);
    this.worker = this.createWorker(connection, (job) => this.process(job));
    this.worker.on('failed', (job, err) => {
      this.logger.warn(
        `purga de la bóveda falló (intento ${job?.attemptsMade ?? '?'}): ${err.name}`,
      );
    });
    // Un `error` sin oyente tumba el proceso (EventEmitter); una caída de Redis no puede hacerlo.
    const onError = (err: Error): void => {
      this.logger.warn(`cola ${PROVIDER_PAYLOADS_QUEUE}: ${err.name}`);
    };
    this.queue.on('error', onError);
    this.worker.on('error', onError);
    // Sin `await`: con Redis caído BullMQ encola el comando y esperaría indefinidamente, y el
    // arranque de la API no puede depender de la purga.
    void this.queue
      .upsertJobScheduler(
        PROVIDER_PAYLOADS_PURGE_SCHEDULER,
        { pattern: PROVIDER_PAYLOADS_PURGE_PATTERN, tz: 'UTC' },
        {
          name: PROVIDER_PAYLOADS_PURGE_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: 10,
            removeOnFail: 50,
          },
        },
      )
      .then(() => this.logger.log('purga diaria de la bóveda de payloads programada'))
      .catch((err: unknown) => {
        this.logger.error(
          `no se pudo programar la purga en BullMQ (${err instanceof Error ? err.name : 'error'}): corre con un temporizador del proceso`,
        );
        this.startTimers();
      });
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Protegido para que el test sustituya BullMQ sin levantar Redis. */
  protected createQueue(connection: ConnectionOptions): Queue {
    return new Queue(PROVIDER_PAYLOADS_QUEUE, { connection });
  }

  protected createWorker(
    connection: ConnectionOptions,
    processor: (job: Job) => Promise<void>,
  ): Worker {
    return new Worker(PROVIDER_PAYLOADS_QUEUE, processor, { connection, concurrency: 1 });
  }

  /** Un nombre desconocido falla en vez de terminar en verde: nadie hizo lo que el job pedía. */
  private async process(job: Job): Promise<void> {
    if (job.name !== PROVIDER_PAYLOADS_PURGE_JOB) {
      throw new Error(`job desconocido en la cola ${PROVIDER_PAYLOADS_QUEUE}: '${job.name}'`);
    }
    await this.payloads.purgeExpired();
  }

  private startTimers(): void {
    if (this.timers.length > 0) return;
    const run = (): void => {
      void this.payloads.purgeExpired().catch((err: unknown) => {
        this.logger.warn(
          `purga de la bóveda falló (${err instanceof Error ? err.name : 'error'}); se reintenta en la próxima corrida`,
        );
      });
    };
    // `unref`: un temporizador de mantenimiento no mantiene vivo al proceso durante un apagado.
    this.timers.push(setTimeout(run, PROVIDER_PAYLOADS_PURGE_FIRST_RUN_MS).unref());
    this.timers.push(setInterval(run, PROVIDER_PAYLOADS_PURGE_INTERVAL_MS).unref());
  }
}
