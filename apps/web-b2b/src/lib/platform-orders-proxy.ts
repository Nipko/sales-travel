import {
  ORDERS_SEARCH_MAX_LENGTH,
  ORDERS_SEARCH_MIN_LENGTH,
  ORDER_VERTICALS,
  isCalendarDay,
  isOrderStatus,
  isProviderCode,
} from './platform-orders';
import type { WalletProxyPlan } from './wallet-proxy';
import { isUuid } from './wallets';

/**
 * A qué ruta del API va cada pedido de Plataforma → Reservas de la red (`/api/admin/orders` →
 * `/admin/orders`, `/api/admin/orders/:id` → `/admin/orders/:id`). Sin I/O.
 *
 * Sólo lectura. La query se rearma parámetro por parámetro desde una lista blanca y lo que no se
 * conoce, o viene repetido, es un 400, como en el API (estricto): un parámetro raro no viaja. Quién
 * puede verla (sólo el superadmin) lo decide el API.
 */

const BAD_FILTER = (error: string): WalletProxyPlan => ({ ok: false, status: 400, error });
const BAD_METHOD: WalletProxyPlan = {
  ok: false,
  status: 405,
  error: 'Operación no admitida en esta ruta.',
};

const KNOWN = new Set([
  'tenantId',
  'subtree',
  'vertical',
  'provider',
  'status',
  'from',
  'to',
  'q',
  'attention',
  'cursor',
  'limit',
]);
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_LIMIT = 100;

/** `GET /api/admin/orders?…` → `GET /admin/orders?…`. */
export function adminOrdersPlan(method: string, search: URLSearchParams): WalletProxyPlan {
  if (method !== 'GET') return BAD_METHOD;
  const seen = new Set<string>();
  for (const key of search.keys()) {
    if (!KNOWN.has(key)) return BAD_FILTER(`Filtro desconocido: ${key.slice(0, 40)}.`);
    if (seen.has(key)) return BAD_FILTER(`Filtro repetido: ${key}.`);
    seen.add(key);
  }
  const value = (key: string): string | undefined => {
    const v = search.get(key)?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const out = new URLSearchParams();

  const tenantId = value('tenantId');
  if (tenantId !== undefined) {
    if (!isUuid(tenantId)) return BAD_FILTER('Nodo inválido.');
    out.set('tenantId', tenantId.toLowerCase());
  }

  const subtree = value('subtree');
  if (subtree !== undefined) {
    if (subtree !== 'true' && subtree !== 'false') return BAD_FILTER('Alcance del nodo inválido.');
    // Sin nodo no cambia nada: no se manda.
    if (tenantId !== undefined) out.set('subtree', subtree);
  }

  const vertical = value('vertical');
  if (vertical !== undefined) {
    if (!(ORDER_VERTICALS as readonly string[]).includes(vertical)) {
      return BAD_FILTER('Vertical inválida.');
    }
    out.set('vertical', vertical);
  }

  const provider = value('provider');
  if (provider !== undefined) {
    if (!isProviderCode(provider)) return BAD_FILTER('Proveedor inválido.');
    out.set('provider', provider);
  }

  const status = value('status');
  if (status !== undefined) {
    const statuses = status.split(',').map((s) => s.trim());
    if (statuses.length > 5 || !statuses.every(isOrderStatus)) {
      return BAD_FILTER('Estado inválido.');
    }
    out.set('status', [...new Set(statuses)].join(','));
  }

  const from = value('from');
  const to = value('to');
  if (from !== undefined && !isCalendarDay(from)) return BAD_FILTER('Fecha "desde" inválida.');
  if (to !== undefined && !isCalendarDay(to)) return BAD_FILTER('Fecha "hasta" inválida.');
  if (from !== undefined && to !== undefined && from > to) {
    return BAD_FILTER('La fecha "hasta" no puede ser anterior a "desde".');
  }
  if (from !== undefined) out.set('from', from);
  if (to !== undefined) out.set('to', to);

  const q = value('q');
  if (q !== undefined) {
    if (/\p{Cc}/u.test(q)) return BAD_FILTER('La búsqueda tiene caracteres no válidos.');
    if (q.length > ORDERS_SEARCH_MAX_LENGTH) return BAD_FILTER('La búsqueda es demasiado larga.');
    if (q.length < ORDERS_SEARCH_MIN_LENGTH) return BAD_FILTER('Escribe al menos 2 caracteres.');
    out.set('q', q);
  }

  const attention = value('attention');
  if (attention !== undefined) {
    if (attention !== 'true') return BAD_FILTER('Filtro de atención inválido.');
    out.set('attention', 'true');
  }

  const cursor = value('cursor');
  if (cursor !== undefined) {
    if (!CURSOR.test(cursor)) return BAD_FILTER('Página inválida.');
    out.set('cursor', cursor);
  }

  const limit = value('limit');
  if (limit !== undefined) {
    const n = Number(limit);
    if (!/^\d{1,3}$/.test(limit) || n < 1 || n > MAX_LIMIT) return BAD_FILTER('Límite inválido.');
    out.set('limit', String(n));
  }

  const query = out.toString();
  return {
    ok: true,
    method: 'GET',
    path: query === '' ? '/admin/orders' : `/admin/orders?${query}`,
  };
}

/** `GET /api/admin/orders/:id` → `GET /admin/orders/:id`. */
export function adminOrderPlan(method: string, orderId: string): WalletProxyPlan {
  if (method !== 'GET') return BAD_METHOD;
  if (!isUuid(orderId)) return { ok: false, status: 404, error: 'Reserva inválida.' };
  return { ok: true, method: 'GET', path: `/admin/orders/${orderId.toLowerCase()}` };
}
