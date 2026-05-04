import type { LatamNdcConfig } from '../config';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
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

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LATAM oauth/cc/token ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as TokenResponse;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new Error('LATAM oauth/cc/token: malformed response');
    }

    const expiresAt = Date.now() + Math.max(60, data.expires_in - 60) * 1000;
    this.cached = { value: data.access_token, expiresAt };
    return data.access_token;
  }
}
