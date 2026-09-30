import { headers as incomingHeaders } from 'next/headers';
import { describeNonJson } from './read-json';
import { getActiveTenant, getSession, getTrustedDevice } from './session';

const BASE = process.env.INTERNAL_API_URL ?? 'http://api:3000';

/**
 * Cabeceras con las que el panel le cuenta al API quién es el usuario de verdad. El panel llama al
 * API servidor a servidor por la red interna: sin ellas el API ve la IP del contenedor y el
 * user-agent de Node para todos (un solo cupo de login para toda la plataforma, dispositivos
 * iguales en "Seguridad", auditoría sin valor). El API sólo las cree si `x-internal-proxy` trae el
 * secreto compartido (`apps/api/src/request-context/client-origin.ts`).
 */
export const INTERNAL_PROXY_HEADER = 'x-internal-proxy';
export const CLIENT_IP_HEADER = 'x-client-ip';
export const CLIENT_USER_AGENT_HEADER = 'x-client-user-agent';
export const TRUSTED_DEVICE_HEADER = 'x-trusted-device';

/** El API trata un secreto más corto como no configurado: mandarlo no serviría de nada. */
const MIN_PROXY_SECRET_LENGTH = 32;
/** Lo que guarda `sessions.user_agent`. */
const MAX_USER_AGENT_LENGTH = 512;
/** Forma de IPv4/IPv6. No valida rangos: sólo descarta basura (el API la vuelve a validar). */
const IP_LIKE = /^[0-9a-fA-F:.]{2,45}$/;

/** Lo mínimo que se lee de las cabeceras entrantes (`Headers` o el de `next/headers`). */
export interface HeaderSource {
  get(name: string): string | null;
}

function ipFrom(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && IP_LIKE.test(trimmed) ? trimmed : undefined;
}

/**
 * `x-client-ip`, `x-client-user-agent` y `x-internal-proxy` a partir del request del navegador.
 *
 * La IP va como la arma `IpThrottlerGuard`: `X-Edge-Peer-IP` (Caddy la borra del request entrante
 * y la reescribe con el peer TCP real, así que no se puede falsificar) y, si vino,
 * `CF-Connecting-IP` detrás: `peer|cf`. El API toma la última como IP del usuario y el par entero
 * como clave del throttler, así que forjar `CF-Connecting-IP` no despega la clave del peer. Sin el
 * peer (desarrollo, sin Caddy) no se manda IP: una `CF-Connecting-IP` suelta no la respalda nadie.
 *
 * Sin secreto configurado no se manda NADA: el API las ignoraría igual.
 */
export function clientOriginHeaders(
  incoming: HeaderSource | null,
  secret: string | undefined,
): Record<string, string> {
  if (!incoming || !secret || secret.length < MIN_PROXY_SECRET_LENGTH) return {};
  const out: Record<string, string> = { [INTERNAL_PROXY_HEADER]: secret };

  const peer = ipFrom(incoming.get('x-edge-peer-ip'));
  const claimed = ipFrom(incoming.get('cf-connecting-ip'));
  if (peer) out[CLIENT_IP_HEADER] = claimed && claimed !== peer ? `${peer}|${claimed}` : peer;

  // Sólo ASCII imprimible: `Headers.set` rechaza caracteres de control y los que no son Latin-1.
  const userAgent = (incoming.get('user-agent') ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, MAX_USER_AGENT_LENGTH);
  if (userAgent) out[CLIENT_USER_AGENT_HEADER] = userAgent;

  return out;
}

/**
 * El token de "recordar este equipo" viaja sólo a `/auth/*`, que es donde el API lo usa (marcar
 * "Este equipo" en la lista). Es una credencial de 30 días: no tiene por qué ir en cada búsqueda.
 */
export function sendsTrustedDevice(path: string): boolean {
  return path.startsWith('/auth/');
}

/** Las cabeceras de todo llamado al API: sesión, tenant, origen del usuario y equipo de confianza. */
async function buildHeaders(path: string, init: RequestInit): Promise<Headers> {
  const token = await getSession();
  const tenantId = await getActiveTenant();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (tenantId) headers.set('x-tenant-id', tenantId);

  // `next/headers` y las cookies tiran fuera de un request (un script, un test): ahí no hay
  // navegador del que contar nada y el llamado sigue sin estas cabeceras.
  let incoming: HeaderSource | null = null;
  try {
    incoming = await incomingHeaders();
  } catch {
    incoming = null;
  }
  const origin = clientOriginHeaders(incoming, process.env.INTERNAL_PROXY_SECRET);
  for (const [name, value] of Object.entries(origin)) headers.set(name, value);

  if (sendsTrustedDevice(path)) {
    try {
      const trusted = await getTrustedDevice();
      if (trusted) headers.set(TRUSTED_DEVICE_HEADER, trusted);
    } catch {
      // Ídem: sin request no hay cookie.
    }
  }
  return headers;
}

/** Lo que se responde cuando el API no se pudo alcanzar siquiera. */
export const SERVICIO_NO_DISPONIBLE = 503;

/**
 * Un estado que `NextResponse.json` acepta.
 *
 * Existe porque `ApiError.status` viaja SIN MIRAR a 48 rutas de `app/api/`, y ahí un valor fuera
 * de 200-599 no da un error legible sino una página HTML de Next que el cliente intenta parsear
 * como JSON. La garantía se da acá, una vez, en lugar de en cada ruta.
 */
export function estadoHttpValido(status: number): number {
  return Number.isInteger(status) && status >= 200 && status <= 599
    ? status
    : SERVICIO_NO_DISPONIBLE;
}

export interface ApiError {
  /** SIEMPRE un estado HTTP válido (200-599). Ver {@link estadoHttpValido}. */
  status: number;
  message: string;
  /**
   * Motivo máquina del API (`SESSION_IDLE`, `MFA_ENROLLMENT_REQUIRED`, `SEATS_FULL`…), si vino.
   * Es lo que se compara; `message` es sólo para mostrar.
   */
  reason?: string;
  /** Los `details` que la excepción del API declaró publicables (p. ej. `attemptsLeft`). */
  details?: unknown;
}

/** La misma forma que deja salir el filtro de excepciones del API: lo demás no es un motivo. */
const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * El `ApiError` de una respuesta de error: `message` (texto o lista), `reason` y `details` del
 * cuerpo; si el cuerpo no trae mensaje, el `statusText`.
 */
export function apiErrorFromBody(status: number, statusText: string, body: unknown): ApiError {
  const error: ApiError = { status: estadoHttpValido(status), message: statusText };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return error;
  const record = body as Record<string, unknown>;

  const message = record['message'];
  if (Array.isArray(message)) {
    const parts = message.filter((m): m is string => typeof m === 'string');
    if (parts.length > 0) error.message = parts.join(', ');
  } else if (typeof message === 'string' && message) {
    error.message = message;
  }

  const reason = record['reason'];
  if (typeof reason === 'string' && MACHINE_REASON.test(reason)) error.reason = reason;
  if (record['details'] !== undefined) error.details = record['details'];
  return error;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const headers = await buildHeaders(path, init);

  try {
    const res = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    });

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = (await res.json()) as unknown;
      } catch {
        // Cuerpo que no es JSON: queda el statusText.
      }
      const apiError = apiErrorFromBody(res.status, res.statusText, body);
      console.error(
        `[API FETCH ERROR] PATH: ${path}, STATUS: ${res.status}, REASON: ${apiError.reason ?? '-'}, MESSAGE: ${apiError.message}`,
      );
      return { ok: false, error: apiError };
    }

    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // El detalle técnico queda en el log; al usuario se le muestra un mensaje claro y accionable.
    console.error(`[API FETCH CONNECTION ERROR] PATH: ${path}, ERROR: ${message}`);
    return {
      ok: false,
      error: {
        // 503, NO 0. Un `status: 0` no es un estado HTTP, y las 48 rutas de `app/api/` lo
        // reenvían tal cual a `NextResponse.json(..., { status })`, que exige 200-599: lanzaba
        // `RangeError`, Next devolvía su página HTML de error y el navegador moría con
        // «Unexpected token '<', "<!DOCTYPE "... is not valid JSON» — un mensaje que no se
        // parece en nada a «no se pudo conectar», que es lo que realmente había pasado.
        status: SERVICIO_NO_DISPONIBLE,
        message: 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.',
      },
    };
  }
}

/**
 * Lo que respondió el API, con su estado y su cuerpo tal cual.
 *
 * `api()` no alcanza para una reserva de hotel (docs/tbo/03 §4.5 punto 6; 08 RF-22): en éxito
 * devuelve sólo el cuerpo, así que un `202` ("sigue en curso, consultá la orden") llegaba al
 * navegador igual que un `201`; y en error conserva sólo `message`, así que se perdían el precio
 * nuevo de un `409`, la orden existente de un doble envío y las marcas `retryForbidden` y
 * `reconciliationRequired`, que son las que dicen que NO hay que repetir la reserva.
 */
export type ApiResponse =
  /** El API respondió con JSON: `body` es su cuerpo completo, de éxito o de error. */
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  /** Respondió algo que no es JSON (la página de error de un proxy): sólo queda el estado. */
  | { readonly kind: 'not-json'; readonly status: number; readonly message: string }
  /**
   * No hubo respuesta. Para una escritura NO prueba que no llegó: la conexión pudo cortarse
   * después de enviar el pedido.
   */
  | { readonly kind: 'unreachable'; readonly status: number; readonly message: string };

/** Lee el cuerpo UNA vez; el estado sale siempre dentro de 200-599 ({@link estadoHttpValido}). */
export async function readApiResponse(res: Response): Promise<ApiResponse> {
  const status = estadoHttpValido(res.status);
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: 'not-json', status, message: describeNonJson(res.status, '') };
  }
  try {
    return { kind: 'json', status, body: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'not-json', status, message: describeNonJson(res.status, text) };
  }
}

/**
 * Como {@link api}, pero devuelve el estado y el cuerpo completo en éxito y en error. Nunca
 * registra cuerpos: los de una reserva llevan nombres de huéspedes.
 */
export async function apiWithStatus(path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const headers = await buildHeaders(path, init);

  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { ...init, headers, cache: 'no-store' });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError';
    console.error(`[API FETCH CONNECTION ERROR] PATH: ${path}, ERROR: ${name}`);
    return {
      kind: 'unreachable',
      status: SERVICIO_NO_DISPONIBLE,
      message: 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.',
    };
  }

  const read = await readApiResponse(res);
  if (read.kind === 'not-json') {
    console.error(`[API FETCH ERROR] PATH: ${path}, STATUS: ${res.status}, BODY: no JSON`);
  }
  return read;
}
