import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { JwtService } from '../auth/jwt.service.js';
import { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from './request-context.js';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly network: NetworkService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    let userId: string | undefined;
    let tokenTenantId: string | undefined;

    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      try {
        const payload = await this.jwt.verify(token);
        userId = payload.sub;
        tokenTenantId = payload.tid;
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

    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    requestContextStorage.run({ userId, tenantId, requestId }, () => {
      next();
    });
  }
}
