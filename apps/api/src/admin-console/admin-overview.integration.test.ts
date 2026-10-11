import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  PlatformConsoleScopeNotFoundError,
  PlatformConsoleSuperadminOnlyError,
} from './admin-console.errors.js';
import { AdminOverviewQuerySchema } from './admin-overview.schemas.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { addDays, todayIn } from './admin-overview.schemas.js';

/**
 * Plataforma → Resumen contra la base, como `app_user` (el rol de producción, sujeto a la RLS): las
 * funciones de 0075 leen la red entera sólo para el superadmin y sólo devuelven agregados.
 *
 * La red: Planetour → consolidador C → agencia A → sub-agencia S (suspendida); Planetour → agencia
 * directa D (la financia Planetour). La base es compartida con otros tests, así que lo exacto se mira
 * acotado al subárbol de C o de D; toda la red, sólo con "al menos".
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const BOGOTA = 'America/Bogota';

d('Resumen de la plataforma (funciones de 0075 como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  /** SUPERUSUARIO: sólo para montar la red y desmontarla. */
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

  const breaker = {
    snapshot: () => ({
      [`prov-abierto-${sfx}`]: { state: 'open' as const, failures: 5 },
      [`prov-sano-${sfx}`]: { state: 'closed' as const, failures: 0 },
    }),
  };
  const service = new AdminOverviewService(database, breaker as unknown as CircuitBreakerService);

  const tenants: string[] = [];
  const users: string[] = [];
  const orders: string[] = [];
  let seq = 0;

  async function tenant(
    slug: string,
    type: string,
    parent: string,
    extra: { isBranch?: boolean; status?: string } = {},
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id, is_branch, status)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3, $4, $5) RETURNING id`,
      [`ov-${slug}-${sfx}`, type, parent, extra.isBranch ?? false, extra.status ?? 'active'],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(
    label: string,
    tenantId: string,
    role: string,
    extra: { status?: string; mfa?: boolean; locked?: boolean; loggedIn?: boolean } = {},
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, status, mfa_secret, mfa_enabled_at, locked_until, last_login_at)
       VALUES ($1, $2, $3,
               CASE WHEN $4 THEN 'cifrado' END,
               CASE WHEN $4 THEN now() END,
               CASE WHEN $5 THEN now() + interval '10 minutes' END,
               CASE WHEN $6 THEN now() - interval '1 day' END)
       RETURNING id`,
      [
        `ov-${label}-${sfx}@test.local`,
        `Usuario ${label}`,
        extra.status ?? 'active',
        extra.mfa ?? false,
        extra.locked ?? false,
        extra.loggedIn ?? false,
      ],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  async function order(
    tenantId: string,
    userId: string,
    o: {
      status: string;
      amount: number;
      currency?: string;
      provider?: string;
      vertical?: string;
      ago?: string;
    },
  ): Promise<string> {
    seq += 1;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, currency, order_number, status, created_at)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $5, $6, $7, $8,
               now() - $9::interval)
       RETURNING id`,
      [
        tenantId,
        userId,
        o.provider ?? 'latam-ndc',
        JSON.stringify(o.vertical === undefined ? {} : { vertical: o.vertical }),
        o.amount,
        o.currency ?? 'COP',
        900_000 + seq,
        o.status,
        o.ago ?? '2 days',
      ],
    );
    orders.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function operation(
    tenantId: string,
    orderId: string,
    type: string,
    status: string,
    ago: string,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO order_operations (tenant_id, order_id, type, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now() - $5::interval, now() - $5::interval)`,
      [tenantId, orderId, type, status, ago],
    );
  }

  async function wallet(tenantId: string, credit: number, balance: number): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
       VALUES ($1, 'COP', $2, $3) RETURNING id`,
      [tenantId, credit, balance],
    );
    return rows[0]!.id;
  }

  async function depositReport(tenantId: string, portfolioId: string, by: string): Promise<void> {
    await admin.query(
      `INSERT INTO portfolio_deposit_reports (tenant_id, portfolio_id, currency, amount_minor, reference, reported_by)
       VALUES ($1, $2, 'COP', 10000, $3, $4)`,
      [tenantId, portfolioId, `ref-${sfx}-${randomBytes(2).toString('hex')}`, by],
    );
  }

  async function invitation(
    tenantId: string,
    state: { expires: string; accepted?: boolean; revoked?: boolean },
  ): Promise<void> {
    await admin.query(
      `INSERT INTO user_invitations (tenant_id, email, role, token_hash, expires_at, accepted_at, revoked_at)
       VALUES ($1, $2, 'vendedor', $3, now() + $4::interval,
               CASE WHEN $5 THEN now() END, CASE WHEN $6 THEN now() END)`,
      [
        tenantId,
        `ov-inv-${randomBytes(3).toString('hex')}-${sfx}@test.local`,
        randomBytes(16).toString('hex'),
        state.expires,
        state.accepted ?? false,
        state.revoked ?? false,
      ],
    );
  }

  /** La query como la deja el pipe: la última semana de Bogotá, acotada a un nodo si se pide. */
  const today = todayIn(BOGOTA, new Date());
  const q = (tenantId?: string) =>
    AdminOverviewQuerySchema.parse({
      from: addDays(today, -6),
      to: today,
      ...(tenantId === undefined ? {} : { tenantId }),
    });

  let platform: string;
  let consolidator: string;
  let agency: string;
  let sub: string;
  let direct: string;
  let branch: string;

  let superadmin: string;
  let platformAdmin: string;
  let consolidatorAdmin: string;
  let agencyAdmin: string;
  let seller: string;

  let monthRecent: string;
  let monthOld: string;
  const savedKillSwitch = process.env['PROVIDERS_DISABLED'];

  beforeAll(async () => {
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    sub = await tenant('s', 'subagency', agency, { status: 'suspended' });
    direct = await tenant('d', 'agency', platform);
    branch = await tenant('b', 'agency', platform, { isBranch: true });

    superadmin = await user('sa', platform, 'superadmin', { mfa: true });
    platformAdmin = await user('pa', platform, 'platform_admin', { mfa: true });
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin', { mfa: true });
    agencyAdmin = await user('aa', agency, 'tenant_admin', { loggedIn: true });
    seller = await user('ve', agency, 'vendedor', { locked: true });
    await user('su', agency, 'vendedor', { status: 'suspended' });
    const directAdmin = await user('da', direct, 'tenant_admin');

    // Ventas del período en el subárbol de C.
    const o1 = await order(agency, seller, { status: 'confirmed', amount: 100_000 });
    const o2 = await order(agency, seller, { status: 'confirmed', amount: 200_000 });
    const o3 = await order(agency, seller, { status: 'ticketed', amount: 50_000, currency: 'USD' });
    await order(agency, seller, {
      status: 'cancelled',
      amount: 30_000,
      provider: 'tbo-hotels',
      vertical: 'hotels',
    });
    const o5 = await order(agency, seller, { status: 'failed', amount: 10_000 });
    await order(agency, seller, { status: 'pending', amount: 5_000 });
    const hotel = await order(sub, seller, {
      status: 'confirmed',
      amount: 70_000,
      provider: 'tbo-hotels',
      vertical: 'hotels',
    });
    const hotelPending = await order(sub, seller, {
      status: 'pending',
      amount: 1_000,
      provider: 'tbo-hotels',
      vertical: 'hotels',
    });
    // Fuera del período (pero dentro de la tendencia) y fuera del subárbol.
    await order(agency, seller, { status: 'confirmed', amount: 999, ago: '60 days' });
    const directOrder = await order(direct, directAdmin, { status: 'confirmed', amount: 123_456 });

    const { rows: months } = await admin.query<{ recent: string; old: string }>(
      `SELECT to_char((now() - interval '2 days') AT TIME ZONE $1, 'YYYY-MM') AS recent,
              to_char((now() - interval '60 days') AT TIME ZONE $1, 'YYYY-MM') AS old`,
      [BOGOTA],
    );
    monthRecent = months[0]!.recent;
    monthOld = months[0]!.old;

    // Cotizaciones del período.
    for (const [tenantId, status] of [
      [agency, 'sent'],
      [agency, 'accepted'],
      [direct, 'sent'],
    ] as const) {
      seq += 1;
      await admin.query(
        `INSERT INTO quotations (tenant_id, user_id, search_criteria, selected_offer, quote_number, expires_at, status)
         VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, $3, now() + interval '7 days', $4)`,
        [tenantId, seller, 900_000 + seq, status],
      );
    }

    // Sesiones: una viva, una revocada, una vencida.
    await admin.query(
      `INSERT INTO sessions (user_id, tenant_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [agencyAdmin, agency],
    );
    await admin.query(
      `INSERT INTO sessions (user_id, tenant_id, expires_at, revoked_at, revoked_reason)
       VALUES ($1, $2, now() + interval '1 hour', now(), 'logout')`,
      [seller, agency],
    );
    await admin.query(
      `INSERT INTO sessions (user_id, tenant_id, expires_at, issued_at, last_seen_at)
       VALUES ($1, $2, now() - interval '1 minute', now() - interval '2 hours', now() - interval '2 hours')`,
      [consolidatorAdmin, consolidator],
    );

    // Carteras: C la financia Planetour; A, el consolidador; D, Planetour.
    await wallet(consolidator, 1_000_000, 5_000);
    const agencyWallet = await wallet(agency, 500_000, -120_000);
    const directWallet = await wallet(direct, 0, 0);
    await depositReport(agency, agencyWallet, agencyAdmin);
    await depositReport(direct, directWallet, directAdmin);

    // Post-venta: o1 con la cancelación fallida; o2 falló y después salió; o3 con una lectura en
    // vuelo hace una hora; o5 con un pago recién empezado.
    await operation(agency, o1, 'cancel', 'failed', '3 hours');
    await operation(agency, o2, 'cancel', 'failed', '3 hours');
    await operation(agency, o2, 'cancel', 'success', '2 hours');
    await operation(agency, o3, 'retrieve', 'pending', '1 hour');
    await operation(agency, o5, 'pay', 'pending', '1 minute');

    // Hoteles: uno con un estado que no conocemos; otro en vuelo, que no cuenta.
    await admin.query(
      `INSERT INTO hotel_order_tracking (order_id, tenant_id, provider_status, provider_status_at, provider_status_source, sub_status)
       VALUES ($1, $2, 'Raro', now(), 'retrieve', 'unknown'),
              ($3, $2, NULL, NULL, NULL, 'create-pending')`,
      [hotel, sub, hotelPending],
    );

    // Retenciones en conflicto: una en el subárbol de C, otra en D.
    for (const [orderId, origin, by] of [
      [o1, agency, seller],
      [directOrder, direct, directAdmin],
    ] as const) {
      await admin.query(
        `INSERT INTO wallet_hold_groups (order_id, origin_tenant_id, currency, sale_amount_minor,
                                         provider_code, credential_source, mode, status, created_by)
         VALUES ($1, $2, 'COP', 1000, 'latam-ndc', 'legacy', 'legacy', 'conflict', $3)`,
        [orderId, origin, by],
      );
    }

    // Conciliación de una cuenta de C.
    const { rows: account } = await admin.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, status)
       VALUES ($1, 'tbo-hotels', $2, '\\x00'::bytea, 'active') RETURNING id`,
      [consolidator, `ov-${sfx}`],
    );
    const { rows: run } = await admin.query<{ id: string }>(
      `INSERT INTO provider_reconciliation_runs (tenant_id, account_id, provider_code, trigger, status, finished_at)
       VALUES ($1, $2, 'tbo-hotels', 'forced', 'completed', now()) RETURNING id`,
      [consolidator, account[0]!.id],
    );
    for (const [severity, action, ago, n] of [
      ['critical', 'review', '1 hour', 1],
      ['warning', 'reported', '1 hour', 2],
      ['info', 'recorded', '1 hour', 3],
      ['critical', 'review', '40 days', 4],
    ] as const) {
      await admin.query(
        `INSERT INTO provider_reconciliation_items (tenant_id, run_id, account_id, provider_code, kind,
                                                    severity, action, provider_booking_id, dedupe_key, created_at)
         VALUES ($1, $2, $3, 'tbo-hotels', 'R2', $4, $5, $6, $7, now() - $8::interval)`,
        [
          consolidator,
          run[0]!.id,
          account[0]!.id,
          severity,
          action,
          `BK-${n}`,
          `R2|${sfx}|${n}`,
          ago,
        ],
      );
    }

    // Invitaciones de A: pendiente, vencida hace poco, vencida hace mucho, aceptada y revocada.
    await invitation(agency, { expires: '3 days' });
    await invitation(agency, { expires: '-5 days' });
    await invitation(agency, { expires: '-40 days' });
    await invitation(agency, { expires: '3 days', accepted: true });
    await invitation(agency, { expires: '3 days', revoked: true });

    process.env['PROVIDERS_DISABLED'] = `prov-apagado-${sfx}:ventas`;
  });

  afterAll(async () => {
    if (savedKillSwitch === undefined) delete process.env['PROVIDERS_DISABLED'];
    else process.env['PROVIDERS_DISABLED'] = savedKillSwitch;
    // Las retenciones frenan el borrado de su orden (RESTRICT): primero ellas.
    await admin.query('DELETE FROM wallet_hold_groups WHERE order_id = ANY($1::uuid[])', [orders]);
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  it('las ventas del subárbol de C, por moneda, vertical y proveedor, sin lo de fuera ni lo viejo', async () => {
    const view = await service.overview(superadmin, q(consolidator));

    expect(view.scope).toMatchObject({ tenantId: consolidator, tenantType: 'consolidator' });
    expect(view.timeZone).toBe(BOGOTA);
    expect(view.period).toEqual({ from: addDays(today, -6), to: today });

    expect(view.sales.byCurrency).toEqual([
      {
        currency: 'COP',
        exponent: 2,
        confirmedCount: 3,
        confirmedAmountMinor: 370_000,
        cancelledCount: 1,
        cancelledAmountMinor: 30_000,
        failedCount: 1,
        pendingCount: 2,
        averageTicketMinor: 123_333,
      },
      {
        currency: 'USD',
        exponent: 2,
        confirmedCount: 1,
        confirmedAmountMinor: 50_000,
        cancelledCount: 0,
        cancelledAmountMinor: 0,
        failedCount: 0,
        pendingCount: 0,
        averageTicketMinor: 50_000,
      },
    ]);
    expect(view.sales.byVertical).toEqual([
      { vertical: 'flights', currency: 'COP', exponent: 2, count: 2, amountMinor: 300_000 },
      { vertical: 'flights', currency: 'USD', exponent: 2, count: 1, amountMinor: 50_000 },
      { vertical: 'hotels', currency: 'COP', exponent: 2, count: 1, amountMinor: 70_000 },
    ]);
    expect(view.sales.byProvider.map((p) => [p.provider, p.currency, p.confirmedCount])).toEqual([
      ['latam-ndc', 'COP', 2],
      ['latam-ndc', 'USD', 1],
      ['tbo-hotels', 'COP', 1],
    ]);
    expect(view.sales.quotations).toMatchObject({ created: 2, accepted: 1 });
  });

  it('la tendencia, el ranking de nodos y lo de otro subárbol', async () => {
    const view = await service.overview(superadmin, q(consolidator));

    expect(view.trend.months).toHaveLength(12);
    expect(view.trend.months.at(-1)).toBe(today.slice(0, 7));
    const cop = view.trend.series.find((s) => s.currency === 'COP');
    const point = (month: string) => cop?.points.find((p) => p.month === month);
    expect(point(monthOld)).toMatchObject({ amountMinor: 999 });
    if (monthRecent !== monthOld) {
      expect(point(monthRecent)).toMatchObject({ count: 3, amountMinor: 370_000 });
    }

    expect(view.topNodes.map((n) => [n.tenantId, n.confirmedCount])).toEqual([
      [agency, 3],
      [sub, 1],
    ]);
    expect(view.topNodes[0]?.amounts).toEqual([
      { currency: 'COP', exponent: 2, amountMinor: 300_000 },
      { currency: 'USD', exponent: 2, amountMinor: 50_000 },
    ]);

    const other = await service.overview(superadmin, q(direct));
    expect(other.sales.byCurrency).toEqual([
      expect.objectContaining({
        currency: 'COP',
        confirmedCount: 1,
        confirmedAmountMinor: 123_456,
      }),
    ]);
    expect(other.topNodes.map((n) => n.tenantId)).toEqual([direct]);
  });

  it('la red: nodos, personas y sesiones del subárbol', async () => {
    const view = await service.overview(superadmin, q(consolidator));

    expect(view.network).toEqual({
      nodes: {
        total: 3,
        active: 2,
        suspended: 1,
        archived: 0,
        consolidators: 1,
        agencies: 1,
        branches: 0,
        subagencies: 1,
        created: 3,
      },
      users: { active: 3, suspended: 1, locked: 1, adminsWithoutMfa: 1, loggedInPeriod: 1 },
      liveSessions: 1,
    });

    const branchView = await service.overview(superadmin, q(branch));
    expect(branchView.network.nodes).toMatchObject({ total: 1, branches: 1, agencies: 0 });
  });

  it('las carteras por moneda, con lo que financia Planetour aparte', async () => {
    const view = await service.overview(superadmin, q(consolidator));
    expect(view.wallets).toEqual([
      {
        currency: 'COP',
        exponent: 2,
        wallets: 2,
        creditLimitMinor: 1_500_000,
        debtMinor: 120_000,
        fundsMinor: 5_000,
        overlimit: 0,
        suspended: 0,
        platformCreditLimitMinor: 1_000_000,
        platformDebtMinor: 0,
      },
    ]);
  });

  it('lo que espera a una persona, acotado al subárbol', async () => {
    const view = await service.overview(superadmin, q(consolidator));
    expect(view.attention).toEqual({
      depositReports: { total: 1, platform: 0, network: 1 },
      postSale: {
        failed: 1,
        stuck: 1,
        byType: [
          { type: 'cancel', failed: 1, stuck: 0 },
          { type: 'retrieve', failed: 0, stuck: 1 },
        ],
      },
      hotelOrdersUnverified: 1,
      walletHoldConflicts: 1,
      reconciliation: { critical: 1, warning: 1, sinceDays: 30 },
      invitations: { pending: 1, expired: 1, expiredSinceDays: 30 },
    });

    const other = await service.overview(superadmin, q(direct));
    expect(other.attention.depositReports).toEqual({ total: 1, platform: 1, network: 0 });
    expect(other.attention.walletHoldConflicts).toBe(1);
    expect(other.attention.postSale).toEqual({ failed: 0, stuck: 0, byType: [] });
  });

  it('las señales de los proveedores: kill-switch del entorno y circuitos abiertos', async () => {
    const view = await service.overview(superadmin, q(consolidator));
    expect(view.providers.killSwitched).toEqual([{ code: `prov-apagado-${sfx}`, level: 'sales' }]);
    expect(view.providers.openCircuits).toEqual([
      { code: `prov-abierto-${sfx}`, state: 'open', failures: 5 },
    ]);
    expect(Array.isArray(view.providers.disabledGlobally)).toBe(true);
    expect(view.providers.tenantOverridesDisabled).toBeGreaterThanOrEqual(0);
  });

  it('sin nodo, toda la red: incluye las dos ramas', async () => {
    const view = await service.overview(superadmin, q());
    expect(view.scope).toBeNull();
    const cop = view.sales.byCurrency.find((c) => c.currency === 'COP');
    expect(cop?.confirmedCount).toBeGreaterThanOrEqual(4);
    expect(cop?.confirmedAmountMinor).toBeGreaterThanOrEqual(370_000 + 123_456);
    expect(view.attention.depositReports.platform).toBeGreaterThanOrEqual(1);
    expect(view.attention.depositReports.network).toBeGreaterThanOrEqual(1);
  });

  it('un nodo que no existe es un 404', async () => {
    await expect(
      service.overview(superadmin, q('00000000-0000-4000-8000-000000000000')),
    ).rejects.toBeInstanceOf(PlatformConsoleScopeNotFoundError);
  });

  it.each([
    ['un consolidator_admin', () => consolidatorAdmin],
    ['un platform_admin (retirado)', () => platformAdmin],
  ])('%s no lee la red: la base lo rechaza y la API responde 403', async (_quien, actor) => {
    await expect(service.overview(actor(), q(consolidator))).rejects.toBeInstanceOf(
      PlatformConsoleSuperadminOnlyError,
    );
  });

  it('sin usuario en el request, cada lectura cruzada falla con 42501', async () => {
    for (const call of [
      `SELECT * FROM platform_overview_orders(NULL, now() - interval '1 day', now())`,
      `SELECT * FROM platform_overview_trend(NULL, now() - interval '1 day', now(), 'UTC')`,
      `SELECT * FROM platform_overview_top_nodes(NULL, now() - interval '1 day', now(), 10)`,
      `SELECT * FROM platform_overview_quotations(NULL, now() - interval '1 day', now())`,
      `SELECT * FROM platform_overview_network(NULL, now() - interval '1 day', now())`,
      `SELECT * FROM platform_overview_wallets(NULL)`,
      `SELECT * FROM platform_overview_post_sale(NULL, now())`,
      `SELECT * FROM platform_overview_attention(NULL, now())`,
    ]) {
      await expect(appPool.query(call), call).rejects.toMatchObject({
        code: '42501',
        message: 'platform_console_superadmin_required',
      });
    }
    const { rows } = await appPool.query<{ ok: boolean }>(
      'SELECT platform_console_is_superadmin() AS ok',
    );
    expect(rows[0]?.ok).toBe(false);
  });

  it('el superadmin con un período al revés: 22023 de la base', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [superadmin]);
      await expect(
        client.query(
          `SELECT * FROM platform_overview_orders(NULL, now(), now() - interval '1 day')`,
        ),
      ).rejects.toMatchObject({ code: '22023', message: 'platform_console_period_invalid' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('los helpers no se exponen a app_user', async () => {
    for (const call of [
      'SELECT * FROM platform_console_scope(NULL)',
      'SELECT platform_console_require_superadmin()',
    ]) {
      await expect(appPool.query(call), call).rejects.toMatchObject({ code: '42501' });
    }
  });
});
