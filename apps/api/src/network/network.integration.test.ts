import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Verifica la autorización jerárquica del modelo consolidador (subárbol por `path`),
 * que es la propiedad de seguridad central de NetworkService.canManageTenant.
 * Requiere migraciones 0011/0012; se SALTA sin PGHOST.
 *
 * Ejecuta la MISMA condición SQL que canManageTenant contra datos sembrados, para
 * confirmar: un admin gestiona su nodo y descendientes, NO ancestros ni nodos de otra red.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('hierarchical authorization (canManageTenant semantics)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  let cons: string;
  let agency: string;
  let sub: string;
  let other: string; // raíz de otra red
  let userId: string;
  let vendedorId: string;

  async function tenant(slug: string, type: string, parent: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text,$1::text,'CO','COP',$2,$3) RETURNING id`,
      [slug, type, parent],
    );
    return rows[0]!.id;
  }

  /** Réplica exacta de la condición de NetworkService.canManageTenant. */
  async function canManage(target: string): Promise<boolean> {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM memberships m
         JOIN tenants admin_t  ON admin_t.id  = m.tenant_id
         JOIN tenants target_t ON target_t.id = $2::uuid
         WHERE m.user_id = $1::uuid AND m.status='active'
           AND ( m.role='superadmin'
                 OR (m.role IN ('tenant_admin','admin') AND admin_t.path OPERATOR(public.@>) target_t.path) )
       ) AS ok`,
      [userId, target],
    );
    return rows[0]!.ok === true;
  }

  beforeAll(async () => {
    cons = await tenant(`c-${sfx}`, 'consolidator', null);
    agency = await tenant(`a-${sfx}`, 'agency', cons);
    sub = await tenant(`s-${sfx}`, 'subagency', agency);
    other = await tenant(`o-${sfx}`, 'agency', null);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`u-${sfx}@test.local`],
    );
    userId = u.rows[0]!.id;
    // El usuario es admin en la AGENCIA (nodo intermedio).
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1,$2,'admin','active')`,
      [agency, userId],
    );

    // Un VENDEDOR (no admin) miembro de la sub-agencia, para distinguir acceso vs gestión.
    const v = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`v-${sfx}@test.local`],
    );
    vendedorId = v.rows[0]!.id;
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1,$2,'vendedor','active')`,
      [sub, vendedorId],
    );
  });

  afterAll(async () => {
    // Borrar tenants primero (cascadean orders/quotations); recién después users,
    // porque orders.user_id es FK RESTRICT.
    for (const id of [sub, agency, cons, other]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userId, vendedorId]]);
    await pool.end();
  });

  let seq = 0;
  async function seedOrder(tenantId: string, status: string): Promise<void> {
    seq += 1;
    await pool.query(
      // `provider` explícito: 0035 le quitó el DEFAULT a la columna.
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers, contact_info, total_amount, order_number, status)
       VALUES ($1, $2, 'latam-ndc', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 1000, $3, $4)`,
      [tenantId, userId, seq, status],
    );
  }
  async function seedQuotation(tenantId: string): Promise<void> {
    seq += 1;
    await pool.query(
      `INSERT INTO quotations (tenant_id, user_id, search_criteria, selected_offer, quote_number, expires_at)
       VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, $3, now() + interval '7 days')`,
      [tenantId, userId, seq],
    );
  }
  async function summary(root: string): Promise<Map<string, { o: number; oc: number; q: number }>> {
    const { rows } = await pool.query<{
      t_id: string;
      orders_total: string;
      orders_confirmed: string;
      quotations_total: string;
    }>(`SELECT * FROM network_sales_summary($1::uuid)`, [root]);
    return new Map(
      rows.map((r) => [
        r.t_id,
        {
          o: Number(r.orders_total),
          oc: Number(r.orders_confirmed),
          q: Number(r.quotations_total),
        },
      ]),
    );
  }

  /** Réplica de NetworkService.canAccessTenant: miembro directo, superadmin, o admin de ancestro. */
  async function canAccess(uid: string, target: string): Promise<boolean> {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM memberships m
         WHERE m.user_id = $1::uuid AND m.status='active'
           AND ( m.tenant_id = $2::uuid
                 OR m.role='superadmin'
                 OR ( m.role IN ('tenant_admin','admin','consolidator_admin','agency_admin','platform_admin')
                      AND EXISTS (SELECT 1 FROM tenants admin_t JOIN tenants target_t ON target_t.id=$2::uuid
                                  WHERE admin_t.id=m.tenant_id AND admin_t.path OPERATOR(public.@>) target_t.path) ) )
       ) AS ok`,
      [uid, target],
    );
    return rows[0]!.ok === true;
  }

  it('admin can manage its OWN node', async () => {
    expect(await canManage(agency)).toBe(true);
  });

  it('admin can manage DESCENDANTS (sub-agency)', async () => {
    expect(await canManage(sub)).toBe(true);
  });

  it('admin CANNOT manage an ANCESTOR (the consolidator above it)', async () => {
    expect(await canManage(cons)).toBe(false);
  });

  it('admin CANNOT manage a node in ANOTHER network', async () => {
    expect(await canManage(other)).toBe(false);
  });

  // canAccessTenant: valida el header x-tenant-id (operar bajo un tenant).
  it('vendedor (non-admin) CAN access its OWN tenant', async () => {
    expect(await canAccess(vendedorId, sub)).toBe(true);
  });

  it('vendedor CANNOT access another tenant (forged header is rejected)', async () => {
    expect(await canAccess(vendedorId, agency)).toBe(false);
    expect(await canAccess(vendedorId, other)).toBe(false);
  });

  it('admin CAN access a descendant (act-as), but not an ancestor or another network', async () => {
    expect(await canAccess(userId, sub)).toBe(true);
    expect(await canAccess(userId, cons)).toBe(false);
    expect(await canAccess(userId, other)).toBe(false);
  });

  it('network_sales_summary aggregates the subtree and excludes other networks', async () => {
    await seedOrder(agency, 'confirmed');
    await seedOrder(agency, 'pending');
    await seedOrder(sub, 'ticketed');
    await seedQuotation(sub);
    await seedOrder(other, 'confirmed'); // otra red: NO debe contar para `cons`

    const s = await summary(cons);
    expect(s.get(cons)).toEqual({ o: 0, oc: 0, q: 0 }); // el consolidador no tiene orders propias
    expect(s.get(agency)).toEqual({ o: 2, oc: 1, q: 0 });
    expect(s.get(sub)).toEqual({ o: 1, oc: 1, q: 1 });
    expect(s.has(other)).toBe(false); // otra red no aparece

    const totalOrders = [...s.values()].reduce((a, v) => a + v.o, 0);
    expect(totalOrders).toBe(3); // agency(2) + sub(1), no incluye `other`
  });

  /** Réplica del SELECT de NetworkService.listTenantUsers (filtrado por tenant). */
  async function listUsers(tenantId: string): Promise<Array<{ userId: string; role: string }>> {
    const { rows } = await pool.query<{ user_id: string; role: string }>(
      `SELECT m.user_id, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1::uuid
       ORDER BY m.created_at`,
      [tenantId],
    );
    return rows.map((r) => ({ userId: r.user_id, role: r.role }));
  }

  it('listTenantUsers returns only the members of the given node (no cross-tenant bleed)', async () => {
    const agencyUsers = await listUsers(agency);
    const subUsers = await listUsers(sub);
    expect(agencyUsers.map((u) => u.userId)).toContain(userId);
    expect(agencyUsers.map((u) => u.userId)).not.toContain(vendedorId);
    expect(subUsers.map((u) => u.userId)).toEqual([vendedorId]);
    expect(subUsers[0]).toMatchObject({ role: 'vendedor' });
  });
});
