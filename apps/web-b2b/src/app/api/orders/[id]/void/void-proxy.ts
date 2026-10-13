import type { ApiResponse } from '../../../../../lib/api';
import { isUuid } from '../../../../../lib/wallets';

/*
 * `POST /api/orders/:id/void` del panel → `POST /orders/:id/void` del API (SAB-09).
 *
 * No viaja cuerpo: el API vuelve a consultar en vivo las condiciones y decide con lo que dice el
 * proveedor, no con lo que vio la pantalla. El estado y el cuerpo se reenvían COMPLETOS, con el
 * `reason` que separa un 409 «quedó en duda, no repitas» de un 409 «la aerolínea dijo que no».
 *
 * Sin respuesta legible no se sabe si la anulación salió: sale como 5xx con un texto que pide NO
 * repetirla, nunca como un 2xx o un 4xx.
 */

export interface VoidProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

export const VOID_UNREADABLE =
  'No pudimos confirmar si la anulación salió. No la repitas: revisa el historial de la reserva en unos minutos.';

/** Un id que no es de una reserva no llega al API: nada salió, y se dice así (4xx, no 5xx). */
export const VOID_INVALID_ORDER = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'La reserva no es válida. Vuelve a abrirla desde Reservas.',
} as const;

export async function proxyTicketVoid(orderId: string, call: ApiCall): Promise<VoidProxyReply> {
  if (!isUuid(orderId)) return { status: 400, body: VOID_INVALID_ORDER };
  const res = await call(`/orders/${encodeURIComponent(orderId)}/void`, { method: 'POST' });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: VOID_UNREADABLE } };
}
