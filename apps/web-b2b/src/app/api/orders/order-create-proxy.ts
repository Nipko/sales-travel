import type { ApiResponse } from '../../../lib/api';

/*
 * `POST /api/orders` del panel → `POST /orders` del API.
 *
 * Reenvía el estado y el cuerpo COMPLETOS, como la ruta de hoteles. Con `api()` sólo viajaba
 * `message`: un 409 con `reconciliationRequired`/`retryForbidden`/`orderId` —createBooking dio
 * timeout y el PNR puede existir— llegaba al navegador como un error cualquiera, la pantalla lo
 * pintaba «Fallida» y volvía a abrir el formulario. Es decir, invitaba a reservar dos veces.
 */

export interface OrderCreateProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

export async function proxyOrderCreate(
  req: Request,
  call: ApiCall,
): Promise<OrderCreateProxyReply> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      status: 400,
      body: { statusCode: 400, error: 'Bad Request', message: 'La reserva llegó incompleta.' },
    };
  }
  const res = await call('/orders', { method: 'POST', body: JSON.stringify(raw) });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  // Sin cuerpo legible no se sabe qué pasó: un 201 cortado o la página HTML de un proxy pueden
  // llegar DESPUÉS de que Sabre creó el PNR. Sale siempre como 5xx, que el navegador lee como
  // desenlace desconocido y no reabre el formulario. Nunca como 2xx/4xx, que sí lo reabren.
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: res.message } };
}
