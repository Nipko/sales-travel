import type { ApiResponse } from '../../../../../lib/api';
import { isUuid } from '../../../../../lib/wallets';

/*
 * `GET /api/orders/:id/ticket-check` del panel → `GET /orders/:id/ticket-check` del API (SAB-09).
 *
 * Las condiciones de los tiquetes se leen en vivo y valen para ese momento: la respuesta no se
 * guarda en ningún caché (`no-store`). El estado y el cuerpo se reenvían completos, para que un 409
 * («sólo en una reserva emitida») o un 502 del proveedor lleguen con su texto.
 */

export interface TicketCheckProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

/** Sin respuesta legible del API: es una lectura, así que se puede volver a pedir. */
export const TICKET_CHECK_UNREADABLE =
  'No pudimos consultar las condiciones. Vuelve a intentarlo en unos minutos.';

/** Lo que la ruta manda con la respuesta: nada de esto se cachea. */
export const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Un id que no es de una reserva no llega al API. */
export const TICKET_CHECK_INVALID_ORDER = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'La reserva no es válida. Vuelve a abrirla desde Reservas.',
} as const;

export async function proxyTicketCheck(
  orderId: string,
  call: ApiCall,
): Promise<TicketCheckProxyReply> {
  if (!isUuid(orderId)) return { status: 400, body: TICKET_CHECK_INVALID_ORDER };
  const res = await call(`/orders/${encodeURIComponent(orderId)}/ticket-check`, { method: 'GET' });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: TICKET_CHECK_UNREADABLE } };
}
