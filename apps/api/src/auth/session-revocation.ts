import type { SessionFailureReason } from '../request-context/request-context.js';

/**
 * Valores de `sessions.revoked_reason` que el panel distingue. El resto (logout, logout_all,
 * password_changed, mfa_reset, user_suspended...) se informa como una sesión cerrada sin más.
 */
export const REVOKED_IDLE_TIMEOUT = 'idle_timeout';
/** Una sesión por usuario: entrar en otro equipo cierra la anterior. */
export const REVOKED_REPLACED = 'replaced';
/** Un admin liberó el puesto desde Equipo. */
export const REVOKED_ADMIN_RELEASED = 'admin_released';
/** Quien quedó afuera por cupo lleno, y administra el nodo del cupo, desconectó a alguien. */
export const REVOKED_RELEASED_AT_LOGIN = 'released_at_login';
/** switch-tenant emite otra sesión y cierra la de la que sale. */
export const REVOKED_TENANT_SWITCHED = 'tenant_switched';

/** Qué `reason` del 401 corresponde a una sesión revocada con `revokedReason`. */
export function reasonForRevocation(revokedReason: string | null): SessionFailureReason {
  switch (revokedReason) {
    case REVOKED_IDLE_TIMEOUT:
      return 'SESSION_IDLE';
    case REVOKED_REPLACED:
      return 'SESSION_REPLACED';
    case REVOKED_ADMIN_RELEASED:
    case REVOKED_RELEASED_AT_LOGIN:
      return 'SESSION_RELEASED';
    default:
      return 'SESSION_REVOKED';
  }
}
