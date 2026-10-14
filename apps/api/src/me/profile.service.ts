import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';

export interface ProfileView {
  name: string;
}

/**
 * El perfil de la propia cuenta (USR-18). Hoy, sólo el nombre visible: el correo no se cambia hasta
 * que haya un flujo que verifique el buzón nuevo.
 *
 * `users` no tiene RLS (identidad global, 0001): la cuenta que se toca es la de la sesión, que el
 * controlador saca de `CurrentUser` y nunca del cuerpo. La base lo respalda (0069): el trigger
 * `users_name_self_only` rechaza que `app_user` cambie el nombre de una cuenta que no sea la de
 * `app.current_user_id`, por eso esto corre con el contexto del request.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Cambia el nombre de `userId` por `name` (ya normalizado por PersonNameSchema) y lo deja en el
   * historial en la misma transacción: si el evento no entra, el cambio tampoco. Con el mismo
   * nombre no escribe ni audita nada.
   *
   * La fila se toma `FOR NO KEY UPDATE`, como el resto de las escrituras sobre `users`: el nombre no
   * es clave, y `FOR UPDATE` frenaba sin motivo las inserciones que apuntan a la cuenta (una sesión
   * nueva, una membership) mientras dura el cambio.
   *
   * El payload lleva el antes y el después: es el nombre de la propia persona, el mismo que su
   * equipo ya ve en Equipo, y es lo que deja ver en el historial que alguien se puso el nombre de
   * otro. Sigue la forma de `tenant.updated` (`changed`, `before`, `after`).
   */
  async updateName(userId: string, name: string): Promise<ProfileView> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const current = await trx
        .selectFrom('users')
        .select('name')
        .where('id', '=', userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current) throw new UnauthorizedException();
      if (current.name === name) return { name };

      await trx.updateTable('users').set({ name }).where('id', '=', userId).execute();
      await this.audit.emitWithin(trx, {
        eventType: 'UserProfileUpdated',
        actorUserId: userId,
        aggregateType: 'user',
        aggregateId: userId,
        payload: {
          changed: ['name'],
          before: { name: current.name },
          after: { name },
        },
      });
      return { name };
    });
  }
}
