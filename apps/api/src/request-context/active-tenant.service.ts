import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { currentTenantId } from './request-context.js';

/**
 * Resuelve el tenant bajo el que opera el request.
 *
 * Reemplaza a doce copias privadas e idénticas de `resolveActiveTenant` que devolvían
 * siempre "la PRIMERA membership del usuario por created_at", ignorando el tenant activo.
 * Consecuencia: un usuario con membresías en varias agencias —el caso normal de un
 * consolidador que opera sobre su red— veía y escribía siempre en la primera, sin
 * importar el tenant que hubiera elegido. El act-as jerárquico no funcionaba.
 *
 * Ahora manda `app.current_tenant_id`, que RequestContextMiddleware ya resolvió y validó
 * contra la jerarquía (el header x-tenant-id sólo se honra si el usuario está autorizado
 * en ese nodo, y si no se cae al `tid` firmado del JWT). El fallback a la primera
 * membership queda sólo para tokens sin tenant.
 */
@Injectable()
export class ActiveTenantService {
  constructor(private readonly db: DatabaseService) {}

  async resolve(userId: string): Promise<string> {
    const fromContext = currentTenantId();
    if (fromContext) return fromContext;

    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select(['tenant_id'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      if (!row) throw new ForbiddenException('user has no active membership');
      return row.tenant_id;
    });
  }
}
