import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NETWORK,
  cascadeProvider,
  cascadeVertical,
  saleOf,
} from './__fixtures__/network-hold-cases.js';
import {
  seedNetwork,
  seedOrder,
  seedWallet,
  teardownNetwork,
  type SeededNetwork,
} from './__fixtures__/wallet-hold-seed.js';

/**
 * El orden de bloqueo de 0060 con transacciones de verdad concurrentes: dos retenciones de
 * hermanas sobre el cupo del mismo consolidador, una retención contra move_tenant_subtree y una
 * retención contra la aprobación de un depósito. Ninguna termina en deadlock (40P01): una espera a
 * la otra y decide con lo que ésta dejó.
 *
 * Necesita un PostgreSQL real (sesiones separadas): corre donde corren los demás tests de
 * integración (en CI, el job con el servicio postgres:16) y se salta sólo sin base o con el doble
 * de PGlite de las pruebas locales (PGHOST=pglite), que comparte una sola sesión. Condicionarla a
 * una variable aparte la dejaba saltada también en CI: verde por omisión.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const realPg = hasDb && process.env['PGHOST'] !== 'pglite';

interface PgFailure {
  readonly code?: string;
  readonly constraint?: string;
}

describe.runIf(realPg)('retención en cascada bajo concurrencia real (0060)', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool({ max: 4 });
  const app = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
    max: 4,
  });

  let net: SeededNetwork;
  const extraTenants: string[] = [];

  /** Una transacción abierta con los GUC del request, para cerrarla cuando el test decida. */
  async function begin(
    pool: pg.Pool,
    ctx: { tenantId?: string; userId?: string },
  ): Promise<pg.PoolClient> {
    const c = await pool.connect();
    await c.query('BEGIN');
    if (ctx.userId !== undefined) {
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.userId]);
    }
    if (ctx.tenantId !== undefined) {
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
    }
    return c;
  }

  async function end(c: pg.PoolClient, how: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    try {
      await c.query(how);
    } finally {
      c.release();
    }
  }

  const retainSql = 'SELECT * FROM wallet_hold_retain($1::uuid, $2::uuid)';

  function order(seller: 'S1' | 'S2' | 'A', currency: string): Promise<string> {
    return seedOrder(admin, {
      tenantId: net.ids[seller],
      userId: net.sellers[seller],
      provider: net.provider,
      totalMinor: saleOf(seller),
      currency,
      accountId: net.accounts.P,
      vertical: net.vertical,
      pricing: { netMinor: 100_000, currency },
    });
  }

  async function balance(tenantId: string, currency: string): Promise<number> {
    const { rows } = await admin.query<{ b: string }>(
      'SELECT balance_minor::text AS b FROM agency_portfolios WHERE tenant_id = $1 AND currency = $2',
      [tenantId, currency],
    );
    return Number(rows[0]!.b);
  }

  async function failFirst(p: Promise<unknown>): Promise<PgFailure | undefined> {
    try {
      await p;
      return undefined;
    } catch (err) {
      return err as PgFailure;
    }
  }

  beforeAll(async () => {
    net = await seedNetwork(admin, {
      sfx,
      vertical: cascadeVertical(),
      provider: cascadeProvider(sfx),
    });
    for (const node of NETWORK) {
      if (node.type === 'platform') continue;
      await seedWallet(admin, net.ids[node.key], { creditLimitMinor: 50_000_000 });
    }
  });

  afterAll(async () => {
    if (net !== undefined) await teardownNetwork(admin, net, extraTenants);
    await admin.end();
    await app.end();
  });

  it('S1 y S2 a la vez sobre el cupo de C: la segunda espera y decide con lo que dejó la primera', async () => {
    for (const k of ['S1', 'S2', 'A'] as const) {
      await seedWallet(admin, net.ids[k], { currency: 'DKK', creditLimitMinor: 50_000_000 });
    }
    await seedWallet(admin, net.ids.C, { currency: 'DKK', creditLimitMinor: 157_500 });
    const o1 = await order('S1', 'DKK');
    const o2 = await order('S2', 'DKK');

    const t1 = await begin(app, { tenantId: net.ids.S1 });
    await t1.query(retainSql, [o1, net.sellers.S1]);

    const t2 = await begin(app, { tenantId: net.ids.S2 });
    const second = failFirst(t2.query(retainSql, [o2, net.sellers.S2]));
    await sleep(300);
    await end(t1, 'COMMIT');

    const e = await second;
    await end(t2, 'ROLLBACK');
    expect(e).toMatchObject({ code: 'STW02', constraint: 'network_funds_unavailable' });
    expect(await balance(net.ids.C, 'DKK')).toBe(-105_000);

    await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [o1]);
    const c = await begin(app, { tenantId: net.ids.S1 });
    await c.query('SELECT wallet_hold_settle($1::uuid, $2::uuid)', [o1, net.sellers.S1]);
    await end(c, 'COMMIT');
  });

  it('A (nivel 3) y S1 (nivel 4) a la vez sobre el cupo de C: sin deadlock, la segunda decide con lo que dejó la primera', async () => {
    for (const k of ['S1', 'A'] as const) {
      await seedWallet(admin, net.ids[k], { currency: 'SEK', creditLimitMinor: 50_000_000 });
    }
    // El costo de C es 105.000 en las dos ventas: le alcanza para una y media.
    await seedWallet(admin, net.ids.C, { currency: 'SEK', creditLimitMinor: 157_500 });
    const oS1 = await order('S1', 'SEK');
    const oA = await order('A', 'SEK');

    // S1 bloquea S1 → A → C; la de A pide primero su propia cartera, que ya tiene S1.
    const t1 = await begin(app, { tenantId: net.ids.S1 });
    await t1.query(retainSql, [oS1, net.sellers.S1]);

    const t2 = await begin(app, { tenantId: net.ids.A });
    const second = failFirst(t2.query(retainSql, [oA, net.sellers.A]));
    await sleep(300);
    await end(t1, 'COMMIT');

    const e = await second;
    await end(t2, 'ROLLBACK');
    expect(e).toMatchObject({ code: 'STW02', constraint: 'network_funds_unavailable' });
    expect(await balance(net.ids.C, 'SEK')).toBe(-105_000);

    await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [oS1]);
    const c = await begin(app, { tenantId: net.ids.S1 });
    await c.query('SELECT wallet_hold_settle($1::uuid, $2::uuid)', [oS1, net.sellers.S1]);
    await end(c, 'COMMIT');
    expect(await balance(net.ids.C, 'SEK')).toBe(0);
  });

  it('una liberación y una retención de la misma cadena a la vez: la retención espera y usa el cupo devuelto', async () => {
    for (const k of ['S1', 'S2', 'A'] as const) {
      await seedWallet(admin, net.ids[k], { currency: 'NOK', creditLimitMinor: 50_000_000 });
    }
    await seedWallet(admin, net.ids.C, { currency: 'NOK', creditLimitMinor: 157_500 });
    const o1 = await order('S1', 'NOK');
    const o2 = await order('S2', 'NOK');

    const first = await begin(app, { tenantId: net.ids.S1 });
    await first.query(retainSql, [o1, net.sellers.S1]);
    await end(first, 'COMMIT');
    await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [o1]);

    // settle bloquea orden → grupo → carteras S1 → A → C; la retención de S2 espera en A.
    const t1 = await begin(app, { tenantId: net.ids.S1 });
    const { rows } = await t1.query<{ outcome: string }>(
      `SELECT wallet_hold_settle($1::uuid, $2::uuid, 'failed') AS outcome`,
      [o1, net.sellers.S1],
    );
    expect(rows[0]!.outcome).toBe('released');

    const t2 = await begin(app, { tenantId: net.ids.S2 });
    const held = t2.query(retainSql, [o2, net.sellers.S2]);
    await sleep(300);
    await end(t1, 'COMMIT');
    await held;
    await end(t2, 'COMMIT');
    expect(await balance(net.ids.C, 'NOK')).toBe(-105_000);

    await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [o2]);
    const c = await begin(app, { tenantId: net.ids.S2 });
    await c.query('SELECT wallet_hold_settle($1::uuid, $2::uuid)', [o2, net.sellers.S2]);
    await end(c, 'COMMIT');
  });

  it('una retención abierta frena a move_tenant_subtree, que la espera y termina en STH02', async () => {
    const o = await order('S1', 'USD');
    const t1 = await begin(app, { tenantId: net.ids.S1 });
    await t1.query(retainSql, [o, net.sellers.S1]);

    const t2 = await admin.connect();
    await t2.query('BEGIN');
    const move = failFirst(
      t2.query('SELECT move_tenant_subtree($1, $2)', [net.ids.S1, net.ids.A2]),
    );
    await sleep(300);
    await end(t1, 'COMMIT');

    const e = await move;
    await end(t2, 'ROLLBACK');
    expect(e).toMatchObject({ code: 'STH02', constraint: 'tenant_move_open_wallet_bookings' });

    await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [o]);
    const c = await begin(app, { tenantId: net.ids.S1 });
    await c.query('SELECT wallet_hold_settle($1::uuid, $2::uuid)', [o, net.sellers.S1]);
    await end(c, 'COMMIT');
  });

  it('move_tenant_subtree primero: la retención espera y usa la cadena nueva', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'USD', 'consolidator', $2) RETURNING id`,
      [`whc-c2-${sfx}`, net.ids.P],
    );
    const c2 = rows[0]!.id;
    extraTenants.push(c2);
    await seedWallet(admin, c2, { creditLimitMinor: 50_000_000 });
    const o = await order('S1', 'USD');

    const t1 = await admin.connect();
    await t1.query('BEGIN');
    await t1.query('SELECT move_tenant_subtree($1, $2)', [net.ids.A, c2]);

    const t2 = await begin(app, { tenantId: net.ids.S1 });
    const held = t2.query(retainSql, [o, net.sellers.S1]);
    await sleep(300);
    await end(t1, 'COMMIT');
    await held;
    await end(t2, 'COMMIT');

    const { rows: levels } = await admin.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM wallet_hold_levels WHERE order_id = $1 ORDER BY depth',
      [o],
    );
    expect(levels.map((l) => l.tenant_id)).toEqual([net.ids.S1, net.ids.A, c2]);

    await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [o]);
    const c = await begin(app, { tenantId: net.ids.S1 });
    await c.query('SELECT wallet_hold_settle($1::uuid, $2::uuid)', [o, net.sellers.S1]);
    await end(c, 'COMMIT');
    await admin.query('SELECT move_tenant_subtree($1, $2)', [net.ids.A, net.ids.C]);
  });

  it('una retención contra la aprobación de un depósito: la retención espera y ve el depósito', async () => {
    const before = await balance(net.ids.S1, 'USD');
    const o = await order('S1', 'USD');

    const deposit = await begin(app, { tenantId: net.ids.S1, userId: net.admins.A });
    await deposit.query(
      `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, created_by)
       SELECT id, 10000, 'DEPOSIT_PAYMENT', $2 FROM agency_portfolios
        WHERE tenant_id = $1 AND currency = 'USD'`,
      [net.ids.S1, net.admins.A],
    );
    await deposit.query(
      `UPDATE agency_portfolios SET balance_minor = balance_minor + 10000
        WHERE tenant_id = $1 AND currency = 'USD'`,
      [net.ids.S1],
    );

    const t2 = await begin(app, { tenantId: net.ids.S1 });
    const held = t2.query(retainSql, [o, net.sellers.S1]);
    await sleep(300);
    await end(deposit, 'COMMIT');
    await held;
    await end(t2, 'COMMIT');

    expect(await balance(net.ids.S1, 'USD')).toBe(before + 10_000 - saleOf('S1'));
  });
});
