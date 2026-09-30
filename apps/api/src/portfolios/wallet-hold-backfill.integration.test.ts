import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Las retenciones anteriores a 0060 pasan a grupos 'legacy' de un solo nivel
 * (`wallet_hold_backfill_legacy`), sin débitos retroactivos, y siguen funcionando con
 * `wallet_hold_settle` y con STH02.
 *
 * Todo corre en UNA transacción de superusuario que se deshace al final: la función convierte
 * todas las retenciones sin grupo de la base, y en CI la base es compartida con los demás tests.
 *
 * Se salta sin base (PGHOST), como el resto de los tests de integración.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

interface PgFailure {
  readonly code?: string;
  readonly constraint?: string;
}

d('retenciones anteriores a 0060 → grupos legacy', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();

  afterAll(async () => {
    await admin.end();
  });

  it('convierte las enlazadas a su orden, una sola vez, y deja fuera las que no puede enlazar', async () => {
    const c = await admin.connect();
    let orderNumber = 1;
    const q = async <R extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
      (await c.query<R>(text, values)).rows;

    async function tenant(slug: string, type: string, parent: string): Promise<string> {
      const rows = await q<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
         VALUES ($1::text, $1::text, 'CO', 'USD', $2, $3) RETURNING id`,
        [`whb-${slug}-${sfx}`, type, parent],
      );
      return rows[0]!.id;
    }
    async function order(tenantId: string, userId: string, status: string): Promise<string> {
      const rows = await q<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer,
                             passengers, contact_info, total_amount, currency, order_number, status)
         VALUES ($1, $2, 'whb-prov', '{}', '{}', '[]', '{}', 5000, 'USD', $3, $4) RETURNING id`,
        [tenantId, userId, orderNumber++, status],
      );
      return rows[0]!.id;
    }
    async function entry(
      walletId: string,
      type: 'BOOKING_HOLD' | 'BOOKING_RELEASED',
      reference: string,
      userId: string,
    ): Promise<string> {
      const rows = await q<{ id: string }>(
        `INSERT INTO portfolio_transactions
           (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [walletId, type === 'BOOKING_HOLD' ? -5000 : 5000, type, reference, userId],
      );
      return rows[0]!.id;
    }

    try {
      await c.query('BEGIN');
      const platform = await platformRootId(c);
      const consolidator = await tenant('c', 'consolidator', platform);
      const agency = await tenant('a', 'agency', consolidator);
      const other = await tenant('o', 'agency', consolidator);
      const { id: seller } = (
        await q<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
          `whb-v-${sfx}@test.local`,
        ])
      )[0]!;
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', 'active')`,
        [agency, seller],
      );
      const wallets = await q<{ id: string; tenant_id: string }>(
        `INSERT INTO agency_portfolios (tenant_id, currency, balance_minor, credit_limit_minor)
         VALUES ($1, 'USD', -20000, 100000), ($2, 'USD', -5000, 100000), ($3, 'USD', 0, 100000)
         RETURNING id, tenant_id`,
        [agency, other, consolidator],
      );
      const wAgency = wallets.find((w) => w.tenant_id === agency)!.id;
      const wOther = wallets.find((w) => w.tenant_id === other)!.id;
      const wConsolidator = wallets.find((w) => w.tenant_id === consolidator)!.id;

      const pending = await order(agency, seller, 'pending');
      const confirmed = await order(agency, seller, 'confirmed');
      const released = await order(agency, seller, 'failed');
      const cancelled = await order(agency, seller, 'cancelled');
      const upper = await order(agency, seller, 'pending');
      const foreign = await order(agency, seller, 'pending');

      const holds = {
        pending: await entry(wAgency, 'BOOKING_HOLD', pending, seller),
        confirmed: await entry(wAgency, 'BOOKING_HOLD', confirmed, seller),
        released: await entry(wAgency, 'BOOKING_HOLD', released, seller),
        cancelled: await entry(wAgency, 'BOOKING_HOLD', cancelled, seller),
        upper: await entry(wAgency, 'BOOKING_HOLD', upper.toUpperCase(), seller),
        orphan: await entry(wAgency, 'BOOKING_HOLD', randomUUID(), seller),
        foreign: await entry(wOther, 'BOOKING_HOLD', foreign, seller),
      };
      const release = await entry(wAgency, 'BOOKING_RELEASED', released, seller);
      await c.query('UPDATE agency_portfolios SET balance_minor = -20000 WHERE id = $1', [wAgency]);

      const { n: first } = (
        await q<{ n: number }>('SELECT wallet_hold_backfill_legacy() AS n')
      )[0]!;
      expect(first).toBeGreaterThanOrEqual(5);

      const groups = await q<{
        order_id: string;
        status: string;
        mode: string;
        credential_source: string;
        sale_amount_minor: string;
        captured: boolean;
        closed: boolean;
      }>(
        `SELECT order_id, status, mode, credential_source, sale_amount_minor::text AS sale_amount_minor,
                captured_at IS NOT NULL AS captured, closed_at IS NOT NULL AS closed
           FROM wallet_hold_groups WHERE order_id = ANY($1::uuid[])`,
        [[pending, confirmed, released, cancelled, upper, foreign]],
      );
      const byOrder = new Map(groups.map((g) => [g.order_id, g]));
      const legacy = { mode: 'legacy', credential_source: 'legacy', sale_amount_minor: '5000' };
      expect(byOrder.get(pending)).toMatchObject({ ...legacy, status: 'held', captured: false });
      expect(byOrder.get(confirmed)).toMatchObject({
        ...legacy,
        status: 'captured',
        captured: true,
      });
      expect(byOrder.get(released)).toMatchObject({ ...legacy, status: 'released', closed: true });
      expect(byOrder.get(cancelled)).toMatchObject({ ...legacy, status: 'held' });
      expect(byOrder.get(upper)).toMatchObject({ ...legacy, status: 'held' });
      // La retención en la cartera de otro tenant no se enlaza a la orden.
      expect(byOrder.has(foreign)).toBe(false);

      const levels = await q<{
        order_id: string;
        depth: number;
        basis: string;
        hold_transaction_id: string;
        release_transaction_id: string | null;
      }>(
        `SELECT order_id, depth, basis, hold_transaction_id, release_transaction_id
           FROM wallet_hold_levels WHERE order_id = ANY($1::uuid[]) ORDER BY order_id`,
        [[pending, confirmed, released, cancelled, upper]],
      );
      expect(levels).toHaveLength(5);
      for (const l of levels)
        expect({ depth: l.depth, basis: l.basis }).toEqual({ depth: 0, basis: 'sale' });
      expect(levels.find((l) => l.order_id === released)).toMatchObject({
        hold_transaction_id: holds.released,
        release_transaction_id: release,
      });
      const converted = await q<{ id: string }>(
        'SELECT hold_transaction_id AS id FROM wallet_hold_levels WHERE hold_transaction_id = ANY($1::uuid[])',
        [[holds.orphan, holds.foreign]],
      );
      expect(converted).toHaveLength(0);

      // Nunca debita a los ancestros ni mueve saldos.
      const balances = await q<{ id: string; b: string }>(
        'SELECT id, balance_minor::text AS b FROM agency_portfolios WHERE id = ANY($1::uuid[])',
        [[wAgency, wOther, wConsolidator]],
      );
      expect(Object.fromEntries(balances.map((b) => [b.id, b.b]))).toEqual({
        [wAgency]: '-20000',
        [wOther]: '-5000',
        [wConsolidator]: '0',
      });

      // Idempotente: una segunda pasada no vuelve a convertir las de este test.
      await q('SELECT wallet_hold_backfill_legacy()');
      const again = await q<{ n: string }>(
        'SELECT count(*)::text AS n FROM wallet_hold_groups WHERE order_id = ANY($1::uuid[])',
        [[pending, confirmed, released, cancelled, upper, foreign]],
      );
      expect(again[0]!.n).toBe('5');

      // Un grupo legacy abierto sigue frenando el movimiento del nodo (STH02)…
      await c.query('SAVEPOINT move');
      let blocked: PgFailure | undefined;
      try {
        await c.query('SELECT move_tenant_subtree($1, $2)', [agency, platform]);
      } catch (err) {
        blocked = err as PgFailure;
      }
      await c.query('ROLLBACK TO SAVEPOINT move');
      expect(blocked).toMatchObject({
        code: 'STH02',
        constraint: 'tenant_move_open_wallet_bookings',
      });

      // …y wallet_hold_settle lo cierra como cualquier otro: la cancelada se libera en su cartera.
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [agency]);
      const { outcome } = (
        await q<{ outcome: string }>(
          'SELECT wallet_hold_settle($1::uuid, $2::uuid, $3) AS outcome',
          [cancelled, seller, 'cancelled'],
        )
      )[0]!;
      expect(outcome).toBe('released');
      const { outcome: open } = (
        await q<{ outcome: string }>('SELECT wallet_hold_settle($1::uuid, $2::uuid) AS outcome', [
          pending,
          seller,
        ])
      )[0]!;
      expect(open).toBe('open');
      const { b } = (
        await q<{ b: string }>(
          'SELECT balance_minor::text AS b FROM agency_portfolios WHERE id = $1',
          [wAgency],
        )
      )[0]!;
      expect(b).toBe('-15000');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
