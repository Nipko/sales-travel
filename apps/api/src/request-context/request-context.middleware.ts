import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { JwtService } from '../auth/jwt.service.js';
import { requestContextStorage } from './request-context.js';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly jwt: JwtService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    let userId: string | undefined;

    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      try {
        const payload = await this.jwt.verify(token);
        userId = payload.sub;
      } catch {
        // Token inválido o expirado: dejamos pasar sin userId.
        // El AuthGuard se encargará de rechazar si la ruta lo requiere.
      }
    }

    const tenantHeader = req.headers['x-tenant-id'];
    const tenantId = typeof tenantHeader === 'string' ? tenantHeader : undefined;

    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    requestContextStorage.run({ userId, tenantId, requestId }, () => {
      next();
    });
  }
}
