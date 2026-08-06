import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { Role, UserStatus } from '../database/database.types.js';

/** Ventana de refresco perezoso de last_seen_at: evita un UPDATE por request. */
const LAST_SEEN_REFRESH_MS = 10 * 60 * 1000;

export interface ValidatedSession {
  /** Rol efectivo en el tenant activo. undefined si no hay membership activa allí. */
  role?: Role;
}

export interface SessionSummary {
  id: string;
  issuedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
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
  constructor(private readonly db: DatabaseService) {}

  /** Crea la sesión del login. El id devuelto viaja como claim `jti`. */
  async create(params: {
    userId: string;
    tenantId?: string | null;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<string> {
    const row = await this.db.withRequestContext({ userId: params.userId }, (trx) =>
      trx
        .insertInto('sessions')
        .values({
          user_id: params.userId,
          tenant_id: params.tenantId ?? null,
          expires_at: params.expiresAt,
          ip: params.ip ?? null,
          user_agent: params.userAgent?.slice(0, 512) ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return row.id;
  }

  /**
   * Valida la sesión y resuelve el rol efectivo, en una sola consulta.
   *
   * Devuelve null —request no autenticado— si la sesión no existe, fue revocada o expiró,
   * si el usuario está suspendido, o si el token es anterior al último cambio de
   * contraseña. El rol se lee de la base, NO del JWT, para que una degradación de rol o
   * una membership suspendida apliquen en el acto.
   */
  async validate(params: {
    sessionId: string;
    userId: string;
    tenantId?: string;
    tokenIssuedAt?: Date;
  }): Promise<ValidatedSession | null> {
    const { sessionId, userId, tenantId, tokenIssuedAt } = params;

    const result = await this.db.withRequestContext({ userId }, async (trx) => {
      const res = await sql<{
        revoked_at: Date | null;
        expires_at: Date;
        last_seen_at: Date;
        user_status: UserStatus;
        password_changed_at: Date | null;
        role: Role | null;
        membership_status: string | null;
      }>`
        SELECT s.revoked_at,
               s.expires_at,
               s.last_seen_at,
               u.status              AS user_status,
               u.password_changed_at,
               m.role                AS role,
               m.status              AS membership_status
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN memberships m
          ON m.user_id = s.user_id
         AND m.tenant_id = ${tenantId ?? null}::uuid
        WHERE s.id = ${sessionId}::uuid
          AND s.user_id = ${userId}::uuid
      `.execute(trx);
      return res.rows[0] ?? null;
    });

    if (!result) return null;
    if (result.revoked_at !== null) return null;
    if (result.expires_at.getTime() <= Date.now()) return null;
    if (result.user_status !== 'active') return null;

    // Un cambio de contraseña invalida todo token emitido antes, aunque su sesión siga viva.
    if (
      tokenIssuedAt &&
      result.password_changed_at &&
      tokenIssuedAt.getTime() < result.password_changed_at.getTime()
    ) {
      return null;
    }

    if (Date.now() - result.last_seen_at.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.touch(sessionId, userId);
    }

    const role = result.role && result.membership_status === 'active' ? result.role : undefined;
    return role ? { role } : {};
  }

  private async touch(sessionId: string, userId: string): Promise<void> {
    try {
      await this.db.withRequestContext({ userId }, (trx) =>
        trx
          .updateTable('sessions')
          .set({ last_seen_at: new Date() })
          .where('id', '=', sessionId)
          .execute(),
      );
    } catch {
      // Cosmético (alimenta el listado de dispositivos). Nunca debe romper el request.
    }
  }

  /** Revoca una sesión puntual del propio usuario (logout). */
  async revoke(sessionId: string, userId: string, reason: string): Promise<void> {
    await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .updateTable('sessions')
        .set({ revoked_at: new Date(), revoked_reason: reason })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .execute(),
    );
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

  /** Sesiones activas del usuario, para el panel de dispositivos. */
  async listActive(userId: string, currentSessionId?: string): Promise<SessionSummary[]> {
    const rows = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('sessions')
        .select(['id', 'issued_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent'])
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', new Date())
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
