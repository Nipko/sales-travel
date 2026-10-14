import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { assertRecentMfa } from '../auth/recent-mfa.js';
import { isAdminRole } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, MembershipStatus } from '../database/database.types.js';
import { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import {
  MemberAccountSuspendedError,
  MembershipSuspendedError,
  PasswordResetRateLimitedError,
} from './member-support.errors.js';
import {
  assertCanSupportMember,
  MemberNotFoundError,
  MemberSelfActionError,
  TenantNotManagedError,
  type TargetMembership,
} from './tenant-admin.policy.js';

/** Motivo con que quedan revocadas las sesiones que cierra un admin (SESSION_REVOKED). */
export const REVOKED_BY_ADMIN_REASON = 'revoked_by_admin';

/** Enlaces para restablecer la contraseña de una persona que frenan uno más, y en qué ventana. */
export const RESET_LINKS_PER_WINDOW = 3;
export const RESET_LINKS_WINDOW_MINUTES = 15;

/** Lo que la autorización sabe del objetivo: su acceso al nodo de la ruta y dónde más opera. */
interface AuthorizedTarget {
  /** Su membership en el nodo de la ruta; cuenta aunque esté suspendida. */
  status: MembershipStatus;
  /** La del nodo de la ruta y sus activas en toda la plataforma. */
  memberships: TargetMembership[];
}

/**
 * Soporte a un miembro del equipo: restablecer su 2FA (perdió el teléfono y los códigos), cerrar
 * todas sus sesiones (perdió la notebook) sin suspenderle la membership, enviarle el enlace para que
 * elija una contraseña nueva, obligarlo a elegirla antes de volver a ingresar y levantarle el bloqueo
 * por intentos fallidos.
 *
 * Todas tocan la identidad global, no un nodo: la regla de quién puede está en
 * assertCanSupportMember. Lo que hace la base (`admin_reset_user_mfa`, `revoke_user_sessions`) es
 * SECURITY DEFINER y no autoriza: todo se valida antes.
 *
 * Nadie elige la contraseña de otro (docs/platform/14): el admin sólo dispara el correo con el enlace,
 * que llega al buzón de la persona. No ve el enlace ni el token, y la respuesta no los trae.
 *
 * La persona se entera de cada cambio por su correo: el de restablecer su 2FA, cerrarle las sesiones
 * o desbloquearla es un aviso de SecurityNoticeService que sale después del commit, y sólo si algo
 * cambió; el del enlace (enviado o forzado) ya es ese aviso.
 */
@Injectable()
export class MemberSupportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly resets: PasswordResetService,
    private readonly notices: SecurityNoticeService,
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
    this.notices.notify('mfa_reset', { userId: targetUserId, tenantId });
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
    // Sin sesiones abiertas no le cerramos nada: el aviso diría algo que no pasó.
    if (revoked > 0) this.notices.notify('sessions_revoked', { userId: targetUserId, tenantId });
    return { revoked };
  }

  /**
   * Le envía a la persona un enlace de un solo uso para elegir una contraseña nueva. Deja sin efecto
   * los enlaces anteriores y su contraseña actual sigue valiendo hasta que la cambie. La respuesta
   * dice si el correo salió (`sent`), nunca el enlace.
   *
   * Si la persona tiene un rol de admin en alguno de sus nodos, pide además el 2FA de los últimos
   * minutos (USR-13, D1 = C): el enlace abre una cuenta con poder sobre la red, y con una sesión
   * robada alcanzaría con tener también su buzón. Se mira después de autorizar, para no pedirle el
   * código a quien igual no podía hacerlo.
   *
   * El enlace y su evento quedan en la misma transacción, que bloquea la fila del usuario: dos envíos
   * en paralelo se ordenan y el segundo ya cuenta el enlace del primero para el límite. El correo
   * sale después del commit: si no sale, el enlace igual existe y se audita el fallo.
   */
  async sendPasswordReset(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<{ sent: boolean; expiresAt: string }> {
    const authorized = await this.authorize(actorUserId, tenantId, targetUserId);
    if (authorized.status === 'suspended') throw new MembershipSuspendedError();
    if (authorized.memberships.some((m) => isAdminRole(m.role))) assertRecentMfa();

    const issued = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const target = await trx
        .selectFrom('users')
        .select(['email', 'status', 'password_reset_required_at'])
        .where('id', '=', targetUserId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!target) throw new MemberNotFoundError();
      if (target.status !== 'active') throw new MemberAccountSuspendedError();
      await this.assertUnderResetLimit(trx, targetUserId);

      const { token, expiresAt } = await this.resets.issueToken(trx, targetUserId, {
        invalidatePrevious: true,
      });
      // En la misma transacción: un enlace enviado por un admin sin su rastro no debe existir.
      await this.audit.emitWithin(trx, {
        eventType: 'auth.password_reset.sent_by_admin',
        tenantId,
        actorUserId,
        aggregateType: 'user',
        aggregateId: targetUserId,
        payload: { targetUserId, expiresAt: expiresAt.toISOString() },
      });

      const node = await trx
        .selectFrom('tenants')
        .select('name')
        .where('id', '=', tenantId)
        .executeTakeFirst();
      return {
        email: target.email,
        token,
        expiresAt,
        nodeName: node?.name ?? null,
        // Con el cambio forzado pendiente, el correo no puede decir que la actual sigue funcionando.
        variant: target.password_reset_required_at === null ? 'admin' : 'required',
      } as const;
    });

    const sent = await this.resets.sendResetEmail(
      tenantId,
      issued.email,
      this.resets.resetLink(issued.token),
      issued.variant,
      issued.nodeName,
    );
    if (!sent) {
      await this.audit.emit({
        eventType: 'auth.password_reset.email_failed',
        tenantId,
        actorUserId,
        aggregateType: 'user',
        aggregateId: targetUserId,
        payload: { targetUserId, via: 'admin' },
      });
    }
    return { sent, expiresAt: issued.expiresAt.toISOString() };
  }

  /**
   * Lo obliga a elegir una contraseña nueva antes de volver a ingresar: cierra todas sus sesiones,
   * deja sin efecto sus enlaces anteriores y le envía uno nuevo (PasswordResetService.requireReset).
   * Hasta que lo use, el login le responde 403 PASSWORD_RESET_REQUIRED. Es para cuando se sospecha
   * que su contraseña está comprometida: a diferencia de enviarle el enlace, la vieja deja de servir
   * en el acto.
   *
   * Los mismos 409 que enviar el enlace. Si ya estaba obligado, volver a pedirlo sólo le reenvía el
   * enlace (no hay sesiones que cerrar: ninguna vale mientras tanto), así que cuenta para el mismo
   * límite de 3 enlaces cada 15 minutos; la primera vez no, para que el límite nunca impida cortarle
   * el acceso a una contraseña comprometida. Todo en una transacción que bloquea la fila del
   * usuario; el correo sale después del commit y, si no sale, se audita el fallo.
   */
  async requirePasswordReset(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<{ sent: boolean; revokedSessions: number }> {
    const { status } = await this.authorize(actorUserId, tenantId, targetUserId);
    if (status === 'suspended') throw new MembershipSuspendedError();

    const required = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const target = await trx
        .selectFrom('users')
        .select(['email', 'status', 'password_reset_required_at'])
        .where('id', '=', targetUserId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!target) throw new MemberNotFoundError();
      if (target.status !== 'active') throw new MemberAccountSuspendedError();
      if (target.password_reset_required_at !== null) {
        await this.assertUnderResetLimit(trx, targetUserId);
      }

      const { token, revokedSessions } = await this.resets.requireReset(trx, {
        actorUserId,
        targetUserId,
        tenantId,
      });

      const node = await trx
        .selectFrom('tenants')
        .select('name')
        .where('id', '=', tenantId)
        .executeTakeFirst();
      return { email: target.email, token, revokedSessions, nodeName: node?.name ?? null };
    });

    const sent = await this.resets.sendResetEmail(
      tenantId,
      required.email,
      this.resets.resetLink(required.token),
      'required',
      required.nodeName,
    );
    if (!sent) {
      await this.audit.emit({
        eventType: 'auth.password_reset.email_failed',
        tenantId,
        actorUserId,
        aggregateType: 'user',
        aggregateId: targetUserId,
        payload: { targetUserId, via: 'required' },
      });
    }
    return { sent, revokedSessions: required.revokedSessions };
  }

  /**
   * Levanta el bloqueo por intentos fallidos: el contador vuelve a cero y puede intentar de nuevo de
   * inmediato. No toca la contraseña, el 2FA ni el estado de la cuenta.
   *
   * `unlocked: false` si no estaba bloqueada (el bloqueo ya venció o nunca existió): no cambia nada
   * y no se audita. El valor anterior se lee bloqueando la fila en la misma sentencia, así dos
   * desbloqueos en paralelo dan uno solo.
   */
  async unlock(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<{ unlocked: boolean }> {
    await this.authorize(actorUserId, tenantId, targetUserId);

    const unlocked = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const res = await sql<{ locked_until: Date }>`
        WITH prev AS (
          SELECT locked_until FROM users WHERE id = ${targetUserId}::uuid FOR NO KEY UPDATE
        )
        UPDATE users u
           SET failed_login_attempts = 0,
               locked_until = NULL
          FROM prev
         WHERE u.id = ${targetUserId}::uuid
           AND prev.locked_until > now()
        RETURNING prev.locked_until
      `.execute(trx);
      const row = res.rows[0];
      if (row === undefined) return false;
      await this.audit.emitWithin(trx, {
        eventType: 'auth.lockout.cleared_by_admin',
        tenantId,
        actorUserId,
        aggregateType: 'user',
        aggregateId: targetUserId,
        payload: { targetUserId, lockedUntil: new Date(row.locked_until).toISOString() },
      });
      return true;
    });
    if (unlocked) this.notices.notify('unlocked', { userId: targetUserId, tenantId });
    return { unlocked };
  }

  /**
   * 429 con RESET_LINKS_PER_WINDOW enlaces o más de esa persona en los últimos
   * RESET_LINKS_WINDOW_MINUTES (los que pidió ella también cuentan): frena que un admin le llene el
   * buzón o deje sin efecto, una y otra vez, el enlace que acaba de recibir.
   */
  private async assertUnderResetLimit(trx: Transaction<DB>, targetUserId: string): Promise<void> {
    const recent = await trx
      .selectFrom('password_reset_tokens')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', targetUserId)
      .where(
        sql<boolean>`created_at > now() - make_interval(mins => ${RESET_LINKS_WINDOW_MINUTES})`,
      )
      .executeTakeFirst();
    if (Number(recent?.n ?? 0) >= RESET_LINKS_PER_WINDOW) {
      throw new PasswordResetRateLimitedError();
    }
  }

  /**
   * La regla de assertCanSupportMember con los datos de la base. El orden importa: primero lo que
   * se decide sin leer nada (uno mismo), después que el actor administre el nodo de la ruta, y
   * recién entonces se miran las memberships del objetivo, para no revelarle a alguien de afuera
   * si un usuario pertenece a un nodo.
   *
   * Devuelve el estado de su membership en el nodo de la ruta, que cuenta aunque esté suspendida:
   * enviarle el enlace lo rechaza recién después de autorizar, así el 409 no le cuenta nada a quien
   * no podía actuar. Y sus memberships, para saber si es admin en alguna.
   */
  private async authorize(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<AuthorizedTarget> {
    if (actorUserId === targetUserId) throw new MemberSelfActionError();

    const routeRole = await this.network.roleOver(actorUserId, tenantId);
    if (routeRole === undefined) throw new TenantNotManagedError();

    const inRoute = await this.db.withRequestContext({ userId: actorUserId, tenantId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['tenant_id', 'role', 'status'])
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
    return { status: inRoute.status, memberships };
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
