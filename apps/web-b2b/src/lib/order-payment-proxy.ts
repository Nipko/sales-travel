import type { ApiResponse } from './api';
import { paymentLinkBody } from './order-payment';
import { isUuid } from './wallets';

/*
 * Proxies del panel para pagar una reserva con las formas de pago gobernadas (0089):
 * - `GET  /api/orders/:id/payment-options` → `GET  /orders/:id/payment-options`
 * - `POST /api/orders/:id/payment-link`    → `POST /orders/:id/payment-link`
 *
 * El id se valida antes de llegar al API y el cuerpo del enlace se rearma: sólo viaja el correo,
 * recortado y validado. El estado y el cuerpo de la respuesta pasan completos, para que un 403
 * («no está habilitada») o un 409 («la reserva no está sin pagar») lleguen con su texto.
 */

export interface OrderPaymentProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

/** Las opciones dependen del estado de la orden y del gobierno: no se cachean. */
export const NO_STORE = { 'cache-control': 'no-store' } as const;

export const PAYMENT_INVALID_ORDER = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'La reserva no es válida. Vuelve a abrirla desde Reservas.',
} as const;

export const PAYMENT_LINK_INVALID_BODY = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'Escribe un correo válido para enviar el enlace.',
} as const;

export const PAYMENT_OPTIONS_UNREADABLE =
  'No pudimos cargar las formas de pago. Vuelve a intentarlo en unos minutos.';

function unreadable(res: ApiResponse, message: string): OrderPaymentProxyReply {
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message } };
}

export async function proxyPaymentOptions(
  orderId: string,
  call: ApiCall,
): Promise<OrderPaymentProxyReply> {
  if (!isUuid(orderId)) return { status: 400, body: PAYMENT_INVALID_ORDER };
  const res = await call(`/orders/${encodeURIComponent(orderId)}/payment-options`, {
    method: 'GET',
  });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  return unreadable(res, PAYMENT_OPTIONS_UNREADABLE);
}

export async function proxyPaymentLink(
  req: Request,
  orderId: string,
  call: ApiCall,
): Promise<OrderPaymentProxyReply> {
  if (!isUuid(orderId)) return { status: 400, body: PAYMENT_INVALID_ORDER };
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { status: 400, body: PAYMENT_LINK_INVALID_BODY };
  }
  const email =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['email']
      : undefined;
  const body = typeof email === 'string' ? paymentLinkBody(email) : null;
  if (body === null) return { status: 400, body: PAYMENT_LINK_INVALID_BODY };

  const res = await call(`/orders/${encodeURIComponent(orderId)}/payment-link`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  // Sin respuesta legible no se sabe si el correo salió: 5xx, nunca 2xx ni 4xx.
  return unreadable(res, res.message);
}
