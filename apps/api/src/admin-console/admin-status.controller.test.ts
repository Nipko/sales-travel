import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { AdminStatusController } from './admin-status.controller.js';
import type { AdminStatusService } from './admin-status.service.js';
import { AdminStatusService as Service } from './admin-status.service.js';
import type { AdminOverviewService } from './admin-overview.service.js';
import type { AdminSystemService } from './admin-system.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';

describe('AdminStatusController: GET /admin/status, sólo el superadmin', () => {
  it('la ruta y las guardas de la consola', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminStatusController)).toBe('admin/status');
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminStatusController)).toEqual([SuperadminGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminStatusController)).toEqual([...PLATFORM_ROLES]);
  });

  it('lee el estado con el id del superadmin como actor', async () => {
    const service = { status: vi.fn(() => Promise.resolve({ overall: 'ok' })) };
    const controller = new AdminStatusController(service as unknown as AdminStatusService);
    await expect(controller.status(USUARIO)).resolves.toEqual({ overall: 'ok' });
    expect(service.status).toHaveBeenCalledWith(USUARIO);
  });
});

describe('AdminStatusService', () => {
  it('pide Salud, Sistema y el Resumen con el mismo actor y el mismo instante, y los pliega', async () => {
    const now = new Date('2026-11-19T15:00:00Z');
    const system = {
      providerHealth: vi.fn(() => Promise.resolve({ providers: [] })),
      jobs: vi.fn(() =>
        Promise.resolve({
          postSaleSweep: {
            lastRunAt: null,
            lastOk: null,
            lastOkAt: null,
            durationMs: null,
            tenantsFailed: null,
            runs24h: 0,
            failures24h: 0,
            stale: true,
            everyMinutes: 15,
            staleAfterMinutes: 45,
          },
          reconciliation: { sinceDays: 7, byProvider: [] },
          catalogs: [],
        }),
      ),
    };
    const overview = {
      overview: vi.fn(() =>
        Promise.resolve({
          providers: {
            killSwitched: [],
            openCircuits: [],
            disabledGlobally: [],
            tenantOverridesDisabled: 0,
          },
          attention: {
            depositReports: { total: 0, platform: 0, network: 0 },
            orders: {
              total: 0,
              byReason: {
                review: 0,
                'verifying-long': 0,
                'create-stuck': 0,
                'cancel-failed': 0,
                'hold-conflict': 0,
                'hold-orphan': 0,
                'hcn-missing': 0,
                reconciliation: 0,
              },
              sample: [],
            },
            postSale: { failed: 0, stuck: 0, byType: [] },
          },
        }),
      ),
    };
    const service = new Service(
      system as unknown as AdminSystemService,
      overview as unknown as AdminOverviewService,
    );
    const view = await service.status(USUARIO, now);
    expect(system.providerHealth).toHaveBeenCalledWith(USUARIO, now);
    expect(system.jobs).toHaveBeenCalledWith(USUARIO, now);
    expect(overview.overview).toHaveBeenCalledWith(USUARIO, {}, now);
    expect(view.overall).toBe('critical');
    expect(view.areas.find((a) => a.id === 'post-sale-sweep')?.level).toBe('critical');
    expect(view.pendings.length).toBeGreaterThan(0);
  });
});
