import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { NetworkService } from '../network/network.service.js';
import {
  assertCanSupportMember,
  MemberNotFoundError,
  MemberSelfActionError,
  TenantNotManagedError,
  type TargetMembership,
} from './tenant-admin.policy.js';

/** Motivo con que quedan revocadas las sesiones que cierra un admin (SESSION_REVOKED). */
export const REVOKED_BY_ADMIN_REASON = 'revoked_by_admin';

/**
 * Soporte a un miembro del equipo: restablecer su 2FA (perdió el teléfono y los códigos) y cerrar
 * todas sus sesiones (perdió la notebook) sin suspenderle la membership.
 *
 * Las dos tocan la identidad global, no un nodo: la regla de quién puede está en
 * assertCanSupportMember. Lo que hace la base (`admin_reset_user_mfa`, `revoke_user_sessions`) es
 * SECURITY DEFINER y no autoriza: todo se valida antes.
 */
@Injectable()
export class MemberSupportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Deja al usuario sin segundo factor, sin códigos de recuperación, sin equipos de confianza y sin
   * sesiones. Si su rol exige MFA, el próximo ingreso lo lleva a enrolarse de nuevo.
   */
  async resetMfa(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<{ ok: true }> {
    await this.authorize(actorUserId, tenantId, targetUserId);

    await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('mfa_enabled_at')
        .where('id', '=', targetUserId)
        .executeTakeFirst();
      await sql`SELECT admin_reset_user_mfa(${targetUserId}::uuid)`.execute(trx);
      // En la misma transacción: un reset de 2FA sin su rastro no debe existir.
      await this.audit.emitWithin(trx, {
        eventType: 'auth.mfa.reset_by_admin',
        tenantId,
        actorUserId,
        aggregateType: 'user',
        aggregateId: targetUserId,
        payload: { targetUserId, hadMfa: Boolean(user?.mfa_enabled_at) },
      });
    });
    return { ok: true };
  }

  /** Cierra todas las sesiones del usuario, en todas sus redes. La membership queda como está. */
  async revokeSessions(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<{ revoked: number }> {
    await this.authorize(actorUserId, tenantId, targetUserId);

    const revoked = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const res = await sql<{ revoked: number | string }>`
        SELECT revoke_user_sessions(${targetUserId}::uuid, ${REVOKED_BY_ADMIN_REASON}) AS revoked
      `.execute(trx);
      const count = Number(res.rows[0]?.revoked ?? 0);
      await this.audit.emitWithin(trx, {
        eventType: 'auth.sessions.revoked_by_admin',
        tenantId,
        actorUserId,
        aggregateType: 'user',
        aggregateId: targetUserId,
        payload: { targetUserId, revoked: count },
      });
      return count;
    });
    return { revoked };
  }

  /**
   * La regla de assertCanSupportMember con los datos de la base. El orden importa: primero lo que
   * se decide sin leer nada (uno mismo), después que el actor administre el nodo de la ruta, y
   * recién entonces se miran las memberships del objetivo, para no revelarle a alguien de afuera
   * si un usuario pertenece a un nodo.
   */
  private async authorize(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<void> {
    if (actorUserId === targetUserId) throw new MemberSelfActionError();

    const routeRole = await this.network.roleOver(actorUserId, tenantId);
    if (routeRole === undefined) throw new TenantNotManagedError();

    const inRoute = await this.db.withRequestContext({ userId: actorUserId, tenantId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['tenant_id', 'role'])
        .where('user_id', '=', targetUserId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    );
    if (!inRoute) throw new MemberNotFoundError();

    const active = await this.activeMemberships(targetUserId);
    const memberships: TargetMembership[] = [
      { tenantId: inRoute.tenant_id, role: inRoute.role },
      ...active.filter((m) => m.tenantId !== inRoute.tenant_id),
    ];
    const actorRoles = await this.network.rolesOver(
      actorUserId,
      memberships.map((m) => m.tenantId),
    );

    assertCanSupportMember({
      actorUserId,
      targetUserId,
      actorIsSuperadmin: routeRole === 'superadmin',
      targetMemberships: memberships,
      actorRoles,
    });
  }

  /**
   * Las memberships activas del objetivo en TODA la plataforma, no sólo en la red del actor: la
   * regla exige administrar todas. Con el actor en el contexto, la RLS de memberships sólo mostraría
   * las de su subárbol y un usuario que además trabaja en otra red parecería sólo suyo. Por eso se
   * leen con el OBJETIVO en `app.current_user_id` (policy memberships_self, la de GET
   * /me/memberships): una lectura de sólo sus memberships, en su propia transacción, que no escribe
   * nada; lo que se hace con el resultado lo decide assertCanSupportMember.
   */
  private async activeMemberships(targetUserId: string): Promise<TargetMembership[]> {
    const rows = await this.db.withRequestContext({ userId: targetUserId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['tenant_id', 'role'])
        .where('user_id', '=', targetUserId)
        .where('status', '=', 'active')
        .execute(),
    );
    return rows.map((r): TargetMembership => ({ tenantId: r.tenant_id, role: r.role }));
  }
}
