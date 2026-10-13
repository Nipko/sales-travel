import {
  parseCancellationEstimate,
  type HotelCancellationEstimate,
} from '../app/(app)/reservas/hotel-cancellation-view';
import {
  actionErrorMessage,
  consoleCancelOutcomeOf,
  parseConfirmationSent,
  parseRetrieveResult,
  type ConsoleCancelOutcome,
  type RetrieveResult,
} from './platform-order-actions';
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
 * Las llamadas del navegador a Plataforma → Reservas de la red (`/api/admin/orders`): la lista, la
 * ficha y la post-venta desde la ficha. Devuelven datos ya validados o un mensaje para la pantalla;
 * nunca lanzan.
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

// ───────────────────────────── Acciones de post-venta ─────────────────────────────

/** Lo que respondió el BFF: el estado y el cuerpo leído (`undefined` si no era JSON o no llegó). */
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function send(url: string, init: RequestInit): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { status: 0, body: undefined };
  }
  const body = await readJson<unknown>(res);
  return { status: res.status, body: body.ok ? body.data : undefined };
}

function post(url: string, body: Readonly<Record<string, unknown>>): Promise<Answer> {
  return send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function actionUrl(orderId: string, rest: string): string {
  return `/api/admin/orders/${encodeURIComponent(orderId)}/${rest}`;
}

function failure<T>(answer: Answer): OrdersResult<T> {
  return {
    ok: false,
    status: answer.status,
    message: actionErrorMessage(answer.status, errorOf(answer.body)),
  };
}

function parsed<T>(answer: Answer, parse: (value: unknown) => T | undefined): OrdersResult<T> {
  if (answer.status < 200 || answer.status >= 300) return failure(answer);
  const data = parse(answer.body);
  return data === undefined
    ? { ok: false, status: answer.status, message: UNREADABLE }
    : { ok: true, data };
}

/** Reenvía la confirmación al cliente, con la marca del nodo de la reserva. */
export async function sendPlatformOrderConfirmation(
  orderId: string,
  reason: string,
): Promise<OrdersResult<{ readonly sent: boolean; readonly to: string }>> {
  return parsed(
    await post(actionUrl(orderId, 'send-confirmation'), { reason }),
    parseConfirmationSent,
  );
}

/** Consulta el estado al proveedor; devuelve la lectura y la ficha ya actualizada. */
export async function retrievePlatformOrder(
  orderId: string,
  reason: string,
): Promise<OrdersResult<RetrieveResult>> {
  return parsed(await post(actionUrl(orderId, 'retrieve'), { reason }), parseRetrieveResult);
}

/** Reintenta una cancelación que la agencia ya pidió y falló. */
export async function retryPlatformOrderCancellation(
  orderId: string,
  operationId: string,
  reason: string,
): Promise<ConsoleCancelOutcome> {
  const answer = await post(
    actionUrl(orderId, `operations/${encodeURIComponent(operationId)}/retry`),
    { reason },
  );
  return consoleCancelOutcomeOf(answer.status, answer.body);
}

/** Cancela en nombre de la agencia, con el número de la orden escrito para confirmar. */
export async function cancelPlatformOrder(
  orderId: string,
  reason: string,
  orderNumber: number,
): Promise<ConsoleCancelOutcome> {
  const answer = await post(actionUrl(orderId, 'cancel'), { reason, orderNumber });
  return consoleCancelOutcomeOf(answer.status, answer.body);
}

/** La penalidad estimada de cancelar una reserva de hotel. Sólo lee. */
export async function loadPlatformCancellationEstimate(
  orderId: string,
): Promise<OrdersResult<HotelCancellationEstimate>> {
  return parsed(
    await send(actionUrl(orderId, 'cancellation-estimate'), { method: 'GET' }),
    parseCancellationEstimate,
  );
}
