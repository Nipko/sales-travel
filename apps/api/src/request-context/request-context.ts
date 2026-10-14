import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '../database/database.types.js';

/**
 * Por qué un bearer bien firmado no autenticó. Viaja como `reason` del 401 para que el panel le
 * diga al usuario qué pasó ("Tu sesión se abrió en otro dispositivo") en vez de un "sesión expirada"
 * genérico, y sepa a qué pantalla mandarlo.
 */
export type SessionFailureReason =
  | 'SESSION_IDLE'
  | 'SESSION_REPLACED'
  | 'SESSION_RELEASED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED';

/** Tiempos de la sesión validada: GET /auth/session los devuelve sin volver a la base. */
export interface SessionTiming {
  idleTimeoutSeconds: number;
  lastSeenAt: Date;
  expiresAt: Date;
}

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
  /**
   * El usuario tiene un rol de plataforma (superadmin) en algún nodo, sea cual sea el tenant
   * activo. Resuelto contra la base junto con `role`. RolesGuard no le deja operar ventas.
   */
  platformUser?: boolean;
  /** El bearer venía pero su sesión ya no sirve. AuthGuard lo devuelve como `reason` del 401. */
  authFailure?: SessionFailureReason;
  /**
   * No se pudo consultar la base para validar la sesión. El request sigue sin usuario (fail-closed),
   * pero AuthGuard responde 503 en vez de un 401 que el panel leería como sesión terminada.
   */
  sessionCheckUnavailable?: boolean;
  /**
   * Estado del segundo factor, resuelto contra la base junto con la sesión. MfaEnforcementGuard
   * corta con él: el MFA obligatorio lo exige el servidor, no un redirect del panel.
   */
  mfaRequired?: boolean;
  mfaEnabled?: boolean;
  mfaVerified?: boolean;
  /**
   * Cuándo pasó ESTA sesión el segundo factor por última vez (login o POST /auth/step-up), en el
   * reloj de este proceso. RecentMfaGuard lo compara con la ventana de las acciones de alto impacto.
   */
  mfaVerifiedAt?: Date;
  session?: SessionTiming;
  /** Para el audit log (domain_events.meta) y las sesiones: la IP y el navegador del USUARIO. */
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

/**
 * Corre `fn` con el contexto del request pero con `tenantId` como tenant activo.
 *
 * Es para quien actúa sobre lo de OTRO nodo sin ser miembro: el superadmin, desde Reservas de la
 * red, sobre la reserva de una agencia. Lo que cae al tenant del contexto cuando no se lo pasan
 * —la auditoría (`AuditService`) y la bóveda de payloads de proveedor (`currentTenantId()`)— tiene
 * que ir al nodo de la reserva, no al de la plataforma. El usuario, la sesión, la IP y el resto
 * del contexto no cambian: sigue siendo quien actúa.
 */
export function runWithTenantContext<T>(tenantId: string, fn: () => T): T {
  return requestContextStorage.run({ ...currentContext(), tenantId }, fn);
}
