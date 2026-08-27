import { createHash } from 'node:crypto';
import type { CachePort, LoggerPort } from '@sales-travel/core';
import { z } from 'zod';
import {
  SABRE_AUTH_PATH,
  SABRE_TOKEN_TTL_MARGIN,
  sabreDomain,
  sabreRequestTimeoutMs,
  sabreTokenTtlSeconds,
  sabreUrl,
  missingSabreCredentials,
  type SabreConfig,
} from '../config';
import {
  SABRE_MAX_ATTEMPTS,
  SabreApiError,
  SabreConfigError,
  classifySabreFailure,
  sabreBackoffDelayMs,
} from '../errors';
import { logRedacted, type SabreLogLevel } from '../redaction';

/** Lo que el cliente HTTP necesita de un proveedor de tokens. Permite falsearlo en tests. */
export interface SabreTokenProvider {
  getToken(): Promise<string>;
  invalidate(): Promise<void>;
}

export interface SabreSecretInput {
  epr: string;
  homePcc: string;
  password: string;
  /** Default `AA`. Es el `Domain` del `clientId`, no el del `UsernameToken` SOAP. */
  domain?: string;
}

function base64Utf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Deriva el `secret` del header `Authorization: Basic` de `/v2/auth/token`.
 *
 * Esquema de **doble base64**, VERIFICADO en el script pre-request de la colección oficial
 * (docs/sabre/01 §2.1):
 *
 *     secret = base64( base64("V1:" + EPR + ":" + PCC + ":" + Domain) + ":" + base64(password) )
 *
 * OJO: el resultado es **reversible**. Quien tenga el `secret` tiene el password de la oficina en
 * claro. No se persiste (se deriva en cada `fetchToken`), no se loguea y no sale por API.
 */
export function deriveSabreSecret(input: SabreSecretInput): string {
  const clientId = `V1:${input.epr}:${input.homePcc}:${input.domain ?? 'AA'}`;
  return base64Utf8(`${base64Utf8(clientId)}:${base64Utf8(input.password)}`);
}

/** Longitud de la huella en la clave de caché: 16 hex = 64 bits. */
const SABRE_FINGERPRINT_HEX_LENGTH = 16;

/**
 * Huella de la identidad que determina un ATK. Entra en la clave de caché **en lugar de** las
 * credenciales.
 *
 * Por qué un digest y no los valores en claro: una clave de caché no es un dato interno. Aparece en
 * los logs de `sabre.token.cache_corrupta`, en las métricas de hit-ratio, en cualquier `SCAN` de
 * Redis y en las capturas que se pegan en un ticket de soporte. Meter ahí el `password` —o el
 * `secret`, que es base64 reversible del password (R-13)— sería filtrar la credencial de la oficina
 * por un canal que nadie trata como sensible.
 *
 * Por qué SHA-256 truncado a 64 bits y no algo más caro: la huella sólo tiene que **separar**
 * identidades, no autenticar. 64 bits dan colisión despreciable para el número de cuentas de un
 * consolidador, y truncar reduce lo que un digest completo revelaría si el password fuese débil.
 * Quien pueda leer estas claves ya tiene el ATK guardado a su lado, que es el activo caro.
 *
 * El separador NUL es deliberado —y no puede aparecer dentro de ninguna de las partes—: sin un
 * separador inequívoco, (`50`, `0001`) y (`500`, `001`) darían la misma huella y dos oficinas
 * distintas volverían a compartir token.
 */
function credentialFingerprint(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, SABRE_FINGERPRINT_HEX_LENGTH);
}

/**
 * Respuesta del token. `expires_in` y `token_type` **no aparecen en ningún contrato ni en la
 * colección** (docs/sabre/01 §7.1): son opcionales a propósito. El ejemplo oficial de
 * `help/get-hotel-avail-v5.0` muestra `604800` (7 días), pero el valor real es contractual.
 */
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().optional(),
});

const CachedTokenSchema = z.object({
  value: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

type CachedToken = z.infer<typeof CachedTokenSchema>;

export type SabreFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface SabreTokenServiceDeps {
  fetch?: SabreFetch;
  /**
   * Caché distribuida. El TAM Pool es un límite **por contrato de agencia**, no por proceso: N
   * réplicas re-autenticando en cada deploy es la forma exacta de agotarlo (docs/sabre/01 §7.1).
   */
  cache?: CachePort;
  logger?: LoggerPort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  /**
   * `ownerTenantId` de la `provider_account` resuelta. Es el **primer** tramo de aislamiento de la
   * clave, no el único: ver `cacheKey` (RF-01 CA-2).
   */
  cacheNamespace?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Obtiene y cachea el ATK de Sabre.
 *
 * Tres desviaciones respecto de `LatamTokenService` que exige el contrato de Sabre
 * (docs/sabre/01 §7.2):
 *
 * 1. `expires_in` **puede no venir**. LATAM falla duro si falta; aquí eso rompería todo. Se cae a
 *    `config.tokenTtlSeconds` con un warning estructurado, y el `401` se trata como señal de
 *    expiración.
 * 2. La caché va al **port de caché** además de a memoria, por el TAM Pool.
 * 3. Hay política de `401` por tipo, no genérica.
 */
export class SabreTokenService implements SabreTokenProvider {
  private memo: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  private readonly fetchImpl: SabreFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(
    private readonly cfg: SabreConfig,
    private readonly deps: SabreTokenServiceDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? defaultSleep;
    this.jitter = deps.jitter ?? Math.random;
  }

  /**
   * `sabre:atk:{ownerTenantId}:{pcc}:{fingerprint}` (RF-01 CA-2).
   *
   * La clave tiene que distinguir **todo lo que produce un ATK distinto**, no lo que es cómodo de
   * leer. El token lo determina el `secret`, y el `secret` se deriva de (EPR, PCC, Domain,
   * password); el host lo completa, porque un ATK de CERT no vale en PROD. Una clave de sólo
   * (tenant, PCC) deja fuera EPR, Domain, password y host: dos oficinas del mismo consolidador con
   * EPR distinto —el caso normal en una red de agencias— colisionaban en Redis y la segunda operaba
   * con el token de la primera. Fallo silencioso: el token es válido, sólo que de otra oficina.
   *
   * `ownerTenantId` y `pcc` van en claro porque no son secretos (el PCC se imprime en el billete) y
   * hacen la clave operable: se puede buscar el token de una agencia sin descifrar nada. El resto va
   * dentro de la huella, nunca en claro — ver `credentialFingerprint`.
   */
  get cacheKey(): string {
    const tenant = this.deps.cacheNamespace ?? 'default';
    const pcc = this.cfg.homePcc ?? 'unknown';
    const fingerprint = credentialFingerprint([
      this.cfg.host,
      this.cfg.epr ?? '',
      pcc,
      sabreDomain(this.cfg),
      this.cfg.password ?? '',
    ]);
    return `sabre:atk:${tenant}:${pcc}:${fingerprint}`;
  }

  async getToken(): Promise<string> {
    const memo = this.memo;
    if (memo && this.now() < memo.expiresAt) return memo.value;

    // Coalescing: N búsquedas en paralelo tras un deploy no deben disparar N autenticaciones.
    if (this.inflight) return this.inflight;
    this.inflight = this.resolveToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async invalidate(): Promise<void> {
    this.memo = null;
    if (this.deps.cache) await this.deps.cache.delete(this.cacheKey);
  }

  private async resolveToken(): Promise<string> {
    const fromCache = await this.readCache();
    if (fromCache) {
      this.memo = fromCache;
      return fromCache.value;
    }

    const { token, ttlSeconds } = await this.fetchToken();
    const cached: CachedToken = { value: token, expiresAt: this.now() + ttlSeconds * 1000 };
    this.memo = cached;
    if (this.deps.cache) await this.deps.cache.set(this.cacheKey, cached, ttlSeconds);
    return token;
  }

  /** La caché es un borde más: lo que vuelve de Redis se valida antes de usarse. */
  private async readCache(): Promise<CachedToken | null> {
    if (!this.deps.cache) return null;
    const raw = await this.deps.cache.get<unknown>(this.cacheKey);
    if (raw === null || raw === undefined) return null;
    const parsed = CachedTokenSchema.safeParse(raw);
    if (!parsed.success) {
      this.log('warn', 'sabre.token.cache_corrupta', { cacheKey: this.cacheKey });
      return null;
    }
    return this.now() < parsed.data.expiresAt ? parsed.data : null;
  }

  private async fetchToken(): Promise<{ token: string; ttlSeconds: number }> {
    const { epr, password, homePcc } = this.cfg;
    if (!epr || !password || !homePcc) {
      throw new SabreConfigError(
        `no se puede autenticar contra Sabre: faltan ${missingSabreCredentials(this.cfg).join(', ')}`,
      );
    }

    const secret = deriveSabreSecret({ epr, homePcc, password, domain: sabreDomain(this.cfg) });
    const url = sabreUrl(this.cfg, SABRE_AUTH_PATH);

    let lastError: SabreApiError | null = null;
    for (let attempt = 1; attempt <= SABRE_MAX_ATTEMPTS; attempt++) {
      const result = await this.attemptFetch(url, secret);
      if ('ok' in result) return result.ok;

      lastError = result.error;
      const retryable = result.error.failure.retry !== 'NO_RETRY';
      if (!retryable || attempt === SABRE_MAX_ATTEMPTS) break;
      await this.sleep(sabreBackoffDelayMs(attempt, this.jitter));
    }

    throw lastError ?? new SabreApiError(0, 'autenticación fallida', SABRE_AUTH_PATH);
  }

  private async attemptFetch(
    url: string,
    secret: string,
  ): Promise<{ ok: { token: string; ttlSeconds: number } } | { error: SabreApiError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sabreRequestTimeoutMs(this.cfg));
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // El header sale de aquí y no se guarda en ninguna variable que alguien pueda loguear.
          Authorization: `Basic ${secret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      return {
        error: new SabreApiError(0, isAbort ? 'timeout' : (err as Error).message, SABRE_AUTH_PATH),
      };
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      // La variante OAuth2 RFC 6749 del token: `{error, error_description}` (docs/sabre/09 §2.1).
      //
      // `error` y `error_description` son campos del proveedor y en `/v2/auth/token` Sabre HACE ECO
      // DE LA REQUEST dentro de ellos: llegan con el `clientId` `V1:{EPR}:{PCC}:{Domain}` y con el
      // `secret`, que es base64 reversible del password de la oficina (docs/sabre/01 §5.3).
      //
      // Aquí se pasan CRUDOS a propósito, y no es un descuido: `classifySabreFailure` compara
      // literales de la tabla 2SG («Wrong clientID or clientSecret» ⇒ marcar la cuenta BYOC) y
      // sobre texto redactado no acertaría. Quien redacta es el constructor de `SabreApiError`,
      // que guarda `code` y `body` ya limpios — el sitio de llamada no tiene que acordarse.
      const oauth = parseOAuthError(text);
      const failure = classifySabreFailure({
        status: res.status,
        code: oauth.error,
        text: oauth.description ?? text,
      });
      const error = new SabreApiError(res.status, text, SABRE_AUTH_PATH, {
        failure,
        ...(oauth.error === undefined ? {} : { code: oauth.error }),
      });
      this.log('warn', 'sabre.token.error', error.toLogMeta());
      return { error };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return {
        error: new SabreApiError(res.status, 'respuesta de token no es JSON', SABRE_AUTH_PATH),
      };
    }

    const parsed = TokenResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        error: new SabreApiError(
          res.status,
          'respuesta de token sin access_token utilizable',
          SABRE_AUTH_PATH,
        ),
      };
    }

    const expiresIn = parsed.data.expires_in;
    if (expiresIn === undefined) {
      // Nunca en silencio: si Sabre deja de mandar `expires_in` queremos verlo en el log, no
      // descubrirlo por una tormenta de 401 (RF-01 CA-3).
      this.log('warn', 'sabre.token.sin_expires_in', {
        ttlSeconds: sabreTokenTtlSeconds(this.cfg),
      });
      return {
        ok: { token: parsed.data.access_token, ttlSeconds: sabreTokenTtlSeconds(this.cfg) },
      };
    }

    const ttlSeconds = Math.max(60, Math.floor(expiresIn * SABRE_TOKEN_TTL_MARGIN));
    this.log('debug', 'sabre.token.obtenido', { ttlSeconds });
    return { ok: { token: parsed.data.access_token, ttlSeconds } };
  }

  /**
   * Load-bearing y medido: `sabre.token.cache_corrupta` publica `cacheKey`, que lleva el PCC de la
   * oficina dentro (`sabre:atk:{tenant}:{pcc}:{huella}`). Sin la pasada de `logRedacted` sale en
   * claro. Aquí no hay política, sólo el reenvío: la política vive en `redaction.ts` y hay una
   * guarda por alcanzabilidad de tipo que impide volver a escribirla aquí.
   */
  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

function parseOAuthError(text: string): { error?: string; description?: string } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = typeof parsed['error'] === 'string' ? parsed['error'] : undefined;
    const description =
      typeof parsed['error_description'] === 'string'
        ? parsed['error_description']
        : typeof parsed['message'] === 'string'
          ? parsed['message']
          : undefined;
    return { ...(error ? { error } : {}), ...(description ? { description } : {}) };
  } catch {
    return {};
  }
}
