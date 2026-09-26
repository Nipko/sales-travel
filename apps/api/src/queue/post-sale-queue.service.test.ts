import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOptions, JobsOptions, Queue } from 'bullmq';
import {
  POST_SALE_JOBS,
  POST_SALE_SWEEP_EVERY_MS,
  PostSaleQueueService,
  cancelRetryJobId,
  compensationJobId,
  postSaleJobId,
  verifyCancellationJobId,
  verifyHotelBookingJobId,
  type CompensateJob,
} from './post-sale-queue.service.js';
import { bullMqJobIdRejection } from './__fixtures__/recording-queue.service.js';

/**
 * La cola sin Redis: qué le llega a `Queue.add` de BullMQ. La prueba contra BullMQ real está en
 * `post-sale-queue.integration.test.ts`; aquí se fija el contrato del servicio —`jobId`, `delay`
 * y el `false` visible— sin depender de que el runner tenga Redis.
 */

interface LlamadaAdd {
  name: string;
  data: unknown;
  opts: JobsOptions | undefined;
}

/** Sustituye la `Queue` de BullMQ por una que graba cada `add` o falla como Redis caído. */
class ColaGrabadora extends PostSaleQueueService {
  readonly llamadas: LlamadaAdd[] = [];
  readonly programadores: unknown[][] = [];
  fallo: Error | null = null;

  protected override createQueue(_connection: ConnectionOptions): Queue {
    const cola = {
      add: (name: string, data: unknown, opts?: JobsOptions): Promise<object> => {
        if (this.fallo) return Promise.reject(this.fallo);
        this.llamadas.push({ name, data, opts });
        return Promise.resolve({});
      },
      upsertJobScheduler: (...args: unknown[]): Promise<object> => {
        if (this.fallo) return Promise.reject(this.fallo);
        this.programadores.push(args);
        return Promise.resolve({});
      },
      close: (): Promise<void> => Promise.resolve(),
    };
    return cola as unknown as Queue;
  }
}

function colaConRedis(): ColaGrabadora {
  vi.stubEnv('REDIS_HOST', 'redis.test');
  const cola = new ColaGrabadora();
  cola.onModuleInit();
  return cola;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';
const OPERACION = '33333333-3333-4333-8333-333333333333';

function compensacion(cancellableItemIds: string[]): CompensateJob {
  return { tenantId: TENANT, orderId: ORDEN, cancellableItemIds, reason: 'partial-items-failed' };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('jobId de post-venta — tres segmentos, siempre', () => {
  it('el reintento de cancelación usa la operación durable como intento', () => {
    const id = cancelRetryJobId({
      tenantId: TENANT,
      orderId: ORDEN,
      operationId: OPERACION,
      type: 'cancel',
    });

    expect(id).toBe(`cancel:${ORDEN}:${OPERACION}`);
    expect(bullMqJobIdRejection(id)).toBeUndefined();
  });

  it('dos operaciones de la misma orden son dos jobs distintos', () => {
    const base = { tenantId: TENANT, orderId: ORDEN, type: 'cancel' as const };
    expect(cancelRetryJobId({ ...base, operationId: 'op-1' })).not.toBe(
      cancelRetryJobId({ ...base, operationId: 'op-2' }),
    );
  });

  it('un itemId con ":" no rompe el jobId de la compensación', () => {
    // Con la lista unida por comas, `NDC:SEG:1` daba cinco segmentos y BullMQ lo rechazaba.
    const id = compensationJobId(compensacion(['NDC:SEG:1', 'NDC:SEG:2']));

    expect(id).toMatch(new RegExp(`^compensate:${ORDEN}:[0-9a-f]{64}$`));
    expect(bullMqJobIdRejection(id)).toBeUndefined();
  });

  it('la huella no depende del orden de los ítems, pero sí de cuáles son', () => {
    expect(compensationJobId(compensacion(['2', '1']))).toBe(
      compensationJobId(compensacion(['1', '2'])),
    );
    // Unidos por comas, los dos daban `a,b` y la segunda compensación se tomaba por duplicada.
    expect(compensationJobId(compensacion(['a,b']))).not.toBe(
      compensationJobId(compensacion(['a', 'b'])),
    );
  });

  it('el `cancel:<orderId>` de dos segmentos es justo el que BullMQ rechaza', () => {
    expect(bullMqJobIdRejection(`${POST_SALE_JOBS.cancel}:${ORDEN}`)).toBe(
      'Custom Id cannot contain :',
    );
    expect(postSaleJobId(POST_SALE_JOBS.cancel, ORDEN, OPERACION).split(':')).toHaveLength(3);
  });
});

describe('PostSaleQueueService — lo que recibe BullMQ', () => {
  it('sin REDIS_HOST no encola y lo dice con `false`', async () => {
    vi.stubEnv('REDIS_HOST', '');
    const cola = new ColaGrabadora();
    cola.onModuleInit();

    await expect(
      cola.enqueueCancelRetry({
        tenantId: TENANT,
        orderId: ORDEN,
        operationId: OPERACION,
        type: 'cancel',
      }),
    ).resolves.toBe(false);
    expect(cola.llamadas).toEqual([]);
  });

  it('el reintento de cancelación llega con su jobId y la política de reintentos de siempre', async () => {
    const cola = colaConRedis();

    await expect(
      cola.enqueueCancelRetry({
        tenantId: TENANT,
        orderId: ORDEN,
        operationId: OPERACION,
        type: 'cancel',
      }),
    ).resolves.toBe(true);

    expect(cola.llamadas).toEqual([
      {
        name: 'cancel',
        data: { tenantId: TENANT, orderId: ORDEN, operationId: OPERACION, type: 'cancel' },
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
          jobId: `cancel:${ORDEN}:${OPERACION}`,
        },
      },
    ]);
  });

  it('`delayMs` llega a BullMQ como `delay`', async () => {
    const cola = colaConRedis();

    await expect(
      cola.enqueueVerifyCreation({ tenantId: TENANT, orderId: ORDEN }, { delayMs: 120_000 }),
    ).resolves.toBe(true);

    expect(cola.llamadas[0]?.opts?.delay).toBe(120_000);
    // La lectura de cierre no lleva jobId: BullMQ asigna uno por job.
    expect(cola.llamadas[0]?.opts).not.toHaveProperty('jobId');
  });

  it('sin `delayMs` no manda `delay`: el job corre en cuanto haya worker', async () => {
    const cola = colaConRedis();

    await cola.enqueueCompensation(compensacion(['12']));

    expect(cola.llamadas[0]?.opts).not.toHaveProperty('delay');
    expect(cola.llamadas[0]?.opts?.jobId).toBe(compensationJobId(compensacion(['12'])));
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'un retardo de %s no se encola y devuelve `false`',
    async (delayMs) => {
      const cola = colaConRedis();

      await expect(
        cola.enqueueVerifyCreation({ tenantId: TENANT, orderId: ORDEN }, { delayMs }),
      ).resolves.toBe(false);
      expect(cola.llamadas).toEqual([]);
    },
  );

  it('un fallo de Redis devuelve `false` sin lanzar', async () => {
    const cola = colaConRedis();
    cola.fallo = new Error('ECONNREFUSED');

    await expect(cola.enqueueCompensation(compensacion(['12']))).resolves.toBe(false);
  });
});

describe('verificación de reservas de hotel y barrido (PR-4.7)', () => {
  it('cada paso es un job de tres segmentos: `verify-hotel-booking:<orderId>:<paso>`', () => {
    const id = verifyHotelBookingJobId({ tenantId: TENANT, orderId: ORDEN, step: 2 });

    expect(id).toBe(`verify-hotel-booking:${ORDEN}:2`);
    expect(bullMqJobIdRejection(id)).toBeUndefined();
  });

  it('el paso llega a BullMQ con su jobId, su retardo y la política de reintentos de una lectura', async () => {
    const cola = colaConRedis();

    await expect(
      cola.enqueueVerifyHotelBooking(
        { tenantId: TENANT, orderId: ORDEN, step: 0 },
        { delayMs: 120_000 },
      ),
    ).resolves.toBe(true);

    expect(cola.llamadas).toEqual([
      {
        name: 'verify-hotel-booking',
        data: { tenantId: TENANT, orderId: ORDEN, step: 0 },
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
          jobId: `verify-hotel-booking:${ORDEN}:0`,
          delay: 120_000,
        },
      },
    ]);
  });

  it('`verify-cancellation`: un job por paso Y por calendario, en tres segmentos (PR-5.3)', () => {
    const paso = { tenantId: TENANT, orderId: ORDEN, step: 3, anchorAt: 1_790_000_000_000 };

    expect(verifyCancellationJobId(paso)).toBe(`verify-cancellation:${ORDEN}:3-1790000000000`);
    expect(bullMqJobIdRejection(verifyCancellationJobId(paso))).toBeUndefined();
    // Una cancelación nueva de la misma orden abre otro calendario: otro job, no un duplicado.
    expect(verifyCancellationJobId({ ...paso, anchorAt: paso.anchorAt + 1 })).not.toBe(
      verifyCancellationJobId(paso),
    );
  });

  it('el paso de verify-cancellation llega a BullMQ con su jobId, su retardo y los reintentos de una lectura', async () => {
    const cola = colaConRedis();
    const paso = { tenantId: TENANT, orderId: ORDEN, step: 0, anchorAt: 1_000 };

    await expect(cola.enqueueVerifyCancellation(paso, { delayMs: 120_000 })).resolves.toBe(true);
    await expect(cola.enqueueVerifyCancellation({ ...paso, step: 1 })).resolves.toBe(true);

    expect(cola.llamadas).toEqual([
      {
        name: 'verify-cancellation',
        data: paso,
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
          jobId: `verify-cancellation:${ORDEN}:0-1000`,
          delay: 120_000,
        },
      },
      {
        name: 'verify-cancellation',
        data: { ...paso, step: 1 },
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
          jobId: `verify-cancellation:${ORDEN}:1-1000`,
        },
      },
    ]);
  });

  it('el barrido se programa con un Job Scheduler, un intento por corrida', async () => {
    const cola = colaConRedis();

    await expect(cola.scheduleSweeper()).resolves.toBe(true);

    expect(cola.programadores).toEqual([
      [
        'post-sale-sweeper',
        { every: POST_SALE_SWEEP_EVERY_MS },
        {
          name: 'post-sale-sweeper',
          data: {},
          opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
        },
      ],
    ]);
    expect(POST_SALE_SWEEP_EVERY_MS).toBe(15 * 60_000);
  });

  it('sin Redis, con un intervalo inválido o con Redis caído, el barrido no queda programado y lo dice', async () => {
    vi.stubEnv('REDIS_HOST', '');
    const sinRedis = new ColaGrabadora();
    sinRedis.onModuleInit();
    await expect(sinRedis.scheduleSweeper()).resolves.toBe(false);

    const cola = colaConRedis();
    await expect(cola.scheduleSweeper(0)).resolves.toBe(false);
    await expect(cola.scheduleSweeper(-1)).resolves.toBe(false);
    cola.fallo = new Error('ECONNREFUSED');
    await expect(cola.scheduleSweeper()).resolves.toBe(false);
    expect(cola.programadores).toEqual([]);
  });
});
