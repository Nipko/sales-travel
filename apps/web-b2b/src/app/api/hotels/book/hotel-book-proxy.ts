import type { ApiResponse } from '../../../../lib/api';
import { isIdempotencyKey, parseHotelBookRequest } from '../../../../lib/hotel-book';

/*
 * `POST /api/hotels/book` del panel → `POST /hotels/book` del API (docs/tbo/09 PR-6.4; 08 RF-22;
 * 03 §4.5 punto 6).
 *
 * Lo que la ruta proxy de órdenes no hace y ésta sí:
 *
 * - **Reenvía `Idempotency-Key`**, la del intento de reserva del navegador. Sin ella el API no
 *   reconoce el segundo envío (un doble clic, un reintento tras un corte) y la reserva sale dos
 *   veces.
 * - **Distingue `201` de `202`**: el estado viaja tal cual. Con `202` la reserva sigue en curso y
 *   el navegador consulta la orden; si viajara como `200`, un Book todavía en vuelo se vería igual
 *   que uno terminado.
 * - **Devuelve el cuerpo de error COMPLETO** (`reason`, `details`, `orderId`, `duplicateRequest`,
 *   `retryForbidden`, `reconciliationRequired`): son los que dicen si hay un precio nuevo que
 *   aceptar o una orden que ya existe y NO hay que repetir.
 *
 * El cuerpo se rearma con `parseHotelBookRequest`: lo que el navegador mande de más no llega.
 */

export interface HotelBookProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

const MISSING_KEY =
  'No pudimos identificar este intento de reserva. Recargá la página y volvé a confirmar la reserva.';

const INVALID_BODY =
  'Revisá los datos de los huéspedes y del contacto: hay campos incompletos o con un formato que no aceptamos.';

function badRequest(message: string): HotelBookProxyReply {
  return { status: 400, body: { statusCode: 400, error: 'Bad Request', message } };
}

export async function proxyHotelBook(req: Request, call: ApiCall): Promise<HotelBookProxyReply> {
  const key = req.headers.get('idempotency-key')?.trim();
  if (!isIdempotencyKey(key)) return badRequest(MISSING_KEY);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest(INVALID_BODY);
  }
  const body = parseHotelBookRequest(raw);
  if (body === undefined) return badRequest(INVALID_BODY);

  const res = await call('/hotels/book', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  // Sin cuerpo del API sólo queda el estado: el navegador lo lee como un desenlace que no se
  // conoce y no ofrece repetir la reserva con otra clave.
  return { status: res.status, body: { statusCode: res.status, message: res.message } };
}
