import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Las funciones SQL que resuelven lo heredado en la red, contra Postgres migrado (plan de pruebas
 * SQL-05, SQL-06, AGE-08). Corren como `app_user`, como la API: son SECURITY DEFINER y leen nodos
 * ancestros que la RLS no le muestra a la agencia.
 *
 * Red: plataforma → consolidador C → agencia A → sub-agencia S, más una agencia hermana H bajo C.
 * SQL-06 suma el gobierno de proveedores y formas de pago (governance_chain, governance_bootstrap).
 * Nada se le cuelga a la raíz compartida (ver platform-root.ts).
 *
 * Se salta sin base (PGHOST), como los demás tests de integración.
 */
const hasDb = Boolean(process.env['PGHOST']);
const d = hasDb ? describe : describe.skip;

d('herencia en la red (SQL-05, SQL-06, AGE-08)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  const ids: Record<'C' | 'A' | 'S' | 'H', string> = { C: '', A: '', S: '', H: '' };

  async function nodo(
    slug: string,
    tipo: string,
    padre: string,
    extra: Record<string, string | null> = {},
  ): Promise<string> {
    const cols = Object.keys(extra);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id
                            ${cols.map((c) => `, ${c}`).join('')})
       VALUES ($1, $2, 'CO', 'COP', $3, $4 ${cols.map((_, i) => `, $${i + 5}`).join('')})
       RETURNING id`,
      [
        `red-${slug}-${sfx}`,
        `Legal ${slug.toUpperCase()} ${sfx}`,
        tipo,
        padre,
        ...Object.values(extra),
      ],
    );
    return rows[0]!.id;
  }

  /** Como la API: app_user, con el nodo activo fijado. */
  async function comoApp<R extends pg.QueryResultRow>(
    tenantId: string,
    q: string,
    params: unknown[],
  ): Promise<R[]> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const r = await c.query<R>(q, params);
      await c.query('COMMIT');
      return r.rows;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    const root = await platformRootId(pool);
    ids.C = await nodo('c', 'consolidator', root, {
      commercial_name: `Marca C ${sfx}`,
      logo_url: 'https://cdn.example.test/c.png',
      primary_color: '#112233',
      support_email: `soporte-c-${sfx}@example.test`,
    });
    ids.A = await nodo('a', 'agency', ids.C, {
      accent_color: '#AA0000',
      custom_domain: `viajes-${sfx}.example.test`,
    });
    ids.S = await nodo('s', 'subagency', ids.A, { commercial_name: `Marca S ${sfx}` });
    ids.H = await nodo('h', 'agency', ids.C, { custom_domain: `hermana-${sfx}.example.test` });
    await pool.query(`UPDATE tenants SET custom_domain_verified_at = now() WHERE id = $1`, [ids.A]);
  });

  afterAll(async () => {
    // Las hojas primero: la jerarquía no deja huérfanos.
    for (const k of ['S', 'A', 'H', 'C'] as const) {
      if (ids[k]) await pool.query('DELETE FROM tenants WHERE id = $1', [ids[k]]);
    }
    await pool.end();
  });

  interface Marca {
    logo_url: string | null;
    primary_color: string | null;
    accent_color: string | null;
    commercial_name: string | null;
    support_email: string | null;
  }

  const marca = async (id: string): Promise<Marca> =>
    (await comoApp<Marca>(id, 'SELECT * FROM resolve_tenant_branding($1)', [id]))[0]!;

  describe('AGE-08 resolve_tenant_branding', () => {
    it('la agencia sin marca propia hereda logo, color y soporte del consolidador, campo a campo', async () => {
      const a = await marca(ids.A);
      expect(a.logo_url).toBe('https://cdn.example.test/c.png');
      expect(a.primary_color).toBe('#112233');
      expect(a.accent_color).toBe('#AA0000');
      expect(a.support_email).toBe(`soporte-c-${sfx}@example.test`);
    });

    it('el nombre comercial no se hereda: sin el propio, el nombre legal (QA-H-43)', async () => {
      expect((await marca(ids.A)).commercial_name).toBe(`Legal A ${sfx}`);
      expect((await marca(ids.S)).commercial_name).toBe(`Marca S ${sfx}`);
      expect((await marca(ids.C)).commercial_name).toBe(`Marca C ${sfx}`);
    });

    it('lo más cercano gana: la sub-agencia toma el acento de A y el logo de C', async () => {
      const s = await marca(ids.S);
      expect(s.accent_color).toBe('#AA0000');
      expect(s.logo_url).toBe('https://cdn.example.test/c.png');
    });

    it('un ancestro suspendido no presta su marca', async () => {
      await pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [ids.A]);
      try {
        expect((await marca(ids.S)).accent_color).not.toBe('#AA0000');
      } finally {
        await pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [ids.A]);
      }
    });
  });

  describe('SQL-06 resolve_tenant_by_host', () => {
    const host = async (h: string) =>
      (
        await comoApp<{ id: string | null }>(ids.H, 'SELECT resolve_tenant_by_host($1) AS id', [h])
      )[0]!.id;

    it('un dominio verificado resuelve a su nodo, sin distinguir mayúsculas', async () => {
      expect(await host(`viajes-${sfx}.example.test`)).toBe(ids.A);
      expect(await host(`VIAJES-${sfx}.EXAMPLE.TEST`)).toBe(ids.A);
    });

    it('sin verificar, desconocido o con el nodo suspendido: nada', async () => {
      expect(await host(`hermana-${sfx}.example.test`)).toBeNull();
      expect(await host(`nadie-${sfx}.example.test`)).toBeNull();
      await pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [ids.A]);
      try {
        expect(await host(`viajes-${sfx}.example.test`)).toBeNull();
      } finally {
        await pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [ids.A]);
      }
    });
  });

  describe('SQL-05 applicable_markup_rules', () => {
    beforeAll(async () => {
      const regla = (t: string, vertical: string, valor: number, status = 'active', prio = 1) =>
        pool.query(
          `INSERT INTO markup_rules (tenant_id, vertical, rule_type, value_minor, status, priority)
           VALUES ($1, $2, 'fixed', $3, $4, $5)`,
          [t, vertical, valor, status, prio],
        );
      await regla(ids.C, 'flights', 100);
      await regla(ids.C, 'all', 200, 'active', 2);
      await regla(ids.C, 'flights', 999, 'inactive');
      await regla(ids.C, 'hotels', 300);
      await regla(ids.A, 'flights', 400);
      await regla(ids.S, 'flights', 500);
      await regla(ids.H, 'flights', 600);
    });

    const reglas = async (t: string) =>
      (
        await comoApp<{ tenant_id: string; value_minor: string }>(
          t,
          `SELECT tenant_id, value_minor FROM applicable_markup_rules($1, 'flights')`,
          [t],
        )
      ).map(
        (r) => `${Object.entries(ids).find(([, v]) => v === r.tenant_id)?.[0]}:${r.value_minor}`,
      );

    it('la sub-agencia ve las de su cadena, de arriba abajo y por prioridad', async () => {
      expect(await reglas(ids.S)).toEqual(['C:100', 'C:200', 'A:400', 'S:500']);
    });

    it('la agencia no ve las de su sub-agencia ni las de su hermana', async () => {
      expect(await reglas(ids.A)).toEqual(['C:100', 'C:200', 'A:400']);
      expect(await reglas(ids.H)).toEqual(['C:100', 'C:200', 'H:600']);
    });

    it('fuera quedan las inactivas y las de otra vertical; «all» entra', async () => {
      const c = await reglas(ids.C);
      expect(c).toEqual(['C:100', 'C:200']);
    });
  });

  /**
   * Gobierno de proveedores y formas de pago (0089). Cada caso corre en una transacción que se
   * deshace: las reglas globales y el perfil de la plataforma los comparte toda la base, y una regla
   * a medio borrar le apagaría un proveedor a otro test.
   */
  async function enTransaccion<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  const nivel = async (c: pg.PoolClient, id: string) =>
    (await c.query<{ n: number }>('SELECT nlevel(path) AS n FROM tenants WHERE id = $1', [id]))
      .rows[0]!.n;

  describe('SQL-06 governance_chain', () => {
    const prov = `qa-gob-${sfx}`;
    const nombre = (id: string | null) =>
      id === null ? 'global' : (Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id);

    async function sembrar(c: pg.PoolClient): Promise<void> {
      const p = await c.query<{ id: string }>(
        `INSERT INTO governance_profiles (name) VALUES ($1) RETURNING id`,
        [`Perfil red ${sfx}`],
      );
      const perfil = p.rows[0]!.id;
      await c.query(
        `INSERT INTO governance_profile_items (profile_id, provider_code, payment_method, enabled)
         VALUES ($1, $2, '', true), ($1, $2, 'card', false)`,
        [perfil, prov],
      );
      await c.query(
        `INSERT INTO tenant_governance_profiles (tenant_id, profile_id) VALUES ($1, $2)`,
        [ids.C, perfil],
      );
      await c.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled)
         VALUES ($1, NULL, false), ($1, $2, true)`,
        [prov, ids.A],
      );
      await c.query(
        `INSERT INTO payment_method_rules (provider_code, payment_method, tenant_id, enabled)
         VALUES ($1, 'cash', $2, true), ($1, 'card', $3, true), ($1, 'gov', NULL, false)`,
        [prov, ids.S, ids.H],
      );
    }

    async function cadena(c: pg.PoolClient, tenantId: string): Promise<string[]> {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const { rows } = await c.query<{
        source: string;
        payment_method: string;
        tenant_id: string | null;
        lvl: number;
        enabled: boolean;
      }>(
        `SELECT source, payment_method, tenant_id, lvl, enabled
           FROM governance_chain($1) WHERE provider_code = $2`,
        [tenantId, prov],
      );
      await c.query('RESET ROLE');
      return rows
        .map(
          (r) =>
            `${r.source}:${r.payment_method || '-'}:${nombre(r.tenant_id)}:${r.lvl}:${r.enabled}`,
        )
        .sort();
    }

    it('la sub-agencia ve reglas y perfiles de toda su cadena, con su profundidad, y nada de la hermana', async () => {
      await enTransaccion(async (c) => {
        await sembrar(c);
        const [lc, la, ls] = [await nivel(c, ids.C), await nivel(c, ids.A), await nivel(c, ids.S)];
        expect(await cadena(c, ids.S)).toEqual(
          [
            'rule:-:global:1:false',
            'rule:gov:global:1:false',
            `rule:-:A:${la}:true`,
            `rule:cash:S:${ls}:true`,
            `profile:-:C:${lc}:true`,
            `profile:card:C:${lc}:false`,
          ].sort(),
        );
      });
    });

    it('la hermana ve lo global, el perfil del consolidador y lo suyo; no lo de A ni lo de S', async () => {
      await enTransaccion(async (c) => {
        await sembrar(c);
        const [lc, lh] = [await nivel(c, ids.C), await nivel(c, ids.H)];
        expect(await cadena(c, ids.H)).toEqual(
          [
            'rule:-:global:1:false',
            'rule:gov:global:1:false',
            `rule:card:H:${lh}:true`,
            `profile:-:C:${lc}:true`,
            `profile:card:C:${lc}:false`,
          ].sort(),
        );
      });
    });

    it('un nodo que no existe sólo ve lo global', async () => {
      await enTransaccion(async (c) => {
        await sembrar(c);
        expect(await cadena(c, '00000000-0000-4000-8000-000000000000')).toEqual([
          'rule:-:global:1:false',
          'rule:gov:global:1:false',
        ]);
      });
    });
  });

  describe('SQL-06 governance_bootstrap', () => {
    const prov = `qa-boot-${sfx}`;
    const items = JSON.stringify([
      { provider: prov, enabled: true },
      { provider: prov, method: 'card', enabled: false },
    ]);

    /** La siembra como la hace el API al arrancar: app_user, sin usuario en el contexto. */
    async function sembrar(c: pg.PoolClient, reglas: unknown[]): Promise<string | null> {
      await c.query('SET LOCAL ROLE app_user');
      const { rows } = await c.query<{ id: string | null }>(
        `SELECT governance_bootstrap($1, $2::jsonb, $3::jsonb) AS id`,
        [`Siembra ${sfx}`, items, JSON.stringify(reglas)],
      );
      await c.query('RESET ROLE');
      return rows[0]!.id;
    }

    it('una base sin sembrar: crea el perfil, se lo asigna a la plataforma y pasa las reglas por nodo', async () => {
      await enTransaccion(async (c) => {
        const root = await platformRootId(pool);
        await c.query('DELETE FROM governance_state');
        await c.query('DELETE FROM tenant_governance_profiles WHERE tenant_id = $1', [root]);

        const perfil = await sembrar(c, [
          { provider: prov, tenantId: ids.A },
          { provider: prov, tenantId: '00000000-0000-4000-8000-000000000000' },
        ]);
        expect(perfil).toMatch(/^[0-9a-f-]{36}$/);

        const filas = await c.query<{ m: string; e: boolean }>(
          `SELECT payment_method AS m, enabled AS e FROM governance_profile_items
            WHERE profile_id = $1 ORDER BY 1`,
          [perfil],
        );
        expect(filas.rows).toEqual([
          { m: '', e: true },
          { m: 'card', e: false },
        ]);
        const asignado = await c.query(
          `SELECT 1 FROM tenant_governance_profiles WHERE tenant_id = $1 AND profile_id = $2`,
          [root, perfil],
        );
        expect(asignado.rowCount).toBe(1);
        // La del nodo que existe queda como regla a mano; la del que no existe se ignora.
        const reglas = await c.query<{ tenant_id: string; enabled: boolean }>(
          `SELECT tenant_id, enabled FROM provider_enablement WHERE provider_code = $1`,
          [prov],
        );
        expect(reglas.rows).toEqual([{ tenant_id: ids.A, enabled: true }]);
      });
    });

    it('una sola vez en la vida de la base: la segunda no hace nada', async () => {
      await enTransaccion(async (c) => {
        const root = await platformRootId(pool);
        await c.query('DELETE FROM governance_state');
        await c.query('DELETE FROM tenant_governance_profiles WHERE tenant_id = $1', [root]);
        expect(await sembrar(c, [])).not.toBeNull();
        expect(await sembrar(c, [{ provider: prov, tenantId: ids.A }])).toBeNull();
        const perfiles = await c.query(`SELECT 1 FROM governance_profiles WHERE name = $1`, [
          `Siembra ${sfx}`,
        ]);
        expect(perfiles.rowCount).toBe(1);
        const reglas = await c.query(`SELECT 1 FROM provider_enablement WHERE provider_code = $1`, [
          prov,
        ]);
        expect(reglas.rowCount).toBe(0);
      });
    });
  });
});
