import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { currentContext } from '../../request-context/request-context.js';
import { MfaEnrollmentRequiredError, MfaStepUpRequiredError } from '../auth-errors.js';
import { ALLOW_WITHOUT_MFA_KEY } from '../decorators/allow-without-mfa.decorator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

/**
 * MFA obligatorio exigido por el SERVIDOR.
 *
 * Antes era un redirect del panel: un superadmin o un tenant_admin sin MFA hacía clic en otro menú
 * y operaba toda la API (credenciales BYOC incluidas) sólo con la contraseña. Ahora, si algún rol
 * activo del usuario exige MFA (MFA_REQUIRED_ROLES):
 *
 * - sin MFA activo → 403 MFA_ENROLLMENT_REQUIRED: sólo puede enrolarse o salir;
 * - con MFA activo pero una sesión que no pasó el segundo factor → 401 MFA_STEP_UP_REQUIRED: vuelve
 *   a ingresar (p. ej. las sesiones abiertas antes de 0055, que no dicen cómo se autenticaron).
 *
 * Corre después de AuthGuard (ya hay usuario) y antes de RolesGuard. Deja pasar las rutas públicas
 * y las marcadas con `@AllowWithoutMfa()`, las mínimas para salir de ese estado.
 */
@Injectable()
export class MfaEnforcementGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_MFA_KEY, targets)) return true;

    const context = currentContext();
    // Sin usuario no hay nada que exigir: AuthGuard ya cortó las rutas que lo necesitan.
    if (!context?.userId || context.mfaRequired !== true) return true;
    if (context.mfaEnabled !== true) throw new MfaEnrollmentRequiredError();
    if (context.mfaVerified !== true) throw new MfaStepUpRequiredError();
    return true;
  }
}
