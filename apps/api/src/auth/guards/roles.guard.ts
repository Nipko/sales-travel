import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../database/database.types.js';
import { currentContext } from '../../request-context/request-context.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../roles.js';

/**
 * Autorización declarativa por rol. Complementa a AuthGuard, que sólo verifica que haya
 * usuario autenticado.
 *
 * Contrasta contra el rol EFECTIVO en el tenant activo (resuelto por
 * RequestContextMiddleware contra la base en cada request), no contra el claim del JWT:
 * degradar a un usuario o suspender su membership surte efecto de inmediato.
 *
 * Los roles de plataforma pasan siempre: su alcance es global por definición.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // Sin @Roles(), este guard no opina: la ruta queda gobernada por AuthGuard.
    if (!required || required.length === 0) return true;

    const context = currentContext();
    if (!context?.userId) throw new UnauthorizedException();

    const role = context.role;
    if (!role) {
      // Autenticado pero sin membership activa en el tenant del request.
      throw new ForbiddenException('no active membership in the current tenant');
    }

    if ((PLATFORM_ROLES as readonly Role[]).includes(role)) return true;
    if (required.includes(role)) return true;

    throw new ForbiddenException('insufficient role for this operation');
  }
}
