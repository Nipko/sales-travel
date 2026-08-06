import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '../database/database.types.js';

export interface RequestContext {
  userId?: string;
  tenantId?: string;
  requestId?: string;
  /** Sesión (claim `jti`) con la que entró el request. Permite revocarla puntualmente. */
  sessionId?: string;
  /**
   * Rol EFECTIVO del usuario en el tenant activo, resuelto contra la base en cada
   * request. No se toma del JWT: un rol degradado o una membership suspendida deben
   * surtir efecto de inmediato, no cuando expire el token.
   */
  role?: Role;
  /** Para el audit log (domain_events.meta). */
  ip?: string;
  userAgent?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function currentUserId(): string | undefined {
  return requestContextStorage.getStore()?.userId;
}

export function currentTenantId(): string | undefined {
  return requestContextStorage.getStore()?.tenantId;
}

export function currentRole(): Role | undefined {
  return requestContextStorage.getStore()?.role;
}
