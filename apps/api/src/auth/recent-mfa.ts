import { UnauthorizedException } from '@nestjs/common';
import { currentContext, type RequestContext } from '../request-context/request-context.js';
import { MfaRecentRequiredError, MfaRequiredForActionError } from './auth-errors.js';

/**
 * Cuántos minutos vale el segundo factor para una acción de alto impacto (USR-13, founder D1 = C).
 * Pasado eso, la acción pide el código otra vez (POST /auth/step-up). Cada ruta puede pedir otra
 * ventana con `@RequireRecentMfa(minutos)`.
 */
export const RECENT_MFA_WINDOW_MINUTES = 10;

/** Lo que mira la reconfirmación del contexto del request, ya validado contra la base. */
type MfaFreshness = Pick<RequestContext, 'userId' | 'mfaEnabled' | 'mfaVerifiedAt'>;

/**
 * ¿La sesión pasó el segundo factor hace `windowMinutes` minutos o menos? El borde cuenta como
 * reciente. `mfaVerifiedAt` ya viene en el reloj de este proceso (SessionService.validate).
 */
export function mfaVerifiedWithin(
  context: Pick<MfaFreshness, 'mfaVerifiedAt'>,
  windowMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  const at = context.mfaVerifiedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
  return nowMs - at.getTime() <= windowMinutes * 60_000;
}

/**
 * Corta una acción de alto impacto si la sesión no pasó el segundo factor en los últimos
 * `windowMinutes` minutos: 403 MFA_RECENT_REQUIRED (el panel pide el código y la repite), o 403
 * MFA_REQUIRED_FOR_ACTION si quien la pide no tiene el 2FA activo (no hay código que pedirle). Sin
 * usuario, 401: nunca deja pasar por falta de contexto.
 *
 * La usa RecentMfaGuard en las rutas con `@RequireRecentMfa()`. Un servicio la llama directo cuando
 * la exigencia depende de los datos (enviar el enlace a alguien con un rol de admin): después de
 * autorizar, para no pedirle el código a quien igual no podía hacerlo.
 */
export function assertRecentMfa(
  windowMinutes: number = RECENT_MFA_WINDOW_MINUTES,
  context: MfaFreshness | undefined = currentContext(),
  nowMs: number = Date.now(),
): void {
  if (!context?.userId) throw new UnauthorizedException();
  if (context.mfaEnabled !== true) throw new MfaRequiredForActionError();
  if (!mfaVerifiedWithin(context, windowMinutes, nowMs)) throw new MfaRecentRequiredError();
}
