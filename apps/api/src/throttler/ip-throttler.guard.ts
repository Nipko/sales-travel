import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveClientOrigin } from '../request-context/client-origin.js';

/**
 * ThrottlerGuard que identifica al cliente por su IP real.
 *
 * Dos orígenes, resueltos en `resolveClientOrigin`:
 *
 * - El panel (web-b2b) llama por la red interna: la IP del request es la del contenedor y, sin más,
 *   todos los usuarios del panel compartían UN cupo (10 logins por minuto para toda la plataforma).
 *   El panel reenvía la IP del navegador en `x-client-ip` con el secreto interno, y esa es la clave.
 * - Un cliente que llega directo al api: la clave combina `CF-Connecting-IP` con `X-Edge-Peer-IP`,
 *   que Caddy borra del request entrante y reescribe con el peer TCP real, así que forjar la
 *   primera no despega la clave del origen.
 *
 * NOTA OPERATIVA: la defensa completa exige además que el origen sólo acepte tráfico de
 * los rangos de Cloudflare. Sin eso, quien alcance la IP del servidor directamente evita
 * el borde entero. Eso es configuración de firewall, no de la aplicación.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(resolveClientOrigin(req).trackerKey);
  }
}
