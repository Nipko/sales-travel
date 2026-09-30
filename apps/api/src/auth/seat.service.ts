import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { AuditService } from '../audit/audit.service.js';
import { NetworkService } from '../network/network.service.js';
import { currentContext } from '../request-context/request-context.js';
import { SeatsFullError, type SeatHolderView } from './auth-errors.js';
import { JwtService } from './jwt.service.js';
import { SeatRepository, type PoolSession, type RevokedSession } from './seat.repository.js';
import { REVOKED_REPLACED } from './session-revocation.js';

export interface IssueSessionParams {
  userId: string;
  tenantId: string | null;
  mfaVerified: boolean;
  expiresAt: Date;
  /** Motivo con que se cierran las demás sesiones del usuario. Por defecto `replaced`. */
  replaceReason?: string;
  /** La sesión desde la que se pide (switch-tenant): se cierra con su propio motivo. */
  current?: { sessionId: string; reason: string };
  /**
   * false cuando el usuario ya ocupa su puesto y sólo lo renueva (cambio de contraseña): la sesión
   * sigue consumiendo el cupo, pero no se le niega aunque el superadmin lo haya achicado.
   */
  enforceSeatLimit?: boolean;
  /** Con qué completar el login si hay que liberar un puesto: "recordar este equipo". */
  remember?: boolean;
}

export interface IssuedSession {
  sessionId: string;
  expiresAt: Date;
  idleTimeoutSeconds: number;
  /** Nodo del cupo que consume. null = no consume (plataforma o sin límite). */
  seatTenantId: string | null;
}

interface SeatsFull {
  kind: 'full';
  poolTenantId: string;
  tenantName: string;
  limit: number;
  inUse: number;
}

interface Issued {
  kind: 'issued';
  session: IssuedSession;
  revoked: RevokedSession[];
}

/**
 * Puestos simultáneos por nodo y una sesión por usuario (decisiones del founder del 2026-09-29).
 *
 * Cada nodo puede tener un cupo de sesiones concurrentes, estilo licencia de GDS; un nodo sin cupo
 * propio consume del ancestro más cercano que lo tenga, y si ninguno lo tiene no hay límite. Entrar
 * en otro equipo cierra la sesión anterior (`replaced`), así un usuario ocupa a lo sumo un puesto.
 * Los usuarios de plataforma no consumen puestos ni tienen el límite de una sesión.
 *
 * Todo pasa en UNA transacción bajo dos advisory locks, uno por usuario y otro por cupo: dos
 * ingresos del mismo usuario se serializan (y el segundo cierra la sesión del primero), y dos que
 * compiten por el último puesto también (y el segundo ve el puesto ocupado). Con el cupo lleno no se
 * revoca nada: quien quedó afuera no le cierra la sesión a nadie por intentar.
 */
@Injectable()
export class SeatService {
  constructor(
    private readonly repo: SeatRepository,
    private readonly audit: AuditService,
    private readonly network: NetworkService,
    private readonly jwt: JwtService,
  ) {}

  async issue(params: IssueSessionParams): Promise<IssuedSession> {
    const ctx = currentContext();
    const enforce = params.enforceSeatLimit !== false;

    const outcome = await this.repo.inTransaction<SeatsFull | Issued>(params.userId, async (tx) => {
      // Una sesión por usuario: el lock del cupo no alcanza. Dos ingresos del mismo usuario por
      // cupos distintos (o por nodos sin cupo, donde no hay lock de cupo) no se esperaban: en READ
      // COMMITTED el UPDATE que cierra sus sesiones no ve la que insertó el otro, y quedaban dos
      // vivas. Con este lock el segundo espera al primero y la ve. Va primero, antes de todo:
      // siempre el del usuario y después el del cupo, así nunca se cruzan. A un usuario de
      // plataforma no le hace falta, pero tomarlo igual no cuesta nada y deja un solo orden.
      await tx.lockUser(params.userId);
      const platform = await tx.isPlatformUser(params.userId);
      const idleMinutes = await tx.idleTimeoutMinutes(params.tenantId);
      const pool = !platform && params.tenantId ? await tx.seatPoolOf(params.tenantId) : null;

      if (pool) {
        await tx.lockPool(pool);
        const info = await tx.poolInfo(pool);
        const inUse = await tx.seatsInUse(pool, params.userId);
        if (enforce && info && inUse >= info.limit) {
          return {
            kind: 'full',
            poolTenantId: pool,
            tenantName: info.tenantName,
            limit: info.limit,
            inUse,
          };
        }
      }

      let revoked: RevokedSession[] = [];
      if (!platform) {
        revoked = await tx.replaceSessions(
          params.userId,
          params.replaceReason ?? REVOKED_REPLACED,
          params.current,
        );
      } else if (params.current) {
        // Plataforma: sin límite de una sesión, pero la sesión de la que sale un switch-tenant se
        // reemplaza igual (el panel ya no la usa).
        if (
          await tx.revokeOwnSession(params.userId, params.current.sessionId, params.current.reason)
        ) {
          revoked = [{ id: params.current.sessionId, reason: params.current.reason }];
        }
      }

      const idleTimeoutSeconds = idleMinutes * 60;
      const sessionId = await tx.insertSession({
        userId: params.userId,
        tenantId: params.tenantId,
        seatTenantId: pool,
        idleTimeoutSeconds,
        mfaVerified: params.mfaVerified,
        expiresAt: params.expiresAt,
        ip: ctx?.ip && isIP(ctx.ip) !== 0 ? ctx.ip : null,
        userAgent: ctx?.userAgent ?? null,
      });
      return {
        kind: 'issued',
        session: { sessionId, expiresAt: params.expiresAt, idleTimeoutSeconds, seatTenantId: pool },
        revoked,
      };
    });

    if (outcome.kind === 'full') {
      throw await this.seatsFull(params, outcome);
    }

    const replaced = outcome.revoked.filter((r) => r.reason === REVOKED_REPLACED).map((r) => r.id);
    if (replaced.length > 0) {
      await this.audit.emit({
        eventType: 'auth.session.replaced',
        tenantId: params.tenantId,
        actorUserId: params.userId,
        aggregateType: 'session',
        aggregateId: outcome.session.sessionId,
        payload: { replacedSessionIds: replaced, seatTenantId: outcome.session.seatTenantId },
      });
    }
    return outcome.session;
  }

  /**
   * 409 del cupo lleno. Si quien quedó afuera administra el nodo del cupo, lleva además la lista de
   * conectados y un permiso de un solo uso para desconectar a uno y completar ESTE ingreso.
   */
  private async seatsFull(params: IssueSessionParams, full: SeatsFull): Promise<SeatsFullError> {
    const canRelease = await this.network
      .canManageTenant(params.userId, full.poolTenantId)
      .catch(() => false);

    await this.audit.emit({
      eventType: 'auth.seat.denied',
      tenantId: full.poolTenantId,
      actorUserId: params.userId,
      aggregateType: 'tenant',
      aggregateId: full.poolTenantId,
      payload: { limit: full.limit, inUse: full.inUse, canRelease },
    });

    const base = { tenantName: full.tenantName, limit: full.limit, inUse: full.inUse };
    if (!canRelease) return new SeatsFullError(base);

    const sessions = (await this.repo.poolSessions(full.poolTenantId))
      // Las propias se reemplazan solas al entrar: no hace falta (ni tiene sentido) liberarlas.
      .filter((s) => s.userId !== params.userId)
      .map(toHolderView);
    const { token } = await this.jwt.signSeatRelease({
      userId: params.userId,
      poolTenantId: full.poolTenantId,
      tenantId: params.tenantId,
      mfa: params.mfaVerified,
      remember: params.remember === true,
      jti: randomUUID(),
    });
    return new SeatsFullError({ ...base, release: { token, sessions } });
  }

  /** ¿Puede liberar puestos de este cupo? Quien administra el nodo del cupo. */
  canRelease(userId: string, poolTenantId: string): Promise<boolean> {
    return this.network.canManageTenant(userId, poolTenantId);
  }

  /** Quiénes ocupan el cupo ahora (para validar que la sesión a liberar sea de ese cupo). */
  poolSessions(poolTenantId: string): Promise<PoolSession[]> {
    return this.repo.poolSessions(poolTenantId);
  }

  releaseSession(sessionId: string, reason: string): Promise<boolean> {
    return this.repo.releaseSession(sessionId, reason);
  }

  consumeReleaseToken(jti: string, expiresAt: Date): Promise<boolean> {
    return this.repo.consumeToken(jti, 'seat_release', expiresAt);
  }
}

function toHolderView(s: PoolSession): SeatHolderView {
  return {
    sessionId: s.sessionId,
    name: s.name,
    email: s.email,
    tenantName: s.tenantName,
    lastSeenAt: s.lastSeenAt.toISOString(),
    device: s.userAgent,
    ip: s.ip,
  };
}
