import { SetMetadata } from '@nestjs/common';
import { RECENT_MFA_WINDOW_MINUTES } from '../recent-mfa.js';

export const REQUIRE_RECENT_MFA_KEY = 'requireRecentMfa';

/**
 * Acción de alto impacto: exige que la sesión haya pasado el segundo factor en los últimos
 * `windowMinutes` minutos (por defecto RECENT_MFA_WINDOW_MINUTES). Si no, RecentMfaGuard responde
 * 403 MFA_RECENT_REQUIRED antes del handler y el panel pide el código (POST /auth/step-up) y repite
 * la acción una vez (`withStepUp`, apps/web-b2b/src/lib/step-up.ts).
 *
 * Qué la lleva lo decidió el founder (D1 = C): suspender o reactivar una cuenta en toda la
 * plataforma, exportar a CSV, forzar el cambio de contraseña (también en bloque), restablecer el 2FA
 * de otra persona y enviarle el enlace a alguien con un rol de admin. El soporte diario
 * (desbloquear, cerrar sesiones) no. Cuando la exigencia depende de los datos, el servicio llama a
 * `assertRecentMfa()` en vez de decorar la ruta.
 *
 * Va en el handler, no en el controlador: cada ruta marcada tiene que ser una decisión.
 */
export const RequireRecentMfa = (
  windowMinutes: number = RECENT_MFA_WINDOW_MINUTES,
): MethodDecorator => {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error(`@RequireRecentMfa: ventana inválida (${windowMinutes} min)`);
  }
  return SetMetadata(REQUIRE_RECENT_MFA_KEY, windowMinutes);
};
