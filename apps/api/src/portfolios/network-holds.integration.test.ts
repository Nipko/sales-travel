import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NETWORK,
  NETWORK_HOLD_CASES,
  cascadeProvider,
  cascadeVertical,
  expectedHolds,
  saleOf,
  type AccountOwner,
  type NodeKey,
} from './__fixtures__/network-hold-cases.js';
import {
  seedNetwork,
  seedOrder,
  seedWallet,
  teardownNetwork,
  type SeededNetwork,
} from './__fixtures__/wallet-hold-seed.js';

/**
 * La retención en cascada de 0060 contra la base, como `app_user` (el rol de la API): quién retiene,
 * cuánto, el todo o nada, el ciclo de vida (captura, liberación, conflicto), la instantánea, los
 * modos, el aviso al ancestro, el anticipo del PreBook, STH02 y el agotamiento del cupo de la red.
 *
 * Cada llamada corre en su transacción con `app.current_tenant_id` del nodo que vende, como
 * `DatabaseService.withTenant`. Lo que la API hace alrededor (validaciones, mensajes, reintentos) se
 * prueba en los tests del servicio.
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

async function failure(p: Promise<unknown>): Promise<PgFailure> {
  try {
    await p;
  } catch (err) {
    return err as PgFailure;
  }
  throw new Error('esperaba un error de Postgres');
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HUGE_CREDIT = 50_000_000;

interface Retained {
  group_id: string;
  own_portfolio_id: string;
  own_transaction_id: string;
  network_levels: number;
  mode: string;
}

interface LevelRow {
  depth: number;
  tenant_id: string;
  portfolio_id: string;
  amount_minor: string;
  basis: string;
  status: string;
  hold_type: string;
  release_type: string | null;
}

d('retención en cascada por la red (0060, como app_user)', () => {
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
  const extraTenants: string[] = [];

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

  const id = (k: NodeKey) => net.ids[k];

  function retain(seller: string, orderId: string, actor: string): Promise<Retained> {
    return as({ tenantId: seller }, async (c) => {
      const { rows } = await c.query<Retained>(
        'SELECT * FROM wallet_hold_retain($1::uuid, $2::uuid)',
        [orderId, actor],
      );
      return rows[0]!;
    });
  }

  function settle(
    seller: string,
    orderId: string,
    actor: string,
    expected: 'failed' | 'cancelled' | null = null,
  ): Promise<string> {
    return as({ tenantId: seller }, async (c) => {
      const { rows } = await c.query<{ outcome: string }>(
        'SELECT wallet_hold_settle($1::uuid, $2::uuid, $3::text) AS outcome',
        [orderId, actor, expected],
      );
      return rows[0]!.outcome;
    });
  }

  function preview(
    seller: string,
    q: {
      account: string | null;
      currency: string;
      sale: number;
      net: number | null;
      vertical?: string;
      provider?: string;
    },
  ): Promise<{ status: string; reason: string | null }> {
    return as({ tenantId: seller }, async (c) => {
      const { rows } = await c.query<{ status: string; reason: string | null }>(
        'SELECT * FROM wallet_hold_preview($1, $2::uuid, $3, $4, $5::bigint, $6::bigint)',
        [
          q.provider ?? net.provider,
          q.account,
          q.vertical ?? net.vertical,
          q.currency,
          q.sale,
          q.net,
        ],
      );
      return rows[0]!;
    });
  }

  function accountOf(owner: AccountOwner | null): string | null {
    return owner === null ? null : net.accounts[owner];
  }

  /** Una orden abierta de `seller`, con el neto y el precio de venta de la cascada. */
  function openOrder(
    seller: NodeKey,
    owner: AccountOwner | null,
    opts: {
      currency?: string;
      pricing?: { netMinor: unknown; currency: unknown } | null;
      /** `selected_offer` entero (p. ej. una oferta de vuelos), en vez del armado con `pricing`. */
      selectedOffer?: Record<string, unknown>;
      /** `null` = la orden no dice su vertical (vuelos: la base asume 'flights'). */
      vertical?: string | null;
      status?: 'pending' | 'confirmed' | 'failed';
      tenantId?: string;
      userId?: string;
    } = {},
  ): Promise<string> {
    const currency = opts.currency ?? 'USD';
    const vertical = opts.vertical === undefined ? net.vertical : opts.vertical;
    return seedOrder(admin, {
      tenantId: opts.tenantId ?? id(seller),
      userId: opts.userId ?? net.sellers[seller],
      provider: net.provider,
      totalMinor: saleOf(seller),
      currency,
      accountId: accountOf(owner),
      ...(vertical === null ? {} : { vertical }),
      pricing: opts.pricing === undefined ? { netMinor: 100_000, currency } : opts.pricing,
      ...(opts.selectedOffer === undefined ? {} : { selectedOffer: opts.selectedOffer }),
      ...(opts.status === undefined ? {} : { status: opts.status }),
    });
  }

  async function balances(currency: string): Promise<Map<string, number>> {
    const tenantIds = [...net.tenants, ...extraTenants];
    const { rows } = await admin.query<{ tenant_id: string; balance: string }>(
      `SELECT tenant_id, balance_minor::text AS balance FROM agency_portfolios
        WHERE currency = $1 AND tenant_id = ANY($2::uuid[])`,
      [currency, tenantIds],
    );
    return new Map(rows.map((r) => [r.tenant_id, Number(r.balance)]));
  }

  async function levels(orderId: string): Promise<LevelRow[]> {
    const { rows } = await admin.query<LevelRow>(
      `SELECT l.depth, l.tenant_id, l.portfolio_id, l.amount_minor::text AS amount_minor, l.basis,
              l.status, h.transaction_type AS hold_type, r.transaction_type AS release_type
         FROM wallet_hold_levels l
         JOIN portfolio_transactions h ON h.id = l.hold_transaction_id
         LEFT JOIN portfolio_transactions r ON r.id = l.release_transaction_id
        WHERE l.order_id = $1 ORDER BY l.depth`,
      [orderId],
    );
    return rows;
  }

  async function group(orderId: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await admin.query<Record<string, unknown>>(
      'SELECT * FROM wallet_hold_groups WHERE order_id = $1',
      [orderId],
    );
    return rows[0];
  }

  async function events(
    orderId: string,
    type: string,
  ): Promise<{ tenant_id: string; actor: string | null; payload: Record<string, unknown> }[]> {
    const { rows } = await admin.query<{
      tenant_id: string;
      actor: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT tenant_id, actor_user_id AS actor, payload FROM domain_events
        WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = $2
        ORDER BY (payload->>'depth')::int NULLS FIRST, occurred_at`,
      [orderId, type],
    );
    return rows;
  }

  async function setStatus(orderId: string, status: string): Promise<void> {
    await admin.query('UPDATE orders SET status = $2 WHERE id = $1', [orderId, status]);
  }

  /** Un rechazo STW02 de `rule`, sin nada escrito y con un mensaje sin ids ni montos. */
  async function expectRejected(
    p: Promise<unknown>,
    rule: string,
    orderId: string,
    currency: string,
  ): Promise<void> {
    const before = await balances(currency);
    const e = await failure(p);
    expect({ code: e.code, constraint: e.constraint }).toEqual({ code: 'STW02', constraint: rule });
    expect(e.message).not.toMatch(UUID_RE);
    expect(e.message).not.toMatch(/\d/);
    expect(await balances(currency)).toEqual(before);
    expect(await group(orderId)).toBeUndefined();
    const { rows } = await admin.query(
      `SELECT 1 FROM portfolio_transactions WHERE lower(reference_id) = lower($1)`,
      [orderId],
    );
    expect(rows).toHaveLength(0);
  }

  /** Cierra la orden como no realizada y libera su retención. */
  async function closeFailed(seller: string, orderId: string, actor: string): Promise<string> {
    await setStatus(orderId, 'failed');
    return settle(seller, orderId, actor, 'failed');
  }

  beforeAll(async () => {
    net = await seedNetwork(admin, {
      sfx,
      vertical: cascadeVertical(),
      provider: cascadeProvider(sfx),
    });
    for (const node of NETWORK) {
      if (node.type === 'platform') continue;
      await seedWallet(admin, id(node.key), { creditLimitMinor: HUGE_CREDIT });
    }
  });

  afterAll(async () => {
    if (net !== undefined) await teardownNetwork(admin, net, extraTenants);
    await admin.end();
    await app.end();
  });

  it('app_user no se salta la RLS (si no, lo demás no prueba nada)', async () => {
    const { rows } = await app.query<{ bypass: boolean }>(
      `SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.bypass).toBe(false);
  });

  describe('quién retiene y cuánto (spec §1.4)', () => {
    it.each(NETWORK_HOLD_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
      const expected = expectedHolds(c);
      const orderId = await openOrder(c.seller, c.account);
      const before = await balances('USD');

      const out = await retain(id(c.seller), orderId, net.sellers[c.seller]);
      expect(out.network_levels).toBe(c.retains.length - 1);
      expect(out.mode).toBe('enforce');

      expect(await levels(orderId)).toEqual(
        c.retains.map((key, depth): unknown =>
          expect.objectContaining({
            depth,
            tenant_id: id(key),
            amount_minor: String(expected.get(key)),
            basis: depth === 0 ? 'sale' : 'cost',
            status: 'held',
            hold_type: depth === 0 ? 'BOOKING_HOLD' : 'NETWORK_HOLD',
            release_type: null,
          }),
        ),
      );
      expect(await group(orderId)).toMatchObject({
        origin_tenant_id: id(c.seller),
        currency: 'USD',
        sale_amount_minor: String(saleOf(c.seller)),
        credential_owner_tenant_id: id(c.account ?? 'P'),
        credential_source: c.account === null ? 'root' : 'account',
        mode: 'enforce',
        status: 'held',
      });

      const after = await balances('USD');
      for (const [tenantId, balance] of before) {
        const key = NETWORK.find((n) => id(n.key) === tenantId)?.key;
        const held = key === undefined ? 0 : (expected.get(key) ?? 0);
        expect(after.get(tenantId), key).toBe(balance - held);
      }

      // Liberar devuelve todo, una sola vez.
      expect(await closeFailed(id(c.seller), orderId, net.sellers[c.seller])).toBe('released');
      expect(await balances('USD')).toEqual(before);
      expect((await levels(orderId)).map((l) => [l.status, l.release_type])).toEqual(
        c.retains.map((_k, depth) => [
          'released',
          depth === 0 ? 'BOOKING_RELEASED' : 'NETWORK_RELEASED',
        ]),
      );
      expect(await settle(id(c.seller), orderId, net.sellers[c.seller], 'failed')).toBe(
        'already-released',
      );
      expect(await balances('USD')).toEqual(before);
    });

    it('el ejemplo de la spec: neto 1.000,00 → S1 1.397,09, A 1.134,00, C 1.050,00', async () => {
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      expect((await levels(orderId)).map((l) => [l.depth, l.amount_minor])).toEqual([
        [0, '139709'],
        [1, '113400'],
        [2, '105000'],
      ]);
      await closeFailed(id('S1'), orderId, net.sellers.S1);
    });

    it('los eventos: uno por nivel en el dueño de la cartera, con actor sólo en depth 0 y sin nombres', async () => {
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      const retained = await events(orderId, 'portfolio.hold.retained');
      expect(retained.map((e) => [e.tenant_id, e.actor])).toEqual([
        [id('S1'), net.sellers.S1],
        [id('A'), null],
        [id('C'), null],
      ]);
      for (const e of retained) {
        expect(Object.keys(e.payload).sort()).toEqual(
          [
            'amountMinor',
            'basis',
            'currency',
            'depth',
            'mode',
            'orderId',
            'orderNumber',
            'originTenantId',
            'portfolioId',
            'source',
            'status',
          ].sort(),
        );
        expect(e.payload['originTenantId']).toBe(id('S1'));
      }
      await closeFailed(id('S1'), orderId, net.sellers.S1);
      const released = await events(orderId, 'portfolio.hold.released');
      expect(released.map((e) => [e.tenant_id, e.payload['reason']])).toEqual([
        [id('S1'), 'failed'],
        [id('A'), 'failed'],
        [id('C'), 'failed'],
      ]);
    });

    it('vuelos: el neto es selected_offer.total (la oferta canónica), no el precio de venta', async () => {
      const sale = saleOf('S1');
      const orderId = await openOrder('S1', 'P', {
        vertical: null,
        selectedOffer: {
          total: { amountMinor: 100_000, currency: 'USD' },
          pricing: { costMinor: 125_000, finalMinor: sale, ownMarkupMinor: 1, currency: 'USD' },
        },
      });
      const out = await retain(id('S1'), orderId, net.sellers.S1);
      expect(out.network_levels).toBe(2);

      // El costo de cada nivel con las reglas de 'flights' que haya: neto 100.000 + lo de arriba.
      const { rows: cost } = await admin.query<{ a: string; c: string }>(
        `SELECT wallet_hold_level_cost($1, 'flights', 100000, 3)::bigint::text AS a,
                wallet_hold_level_cost($1, 'flights', 100000, 2)::bigint::text AS c`,
        [id('S1')],
      );
      expect((await levels(orderId)).map((l) => [l.depth, l.amount_minor])).toEqual([
        [0, String(sale)],
        [1, cost[0]!.a],
        [2, cost[0]!.c],
      ]);
      await closeFailed(id('S1'), orderId, net.sellers.S1);
    });

    it.each([
      ['el neto de pricing manda', { pricing: { netMinor: 7, currency: 'USD' } }, 'hotels', '7'],
      [
        'vuelos sin pricing.netMinor usa total',
        { total: { amountMinor: 9, currency: 'USD' }, pricing: { costMinor: 11 } },
        'flights',
        '9',
      ],
      [
        'otra vertical no usa total',
        { total: { amountMinor: 9, currency: 'USD' } },
        'hotels',
        null,
      ],
      ['total en otra moneda', { total: { amountMinor: 9, currency: 'EUR' } }, 'flights', null],
      ['total con decimales', { total: { amountMinor: 9.5, currency: 'USD' } }, 'flights', null],
      [
        'un pricing.netMinor inválido no cae a total',
        { total: { amountMinor: 9, currency: 'USD' }, pricing: { netMinor: 'x', currency: 'USD' } },
        'flights',
        null,
      ],
    ] as const)('wallet_hold_net: %s', async (_label, offer, vertical, expected) => {
      const { rows } = await admin.query<{ n: string | null }>(
        `SELECT wallet_hold_net($1::jsonb, 'USD', $2)::text AS n`,
        [JSON.stringify(offer), vertical],
      );
      expect(rows[0]!.n).toBe(expected);
    });

    it('sin cadena no hace falta el neto: la sucursal retiene aunque la orden no lo guarde', async () => {
      const orderId = await openOrder('B', null, { pricing: null });
      const out = await retain(id('B'), orderId, net.sellers.B);
      expect(out.network_levels).toBe(0);
      await closeFailed(id('B'), orderId, net.sellers.B);
    });
  });

  describe('todo o nada: un nivel que no alcanza no deja nada escrito', () => {
    beforeAll(async () => {
      // EUR: A no tiene cartera. GBP: C suspendida. CHF: C sin cupo. JPY: S1 sin fondos.
      for (const k of ['S1', 'C'] as const) {
        await seedWallet(admin, id(k), { currency: 'EUR', creditLimitMinor: HUGE_CREDIT });
      }
      for (const k of ['S1', 'A', 'C'] as const) {
        await seedWallet(admin, id(k), {
          currency: 'GBP',
          creditLimitMinor: HUGE_CREDIT,
          status: k === 'C' ? 'suspended' : 'active',
        });
        await seedWallet(admin, id(k), {
          currency: 'CHF',
          creditLimitMinor: k === 'C' ? 1_000 : HUGE_CREDIT,
        });
        await seedWallet(admin, id(k), {
          currency: 'JPY',
          creditLimitMinor: k === 'S1' ? 0 : HUGE_CREDIT,
        });
      }
    });

    it('A sin cartera en la moneda: network_currency_not_enabled', async () => {
      const orderId = await openOrder('S1', 'P', { currency: 'EUR' });
      await expectRejected(
        retain(id('S1'), orderId, net.sellers.S1),
        'network_currency_not_enabled',
        orderId,
        'EUR',
      );
    });

    it('C suspendida: network_funds_unavailable', async () => {
      const orderId = await openOrder('S1', 'P', { currency: 'GBP' });
      await expectRejected(
        retain(id('S1'), orderId, net.sellers.S1),
        'network_funds_unavailable',
        orderId,
        'GBP',
      );
    });

    it('C sin cupo: network_funds_unavailable', async () => {
      const orderId = await openOrder('S1', 'P', { currency: 'CHF' });
      await expectRejected(
        retain(id('S1'), orderId, net.sellers.S1),
        'network_funds_unavailable',
        orderId,
        'CHF',
      );
    });

    it('S1 sin fondos: primero decide su propia cartera (hold_funds_insufficient)', async () => {
      const orderId = await openOrder('S1', 'P', { currency: 'JPY' });
      await expectRejected(
        retain(id('S1'), orderId, net.sellers.S1),
        'hold_funds_insufficient',
        orderId,
        'JPY',
      );
    });

    it.each([
      ['la orden no guarda neto', null],
      ['el neto está en otra moneda', { netMinor: 100_000, currency: 'EUR' }],
      ['el neto no es un entero', { netMinor: '100000.5', currency: 'USD' }],
      ['el neto es cero', { netMinor: 0, currency: 'USD' }],
    ] as const)(
      'con la cadena no vacía, %s: network_cost_unavailable (nunca el precio de venta)',
      async (_label, pricing) => {
        const orderId = await openOrder('S1', 'P', { pricing });
        await expectRejected(
          retain(id('S1'), orderId, net.sellers.S1),
          'network_cost_unavailable',
          orderId,
          'USD',
        );
      },
    );
  });

  describe('ciclo de vida (wallet_hold_settle y la captura)', () => {
    it('pendiente: la retención se mantiene; con otra expectativa, hold_release_order_open', async () => {
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      expect(await settle(id('S1'), orderId, net.sellers.S1)).toBe('open');
      const e = await failure(settle(id('S1'), orderId, net.sellers.S1, 'failed'));
      expect({ code: e.code, constraint: e.constraint }).toEqual({
        code: 'STW01',
        constraint: 'hold_release_order_open',
      });
      await closeFailed(id('S1'), orderId, net.sellers.S1);
    });

    it('confirmar la orden captura toda la cascada sin mover saldo', async () => {
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      const held = await balances('USD');

      await as({ tenantId: id('S1') }, (c) =>
        c.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderId]),
      );

      expect(await balances('USD')).toEqual(held);
      expect(await group(orderId)).toMatchObject({ status: 'captured' });
      expect((await levels(orderId)).map((l) => l.status)).toEqual([
        'captured',
        'captured',
        'captured',
      ]);
      expect(
        (await events(orderId, 'portfolio.hold.captured')).map((e) => [e.tenant_id, e.actor]),
      ).toEqual([
        [id('S1'), null],
        [id('A'), null],
        [id('C'), null],
      ]);
      expect(await settle(id('S1'), orderId, net.sellers.S1)).toBe('already-captured');

      // Figuró confirmada y después no realizada: conflicto, sin liberar.
      await setStatus(orderId, 'failed');
      expect(await settle(id('S1'), orderId, net.sellers.S1, 'failed')).toBe('conflict');
      expect(await balances('USD')).toEqual(held);
      expect(await group(orderId)).toMatchObject({ status: 'conflict' });
      expect((await levels(orderId)).map((l) => l.status)).toEqual([
        'conflict',
        'conflict',
        'conflict',
      ]);
      // Cada dueño de cartera tiene el rastro de su cupo congelado; el actor, sólo en depth 0.
      expect(
        (await events(orderId, 'portfolio.hold.conflict')).map((e) => [
          e.tenant_id,
          e.actor,
          e.payload['cause'],
          e.payload['status'],
        ]),
      ).toEqual([
        [id('S1'), net.sellers.S1, 'failed_after_capture', 'conflict'],
        [id('A'), null, 'failed_after_capture', 'conflict'],
        [id('C'), null, 'failed_after_capture', 'conflict'],
      ]);
      expect(await settle(id('S1'), orderId, net.sellers.S1)).toBe('conflict');
    });

    it('una confirmación retractada (vuelve a pending) devuelve la retención a held; si después falla, se libera', async () => {
      const before = await balances('USD');
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      await setStatus(orderId, 'confirmed');
      expect(await group(orderId)).toMatchObject({ status: 'captured' });

      // Lo que hace markPending cuando la lectura de cierre contradice al proveedor.
      await setStatus(orderId, 'pending');
      expect(await group(orderId)).toMatchObject({ status: 'held', captured_at: null });
      expect((await levels(orderId)).map((l) => l.status)).toEqual(['held', 'held', 'held']);
      expect(
        (await events(orderId, 'portfolio.hold.uncaptured')).map((e) => [
          e.tenant_id,
          e.actor,
          e.payload['previousOrderStatus'],
        ]),
      ).toEqual([
        [id('S1'), null, 'confirmed'],
        [id('A'), null, 'confirmed'],
        [id('C'), null, 'confirmed'],
      ]);
      expect(await settle(id('S1'), orderId, net.sellers.S1)).toBe('open');

      expect(await closeFailed(id('S1'), orderId, net.sellers.S1)).toBe('released');
      expect(await balances('USD')).toEqual(before);
    });

    it('cancelar después de capturar libera el 100 % en todos los niveles', async () => {
      const before = await balances('USD');
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      await setStatus(orderId, 'confirmed');
      await setStatus(orderId, 'cancelled');
      expect(await settle(id('S1'), orderId, net.sellers.S1, 'cancelled')).toBe('released');
      expect(await balances('USD')).toEqual(before);
      const { rows } = await admin.query<{ notes: string }>(
        `SELECT notes FROM portfolio_transactions
          WHERE lower(reference_id) = lower($1) AND transaction_type LIKE '%_RELEASED'
          ORDER BY transaction_type, notes`,
        [orderId],
      );
      expect(rows.map((r) => r.notes)).toEqual([
        'Cancelación confirmada por el proveedor; saldo retenido liberado',
        'Reserva de tu red cancelada; retención liberada',
        'Reserva de tu red cancelada; retención liberada',
      ]);
    });

    it('la retención manual de una orden confirmada nace capturada', async () => {
      const before = await balances('USD');
      const orderId = await openOrder('S1', 'P', { status: 'confirmed' });
      const out = await retain(id('S1'), orderId, net.sellers.S1);
      expect(out.network_levels).toBe(2);
      expect(await group(orderId)).toMatchObject({ status: 'captured' });
      const { rows } = await admin.query<{ notes: string }>(
        'SELECT notes FROM portfolio_transactions WHERE id = $1',
        [out.own_transaction_id],
      );
      expect(rows[0]!.notes).toBe('Retención preventiva de saldo por reserva pendiente de emisión');
      await setStatus(orderId, 'cancelled');
      expect(await settle(id('S1'), orderId, net.sellers.S1, 'cancelled')).toBe('released');
      expect(await balances('USD')).toEqual(before);
    });

    it('una orden sin retención da no-hold; una cerrada no retiene; una retenida no retiene dos veces', async () => {
      const failed = await openOrder('S1', 'P', { status: 'failed' });
      expect(await settle(id('S1'), failed, net.sellers.S1)).toBe('no-hold');
      const notHoldable = await failure(retain(id('S1'), failed, net.sellers.S1));
      expect(notHoldable.constraint).toBe('hold_order_not_holdable');

      const withOutcome = await openOrder('S1', 'P');
      await admin.query(`UPDATE orders SET provider_raw = '{}'::jsonb WHERE id = $1`, [
        withOutcome,
      ]);
      expect((await failure(retain(id('S1'), withOutcome, net.sellers.S1))).constraint).toBe(
        'hold_order_not_holdable',
      );

      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      const twice = await failure(retain(id('S1'), orderId, net.sellers.S1));
      expect({ code: twice.code, constraint: twice.constraint }).toEqual({
        code: 'STW01',
        constraint: 'hold_already_exists',
      });
      await closeFailed(id('S1'), orderId, net.sellers.S1);
    });

    it('un total o una moneda inválidos: hold_amount_invalid', async () => {
      const orderId = await openOrder('S1', 'P', { currency: 'US1' });
      const e = await failure(retain(id('S1'), orderId, net.sellers.S1));
      expect({ code: e.code, constraint: e.constraint }).toEqual({
        code: 'STW01',
        constraint: 'hold_amount_invalid',
      });
    });
  });

  describe('liberar es reentrante y no exige cartera activa', () => {
    /** Un asiento de liberación escrito por fuera de settle (un estado a medias o del código viejo). */
    async function strayRelease(
      tenantId: string,
      orderId: string,
      type: 'BOOKING_RELEASED' | 'NETWORK_RELEASED',
      amount: number,
      moveBalance: boolean,
    ): Promise<void> {
      const { rows } = await admin.query<{ id: string }>(
        `SELECT id FROM agency_portfolios WHERE tenant_id = $1 AND currency = 'USD'`,
        [tenantId],
      );
      await admin.query(
        `INSERT INTO portfolio_transactions
           (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [rows[0]!.id, amount, type, orderId, net.sellers.S1],
      );
      if (moveBalance) {
        await admin.query(
          'UPDATE agency_portfolios SET balance_minor = balance_minor + $2 WHERE id = $1',
          [rows[0]!.id, amount],
        );
      }
    }

    it('una liberación a medias se enlaza y el resto se libera, sin acreditar dos veces', async () => {
      const before = await balances('USD');
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      await strayRelease(id('A'), orderId, 'NETWORK_RELEASED', 113_400, true);

      expect(await closeFailed(id('S1'), orderId, net.sellers.S1)).toBe('released');
      expect(await balances('USD')).toEqual(before);
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM portfolio_transactions
          WHERE lower(reference_id) = lower($1) AND transaction_type = 'NETWORK_RELEASED'`,
        [orderId],
      );
      expect(rows[0]!.n).toBe('2');
    });

    it('una liberación que no casa con lo retenido deja la retención en conflicto, sin mover saldo', async () => {
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      await strayRelease(id('C'), orderId, 'NETWORK_RELEASED', 1, false);
      const held = await balances('USD');

      expect(await closeFailed(id('S1'), orderId, net.sellers.S1)).toBe('conflict');
      expect(await balances('USD')).toEqual(held);
      expect(await group(orderId)).toMatchObject({ status: 'conflict' });
      const conflict = await events(orderId, 'portfolio.hold.conflict');
      expect(conflict.map((e) => [e.tenant_id, e.payload['cause']])).toEqual([
        [id('S1'), 'release_mismatch'],
        [id('A'), 'release_mismatch'],
        [id('C'), 'release_mismatch'],
      ]);
    });

    it('devuelve aunque quien financia haya suspendido la cartera', async () => {
      const before = await balances('USD');
      const orderId = await openOrder('S1', 'P');
      await retain(id('S1'), orderId, net.sellers.S1);
      await admin.query(
        `UPDATE agency_portfolios SET status = 'suspended' WHERE tenant_id = $1 AND currency = 'USD'`,
        [id('C')],
      );
      try {
        expect(await closeFailed(id('S1'), orderId, net.sellers.S1)).toBe('released');
        expect(await balances('USD')).toEqual(before);
      } finally {
        await admin.query(
          `UPDATE agency_portfolios SET status = 'active' WHERE tenant_id = $1 AND currency = 'USD'`,
          [id('C')],
        );
      }
    });

    it('una devolución que dejaría el saldo fuera de rango no se escribe: hold_release_out_of_range', async () => {
      const orderId = await openOrder('B', 'P');
      await retain(id('B'), orderId, net.sellers.B);
      const retained = (await balances('USD')).get(id('B'))!;
      await admin.query(
        `UPDATE agency_portfolios SET balance_minor = 9007199254740991
          WHERE tenant_id = $1 AND currency = 'USD'`,
        [id('B')],
      );
      try {
        await setStatus(orderId, 'failed');
        const e = await failure(settle(id('B'), orderId, net.sellers.B, 'failed'));
        expect({ code: e.code, constraint: e.constraint }).toEqual({
          code: 'STW01',
          constraint: 'hold_release_out_of_range',
        });
        expect(await group(orderId)).toMatchObject({ status: 'held' });
      } finally {
        await admin.query(
          `UPDATE agency_portfolios SET balance_minor = $2
            WHERE tenant_id = $1 AND currency = 'USD'`,
          [id('B'), retained],
        );
      }
      expect(await settle(id('B'), orderId, net.sellers.B, 'failed')).toBe('released');
      expect((await balances('USD')).get(id('B'))).toBe(retained + saleOf('B'));
    });
  });

  describe('la instantánea: liberar recorre lo registrado', () => {
    it('desactivar la cuenta después de retener no cambia dónde se devuelve', async () => {
      const before = await balances('USD');
      const orderId = await openOrder('S1', 'C');
      await retain(id('S1'), orderId, net.sellers.S1);
      await admin.query(`UPDATE provider_accounts SET status = 'disabled' WHERE id = $1`, [
        net.accounts.C,
      ]);
      try {
        // Con la cuenta inactiva, una reserva nueva con ella falla cerrado…
        const other = await openOrder('S1', 'C');
        const e = await failure(retain(id('S1'), other, net.sellers.S1));
        expect({ code: e.code, constraint: e.constraint }).toEqual({
          code: 'STW01',
          constraint: 'hold_owner_unresolvable',
        });
        // …y la ya retenida se libera en S1 y A, como se registró.
        expect(await closeFailed(id('S1'), orderId, net.sellers.S1)).toBe('released');
        expect(await balances('USD')).toEqual(before);
      } finally {
        await admin.query(`UPDATE provider_accounts SET status = 'active' WHERE id = $1`, [
          net.accounts.C,
        ]);
      }
    });

    it('mover al vendedor después de retener devuelve en las carteras originales; STH02 lo frena mientras la orden está abierta', async () => {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
         VALUES ($1::text, $1::text, 'CO', 'USD', 'subagency', $2) RETURNING id`,
        [`whc-s4-${sfx}`, id('A')],
      );
      const s4 = rows[0]!.id;
      extraTenants.push(s4);
      await admin.query(
        `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', 'active')`,
        [s4, net.sellers.A2],
      );
      await seedWallet(admin, s4, { creditLimitMinor: HUGE_CREDIT });
      const before = await balances('USD');

      const orderId = await openOrder('S1', 'P', { tenantId: s4, userId: net.sellers.A2 });
      await retain(s4, orderId, net.sellers.A2);

      const blocked = await failure(
        admin.query('SELECT move_tenant_subtree($1, $2)', [s4, id('A2')]),
      );
      expect({ code: blocked.code, constraint: blocked.constraint }).toEqual({
        code: 'STH02',
        constraint: 'tenant_move_open_wallet_bookings',
      });

      await setStatus(orderId, 'failed');
      await admin.query('SELECT move_tenant_subtree($1, $2)', [s4, id('A2')]);
      expect(await settle(s4, orderId, net.sellers.A2, 'failed')).toBe('released');
      // Volvió a S4, A y C; A2, su nuevo padre, no se tocó.
      expect(await balances('USD')).toEqual(before);
    });

    it('una retención en conflicto frena a move_tenant_subtree aunque la orden ya no esté activa', async () => {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
         VALUES ($1::text, $1::text, 'CO', 'USD', 'subagency', $2) RETURNING id`,
        [`whc-s5-${sfx}`, id('A')],
      );
      const s5 = rows[0]!.id;
      extraTenants.push(s5);
      await admin.query(
        `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', 'active')`,
        [s5, net.sellers.A2],
      );
      await seedWallet(admin, s5, { creditLimitMinor: HUGE_CREDIT });

      // Figuró confirmada y después no realizada: la plata queda congelada en s5, A y C.
      const orderId = await openOrder('S1', 'P', { tenantId: s5, userId: net.sellers.A2 });
      await retain(s5, orderId, net.sellers.A2);
      await setStatus(orderId, 'confirmed');
      await setStatus(orderId, 'failed');
      expect(await settle(s5, orderId, net.sellers.A2, 'failed')).toBe('conflict');

      const blocked = await failure(
        admin.query('SELECT move_tenant_subtree($1, $2)', [s5, id('A2')]),
      );
      expect({ code: blocked.code, constraint: blocked.constraint }).toEqual({
        code: 'STH02',
        constraint: 'tenant_move_open_wallet_bookings',
      });
    });
  });

  describe('los modos (wallet_hold_policy)', () => {
    async function policy(key: NodeKey, mode: 'off' | 'observe' | 'enforce'): Promise<void> {
      await admin.query(
        `INSERT INTO wallet_hold_policy (tenant_id, mode, reason) VALUES ($1, $2, 'prueba 0060')
         ON CONFLICT (tenant_id) DO UPDATE SET mode = EXCLUDED.mode`,
        [id(key), mode],
      );
    }
    async function clearPolicies(): Promise<void> {
      await admin.query('DELETE FROM wallet_hold_policy WHERE tenant_id = ANY($1::uuid[])', [
        net.tenants,
      ]);
    }

    it('off: retiene sólo quien vende', async () => {
      await policy('C', 'off');
      try {
        const orderId = await openOrder('S1', 'P');
        const out = await retain(id('S1'), orderId, net.sellers.S1);
        expect(out).toMatchObject({ network_levels: 0, mode: 'off' });
        expect((await levels(orderId)).map((l) => l.depth)).toEqual([0]);
        await closeFailed(id('S1'), orderId, net.sellers.S1);
      } finally {
        await clearPolicies();
      }
    });

    it('observe: retiene quien vende y avisa en cada nivel que habría rechazado, sin tocar su cartera', async () => {
      await seedWallet(admin, id('S1'), { currency: 'SEK', creditLimitMinor: HUGE_CREDIT });
      await policy('A', 'observe');
      try {
        const orderId = await openOrder('S1', 'P', { currency: 'SEK' });
        const out = await retain(id('S1'), orderId, net.sellers.S1);
        expect(out).toMatchObject({ network_levels: 0, mode: 'observe' });
        const warned = await events(orderId, 'portfolio.network_hold.would_block');
        expect(
          warned.map((e) => [e.tenant_id, e.actor, e.payload['depth'], e.payload['reason']]),
        ).toEqual([
          [id('A'), null, 1, 'network_currency_not_enabled'],
          [id('C'), null, 2, 'network_currency_not_enabled'],
        ]);
        expect(warned[0]!.payload['amountMinor']).toBe(113_400);
        await closeFailed(id('S1'), orderId, net.sellers.S1);
      } finally {
        await clearPolicies();
      }
    });

    it('entre observe y enforce manda la fila del ancestro-o-igual más cercano', async () => {
      await policy('C', 'observe');
      await policy('A', 'enforce');
      try {
        const orderId = await openOrder('S1', 'P');
        expect(await retain(id('S1'), orderId, net.sellers.S1)).toMatchObject({
          network_levels: 2,
          mode: 'enforce',
        });
        await closeFailed(id('S1'), orderId, net.sellers.S1);
      } finally {
        await clearPolicies();
      }
    });

    it('un off más arriba gana aunque la red tenga su propia fila enforce (el kill-switch)', async () => {
      await policy('C', 'off');
      await policy('A', 'enforce');
      try {
        const orderId = await openOrder('S1', 'P');
        expect(await retain(id('S1'), orderId, net.sellers.S1)).toMatchObject({
          network_levels: 0,
          mode: 'off',
        });
        await closeFailed(id('S1'), orderId, net.sellers.S1);
      } finally {
        await clearPolicies();
      }
    });

    it('off no exige que la cuenta de la orden se resuelva: retiene sólo quien vende', async () => {
      await policy('C', 'off');
      await admin.query(`UPDATE provider_accounts SET status = 'disabled' WHERE id = $1`, [
        net.accounts.C,
      ]);
      try {
        const before = await balances('USD');
        const orderId = await openOrder('S1', 'C', { status: 'confirmed' });
        expect(await retain(id('S1'), orderId, net.sellers.S1)).toMatchObject({
          network_levels: 0,
          mode: 'off',
        });
        expect(await group(orderId)).toMatchObject({
          credential_source: 'unresolved',
          credential_owner_tenant_id: null,
          status: 'captured',
        });
        expect(
          await preview(id('S1'), {
            account: net.accounts.C,
            currency: 'USD',
            sale: saleOf('S1'),
            net: 100_000,
          }),
        ).toEqual({ status: 'ok', reason: null });
        await setStatus(orderId, 'cancelled');
        expect(await settle(id('S1'), orderId, net.sellers.S1, 'cancelled')).toBe('released');
        expect(await balances('USD')).toEqual(before);
      } finally {
        await admin.query(`UPDATE provider_accounts SET status = 'active' WHERE id = $1`, [
          net.accounts.C,
        ]);
        await clearPolicies();
      }
    });

    it('cada cambio de modo deja su rastro de plataforma, con el actor y la razón de ESE cambio', async () => {
      const op1 = net.admins.P;
      const op2 = net.admins.A2;
      type Trace = [
        string | null,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        string | null,
        unknown,
      ];
      const seen = new Set<string>();

      /** El evento que dejó el último cambio (uno solo), sin los de otros tests sobre C. */
      async function lastTrace(): Promise<Trace[]> {
        const { rows } = await admin.query<{
          id: string;
          tenant_id: string | null;
          actor: string | null;
          payload: Record<string, unknown>;
        }>(
          `SELECT id, tenant_id, actor_user_id AS actor, payload FROM domain_events
            WHERE aggregate_type = 'tenant' AND aggregate_id = $1
              AND event_type = 'wallet_hold.policy_changed'`,
          [id('C')],
        );
        const fresh = rows.filter((r) => !seen.has(r.id));
        for (const r of fresh) seen.add(r.id);
        return fresh.map((r) => [
          r.tenant_id,
          r.payload['targetTenantId'],
          r.payload['operation'],
          r.payload['mode'] ?? null,
          r.payload['previousMode'] ?? null,
          r.payload['effectiveMode'],
          r.actor,
          r.payload['reason'] ?? null,
        ]);
      }

      async function change(
        sql: string,
        params: unknown[],
        guc: Record<string, string> = {},
      ): Promise<Trace[]> {
        const c = await admin.connect();
        try {
          await c.query('BEGIN');
          for (const [k, v] of Object.entries(guc)) {
            await c.query('SELECT set_config($1, $2, true)', [k, v]);
          }
          await c.query(sql, params);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
        return lastTrace();
      }
      const insert = `INSERT INTO wallet_hold_policy (tenant_id, mode, reason, updated_by)
                      VALUES ($1, 'observe', 'op1', $2)`;
      const del = 'DELETE FROM wallet_hold_policy WHERE tenant_id = $1';
      const C = id('C');

      await lastTrace();
      expect(await change(insert, [C, op1])).toEqual([
        [null, C, 'insert', 'observe', null, 'observe', op1, 'op1'],
      ]);

      // El upsert natural, sin updated_by ni razón nueva: el rastro no se lo atribuye a op1.
      await policy('C', 'off');
      expect(await lastTrace()).toEqual([[null, C, 'update', 'off', 'observe', 'off', null, null]]);

      expect(
        await change(`UPDATE wallet_hold_policy SET mode = 'enforce' WHERE tenant_id = $1`, [C], {
          'wallet_hold.actor': op2,
        }),
      ).toEqual([[null, C, 'update', 'enforce', 'off', 'enforce', op2, null]]);

      expect(
        await change(del, [C], {
          'wallet_hold.actor': op2,
          'wallet_hold.reason': 'fin de la prueba',
        }),
      ).toEqual([[null, C, 'delete', null, 'enforce', 'enforce', op2, 'fin de la prueba']]);

      // Borrar sin declararse: nunca el autor ni la razón de la fila borrada.
      await change(insert, [C, op1]);
      expect(await change(del, [C])).toEqual([
        [null, C, 'delete', null, 'observe', 'enforce', null, null],
      ]);
    });
  });

  describe('el aviso al ancestro y el anticipo', () => {
    it('report_block deja un solo aviso en el primer nivel que bloquea', async () => {
      const orderId = await openOrder('S1', 'P', { currency: 'EUR' });
      await failure(retain(id('S1'), orderId, net.sellers.S1));
      for (let i = 0; i < 2; i++) {
        await as({ tenantId: id('S1') }, (c) =>
          c.query('SELECT wallet_hold_report_block($1::uuid)', [orderId]),
        );
      }
      const blocked = await events(orderId, 'portfolio.network_hold.blocked');
      expect(
        blocked.map((e) => [e.tenant_id, e.actor, e.payload['depth'], e.payload['reason']]),
      ).toEqual([[id('A'), null, 1, 'network_currency_not_enabled']]);
    });

    it('report_block no deja nada si la red no bloquea o si la orden no es del nodo', async () => {
      const passes = await openOrder('S1', 'P');
      await as({ tenantId: id('S1') }, (c) =>
        c.query('SELECT wallet_hold_report_block($1::uuid)', [passes]),
      );
      const foreign = await openOrder('S1', 'P', { currency: 'EUR' });
      await as({ tenantId: id('S2') }, (c) =>
        c.query('SELECT wallet_hold_report_block($1::uuid)', [foreign]),
      );
      expect(await events(passes, 'portfolio.network_hold.blocked')).toEqual([]);
      expect(await events(foreign, 'portfolio.network_hold.blocked')).toEqual([]);
    });

    it.each([
      ['S1 en USD con la cuenta de P', 'S1', 'P', 'USD', 100_000],
      ['A sin EUR', 'S1', 'P', 'EUR', 100_000],
      ['C suspendida en GBP', 'S1', 'P', 'GBP', 100_000],
      ['S1 sin fondos en JPY', 'S1', 'P', 'JPY', 100_000],
      ['sin neto con cadena', 'S1', 'P', 'USD', null],
      ['sin neto y sin cadena', 'B', 'P', 'USD', null],
    ] as const)(
      'preview dice lo mismo que retain: %s',
      async (_label, seller, owner, currency, net_) => {
        const p = await preview(id(seller), {
          account: accountOf(owner),
          currency,
          sale: saleOf(seller),
          net: net_,
        });
        const orderId = await openOrder(seller, owner, {
          currency,
          pricing: net_ === null ? null : { netMinor: net_, currency },
        });
        let outcome: { status: string; reason: string | null };
        try {
          await retain(id(seller), orderId, net.sellers[seller]);
          outcome = { status: 'ok', reason: null };
          await closeFailed(id(seller), orderId, net.sellers[seller]);
        } catch (err) {
          outcome = { status: 'blocked', reason: (err as PgFailure).constraint ?? '?' };
        }
        expect(p).toEqual(outcome);
      },
    );

    it('preview no sabe (unknown) con una cuenta ajena a la red o parámetros inválidos', async () => {
      const base = { account: null, currency: 'USD', sale: 1_000, net: 1_000 };
      expect(await preview(id('A2'), { ...base, account: net.accounts.A })).toEqual({
        status: 'unknown',
        reason: null,
      });
      expect(
        await preview(id('S1'), { ...base, account: net.accounts.C, provider: 'otro' }),
      ).toEqual({ status: 'unknown', reason: null });
      expect(await preview(id('S1'), { ...base, currency: 'usd' })).toMatchObject({
        status: 'unknown',
      });
      expect(await preview(id('S1'), { ...base, sale: 0 })).toMatchObject({ status: 'unknown' });
      expect(await preview(id('S1'), { ...base, net: -5 })).toMatchObject({ status: 'unknown' });
      expect(await preview(id('S1'), { ...base, vertical: 'Hotels' })).toMatchObject({
        status: 'unknown',
      });
    });
  });

  describe('el cupo de la red se agota de a una reserva', () => {
    it('S1 y S2 comparten el cupo de C: la segunda no entra hasta que se libera la primera', async () => {
      for (const k of ['S1', 'S2', 'A'] as const) {
        await seedWallet(admin, id(k), { currency: 'NOK', creditLimitMinor: HUGE_CREDIT });
      }
      // El costo de C es 105.000: le alcanza para una y media.
      await seedWallet(admin, id('C'), { currency: 'NOK', creditLimitMinor: 157_500 });

      const first = await openOrder('S1', 'P', { currency: 'NOK' });
      await retain(id('S1'), first, net.sellers.S1);

      const second = await openOrder('S2', 'P', { currency: 'NOK' });
      await expectRejected(
        retain(id('S2'), second, net.sellers.S2),
        'network_funds_unavailable',
        second,
        'NOK',
      );

      await closeFailed(id('S1'), first, net.sellers.S1);
      expect(await retain(id('S2'), second, net.sellers.S2)).toMatchObject({ network_levels: 2 });
      expect((await balances('NOK')).get(id('C'))).toBe(-105_000);
      await closeFailed(id('S2'), second, net.sellers.S2);
    });
  });
});
