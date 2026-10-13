import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_RECENT_MFA_KEY } from '../decorators/require-recent-mfa.decorator.js';
import { assertRecentMfa } from '../recent-mfa.js';

/**
 * Reconfirmación del 2FA en las acciones de alto impacto (USR-13). Sólo opina en los handlers con
 * `@RequireRecentMfa()`; el resto de la API no la ve.
 *
 * Global y después de RolesGuard: para cuando corre ya hay usuario, el MFA de su rol se cumple
 * (MfaEnforcementGuard) y su rol alcanza para la ruta, así que el código se le pide sólo a quien
 * llegó hasta la acción. Lo que el handler decide adentro (que sea superadmin, que pueda dar soporte
 * a esa persona) viene después: quien no podía igual recibe su 403 una vez reconfirmado.
 */
@Injectable()
export class RecentMfaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const windowMinutes = this.reflector.get<number | undefined>(
      REQUIRE_RECENT_MFA_KEY,
      ctx.getHandler(),
    );
    if (windowMinutes === undefined) return true;
    assertRecentMfa(windowMinutes);
    return true;
  }
}
