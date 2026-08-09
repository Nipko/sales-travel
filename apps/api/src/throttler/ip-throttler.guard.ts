import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** IPv4 o IPv6 con forma razonable. No valida rangos: sólo descarta basura. */
const IP_LIKE = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * ThrottlerGuard que identifica al cliente por su IP real.
 *
 * Detrás de Cloudflare la IP del usuario llega en `CF-Connecting-IP`, pero ESA CABECERA
 * LA PUEDE MANDAR CUALQUIERA: hasta ahora se usaba tal cual como clave, así que bastaba
 * con enviar un CF-Connecting-IP distinto en cada intento para estrenar cupo y evadir por
 * completo el anti brute-force del login (10 intentos/min).
 *
 * Ahora la clave combina la cabecera con `X-Edge-Peer-IP`, que Caddy borra del request
 * entrante y reescribe con el peer TCP real. Falsificar CF-Connecting-IP ya no despega la
 * clave del origen: todos los intentos de una misma conexión comparten el componente que
 * el cliente no controla.
 *
 * NOTA OPERATIVA: la defensa completa exige además que el origen sólo acepte tráfico de
 * los rangos de Cloudflare. Sin eso, quien alcance la IP del servidor directamente evita
 * el borde entero. Eso es configuración de firewall, no de la aplicación.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req['headers'] ?? {}) as Record<string, unknown>;

    const peer = pick(headers['x-edge-peer-ip']) ?? pick(req['ip']) ?? 'unknown';
    const claimed = pick(headers['cf-connecting-ip']);

    // Sin cabecera de borde válida, el peer solo ya identifica al cliente.
    return Promise.resolve(claimed ? `${peer}|${claimed}` : peer);
  }
}

function pick(value: unknown): string | undefined {
  return typeof value === 'string' && IP_LIKE.test(value) ? value : undefined;
}
