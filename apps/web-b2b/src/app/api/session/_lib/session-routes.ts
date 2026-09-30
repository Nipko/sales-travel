/**
 * Piezas puras de los route handlers de `/api/session/*` (ping, logout, end), separadas para
 * probarlas sin Next.
 */

import { COOKIES_CLEARED_ON_LOGOUT } from '../../../../lib/session-cookies';
import { isSessionReason } from '../../../../lib/session-reasons';
import { isTokenExpired } from '../../../login/login-redirect';
import { MFA_STEP_UP_REQUIRED } from '../../../../components/layout/session-gate';

/**
 * Nada de lo que responde `/api/session/*` se guarda: ni el estado de la sesión ni una redirección
 * al login pueden salir de una caché (del navegador, del bfcache o de un proxy).
 */
export const NO_STORE = 'no-store, max-age=0';

/** Lo que se lee de las cabeceras del request (`Headers` alcanza). */
export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * ¿El POST viene de una página del propio panel?
 *
 * Los route handlers no tienen el chequeo de origen que Next les pone a los server actions, y la
 * cookie `SameSite=Lax` no frena a un subdominio hermano (same-site). `Sec-Fetch-Site` lo mandan
 * todos los navegadores actuales y el sitio no lo puede falsificar; si falta (navegador viejo), se
 * compara `Origin` con el host. Sin ninguno de los dos no es un navegador, y sin navegador no hay
 * cookie de la víctima que aprovechar.
 */
export function isSameOriginRequest(headers: HeaderSource): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';

  const origin = headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [headers.get('x-forwarded-host'), headers.get('host')].filter(
    (h): h is string => typeof h === 'string' && h.length > 0,
  );
  return hosts.some((h) => h.split(',')[0]?.trim().toLowerCase() === originHost.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cuerpo de `POST /api/session/ping`: `active` sólo si viene `true` (ante la duda, pasivo). */
export function parsePingBody(raw: unknown): { active: boolean } {
  return { active: isRecord(raw) && raw['active'] === true };
}

/**
 * ¿Un 401 del API al ping quiere decir que la sesión terminó?
 *
 * Sí si trae el motivo (de sesión, o MFA_STEP_UP_REQUIRED) o si el token ya venció por su `exp`.
 * Un 401 pelado con un token vigente, no: el API también lo responde cuando no pudo consultar la
 * base (el middleware es fail-closed y deja el request sin usuario), y un pool saturado o un
 * reinicio de Postgres durante un deploy echaba al login a todos los conectados cuyo ping cayera
 * en esos segundos. Se reintenta: si la sesión de verdad no sirve, lo dice el próximo ping con su
 * motivo, la próxima pantalla que dibuje el layout, o el propio reloj de la guardia.
 */
export function unauthorizedEndsSession(
  reason: string | undefined,
  token: string,
  nowMs: number,
): boolean {
  if (isSessionReason(reason) || reason === MFA_STEP_UP_REQUIRED) return true;
  return isTokenExpired(token, nowMs);
}

/** Cuerpo de `POST /api/session/logout`: `{ reason: 'idle' }` es el cierre por inactividad. */
export function parseLogoutBody(raw: unknown): { idle: boolean } {
  return { idle: isRecord(raw) && raw['reason'] === 'idle' };
}

/** Lo que se le manda a `POST /auth/logout` del API. */
export function apiLogoutBody(idle: boolean): string {
  return JSON.stringify(idle ? { reason: 'idle' } : {});
}

/** Algo con cookies que se pueden borrar (el `cookies` de un `NextResponse`). */
export interface CookieSink {
  delete(name: string): unknown;
}

/** Borra `st_session` y `st_tenant`. `st_trusted` se queda: es del equipo, no de la sesión. */
export function clearSessionCookies(cookies: CookieSink): void {
  for (const name of COOKIES_CLEARED_ON_LOGOUT) cookies.delete(name);
}

/**
 * ¿Es el pedido del router de Next (una navegación de cliente o un `redirect()` de un Server
 * Component en medio de una)? Next lo marca con la cabecera `RSC: 1`.
 */
export function isRouterRequest(headers: HeaderSource): boolean {
  return headers.get('rsc') === '1';
}
