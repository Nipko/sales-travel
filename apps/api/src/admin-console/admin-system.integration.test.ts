import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { HcnTrackingService } from '../hotels/hcn-tracking.service.js';
import type { HotelBookingVerificationService } from '../hotels/hotel-booking-verification.service.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import type { HotelOrderCancellationService } from '../orders/hotel-order-cancellation.service.js';
import { POST_SALE_SWEEP_EVENTS } from '../orders/post-sale-sweep-events.js';
import { PostSaleSweeper } from '../orders/post-sale-sweeper.js';
import type { StaleCancelClaimService } from '../orders/stale-cancel-claim.service.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import type { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { AdminSystemService, readPostSaleSweep } from './admin-system.service.js';

/**
 * Sistema › Procesos contra la base, como `app_user` (el rol de producción, sujeto a la RLS): el
 * barrido de post-venta deja su rastro en la raíz `platform` y sólo el superadmin lo lee; la
 * conciliación por proveedor sale de admin_reconciliation_health (0075) y los catálogos de
 * hotel_provider_city.
 *
 * La base es compartida con otros tests: lo exacto se mira con códigos de proveedor propios y con lo
 * emitido después de que arrancó este archivo.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const ZERO_HOTELS = {
  examined: 0,
  adopted: 0,
  failed: 0,
  consolidated: 0,
  advanced: 0,
  'not-found': 0,
  held: 0,
  unavailable: 0,
  skipped: 0,
};

d('Sistema › Procesos (rastro del barrido y lecturas de 0075 como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  /** SUPERUSUARIO: sólo para montar y desmontar. */
  const admin = new pg.Pool();
  const appPool = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });
  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: appPool }) });
  const audit = new AuditService(database);
  const service = new AdminSystemService(database);

  /** El barrido de verdad, con cada barrido por tenant en cero: lo que importa es su rastro. */
  const sweeper = new PostSaleSweeper(
    database,
    new RecordingQueueService().asService(),
    {
      sweepTenant: () => Promise.resolve({ ...ZERO_HOTELS }),
    } as unknown as HotelBookingVerificationService,
    new InflightWorkRegistry(),
    {
      sweepTenant: () =>
        Promise.resolve({
          examined: 0,
          failed: 0,
          closed: 0,
          advanced: 0,
          stuck: 0,
          settled: 0,
          held: 0,
          unavailable: 0,
          skipped: 0,
        }),
    } as unknown as HotelOrderCancellationService,
    {
      sweepTenant: () =>
        Promise.resolve({
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
        }),
    } as unknown as HcnTrackingService,
    {
      sweepTenant: () => Promise.resolve({ accounts: 0, queued: 0, ran: 0, failed: 0 }),
    } as unknown as ReconciliationService,
    {
      sweepTenant: () => Promise.resolve({ examined: 0, expired: 0, skipped: 0, failed: 0 }),
    } as unknown as StaleCancelClaimService,
    audit,
  );

  const tenants: string[] = [];
  const users: string[] = [];
  let startedAt: Date;
  let platform: string;
  let consolidator: string;
  let superadmin: string;
  let consolidatorAdmin: string;

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`sys-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`sys-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    const { rows } = await admin.query<{ now: Date }>('SELECT now() AS now');
    startedAt = rows[0]!.now;
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    superadmin = await user('sa', platform, 'superadmin');
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin');

    // Conciliación de un proveedor propio: una corrida correcta hace 2 h y otra fallida ayer, de
    // una cuenta del consolidador.
    const { rows: account } = await admin.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, status)
       VALUES ($1, 'tbo-hotels', $2, '\\x00'::bytea, 'active') RETURNING id`,
      [consolidator, `sys-${sfx}`],
    );
    for (const [status, ago] of [
      ['failed', '1 day'],
      ['completed', '2 hours'],
    ] as const) {
      await admin.query(
        `INSERT INTO provider_reconciliation_runs (tenant_id, account_id, provider_code, trigger, status,
                                                   started_at, finished_at)
         VALUES ($1, $2, $3, 'scheduled', $4, now() - $5::interval,
                 now() - $5::interval + interval '1 minute')`,
        [consolidator, account[0]!.id, `rec-sys-${sfx}`, status, ago],
      );
    }
    // Un catálogo propio: una ciudad hace 2 h, otra hace 3 días con error.
    await admin.query(
      `INSERT INTO hotel_provider_city (provider_code, provider_city_code, country_code, name, name_norm,
                                        synced_at, last_status_code)
       VALUES ($1, 'c1', 'CO', 'Uno', 'uno', now() - interval '2 hours', 200),
              ($1, 'c2', 'CO', 'Dos', 'dos', now() - interval '3 days', 503)`,
      [`cat-sys-${sfx}`],
    );
  });

  afterAll(async () => {
    await admin.query(
      `DELETE FROM domain_events WHERE event_type = ANY($1::text[]) AND occurred_at >= $2`,
      [Object.values(POST_SALE_SWEEP_EVENTS), startedAt],
    );
    await admin.query('DELETE FROM hotel_provider_city WHERE provider_code = $1', [
      `cat-sys-${sfx}`,
    ]);
    for (const id of [...tenants].reverse()) {
      await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  it('una corrida del barrido deja su rastro en la raíz platform, sin actor y sólo con conteos', async () => {
    const report = await sweeper.run();

    const { rows } = await admin.query<{
      tenant_id: string | null;
      actor_user_id: string | null;
      aggregate_type: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT tenant_id, actor_user_id, aggregate_type, payload FROM domain_events
        WHERE event_type = $1 AND occurred_at >= $2
        ORDER BY occurred_at DESC LIMIT 1`,
      [POST_SALE_SWEEP_EVENTS.completed, startedAt],
    );
    expect(rows[0]).toMatchObject({
      tenant_id: platform,
      actor_user_id: null,
      aggregate_type: 'system_job',
    });
    expect(rows[0]!.payload).toMatchObject({
      tenants: report.tenants,
      tenantsFailed: 0,
      examined: 0,
      adopted: 0,
      reconciliation: { accounts: 0, queued: 0, ran: 0, failed: 0 },
    });
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(
      [
        'adopted',
        'cancellations',
        'durationMs',
        'examined',
        'hcn',
        'reconciliation',
        'staleCancelClaims',
        'tenants',
        'tenantsFailed',
      ].sort(),
    );
  });

  it('el superadmin lo lee con la RLS de siempre: el barrido corre', async () => {
    const view = await service.jobs(superadmin);
    const sweep = view.postSaleSweep;
    expect(sweep.lastOkAt).not.toBeNull();
    expect(Date.parse(sweep.lastOkAt!)).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(sweep).toMatchObject({ lastOk: true, stale: false, tenantsFailed: 0 });
    expect(sweep.durationMs).toEqual(expect.any(Number));
    expect(sweep.runs24h).toBeGreaterThanOrEqual(1);
  });

  it('una corrida que se cae entera: la última dice que falló, el atraso se mide desde la correcta', async () => {
    await audit.emit({
      eventType: POST_SALE_SWEEP_EVENTS.failed,
      tenantId: platform,
      actorUserId: null,
      payload: { errorClass: 'Error' },
    });
    const { postSaleSweep } = await service.jobs(superadmin);
    expect(postSaleSweep).toMatchObject({ lastOk: false, stale: false });
    expect(postSaleSweep.failures24h).toBeGreaterThanOrEqual(1);
    expect(Date.parse(postSaleSweep.lastRunAt!)).toBeGreaterThanOrEqual(
      Date.parse(postSaleSweep.lastOkAt!),
    );
  });

  it('nadie de la red ve el rastro: un consolidator_admin no lee los eventos de la raíz', async () => {
    const asConsolidator = await database.withRequestContext({ userId: consolidatorAdmin }, (trx) =>
      readPostSaleSweep(trx, new Date()),
    );
    expect(asConsolidator).toMatchObject({ lastRunAt: null, lastOkAt: null, runs24h: 0 });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [consolidatorAdmin]);
      const { rows } = await client.query(
        `SELECT 1 FROM domain_events WHERE event_type = ANY($1::text[])`,
        [Object.values(POST_SALE_SWEEP_EVENTS)],
      );
      expect(rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('y la consola entera es sólo del superadmin: la base lo rechaza con 42501 → 403', async () => {
    await expect(service.jobs(consolidatorAdmin)).rejects.toBeInstanceOf(SuperadminRequiredError);
  });

  it('la actividad de la red no se llena de latidos del barrido', async () => {
    const events = await requestContextStorage.run({ userId: superadmin }, () =>
      audit.networkAudit(platform, 200),
    );
    expect(events.filter((e) => e.eventType.startsWith('system.'))).toEqual([]);
  });

  it('la conciliación por proveedor, los catálogos y los aeropuertos', async () => {
    const view = await service.jobs(superadmin);
    expect(view.reconciliation.sinceDays).toBe(7);
    expect(
      view.reconciliation.byProvider.find((p) => p.providerCode === `rec-sys-${sfx}`),
    ).toMatchObject({ runs: 2, failedRuns: 1, lastStatus: 'completed', stale: false });
    expect(view.catalogs.find((c) => c.providerCode === `cat-sys-${sfx}`)).toMatchObject({
      cities: 2,
      syncedLast48h: 1,
      failedCities: 1,
      stale: false,
    });
    const { rows } = await admin.query<{ n: string }>('SELECT count(*) AS n FROM airports');
    expect(view.airports.count).toBe(Number(rows[0]!.n));
    expect(view.schedules.map((s) => s.id)).toContain('sync-tbo-hotel-inventory');
  });
});
