import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { platformRootId, type Queryable } from '../../__fixtures__/platform-root.js';
import { ACCOUNT_OWNERS, NETWORK, type AccountOwner, type NodeKey } from './network-hold-cases.js';

/**
 * Siembra de retenciones de cartera como SUPERUSUARIO, para los tests de integración.
 *
 * Desde 0060 `app_user` no escribe asientos BOOKING_* ni NETWORK_* ni mueve `balance_minor` (salvo
 * como quien financia): una retención sale sólo de `wallet_hold_retain`. Los tests que antes
 * sembraban un `BOOKING_HOLD` a mano lo hacen con {@link retainAsSuperuser}, que llama a la misma
 * función con el tenant del request puesto, y limpian con {@link clearWalletHolds} antes de borrar
 * órdenes o tenants (los grupos son ON DELETE RESTRICT).
 */

/** Una conexión propia (`pool.connect()`): la transacción con los GUC tiene que ser suya. */
type Conn = Pick<pg.PoolClient, 'query' | 'release'>;
interface Connectable {
  connect(): Promise<Conn>;
}

export interface WalletSeed {
  readonly currency?: string;
  readonly balanceMinor?: number;
  readonly creditLimitMinor?: number;
  readonly status?: 'active' | 'suspended' | 'overlimit';
}

/** Abre (o ajusta) la cartera del tenant en esa moneda, con saldo y cupo, sin pasar por las guardas. */
export async function seedWallet(
  db: Queryable,
  tenantId: string,
  seed: WalletSeed = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agency_portfolios (tenant_id, currency, balance_minor, credit_limit_minor, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, currency) DO UPDATE
       SET balance_minor = EXCLUDED.balance_minor,
           credit_limit_minor = EXCLUDED.credit_limit_minor,
           status = EXCLUDED.status
     RETURNING id`,
    [
      tenantId,
      seed.currency ?? 'USD',
      seed.balanceMinor ?? 0,
      seed.creditLimitMinor ?? 0,
      seed.status ?? 'active',
    ],
  );
  return rows[0]!.id;
}

export interface RetainedRow {
  readonly group_id: string;
  /** held | captured; exempt con la cuenta propia del que vende, sin cartera ni asiento. */
  readonly hold_status: string;
  readonly own_portfolio_id: string | null;
  readonly own_transaction_id: string | null;
  readonly network_levels: number;
  readonly mode: string;
}

/** Corre `fn` en una transacción de `pool` con `app.current_tenant_id` puesto. */
async function withTenantGuc<T>(
  pool: Connectable,
  tenantId: string,
  fn: (c: Conn) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** `wallet_hold_retain` como la llama la API (withTenant), con la conexión de `pool`. */
export async function retainAsSuperuser(
  pool: Connectable,
  tenantId: string,
  orderId: string,
  actorId: string,
): Promise<RetainedRow> {
  return withTenantGuc(pool, tenantId, async (c) => {
    const { rows } = await c.query<RetainedRow>(
      'SELECT * FROM wallet_hold_retain($1::uuid, $2::uuid)',
      [orderId, actorId],
    );
    return rows[0]!;
  });
}

/** `wallet_hold_settle` como la llama la API. */
export async function settleAsSuperuser(
  pool: Connectable,
  tenantId: string,
  orderId: string,
  actorId: string,
  expected: 'failed' | 'cancelled' | null = null,
): Promise<string> {
  return withTenantGuc(pool, tenantId, async (c) => {
    const { rows } = await c.query<{ outcome: string }>(
      'SELECT wallet_hold_settle($1::uuid, $2::uuid, $3::text) AS outcome',
      [orderId, actorId, expected],
    );
    return rows[0]!.outcome;
  });
}

/** Borra las retenciones registradas de esas órdenes (niveles y grupos), para poder borrarlas. */
export async function clearWalletHolds(db: Queryable, orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await db.query('DELETE FROM wallet_hold_levels WHERE order_id = ANY($1::uuid[])', [orderIds]);
  await db.query('DELETE FROM wallet_hold_groups WHERE order_id = ANY($1::uuid[])', [orderIds]);
}

/** Lo mismo, para todas las órdenes de esos tenants. */
export async function clearWalletHoldsOfTenants(
  db: Queryable,
  tenantIds: readonly string[],
): Promise<void> {
  if (tenantIds.length === 0) return;
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM orders WHERE tenant_id = ANY($1::uuid[])',
    [tenantIds],
  );
  await clearWalletHolds(
    db,
    rows.map((r) => r.id),
  );
}

export interface OrderSeed {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  readonly totalMinor: number;
  readonly currency?: string;
  readonly accountId?: string | null;
  readonly vertical?: string;
  /** `selected_offer.pricing`; `null` = la orden no guarda neto. */
  readonly pricing?: { netMinor: unknown; currency: unknown } | null;
  /** `selected_offer` entero, en vez del armado con `pricing` (p. ej. una oferta de vuelos). */
  readonly selectedOffer?: Record<string, unknown>;
  /** 'pending' abre un intent (sin desenlace y con create_request_key). */
  readonly status?: 'pending' | 'confirmed' | 'failed' | 'cancelled' | 'ticketed';
}

let orderNumber = Math.floor(Date.now() / 1000) % 1_000_000_000;

/** Una orden como las que abre la API, insertada como superusuario. */
export async function seedOrder(db: Queryable, seed: OrderSeed): Promise<string> {
  orderNumber += 1;
  const currency = seed.currency ?? 'USD';
  const offer =
    seed.selectedOffer ??
    (seed.pricing === null
      ? {}
      : {
          pricing: seed.pricing ?? { netMinor: seed.totalMinor, currency },
        });
  const status = seed.status ?? 'pending';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                         contact_info, total_amount, currency, order_number, status,
                         provider_account_id, create_request_key)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, '[]', '{}', $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      seed.tenantId,
      seed.userId,
      seed.provider,
      JSON.stringify(seed.vertical === undefined ? {} : { vertical: seed.vertical }),
      JSON.stringify(offer),
      seed.totalMinor,
      currency,
      orderNumber,
      status,
      seed.accountId ?? null,
      status === 'pending' ? `wh-${randomUUID()}` : null,
    ],
  );
  return rows[0]!.id;
}

export interface SeededNetwork {
  readonly ids: Readonly<Record<NodeKey, string>>;
  /** Un vendedor (`vendedor`) por nodo; en P, el superadmin de la corrida. */
  readonly sellers: Readonly<Record<NodeKey, string>>;
  /** Un admin por nodo (consolidator_admin o tenant_admin); en P, el superadmin de la corrida. */
  readonly admins: Readonly<Record<NodeKey, string>>;
  readonly accounts: Readonly<Record<AccountOwner, string>>;
  /** Los tenants creados (sin P), de la raíz a las hojas. */
  readonly tenants: readonly string[];
  readonly users: readonly string[];
  readonly vertical: string;
  readonly provider: string;
}

/**
 * La red de `network-hold-cases.ts` colgada de la raíz compartida, con sus usuarios, sus reglas de
 * markup en `vertical` y sus cuentas de `provider`. Sin carteras: cada test abre las que necesita.
 */
export async function seedNetwork(
  db: Queryable,
  opts: { sfx: string; vertical: string; provider: string },
): Promise<SeededNetwork> {
  const ids = {} as Record<NodeKey, string>;
  const sellers = {} as Record<NodeKey, string>;
  const admins = {} as Record<NodeKey, string>;
  const accounts = {} as Record<AccountOwner, string>;
  const tenants: string[] = [];
  const users: string[] = [];

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`whc-${label}-${opts.sfx}@test.local`],
    );
    users.push(rows[0]!.id);
    await db.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  for (const node of NETWORK) {
    if (node.type === 'platform') {
      ids[node.key] = await platformRootId(db);
      const superadmin = await user('sa', ids[node.key], 'superadmin');
      sellers[node.key] = superadmin;
      admins[node.key] = superadmin;
    } else {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type,
                              parent_tenant_id, is_branch)
         VALUES ($1::text, $1::text, 'CO', 'USD', $2, $3, $4) RETURNING id`,
        [
          `whc-${node.key.toLowerCase()}-${opts.sfx}`,
          node.type,
          ids[node.parent!],
          node.isBranch ?? false,
        ],
      );
      ids[node.key] = rows[0]!.id;
      tenants.push(rows[0]!.id);
      const low = node.key.toLowerCase();
      sellers[node.key] = await user(`${low}-v`, ids[node.key], 'vendedor');
      admins[node.key] = await user(
        `${low}-a`,
        ids[node.key],
        node.type === 'consolidator' ? 'consolidator_admin' : 'tenant_admin',
      );
    }
    if (node.markupBps !== undefined) {
      await db.query(
        `INSERT INTO markup_rules (tenant_id, vertical, rule_type, value_minor, priority, status)
         VALUES ($1, $2, 'percentage', $3, 1, 'active')`,
        [ids[node.key], opts.vertical, node.markupBps],
      );
    }
  }

  for (const owner of ACCOUNT_OWNERS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, is_inheritable, status)
       VALUES ($1, $2, $3, '\\x00'::bytea, true, 'active') RETURNING id`,
      [ids[owner], opts.provider, `whc-${owner.toLowerCase()}`],
    );
    accounts[owner] = rows[0]!.id;
  }

  return {
    ids,
    sellers,
    admins,
    accounts,
    tenants,
    users,
    vertical: opts.vertical,
    provider: opts.provider,
  };
}

/**
 * Desmonta la red: retenciones, órdenes, las reglas y cuentas colgadas de la raíz compartida, los
 * tenants (de las hojas a la raíz) y los usuarios. Los domain_events quedan: son de sólo agregar.
 */
export async function teardownNetwork(
  db: Queryable,
  net: SeededNetwork,
  extraTenants: readonly string[] = [],
): Promise<void> {
  const all = [...net.tenants, ...extraTenants];
  const { rows: orders } = await db.query<{ id: string }>(
    'SELECT id FROM orders WHERE tenant_id = ANY($1::uuid[]) OR provider = $2',
    [all, net.provider],
  );
  const orderIds = orders.map((o) => o.id);
  await clearWalletHolds(db, orderIds);
  await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orderIds]);
  await db.query('DELETE FROM provider_accounts WHERE provider_code = $1', [net.provider]);
  await db.query('DELETE FROM markup_rules WHERE vertical = $1', [net.vertical]);
  await db.query('DELETE FROM wallet_hold_policy WHERE tenant_id = ANY($1::uuid[])', [all]);
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
    [all],
  );
  for (const r of rows) await db.query('DELETE FROM tenants WHERE id = $1', [r.id]);
  await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [net.users]);
}
