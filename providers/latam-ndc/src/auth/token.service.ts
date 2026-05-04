import type { LatamNdcConfig } from '../config';

interface TokenResponse {
  access_token?: string;
  accessToken?: string;
  expires_in?: number;
  expiresIn?: number;
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
    if (!this.cfg.apiKey || !this.cfg.apiSecret) {
      throw new Error('LatamTokenService: apiKey and apiSecret required');
    }

    const basic = Buffer.from(`${this.cfg.apiKey}:${this.cfg.apiSecret}`).toString('base64');
    const url = `${this.cfg.apiUrl.replace(/\/$/, '')}/oauth/cc/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'x-api-key': this.cfg.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `LATAM oauth/cc/token ${res.status} (content-type=${res.headers.get('content-type') ?? '?'}): ${text.slice(0, 400)}`,
      );
    }

    let data: TokenResponse;
    try {
      data = JSON.parse(text) as TokenResponse;
    } catch {
      throw new Error(
        `LATAM oauth/cc/token: non-JSON response (content-type=${res.headers.get('content-type') ?? '?'}): ${text.slice(0, 400)}`,
      );
    }

    const accessToken = data.access_token ?? data.accessToken;
    const expiresIn = data.expires_in ?? data.expiresIn;
    if (!accessToken || typeof expiresIn !== 'number') {
      throw new Error(
        `LATAM oauth/cc/token: missing access_token/expires_in. Body keys=[${Object.keys(data).join(',')}] body=${text.slice(0, 400)}`,
      );
    }

    const expiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    this.cached = { value: accessToken, expiresAt };
    return accessToken;
  }
}
