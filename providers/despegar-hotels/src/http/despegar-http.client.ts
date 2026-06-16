import type { DespegarHotelsConfig } from '../config';

export class DespegarApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`Despegar API ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'DespegarApiError';
  }
}

type QueryValue = string | number | boolean | undefined | null;

function buildQuery(params: Record<string, QueryValue>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** Cliente HTTP de Despegar. Auth por header `x-apikey`. NUNCA loguea la api key. */
export class DespegarHttpClient {
  constructor(private readonly cfg: DespegarHotelsConfig) {}

  private get debug(): boolean {
    return process.env['DESPEGAR_DEBUG_HTTP'] === 'true';
  }

  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}${buildQuery(query)}`;
    if (this.debug) console.warn(`[despegar] GET ${path}${buildQuery(query)}`);
    const res = await this.fetchOrThrow(
      url,
      { method: 'GET', headers: { 'x-apikey': this.cfg.apiKey, accept: 'application/json' } },
      path,
    );
    return this.parse<T>(res, path);
  }

  async post<T>(path: string, body: unknown, query: Record<string, QueryValue> = {}): Promise<T> {
    return this.send<T>('POST', path, body, query);
  }

  async patch<T>(path: string, body: unknown, query: Record<string, QueryValue> = {}): Promise<T> {
    return this.send<T>('PATCH', path, body, query);
  }

  private async send<T>(
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
    query: Record<string, QueryValue>,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}${buildQuery(query)}`;
    if (this.debug) console.warn(`[despegar] ${method} ${path}`);
    const res = await this.fetchOrThrow(
      url,
      {
        method,
        headers: {
          'x-apikey': this.cfg.apiKey,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      path,
    );
    return this.parse<T>(res, path);
  }

  /** fetch con timeout (15s) que envuelve red/abort como DespegarApiError(status 0). */
  private async fetchOrThrow(url: string, init: RequestInit, path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const msg = (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message;
      throw new DespegarApiError(0, msg, path);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new DespegarApiError(res.status, text, path);
    if (!text.trim()) return {} as T; // 2xx vacío: los mappers lo toleran (devuelven [] / vacío).
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DespegarApiError(res.status, `respuesta no-JSON: ${text.slice(0, 200)}`, path);
    }
  }
}
