import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { REVOKED_IDLE_TIMEOUT } from './session-revocation.js';
import { PLATFORM_ROLES } from './roles.js';

export interface PoolInfo {
  limit: number;
  tenantName: string;
}

export interface NewSession {
  userId: string;
  tenantId: string | null;
  seatTenantId: string | null;
  idleTimeoutSeconds: number;
  mfaVerified: boolean;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface RevokedSession {
  id: string;
  reason: string;
}

/** Una sesión que ocupa un puesto del cupo (pool_active_sessions). */
export interface PoolSession {
  sessionId: string;
  userId: string;
  email: string;
  name: string | null;
  tenantId: string | null;
  tenantName: string | null;
  issuedAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Lo que hace `issueToken` dentro de UNA transacción con el usuario fijado (RLS `sessions_self`):
 * contar puestos, cerrar sus otras sesiones e insertar la nueva. Interfaz propia para que
 * SeatService se pruebe con un doble en memoria.
 */
export interface SeatTransaction {
  isPlatformUser(userId: string): Promise<boolean>;
  seatPoolOf(tenantId: string): Promise<string | null>;
  idleTimeoutMinutes(tenantId: string | null): Promise<number>;
  /**
   * Serializa los ingresos del mismo usuario hasta el fin de la transacción, sea cual sea el cupo
   * (o aunque no haya ninguno). Se toma ANTES que el del cupo: siempre en el mismo orden.
   */
  lockUser(userId: string): Promise<void>;
  /** Serializa los ingresos que compiten por el mismo cupo hasta el fin de la transacción. */
  lockPool(poolTenantId: string): Promise<void>;
  poolInfo(poolTenantId: string): Promise<PoolInfo | null>;
  seatsInUse(poolTenantId: string, excludeUserId: string): Promise<number>;
  /**
   * Cierra todas las sesiones vivas del usuario con `reason` (las que ya estaban inactivas, con
   * `idle_timeout`), y `current`, si viene, con su propio motivo.
   */
  replaceSessions(
    userId: string,
    reason: string,
    current?: { sessionId: string; reason: string },
  ): Promise<RevokedSession[]>;
  revokeOwnSession(userId: string, sessionId: string, reason: string): Promise<boolean>;
  insertSession(session: NewSession): Promise<string>;
}

export abstract class SeatRepository {
  abstract inTransaction<T>(userId: string, fn: (tx: SeatTransaction) => Promise<T>): Promise<T>;
  /** Quiénes ocupan el cupo, de la actividad más reciente a la más vieja. */
  abstract poolSessions(poolTenantId: string): Promise<PoolSession[]>;
  /** Revoca la sesión de OTRO usuario (revoke_session, DEFINER). La app autoriza antes. */
  abstract releaseSession(sessionId: string, reason: string): Promise<boolean>;
  /** Consume un jti de un solo uso. false = ya se había usado. */
  abstract consumeToken(jti: string, purpose: string, expiresAt: Date): Promise<boolean>;
}

@Injectable()
export class PgSeatRepository extends SeatRepository {
  constructor(private readonly db: DatabaseService) {
    super();
  }

  inTransaction<T>(userId: string, fn: (tx: SeatTransaction) => Promise<T>): Promise<T> {
    return this.db.withRequestContext({ userId }, (trx) => fn(new PgSeatTransaction(trx)));
  }

  async poolSessions(poolTenantId: string): Promise<PoolSession[]> {
    const res = await sql<{
      session_id: string;
      user_id: string;
      email: string;
      name: string | null;
      tenant_id: string | null;
      tenant_name: string | null;
      issued_at: Date;
      last_seen_at: Date;
      ip: string | null;
      user_agent: string | null;
    }>`SELECT * FROM pool_active_sessions(${poolTenantId}::uuid)`.execute(this.db.db);
    return res.rows.map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      email: r.email,
      name: r.name,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      issuedAt: r.issued_at,
      lastSeenAt: r.last_seen_at,
      ip: r.ip,
      userAgent: r.user_agent,
    }));
  }

  async releaseSession(sessionId: string, reason: string): Promise<boolean> {
    const res = await sql<{
      ok: boolean;
    }>`SELECT revoke_session(${sessionId}::uuid, ${reason}) AS ok`.execute(this.db.db);
    return res.rows[0]?.ok === true;
  }

  async consumeToken(jti: string, purpose: string, expiresAt: Date): Promise<boolean> {
    const row = await this.db.db
      .insertInto('consumed_tokens')
      .values({ jti, purpose, expires_at: expiresAt })
      .onConflict((oc) => oc.column('jti').doNothing())
      .returning('jti')
      .executeTakeFirst();
    return row !== undefined;
  }
}

class PgSeatTransaction implements SeatTransaction {
  constructor(private readonly trx: Transaction<DB>) {}

  async isPlatformUser(userId: string): Promise<boolean> {
    const row = await this.trx
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('role', 'in', [...PLATFORM_ROLES])
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async seatPoolOf(tenantId: string): Promise<string | null> {
    const res = await sql<{
      pool: string | null;
    }>`SELECT seat_pool_of(${tenantId}::uuid) AS pool`.execute(this.trx);
    return res.rows[0]?.pool ?? null;
  }

  async idleTimeoutMinutes(tenantId: string | null): Promise<number> {
    const res = await sql<{
      minutes: number;
    }>`SELECT effective_idle_timeout_minutes(${tenantId}::uuid) AS minutes`.execute(this.trx);
    return res.rows[0]?.minutes ?? 30;
  }

  async lockUser(userId: string): Promise<void> {
    // El lock del cupo no alcanza para "una sesión por usuario": sin cupo no existe, y dos ingresos
    // por cupos distintos toman claves distintas. Ningún otro camino toma 'user-session:', y éste
    // va siempre antes que 'seat:', así que no puede cerrar un ciclo.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('user-session:' || ${userId}::uuid::text, 0))`.execute(
      this.trx,
    );
  }

  async lockPool(poolTenantId: string): Promise<void> {
    // La misma clave que usa cualquier otro camino que cuente o libere puestos de este cupo.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('seat:' || ${poolTenantId}::uuid::text, 0))`.execute(
      this.trx,
    );
  }

  async poolInfo(poolTenantId: string): Promise<PoolInfo | null> {
    const row = await this.trx
      .selectFrom('tenants')
      .select(['concurrent_seats', 'name'])
      .where('id', '=', poolTenantId)
      .executeTakeFirst();
    return row?.concurrent_seats != null
      ? { limit: row.concurrent_seats, tenantName: row.name }
      : null;
  }

  async seatsInUse(poolTenantId: string, excludeUserId: string): Promise<number> {
    const res = await sql<{
      n: number;
    }>`SELECT seats_in_use(${poolTenantId}::uuid, ${excludeUserId}::uuid) AS n`.execute(this.trx);
    return res.rows[0]?.n ?? 0;
  }

  async replaceSessions(
    userId: string,
    reason: string,
    current?: { sessionId: string; reason: string },
  ): Promise<RevokedSession[]> {
    const res = await sql<{ id: string; revoked_reason: string }>`
      UPDATE sessions
         SET revoked_at = now(),
             revoked_reason = CASE
               WHEN id = ${current?.sessionId ?? null}::uuid THEN ${current?.reason ?? null}::text
               WHEN last_seen_at <= now() - idle_timeout_seconds * interval '1 second'
                 THEN ${REVOKED_IDLE_TIMEOUT}::text
               ELSE ${reason}::text
             END
       WHERE user_id = ${userId}::uuid
         AND revoked_at IS NULL
         AND expires_at > now()
      RETURNING id, revoked_reason
    `.execute(this.trx);
    return res.rows.map((r) => ({ id: r.id, reason: r.revoked_reason }));
  }

  async revokeOwnSession(userId: string, sessionId: string, reason: string): Promise<boolean> {
    const row = await this.trx
      .updateTable('sessions')
      .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async insertSession(session: NewSession): Promise<string> {
    const row = await this.trx
      .insertInto('sessions')
      .values({
        user_id: session.userId,
        tenant_id: session.tenantId,
        seat_tenant_id: session.seatTenantId,
        idle_timeout_seconds: session.idleTimeoutSeconds,
        mfa_verified_at: session.mfaVerified ? sql<Date>`now()` : null,
        expires_at: session.expiresAt,
        ip: session.ip,
        user_agent: session.userAgent?.slice(0, 512) ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
