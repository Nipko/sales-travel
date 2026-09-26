import { Logger } from '@nestjs/common';
import type { ConnectionOptions, Job, Queue, Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_PAYLOADS_PURGE_FIRST_RUN_MS,
  PROVIDER_PAYLOADS_PURGE_INTERVAL_MS,
  PROVIDER_PAYLOADS_PURGE_JOB,
  PROVIDER_PAYLOADS_PURGE_PATTERN,
  PROVIDER_PAYLOADS_PURGE_SCHEDULER,
  ProviderPayloadsPurgeScheduler,
} from './provider-payloads-purge.scheduler.js';
import type { ProviderPayloadsService } from './provider-payloads.service.js';

/**
 * La purga diaria de la bóveda (docs/tbo/09 PR-4.9; D9). Sin Redis ni BullMQ reales: la cola y el
 * worker se sustituyen por la costura protegida del scheduler. Lo que se prueba es que la purga
 * corre SIEMPRE —con Redis, sin Redis y con un Redis que rechaza el scheduler—.
 */

interface Dobles {
  readonly upsertJobScheduler: ReturnType<typeof vi.fn>;
  processor?: (job: Job) => Promise<void>;
}

class SchedulerDePrueba extends ProviderPayloadsPurgeScheduler {
  constructor(
    payloads: ProviderPayloadsService,
    private readonly dobles: Dobles,
  ) {
    super(payloads);
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

function montar(purge: () => Promise<number> = () => Promise.resolve(0)) {
  const purgeExpired = vi.fn(purge);
  const dobles: Dobles = { upsertJobScheduler: vi.fn(() => Promise.resolve({})) };
  const scheduler = new SchedulerDePrueba(
    { purgeExpired } as unknown as ProviderPayloadsService,
    dobles,
  );
  return { scheduler, purgeExpired, dobles };
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

describe('ProviderPayloadsPurgeScheduler', () => {
  it('con Redis: un job scheduler diario en UTC, idempotente entre réplicas, que corre la purga', async () => {
    vi.stubEnv('REDIS_HOST', 'redis.test');
    const { scheduler, purgeExpired, dobles } = montar();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(dobles.upsertJobScheduler).toHaveBeenCalledWith(
      PROVIDER_PAYLOADS_PURGE_SCHEDULER,
      { pattern: PROVIDER_PAYLOADS_PURGE_PATTERN, tz: 'UTC' },
      expect.objectContaining({ name: PROVIDER_PAYLOADS_PURGE_JOB }),
    );
    expect(PROVIDER_PAYLOADS_PURGE_PATTERN).toBe('17 3 * * *');

    await dobles.processor?.({ name: PROVIDER_PAYLOADS_PURGE_JOB } as Job);
    expect(purgeExpired).toHaveBeenCalledTimes(1);

    // Un nombre que nadie atiende falla en vez de terminar en verde.
    await expect(dobles.processor?.({ name: 'otro-job' } as Job)).rejects.toThrow('otro-job');
    // Con Redis no hay temporizador del proceso: la purga es de BullMQ.
    await vi.advanceTimersByTimeAsync(PROVIDER_PAYLOADS_PURGE_INTERVAL_MS * 2);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    await scheduler.onModuleDestroy();
  });

  it('sin Redis: temporizador del proceso, a los 5 minutos del arranque y cada 24 h', async () => {
    vi.stubEnv('REDIS_HOST', '');
    const { scheduler, purgeExpired } = montar();

    scheduler.onModuleInit();
    expect(purgeExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROVIDER_PAYLOADS_PURGE_FIRST_RUN_MS);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROVIDER_PAYLOADS_PURGE_INTERVAL_MS);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('REDIS_HOST no configurado');

    await scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(PROVIDER_PAYLOADS_PURGE_INTERVAL_MS * 3);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
  });

  it('si Redis rechaza el scheduler, la purga cae al temporizador en vez de no correr', async () => {
    vi.stubEnv('REDIS_HOST', 'redis.test');
    const { scheduler, purgeExpired, dobles } = montar();
    dobles.upsertJobScheduler.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(PROVIDER_PAYLOADS_PURGE_FIRST_RUN_MS);

    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(' ')).toContain('temporizador');
    await scheduler.onModuleDestroy();
  });

  it('una purga que falla en el temporizador no tumba el proceso: avisa y espera a la próxima', async () => {
    vi.stubEnv('REDIS_HOST', '');
    const { scheduler, purgeExpired } = montar(() => Promise.reject(new TypeError('boom')));

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(PROVIDER_PAYLOADS_PURGE_FIRST_RUN_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_PAYLOADS_PURGE_INTERVAL_MS);

    expect(purgeExpired).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('purga de la bóveda falló (TypeError)');
    await scheduler.onModuleDestroy();
  });
});
