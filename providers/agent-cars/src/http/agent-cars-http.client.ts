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

export class AgentCarsHttpClient {
  constructor(private readonly cfg: AgentCarsConfig) {}

  async get<T>(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const url = this.buildUrl(baseUrl, path, { 'access-token': this.cfg.accessToken, ...query });
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return this.parse<T>(res, path);
  }

  async postForm<T>(
    baseUrl: string,
    path: string,
    body: Record<string, QueryValue>,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    const url = this.buildUrl(baseUrl, path, { 'access-token': this.cfg.accessToken, ...query });
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) {
      if (v !== null && v !== undefined) form.append(k, String(v));
    }
    const res = await fetch(url, {
      method: 'POST',
      body: form,
    });
    return this.parse<T>(res, path);
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
    return (text ? JSON.parse(text) : {}) as T;
  }
}
