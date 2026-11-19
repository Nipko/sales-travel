import { describe, expect, it } from 'vitest';
import type { AttentionView, ProviderSignalsView } from './admin-overview.fold.js';
import type { PostSaleSweepView, SystemReconciliationView } from './admin-system.service.js';
import {
  foldCatalogsArea,
  foldDepositsArea,
  foldOrdersArea,
  foldPlatformStatus,
  foldProvidersArea,
  foldReconciliationArea,
  foldSweepArea,
  worst,
  type PlatformStatusInputs,
} from './platform-status.fold.js';
import type { ProviderHealth } from './provider-health.fold.js';

const NOW = new Date('2026-11-19T15:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function health(over: Partial<ProviderHealth>): ProviderHealth {
  return {
    providerCode: 'sabre',
    vertical: 'flights',
    status: 'ok',
    reason: '90% de las búsquedas traen resultados.',
    searches: 10,
    withResults: 9,
    empty: 1,
    errors: 0,
    recentSearches: 5,
    recentWithResults: 5,
    hitRate: 90,
    avgDurationMs: 1000,
    p95DurationMs: 2000,
    lastSearchAt: daysAgo(0),
    lastResultAt: daysAgo(0),
    lastErrorCode: null,
    ...over,
  };
}

const NO_SIGNALS: ProviderSignalsView = {
  killSwitched: [],
  openCircuits: [],
  disabledGlobally: [],
  tenantOverridesDisabled: 0,
};

const SWEEP_OK: PostSaleSweepView = {
  lastRunAt: daysAgo(0),
  lastOk: true,
  lastOkAt: daysAgo(0),
  durationMs: 100,
  tenantsFailed: 0,
  runs24h: 96,
  failures24h: 0,
  stale: false,
  everyMinutes: 15,
  staleAfterMinutes: 45,
};

const RECON_OK: SystemReconciliationView = {
  sinceDays: 7,
  byProvider: [
    {
      providerCode: 'despegar-hotels',
      runs: 3,
      failedRuns: 0,
      lastFinishedAt: daysAgo(0),
      lastStatus: 'completed',
      criticalItems: 0,
      warningItems: 0,
      stale: false,
    },
  ],
};

function attention(over: Partial<AttentionView> = {}): AttentionView {
  return {
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
    hotelOrdersUnverified: 0,
    walletHoldConflicts: 0,
    reconciliation: { critical: 0, warning: 0, sinceDays: 30 },
    reconciliationRuns: { sinceDays: 7, failedRuns: 0, byProvider: [] },
    invitations: { pending: 0, expired: 0, expiredSinceDays: 30 },
    seats: { saturated: [] },
    jobs: { postSaleSweepStale: false, lastOkAt: null },
    ...over,
  };
}

const ALL_OK: PlatformStatusInputs = {
  health: [health({})],
  signals: NO_SIGNALS,
  sweep: SWEEP_OK,
  reconciliation: RECON_OK,
  catalogs: [
    {
      providerCode: 'tbo-hotels',
      cities: 10,
      syncedLast48h: 10,
      failedCities: 0,
      lastSyncedAt: daysAgo(0),
      stale: false,
    },
  ],
  attention: attention(),
};

describe('Plataforma → Estado: el semáforo', () => {
  it('worst toma el peor nivel', () => {
    expect(worst([])).toBe('ok');
    expect(worst(['ok', 'warn'])).toBe('warn');
    expect(worst(['warn', 'critical', 'ok'])).toBe('critical');
  });

  it('todo bien: verde en cada área, con la versión y los pendientes', () => {
    const view = foldPlatformStatus(ALL_OK, {
      now: NOW,
      version: 'abc123',
      startedAt: new Date('2026-11-19T14:00:00Z'),
      pendings: [],
    });
    expect(view.overall).toBe('ok');
    expect(view.areas.map((a) => [a.id, a.level])).toEqual([
      ['providers', 'ok'],
      ['reconciliation', 'ok'],
      ['orders', 'ok'],
      ['post-sale-sweep', 'ok'],
      ['catalogs', 'ok'],
      ['deposits', 'ok'],
    ]);
    expect(view.runtime).toEqual({ version: 'abc123', startedAt: '2026-11-19T14:00:00.000Z' });
  });

  it('un proveedor caído es crítico y se nombra', () => {
    const area = foldProvidersArea(
      [health({}), health({ providerCode: 'tbo-hotels', vertical: 'hotels', status: 'down' })],
      NO_SIGNALS,
      NOW,
    );
    expect(area.level).toBe('critical');
    expect(area.summary).toContain('tbo-hotels (hotels)');
    expect(area.href).toBe('/admin/plataforma/salud');
  });

  it('un proveedor sin búsquedas recientes y sin resultados hace días es aviso; reciente, no', () => {
    const viejo = foldProvidersArea(
      [health({ status: 'idle', lastResultAt: daysAgo(6) })],
      NO_SIGNALS,
      NOW,
    );
    expect(viejo.level).toBe('warn');
    expect(viejo.details[0]).toContain('6 días');
    expect(
      foldProvidersArea([health({ status: 'idle', lastResultAt: daysAgo(1) })], NO_SIGNALS, NOW)
        .level,
    ).toBe('ok');
  });

  it('un apagado desde el panel o un circuito abierto son aviso', () => {
    const area = foldProvidersArea(
      [health({})],
      {
        ...NO_SIGNALS,
        killSwitched: [{ code: 'tbo-hotels', level: 'all' }],
        openCircuits: [{ code: 'sabre', state: 'open', failures: 5 }],
      },
      NOW,
    );
    expect(area.level).toBe('warn');
    expect(area.details).toHaveLength(2);
  });

  it('una conciliación cuya última corrida falló es crítica', () => {
    const area = foldReconciliationArea({
      sinceDays: 7,
      byProvider: [
        {
          providerCode: 'tbo-hotels',
          runs: 7,
          failedRuns: 7,
          lastFinishedAt: daysAgo(0),
          lastStatus: 'failed',
          criticalItems: 0,
          warningItems: 0,
          stale: false,
        },
      ],
    });
    expect(area.level).toBe('critical');
    expect(area.details[0]).toContain('tbo-hotels');
  });

  it('divergencias críticas sin corridas fallidas son aviso', () => {
    const area = foldReconciliationArea({
      sinceDays: 7,
      byProvider: [{ ...RECON_OK.byProvider[0]!, criticalItems: 2 }],
    });
    expect(area.level).toBe('warn');
  });

  it('plata trabada o una cancelación fallida es crítico; otra espera, aviso', () => {
    const base = attention();
    const urgent = foldOrdersArea(
      attention({
        orders: {
          ...base.orders,
          total: 1,
          byReason: { ...base.orders.byReason, 'hold-orphan': 1 },
        },
      }),
    );
    expect(urgent.level).toBe('critical');
    const review = foldOrdersArea(
      attention({
        orders: { ...base.orders, total: 2, byReason: { ...base.orders.byReason, review: 2 } },
      }),
    );
    expect(review.level).toBe('warn');
    expect(review.summary).toBe('2 reservas esperan a una persona.');
  });

  it('el barrido atrasado es crítico; con fallas sueltas, aviso', () => {
    expect(foldSweepArea({ ...SWEEP_OK, stale: true }).level).toBe('critical');
    expect(foldSweepArea({ ...SWEEP_OK, failures24h: 2 }).level).toBe('warn');
  });

  it('un catálogo atrasado o con ciudades fallidas es aviso', () => {
    const area = foldCatalogsArea([{ ...ALL_OK.catalogs[0]!, stale: true, failedCities: 3 }]);
    expect(area.level).toBe('warn');
    expect(area.summary).toBe('1 catálogo atrasado o con errores.');
  });

  it('depósitos que esperan a la plataforma son aviso; los de la red, sólo detalle', () => {
    expect(
      foldDepositsArea(attention({ depositReports: { total: 1, platform: 0, network: 1 } })).level,
    ).toBe('ok');
    expect(
      foldDepositsArea(attention({ depositReports: { total: 1, platform: 1, network: 0 } })).level,
    ).toBe('warn');
  });
});
