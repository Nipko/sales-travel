import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foldDisclosure, type DisclosureNode } from './provider-disclosure.policy.js';

/**
 * El recorrido de la jerarquía, contra base de verdad. Requiere la migración 0036; se SALTA
 * sin PGHOST.
 *
 * Los tests de la política prueban el plegado con cadenas escritas a mano. Lo que no se puede
 * probar sin base es que `provider_disclosure_chain` devuelva EXACTAMENTE los ancestros del
 * tenant —ni uno de otra red, ni faltando el consolidador—, que es de lo que depende que el
 * "oculto" de arriba llegue abajo.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('provider_disclosure_chain (0036)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  let consolidador: string;
  let agencia: string;
  let sub: string;
  let otraRed: string;

  async function tenant(slug: string, type: string, parent: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text,$1::text,'CO','COP',$2,$3) RETURNING id`,
      [slug, type, parent],
    );
    return rows[0]!.id;
  }

  async function setValue(tenantId: string, value: boolean | null): Promise<void> {
    await pool.query('UPDATE tenants SET show_provider_in_results = $2 WHERE id = $1', [
      tenantId,
      value,
    ]);
  }

  async function chain(tenantId: string): Promise<DisclosureNode[]> {
    const { rows } = await pool.query<{
      tenant_id: string;
      lvl: number;
      show_provider_in_results: boolean | null;
    }>('SELECT * FROM provider_disclosure_chain($1::uuid)', [tenantId]);
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      depth: Number(r.lvl),
      showProviderInResults: r.show_provider_in_results,
    }));
  }

  beforeAll(async () => {
    consolidador = await tenant(`pd-cons-${sfx}`, 'consolidator', null);
    agencia = await tenant(`pd-ag-${sfx}`, 'agency', consolidador);
    sub = await tenant(`pd-sub-${sfx}`, 'subagency', agencia);
    otraRed = await tenant(`pd-otra-${sfx}`, 'consolidator', null);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`pd-%-${sfx}`]);
    await pool.end();
  });

  it('devuelve la rama entera del tenant, de la raíz hacia abajo', async () => {
    const nodos = await chain(sub);
    expect(nodos.map((n) => n.tenantId)).toEqual([consolidador, agencia, sub]);
  });

  it('no arrastra tenants de otra red', async () => {
    const nodos = await chain(sub);
    expect(nodos.map((n) => n.tenantId)).not.toContain(otraRed);
  });

  it('el "oculto" del consolidador llega hasta la sub-agencia que pidió mostrarlo', async () => {
    await setValue(consolidador, false);
    await setValue(agencia, null);
    await setValue(sub, true);

    const view = foldDisclosure(sub, await chain(sub));
    expect(view.effective).toBe(false);
    expect(view.lockedByAncestor).toBe(true);
  });

  it('encendido arriba y sin nada abajo, la sub-agencia lo hereda encendido', async () => {
    await setValue(consolidador, true);
    await setValue(agencia, null);
    await setValue(sub, null);

    const view = foldDisclosure(sub, await chain(sub));
    expect(view.effective).toBe(true);
    expect(view.own).toBeNull();
  });

  it('un consolidador suspendido sigue contando: su "oculto" no se cae con él', async () => {
    await setValue(consolidador, false);
    await setValue(sub, null);
    await pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [consolidador]);

    try {
      const view = foldDisclosure(sub, await chain(sub));
      expect(view.effective).toBe(false);
    } finally {
      await pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [consolidador]);
    }
  });

  it('sin nadie configurado en la rama, la cadena no opina y el default decide', async () => {
    await setValue(consolidador, null);
    await setValue(agencia, null);
    await setValue(sub, null);

    const nodos = await chain(sub);
    expect(nodos.every((n) => n.showProviderInResults === null)).toBe(true);
    expect(foldDisclosure(sub, nodos).effective).toBe(false);
  });
});
