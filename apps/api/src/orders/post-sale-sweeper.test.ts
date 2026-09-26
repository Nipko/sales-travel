import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { HcnSweepReport, HcnTrackingService } from '../hotels/hcn-tracking.service.js';
import type {
  HotelBookingVerificationService,
  HotelVerificationSweepReport,
} from '../hotels/hotel-booking-verification.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import type {
  ReconciliationDispatchReport,
  ReconciliationService,
} from '../reconciliation/reconciliation.service.js';
import type {
  HotelCancelVerifySweepReport,
  HotelOrderCancellationService,
} from './hotel-order-cancellation.service.js';
import {
  POST_SALE_SWEEP_FIRST_RUN_MS,
  POST_SALE_SWEEP_SCHEDULE_WAIT_MS,
  PostSaleSweeper,
} from './post-sale-sweeper.js';

/**
 * El barrido de post-venta (docs/tbo/09 PR-4.7; 08 RNF-10): recorre los tenants uno por uno —la API
 * corre como `app_user`, sin rol que salte la RLS— y un tenant que falla no frena a los demás. Con
 * Redis lo programa BullMQ; sin Redis corre con un temporizador del proceso (RF-21 CA-3: es cuando
 * la cola no encola nada que el barrido tiene que recoger lo pendiente).
 */

const QUINCE_MIN = 15 * 60_000;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function informe(
  parcial: Partial<HotelVerificationSweepReport> = {},
): HotelVerificationSweepReport {
  return {
    examined: 0,
    adopted: 0,
    failed: 0,
    consolidated: 0,
    advanced: 0,
    'not-found': 0,
    held: 0,
    unavailable: 0,
    skipped: 0,
    ...parcial,
  };
}

function informeDeCancelaciones(
  parcial: Partial<HotelCancelVerifySweepReport> = {},
): HotelCancelVerifySweepReport {
  return {
    examined: 0,
    failed: 0,
    closed: 0,
    advanced: 0,
    stuck: 0,
    settled: 0,
    held: 0,
    unavailable: 0,
    skipped: 0,
    ...parcial,
  };
}

function informeHcn(parcial: Partial<HcnSweepReport> = {}): HcnSweepReport {
  return {
    examined: 0,
    adopted: 0,
    failed: 0,
    received: 0,
    advanced: 0,
    missing: 0,
    stopped: 0,
    paused: 0,
    unavailable: 0,
    'window-entered': 0,
    skipped: 0,
    ...parcial,
  };
}

function informeConciliacion(
  parcial: Partial<ReconciliationDispatchReport> = {},
): ReconciliationDispatchReport {
  return { accounts: 0, queued: 0, ran: 0, failed: 0, ...parcial };
}

function banco(tenants: string[], redis = true) {
  const consulta = { tabla: '', columna: '', orden: '' };
  const db = {
    db: {
      selectFrom: (tabla: string) => {
        consulta.tabla = tabla;
        return {
          select: (columna: string) => {
            consulta.columna = columna;
            return {
              orderBy: (orden: string) => {
                consulta.orden = orden;
                return { execute: () => Promise.resolve(tenants.map((id) => ({ id }))) };
              },
            };
          },
        };
      },
    },
  } as unknown as DatabaseService;
  const sweepTenant = vi.fn<HotelBookingVerificationService['sweepTenant']>(() =>
    Promise.resolve(informe()),
  );
  const sweepCancellations = vi.fn<HotelOrderCancellationService['sweepTenant']>(() =>
    Promise.resolve(informeDeCancelaciones()),
  );
  const sweepHcn = vi.fn<HcnTrackingService['sweepTenant']>(() => Promise.resolve(informeHcn()));
  const sweepReconciliation = vi.fn<ReconciliationService['sweepTenant']>(() =>
    Promise.resolve(informeConciliacion()),
  );
  const queue = new RecordingQueueService(redis);
  const work = new InflightWorkRegistry();
  const sweeper = new PostSaleSweeper(
    db,
    queue.asService(),
    { sweepTenant } as unknown as HotelBookingVerificationService,
    work,
    { sweepTenant: sweepCancellations } as unknown as HotelOrderCancellationService,
    { sweepTenant: sweepHcn } as unknown as HcnTrackingService,
    { sweepTenant: sweepReconciliation } as unknown as ReconciliationService,
  );
  return {
    sweeper,
    sweepTenant,
    sweepCancellations,
    sweepHcn,
    sweepReconciliation,
    queue,
    consulta,
    work,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PostSaleSweeper — dónde corre', () => {
  it('con Redis lo programa BullMQ cada 15 minutos, y el proceso no suma temporizadores', async () => {
    vi.useFakeTimers();
    const b = banco([A]);

    b.sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(2 * QUINCE_MIN);

    expect(b.queue.sweeperSchedules).toEqual([QUINCE_MIN]);
    expect(b.sweepTenant).not.toHaveBeenCalled();
    b.sweeper.onModuleDestroy();
  });

  it('sin Redis corre con un temporizador: al minuto de arrancar y cada 15 minutos (RF-21 CA-3)', async () => {
    vi.useFakeTimers();
    const b = banco([A], false);

    b.sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(POST_SALE_SWEEP_FIRST_RUN_MS - 1);
    expect(b.sweepTenant).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(b.sweepTenant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUINCE_MIN - POST_SALE_SWEEP_FIRST_RUN_MS);
    expect(b.sweepTenant).toHaveBeenCalledTimes(2);

    b.sweeper.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2 * QUINCE_MIN);
    expect(b.sweepTenant).toHaveBeenCalledTimes(2);
  });

  it('una corrida lenta no se solapa con la siguiente, y el apagado la espera', async () => {
    vi.useFakeTimers();
    const b = banco([A], false);
    let terminar!: () => void;
    b.sweepTenant.mockImplementation(
      () =>
        new Promise((resolve) => {
          terminar = () => resolve(informe());
        }),
    );

    b.sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(POST_SALE_SWEEP_FIRST_RUN_MS + QUINCE_MIN);
    expect(b.sweepTenant).toHaveBeenCalledTimes(1);
    expect(b.work.countsByKind()).toEqual({ 'post-sale-sweep': 1 });

    // La señal detiene los temporizadores; lo que está corriendo termina.
    b.work.startShutdown(vi.fn());
    await vi.advanceTimersByTimeAsync(2 * QUINCE_MIN);
    expect(b.sweepTenant).toHaveBeenCalledTimes(1);
    terminar();
    await b.work.whenIdle();
  });

  it('una corrida que falla entera no apaga el temporizador', async () => {
    vi.useFakeTimers();
    const b = banco([], false);
    const run = vi.spyOn(b.sweeper, 'run');
    run.mockRejectedValueOnce(new Error('base caída')).mockRejectedValueOnce('boom');

    b.sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(POST_SALE_SWEEP_FIRST_RUN_MS + 2 * QUINCE_MIN);

    expect(run).toHaveBeenCalledTimes(3);
    b.sweeper.onModuleDestroy();
  });

  it('con Redis configurado pero caído la cola no contesta: barre con el temporizador igual', async () => {
    vi.useFakeTimers();
    const b = banco([A]);
    // BullMQ espera la conexión sin límite: el programador nunca confirma.
    vi.spyOn(b.queue, 'scheduleSweeper').mockReturnValue(new Promise(() => undefined));

    b.sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(
      POST_SALE_SWEEP_SCHEDULE_WAIT_MS + POST_SALE_SWEEP_FIRST_RUN_MS - 1,
    );
    expect(b.sweepTenant).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(b.sweepTenant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUINCE_MIN);
    expect(b.sweepTenant).toHaveBeenCalledTimes(2);
    b.sweeper.onModuleDestroy();
  });

  it('si Redis vuelve y el programador confirma tarde, el temporizador se apaga: no se barre dos veces', async () => {
    vi.useFakeTimers();
    const b = banco([A]);
    let confirmar!: (programado: boolean) => void;
    vi.spyOn(b.queue, 'scheduleSweeper').mockReturnValue(
      new Promise((resolve) => {
        confirmar = resolve;
      }),
    );

    b.sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(
      POST_SALE_SWEEP_SCHEDULE_WAIT_MS + POST_SALE_SWEEP_FIRST_RUN_MS,
    );
    expect(b.sweepTenant).toHaveBeenCalledTimes(1);

    confirmar(true);
    await vi.advanceTimersByTimeAsync(2 * QUINCE_MIN);
    expect(b.sweepTenant).toHaveBeenCalledTimes(1);
    b.sweeper.onModuleDestroy();
  });

  it('si el apagado llegó antes que la respuesta de la cola, no arranca temporizadores', async () => {
    vi.useFakeTimers();
    const b = banco([A], false);

    b.sweeper.onApplicationBootstrap();
    b.sweeper.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2 * QUINCE_MIN);

    expect(b.sweepTenant).not.toHaveBeenCalled();
  });
});

describe('PostSaleSweeper — la corrida', () => {
  it('recorre todos los tenants, en orden estable, con el mismo instante', async () => {
    const b = banco([A, B]);
    b.sweepTenant.mockImplementation((tenantId) =>
      Promise.resolve(
        tenantId === A
          ? informe({ examined: 2, advanced: 1, consolidated: 1 })
          : informe({ examined: 1, adopted: 1, 'not-found': 1 }),
      ),
    );

    const report = await b.sweeper.run(1_000);

    expect(b.consulta).toEqual({ tabla: 'tenants', columna: 'id', orden: 'id' });
    expect(b.sweepTenant.mock.calls).toEqual([
      [A, 1_000],
      [B, 1_000],
    ]);
    expect(report).toEqual({
      tenants: 2,
      tenantsFailed: 0,
      ...informe({ examined: 3, advanced: 1, consolidated: 1, adopted: 1, 'not-found': 1 }),
      cancellations: informeDeCancelaciones(),
      hcn: informeHcn(),
      reconciliation: informeConciliacion(),
    });
  });

  it('también verifica las cancelaciones de hotel, tenant por tenant, con su propio informe (PR-5.3)', async () => {
    const b = banco([A, B]);
    b.sweepCancellations.mockImplementation((tenantId) =>
      Promise.resolve(
        tenantId === A
          ? informeDeCancelaciones({ examined: 2, closed: 1, advanced: 1 })
          : informeDeCancelaciones({ examined: 1, stuck: 1 }),
      ),
    );

    const report = await b.sweeper.run(1_000);

    expect(b.sweepCancellations.mock.calls).toEqual([
      [A, 1_000],
      [B, 1_000],
    ]);
    expect(report.cancellations).toEqual(
      informeDeCancelaciones({ examined: 3, closed: 1, advanced: 1, stuck: 1 }),
    );
    // Los desenlaces de la verificación del Book no se mezclan con los de la cancelación.
    expect(report.examined).toBe(0);
  });

  it('también sigue el HCN, tenant por tenant, con su propio informe (PR-5.4)', async () => {
    const b = banco([A, B]);
    b.sweepHcn.mockImplementation((tenantId) =>
      Promise.resolve(
        tenantId === A
          ? informeHcn({ examined: 3, adopted: 1, advanced: 1, 'window-entered': 1 })
          : informeHcn({ examined: 1, missing: 1 }),
      ),
    );

    const report = await b.sweeper.run(1_000);

    expect(b.sweepHcn.mock.calls).toEqual([
      [A, 1_000],
      [B, 1_000],
    ]);
    expect(report.hcn).toEqual(
      informeHcn({ examined: 4, adopted: 1, advanced: 1, 'window-entered': 1, missing: 1 }),
    );
    expect(report.examined).toBe(0);
    expect(report.cancellations.examined).toBe(0);
  });

  it('también recupera las conciliaciones del día que no salieron, tenant por tenant (PR-5.5)', async () => {
    const b = banco([A, B]);
    b.sweepReconciliation.mockImplementation((tenantId) =>
      Promise.resolve(
        tenantId === A
          ? informeConciliacion({ accounts: 2, queued: 2 })
          : informeConciliacion({ accounts: 1, ran: 1 }),
      ),
    );

    const report = await b.sweeper.run(1_000);

    expect(b.sweepReconciliation.mock.calls).toEqual([
      [A, 1_000],
      [B, 1_000],
    ]);
    expect(report.reconciliation).toEqual(informeConciliacion({ accounts: 3, queued: 2, ran: 1 }));
    expect(report.examined).toBe(0);
  });

  it('una conciliación que falla en un tenant no frena al resto del barrido', async () => {
    const b = banco([A, B]);
    b.sweepReconciliation.mockImplementation((tenantId) =>
      tenantId === A
        ? Promise.reject(new Error('base caída'))
        : Promise.resolve(informeConciliacion({ accounts: 1, queued: 1 })),
    );
    b.sweepHcn.mockResolvedValue(informeHcn({ examined: 1, received: 1 }));

    const report = await b.sweeper.run();

    expect(report.tenantsFailed).toBe(1);
    expect(report.reconciliation).toEqual(informeConciliacion({ accounts: 1, queued: 1 }));
    expect(report.hcn).toMatchObject({ examined: 2, received: 2 });
  });

  it('un seguimiento del HCN que falla en un tenant no frena a las verificaciones ni a los demás tenants', async () => {
    const b = banco([A, B]);
    b.sweepHcn.mockImplementation((tenantId) =>
      tenantId === A
        ? Promise.reject(new Error('base caída'))
        : Promise.resolve(informeHcn({ examined: 1, received: 1 })),
    );
    b.sweepTenant.mockResolvedValue(informe({ examined: 1, held: 1 }));

    const report = await b.sweeper.run();

    expect(report).toMatchObject({ tenantsFailed: 1, examined: 2, held: 2 });
    expect(report.hcn).toMatchObject({ examined: 1, received: 1 });
  });

  it('una verificación que falla en un tenant no deja sin correr a la otra', async () => {
    const b = banco([A]);
    b.sweepTenant.mockRejectedValue(new Error('base caída'));
    b.sweepCancellations.mockResolvedValue(informeDeCancelaciones({ examined: 1, closed: 1 }));

    const report = await b.sweeper.run();

    expect(report.tenantsFailed).toBe(1);
    expect(report.cancellations).toMatchObject({ examined: 1, closed: 1 });

    const c = banco([A]);
    c.sweepCancellations.mockRejectedValue('boom');
    c.sweepTenant.mockResolvedValue(informe({ examined: 1, held: 1 }));
    expect(await c.sweeper.run()).toMatchObject({ tenantsFailed: 1, examined: 1, held: 1 });
  });

  it('un tenant que falla entero no frena a los demás', async () => {
    const b = banco([A, B, C]);
    b.sweepTenant.mockImplementation((tenantId) =>
      tenantId === B
        ? Promise.reject(new Error('base caída'))
        : Promise.resolve(informe({ examined: 1, held: 1 })),
    );

    const report = await b.sweeper.run();

    expect(report).toMatchObject({ tenants: 3, tenantsFailed: 1, examined: 2, held: 2 });
  });

  it('un rechazo que no es un Error también se cuenta', async () => {
    const b = banco([A]);
    b.sweepTenant.mockRejectedValue('boom');

    expect((await b.sweeper.run()).tenantsFailed).toBe(1);
  });

  it('sin nada que hacer no hace ruido', async () => {
    const b = banco([A]);
    expect(await b.sweeper.run()).toEqual({
      tenants: 1,
      tenantsFailed: 0,
      ...informe(),
      cancellations: informeDeCancelaciones(),
      hcn: informeHcn(),
      reconciliation: informeConciliacion(),
    });
  });
});
