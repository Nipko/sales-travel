import { randomBytes, randomUUID } from 'node:crypto';
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
 * Lo que la aplicación NO puede hacer con las retenciones desde 0060, como `app_user`: ver lo de
 * sus ancestros, escribir asientos de retención o mover saldos por fuera de las funciones, tocar
 * las tablas de la instantánea o la política, ejecutar los helpers, operar órdenes ajenas, crear
 * tablas temporales para sombrear las guardas, o borrar una orden con su retención.
 *
 * Se salta sin credenciales de app_user (APP_USER_PASSWORD), como wallets-rls.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

interface PgFailure {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
}

/** `código/regla` del error con que falla `p` (`?` si no nombra regla, como la RLS o un GRANT). */
async function rule(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as PgFailure;
    return `${e.code ?? '?'}/${e.constraint ?? '?'}`;
  }
  throw new Error('esperaba un error de Postgres');
}

/** Los helpers de 0060: sin GRANT, sólo los usan las funciones de retención. */
const HELPERS = [
  'wallet_hold_current_tenant()',
  'wallet_hold_assert_actor(uuid,uuid)',
  'wallet_hold_mode(uuid)',
  'wallet_hold_owner(uuid,text,uuid)',
  'wallet_hold_is_own_account(uuid,uuid,text)',
  'wallet_hold_chain(uuid,integer)',
  'wallet_hold_net(jsonb,text,text)',
  'wallet_hold_level_cost(uuid,text,bigint,integer)',
  'wallet_hold_decide(agency_portfolios,bigint)',
  'wallet_hold_emit(uuid,uuid,text,uuid,jsonb)',
  'wallet_hold_level_event(wallet_hold_levels,text,uuid,text,text,jsonb)',
  'wallet_hold_capture(uuid,uuid,text)',
  'wallet_hold_mark_conflict(wallet_hold_groups,uuid,text)',
  'wallet_hold_release_all(wallet_hold_groups,uuid,text)',
  'wallet_hold_backfill_legacy()',
  'wallet_hold_policy_actor_setting()',
  'wallet_hold_policy_stamp()',
  'wallet_hold_policy_audit()',
  'wallet_hold_capture_on_confirm()',
  'wallet_hold_uncapture_on_retract()',
  'portfolio_transactions_hold_entries_gate()',
  'agency_portfolios_balance_guard()',
];

const ENTRY_POINTS = [
  'wallet_hold_retain(uuid,uuid)',
  'wallet_hold_settle(uuid,uuid,text)',
  'wallet_hold_preview(text,uuid,text,text,bigint,bigint)',
  'wallet_hold_report_block(uuid)',
  'wallet_hold_report_preview_block(text,uuid,text,text,bigint,bigint)',
];

d('retenciones de red bajo RLS y guardas (0060, como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();
  const app = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });

  let net: SeededNetwork;
  const wallets: Record<string, string> = {};
  let orderS1: string;
  let orderS2: string;

  async function as<T>(
    ctx: { tenantId?: string; userId?: string },
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      if (ctx.userId !== undefined) {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.userId]);
      }
      if (ctx.tenantId !== undefined) {
        await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
      }
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const retain = (tenantId: string, orderId: string, actor: string) =>
    as({ tenantId }, (c) =>
      c.query('SELECT * FROM wallet_hold_retain($1::uuid, $2::uuid)', [orderId, actor]),
    );
  const settle = (tenantId: string, orderId: string, actor: string) =>
    as({ tenantId }, async (c) => {
      const { rows } = await c.query<{ outcome: string }>(
        'SELECT wallet_hold_settle($1::uuid, $2::uuid) AS outcome',
        [orderId, actor],
      );
      return rows[0]!.outcome;
    });

  function order(seller: 'S1' | 'S2' | 'A'): Promise<string> {
    return seedOrder(admin, {
      tenantId: net.ids[seller],
      userId: net.sellers[seller],
      provider: net.provider,
      totalMinor: saleOf(seller),
      accountId: net.accounts.P,
      vertical: net.vertical,
      pricing: { netMinor: 100_000, currency: 'USD' },
    });
  }

  async function balance(walletId: string): Promise<string> {
    const { rows } = await admin.query<{ b: string }>(
      'SELECT balance_minor::text AS b FROM agency_portfolios WHERE id = $1',
      [walletId],
    );
    return rows[0]!.b;
  }

  beforeAll(async () => {
    net = await seedNetwork(admin, {
      sfx,
      vertical: cascadeVertical(),
      provider: cascadeProvider(sfx),
    });
    for (const node of NETWORK) {
      if (node.type === 'platform') continue;
      wallets[node.key] = await seedWallet(admin, net.ids[node.key], {
        creditLimitMinor: 50_000_000,
      });
    }
    orderS1 = await order('S1');
    await retain(net.ids.S1, orderS1, net.sellers.S1);
    orderS2 = await order('S2');
  });

  afterAll(async () => {
    if (net !== undefined) await teardownNetwork(admin, net);
    await admin.end();
    await app.end();
  });

  it('app_user no se salta la RLS ni puede crear tablas temporales o en public', async () => {
    const { rows } = await app.query<{ bypass: boolean }>(
      `SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.bypass).toBe(false);
    expect(await rule(as({}, (c) => c.query('CREATE TEMP TABLE pg_roles (x int)')))).toBe(
      '42501/?',
    );
    expect(await rule(as({}, (c) => c.query('CREATE TABLE public.wh_probe (x int)')))).toBe(
      '42501/?',
    );
  });

  it('una tabla temporal pg_roles no le hace creer a la guarda que app_user se salta la RLS', async () => {
    // Sólo un superusuario puede crearla ahora; se prueba que la guarda ya no la mira.
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        'CREATE TEMP TABLE pg_roles (rolname name, rolsuper boolean, rolbypassrls boolean)',
      );
      await c.query(`INSERT INTO pg_temp.pg_roles VALUES ('app_user', true, true)`);
      await c.query('GRANT SELECT ON pg_temp.pg_roles TO app_user');
      await c.query('SET LOCAL ROLE app_user');
      const { rows } = await c.query<{ b: boolean }>('SELECT current_role_bypasses_rls() AS b');
      expect(rows[0]!.b).toBe(false);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('S1 no ve las carteras, los niveles ni los eventos de sus ancestros', async () => {
    const seen = await as({ tenantId: net.ids.S1, userId: net.admins.S1 }, async (c) => ({
      wallets: (
        await c.query('SELECT id FROM agency_portfolios WHERE tenant_id = ANY($1::uuid[])', [
          [net.ids.A, net.ids.C],
        ])
      ).rows.length,
      levels: (
        await c.query<{ depth: number }>(
          'SELECT depth FROM wallet_hold_levels WHERE order_id = $1 ORDER BY depth',
          [orderS1],
        )
      ).rows.map((r) => r.depth),
      groups: (await c.query('SELECT id FROM wallet_hold_groups WHERE order_id = $1', [orderS1]))
        .rows.length,
      eventTenants: (
        await c.query<{ tenant_id: string }>(
          `SELECT DISTINCT tenant_id FROM domain_events
            WHERE aggregate_type = 'order' AND aggregate_id = $1`,
          [orderS1],
        )
      ).rows.map((r) => r.tenant_id),
    }));
    expect(seen).toEqual({ wallets: 0, levels: [0], groups: 1, eventTenants: [net.ids.S1] });

    // A ve su nivel, no el de S1 ni el grupo (es de S1); C, el suyo.
    const levelsOf = (tenantId: string) =>
      as({ tenantId }, async (c) => ({
        levels: (
          await c.query<{ depth: number }>(
            'SELECT depth FROM wallet_hold_levels WHERE order_id = $1',
            [orderS1],
          )
        ).rows.map((r) => r.depth),
        groups: (await c.query('SELECT id FROM wallet_hold_groups WHERE order_id = $1', [orderS1]))
          .rows.length,
      }));
    expect(await levelsOf(net.ids.A)).toEqual({ levels: [1], groups: 0 });
    expect(await levelsOf(net.ids.C)).toEqual({ levels: [2], groups: 0 });
  });

  it('los eventos de los ancestros van sin actor y sin nombres ni correos', async () => {
    const { rows } = await admin.query<{ actor: string | null; payload: unknown }>(
      `SELECT actor_user_id AS actor, payload FROM domain_events
        WHERE aggregate_type = 'order' AND aggregate_id = $1 AND tenant_id = ANY($2::uuid[])`,
      [orderS1, [net.ids.A, net.ids.C]],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actor).toBeNull();
      const text = JSON.stringify(r.payload);
      expect(text).not.toContain(net.sellers.S1);
      expect(text).not.toContain('whc-');
      expect(text).not.toContain('@');
    }
  });

  describe('los asientos de retención y el saldo', () => {
    it.each([
      ['BOOKING_HOLD', -1],
      ['BOOKING_RELEASED', 1],
      ['BOOKING_CHARGE', -1],
      ['NETWORK_HOLD', -1],
      ['NETWORK_RELEASED', 1],
    ] as const)(
      'un %s como app_user, aun en la cartera propia o como quien financia: 42501 hold_entry_reserved',
      async (type, amount) => {
        const insert = (ctx: { tenantId: string; userId?: string }) =>
          as(ctx, (c) =>
            c.query(
              `INSERT INTO portfolio_transactions
                 (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
               VALUES ($1, $2, $3, $4, $5)`,
              [wallets.S1, amount, type, randomUUID(), net.sellers.S1],
            ),
          );
        expect(await rule(insert({ tenantId: net.ids.S1 }))).toBe('42501/hold_entry_reserved');
        expect(await rule(insert({ tenantId: net.ids.S1, userId: net.admins.A }))).toBe(
          '42501/hold_entry_reserved',
        );
      },
    );

    it('un tipo de asiento desconocido o con el signo al revés no entra (ni como superusuario)', async () => {
      const insert = (type: string, amount: number) =>
        admin.query(
          `INSERT INTO portfolio_transactions
             (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [wallets.S1, amount, type, randomUUID(), net.sellers.S1],
        );
      expect(await rule(insert('WITHDRAWAL', -1))).toBe('23514/portfolio_transactions_type_known');
      expect(await rule(insert('NETWORK_HOLD', 5))).toBe('23514/portfolio_transactions_hold_sign');
      expect(await rule(insert('BOOKING_RELEASED', -5))).toBe(
        '23514/portfolio_transactions_hold_sign',
      );
    });

    it('el saldo propio no se mueve desde la aplicación; quien financia, sí', async () => {
      const move = (ctx: { tenantId: string; userId?: string }, delta: number) =>
        as(ctx, (c) =>
          c.query('UPDATE agency_portfolios SET balance_minor = balance_minor + $2 WHERE id = $1', [
            wallets.S1,
            delta,
          ]),
        );
      const before = await balance(wallets.S1!);
      expect(await rule(move({ tenantId: net.ids.S1 }, 1))).toBe(
        '42501/portfolio_balance_reserved',
      );
      expect(await rule(move({ tenantId: net.ids.S1, userId: net.admins.S1 }, 1))).toBe(
        '42501/portfolio_balance_reserved',
      );
      // El consolidador no financia a la sub-agencia de su agencia.
      expect(await rule(move({ tenantId: net.ids.S1, userId: net.admins.C }, 1))).toBe(
        '42501/portfolio_balance_reserved',
      );
      expect(await balance(wallets.S1!)).toBe(before);

      await move({ tenantId: net.ids.S1, userId: net.admins.A }, 1);
      await move({ tenantId: net.ids.S1, userId: net.admins.A }, -1);
      expect(await balance(wallets.S1!)).toBe(before);
    });
  });

  it('la instantánea y la política no se escriben (ni la política se lee) desde la aplicación', async () => {
    const ctx = { tenantId: net.ids.S1 };
    expect(
      await rule(
        as(ctx, (c) =>
          c.query(
            `INSERT INTO wallet_hold_groups (order_id, origin_tenant_id, currency, sale_amount_minor,
               provider_code, credential_source, mode, status, created_by)
             VALUES ($1, $2, 'USD', 1, 'x', 'root', 'enforce', 'held', $3)`,
            [orderS2, net.ids.S1, net.sellers.S1],
          ),
        ),
      ),
    ).toBe('42501/?');
    expect(
      await rule(
        as(ctx, (c) =>
          c.query(`UPDATE wallet_hold_levels SET status = 'released' WHERE order_id = $1`, [
            orderS1,
          ]),
        ),
      ),
    ).toBe('42501/?');
    expect(
      await rule(
        as(ctx, (c) => c.query('DELETE FROM wallet_hold_groups WHERE order_id = $1', [orderS1])),
      ),
    ).toBe('42501/?');
    expect(await rule(as(ctx, (c) => c.query('SELECT * FROM wallet_hold_policy')))).toBe('42501/?');
    expect(
      await rule(
        as(ctx, (c) =>
          c.query(
            `INSERT INTO wallet_hold_policy (tenant_id, mode, reason) VALUES ($1, 'off', 'x')`,
            [net.ids.S1],
          ),
        ),
      ),
    ).toBe('42501/?');
  });

  it('un cambio de política no lo lee la red afectada: ni el modo, ni la razón, ni quién', async () => {
    await admin.query(
      `INSERT INTO wallet_hold_policy (tenant_id, mode, reason, updated_by)
       VALUES ($1, 'off', 'nota interna del operador', $2)`,
      [net.ids.C, net.admins.P],
    );
    try {
      // La consulta de AuditService.networkAudit, como la corre el admin del consolidador.
      const seen = await as({ userId: net.admins.C }, async (c) => {
        const { rows } = await c.query<{ event_type: string }>(
          `SELECT e.event_type
             FROM domain_events e
             JOIN tenants t    ON t.id = e.tenant_id
             JOIN tenants root ON root.id = $1::uuid
            WHERE t.path OPERATOR(public.<@) root.path`,
          [net.ids.C],
        );
        const { rows: direct } = await c.query(
          `SELECT 1 FROM domain_events
            WHERE event_type = 'wallet_hold.policy_changed' AND aggregate_id = $1`,
          [net.ids.C],
        );
        return { network: rows.map((r) => r.event_type), direct: direct.length };
      });
      expect(seen.network).not.toContain('wallet_hold.policy_changed');
      expect(seen.direct).toBe(0);

      const { rows } = await admin.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM domain_events
          WHERE event_type = 'wallet_hold.policy_changed' AND aggregate_id = $1`,
        [net.ids.C],
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([null]);
    } finally {
      await admin.query('DELETE FROM wallet_hold_policy WHERE tenant_id = $1', [net.ids.C]);
    }
  });

  it('los helpers no se ejecutan desde la aplicación; los puntos de entrada, sí', async () => {
    const { rows } = await admin.query<{ fn: string; can: boolean }>(
      `SELECT fn, has_function_privilege('app_user', fn, 'EXECUTE') AS can
         FROM unnest($1::text[]) AS fn`,
      [[...HELPERS, ...ENTRY_POINTS]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.fn, r.can]))).toEqual(
      Object.fromEntries([
        ...HELPERS.map((h) => [h, false]),
        ...ENTRY_POINTS.map((e) => [e, true]),
      ]),
    );
    expect(
      await rule(
        as({ tenantId: net.ids.S1 }, (c) =>
          c.query('SELECT wallet_hold_mode($1::uuid)', [net.ids.S1]),
        ),
      ),
    ).toBe('42501/?');
    expect(
      await rule(
        as({ tenantId: net.ids.S1 }, (c) => c.query('SELECT wallet_hold_backfill_legacy()')),
      ),
    ).toBe('42501/?');
  });

  describe('órdenes ajenas, tenant y actor', () => {
    it('la orden de una hermana o de un hijo no existe para el nodo', async () => {
      expect(await rule(retain(net.ids.S1, orderS2, net.sellers.S1))).toBe(
        'STW01/hold_order_not_found',
      );
      expect(await rule(retain(net.ids.A, orderS1, net.admins.A))).toBe(
        'STW01/hold_order_not_found',
      );
      expect(await rule(settle(net.ids.S2, orderS1, net.sellers.S2))).toBe(
        'STW01/hold_order_not_found',
      );
      expect(await rule(settle(net.ids.A, orderS1, net.admins.A))).toBe(
        'STW01/hold_order_not_found',
      );
    });

    it('sin tenant del request: 42501 wallet_hold_no_tenant', async () => {
      const call = (sql: string, params: unknown[]) => as({}, (c) => c.query(sql, params));
      expect(
        await rule(
          call('SELECT * FROM wallet_hold_retain($1::uuid, $2::uuid)', [orderS2, net.sellers.S2]),
        ),
      ).toBe('42501/wallet_hold_no_tenant');
      expect(
        await rule(
          call('SELECT wallet_hold_settle($1::uuid, $2::uuid)', [orderS1, net.sellers.S1]),
        ),
      ).toBe('42501/wallet_hold_no_tenant');
      expect(
        await rule(
          call(`SELECT * FROM wallet_hold_preview('x', NULL, 'hotels', 'USD', 1, NULL)`, []),
        ),
      ).toBe('42501/wallet_hold_no_tenant');
      expect(
        await rule(
          as({ tenantId: 'no-es-un-uuid' }, (c) =>
            c.query('SELECT wallet_hold_report_block($1::uuid)', [orderS1]),
          ),
        ),
      ).toBe('42501/wallet_hold_no_tenant');
      expect(
        await rule(
          call(`SELECT wallet_hold_report_preview_block('x', NULL, 'hotels', 'USD', 1, NULL)`, []),
        ),
      ).toBe('42501/wallet_hold_no_tenant');
    });

    it('un actor fuera de la red: 42501 wallet_hold_actor_invalid; uno de un ancestro o el superadmin, sí', async () => {
      expect(await rule(retain(net.ids.S2, orderS2, net.sellers.A2))).toBe(
        '42501/wallet_hold_actor_invalid',
      );
      expect(await rule(retain(net.ids.S2, orderS2, randomUUID()))).toBe(
        '42501/wallet_hold_actor_invalid',
      );
      expect(await rule(settle(net.ids.S1, orderS1, net.sellers.S2))).toBe(
        '42501/wallet_hold_actor_invalid',
      );

      // Una membership suspendida en un ancestro sigue firmando (la liberación puede venir de un
      // usuario dado de baja), y el superadmin firma en cualquier nodo.
      await admin.query(
        `UPDATE memberships SET status = 'suspended' WHERE user_id = $1 AND tenant_id = $2`,
        [net.admins.A, net.ids.A],
      );
      try {
        expect(await settle(net.ids.S1, orderS1, net.admins.A)).toBe('open');
      } finally {
        await admin.query(
          `UPDATE memberships SET status = 'active' WHERE user_id = $1 AND tenant_id = $2`,
          [net.admins.A, net.ids.A],
        );
      }
      const byRoot = await order('S2');
      await retain(net.ids.S2, byRoot, net.admins.P);
      await admin.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [byRoot]);
      expect(await settle(net.ids.S2, byRoot, net.admins.P)).toBe('released');
    });
  });

  // ON DELETE RESTRICT: Postgres 16 (producción y CI) responde foreign_key_violation (23503) y
  // versiones posteriores, como la de PGlite, restrict_violation (23001). La regla es la misma.
  it('borrar una orden o un tenant con su retención registrada falla', async () => {
    expect(await rule(admin.query('DELETE FROM orders WHERE id = $1', [orderS1]))).toMatch(
      /^(23001|23503)\/wallet_hold_groups_order_fk$/,
    );
    expect(await rule(admin.query('DELETE FROM tenants WHERE id = $1', [net.ids.S1]))).toMatch(
      /^(23001|23503)\//,
    );
  });
});
