import type { AgentCarsConfig } from '../config.js';
import { isErrorBody } from '../internal/error-body.js';

type QueryValue = string | number | boolean | null | undefined;

export class AgentCarsApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
    /**
     * La URL a la que se llamó, sin query string (ahí va el token). Es lo que dice si la cuenta
     * apunta a otro host o a una ruta que AgentCars no tiene.
     */
    readonly endpoint?: string,
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

interface RequestOptions {
  /** `false` para servicios públicos que no llevan token (el suggest). */
  auth?: boolean;
}

export class AgentCarsHttpClient {
  constructor(private readonly cfg: AgentCarsConfig) {}

  async get<T>(
    baseUrl: string,
    path: string,
    query: Record<string, QueryValue> = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(baseUrl, path, this.withToken(query, opts));
    const res = await this.fetchOrThrow(
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      path,
    );
    return this.parse<T>(res, path, url);
  }

  async postForm<T>(
    baseUrl: string,
    path: string,
    body: Record<string, QueryValue>,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    const url = this.buildUrl(baseUrl, path, this.withToken(query, {}));
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) {
      if (v !== null && v !== undefined) form.append(k, String(v));
    }
    const res = await this.fetchOrThrow(
      url,
      { method: 'POST', body: form, headers: { Accept: 'application/json' } },
      path,
    );
    return this.parse<T>(res, path, url);
  }

  /**
   * El token va en el query string (`access-token`): es la única forma que documenta la guía de
   * AgentCars (v2.0, "Authentication IP + token": cada token vale sólo desde la IP registrada).
   *
   * El 2026-08-09 (66b3437) se lo pasó a una cabecera `access-token`, suponiendo que el API la
   * aceptaba. Nunca se verificó —la URL base mala lo tapaba con un 404— y la guía no la menciona;
   * en junio, con el token en la URL, la integración sí había funcionado. Lo que no puede pasar es
   * que la URL con el token quede en un log nuestro: los errores y el log llevan `endpoint`, sin
   * query, y el suggest, que es público, no lo recibe.
   */
  private withToken(
    query: Record<string, QueryValue>,
    opts: RequestOptions,
  ): Record<string, QueryValue> {
    return opts.auth === false ? query : { ...query, 'access-token': this.cfg.accessToken };
  }

  /**
   * Envuelve un fallo de red (DNS/timeout/conexión) como AgentCarsApiError(status 0). Node sólo dice
   * "fetch failed"; el motivo real (ENOTFOUND con el host, ECONNREFUSED…) viene en `cause`, y sin él
   * una URL base mal escrita parecía una caída del proveedor.
   */
  private async fetchOrThrow(url: string, init: RequestInit, path: string): Promise<Response> {
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = err as Error & { cause?: { code?: unknown; hostname?: unknown } };
      const code = typeof e.cause?.code === 'string' ? e.cause.code : undefined;
      const host = typeof e.cause?.hostname === 'string' ? ` ${e.cause.hostname}` : '';
      const reason =
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? `el proveedor no respondió en ${timeoutMs} ms`
          : `${e.message}${code ? ` (${code}${host})` : ''}`;
      throw new AgentCarsApiError(0, reason, path, endpointOf(url));
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

  private async parse<T>(res: Response, path: string, url: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new AgentCarsApiError(res.status, text, path, endpointOf(url));
    if (!text.trim()) return {} as T; // 2xx vacío: los mappers lo toleran (devuelven [] / vacío).
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentCarsApiError(
        res.status,
        `respuesta no-JSON: ${text.slice(0, 200)}`,
        path,
        endpointOf(url),
      );
    }
    // Un 2xx también puede ser un error (ver error-body.ts): leído como datos, inventaba resultados.
    if (isErrorBody(parsed)) throw new AgentCarsApiError(res.status, text, path, endpointOf(url));
    return parsed as T;
  }
}

function endpointOf(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}
