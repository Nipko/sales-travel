import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { JwtService } from '../auth/jwt.service.js';
import { SessionService } from '../auth/session.service.js';
import type { Role } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from './request-context.js';

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

    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      try {
        const payload = await this.jwt.verify(token);
        userId = payload.sub;
        tokenTenantId = payload.tid;
        sessionId = payload.jti;
        issuedAt = payload.iat ? new Date(payload.iat * 1000) : undefined;
      } catch {
        // Token inválido o expirado: dejamos pasar sin userId.
        // El AuthGuard se encargará de rechazar si la ruta lo requiere.
      }
    }

    // Tenant activo: el `tid` del JWT (firmado, confiable) es la base. El header
    // `x-tenant-id` (que envía web-b2b) sólo se honra si el usuario está AUTORIZADO en
    // ese tenant (miembro directo o admin de un ancestro). Así un cliente no puede
    // operar bajo un tenant ajeno pasando un header forjado. Drop-on-invalid: si el
    // header no autoriza, se ignora y se usa el `tid`.
    let tenantId = tokenTenantId;
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
    // que la sesión siga viva, que el usuario no esté suspendido y que el token no sea
    // anterior al último cambio de contraseña. De paso se resuelve el rol EFECTIVO en el
    // tenant activo, para que degradar un rol o suspender una membership aplique en el acto.
    //
    // Un token sin `jti` es previo a esta versión: se rechaza. Consecuencia deliberada y
    // por única vez: al desplegar, todas las sesiones vigentes deben volver a loguearse.
    let role: Role | undefined;
    if (userId) {
      if (!sessionId) {
        userId = undefined;
      } else {
        try {
          const validated = await this.sessions.validate({
            sessionId,
            userId,
            tenantId,
            tokenIssuedAt: issuedAt,
          });
          if (!validated) {
            userId = undefined;
            sessionId = undefined;
          } else {
            role = validated.role;
          }
        } catch {
          // Fail-closed: si no podemos comprobar la sesión, el request va sin autenticar.
          userId = undefined;
          sessionId = undefined;
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
        ip: req.ip ?? undefined,
        userAgent: req.headers['user-agent'],
      },
      () => {
        next();
      },
    );
  }
}
