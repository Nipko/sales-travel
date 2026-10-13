import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { TenantHierarchyNotFoundError } from '../database/tenant-hierarchy-errors.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { AdminTenantsService } from './admin-tenants.service.js';

/**
 * Agencias en números contra la base, como `app_user` (el rol de producción, sujeto a la RLS):
 * `admin_node_stats()` (0075) por nodo, y el impacto de suspender un nodo sumado sobre su subárbol.
 *
 * La red: Planetour → consolidador C → agencias A y B, y A → sub-agencia S; Planetour → agencia D,
 * fuera de lo que se mira. Una persona con acceso a A y a S cuenta una vez. La base es compartida
 * con otros tests: todo se mira acotado a estos nodos. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

d('Agencias en números (admin_node_stats de 0075 como app_user)', () => {
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
  const service = new AdminTenantsService(database);

  const tenants: string[] = [];
  const users: string[] = [];
  const orders: string[] = [];
  let seq = 0;

  let platform: string;
  let consolidator: string;
  let agencyA: string;
  let agencyB: string;
  let sub: string;
  let outside: string;
  let superadmin: string;
  let consolidatorAdmin: string;

  async function tenant(label: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`at-${label}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, status = 'active'): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, $3) RETURNING id`,
      [`at-${label}-${sfx}@test.local`, `Usuario ${label}`, status],
    );
    users.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: string, status = 'active') {
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  async function session(userId: string, tenantId: string, revoked = false): Promise<void> {
    await admin.query(
      `INSERT INTO sessions (user_id, tenant_id, expires_at, revoked_at, revoked_reason)
       VALUES ($1, $2, now() + interval '1 hour', CASE WHEN $3 THEN now() END,
               CASE WHEN $3 THEN 'logout' END)`,
      [userId, tenantId, revoked],
    );
  }

  async function order(
    tenantId: string,
    userId: string,
    status: string,
    currency = 'COP',
  ): Promise<string> {
    seq += 1;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, currency, order_number, status)
       VALUES ($1, $2, 'latam-ndc', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 1000, $3,
               $4, $5)
       RETURNING id`,
      [tenantId, userId, currency, 800_000 + seq, status],
    );
    orders.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function wallet(tenantId: string, currency = 'COP'): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, currency, credit_limit_minor, balance_minor)
       VALUES ($1, $2, 1000000, 0) RETURNING id`,
      [tenantId, currency],
    );
    return rows[0]!.id;
  }

  /**
   * Una retención `held` de la orden en cascada: cada nivel en la cartera de su nodo. Como
   * superusuario: las funciones de retención (0060) no se prueban acá.
   */
  async function hold(
    orderId: string,
    origin: string,
    by: string,
    currency: string,
    levels: ReadonlyArray<{ tenantId: string; portfolioId: string; amount: number }>,
  ): Promise<void> {
    const { rows: group } = await admin.query<{ id: string }>(
      `INSERT INTO wallet_hold_groups (order_id, origin_tenant_id, currency, sale_amount_minor,
                                       provider_code, credential_source, mode, status, created_by)
       VALUES ($1, $2, $3, 1000, 'latam-ndc', 'legacy', 'legacy', 'held', $4) RETURNING id`,
      [orderId, origin, currency, by],
    );
    for (const [depth, level] of levels.entries()) {
      const { rows: entry } = await admin.query<{ id: string }>(
        `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          level.portfolioId,
          -level.amount,
          depth === 0 ? 'BOOKING_HOLD' : 'NETWORK_HOLD',
          orderId,
          by,
        ],
      );
      await admin.query(
        `INSERT INTO wallet_hold_levels (group_id, order_id, depth, tenant_id, portfolio_id,
                                         origin_tenant_id, currency, amount_minor, basis,
                                         hold_transaction_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'held')`,
        [
          group[0]!.id,
          orderId,
          depth,
          level.tenantId,
          level.portfolioId,
          origin,
          currency,
          level.amount,
          depth === 0 ? 'sale' : 'cost',
          entry[0]!.id,
        ],
      );
    }
  }

  async function depositReport(tenantId: string, portfolioId: string, by: string): Promise<void> {
    await admin.query(
      `INSERT INTO portfolio_deposit_reports (tenant_id, portfolio_id, currency, amount_minor, reference, reported_by)
       VALUES ($1, $2, 'COP', 10000, $3, $4)`,
      [tenantId, portfolioId, `at-${sfx}-${randomBytes(2).toString('hex')}`, by],
    );
  }

  async function invitation(tenantId: string, expires: string): Promise<void> {
    await admin.query(
      `INSERT INTO user_invitations (tenant_id, email, role, token_hash, expires_at)
       VALUES ($1, $2, 'vendedor', $3, now() + $4::interval)`,
      [
        tenantId,
        `at-inv-${randomBytes(3).toString('hex')}-${sfx}@test.local`,
        randomBytes(16).toString('hex'),
        expires,
      ],
    );
  }

  beforeAll(async () => {
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agencyA = await tenant('a', 'agency', consolidator);
    agencyB = await tenant('b', 'agency', consolidator);
    sub = await tenant('s', 'subagency', agencyA);
    outside = await tenant('d', 'agency', platform);

    superadmin = await user('sa');
    await member(platform, superadmin, 'superadmin');
    consolidatorAdmin = await user('ca');
    await member(consolidator, consolidatorAdmin, 'consolidator_admin');
    // La misma persona en A y en S: una sola para el impacto, una en cada nodo para stats.
    const twoNodes = await user('dos');
    await member(agencyA, twoNodes, 'tenant_admin');
    await member(sub, twoNodes, 'vendedor');
    const sellerB = await user('vb');
    await member(agencyB, sellerB, 'vendedor');
    // No cuentan: la membership suspendida y el usuario suspendido.
    await member(agencyA, await user('ms'), 'vendedor', 'suspended');
    await member(agencyB, await user('us', 'suspended'), 'vendedor');
    const outsider = await user('fuera');
    await member(outside, outsider, 'tenant_admin');

    // Sesiones vivas en A y en S; la revocada de B no cuenta.
    await session(twoNodes, agencyA);
    await session(twoNodes, sub);
    await session(sellerB, agencyB, true);
    await session(outsider, outside);

    // Reservas abiertas: la pendiente de A y la confirmada de S; la cancelada de B no.
    const pendingA = await order(agencyA, twoNodes, 'pending');
    await order(sub, twoNodes, 'confirmed');
    await order(agencyB, sellerB, 'cancelled');
    await order(outside, outsider, 'pending');
    const usdS = await order(sub, twoNodes, 'ticketed', 'USD');

    // Retenido: la venta de A retiene en A (venta) y en C (su costo); la de S, en USD.
    const walletA = await wallet(agencyA);
    const walletC = await wallet(consolidator);
    const walletB = await wallet(agencyB);
    const walletSUsd = await wallet(sub, 'USD');
    const walletD = await wallet(outside);
    await hold(pendingA, agencyA, twoNodes, 'COP', [
      { tenantId: agencyA, portfolioId: walletA, amount: 1000 },
      { tenantId: consolidator, portfolioId: walletC, amount: 800 },
    ]);
    await hold(usdS, sub, twoNodes, 'USD', [
      { tenantId: sub, portfolioId: walletSUsd, amount: 2500 },
    ]);

    await depositReport(agencyB, walletB, sellerB);
    await depositReport(outside, walletD, outsider);

    // Invitaciones: la vigente de S cuenta; la vencida de A no.
    await invitation(sub, '3 days');
    await invitation(agencyA, '-1 day');

    await admin.query(`UPDATE tenants SET concurrent_seats = 2 WHERE id = $1`, [agencyA]);
    await admin.query(`UPDATE sessions SET seat_tenant_id = $1 WHERE tenant_id = ANY($2::uuid[])`, [
      agencyA,
      [agencyA, sub],
    ]);
  });

  afterAll(async () => {
    // Las retenciones frenan el borrado de su orden (RESTRICT): primero ellas, y sus niveles antes.
    await admin.query('DELETE FROM wallet_hold_levels WHERE order_id = ANY($1::uuid[])', [orders]);
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

  it('stats: cada nodo con sus puestos, ventas, abiertas, retenido y pendientes', async () => {
    const nodes = await service.stats(superadmin);
    const of = (id: string) => nodes.find((n) => n.tenantId === id);

    expect(of(agencyA)).toMatchObject({
      seatLimit: 2,
      seatsUsed: 2,
      liveSessions: 1,
      // tenant_admin; la membership suspendida no cuenta.
      activeUsers: 1,
      orders30d: 1,
      openOrders: 1,
      pendingDepositReports: 0,
      pendingInvitations: 0,
      held: [{ currency: 'COP', exponent: 2, amountMinor: 1000 }],
    });
    expect(of(agencyA)?.lastOrderAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(of(consolidator)).toMatchObject({
      seatLimit: null,
      seatsUsed: null,
      orders30d: 0,
      lastOrderAt: null,
      held: [{ currency: 'COP', exponent: 2, amountMinor: 800 }],
    });
    expect(of(agencyB)).toMatchObject({
      liveSessions: 0,
      // El usuario suspendido no cuenta.
      activeUsers: 1,
      openOrders: 0,
      pendingDepositReports: 1,
    });
    expect(of(sub)).toMatchObject({
      openOrders: 2,
      pendingInvitations: 1,
      held: [{ currency: 'USD', exponent: 2, amountMinor: 2500 }],
    });
  });

  it('impacto de suspender C: su red entera, cada persona una vez y lo retenido por moneda', async () => {
    const impact = await service.impact(superadmin, consolidator);

    expect(impact).toEqual({
      tenant: {
        id: consolidator,
        name: `at-c-${sfx}`,
        tenantType: 'consolidator',
        isBranch: false,
        status: 'active',
      },
      descendants: 3,
      // El admin de C, la persona de A y S (una vez) y el vendedor de B.
      activeUsers: 3,
      liveSessions: 2,
      openOrders: 3,
      held: [
        { currency: 'COP', exponent: 2, amountMinor: 1800 },
        { currency: 'USD', exponent: 2, amountMinor: 2500 },
      ],
      pendingDepositReports: 1,
      pendingInvitations: 1,
    });
  });

  it('impacto de suspender A: sólo A y S, sin lo de B, C ni fuera de la red', async () => {
    expect(await service.impact(superadmin, agencyA)).toMatchObject({
      descendants: 1,
      activeUsers: 1,
      liveSessions: 2,
      openOrders: 3,
      held: [
        { currency: 'COP', exponent: 2, amountMinor: 1000 },
        { currency: 'USD', exponent: 2, amountMinor: 2500 },
      ],
      pendingDepositReports: 0,
      pendingInvitations: 1,
    });
    expect(await service.impact(superadmin, agencyB)).toMatchObject({
      descendants: 0,
      activeUsers: 1,
      liveSessions: 0,
      openOrders: 0,
      held: [],
      pendingDepositReports: 1,
    });
  });

  it('un nodo que no existe es 404 TENANT_NOT_FOUND', async () => {
    const error = await service
      .impact(superadmin, '00000000-0000-4000-8000-000000000000')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantHierarchyNotFoundError);
    expect((error as TenantHierarchyNotFoundError).reason).toBe('TENANT_NOT_FOUND');
  });

  it('quien no es superadmin (un consolidator_admin sobre su propia red): 403 de la base', async () => {
    await expect(service.stats(consolidatorAdmin)).rejects.toBeInstanceOf(SuperadminRequiredError);
    await expect(service.impact(consolidatorAdmin, consolidator)).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
  });
});
