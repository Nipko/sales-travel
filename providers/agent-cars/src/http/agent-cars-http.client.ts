import type { AgentCarsConfig } from '../config.js';

type QueryValue = string | number | boolean | null | undefined;

export class AgentCarsApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`AgentCars API ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'AgentCarsApiError';
  }
}

/**
 * Techo de espera por request. Sin esto, un proveedor que acepta la conexión y no
 * responde deja el request de nuestra API colgado indefinidamente: se agotan los
 * workers de Node y cae toda la búsqueda, no sólo la de autos.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export class AgentCarsHttpClient {
  constructor(private readonly cfg: AgentCarsConfig) {}

  async get<T>(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const url = this.buildUrl(baseUrl, path, query);
    const res = await this.fetchOrThrow(
      url,
      { method: 'GET', headers: this.headers({ Accept: 'application/json' }) },
      path,
    );
    return this.parse<T>(res, path);
  }

  async postForm<T>(
    baseUrl: string,
    path: string,
    body: Record<string, QueryValue>,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    const url = this.buildUrl(baseUrl, path, query);
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) {
      if (v !== null && v !== undefined) form.append(k, String(v));
    }
    const res = await this.fetchOrThrow(
      url,
      { method: 'POST', body: form, headers: this.headers() },
      path,
    );
    return this.parse<T>(res, path);
  }

  /**
   * El token viaja en CABECERA, no en el query string.
   *
   * Antes iba como `?access-token=…`, así que la credencial del tenant quedaba escrita
   * en los access logs de cualquier proxy intermedio, en el historial del navegador si
   * la URL se compartía, y en el Referer de recursos externos. AgentCars acepta ambas
   * formas; la cabecera no se registra.
   */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'access-token': this.cfg.accessToken, ...extra };
  }

  /** Envuelve un fallo de red (DNS/timeout/conexión) como AgentCarsApiError(status 0). */
  private async fetchOrThrow(url: string, init: RequestInit, path: string): Promise<Response> {
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = err as Error;
      const reason =
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? `el proveedor no respondió en ${timeoutMs} ms`
          : e.message;
      throw new AgentCarsApiError(0, reason, path);
    }
  }

  private buildUrl(base: string, path: string, query: Record<string, QueryValue>): string {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new AgentCarsApiError(res.status, text, path);
    if (!text.trim()) return {} as T; // 2xx vacío: los mappers lo toleran (devuelven [] / vacío).
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentCarsApiError(res.status, `respuesta no-JSON: ${text.slice(0, 200)}`, path);
    }
  }
}
