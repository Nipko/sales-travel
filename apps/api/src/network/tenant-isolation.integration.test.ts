import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Aislamiento cross-tenant REAL, ejercitando la RLS.
 *
 * CLAUDE.md los declara obligatorios en CI, pero el job de tests corría como el
 * superusuario `postgres`, que hace BYPASSRLS: ninguna policy se evaluaba nunca y estos
 * tests habrían pasado incluso con la RLS desactivada. Este archivo se conecta
 * explícitamente como `app_user` (NOSUPERUSER, NOBYPASSRLS), que es el rol con el que
 * corre la API en producción, y sólo entonces las policies significan algo.
 *
 * Se salta si no hay credenciales de app_user (APP_USER_PASSWORD), igual que el resto de
 * los tests de integración se saltan sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

d('aislamiento cross-tenant bajo RLS (como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');

  /** Conexión de SUPERUSUARIO: sólo para montar y desmontar los fixtures. */
  const admin = new pg.Pool();

  /** Conexión de la APLICACIÓN: sujeta a RLS, es la que se pone a prueba. */
  const app = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });

  let tenantA: string;
  let tenantB: string;
  let customerA: string;
  let customerB: string;

  /** Ejecuta como app_user con el GUC de tenant seteado, igual que DatabaseService. */
  async function asTenant<T>(
    tenantId: string,
    fn: (c: pg.PoolClient) => Promise<T>,
    userId?: string,
  ): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      if (userId) await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
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

  async function seedCustomer(tenantId: string, last: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, first_name, last_name, document_type, document_number,
                              document_issuing_country, birthdate, gender, nationality)
       VALUES ($1,'Test',$2,'CC',$3,'COL','1990-01-01','O','COL') RETURNING id`,
      [tenantId, last, `doc-${last}-${sfx}`],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    const mk = async (slug: string): Promise<string> => {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency)
         VALUES ($1::text,$1::text,'CO','COP') RETURNING id`,
        [slug],
      );
      return rows[0]!.id;
    };
    tenantA = await mk(`iso-a-${sfx}`);
    tenantB = await mk(`iso-b-${sfx}`);
    customerA = await seedCustomer(tenantA, 'Alpha');
    customerB = await seedCustomer(tenantB, 'Beta');
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB]) {
      if (id) await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await admin.end();
    await app.end();
  });

  it('app_user NO puede saltarse la RLS (no es superusuario)', async () => {
    const { rows } = await app.query<{ usesuper: boolean; userepl: boolean }>(
      `SELECT rolsuper AS usesuper, rolbypassrls AS userepl FROM pg_roles WHERE rolname = current_user`,
    );
    // Si esto falla, todos los demás asserts de este archivo son vacíos.
    expect(rows[0]?.usesuper).toBe(false);
    expect(rows[0]?.userepl).toBe(false);
  });

  it('un tenant ve SOLO sus propios clientes', async () => {
    const visibles = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query<{ id: string }>('SELECT id FROM customers');
      return rows.map((r) => r.id);
    });
    expect(visibles).toContain(customerA);
    expect(visibles).not.toContain(customerB);
  });

  it('un tenant NO puede leer un cliente ajeno ni pidiéndolo por id', async () => {
    const found = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query('SELECT id FROM customers WHERE id = $1', [customerB]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('un tenant NO puede modificar un cliente ajeno', async () => {
    const updated = await asTenant(tenantA, async (c) => {
      const r = await c.query('UPDATE customers SET first_name = $1 WHERE id = $2', [
        'Hackeado',
        customerB,
      ]);
      return r.rowCount;
    });
    expect(updated).toBe(0);

    // Y el dato del otro tenant sigue intacto.
    const { rows } = await admin.query<{ first_name: string }>(
      'SELECT first_name FROM customers WHERE id = $1',
      [customerB],
    );
    expect(rows[0]?.first_name).toBe('Test');
  });

  it('un tenant NO puede borrar un cliente ajeno', async () => {
    const deleted = await asTenant(tenantA, async (c) => {
      const r = await c.query('DELETE FROM customers WHERE id = $1', [customerB]);
      return r.rowCount;
    });
    expect(deleted).toBe(0);
  });

  it('un tenant NO puede insertar filas a nombre de otro (WITH CHECK)', async () => {
    await expect(
      asTenant(tenantA, (c) =>
        c.query(
          `INSERT INTO customers (tenant_id, first_name, last_name, document_type, document_number,
                                  document_issuing_country, birthdate, gender, nationality)
           VALUES ($1,'Intruso','X','CC',$2,'COL','1990-01-01','O','COL')`,
          [tenantB, `intruso-${sfx}`],
        ),
      ),
    ).rejects.toThrow();
  });

  it('sin tenant activo no se ve nada', async () => {
    const c = await app.connect();
    try {
      const { rows } = await c.query('SELECT id FROM customers');
      expect(rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });

  it('el audit log tampoco se lee cross-red', async () => {
    // domain_events pasó a tener RLS por subárbol en 0029. Sin un usuario admin en el
    // contexto, can_read_membership() es falso y no debe devolver ninguna fila.
    const c = await app.connect();
    try {
      const { rows } = await c.query('SELECT id FROM domain_events LIMIT 1');
      expect(rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });
});
