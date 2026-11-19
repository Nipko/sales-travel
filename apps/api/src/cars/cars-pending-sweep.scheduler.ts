import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { redisConnection } from '../queue/redis-connection.js';
import { CarsPendingSweepService } from './cars-pending-sweep.service.js';

export const CARS_PENDING_QUEUE = 'cars-pending';
export const CARS_PENDING_SWEEP_JOB = 'sweep-pending';
export const CARS_PENDING_SWEEP_SCHEDULER = 'cars-pending-sweep';

/** Cada 30 minutos, en el minuto 7 y 37: lejos de la hora en punto de otros cron. */
export const CARS_PENDING_SWEEP_PATTERN = '7,37 * * * *';

/** Sin Redis: primera corrida poco después de arrancar, y después cada 30 min. */
export const CARS_PENDING_SWEEP_FIRST_RUN_MS = 3 * 60_000;
export const CARS_PENDING_SWEEP_INTERVAL_MS = 30 * 60_000;

/**
 * Programa el barrido de las reservas de autos en espera (A3 de docs/platform/19; D9: sobre
 * BullMQ). Mismo esquema que la purga de la bóveda de payloads: con Redis, un `upsertJobScheduler`
 * idempotente —cada réplica lo declara y BullMQ corre UNA vez por intervalo— y un worker con
 * concurrencia 1; sin Redis, o si Redis rechaza el scheduler, un temporizador del proceso. Correrlo
 * de más no rompe nada: cada cambio de estado es un CAS sobre `pending`.
 */
@Injectable()
export class CarsPendingSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CarsPendingSweepScheduler');
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private readonly sweeper: CarsPendingSweepService) {}

  onModuleInit(): void {
    const connection = redisConnection();
    if (connection === null) {
      this.logger.warn(
        'REDIS_HOST no configurado: el barrido de reservas de autos en espera corre con un temporizador del proceso',
      );
      this.startTimers();
      return;
    }
    this.queue = this.createQueue(connection);
    this.worker = this.createWorker(connection, (job) => this.process(job));
    this.worker.on('failed', (job, err) => {
      this.logger.warn(
        `barrido de autos en espera falló (intento ${job?.attemptsMade ?? '?'}): ${err.name}`,
      );
    });
    // Un `error` sin oyente tumba el proceso (EventEmitter); una caída de Redis no puede hacerlo.
    const onError = (err: Error): void => {
      this.logger.warn(`cola ${CARS_PENDING_QUEUE}: ${err.name}`);
    };
    this.queue.on('error', onError);
    this.worker.on('error', onError);
    // Sin `await`: con Redis caído BullMQ esperaría indefinidamente y el arranque no depende de esto.
    void this.queue
      .upsertJobScheduler(
        CARS_PENDING_SWEEP_SCHEDULER,
        { pattern: CARS_PENDING_SWEEP_PATTERN, tz: 'UTC' },
        {
          name: CARS_PENDING_SWEEP_JOB,
          // Sin reintentos: la próxima corrida es en 30 min y vuelve a mirar todo lo pendiente.
          opts: { attempts: 1, removeOnComplete: 10, removeOnFail: 50 },
        },
      )
      .then(() => this.logger.log('barrido de reservas de autos en espera programado'))
      .catch((err: unknown) => {
        this.logger.error(
          `no se pudo programar el barrido de autos en BullMQ (${err instanceof Error ? err.name : 'error'}): corre con un temporizador del proceso`,
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
    return new Queue(CARS_PENDING_QUEUE, { connection });
  }

  protected createWorker(
    connection: ConnectionOptions,
    processor: (job: Job) => Promise<void>,
  ): Worker {
    return new Worker(CARS_PENDING_QUEUE, processor, { connection, concurrency: 1 });
  }

  /** Un nombre desconocido falla en vez de terminar en verde: nadie hizo lo que el job pedía. */
  private async process(job: Job): Promise<void> {
    if (job.name !== CARS_PENDING_SWEEP_JOB) {
      throw new Error(`job desconocido en la cola ${CARS_PENDING_QUEUE}: '${job.name}'`);
    }
    await this.sweeper.sweep();
  }

  private startTimers(): void {
    if (this.timers.length > 0) return;
    const run = (): void => {
      // Una corrida lenta (muchas lecturas espaciadas) no se solapa con la siguiente.
      if (this.running) return;
      this.running = true;
      void this.sweeper
        .sweep()
        .catch((err: unknown) => {
          this.logger.warn(
            `barrido de autos en espera falló (${err instanceof Error ? err.name : 'error'}); se reintenta en la próxima corrida`,
          );
        })
        .finally(() => {
          this.running = false;
        });
    };
    // `unref`: un temporizador de mantenimiento no mantiene vivo al proceso durante un apagado.
    this.timers.push(setTimeout(run, CARS_PENDING_SWEEP_FIRST_RUN_MS).unref());
    this.timers.push(setInterval(run, CARS_PENDING_SWEEP_INTERVAL_MS).unref());
  }
}
