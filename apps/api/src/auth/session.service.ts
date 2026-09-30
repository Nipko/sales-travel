import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { Role, UserStatus } from '../database/database.types.js';
import type { SessionFailureReason } from '../request-context/request-context.js';
import { MFA_REQUIRED_ROLES, PLATFORM_ROLES } from './roles.js';
import { REVOKED_IDLE_TIMEOUT, reasonForRevocation } from './session-revocation.js';

/**
 * Ventana de refresco perezoso de last_seen_at: evita un UPDATE por request. Antes eran 10 min,
 * que alcanzaba para listar dispositivos; con cierre por inactividad define cuánto puede atrasar
 * el servidor respecto de la última actividad real, así que baja a 60 s.
 */
const LAST_SEEN_REFRESH_MS = 60 * 1000;

export interface ValidSession {
  ok: true;
  /** Rol efectivo en el tenant activo. undefined si no hay membership activa allí. */
  role?: Role;
  /**
   * `true` si el usuario tiene una membership ACTIVA con un rol de plataforma en cualquier nodo;
   * ausente si no. Es la misma identidad global que mira NetworkService.isSuperadmin(), no el rol
   * del tenant activo: RolesGuard la usa para que el superadmin no venda ni desde una sucursal
   * donde además sea vendedor.
   */
  platformUser?: true;
  /** Algún rol activo del usuario exige MFA (MFA_REQUIRED_ROLES), en cualquier nodo. */
  mfaRequired: boolean;
  /** El usuario tiene MFA activo (`users.mfa_enabled_at`). */
  mfaEnabled: boolean;
  /** ESTA sesión pasó el segundo factor (`sessions.mfa_verified_at`). */
  mfaVerified: boolean;
  /**
   * El tenant pedido (`requestedTenantId`) consume de otro cupo que la sesión: no se adoptó, y el
   * rol es el del tenant firmado. El middleware vuelve al `tid` del token.
   */
  requestedTenantRejected?: true;
  idleTimeoutSeconds: number;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface InvalidSession {
  ok: false;
  reason: SessionFailureReason;
}

export type SessionValidation = ValidSession | InvalidSession;

/**
 * Cómo refrescar la actividad: `passive` valida sin tocar `last_seen_at` (el ping del panel cuando
 * el usuario no interactuó; si no, el propio ping mantendría viva la sesión para siempre) y
 * `active` la refresca aunque no hayan pasado 60 s ("Seguir conectado").
 */
export type ActivityMode = 'default' | 'passive' | 'active';

export interface SessionSummary {
  id: string;
  issuedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

interface SessionRow {
  revoked_at: Date | null;
  revoked_reason: string | null;
  expires_at: Date;
  last_seen_at: Date;
  idle_timeout_seconds: number;
  mfa_verified_at: Date | null;
  expired: boolean;
  idle: boolean;
  user_status: UserStatus;
  password_changed_at: Date | null;
  mfa_enabled_at: Date | null;
  role: Role | null;
  membership_status: string | null;
  tenant_active: boolean | null;
  platform_user: boolean;
  mfa_required: boolean;
  requested_rejected: boolean;
}

/**
 * Sesiones revocables.
 *
 * Antes de esto el access token era stateless con TTL de 24h: suspender a un usuario,
 * quitarle la membership o expulsar a su agencia de la red no tenía ningún efecto hasta
 * que el token expirara, y el logout sólo borraba la cookie del navegador. Ahora cada
 * request valida contra `sessions`, así que revocar es inmediato.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Valida la sesión y resuelve el rol efectivo y el estado del MFA, en una sola consulta.
   *
   * Una sesión que no sirve vuelve con el motivo, que el panel le muestra al usuario: revocada
   * (con el motivo de la revocación), vencida, usuario suspendido, token anterior al último cambio
   * de contraseña o inactiva. Una sesión viva que superó su inactividad se revoca ACÁ con
   * `idle_timeout`: la inactividad la aplica el servidor, no el reloj del navegador.
   *
   * El rol se lee de la base, NO del JWT, para que una degradación de rol o una membership
   * suspendida apliquen en el acto. Tampoco hay rol si el nodo, o alguno de sus ancestros, no está
   * activo: suspender un nodo corta a toda su red en el acto.
   *
   * `tenantId` es el `tid` firmado del token. `requestedTenantId`, otro nodo que pide el request
   * (header `x-tenant-id`, dominio propio) y que el middleware ya autorizó. Si el usuario es miembro
   * de ese nodo y el nodo consume de OTRO cupo que la sesión (`seat_pool_of` distinto de
   * `seat_tenant_id`), no se adopta: operaría allí con su rol completo sin ocupar un puesto de ese
   * cupo, que seguiría mostrándose lleno sin él y cuyo admin no lo vería ni lo podría desconectar.
   * Cambiar a un nodo de otro cupo es POST /auth/switch-tenant, que sí aplica el cupo. No aplica a
   * los usuarios de plataforma (no consumen puestos) ni al admin de un ancestro que opera un nodo
   * donde no es miembro (ahí no tiene rol y su puesto es el de su propio nodo).
   */
  async validate(params: {
    sessionId: string;
    userId: string;
    tenantId?: string;
    requestedTenantId?: string;
    tokenIssuedAt?: Date;
    activity?: ActivityMode;
  }): Promise<SessionValidation> {
    const {
      sessionId,
      userId,
      tenantId,
      requestedTenantId,
      tokenIssuedAt,
      activity = 'default',
    } = params;
    const signed = tenantId ?? null;
    const requested = requestedTenantId ?? null;

    // `expired` e `idle` con el reloj de la base: el mismo que usan seats_in_use y
    // pool_active_sessions para decidir si la sesión ocupa puesto.
    const row = await this.db.withRequestContext({ userId }, async (trx) => {
      const res = await sql<SessionRow>`
        SELECT s.revoked_at,
               s.revoked_reason,
               s.expires_at,
               s.last_seen_at,
               s.idle_timeout_seconds,
               s.mfa_verified_at,
               s.expires_at <= now()                                                   AS expired,
               s.last_seen_at <= now() - s.idle_timeout_seconds * interval '1 second'  AS idle,
               u.status              AS user_status,
               u.password_changed_at,
               u.mfa_enabled_at,
               m.role                AS role,
               m.status              AS membership_status,
               NOT EXISTS (
                 SELECT 1
                 FROM tenants t
                 JOIN tenants a ON a.path OPERATOR(public.@>) t.path
                 WHERE t.id = m.tenant_id
                   AND a.status <> 'active'
               )                     AS tenant_active,
               p.platform_user,
               EXISTS (
                 SELECT 1
                 FROM memberships rm
                 WHERE rm.user_id = s.user_id
                   AND rm.status = 'active'
                   AND rm.role = ANY(${[...MFA_REQUIRED_ROLES]}::text[])
               )                     AS mfa_required,
               (${requested}::uuid IS NOT NULL
                 AND eff.tenant_id IS DISTINCT FROM ${requested}::uuid) AS requested_rejected
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        CROSS JOIN LATERAL (
          SELECT EXISTS (
                   SELECT 1
                   FROM memberships pm
                   WHERE pm.user_id = s.user_id
                     AND pm.status = 'active'
                     AND pm.role = ANY(${[...PLATFORM_ROLES]}::text[])
                 ) AS platform_user
        ) p
        -- El tenant cuyo rol se resuelve: el pedido, salvo que el usuario sea miembro allí y ese
        -- nodo consuma de otro cupo que la sesión (ver el comentario de validate).
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN ${requested}::uuid IS NULL THEN ${signed}::uuid
                   WHEN p.platform_user THEN ${requested}::uuid
                   WHEN NOT EXISTS (
                     SELECT 1
                     FROM memberships dm
                     WHERE dm.user_id = s.user_id
                       AND dm.tenant_id = ${requested}::uuid
                       AND dm.status = 'active'
                   ) THEN ${requested}::uuid
                   WHEN seat_pool_of(${requested}::uuid) IS NOT DISTINCT FROM s.seat_tenant_id
                     THEN ${requested}::uuid
                   ELSE ${signed}::uuid
                 END AS tenant_id
        ) eff
        LEFT JOIN memberships m
          ON m.user_id = s.user_id
         AND m.tenant_id = eff.tenant_id
        WHERE s.id = ${sessionId}::uuid
          AND s.user_id = ${userId}::uuid
      `.execute(trx);
      return res.rows[0] ?? null;
    });

    if (!row) return invalid('SESSION_REVOKED');
    if (row.revoked_at !== null) return invalid(reasonForRevocation(row.revoked_reason));
    if (row.expired) return invalid('SESSION_EXPIRED');
    if (row.user_status !== 'active') return invalid('SESSION_REVOKED');

    // Un cambio de contraseña invalida todo token emitido antes, aunque su sesión siga viva. El
    // `iat` del JWT tiene resolución de segundos: se compara contra el segundo del cambio, o el
    // token que emite el propio cambio de contraseña nacería inválido.
    if (
      tokenIssuedAt &&
      row.password_changed_at &&
      tokenIssuedAt.getTime() < Math.floor(row.password_changed_at.getTime() / 1000) * 1000
    ) {
      return invalid('SESSION_REVOKED');
    }

    if (row.idle) {
      await this.expireIdle(sessionId, userId);
      return invalid('SESSION_IDLE');
    }

    let lastSeenAt = row.last_seen_at;
    const stale = Date.now() - row.last_seen_at.getTime() > LAST_SEEN_REFRESH_MS;
    if (activity === 'active' || (activity === 'default' && stale)) {
      lastSeenAt = (await this.touch(sessionId, userId)) ?? lastSeenAt;
    }

    // Un nodo suspendido (o colgado de uno suspendido) no opera: sin rol, RolesGuard corta todo
    // endpoint de gestión y de venta. Es lo que hace efectivo suspender un nodo desde el panel.
    const role =
      row.role && row.membership_status === 'active' && row.tenant_active === true
        ? row.role
        : undefined;
    // El superadmin no vende (modelo Planetour): la marca sigue al USUARIO, no al tenant activo.
    return {
      ok: true,
      ...(role ? { role } : {}),
      ...(row.platform_user === true ? { platformUser: true as const } : {}),
      ...(row.requested_rejected === true ? { requestedTenantRejected: true as const } : {}),
      mfaRequired: row.mfa_required === true,
      mfaEnabled: row.mfa_enabled_at !== null,
      mfaVerified: row.mfa_verified_at !== null,
      idleTimeoutSeconds: row.idle_timeout_seconds,
      lastSeenAt,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Revoca por inactividad. Condicional: si otro request la revocó o la tocó entre la lectura y
   * acá, no se pisa. La auditoría es best-effort, como toda la de AuditService.
   */
  private async expireIdle(sessionId: string, userId: string): Promise<void> {
    try {
      const revoked = await this.db.withRequestContext({ userId }, (trx) =>
        trx
          .updateTable('sessions')
          .set({ revoked_at: sql<Date>`now()`, revoked_reason: REVOKED_IDLE_TIMEOUT })
          .where('id', '=', sessionId)
          .where('revoked_at', 'is', null)
          .where(sql<boolean>`last_seen_at <= now() - idle_timeout_seconds * interval '1 second'`)
          .returning(['id', 'tenant_id', 'seat_tenant_id'])
          .executeTakeFirst(),
      );
      if (revoked) {
        await this.audit?.emit({
          eventType: 'auth.session.idle_timeout',
          tenantId: revoked.tenant_id,
          actorUserId: userId,
          aggregateType: 'session',
          aggregateId: sessionId,
          payload: { source: 'server', seatTenantId: revoked.seat_tenant_id },
        });
      }
    } catch {
      // La respuesta ya es SESSION_IDLE: si la revocación falla, la próxima validación reintenta.
    }
  }

  /** Refresca la actividad. Devuelve el instante guardado, o null si no se pudo. */
  private async touch(sessionId: string, userId: string): Promise<Date | null> {
    try {
      const row = await this.db.withRequestContext({ userId }, (trx) =>
        trx
          .updateTable('sessions')
          .set({ last_seen_at: sql<Date>`now()` })
          .where('id', '=', sessionId)
          .where('revoked_at', 'is', null)
          .returning('last_seen_at')
          .executeTakeFirst(),
      );
      return row?.last_seen_at ?? null;
    } catch {
      // No debe romper el request: la próxima validación lo reintenta.
      return null;
    }
  }

  /** Revoca una sesión puntual del propio usuario. false si no era suya o ya estaba cerrada. */
  async revoke(sessionId: string, userId: string, reason: string): Promise<boolean> {
    const row = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .updateTable('sessions')
        .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
        .where('id', '=', sessionId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  /**
   * Revoca TODAS las sesiones de un usuario: cambio de contraseña, "cerrar sesión en
   * todos los dispositivos", suspensión o baja de la red.
   *
   * Usa revoke_user_sessions() (SECURITY DEFINER) para poder alcanzar también las
   * sesiones de OTRO usuario en el camino administrativo, donde la policy sessions_self
   * no aplicaría. La autorización jerárquica se valida en el llamador.
   */
  async revokeAllForUser(targetUserId: string, reason: string): Promise<number> {
    const res = await sql<{
      revoke_user_sessions: number;
    }>`SELECT revoke_user_sessions(${targetUserId}::uuid, ${reason})`.execute(this.db.db);
    return res.rows[0]?.revoke_user_sessions ?? 0;
  }

  /** El tenant y el estado del MFA con que se emitió una sesión propia (switch-tenant, cambio de contraseña). */
  async snapshot(
    sessionId: string,
    userId: string,
  ): Promise<{ tenantId: string | null; mfaVerified: boolean } | null> {
    const row = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('sessions')
        .select(['tenant_id', 'mfa_verified_at'])
        .where('id', '=', sessionId)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    return row ? { tenantId: row.tenant_id, mfaVerified: row.mfa_verified_at !== null } : null;
  }

  /** Sesiones vivas del usuario (no revocadas, no vencidas ni inactivas), para el panel de dispositivos. */
  async listActive(userId: string, currentSessionId?: string): Promise<SessionSummary[]> {
    const rows = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('sessions')
        .select(['id', 'issued_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent'])
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .where(sql<boolean>`last_seen_at > now() - idle_timeout_seconds * interval '1 second'`)
        .orderBy('last_seen_at', 'desc')
        .execute(),
    );

    return rows.map((r) => ({
      id: r.id,
      issuedAt: r.issued_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      ip: r.ip,
      userAgent: r.user_agent,
      current: r.id === currentSessionId,
    }));
  }
}

function invalid(reason: SessionFailureReason): InvalidSession {
  return { ok: false, reason };
}
