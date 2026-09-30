import {
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { currentContext } from '../request-context/request-context.js';

export const SELLER_RATE_LIMIT_KEY = 'sellerRateLimit';

/** Cuántos pedidos de una ruta de venta admite un vendedor en su nodo, por ventana. */
export interface SellerRateLimitOptions {
  /** Nombre del cupo: rutas distintas con el mismo nombre lo comparten. */
  readonly bucket: string;
  readonly limit: number;
  readonly ttlMs: number;
}

/** Por encima de esto se barren las ventanas vencidas antes de abrir otra. */
const SWEEP_AT = 5_000;

interface Window {
  hits: number;
  readonly resetAt: number;
}

/**
 * Tope por vendedor y nodo activo, con ventana fija y en memoria (un contenedor api, como el
 * throttler global).
 *
 * Existe porque el tope por IP no separa a nadie en las rutas que web-b2b llama desde su servidor:
 * todas llegan desde el mismo peer, así que un tope por IP en el PreBook o el Book de hoteles sería
 * uno solo para toda la plataforma, y el doble clic de una agencia frenaría las ventas de las demás.
 * Corre después de AuthGuard (es guard de ruta), así que la clave es el usuario autenticado y el
 * tenant que resolvió el contexto, nunca una cabecera que manda el cliente.
 */
@Injectable()
export class SellerRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.get<SellerRateLimitOptions | undefined>(
      SELLER_RATE_LIMIT_KEY,
      context.getHandler(),
    );
    const ctx = currentContext();
    // Sin usuario no hay a quién contarle: AuthGuard ya rechazó el pedido o la ruta es pública.
    if (options === undefined || ctx?.userId === undefined) return true;

    const now = this.now();
    const key = `${options.bucket}|${ctx.userId}|${ctx.tenantId ?? '-'}`;
    let window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      if (this.windows.size >= SWEEP_AT) this.sweep(now);
      window = { hits: 0, resetAt: now + options.ttlMs };
      this.windows.set(key, window);
    }
    window.hits += 1;
    if (window.hits <= options.limit) return true;

    const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    const res = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
    res.header?.('Retry-After', String(retryAfter));
    throw new ThrottlerException();
  }

  /** El reloj; los tests lo mueven con los timers falsos de vitest. */
  protected now(): number {
    return Date.now();
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

/**
 * Aplica {@link SellerRateLimitGuard} a la ruta con su cupo. No reemplaza al throttler global por
 * IP (`IpThrottlerGuard`), que sigue frenando lo que llega sin autenticar.
 */
export const SellerRateLimit = (options: SellerRateLimitOptions): MethodDecorator =>
  applyDecorators(SetMetadata(SELLER_RATE_LIMIT_KEY, options), UseGuards(SellerRateLimitGuard));
