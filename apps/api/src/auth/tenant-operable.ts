import { sql, type RawBuilder } from 'kysely';

/**
 * `true` si el nodo y toda su cadena de ancestros están activos: el mismo criterio con que
 * SessionService.validate deja de resolver rol bajo un nodo suspendido. `tenants` no tiene RLS
 * (0001), así que se leen los ancestros sin GUC de tenant.
 *
 * `tenantIdColumn` es una referencia a columna (`memberships.tenant_id`), nunca un valor del usuario.
 */
export function tenantOperableSql(tenantIdColumn: string): RawBuilder<boolean> {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM tenants op_t
    JOIN tenants op_a ON op_a.path OPERATOR(public.@>) op_t.path
    WHERE op_t.id = ${sql.ref(tenantIdColumn)}
      AND op_a.status <> 'active'
  )`;
}
