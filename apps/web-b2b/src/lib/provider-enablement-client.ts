import {
  parsePlatformProvider,
  parsePlatformProviders,
  parseTenantProviders,
  requestErrorMessage,
  type EnablementRequest,
  type PlatformProvider,
  type TenantOption,
  type TenantProviders,
} from './provider-enablement';
import { readJson } from './read-json';

/**
 * Las llamadas del navegador al proxy de habilitación de proveedores (`/api/admin/providers`).
 * Cada una devuelve datos ya validados o un mensaje para la pantalla; nunca lanza.
 */

export type Loaded<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string };

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recargá la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const e = (body as Record<string, unknown>)['error'];
  return typeof e === 'string' ? e : undefined;
}

async function call<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
): Promise<Loaded<T>> {
  const kind = init.method === undefined ? 'read' : 'write';
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!read.ok) return { ok: false, message: read.message };
  if (!res.ok) {
    return { ok: false, message: requestErrorMessage(res.status, errorOf(read.data), kind) };
  }
  const data = parse(read.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

export function loadPlatformProviders(): Promise<Loaded<PlatformProvider[]>> {
  return call('/api/admin/providers', {}, parsePlatformProviders);
}

export function loadTenantProviders(tenantId: string): Promise<Loaded<TenantProviders>> {
  return call(
    `/api/admin/providers/tenants/${encodeURIComponent(tenantId)}`,
    {},
    parseTenantProviders,
  );
}

function parseTenantOptions(value: unknown): TenantOption[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const list = (value as Record<string, unknown>)['tenants'];
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((t): TenantOption[] => {
    if (typeof t !== 'object' || t === null) return [];
    const { id, name, slug } = t as Record<string, unknown>;
    return typeof id === 'string' && typeof name === 'string' && typeof slug === 'string'
      ? [{ id: id.toLowerCase(), name, slug }]
      : [];
  });
}

/** Todos los tenants de la plataforma, para buscar a quién agregar una excepción. */
export function loadTenantOptions(): Promise<Loaded<TenantOption[]>> {
  return call('/api/admin/tenants', {}, parseTenantOptions);
}

function writeInit(request: EnablementRequest): RequestInit {
  return request.method === 'DELETE'
    ? { method: 'DELETE' }
    : {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      };
}

/** Fija o quita el ajuste global. Devuelve el proveedor como quedó. */
export function saveGlobal(
  code: string,
  request: EnablementRequest,
): Promise<Loaded<PlatformProvider>> {
  return call(
    `/api/admin/providers/${encodeURIComponent(code)}/global`,
    writeInit(request),
    parsePlatformProvider,
  );
}

/** Fija o quita la excepción de un tenant. Devuelve el proveedor como quedó. */
export function saveTenant(
  code: string,
  tenantId: string,
  request: EnablementRequest,
): Promise<Loaded<PlatformProvider>> {
  return call(
    `/api/admin/providers/${encodeURIComponent(code)}/tenants/${encodeURIComponent(tenantId)}`,
    writeInit(request),
    parsePlatformProvider,
  );
}
