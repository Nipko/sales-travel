import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';

/** `pg.Pool`, `pg.PoolClient` o `pg.Client`: lo que tenga cada test de integración a mano. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * La raíz `platform` de la base de pruebas: la que haya, o una nueva.
 *
 * Desde 0050 sólo la plataforma es raíz y hay una sola por base (D4 A). Los tests de integración
 * comparten la base —en CI corren en paralelo, junto con los de `tools/`—, así que cuelgan sus redes
 * de esta raíz común en lugar de crear raíces propias. Para no pisarse:
 *
 *   - nunca se borra;
 *   - no se le cuelgan cuentas de proveedor, reglas de markup, ajustes de habilitación ni marca:
 *     los heredaría la red de cualquier otro test;
 *   - sí puede tener memberships de usuarios del propio test (superadmin, platform_admin), que se
 *     van con el usuario al borrarlo.
 *
 * Buscar o crear sin carrera: el índice único de 0050 decide quién crea, y `ON CONFLICT DO NOTHING`
 * deja al que llega segundo sin error.
 */
export async function platformRootId(db: Queryable): Promise<string> {
  await db.query(
    `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type)
     VALUES ('it-platform', 'Plataforma de pruebas', 'CO', 'COP', 'platform')
     ON CONFLICT DO NOTHING`,
  );
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM tenants WHERE tenant_type = 'platform'`,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('la base de pruebas no tiene raíz platform');
  return id;
}

/**
 * Un nodo que la matriz D4 (0050) ya no deja crear, como los que quedaron de antes: la agencia raíz
 * `amazon-minimalist` de producción, el consolidador raíz de un seed viejo o una cadena de tipos
 * inválida. Se inserta con los triggers apagados SÓLO para esta sesión y esta transacción
 * (`session_replication_role`, que exige superusuario, como el de CI) y con el `path` que le habría
 * puesto 0011.
 *
 * Recibe una conexión dedicada (`pool.connect()`): la transacción tiene que ser suya.
 */
export async function legacyTenant(
  db: Queryable,
  slug: string,
  tenantType: 'consolidator' | 'agency' | 'subagency',
  parentId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.query('BEGIN');
  try {
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      `INSERT INTO tenants (id, slug, name, country_code, default_currency, tenant_type,
                           parent_tenant_id, path)
       SELECT $1::uuid, $2::text, $2::text, 'CO', 'COP', $3, $4::uuid,
              CASE WHEN $4::uuid IS NULL THEN replace($1::text, '-', '')::ltree
                   ELSE p.path || replace($1::text, '-', '')::ltree END
         FROM (SELECT 1) AS one
         LEFT JOIN tenants p ON p.id = $4::uuid`,
      [id, slug, tenantType, parentId],
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
  return id;
}
