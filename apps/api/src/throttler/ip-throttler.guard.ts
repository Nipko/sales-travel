import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard que identifica al cliente por su IP real. Detrás de Cloudflare la IP
 * del usuario llega en `CF-Connecting-IP`; si no, se usa `req.ip` (que con trust proxy
 * refleja X-Forwarded-For). Evita throttlear a todos juntos bajo la IP del proxy.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req['headers'] ?? {}) as Record<string, unknown>;
    const cf = headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length > 0) return Promise.resolve(cf);
    const ip = req['ip'];
    return Promise.resolve(typeof ip === 'string' && ip.length > 0 ? ip : 'unknown');
  }
}
