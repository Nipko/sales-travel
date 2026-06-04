import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Verifica el pricing waterfall multinivel (compute_price_waterfall) contra Postgres real.
 * Requiere migraciones 0011 + 0016. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('pricing waterfall (compute_price_waterfall)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  let cons: string;
  let agency: string;
  let sub: string;

  async function tenant(slug: string, type: string, parent: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text,$1::text,'CO','COP',$2,$3) RETURNING id`,
      [slug, type, parent],
    );
    return rows[0]!.id;
  }
  async function rule(
    tenantId: string,
    vertical: string,
    type: string,
    value: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO markup_rules (tenant_id, vertical, rule_type, value_minor) VALUES ($1,$2,$3,$4)`,
      [tenantId, vertical, type, value],
    );
  }
  async function waterfall(tenantId: string, vertical: string, net: number) {
    const { rows } = await pool.query<{
      net_minor: string;
      final_minor: string;
      total_markup_minor: string;
      breakdown: unknown;
    }>(`SELECT * FROM compute_price_waterfall($1::uuid, $2, $3::bigint)`, [
      tenantId,
      vertical,
      net,
    ]);
    const r = rows[0]!;
    return {
      net: Number(r.net_minor),
      final: Number(r.final_minor),
      markup: Number(r.total_markup_minor),
      steps: (r.breakdown as unknown[]) ?? [],
    };
  }

  beforeAll(async () => {
    cons = await tenant(`pc-${sfx}`, 'consolidator', null);
    agency = await tenant(`pa-${sfx}`, 'agency', cons);
    sub = await tenant(`ps-${sfx}`, 'subagency', agency);
    await rule(cons, 'flights', 'percentage', 1000); // 10%
    await rule(agency, 'flights', 'percentage', 500); // 5%
    await rule(sub, 'flights', 'fixed', 2000); // +2000 minor
  });

  afterAll(async () => {
    for (const id of [sub, agency, cons]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]); // markup_rules cascade
    }
    await pool.end();
  });

  it('cascades ancestor→descendant: 100000 → +10% → +5% → +2000 = 117500', async () => {
    const w = await waterfall(sub, 'flights', 100000);
    expect(w.net).toBe(100000);
    expect(w.final).toBe(117500); // 100000 → 110000 → 115500 → 117500
    expect(w.markup).toBe(17500);
    expect(w.steps).toHaveLength(3);
  });

  it('applies only ancestors for an intermediate node (agency: just consolidator override)', async () => {
    const w = await waterfall(agency, 'flights', 100000);
    expect(w.final).toBe(115500); // 100000 → +10% (cons) → +5% (agency) = 115500; sub fixed NO aplica
    expect(w.steps).toHaveLength(2);
  });

  it('returns net unchanged when no rules match the vertical', async () => {
    const w = await waterfall(sub, 'hotels', 50000);
    expect(w.final).toBe(50000);
    expect(w.markup).toBe(0);
    expect(w.steps).toHaveLength(0);
  });
});
