import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Cabeceras que agrega el panel (web-b2b) al llamar al api por la red interna. */
export const INTERNAL_PROXY_HEADER = 'x-internal-proxy';
export const CLIENT_IP_HEADER = 'x-client-ip';
export const CLIENT_USER_AGENT_HEADER = 'x-client-user-agent';

/** Por debajo de esto el secreto se adivina: se trata como no configurado. */
const MIN_SECRET_LENGTH = 32;
/** Lo mismo que guarda `sessions.user_agent`. */
const MAX_USER_AGENT_LENGTH = 512;

export interface ClientOrigin {
  /** IP del usuario, válida para `inet`. undefined si no se conoce. */
  ip?: string;
  userAgent?: string;
  /** Clave del rate limiting (IpThrottlerGuard). */
  trackerKey: string;
  /** Los `x-client-*` vinieron del panel con el secreto correcto y se usaron. */
  viaInternalProxy: boolean;
}

/** Lo mínimo de un request: sirve el de Express y el `Record` que recibe el throttler. */
export interface OriginRequest {
  headers?: unknown;
  ip?: unknown;
}

/**
 * IP, navegador y clave de throttling del USUARIO que originó el request.
 *
 * El panel llama al api servidor a servidor por la red interna: sin esto el api veía la IP del
 * contenedor web-b2b y el user-agent de Node para todos. Los dispositivos de "Seguridad" salían
 * iguales, la auditoría no servía para investigar y el anti brute-force del login era UN cupo para
 * toda la plataforma (el usuario número 11 del minuto recibía 429).
 *
 * El panel reenvía lo que vio del navegador en `x-client-ip` y `x-client-user-agent`, junto con
 * `x-internal-proxy: <INTERNAL_PROXY_SECRET>`. El api es público (api.planetour.cloud): esas
 * cabeceras sólo se creen si el secreto coincide, comparado en tiempo constante. Sin secreto
 * configurado (o con uno corto) no se cree nunca, y todo queda como antes.
 *
 * `x-client-ip` admite una IP o varias separadas por `|` (p. ej. `peer|cf-connecting-ip`): la
 * última es la del usuario y todas juntas son la clave del throttler, igual que hacía el guard
 * con `X-Edge-Peer-IP|CF-Connecting-IP`.
 */
export function resolveClientOrigin(
  req: OriginRequest,
  secret: string | undefined = process.env['INTERNAL_PROXY_SECRET'],
): ClientOrigin {
  const headers = asRecord(req.headers);
  const direct = directOrigin(req, headers);

  if (!proxySecretMatches(header(headers, INTERNAL_PROXY_HEADER), secret)) return direct;

  const ips = (header(headers, CLIENT_IP_HEADER) ?? '')
    .split(/[|,]/)
    .map((part) => validIp(part.trim()))
    .filter((ip): ip is string => ip !== undefined);
  const userAgent = truncate(header(headers, CLIENT_USER_AGENT_HEADER));

  return {
    ip: ips[ips.length - 1],
    // Sin el user-agent del navegador no se usa el del panel: sería el de Node, no el del usuario.
    ...(userAgent === undefined ? {} : { userAgent }),
    // Si el panel no supo la IP, el request sigue contando contra el cupo del contenedor.
    trackerKey: ips.length > 0 ? ips.join('|') : direct.trackerKey,
    viaInternalProxy: true,
  };
}

/**
 * Lo que se ve sin el panel de por medio. La clave combina `CF-Connecting-IP` (que manda
 * cualquiera) con `X-Edge-Peer-IP`, que Caddy borra del request entrante y reescribe con el peer
 * TCP real: forjar la primera no despega la clave del peer.
 */
function directOrigin(req: OriginRequest, headers: Record<string, unknown>): ClientOrigin {
  const reqIp = validIp(typeof req.ip === 'string' ? req.ip : undefined);
  const peer = validIp(header(headers, 'x-edge-peer-ip')) ?? reqIp ?? 'unknown';
  const claimed = validIp(header(headers, 'cf-connecting-ip'));
  const userAgent = truncate(header(headers, 'user-agent'));
  return {
    ...(reqIp === undefined ? {} : { ip: reqIp }),
    ...(userAgent === undefined ? {} : { userAgent }),
    trackerKey: claimed ? `${peer}|${claimed}` : peer,
    viaInternalProxy: false,
  };
}

/**
 * Compara los sha256 y no los valores: `timingSafeEqual` exige el mismo largo, y comparar largos
 * primero filtraría el del secreto.
 */
export function proxySecretMatches(
  presented: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH || !presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Sólo direcciones que Postgres acepta como `inet`: una IP inválida rompería el INSERT del login. */
function validIp(value: string | undefined): string | undefined {
  return value !== undefined && isIP(value) !== 0 ? value : undefined;
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}
