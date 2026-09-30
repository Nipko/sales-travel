/**
 * Nombres y duración de las cookies de sesión, sin `next/headers`: lo usan `session.ts`, el
 * middleware y los route handlers que borran cookies sobre su propia respuesta.
 */

export const SESSION_COOKIE = 'st_session';
export const TENANT_COOKIE = 'st_tenant';
/** Token de "recordar este equipo". Sobrevive al cierre de sesión: es del equipo, no de la sesión. */
export const TRUSTED_DEVICE_COOKIE = 'st_trusted';

/** Lo que se borra al cerrar sesión (por el usuario, por inactividad o porque la API la cortó). */
export const COOKIES_CLEARED_ON_LOGOUT = [SESSION_COOKIE, TENANT_COOKIE] as const;

/**
 * Header del request (no de la respuesta) con la pantalla que pidió el usuario. Lo pone el
 * middleware y lo lee el layout del panel: si la cookie sigue viva pero la API ya cerró la sesión
 * (inactividad, otro dispositivo), el layout es quien se entera, y una Server Component no conoce la
 * URL pedida. Sin esto el login volvía al inicio en vez de al link que se había abierto.
 */
export const REQUESTED_PATH_HEADER = 'x-st-path';

/**
 * `st_tenant` es una preferencia de navegación, no una credencial: dura más que la sesión. La
 * escriben el login y el cambio de agencia (junto con `st_session`) y el middleware, que la alinea
 * con el `tid` de la sesión.
 */
export const TENANT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Las opciones de `st_tenant`, las mismas desde una server action que desde el middleware. */
export function tenantCookieOptions(production: boolean) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: TENANT_COOKIE_MAX_AGE_SECONDS,
  };
}

/** El access token dura 12 h: si la API no dice cuándo vence, la cookie no vive más que eso. */
export const SESSION_FALLBACK_SECONDS = 12 * 60 * 60;
export const TRUSTED_DEVICE_FALLBACK_SECONDS = 30 * 24 * 60 * 60;

/**
 * Techo por si la API manda una fecha absurda: una cookie de sesión no pasa de 1 día ni una de
 * equipo de confianza de 90.
 */
const SESSION_MAX_SECONDS = 24 * 60 * 60;
const TRUSTED_DEVICE_MAX_SECONDS = 90 * 24 * 60 * 60;

/**
 * Piso: un token que ya venció (o un reloj un poco atrasado) deja igual una cookie de un minuto; el
 * próximo request recibe el 401 con su motivo, en vez de volver al login sin explicación.
 */
const MIN_SECONDS = 60;

function secondsUntil(
  expiresAt: string | Date | null | undefined,
  fallbackSeconds: number,
  maxSeconds: number,
  nowMs: number,
): number {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return fallbackSeconds;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return fallbackSeconds;
  const seconds = Math.floor((ms - nowMs) / 1000);
  return Math.min(Math.max(seconds, MIN_SECONDS), maxSeconds);
}

/**
 * `maxAge` de `st_session`: hasta que vence el token. Antes era de 7 días con un token de 12 h, y el
 * navegador seguía mandando un token muerto: el panel quedaba abierto pero vacío.
 */
export function sessionCookieMaxAge(
  expiresAt?: string | Date | null,
  nowMs: number = Date.now(),
): number {
  return secondsUntil(expiresAt, SESSION_FALLBACK_SECONDS, SESSION_MAX_SECONDS, nowMs);
}

/** `maxAge` de `st_trusted`: hasta que vence el equipo de confianza en la API. */
export function trustedDeviceCookieMaxAge(
  expiresAt?: string | Date | null,
  nowMs: number = Date.now(),
): number {
  return secondsUntil(
    expiresAt,
    TRUSTED_DEVICE_FALLBACK_SECONDS,
    TRUSTED_DEVICE_MAX_SECONDS,
    nowMs,
  );
}
