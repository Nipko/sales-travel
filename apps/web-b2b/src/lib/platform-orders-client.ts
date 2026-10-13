import {
  ordersErrorMessage,
  ordersSearch,
  parsePlatformOrderDetail,
  parsePlatformOrdersPage,
  type OrdersFilters,
  type PlatformOrderDetail,
  type PlatformOrdersPage,
} from './platform-orders';
import { readJson } from './read-json';

/**
 * Las llamadas del navegador a Plataforma → Reservas de la red (`/api/admin/orders`). Devuelven datos
 * ya validados o un mensaje para la pantalla; nunca lanzan.
 */

export type OrdersResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

async function read<T>(
  url: string,
  parse: (value: unknown) => T | undefined,
  kind: 'list' | 'detail',
): Promise<OrdersResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, message: ordersErrorMessage(0, undefined, kind) };
  }
  const body = await readJson<unknown>(res);
  if (!body.ok) {
    return {
      ok: false,
      status: res.status,
      // Lo que no es JSON (la página de un proxy) dice poco: el estado decide el mensaje.
      message: res.ok ? UNREADABLE : ordersErrorMessage(res.status, undefined, kind),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: ordersErrorMessage(res.status, errorOf(body.data), kind),
    };
  }
  const data = parse(body.data);
  return data === undefined
    ? { ok: false, status: res.status, message: UNREADABLE }
    : { ok: true, data };
}

/** Una página de la lista con estos filtros; `cursor` para la siguiente. */
export function loadPlatformOrders(
  filters: OrdersFilters,
  cursor?: string | null,
): Promise<OrdersResult<PlatformOrdersPage>> {
  return read(
    `/api/admin/orders?${ordersSearch(filters, cursor)}`,
    parsePlatformOrdersPage,
    'list',
  );
}

/** La ficha de una reserva. El API deja constancia de que se abrió. */
export function loadPlatformOrder(orderId: string): Promise<OrdersResult<PlatformOrderDetail>> {
  return read(
    `/api/admin/orders/${encodeURIComponent(orderId)}`,
    parsePlatformOrderDetail,
    'detail',
  );
}
