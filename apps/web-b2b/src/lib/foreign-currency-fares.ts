import { isTenantId } from './provider-enablement';
import type { TenantAdminProxyPlan, TenantAdminProxyTarget } from './tenant-admin-proxy';

/**
 * Tarifas de vuelo en otra moneda que la de la agencia (migración 0087), el interruptor de pruebas
 * del superadmin. Encendido, la búsqueda deja de descartar las tarifas que el proveedor devuelve en
 * otra moneda —LATAM NDC en BRL a una agencia en COP— y se pueden revalidar y reservar en ella.
 */
export interface ForeignCurrencyFares {
  readonly tenantId: string;
  readonly enabled: boolean;
  /** La moneda de venta de la agencia. */
  readonly currency: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseForeignCurrencyFares(raw: unknown): ForeignCurrencyFares | undefined {
  const r = asRecord(raw);
  if (r === undefined) return undefined;
  const { tenantId, enabled, currency } = r;
  if (typeof tenantId !== 'string' || typeof enabled !== 'boolean') return undefined;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { tenantId, enabled, currency };
}

function pathOf(tenantId: string): string {
  return `/admin/tenants/${tenantId.toLowerCase()}/foreign-currency-fares`;
}

/** `GET` del API: sólo con un id de nodo válido. */
export function foreignCurrencyFaresTarget(tenantId: string): TenantAdminProxyTarget {
  return isTenantId(tenantId)
    ? { ok: true, path: pathOf(tenantId) }
    : { ok: false, error: 'Nodo inválido.' };
}

/** `PATCH` del API, con el cuerpo reconstruido: sólo `enabled`, y booleano. */
export function foreignCurrencyFaresPlan(tenantId: string, raw: unknown): TenantAdminProxyPlan {
  if (!isTenantId(tenantId)) return { ok: false, error: 'Nodo inválido.' };
  const enabled = asRecord(raw)?.['enabled'];
  if (typeof enabled !== 'boolean') return { ok: false, error: 'El cambio no se pudo leer.' };
  return { ok: true, path: pathOf(tenantId), body: { enabled } };
}

/** Lo que dice la tarjeta debajo del interruptor, según esté. */
export function foreignCurrencyFaresHint(view: ForeignCurrencyFares): string {
  return view.enabled
    ? `Las tarifas que un proveedor devuelva en otra moneda se muestran y se reservan en esa moneda, sin convertir a ${view.currency}. Del markup sólo se aplican los porcentajes. Apágalo al terminar las pruebas.`
    : `Sólo se muestran tarifas en ${view.currency}, la moneda de la agencia. Las que un proveedor devuelva en otra se descartan y el proveedor aparece con el motivo.`;
}

export function foreignCurrencyFaresSavedMessage(enabled: boolean, tenantName: string): string {
  return enabled
    ? `${tenantName} ya ve tarifas en otra moneda.`
    : `${tenantName} vuelve a ver sólo tarifas en su moneda.`;
}

const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';

export type FaresResult =
  | { readonly ok: true; readonly data: ForeignCurrencyFares }
  | { readonly ok: false; readonly message: string };

async function call(url: string, init: RequestInit): Promise<FaresResult> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 401)
      return { ok: false, message: 'Tu sesión venció. Vuelve a iniciar sesión.' };
    if (res.status === 403) return { ok: false, message: 'Sólo el superadmin cambia este ajuste.' };
    const error = asRecord(body)?.['error'];
    return {
      ok: false,
      message:
        typeof error === 'string' && error.trim() !== ''
          ? error
          : 'No se pudo completar la operación. Inténtalo de nuevo.',
    };
  }
  const data = parseForeignCurrencyFares(body);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

function routeOf(tenantId: string): string {
  return `/api/admin/tenants/${encodeURIComponent(tenantId)}/foreign-currency-fares`;
}

export function loadForeignCurrencyFares(tenantId: string): Promise<FaresResult> {
  return call(routeOf(tenantId), { method: 'GET' });
}

export function saveForeignCurrencyFares(tenantId: string, enabled: boolean): Promise<FaresResult> {
  return call(routeOf(tenantId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}
