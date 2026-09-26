import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Job, Queue, Worker, type ConnectionOptions, type MinimalQueue } from 'bullmq';
import {
  POST_SALE_JOBS,
  POST_SALE_QUEUE,
  PostSaleQueueService,
  POST_SALE_SWEEP_EVERY_MS,
  cancelRetryJobId,
  compensationJobId,
  hcnCheckJobId,
  verifyCancellationJobId,
  verifyHotelBookingJobId,
  type CancelRetryJob,
  type CompensateJob,
  type VerifyCreationJob,
  type VerifyHotelBookingJob,
} from './post-sale-queue.service.js';
import { redisConnection } from './redis-connection.js';
import { bullMqJobIdRejection } from './__fixtures__/recording-queue.service.js';

/**
 * La cola de post-venta contra BullMQ de verdad.
 *
 * El doble de pruebas no pasa por BullMQ, y por eso el `cancel:<orderId>` de dos segmentos pasó
 * todos los tests mientras en producción `add()` devolvía `false` y el reintento de la
 * cancelación no se encolaba nunca. Este fichero cierra ese hueco por las dos puntas:
 *
 * - Sin Redis, corre igual la validación de `jobId` de BullMQ —su `Job.validateOptions`, no una
 *   copia— sobre cada id que arma la cola, y la compara con la regla que aplica el doble.
 * - Con Redis, encola por el servicio real y ejecuta un job con `delay` después del retardo.
 *
 * La segunda parte se SALTA sin `REDIS_HOST`, la variable que lee `redis-connection.ts`. Usa un
 * `prefix` propio y lo borra al final: nunca toca la cola viva ni sus jobs.
 */

/** Un `Job` de BullMQ que sólo sirve para llamar a su validación sin conexión. */
class SondaJob extends Job {
  validar(): void {
    this.validateOptions(this.asJSON());
  }
}

/** Lo mínimo que el constructor de `Job` lee de su cola; ningún método toca Redis. */
const COLA_SIN_REDIS = {
  name: 'sonda',
  qualifiedName: 'bull:sonda',
  keys: {},
  opts: {},
  toKey: (tipo: string) => `bull:sonda:${tipo}`,
} as unknown as MinimalQueue;

function rechazoDeBullMq(jobId: string): string | undefined {
  try {
    new SondaJob(COLA_SIN_REDIS, 'sonda', {}, { jobId }).validar();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

const TENANT = randomUUID();

function reintentoDeCancelacion(orderId: string): CancelRetryJob {
  return { tenantId: TENANT, orderId, operationId: randomUUID(), type: 'cancel' };
}

function compensacion(orderId: string): CompensateJob {
  // Ids de proveedor con `:` y `,`: los dos caracteres que rompían la huella unida por comas.
  return {
    tenantId: TENANT,
    orderId,
    cancellableItemIds: ['NDC:SEG:1', 'seg,2'],
    reason: 'partial-items-failed',
  };
}

describe('jobId de post-venta — la regla de BullMQ, sin Redis', () => {
  it.each([
    'cancel:orden:operacion',
    'cancel:orden',
    'a:b:c:d',
    'sin-dos-puntos',
    '123',
    '123abc',
    'x:y:',
  ])('el doble y BullMQ coinciden sobre "%s"', (jobId) => {
    expect(bullMqJobIdRejection(jobId)).toBe(rechazoDeBullMq(jobId));
  });

  it('BullMQ acepta todos los jobId que arma la cola', () => {
    const orderId = randomUUID();
    const ids = [
      cancelRetryJobId(reintentoDeCancelacion(orderId)),
      compensationJobId(compensacion(orderId)),
      ...[0, 1, 2, 3].map((step) => verifyHotelBookingJobId({ tenantId: TENANT, orderId, step })),
      ...[0, 4].map((step) =>
        verifyCancellationJobId({ tenantId: TENANT, orderId, step, anchorAt: Date.now() }),
      ),
      ...[0, 3].map((attempt) => hcnCheckJobId({ tenantId: TENANT, orderId, attempt })),
    ];

    expect(ids.map(rechazoDeBullMq)).toEqual(ids.map(() => undefined));
  });

  it('y rechaza el `cancel:<orderId>` de antes', () => {
    expect(rechazoDeBullMq(`${POST_SALE_JOBS.cancel}:${randomUUID()}`)).toBe(
      'Custom Id cannot contain :',
    );
  });
});

/** El servicio de producción con su cola bajo un `prefix` de prueba. */
class ColaAislada extends PostSaleQueueService {
  constructor(private readonly prefix: string) {
    super();
  }

  protected override createQueue(connection: ConnectionOptions): Queue {
    return new Queue(POST_SALE_QUEUE, { connection, prefix: this.prefix });
  }
}

const hasRedis = Boolean(process.env['REDIS_HOST']);
const d = hasRedis ? describe : describe.skip;

d('PostSaleQueueService contra BullMQ real', () => {
  const prefix = `st-test-${randomBytes(4).toString('hex')}`;
  let connection: ConnectionOptions;
  let cola: ColaAislada;
  let inspector: Queue;

  beforeAll(() => {
    const opciones = redisConnection();
    if (!opciones) throw new Error('REDIS_HOST está definido pero no produjo una conexión');
    connection = opciones;
    cola = new ColaAislada(prefix);
    cola.onModuleInit();
    inspector = new Queue(POST_SALE_QUEUE, { connection, prefix });
  });

  afterAll(async () => {
    await cola.onModuleDestroy();
    await inspector.obliterate({ force: true });
    await inspector.close();
  });

  it('acepta todos los jobId que usa la cola', async () => {
    const orderId = randomUUID();
    const cancelacion = reintentoDeCancelacion(orderId);
    const compensa = compensacion(orderId);
    const verifica: VerifyCreationJob = { tenantId: TENANT, orderId };
    const paso: VerifyHotelBookingJob = { tenantId: TENANT, orderId, step: 1 };

    await expect(cola.enqueueCancelRetry(cancelacion)).resolves.toBe(true);
    await expect(cola.enqueueCompensation(compensa)).resolves.toBe(true);
    await expect(cola.enqueueVerifyCreation(verifica)).resolves.toBe(true);
    await expect(cola.enqueueVerifyHotelBooking(paso, { delayMs: 60_000 })).resolves.toBe(true);
    const cancelacionEnCurso = { tenantId: TENANT, orderId, step: 0, anchorAt: Date.now() };
    await expect(
      cola.enqueueVerifyCancellation(cancelacionEnCurso, { delayMs: 120_000 }),
    ).resolves.toBe(true);
    expect((await inspector.getJob(verifyCancellationJobId(cancelacionEnCurso)))?.opts.delay).toBe(
      120_000,
    );
    // P5: una lectura del HCN a cinco días.
    const hcn = { tenantId: TENANT, orderId, attempt: 0 };
    await expect(cola.enqueueHcnCheck(hcn, { delayMs: 120 * 3_600_000 })).resolves.toBe(true);
    expect((await inspector.getJob(hcnCheckJobId(hcn)))?.opts.delay).toBe(120 * 3_600_000);

    expect((await inspector.getJob(cancelRetryJobId(cancelacion)))?.name).toBe('cancel');
    expect((await inspector.getJob(compensationJobId(compensa)))?.name).toBe('compensate');
    const diferido = await inspector.getJob(verifyHotelBookingJobId(paso));
    expect(diferido?.name).toBe('verify-hotel-booking');
    expect(diferido?.opts.delay).toBe(60_000);
  });

  it('el barrido queda como UN Job Scheduler, aunque la API arranque dos veces', async () => {
    await expect(cola.scheduleSweeper()).resolves.toBe(true);
    await expect(cola.scheduleSweeper()).resolves.toBe(true);

    const programadores = await inspector.getJobSchedulers();
    expect(programadores.map((p) => [p.key, Number(p.every)])).toEqual([
      ['post-sale-sweeper', POST_SALE_SWEEP_EVERY_MS],
    ]);
  });

  it('BullMQ sigue rechazando el id de dos segmentos (y por eso se cambió)', async () => {
    await expect(
      inspector.add(POST_SALE_JOBS.cancel, {}, { jobId: `cancel:${randomUUID()}` }),
    ).rejects.toThrow('Custom Id cannot contain :');
  });

  it('el mismo intento no se encola dos veces', async () => {
    const cancelacion = reintentoDeCancelacion(randomUUID());

    await expect(cola.enqueueCancelRetry(cancelacion)).resolves.toBe(true);
    // BullMQ resuelve el duplicado con el job que ya existe: para el llamador sigue encolado.
    await expect(cola.enqueueCancelRetry(cancelacion)).resolves.toBe(true);

    // Se cuenta por la orden y no por el id: dos ids para el mismo intento también serían dos
    // writes, y filtrar por el id esperado no los vería.
    const deLaOrden = (await inspector.getJobs(['wait', 'delayed', 'active'])).filter(
      (job) => (job.data as Partial<CancelRetryJob>).orderId === cancelacion.orderId,
    );
    expect(deLaOrden.map((job) => job.id)).toEqual([cancelRetryJobId(cancelacion)]);
  });

  it('un job con `delay` espera en `delayed` y corre después del retardo', async () => {
    const RETARDO_MS = 1_500;
    const orderId = randomUUID();
    let marcarCorrida: (en: number) => void = () => undefined;
    const corrida = new Promise<number>((resolve) => {
      marcarCorrida = resolve;
    });
    const worker = new Worker<Partial<VerifyCreationJob>>(
      POST_SALE_QUEUE,
      (job) => {
        if (job.data.orderId === orderId) marcarCorrida(Date.now());
        return Promise.resolve();
      },
      { connection, prefix },
    );

    try {
      const encoladoEn = Date.now();
      await expect(
        cola.enqueueVerifyCreation({ tenantId: TENANT, orderId }, { delayMs: RETARDO_MS }),
      ).resolves.toBe(true);

      const diferido = (await inspector.getJobs(['delayed'])).find(
        (job) => (job.data as Partial<VerifyCreationJob>).orderId === orderId,
      );
      expect(diferido?.opts.delay).toBe(RETARDO_MS);

      const corrioEn = await corrida;
      expect(corrioEn - encoladoEn).toBeGreaterThanOrEqual(RETARDO_MS);
    } finally {
      await worker.close();
    }
  }, 15_000);
});
