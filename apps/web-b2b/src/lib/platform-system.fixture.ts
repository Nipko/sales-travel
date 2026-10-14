/**
 * Una respuesta de `GET /admin/system/jobs` con la forma que arma el API (admin-system.service.ts),
 * para las pruebas de la lectura y de la pantalla. Por omisión todo corre.
 */

type Payload = Record<string, unknown>;

/** El barrido corrió 5 minutos antes de `generatedAt`, sin errores. */
export function runningSweep(overrides: Payload = {}): Payload {
  return {
    lastRunAt: '2026-10-13T11:55:00.000Z',
    lastOk: true,
    lastOkAt: '2026-10-13T11:55:00.000Z',
    durationMs: 8_400,
    tenantsFailed: 0,
    runs24h: 96,
    failures24h: 0,
    stale: false,
    everyMinutes: 15,
    staleAfterMinutes: 45,
    ...overrides,
  };
}

export function systemJobsPayload(overrides: Payload = {}): Payload {
  return {
    generatedAt: '2026-10-13T12:00:00.000Z',
    postSaleSweep: runningSweep(),
    reconciliation: {
      sinceDays: 7,
      byProvider: [
        {
          providerCode: 'tbo-hotels',
          runs: 7,
          failedRuns: 1,
          lastFinishedAt: '2026-10-13T04:31:00.000Z',
          lastStatus: 'completed',
          criticalItems: 2,
          warningItems: 1,
          stale: false,
        },
      ],
    },
    catalogs: [
      {
        providerCode: 'tbo-hotels',
        cities: 1200,
        syncedLast48h: 1180,
        failedCities: 3,
        lastSyncedAt: '2026-10-13T09:17:00.000Z',
        stale: false,
      },
    ],
    airports: { count: 8214 },
    schedules: [
      {
        id: 'post-sale-sweep',
        label: 'Barrido de post-venta',
        runner: 'api',
        workflow: null,
        cron: null,
        schedule: 'Cada 15 minutos, dentro del api.',
      },
      {
        id: 'sync-tbo-hotel-inventory',
        label: 'Catálogo de hoteles de TBO',
        runner: 'github',
        workflow: 'sync-tbo-hotel-inventory.yml',
        cron: '17 6-9 * * *',
        schedule: 'Cada hora de 06:17 a 09:17 UTC (01:17 a 04:17 en Bogotá).',
      },
    ],
    ...overrides,
  };
}
