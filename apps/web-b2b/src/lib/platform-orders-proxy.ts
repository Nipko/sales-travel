import {
  ORDERS_SEARCH_MAX_LENGTH,
  ORDERS_SEARCH_MIN_LENGTH,
  ORDER_VERTICALS,
  isCalendarDay,
  isOrderStatus,
  isProviderCode,
} from './platform-orders';
import type { TenantAdminProxyPlan, TenantAdminProxyTarget } from './tenant-admin-proxy';
import type { WalletProxyPlan } from './wallet-proxy';
import { isUuid } from './wallets';

/**
 * A qué ruta del API va cada pedido de Plataforma → Reservas de la red (`/api/admin/orders` →
 * `/admin/orders`, `/api/admin/orders/export` → `/admin/orders/export`, `/api/admin/orders/:id` →
 * `/admin/orders/:id`). Sin I/O.
 *
 * La lista, la exportación y la ficha sólo leen. La query se rearma parámetro por parámetro desde una lista blanca y
 * lo que no se conoce, o viene repetido, es un 400, como en el API (estricto): un parámetro raro no
 * viaja. Las acciones de post-venta de la ficha (reenviar, consultar, reintentar, cancelar) rearman
 * su cuerpo campo por campo: sólo el motivo, y en cancelar también el número de la orden. Quién
 * puede (sólo el superadmin) lo decide el API.
 */

const BAD_FILTER = (error: string): WalletProxyPlan => ({ ok: false, status: 400, error });
const BAD_METHOD: WalletProxyPlan = {
  ok: false,
  status: 405,
  error: 'Operación no admitida en esta ruta.',
};

const FILTERS = [
  'tenantId',
  'subtree',
  'vertical',
  'provider',
  'status',
  'from',
  'to',
  'q',
  'attention',
] as const;
const PAGE = ['cursor', 'limit'] as const;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_LIMIT = 100;

type Rebuilt =
  | { readonly ok: true; readonly query: string }
  | { readonly ok: false; readonly error: string };

/**
 * La query rearmada desde la lista blanca: los filtros, y en la lista también la página. La
 * exportación lleva exactamente los mismos filtros que la lista (así el archivo es lo que se ve), sin
 * `cursor` ni `limit`: con ellos es un 400, como en el API.
 */
function rebuildOrdersQuery(search: URLSearchParams, mode: 'list' | 'export'): Rebuilt {
  const known = new Set<string>(mode === 'list' ? [...FILTERS, ...PAGE] : FILTERS);
  const bad = (error: string): Rebuilt => ({ ok: false, error });
  const seen = new Set<string>();
  for (const key of search.keys()) {
    if (!known.has(key)) return bad(`Filtro desconocido: ${key.slice(0, 40)}.`);
    if (seen.has(key)) return bad(`Filtro repetido: ${key}.`);
    seen.add(key);
  }
  const value = (key: string): string | undefined => {
    const v = search.get(key)?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const out = new URLSearchParams();

  const tenantId = value('tenantId');
  if (tenantId !== undefined) {
    if (!isUuid(tenantId)) return bad('Nodo inválido.');
    out.set('tenantId', tenantId.toLowerCase());
  }

  const subtree = value('subtree');
  if (subtree !== undefined) {
    if (subtree !== 'true' && subtree !== 'false') return bad('Alcance del nodo inválido.');
    // Sin nodo no cambia nada: no se manda.
    if (tenantId !== undefined) out.set('subtree', subtree);
  }

  const vertical = value('vertical');
  if (vertical !== undefined) {
    if (!(ORDER_VERTICALS as readonly string[]).includes(vertical)) {
      return bad('Vertical inválida.');
    }
    out.set('vertical', vertical);
  }

  const provider = value('provider');
  if (provider !== undefined) {
    if (!isProviderCode(provider)) return bad('Proveedor inválido.');
    out.set('provider', provider);
  }

  const status = value('status');
  if (status !== undefined) {
    const statuses = status.split(',').map((s) => s.trim());
    if (statuses.length > 5 || !statuses.every(isOrderStatus)) {
      return bad('Estado inválido.');
    }
    out.set('status', [...new Set(statuses)].join(','));
  }

  const from = value('from');
  const to = value('to');
  if (from !== undefined && !isCalendarDay(from)) return bad('Fecha "desde" inválida.');
  if (to !== undefined && !isCalendarDay(to)) return bad('Fecha "hasta" inválida.');
  if (from !== undefined && to !== undefined && from > to) {
    return bad('La fecha "hasta" no puede ser anterior a "desde".');
  }
  if (from !== undefined) out.set('from', from);
  if (to !== undefined) out.set('to', to);

  const q = value('q');
  if (q !== undefined) {
    if (/\p{Cc}/u.test(q)) return bad('La búsqueda tiene caracteres no válidos.');
    if (q.length > ORDERS_SEARCH_MAX_LENGTH) return bad('La búsqueda es demasiado larga.');
    if (q.length < ORDERS_SEARCH_MIN_LENGTH) return bad('Escribe al menos 2 caracteres.');
    out.set('q', q);
  }

  const attention = value('attention');
  if (attention !== undefined) {
    if (attention !== 'true') return bad('Filtro de atención inválido.');
    out.set('attention', 'true');
  }

  if (mode === 'list') {
    const cursor = value('cursor');
    if (cursor !== undefined) {
      if (!CURSOR.test(cursor)) return bad('Página inválida.');
      out.set('cursor', cursor);
    }

    const limit = value('limit');
    if (limit !== undefined) {
      const n = Number(limit);
      if (!/^\d{1,3}$/.test(limit) || n < 1 || n > MAX_LIMIT) return bad('Límite inválido.');
      out.set('limit', String(n));
    }
  }

  return { ok: true, query: out.toString() };
}

function withQuery(base: string, query: string): string {
  return query === '' ? base : `${base}?${query}`;
}

/** `GET /api/admin/orders?…` → `GET /admin/orders?…`. */
export function adminOrdersPlan(method: string, search: URLSearchParams): WalletProxyPlan {
  if (method !== 'GET') return BAD_METHOD;
  const rebuilt = rebuildOrdersQuery(search, 'list');
  if (!rebuilt.ok) return BAD_FILTER(rebuilt.error);
  return { ok: true, method: 'GET', path: withQuery('/admin/orders', rebuilt.query) };
}

/**
 * `GET /api/admin/orders/export?…` → `GET /admin/orders/export?…`: los filtros de la lista, sin la
 * página.
 */
export function adminOrdersExportTarget(search: URLSearchParams): TenantAdminProxyTarget {
  const rebuilt = rebuildOrdersQuery(search, 'export');
  if (!rebuilt.ok) return { ok: false, error: rebuilt.error };
  return { ok: true, path: withQuery('/admin/orders/export', rebuilt.query) };
}

/** `GET /api/admin/orders/:id` → `GET /admin/orders/:id`. */
export function adminOrderPlan(method: string, orderId: string): WalletProxyPlan {
  if (method !== 'GET') return BAD_METHOD;
  if (!isUuid(orderId)) return { ok: false, status: 404, error: 'Reserva inválida.' };
  return { ok: true, method: 'GET', path: `/admin/orders/${orderId.toLowerCase()}` };
}

// ───────────────────────────── Acciones de post-venta ─────────────────────────────

const BAD_ORDER = 'Reserva inválida.';
const REASON_REQUIRED = 'Escribe el motivo: queda en la auditoría.';
const ORDER_NUMBER_REQUIRED = 'Escribe el número de la orden para confirmar.';

/**
 * Lo más largo que se reenvía. El API acepta hasta 500 caracteres ya recortados; acá sólo se corta lo
 * absurdo, para que el mensaje de un motivo largo lo dé el API.
 */
const REASON_FORWARD_MAX = 2_000;

/** Las acciones sin más cuerpo que el motivo (`POST /admin/orders/:id/<acción>`). */
export type AdminOrderActionPath = 'send-confirmation' | 'retrieve';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function reasonOf(raw: unknown): string | undefined {
  const reason = asRecord(raw)?.['reason'];
  return typeof reason === 'string' && reason.length <= REASON_FORWARD_MAX ? reason : undefined;
}

function orderPath(orderId: string): string | undefined {
  return isUuid(orderId) ? `/admin/orders/${orderId.toLowerCase()}` : undefined;
}

/** `POST /api/admin/orders/:id/(send-confirmation|retrieve)` → el API, con `{ reason }`. */
export function adminOrderActionPlan(
  orderId: string,
  action: AdminOrderActionPath,
  raw: unknown,
): TenantAdminProxyPlan {
  const base = orderPath(orderId);
  if (base === undefined) return { ok: false, error: BAD_ORDER };
  const reason = reasonOf(raw);
  if (reason === undefined) return { ok: false, error: REASON_REQUIRED };
  return { ok: true, path: `${base}/${action}`, body: { reason } };
}

/** `POST /api/admin/orders/:id/operations/:opId/retry` → el API, con `{ reason }`. */
export function adminOrderRetryPlan(
  orderId: string,
  operationId: string,
  raw: unknown,
): TenantAdminProxyPlan {
  const base = orderPath(orderId);
  if (base === undefined) return { ok: false, error: BAD_ORDER };
  if (!isUuid(operationId)) return { ok: false, error: 'Operación inválida.' };
  const reason = reasonOf(raw);
  if (reason === undefined) return { ok: false, error: REASON_REQUIRED };
  return {
    ok: true,
    path: `${base}/operations/${operationId.toLowerCase()}/retry`,
    body: { reason },
  };
}

/**
 * `POST /api/admin/orders/:id/cancel` → el API, con `{ reason, orderNumber }`. El número lo escribió
 * el superadmin para confirmar; si es el de la reserva lo decide el API.
 */
export function adminOrderCancelPlan(orderId: string, raw: unknown): TenantAdminProxyPlan {
  const base = orderPath(orderId);
  if (base === undefined) return { ok: false, error: BAD_ORDER };
  const reason = reasonOf(raw);
  if (reason === undefined) return { ok: false, error: REASON_REQUIRED };
  const orderNumber = asRecord(raw)?.['orderNumber'];
  if (typeof orderNumber !== 'number' || !Number.isSafeInteger(orderNumber) || orderNumber < 1) {
    return { ok: false, error: ORDER_NUMBER_REQUIRED };
  }
  return { ok: true, path: `${base}/cancel`, body: { reason, orderNumber } };
}

/** `GET /api/admin/orders/:id/cancellation-estimate` → el API. Sólo lee. */
export function adminOrderEstimateTarget(orderId: string): TenantAdminProxyTarget {
  const base = orderPath(orderId);
  if (base === undefined) return { ok: false, error: BAD_ORDER };
  return { ok: true, path: `${base}/cancellation-estimate` };
}
