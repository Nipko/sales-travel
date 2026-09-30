import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { JwtService } from '../auth/jwt.service.js';
import { SessionService, type ActivityMode } from '../auth/session.service.js';
import type { Role } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { resolveClientOrigin } from './client-origin.js';
import {
  requestContextStorage,
  type SessionFailureReason,
  type SessionTiming,
} from './request-context.js';

/**
 * `x-session-ping: passive` lo manda el ping del panel cuando el usuario no interactuó: se valida la
 * sesión sin contarlo como actividad (si no, el propio ping la mantendría viva para siempre).
 * `active`, cuando sí interactuó o eligió "Seguir conectado": refresca aunque no hayan pasado 60 s.
 */
const SESSION_PING_HEADER = 'x-session-ping';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly network: NetworkService,
    private readonly sessions: SessionService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    let userId: string | undefined;
    let tokenTenantId: string | undefined;
    let sessionId: string | undefined;
    let issuedAt: Date | undefined;
    let authFailure: SessionFailureReason | undefined;
    let sessionCheckUnavailable = false;

    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      try {
        const payload = await this.jwt.verify(token);
        userId = payload.sub;
        tokenTenantId = payload.tid;
        sessionId = payload.jti;
        issuedAt = payload.iat ? new Date(payload.iat * 1000) : undefined;
      } catch (err) {
        // Token inválido o expirado: dejamos pasar sin userId. El AuthGuard se encargará de
        // rechazar si la ruta lo requiere; si venció, con el motivo.
        if (isExpiredJwt(err)) authFailure = 'SESSION_EXPIRED';
      }
    }

    // IP y navegador del USUARIO: el panel llama por la red interna y los reenvía con el secreto
    // interno. Sin eso, las sesiones y la auditoría guardaban la IP del contenedor web.
    const origin = resolveClientOrigin(req);

    // Tenant activo: el `tid` del JWT (firmado, confiable) es la base. El header
    // `x-tenant-id` (que envía web-b2b) sólo se honra si el usuario está AUTORIZADO en
    // ese tenant (miembro directo o admin de un ancestro). Así un cliente no puede
    // operar bajo un tenant ajeno pasando un header forjado. Drop-on-invalid: si el
    // header no autoriza, se ignora y se usa el `tid`.
    let tenantId = tokenTenantId;

    // Dominio propio de la agencia (0033). Se usa SÓLO como valor por defecto para
    // requests sin sesión —el portal público de una agencia—: para un usuario ya
    // autenticado manda su tenant activo, porque si no, entrar por el dominio de otra
    // agencia de la red cambiaría en silencio bajo qué nodo está operando.
    if (!tenantId) {
      const host = (req.headers['x-forwarded-host'] ?? req.headers.host) as string | undefined;
      if (host) {
        tenantId = (await this.network.resolveTenantByHost(host.split(':')[0]!)) ?? undefined;
      }
    }
    const tenantHeader = req.headers['x-tenant-id'];
    const headerTenant = typeof tenantHeader === 'string' ? tenantHeader : undefined;
    if (headerTenant && userId) {
      try {
        if (await this.network.canAccessTenant(userId, headerTenant)) {
          tenantId = headerTenant;
        }
        // header no autorizado → se ignora (se mantiene el tid firmado).
      } catch {
        // Falla de validación → conservador: ignorar el header.
      }
    }

    // Sesión revocable (0026): el token firmado ya no basta. Se comprueba contra la base
    // que la sesión siga viva y dentro de su inactividad, que el usuario no esté suspendido y
    // que el token no sea anterior al último cambio de contraseña. De paso se resuelven el rol
    // EFECTIVO en el tenant activo y el estado del MFA, para que degradar un rol o suspender una
    // membership aplique en el acto.
    //
    // Un token sin `jti` es previo a esta versión: se rechaza. Consecuencia deliberada y
    // por única vez: al desplegar, todas las sesiones vigentes deben volver a loguearse.
    //
    // El tenant del header (o del dominio) va aparte del `tid` firmado: un nodo de otro cupo de
    // puestos no se adopta aunque el usuario sea miembro (ver SessionService.validate). Sin eso,
    // cambiar la cookie st_tenant operaba en un nodo con el cupo lleno sin ocupar puesto en él.
    let role: Role | undefined;
    let platformUser = false;
    let mfa: { mfaRequired: boolean; mfaEnabled: boolean; mfaVerified: boolean } | undefined;
    let session: SessionTiming | undefined;
    if (userId) {
      if (!sessionId) {
        userId = undefined;
      } else {
        try {
          const validated = await this.sessions.validate({
            sessionId,
            userId,
            tenantId: tokenTenantId,
            ...(tenantId && tenantId !== tokenTenantId ? { requestedTenantId: tenantId } : {}),
            tokenIssuedAt: issuedAt,
            activity: activityMode(req.headers[SESSION_PING_HEADER]),
          });
          if (!validated.ok) {
            userId = undefined;
            sessionId = undefined;
            authFailure = validated.reason;
          } else {
            if (validated.requestedTenantRejected) tenantId = tokenTenantId;
            role = validated.role;
            platformUser = validated.platformUser === true;
            mfa = {
              mfaRequired: validated.mfaRequired,
              mfaEnabled: validated.mfaEnabled,
              mfaVerified: validated.mfaVerified,
            };
            session = {
              idleTimeoutSeconds: validated.idleTimeoutSeconds,
              lastSeenAt: validated.lastSeenAt,
              expiresAt: validated.expiresAt,
            };
          }
        } catch {
          // Fail-closed: si no podemos comprobar la sesión, el request va sin autenticar. Pero se
          // marca: AuthGuard responde 503 y no 401, que el panel tomaría como sesión terminada.
          userId = undefined;
          sessionId = undefined;
          sessionCheckUnavailable = true;
        }
      }
    }

    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    requestContextStorage.run(
      {
        userId,
        tenantId,
        requestId,
        sessionId,
        role,
        platformUser,
        ...(authFailure ? { authFailure } : {}),
        ...(sessionCheckUnavailable ? { sessionCheckUnavailable: true } : {}),
        ...(mfa ?? {}),
        ...(session ? { session } : {}),
        ip: origin.ip,
        userAgent: origin.userAgent,
      },
      () => {
        next();
      },
    );
  }
}

function activityMode(header: string | string[] | undefined): ActivityMode {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === 'passive') return 'passive';
  if (value === 'active') return 'active';
  return 'default';
}

/** jose marca el vencimiento con `code: 'ERR_JWT_EXPIRED'`. */
function isExpiredJwt(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ERR_JWT_EXPIRED'
  );
}
