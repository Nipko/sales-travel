import { Logger } from '@nestjs/common';
import type { ConnectionOptions, Job, Queue, Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARS_PENDING_SWEEP_FIRST_RUN_MS,
  CARS_PENDING_SWEEP_INTERVAL_MS,
  CARS_PENDING_SWEEP_JOB,
  CARS_PENDING_SWEEP_PATTERN,
  CARS_PENDING_SWEEP_SCHEDULER,
  CarsPendingSweepScheduler,
} from './cars-pending-sweep.scheduler.js';
import type { CarsPendingSweepService } from './cars-pending-sweep.service.js';

/*
 * El barrido de autos en espera corre siempre: con Redis como job scheduler de BullMQ (una corrida
 * por intervalo aunque haya varias réplicas, worker de concurrencia 1), y sin Redis —o con un Redis
 * que rechaza el scheduler— con un temporizador del proceso.
 */

interface Dobles {
  readonly upsertJobScheduler: ReturnType<typeof vi.fn>;
  processor?: (job: Job) => Promise<void>;
}

class SchedulerDePrueba extends CarsPendingSweepScheduler {
  constructor(
    sweeper: CarsPendingSweepService,
    private readonly dobles: Dobles,
  ) {
    super(sweeper);
  }

  protected override createQueue(_connection: ConnectionOptions): Queue {
    return {
      upsertJobScheduler: this.dobles.upsertJobScheduler,
      on: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
    } as unknown as Queue;
  }

  protected override createWorker(
    _connection: ConnectionOptions,
    processor: (job: Job) => Promise<void>,
  ): Worker {
    this.dobles.processor = processor;
    return { on: vi.fn(), close: vi.fn(() => Promise.resolve()) } as unknown as Worker;
  }
}

function montar(run: () => Promise<unknown> = () => Promise.resolve({})) {
  const sweep = vi.fn(run);
  const dobles: Dobles = { upsertJobScheduler: vi.fn(() => Promise.resolve({})) };
  const scheduler = new SchedulerDePrueba({ sweep } as unknown as CarsPendingSweepService, dobles);
  return { scheduler, sweep, dobles };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CarsPendingSweepScheduler', () => {
  it('con Redis: un job scheduler cada 30 min en UTC que corre el barrido', async () => {
    vi.stubEnv('REDIS_HOST', 'redis.test');
    const { scheduler, sweep, dobles } = montar();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(dobles.upsertJobScheduler).toHaveBeenCalledWith(
      CARS_PENDING_SWEEP_SCHEDULER,
      { pattern: CARS_PENDING_SWEEP_PATTERN, tz: 'UTC' },
      expect.objectContaining({ name: CARS_PENDING_SWEEP_JOB }),
    );
    expect(CARS_PENDING_SWEEP_PATTERN).toBe('7,37 * * * *');

    await dobles.processor?.({ name: CARS_PENDING_SWEEP_JOB } as Job);
    expect(sweep).toHaveBeenCalledTimes(1);
    await expect(dobles.processor?.({ name: 'otro-job' } as Job)).rejects.toThrow('otro-job');

    // Con Redis no hay temporizador del proceso.
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_INTERVAL_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(1);
    await scheduler.onModuleDestroy();
  });

  it('sin Redis: temporizador del proceso, al rato del arranque y cada 30 min', async () => {
    vi.stubEnv('REDIS_HOST', '');
    const { scheduler, sweep } = montar();

    scheduler.onModuleInit();
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_FIRST_RUN_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('REDIS_HOST no configurado');

    await scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_INTERVAL_MS * 3);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('si Redis rechaza el scheduler, cae al temporizador', async () => {
    vi.stubEnv('REDIS_HOST', 'redis.test');
    const { scheduler, sweep, dobles } = montar();
    dobles.upsertJobScheduler.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_FIRST_RUN_MS);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(' ')).toContain('temporizador');
    await scheduler.onModuleDestroy();
  });

  it('una corrida lenta no se solapa con la siguiente, y un fallo no tumba el proceso', async () => {
    vi.stubEnv('REDIS_HOST', '');
    let release: () => void = () => undefined;
    const { scheduler, sweep } = montar(
      () => new Promise<void>((_resolve, reject) => (release = () => reject(new TypeError('x')))),
    );

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_FIRST_RUN_MS);
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(CARS_PENDING_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('falló (TypeError)');
    await scheduler.onModuleDestroy();
  });
});
