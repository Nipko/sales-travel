import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { currentContext } from '../../request-context/request-context.js';
import { SessionCheckUnavailableError, SessionInvalidError } from '../auth-errors.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const context = currentContext();
    if (!context?.userId) {
      // La base no respondió al validar la sesión: no se sabe si murió, así que no se dice que sí.
      if (context?.sessionCheckUnavailable) throw new SessionCheckUnavailableError();
      // Con el motivo (inactividad, otro dispositivo, puesto liberado...) el panel le explica al
      // usuario por qué lo manda al login, en vez de un "sesión expirada" genérico.
      const failure = context?.authFailure;
      throw failure ? new SessionInvalidError(failure) : new UnauthorizedException();
    }
    return true;
  }
}
