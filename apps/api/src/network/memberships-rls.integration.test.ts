import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Valida la RLS jerárquica de memberships (migración 0020) invocando la FUNCIÓN REAL
 * `can_read_membership(uuid)` con distintos `app.current_user_id`:
 *   - un admin sólo "ve" memberships de su nodo y descendientes (subárbol por path),
 *   - NO de un ancestro ni de otra red,
 *   - el superadmin ve todo,
 *   - un no-admin (vendedor) no ve nada por esta policy (sus pares los ve por tenant_isolation).
 * Se SALTA sin PGHOST. Requiere migraciones 0011 (jerarquía) y 0020.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('hierarchical memberships RLS (can_read_membership)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  let platform: string;
  let cons: string;
  let agency: string;
  let sub: string;
  let other: string;
  let agencyAdmin: string;
  let superadmin: string;
  let vendedor: string;

  async function tenant(slug: string, type: string, parent: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text,$1::text,'CO','COP',$2,$3) RETURNING id`,
      [slug, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(email: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [email],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: string): Promise<void> {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1,$2,$3,'active')`,
      [tenantId, userId, role],
    );
  }

  /** Invoca la función real con un current_user_id dado, en una conexión dedicada. */
  async function canRead(asUserId: string, targetTenantId: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [asUserId]);
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT can_read_membership($1::uuid) AS ok`,
        [targetTenantId],
      );
      return rows[0]!.ok === true;
    } finally {
      await client.query(`SELECT set_config('app.current_user_id', '', false)`);
      client.release();
    }
  }

  beforeAll(async () => {
    // El superadmin cuelga del nodo de PLATAFORMA, no de un consolidador: desde
    // 0025_role_escalation_guard un rol global sólo puede existir sobre tenant_type
    // 'platform'. Es el invariante que impide que un admin de agencia se fabrique un
    // superadmin dentro de su propio nodo y obtenga acceso a toda la plataforma.
    platform = await tenant(`p-${sfx}`, 'platform', null);
    cons = await tenant(`c-${sfx}`, 'consolidator', null);
    agency = await tenant(`a-${sfx}`, 'agency', cons);
    sub = await tenant(`s-${sfx}`, 'subagency', agency);
    other = await tenant(`o-${sfx}`, 'agency', null);

    agencyAdmin = await user(`aa-${sfx}@test.local`);
    superadmin = await user(`sa-${sfx}@test.local`);
    vendedor = await user(`ve-${sfx}@test.local`);

    await member(agency, agencyAdmin, 'tenant_admin'); // admin del nodo intermedio
    await member(platform, superadmin, 'superadmin'); // rol global, sólo sobre el nodo platform
    await member(sub, vendedor, 'vendedor'); // no-admin
  });

  afterAll(async () => {
    for (const id of [sub, agency, cons, other, platform]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[agencyAdmin, superadmin, vendedor]]);
    await pool.end();
  });

  it('agency admin CAN read memberships of its OWN node', async () => {
    expect(await canRead(agencyAdmin, agency)).toBe(true);
  });

  it('agency admin CAN read memberships of a DESCENDANT (sub-agency)', async () => {
    expect(await canRead(agencyAdmin, sub)).toBe(true);
  });

  it('agency admin CANNOT read memberships of an ANCESTOR (consolidator)', async () => {
    expect(await canRead(agencyAdmin, cons)).toBe(false);
  });

  it('agency admin CANNOT read memberships of ANOTHER network', async () => {
    expect(await canRead(agencyAdmin, other)).toBe(false);
  });

  it('superadmin CAN read memberships of any tenant (own net and others)', async () => {
    expect(await canRead(superadmin, sub)).toBe(true);
    expect(await canRead(superadmin, other)).toBe(true);
  });

  it('a non-admin (vendedor) reads NOTHING via the admin policy', async () => {
    expect(await canRead(vendedor, sub)).toBe(false);
    expect(await canRead(vendedor, agency)).toBe(false);
  });

  it('with no current_user_id the policy grants nothing', async () => {
    expect(await canRead('', sub)).toBe(false);
  });

  /**
   * Guarda de escalada (0025_role_escalation_guard).
   *
   * Cierra la vía por la que cualquier admin —hasta el de la sub-agencia más profunda—
   * podía crearse un usuario con role='superadmin' en su propio tenant y, como
   * isSuperadmin() busca ese rol en CUALQUIER nodo sin filtrar por tenant, quedarse con
   * acceso a toda la plataforma: todos los tenants, todas las redes y todas las
   * credenciales BYOC. La validación Zod del controller la tapa en un punto; esto la
   * mueve a la base, donde no depende de que cada endpoint futuro se acuerde.
   */
  describe('guarda de roles de plataforma', () => {
    it('RECHAZA un rol global sobre un tenant que no es de plataforma', async () => {
      const victim = await user(`esc-${sfx}@test.local`);
      for (const [node, label] of [
        [sub, 'subagency'],
        [agency, 'agency'],
        [cons, 'consolidator'],
      ] as const) {
        await expect(
          member(node, victim, 'superadmin'),
          `superadmin sobre ${label}`,
        ).rejects.toThrow(/platform-wide role/);
        await expect(
          member(node, victim, 'platform_admin'),
          `platform_admin sobre ${label}`,
        ).rejects.toThrow(/platform-wide role/);
      }
      await pool.query('DELETE FROM users WHERE id = $1', [victim]);
    });

    it('PERMITE los roles no globales en cualquier nodo', async () => {
      const normal = await user(`ok-${sfx}@test.local`);
      await expect(member(sub, normal, 'tenant_admin')).resolves.toBeUndefined();
      await pool.query('DELETE FROM users WHERE id = $1', [normal]);
    });

    it('impide MOVER una membership global a un nodo que no es de plataforma', async () => {
      // El trigger cubre UPDATE OF role, tenant_id: si sólo mirara el INSERT, bastaría
      // crear el superadmin en platform y después reasignarlo.
      await expect(
        pool.query('UPDATE memberships SET tenant_id = $1 WHERE user_id = $2 AND role = $3', [
          cons,
          superadmin,
          'superadmin',
        ]),
      ).rejects.toThrow(/platform-wide role/);
    });
  });
});
