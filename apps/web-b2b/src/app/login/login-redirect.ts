import { SAFE_NEXT_FALLBACK, safeNextPath } from '../../lib/safe-next';
import type { SessionMotivo } from '../../lib/session-reasons';

/**
 * Lo que el middleware necesita para mandar al login sin perder a dónde iba el usuario. Sin
 * `next/server`, para probarlo sin levantar Next.
 */

/**
 * Parámetros que agrega Next a sus propios pedidos (el `_rsc` de una navegación del cliente) y que
 * no son parte de la pantalla que el usuario pidió.
 */
const INTERNAL_PARAMS = ['_rsc'] as const;

/** La pantalla que pidió el usuario (ruta y query), sin lo que agrega Next a sus pedidos. */
export function requestedPathOf(requested: { pathname: string; search: string }): string {
  const params = new URLSearchParams(requested.search);
  for (const name of INTERNAL_PARAMS) params.delete(name);
  const query = params.toString();
  return `${requested.pathname}${query ? `?${query}` : ''}`;
}

/**
 * `/login?next=<ruta>` para volver a donde se iba después de entrar (un link a una reserva que
 * llegó por WhatsApp, por ejemplo). Al inicio no hace falta `next`: es el destino por defecto.
 */
export function loginUrlFor(requested: URL, options: { motivo?: SessionMotivo | null } = {}): URL {
  const next = safeNextPath(requestedPathOf(requested));

  const url = new URL('/login', requested);
  if (next !== SAFE_NEXT_FALLBACK) url.searchParams.set('next', next);
  if (options.motivo) url.searchParams.set('motivo', options.motivo);
  return url;
}

function decodeBase64Url(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

/** El payload del JWT, SIN verificar la firma. `null` si no se puede leer. */
function tokenPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  const json = decodeBase64Url(payload);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Cuándo vence el access token según su propio `exp`, en ms; `null` si no se puede leer.
 *
 * NO verifica la firma y no hace falta: sólo sirve para darse cuenta de que un token YA venció y
 * no mandar al panel a alguien que va a recibir un 401. Un token con un `exp` inventado pasa este
 * filtro igual que antes y lo rechaza la API, que es la que valida.
 */
export function tokenExpiresAtMs(token: string): number | null {
  const exp = tokenPayload(token)?.['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El tenant de la sesión (`tid`), SIN verificar la firma. Lo usa el middleware para que la cookie
 * `st_tenant` (la cabecera `x-tenant-id`) no se despegue nunca de la sesión: un `tid` inventado no
 * sirve de nada, porque la API vuelve a validar el token y sólo honra la cabecera si el usuario está
 * autorizado en ese tenant.
 */
export function tokenTenantId(token: string): string | null {
  const tid = tokenPayload(token)?.['tid'];
  return typeof tid === 'string' && UUID.test(tid) ? tid : null;
}

/** ¿El token ya venció seguro? Si no se puede leer, se asume vivo y decide la API. */
export function isTokenExpired(token: string, nowMs: number): boolean {
  const expiresAt = tokenExpiresAtMs(token);
  return expiresAt !== null && expiresAt <= nowMs;
}
