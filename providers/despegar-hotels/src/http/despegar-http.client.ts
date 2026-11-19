import { randomUUID } from 'node:crypto';
import type { DespegarHotelsConfig } from '../config';

/**
 * Un rechazo o una caída de Despegar. El cuerpo queda en `body` para quien lo traduce
 * (`code`/`message` del proveedor) pero NO en `message`: el Book y `/reservations` devuelven
 * nombres, email y documentos, y `message` termina en cualquier log.
 */
export class DespegarApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`Despegar API ${status} on ${path}${providerCodeSuffix(body)}`);
    this.name = 'DespegarApiError';
  }

  /** El `code` del error de Despegar (`PRODUCT_GONE`, `INVALID_PREBOOK_ID`…), si vino. */
  get providerCode(): string | undefined {
    return providerCodeOf(this.body);
  }
}

function providerCodeOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      const code = o['code'] ?? o['error_code'];
      if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code)) return code;
    }
  } catch {
    // no es JSON: sin código
  }
  return undefined;
}

function providerCodeSuffix(body: string): string {
  const code = providerCodeOf(body);
  return code ? ` (${code})` : '';
}

type QueryValue = string | number | boolean | undefined | null;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

function buildQuery(params: Record<string, QueryValue>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * Un intercambio completo con Despegar, tal como salió y volvió. Es lo que la certificación de
 * HotelDO pide como "logs" y lo que la bóveda de payloads cifra. Los cuerpos van en texto: son
 * los bytes que Despegar pide ver.
 */
export interface DespegarExchange {
  readonly requestId: string;
  /** Operación lógica (`book`, `prebook`, `cancel`…), no la ruta con ids. */
  readonly operation: string;
  readonly method: Method;
  readonly sentAt: number;
  readonly durationMs: number;
  /** 0 = no llegó respuesta (red o timeout). */
  readonly status: number;
  readonly outcome: 'SUCCESS' | 'REJECTED' | 'PROVIDER_ERROR' | 'TRANSPORT';
  readonly providerCode?: string;
  readonly requestBody?: string;
  readonly responseBody?: string;
}

export interface DespegarHttpDeps {
  /** Nunca debe lanzar; si lo hace, se ignora: la bóveda no cambia el desenlace de la llamada. */
  readonly onExchange?: (exchange: DespegarExchange) => void;
  /** Para tests. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface DespegarCallOptions {
  readonly query?: Record<string, QueryValue>;
  /** Operación lógica para la bóveda. Por defecto, la ruta sin ids. */
  readonly operation?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Cliente HTTP de Despegar. Auth por header `x-apikey`. NUNCA loguea la api key. */
export class DespegarHttpClient {
  constructor(
    private readonly cfg: DespegarHotelsConfig,
    private readonly deps: DespegarHttpDeps = {},
  ) {}

  async get<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    operation?: string,
  ): Promise<T> {
    return this.send<T>('GET', path, undefined, { query, operation });
  }

  async post<T>(
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
    operation?: string,
  ): Promise<T> {
    return this.send<T>('POST', path, body, { query, operation });
  }

  async patch<T>(
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
    operation?: string,
  ): Promise<T> {
    return this.send<T>('PATCH', path, body, { query, operation });
  }

  async put<T>(
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
    operation?: string,
  ): Promise<T> {
    return this.send<T>('PUT', path, body, { query, operation });
  }

  private async send<T>(
    method: Method,
    path: string,
    body: unknown,
    options: DespegarCallOptions,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}${buildQuery(options.query ?? {})}`;
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      'x-apikey': this.cfg.apiKey,
      accept: 'application/json',
    };
    if (requestBody !== undefined) headers['content-type'] = 'application/json';

    const requestId = randomUUID();
    const operation = options.operation ?? operationOf(path);
    const sentAt = Date.now();
    const report = (
      status: number,
      outcome: DespegarExchange['outcome'],
      responseBody: string | undefined,
    ): void => {
      const onExchange = this.deps.onExchange;
      if (onExchange === undefined) return;
      const providerCode = responseBody === undefined ? undefined : providerCodeOf(responseBody);
      try {
        onExchange({
          requestId,
          operation,
          method,
          sentAt,
          durationMs: Date.now() - sentAt,
          status,
          outcome,
          ...(providerCode === undefined ? {} : { providerCode }),
          ...(requestBody === undefined ? {} : { requestBody }),
          ...(responseBody === undefined ? {} : { responseBody }),
        });
      } catch {
        // La bóveda nunca cambia el desenlace de la llamada.
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await (this.deps.fetch ?? fetch)(url, {
        method,
        headers,
        ...(requestBody === undefined ? {} : { body: requestBody }),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const msg = (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message;
      report(0, 'TRANSPORT', undefined);
      throw new DespegarApiError(0, msg, path);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      report(res.status, res.status >= 500 ? 'PROVIDER_ERROR' : 'REJECTED', text);
      throw new DespegarApiError(res.status, text, path);
    }
    report(res.status, 'SUCCESS', text);
    if (!text.trim()) return {} as T; // 2xx vacío (p. ej. 204 del recovery): los mappers lo toleran.
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DespegarApiError(res.status, 'respuesta no-JSON', path);
    }
  }
}

/** `/reservations/123/cancels` → `reservations_cancels`: sin ids (pueden ser datos de reserva) y con el alfabeto de la bóveda. */
function operationOf(path: string): string {
  const name = path
    .split('/')
    .filter((seg) => /^[A-Za-z_-]{1,39}$/.test(seg))
    .join('_')
    .slice(0, 64);
  return name === '' ? 'call' : name;
}
