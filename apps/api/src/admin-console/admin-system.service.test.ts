import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_EVENT_PREFIX } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { POST_SALE_SWEEP_EVENTS } from '../orders/post-sale-sweep-events.js';
import {
  POST_SALE_SWEEP_EVERY_MS,
  RECONCILIATION_DAILY_CRON,
} from '../queue/post-sale-queue.service.js';
import { CATALOG_STALE_HOURS, foldCatalogs } from './admin-overview.fold.js';
import {
  AdminSystemService,
  POST_SALE_SWEEP_STALE_MS,
  RECONCILIATION_STALE_HOURS,
  SYSTEM_SCHEDULES,
  foldPostSaleSweep,
  foldSystemReconciliation,
} from './admin-system.service.js';

/**
 * Sistema › Procesos sin base: cuándo el barrido se da por detenido, cuándo un catálogo o una
 * conciliación quedaron atrás, y que la programación diga lo mismo que los workflows. La lectura
 * contra Postgres (RLS de `domain_events`, admin_reconciliation_health) está en
 * admin-system.integration.test.ts.
 */

const NOW = new Date('2026-10-13T12:00:00.000Z');
const MIN = 60_000;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('foldPostSaleSweep', () => {
  it('corre cada 15 minutos y se da por detenido sin una corrida correcta en 45', () => {
    expect(POST_SALE_SWEEP_EVERY_MS).toBe(15 * MIN);
    expect(POST_SALE_SWEEP_STALE_MS).toBe(45 * MIN);

    const at = (ms: number) =>
      foldPostSaleSweep({ lastCompleted: { occurred_at: ago(ms), payload: {} } }, NOW);
    expect(at(14 * MIN).stale).toBe(false);
    expect(at(45 * MIN).stale).toBe(false);
    expect(at(45 * MIN + 1).stale).toBe(true);
    expect(at(3 * 60 * MIN)).toMatchObject({
      stale: true,
      everyMinutes: 15,
      staleAfterMinutes: 45,
    });
  });

  it('una corrida correcta reciente: cuándo, cuánto tardó, a cuántos nodos no llegó y las de 24 h', () => {
    const view = foldPostSaleSweep(
      {
        lastCompleted: {
          occurred_at: '2026-10-13T11:50:00.000Z',
          payload: { durationMs: 8_400, tenantsFailed: 2, tenants: 40 },
        },
        lastFailed: { occurred_at: new Date('2026-10-13T09:00:00.000Z'), payload: {} },
        counts: { completed: '94', failed: '2' },
      },
      NOW,
    );
    expect(view).toEqual({
      lastRunAt: '2026-10-13T11:50:00.000Z',
      lastOk: true,
      lastOkAt: '2026-10-13T11:50:00.000Z',
      durationMs: 8_400,
      tenantsFailed: 2,
      runs24h: 96,
      failures24h: 2,
      stale: false,
      everyMinutes: 15,
      staleAfterMinutes: 45,
    });
  });

  it('si la última se cayó, lo dice; el atraso se mide desde la última correcta', () => {
    const view = foldPostSaleSweep(
      {
        lastCompleted: { occurred_at: ago(50 * MIN), payload: { durationMs: 100 } },
        lastFailed: { occurred_at: ago(5 * MIN), payload: { errorClass: 'Error' } },
        counts: { completed: 1, failed: 3 },
      },
      NOW,
    );
    expect(view).toMatchObject({
      lastRunAt: ago(5 * MIN).toISOString(),
      lastOk: false,
      lastOkAt: ago(50 * MIN).toISOString(),
      durationMs: 100,
      tenantsFailed: null,
      runs24h: 4,
      failures24h: 3,
      stale: true,
    });
  });

  it('cayéndose cada 15 minutos también está detenido, aunque "corra"', () => {
    const view = foldPostSaleSweep(
      {
        lastFailed: { occurred_at: ago(2 * MIN), payload: {} },
        counts: { completed: 0, failed: 96 },
      },
      NOW,
    );
    expect(view).toMatchObject({ lastOk: false, lastOkAt: null, stale: true, failures24h: 96 });
  });

  it('sin rastro de ninguna corrida: detenido, sin fechas ni números inventados', () => {
    expect(foldPostSaleSweep({}, NOW)).toEqual({
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
    });
  });

  it('un payload que no se puede leer no inventa duración ni nodos', () => {
    for (const payload of [null, 'texto', [1], { durationMs: -1, tenantsFailed: 1.5 }]) {
      expect(
        foldPostSaleSweep({ lastCompleted: { occurred_at: ago(MIN), payload } }, NOW),
      ).toMatchObject({ durationMs: null, tenantsFailed: null, stale: false });
    }
  });

  it('una fecha ilegible cuenta como sin corrida', () => {
    expect(
      foldPostSaleSweep({ lastCompleted: { occurred_at: 'nunca', payload: {} } }, NOW),
    ).toMatchObject({ lastOkAt: null, lastRunAt: null, stale: true });
  });
});

describe('foldSystemReconciliation', () => {
  const row = (provider_code: string, last_finished_at: Date | null, runs = 1) => ({
    provider_code,
    runs: String(runs),
    failed_runs: '0',
    last_finished_at,
    last_status: last_finished_at === null ? null : 'completed',
    critical_items: '2',
    warning_items: '0',
  });

  it('por proveedor, con la que dejó de conciliar: más de 36 horas sin terminar una corrida', () => {
    expect(RECONCILIATION_STALE_HOURS).toBe(36);
    const view = foldSystemReconciliation(
      [
        row('tbo-hotels', ago(5 * 60 * MIN)),
        row('agent-cars', ago(36 * 60 * MIN + 1), 0),
        row('nuevo', null, 0),
      ],
      7,
      NOW,
    );
    expect(view.sinceDays).toBe(7);
    expect(view.byProvider.map((p) => [p.providerCode, p.stale, p.criticalItems])).toEqual([
      ['agent-cars', true, 2],
      ['nuevo', true, 2],
      ['tbo-hotels', false, 2],
    ]);
  });
});

describe('frescura de los catálogos', () => {
  it('un catálogo sin sincronizar en más de 36 horas quedó atrás', () => {
    expect(CATALOG_STALE_HOURS).toBe(36);
    const catalog = (hours: number | null) =>
      foldCatalogs(
        [
          {
            provider_code: 'tbo-hotels',
            cities: '120',
            synced_last_48h: '80',
            failed_cities: '3',
            last_synced_at: hours === null ? null : ago(hours * 60 * MIN),
          },
        ],
        NOW,
      )[0];
    expect(catalog(35)).toMatchObject({
      cities: 120,
      syncedLast48h: 80,
      failedCities: 3,
      stale: false,
    });
    expect(catalog(36.01)?.stale).toBe(true);
    expect(catalog(null)).toMatchObject({ lastSyncedAt: null, stale: true });
  });
});

describe('la programación', () => {
  const workflows = join(__dirname, '..', '..', '..', '..', '.github', 'workflows');

  it('cada cron de GitHub es el de su workflow: cambiar uno sin el otro rompe acá', () => {
    const github = SYSTEM_SCHEDULES.filter((s) => s.runner === 'github');
    expect(github.map((s) => s.workflow)).toEqual([
      'sync-airports.yml',
      'sync-hotel-inventory.yml',
      'sync-tbo-hotel-inventory.yml',
    ]);
    for (const s of github) {
      const yml = readFileSync(join(workflows, s.workflow ?? ''), 'utf8');
      const crons = [...yml.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
      expect(crons, s.workflow ?? '').toEqual([s.cron]);
    }
  });

  it('lo del api sale de sus constantes', () => {
    expect(SYSTEM_SCHEDULES.find((s) => s.id === 'post-sale-sweep')).toMatchObject({
      runner: 'api',
      cron: null,
    });
    expect(SYSTEM_SCHEDULES.find((s) => s.id === 'post-sale-sweep')?.schedule).toMatch(
      /^Cada 15 minutos/,
    );
    const reconciliation = SYSTEM_SCHEDULES.find((s) => s.id === 'reconciliation');
    expect(reconciliation?.cron).toBe(RECONCILIATION_DAILY_CRON);
    expect(RECONCILIATION_DAILY_CRON).toBe('30 4 * * *');
    expect(reconciliation?.schedule).toContain('04:30 UTC');
  });

  it('las horas en palabras dicen lo mismo que el cron', () => {
    const text = (id: string) => SYSTEM_SCHEDULES.find((s) => s.id === id)?.schedule ?? '';
    expect(text('sync-airports')).toContain('03:00 UTC');
    expect(text('sync-hotel-inventory')).toContain('03:30 UTC');
    expect(text('sync-tbo-hotel-inventory')).toContain('de 06:17 a 09:17 UTC');
  });

  it('los eventos del barrido son del sistema: la actividad de la red no los muestra', () => {
    for (const type of Object.values(POST_SALE_SWEEP_EVENTS)) {
      expect(type.startsWith(SYSTEM_EVENT_PREFIX)).toBe(true);
    }
  });
});

describe('AdminSystemService.jobs', () => {
  it('el rechazo de la base a quien no es superadmin sale como el 403 de la consola', async () => {
    const db = {
      withRequestContext: vi.fn(() =>
        Promise.reject(Object.assign(new Error('admin_superadmin_required'), { code: '42501' })),
      ),
    };
    const service = new AdminSystemService(db as unknown as DatabaseService);
    await expect(service.jobs('99999999-9999-4999-8999-999999999999')).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
    expect(db.withRequestContext).toHaveBeenCalledWith(
      { userId: '99999999-9999-4999-8999-999999999999' },
      expect.any(Function),
    );
  });

  it('cualquier otro error sigue su camino', async () => {
    const boom = new Error('otra cosa');
    const db = { withRequestContext: vi.fn(() => Promise.reject(boom)) };
    const service = new AdminSystemService(db as unknown as DatabaseService);
    await expect(service.jobs('99999999-9999-4999-8999-999999999999')).rejects.toBe(boom);
  });
});
