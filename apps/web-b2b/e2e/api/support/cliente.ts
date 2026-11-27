import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { request, type APIRequestContext } from '@playwright/test';
import { E2E } from '../../support/env';
import { freshTotp } from '../../support/totp';
import { API_PASSWORD, PERSONAS, type Persona, type PersonaKey } from './personas';

/**
 * Cliente del arnés HTTP (INF-1). Pega a la API real (guardas, Zod, throttler y base de verdad), sin
 * navegador y sin el panel de por medio.
 *
 * - `como('vendedorA')` devuelve un cliente con la sesión de esa persona. Si su rol exige MFA y todavía
 *   no lo tiene (base recién sembrada), lo activa por API y guarda la clave en e2e/.auth/api-<key>.json;
 *   si ya lo tiene, pasa el desafío con esa clave. El token queda en el mismo archivo y se reusa mientras
 *   `GET /auth/session` lo acepte: la suite completa hace un login por persona.
 * - `anonimo()` no manda token.
 *
 * Con `E2E_INTERNAL_PROXY_SECRET` (el `INTERNAL_PROXY_SECRET` del stack) cada persona viaja con su
 * propia IP de documentación, como si llegara por el panel: sin él, todas comparten la IP del runner y el
 * límite de 10 logins por minuto.
 */

const PROXY_SECRET = process.env['E2E_INTERNAL_PROXY_SECRET'];
const ANON_IP = '198.51.100.99';

export interface Respuesta<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
  text: string;
}

interface Guardado {
  secret?: string;
  lastStep?: number;
  token?: string;
  expiresAt?: string;
}

function archivo(key: string): string {
  return path.join(E2E.authDir, `api-${key}.json`);
}

function leer(key: string): Guardado {
  const f = archivo(key);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Guardado) : {};
}

function guardar(key: string, g: Guardado): void {
  mkdirSync(E2E.authDir, { recursive: true });
  writeFileSync(archivo(key), JSON.stringify(g, null, 2));
}

function origen(ip: string): Record<string, string> {
  return PROXY_SECRET
    ? {
        'x-internal-proxy': PROXY_SECRET,
        'x-client-ip': ip,
        'x-client-user-agent': 'qa-arnes-http',
      }
    : {};
}

export class Api {
  constructor(
    private readonly ctx: APIRequestContext,
    private readonly headers: Record<string, string>,
    readonly persona?: { key: string; userId?: string; tenantId?: string },
  ) {}

  async pedir<T = unknown>(
    method: string,
    ruta: string,
    opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {},
  ): Promise<Respuesta<T>> {
    const url = ruta.startsWith('http')
      ? ruta
      : `${E2E.apiUrl}${ruta.startsWith('/api') ? '' : '/api'}${ruta}`;
    const res = await this.ctx.fetch(url, {
      method,
      headers: {
        ...this.headers,
        ...(opts.body !== undefined || opts.raw !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
        ...opts.headers,
      },
      ...(opts.raw !== undefined
        ? { data: opts.raw }
        : opts.body !== undefined
          ? { data: opts.body as object }
          : {}),
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // No es JSON (PDF, CSV, HTML): queda el texto.
    }
    return { status: res.status(), body: body as T, headers: res.headers(), text };
  }

  get<T = unknown>(ruta: string, headers?: Record<string, string>) {
    return this.pedir<T>('GET', ruta, headers ? { headers } : {});
  }
  post<T = unknown>(ruta: string, body?: unknown, headers?: Record<string, string>) {
    return this.pedir<T>('POST', ruta, { body: body ?? {}, ...(headers ? { headers } : {}) });
  }
  patch<T = unknown>(ruta: string, body?: unknown, headers?: Record<string, string>) {
    return this.pedir<T>('PATCH', ruta, { body: body ?? {}, ...(headers ? { headers } : {}) });
  }
  put<T = unknown>(ruta: string, body?: unknown, headers?: Record<string, string>) {
    return this.pedir<T>('PUT', ruta, { body: body ?? {}, ...(headers ? { headers } : {}) });
  }
  delete<T = unknown>(ruta: string, headers?: Record<string, string>) {
    return this.pedir<T>('DELETE', ruta, headers ? { headers } : {});
  }

  /** El token de la sesión: el mismo que el panel guarda en la cookie `st_session`. */
  get token(): string | undefined {
    return this.headers['authorization']?.replace(/^Bearer /, '');
  }

  /** Reconfirma el MFA de esta sesión (para rutas `@RequireRecentMfa`). */
  async stepUp(): Promise<void> {
    const key = this.persona?.key;
    if (!key) throw new Error('stepUp sin persona');
    const g = leer(key);
    if (!g.secret) throw new Error(`${key} no tiene MFA activo`);
    const { code, step } = await freshTotp(g.secret, g.lastStep);
    const r = await this.post('/auth/step-up', { code });
    guardar(key, { ...g, lastStep: step });
    if (r.status !== 200) throw new Error(`step-up de ${key}: ${r.status} ${r.text}`);
  }
}

let ctxPromise: Promise<APIRequestContext> | undefined;
function ctx(): Promise<APIRequestContext> {
  ctxPromise ??= request.newContext();
  return ctxPromise;
}

export async function anonimo(): Promise<Api> {
  return new Api(await ctx(), origen(ANON_IP));
}

/** Sin sesión pero desde una IP propia: para los casos de login que gastan su cupo de intentos. */
export async function anonimoDesde(ip: string): Promise<Api> {
  return new Api(await ctx(), origen(ip));
}

const sesiones = new Map<PersonaKey, Promise<Api>>();

/**
 * Un test que abre su propia sesión de la persona reemplaza la guardada (una sesión por usuario):
 * después de eso, la siguiente llamada a `como(key)` tiene que volver a ingresar.
 */
export function olvidar(key: PersonaKey): void {
  sesiones.delete(key);
  const { token, ...resto } = leer(key);
  if (token !== undefined) guardar(key, resto);
}

/** Cliente con la sesión de `key`. Una sola sesión por persona en toda la corrida. */
export function como(key: PersonaKey): Promise<Api> {
  let s = sesiones.get(key);
  if (!s) {
    s = iniciar(key, PERSONAS[key]);
    sesiones.set(key, s);
    s.catch(() => sesiones.delete(key));
  }
  return s;
}

async function iniciar(key: PersonaKey, p: Persona): Promise<Api> {
  const c = await ctx();
  const base = origen(p.ip);
  const g = leer(key);

  if (g.token) {
    const api = new Api(c, { ...base, authorization: `Bearer ${g.token}` }, { key });
    const s = await api.get<{ mfaVerified?: boolean }>('/auth/session', {
      'x-session-ping': 'passive',
    });
    if (s.status === 200 && (!p.mfa || s.body.mfaVerified)) return conIdentidad(api, key);
  }

  const anon = new Api(c, base);
  let login = await anon.post<Record<string, unknown>>('/auth/login', {
    email: p.email,
    password: API_PASSWORD,
  });
  if (login.status === 429) {
    await new Promise((r) => setTimeout(r, 61_000));
    login = await anon.post<Record<string, unknown>>('/auth/login', {
      email: p.email,
      password: API_PASSWORD,
    });
  }
  if (login.status !== 200) throw new Error(`login de ${p.email}: ${login.status} ${login.text}`);

  let token: string;
  if (login.body['mfaRequired'] === true) {
    if (!g.secret)
      throw new Error(
        `${p.email} ya tiene MFA pero el arnés no guarda su clave: vuelve a sembrar la base.`,
      );
    const { code, step } = await freshTotp(g.secret, g.lastStep);
    const v = await anon.post<{ token: string }>('/auth/mfa/verify', {
      mfaToken: login.body['mfaToken'],
      code,
    });
    if (v.status !== 200) throw new Error(`MFA de ${p.email}: ${v.status} ${v.text}`);
    token = v.body.token;
    g.lastStep = step;
  } else {
    token = String(login.body['token']);
  }

  const api = new Api(c, { ...base, authorization: `Bearer ${token}` }, { key });
  if (p.mfa && login.body['mfaEnrollmentRequired'] === true) {
    const e = await api.post<{ secret: string }>('/auth/mfa/enroll', {});
    if (e.status !== 200) throw new Error(`enroll de ${p.email}: ${e.status} ${e.text}`);
    const { code, step } = await freshTotp(e.body.secret, undefined);
    const conf = await api.post('/auth/mfa/confirm', { code, currentPassword: API_PASSWORD });
    if (conf.status !== 200) throw new Error(`confirm de ${p.email}: ${conf.status} ${conf.text}`);
    g.secret = e.body.secret;
    g.lastStep = step;
  }
  guardar(key, { ...g, token });
  return conIdentidad(api, key);
}

async function conIdentidad(api: Api, key: PersonaKey): Promise<Api> {
  const me = await api.get<{
    id?: string;
    userId?: string;
    activeTenantId?: string;
    tenantId?: string;
  }>('/me');
  const userId = me.body?.id ?? me.body?.userId;
  const tenantId = me.body?.activeTenantId ?? me.body?.tenantId;
  Object.assign(api.persona ?? {}, { userId, tenantId });
  return api;
}

/** Ids de nodos de la red de prueba, por slug (para armar rutas). */
export async function nodo(slug: string): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: E2E.pgUrl });
  await c.connect();
  try {
    const r = await c.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug]);
    const id = r.rows[0]?.id;
    if (!id) throw new Error(`no existe el nodo ${slug}`);
    return id;
  } finally {
    await c.end();
  }
}

/** Consulta de sólo lectura contra la base del stack (con el usuario admin del E2E, sin RLS). */
export async function sql<T extends Record<string, unknown>>(
  q: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: E2E.pgUrl });
  await c.connect();
  try {
    return (await c.query<T>(q, params)).rows;
  } finally {
    await c.end();
  }
}
