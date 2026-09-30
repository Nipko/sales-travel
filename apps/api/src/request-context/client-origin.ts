import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Cabeceras que agrega el panel (web-b2b) al llamar al api por la red interna. */
export const INTERNAL_PROXY_HEADER = 'x-internal-proxy';
export const CLIENT_IP_HEADER = 'x-client-ip';
export const CLIENT_USER_AGENT_HEADER = 'x-client-user-agent';
/**
 * La IP del usuario tal como la resolvió Caddy (`{client_ip}`). El nombre es histórico: hasta el
 * cambio de `trusted_proxies` llevaba el peer TCP, que detrás de Cloudflare es el borde y no el
 * usuario. Caddy la escribe en cada `reverse_proxy` pisando la que mande el cliente.
 */
export const EDGE_CLIENT_IP_HEADER = 'x-edge-peer-ip';

/** Por debajo de esto el secreto se adivina: se trata como no configurado. */
const MIN_SECRET_LENGTH = 32;
/** Lo mismo que guarda `sessions.user_agent`. */
const MAX_USER_AGENT_LENGTH = 512;
/** Grupos de 16 bits que forman el prefijo /64 de una IPv6. */
const IPV6_PREFIX_GROUPS = 4;

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
 * La IP la decide UNA vez Caddy, y el resto la transporta sin reinterpretarla
 * (`infrastructure/hostinger/README.md` §10):
 *
 * 1. Caddy cree `CF-Connecting-IP` sólo si la conexión TCP viene de un rango de Cloudflare
 *    (`trusted_proxies` + `client_ip_headers`); si no, el usuario es el peer. El resultado,
 *    `{client_ip}`, va en `X-Edge-Peer-IP` a los dos upstreams.
 * 2. El panel (web-b2b) llama al api por la red interna, sin Caddy de por medio: sin más, el api
 *    veía la IP del contenedor y el user-agent de Node para todos (UN cupo de login para toda la
 *    plataforma, dispositivos iguales en "Seguridad", auditoría inútil). Reenvía la
 *    `X-Edge-Peer-IP` que recibió en `x-client-ip` y el navegador en `x-client-user-agent`, junto
 *    con `x-internal-proxy: <INTERNAL_PROXY_SECRET>`.
 * 3. El api es público (api.planetour.cloud): los `x-client-*` sólo se creen si el secreto
 *    coincide, comparado en tiempo constante. Sin secreto configurado (o con uno corto) no se creen
 *    nunca. Además Caddy los borra de todo request que llega de afuera.
 *
 * Así el mismo usuario tiene la misma IP y el mismo cupo entre por el panel o directo al api.
 * `CF-Connecting-IP` no se lee acá: la escribe cualquiera que llegue al origen sin pasar por
 * Cloudflare, y rotarla le daba un cupo nuevo en cada intento.
 */
export function resolveClientOrigin(
  req: OriginRequest,
  secret: string | undefined = process.env['INTERNAL_PROXY_SECRET'],
): ClientOrigin {
  const headers = asRecord(req.headers);
  const direct = directOrigin(req, headers);

  if (!proxySecretMatches(header(headers, INTERNAL_PROXY_HEADER), secret)) return direct;

  const ip = forwardedClientIp(header(headers, CLIENT_IP_HEADER));
  const userAgent = truncate(header(headers, CLIENT_USER_AGENT_HEADER));

  return {
    ip,
    // Sin el user-agent del navegador no se usa el del panel: sería el de Node, no el del usuario.
    ...(userAgent === undefined ? {} : { userAgent }),
    // Si el panel no supo la IP, el request sigue contando contra el cupo del contenedor.
    trackerKey: ip === undefined ? direct.trackerKey : throttleKey(ip),
    viaInternalProxy: true,
  };
}

/**
 * Lo que se ve sin el panel de por medio: la IP que Caddy escribió en `X-Edge-Peer-IP`. Sin ella
 * (desarrollo sin Caddy, o un llamado por la red interna que no trae el secreto) queda `req.ip`.
 * El puerto 3000 del api no se publica: sólo lo alcanzan Caddy y el panel.
 */
function directOrigin(req: OriginRequest, headers: Record<string, unknown>): ClientOrigin {
  const ip =
    validIp(header(headers, EDGE_CLIENT_IP_HEADER)) ??
    validIp(typeof req.ip === 'string' ? req.ip : undefined);
  const userAgent = truncate(header(headers, 'user-agent'));
  return {
    ...(ip === undefined ? {} : { ip }),
    ...(userAgent === undefined ? {} : { userAgent }),
    trackerKey: ip === undefined ? 'unknown' : throttleKey(ip),
    viaInternalProxy: false,
  };
}

/**
 * La IP que reenvió el panel: UNA, la `X-Edge-Peer-IP` que Caddy le puso al request del navegador.
 *
 * Un panel anterior a este cambio mandaba `peer|cf-connecting-ip`. Si coinciden en un despliegue,
 * vale SÓLO la primera, la que escribió Caddy: la segunda la puede elegir quien llama, así que no se
 * usa nunca, tampoco cuando la primera no es una IP.
 */
function forwardedClientIp(value: string | undefined): string | undefined {
  return validIp(value?.split(/[|,]/)[0]);
}

/**
 * La clave del throttler para una IP. Una IPv4 cuenta sola; una IPv6, por su red /64: cualquier
 * conexión con IPv6 (una casa, un móvil, un VPS de 5 dólares) recibe al menos un /64 y elige la
 * dirección dentro de él sin pedirle nada a nadie, así que contar la dirección entera le daba un
 * cupo nuevo en cada intento. El precio, aceptado (infrastructure/hostinger/README.md §10.5): quien
 * comparte un /64 con otros (iCloud Private Relay, algunos hostings) comparte el cupo, y quien
 * tiene un /56 o un /48 sigue teniendo varios.
 */
function throttleKey(ip: string): string {
  const groups = isIP(ip) === 6 ? ipv6Groups(ip) : undefined;
  if (groups === undefined) return ip;
  const prefix = groups.slice(0, IPV6_PREFIX_GROUPS).map((group) => group.toString(16));
  return `${prefix.join(':')}::/64`;
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

/**
 * Sólo direcciones que Postgres acepta como `inet` (una IP inválida rompería el INSERT del login),
 * escritas siempre igual para que la misma conexión dé la misma clave: IPv6 en minúsculas, sin zona
 * (`%eth0`, que `inet` rechaza) y la IPv4 mapeada (`::ffff:190.24.8.9`) como IPv4.
 */
function validIp(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text || text.includes('%')) return undefined;
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6) return undefined;
  const groups = ipv6Groups(text);
  if (groups === undefined) return undefined;
  if (isIpv4Mapped(groups)) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return text.toLowerCase();
}

/** `::ffff:a.b.c.d`: cinco grupos en cero y `ffff`. */
function isIpv4Mapped(groups: readonly number[]): boolean {
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

/**
 * Los ocho grupos de 16 bits de una IPv6 ya validada con `isIP`, con `::` expandido y una IPv4 al
 * final (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) pasada a sus dos grupos. undefined si no cuadra.
 */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const tailStart = text.lastIndexOf(':') + 1;
  const tail = text.slice(tailStart);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return undefined;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, tailStart)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;

  const groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}
