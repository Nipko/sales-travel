import type { DatabaseService } from '../database/database.service.js';

/** El nodo por cuyo correo (propio o heredado) le escribimos a una persona. */
export interface MailNode {
  readonly tenantId: string;
  readonly name: string;
  /** Su país: la zona horaria de un aviso que dice la hora. Sólo lo trae mailNodeOf. */
  readonly countryCode?: string | null;
}

/**
 * El nodo por cuyo correo le escribimos a alguien sin un admin de por medio: su membership activa
 * más antigua. `undefined` si no tiene ninguna (sale por el correo del sistema).
 *
 * Se lee con su id en el contexto (policy memberships_self): la API corre como app_user y, sin él, la
 * RLS de memberships no deja ver ninguna y el correo salía siempre por el del sistema.
 */
export function mailNodeOf(db: DatabaseService, userId: string): Promise<MailNode | undefined> {
  return db.withRequestContext({ userId }, (trx) =>
    trx
      .selectFrom('memberships')
      .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
      .select([
        'memberships.tenant_id as tenantId',
        'tenants.name as name',
        'tenants.country_code as countryCode',
      ])
      .where('memberships.user_id', '=', userId)
      .where('memberships.status', '=', 'active')
      .orderBy('memberships.created_at')
      .executeTakeFirst(),
  );
}
