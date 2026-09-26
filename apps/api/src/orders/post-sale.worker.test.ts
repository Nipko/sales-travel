import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HcnTrackingService } from '../hotels/hcn-tracking.service.js';
import type { HotelBookingVerificationService } from '../hotels/hotel-booking-verification.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import type { HotelOrderCancellationService } from './hotel-order-cancellation.service.js';
import type { OrdersService } from './orders.service.js';
import type { PostSaleSweeper } from './post-sale-sweeper.js';
// `vi.mock` sube antes de los imports: el worker ya ve el BullMQ falso.
import { PostSaleWorker, runPostSaleJob, type PostSaleJobHandlers } from './post-sale.worker.js';

/**
 * El worker de post-venta: el apagado ordenado (docs/tbo/09 PR-4.10) —deja de tomar jobs al
 * llegar la señal y termina los activos antes de `app.close()`, que cierra el pool primero— y el
 * enrutado de los jobs de la verificación de hoteles y del barrido (PR-4.7).
 */

type Procesador = (job: {
  name: string;
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
}) => Promise<void>;

const bull = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  constructed: 0,
  procesador: undefined as Procesador | undefined,
}));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_queue: string, procesador: Procesador) {
      bull.constructed += 1;
      bull.procesador = procesador;
    }
    close = bull.close;
    on = vi.fn();
  },
  Queue: class {},
}));

const orders = {} as OrdersService;
const runJob = vi.fn<HotelBookingVerificationService['runJob']>(() => Promise.resolve());
const hotelBookings = { runJob } as unknown as HotelBookingVerificationService;
const runCancelJob = vi.fn<HotelOrderCancellationService['runJob']>(() => Promise.resolve());
const hotelCancellations = { runJob: runCancelJob } as unknown as HotelOrderCancellationService;
const runHcnJob = vi.fn<HcnTrackingService['runJob']>(() => Promise.resolve());
const hcn = { runJob: runHcnJob } as unknown as HcnTrackingService;
const run = vi.fn<PostSaleSweeper['run']>();
const sweeper = { run } as unknown as PostSaleSweeper;
const TENANT = '11111111-1111-4111-8111-111111111111';

describe('PostSaleWorker en el apagado', () => {
  beforeEach(() => {
    bull.close.mockReset();
    bull.constructed = 0;
    bull.procesador = undefined;
    vi.unstubAllEnvs();
  });

  it('cierra el worker al empezar el apagado y onModuleDestroy espera al mismo cierre', async () => {
    vi.stubEnv('REDIS_HOST', 'redis');
    let finishJobs!: () => void;
    bull.close.mockReturnValue(
      new Promise<void>((resolve) => {
        finishJobs = resolve;
      }),
    );
    const registry = new InflightWorkRegistry();
    const worker = new PostSaleWorker(
      orders,
      hotelBookings,
      sweeper,
      registry,
      hotelCancellations,
      hcn,
    );

    worker.onModuleInit();
    expect(bull.constructed).toBe(1);
    expect(bull.close).not.toHaveBeenCalled();

    registry.startShutdown(vi.fn());
    await vi.waitFor(() => expect(bull.close).toHaveBeenCalledOnce());
    expect(registry.countsByKind()).toEqual({ 'post-sale-worker': 1 });

    finishJobs();
    await registry.whenIdle();
    await worker.onModuleDestroy();
    // BullMQ devuelve la misma promesa en cada `close()`: aquí sólo importa que la primera llegó
    // con la señal y no con `app.close()`.
    expect(bull.close).toHaveBeenCalledTimes(2);
  });

  it('sin Redis no hay worker ni nada que detener', () => {
    vi.stubEnv('REDIS_HOST', '');
    const registry = new InflightWorkRegistry();
    const worker = new PostSaleWorker(
      orders,
      hotelBookings,
      sweeper,
      registry,
      hotelCancellations,
      hcn,
    );

    worker.onModuleInit();
    registry.startShutdown(vi.fn());

    expect(bull.constructed).toBe(0);
    expect(registry.size).toBe(0);
  });
});

describe('runPostSaleJob — verificación de hoteles y barrido (PR-4.7)', () => {
  function manejadores(): PostSaleJobHandlers {
    return { orders, hotelBookings, hotelCancellations, hcn, sweeper };
  }

  beforeEach(() => {
    runJob.mockClear();
    runCancelJob.mockClear();
    runHcnJob.mockClear();
    run.mockReset();
  });

  it('`verify-hotel-booking` va a la verificación con el payload tal cual (lo valida ella)', async () => {
    const data = { tenantId: TENANT, orderId: 'o1', step: 2 };

    await runPostSaleJob(manejadores(), 'verify-hotel-booking', data, { made: 0, max: 5 });

    expect(runJob).toHaveBeenCalledWith(data, { final: false });
  });

  it('el último intento de la cola se le avisa: ahí se escala en vez de relanzar', async () => {
    const data = { tenantId: TENANT, orderId: 'o1', step: 0 };

    await runPostSaleJob(manejadores(), 'verify-hotel-booking', data, { made: 4, max: 5 });
    await runPostSaleJob(manejadores(), 'verify-hotel-booking', data);

    expect(runJob.mock.calls.map(([, intento]) => intento)).toEqual([
      { final: true },
      { final: true },
    ]);
  });

  it('`verify-cancellation` va a la verificación de cancelaciones, con el último intento avisado (PR-5.3)', async () => {
    const data = { tenantId: TENANT, orderId: 'o1', step: 1, anchorAt: 1_000 };

    await runPostSaleJob(manejadores(), 'verify-cancellation', data, { made: 0, max: 5 });
    await runPostSaleJob(manejadores(), 'verify-cancellation', data, { made: 4, max: 5 });

    expect(runCancelJob.mock.calls).toEqual([
      [data, { final: false }],
      [data, { final: true }],
    ]);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('`hcn-check` va al seguimiento del HCN, con el último intento avisado (PR-5.4)', async () => {
    const data = { tenantId: TENANT, orderId: 'o1', attempt: 2 };

    await runPostSaleJob(manejadores(), 'hcn-check', data, { made: 0, max: 5 });
    await runPostSaleJob(manejadores(), 'hcn-check', data, { made: 4, max: 5 });

    expect(runHcnJob.mock.calls).toEqual([
      [data, { final: false }],
      [data, { final: true }],
    ]);
    expect(runJob).not.toHaveBeenCalled();
    expect(runCancelJob).not.toHaveBeenCalled();
  });

  it('`post-sale-sweeper` corre el barrido', async () => {
    run.mockResolvedValue({} as Awaited<ReturnType<PostSaleSweeper['run']>>);

    await runPostSaleJob(manejadores(), 'post-sale-sweeper', {});

    expect(run).toHaveBeenCalledOnce();
  });

  it('el Worker de BullMQ le pasa al enrutado los intentos del job', async () => {
    vi.stubEnv('REDIS_HOST', 'redis');
    const worker = new PostSaleWorker(
      orders,
      hotelBookings,
      sweeper,
      new InflightWorkRegistry(),
      hotelCancellations,
      hcn,
    );
    worker.onModuleInit();
    const procesar = bull.procesador;
    if (procesar === undefined) throw new Error('no se construyó el Worker');

    await procesar({
      name: 'verify-hotel-booking',
      data: { tenantId: TENANT, orderId: 'o1', step: 1 },
      attemptsMade: 4,
      opts: { attempts: 5 },
    });
    await procesar({
      name: 'verify-hotel-booking',
      data: { tenantId: TENANT, orderId: 'o1', step: 1 },
      attemptsMade: 0,
      opts: {},
    });

    expect(runJob.mock.calls.map(([, intento]) => intento)).toEqual([
      { final: true },
      { final: true },
    ]);
    vi.unstubAllEnvs();
  });
});
