import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Test de integración del modelo CONSOLIDADOR (jerarquía + BYOC con herencia).
 * Requiere una base de datos con las migraciones 0011 y 0012 aplicadas.
 * Se SALTA automáticamente si no hay PGHOST (p. ej. CI sin DB). Para correrlo:
 *   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... pnpm --filter @sales-travel/api test
 *
 * Conecta como el usuario privilegiado (owner) sólo para sembrar datos y llamar a
 * la función SECURITY DEFINER `resolve_provider_account`. La validación de aislamiento
 * cross-tenant vía RLS (app_user NOBYPASSRLS) se cubre con el mismo mecanismo de
 * policy que el resto de tablas tenant-scoped (ver migración 0012).
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('consolidator hierarchy + BYOC resolution', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  const enc = Buffer.from('not-a-real-secret'); // credentials_enc es BYTEA NOT NULL; el contenido no importa aquí
  const PROV = `test-prov-${sfx}`;
  let consolidatorId: string;
  let agencyId: string;
  let subagencyId: string;

  async function createTenant(
    slug: string,
    type: string,
    parentId: string | null,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, type, parentId],
    );
    return rows[0]!.id;
  }

  async function addAccount(tenantId: string, inheritable: boolean, label: string): Promise<void> {
    await pool.query(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, is_inheritable, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [tenantId, PROV, label, enc, inheritable],
    );
  }

  async function resolveOwner(tenantId: string): Promise<string | null> {
    const { rows } = await pool.query<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM resolve_provider_account($1::uuid, $2)`,
      [tenantId, PROV],
    );
    return rows[0]?.tenant_id ?? null;
  }

  beforeAll(async () => {
    consolidatorId = await createTenant(`cons-${sfx}`, 'consolidator', null);
    agencyId = await createTenant(`ag-${sfx}`, 'agency', consolidatorId);
    subagencyId = await createTenant(`sub-${sfx}`, 'subagency', agencyId);
  });

  afterAll(async () => {
    // ON DELETE RESTRICT en parent_tenant_id ⇒ borrar de hoja a raíz.
    for (const id of [subagencyId, agencyId, consolidatorId]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await pool.end();
  });

  it('builds a 3-level path consolidator → agency → subagency', async () => {
    const { rows } = await pool.query<{ depth: number }>(
      `SELECT nlevel(path) AS depth FROM tenants WHERE id = $1`,
      [subagencyId],
    );
    expect(Number(rows[0]!.depth)).toBe(3);
  });

  it("resolves a tenant's OWN account when present", async () => {
    await addAccount(consolidatorId, true, 'c');
    await addAccount(agencyId, false, 'a'); // own but NOT inheritable by descendants
    expect(await resolveOwner(agencyId)).toBe(agencyId);
    expect(await resolveOwner(consolidatorId)).toBe(consolidatorId);
  });

  it('inherits the nearest INHERITABLE ancestor, skipping a non-inheritable one', async () => {
    // subagency has no own account; agency's is non-inheritable ⇒ falls back to consolidator.
    expect(await resolveOwner(subagencyId)).toBe(consolidatorId);
  });

  it('prefers the OWN account over any inherited one', async () => {
    await addAccount(subagencyId, false, 's');
    expect(await resolveOwner(subagencyId)).toBe(subagencyId);
  });

  it('returns no row when nothing is resolvable', async () => {
    const { rows } = await pool.query<{ id: string | null }>(
      `SELECT id FROM resolve_provider_account($1::uuid, $2)`,
      [consolidatorId, `missing-${sfx}`],
    );
    expect(rows[0]?.id ?? null).toBeNull();
  });

  it('enforces the 4-level depth limit', async () => {
    const l4 = await createTenant(`l4-${sfx}`, 'subagency', subagencyId); // depth 4 ok
    await expect(
      createTenant(`l5-${sfx}`, 'subagency', l4), // depth 5 → rejected
    ).rejects.toThrow();
    await pool.query('DELETE FROM tenants WHERE id = $1', [l4]);
  });
});
