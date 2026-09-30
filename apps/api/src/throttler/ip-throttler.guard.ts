import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveClientOrigin } from '../request-context/client-origin.js';

/**
 * ThrottlerGuard que identifica al cliente por su IP real, la misma que queda en sesiones y
 * auditoría (`resolveClientOrigin`).
 *
 * La IP la resuelve Caddy: cree `CF-Connecting-IP` sólo si la conexión viene de un rango de
 * Cloudflare y la escribe en `X-Edge-Peer-IP`. El panel (web-b2b), que llama por la red interna,
 * la reenvía en `x-client-ip` con el secreto interno. Un mismo usuario tiene así UN cupo, entre
 * por el panel o directo al api, y ni rotar `CF-Connecting-IP` ni cambiar de dirección dentro de
 * su red IPv6 /64 le dan uno nuevo.
 *
 * Antes la clave de un cliente directo era `peer|CF-Connecting-IP`: el peer es el borde de
 * Cloudflare, que rota entre conexiones (el cupo de un usuario se repartía), y quien llegaba al
 * origen sin Cloudflare estrenaba cupo con cada `CF-Connecting-IP` inventada.
 *
 * NOTA OPERATIVA: si la conexión NO viene de Cloudflare, Caddy toma el peer TCP, que no se
 * falsifica. Cerrar el origen al resto (firewall) sigue haciendo falta para que nadie evite el WAF,
 * pero ya no para que la clave del throttler sea confiable. Ver infrastructure/hostinger/README.md
 * §10.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(resolveClientOrigin(req).trackerKey);
  }
}
