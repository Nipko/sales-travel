import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Valida la tabla order_operations (migración 0021): inserción de operaciones de post-venta y
 * listado por orden (más reciente primero). Se SALTA sin PGHOST; corre en el harness de CI.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('order_operations (post-venta durable)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  let tenantId: string;
  let userId: string;
  let orderId: string;

  beforeAll(async () => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency) VALUES ($1::text,$1::text,'CO','COP') RETURNING id`,
      [`op-${sfx}`],
    );
    tenantId = t.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`op-${sfx}@test.local`],
    );
    userId = u.rows[0]!.id;
    const o = await pool.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, search_criteria, selected_offer, passengers, contact_info, total_amount, order_number, status)
       VALUES ($1,$2,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb, 1000, 1, 'confirmed') RETURNING id`,
      [tenantId, userId],
    );
    orderId = o.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]); // cascada orders/operations
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  it('inserts and lists post-sale operations (most recent first)', async () => {
    await pool.query(
      `INSERT INTO order_operations (tenant_id, order_id, type, status) VALUES ($1,$2,'cancel','failed')`,
      [tenantId, orderId],
    );
    await pool.query(
      `INSERT INTO order_operations (tenant_id, order_id, type, status, last_error) VALUES ($1,$2,'cancel','success',NULL)`,
      [tenantId, orderId],
    );
    const { rows } = await pool.query<{ type: string; status: string }>(
      `SELECT type, status FROM order_operations WHERE order_id = $1 ORDER BY created_at DESC`,
      [orderId],
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.type === 'cancel')).toBe(true);
    expect(rows.map((r) => r.status)).toContain('success');
    expect(rows.map((r) => r.status)).toContain('failed');
  });

  it('rejects an invalid status (CHECK constraint)', async () => {
    await expect(
      pool.query(
        `INSERT INTO order_operations (tenant_id, order_id, type, status) VALUES ($1,$2,'cancel','bogus')`,
        [tenantId, orderId],
      ),
    ).rejects.toThrow();
  });
});
