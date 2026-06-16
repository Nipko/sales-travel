import type { LatamNdcConfig } from '../config';
import { LatamApiError } from '../errors';

interface TokenResponse {
  access_token?: string;
  accessToken?: string;
  expires_in?: number | string;
  expiresIn?: number | string;
  token_type?: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Pide Bearer al endpoint OAuth2 de LATAM con basic auth (apikey:secret).
 * Cachea el token en memoria hasta `expires_in - 60s` (margen de seguridad).
 *
 * Notas:
 * - LATAM usa `application/x-www-form-urlencoded` con `grant_type=client_credentials`.
 * - Hay que mandar TANTO basic auth como header `x-api-key`.
 */
export class LatamTokenService {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly cfg: LatamNdcConfig) {}

  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.value;
    }
    // Coalesce: si ya hay un fetch en vuelo, esperar ese.
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const path = '/oauth/cc/token';
    if (!this.cfg.apiKey || !this.cfg.apiSecret) {
      throw new LatamApiError(401, 'apiKey and apiSecret required', path);
    }

    const basic = Buffer.from(`${this.cfg.apiKey}:${this.cfg.apiSecret}`).toString('base64');
    const url = `${this.cfg.apiUrl.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'x-api-key': this.cfg.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal,
      });
    } catch (err) {
      throw new LatamApiError(
        0,
        (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message,
        path,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new LatamApiError(res.status, text.slice(0, 400), path);
    }

    let data: TokenResponse;
    try {
      data = JSON.parse(text) as TokenResponse;
    } catch {
      throw new LatamApiError(res.status, `non-JSON token response: ${text.slice(0, 200)}`, path);
    }

    const accessToken = data.access_token ?? data.accessToken;
    const rawExpires = data.expires_in ?? data.expiresIn;
    const expiresIn = typeof rawExpires === 'string' ? Number(rawExpires) : rawExpires;
    if (!accessToken || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      throw new LatamApiError(
        res.status,
        'missing access_token/expires_in in token response',
        path,
      );
    }

    const expiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    this.cached = { value: accessToken, expiresAt };
    return accessToken;
  }
}
