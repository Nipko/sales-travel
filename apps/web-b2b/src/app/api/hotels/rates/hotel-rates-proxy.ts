import type { HotelAccountEnvironment, HotelOffer } from '../../../(app)/hoteles/actions';
import type { HotelRatesOutcome } from '../../../(app)/hoteles/[hotelKey]/actions';
import { decodeHotelKey } from '../../../(app)/hoteles/_components/hotel-key';
import { parseStay } from '../../../(app)/hoteles/_components/hotel-search-handoff';
import { apiErrorFromBody, type ApiResponse } from '../../../../lib/api';

/*
 * `POST /api/hotels/rates` del panel → `POST /hotels/detail` del API (D-TBO-19 A): las tarifas de
 * UN proveedor del hotel para la estadía de la búsqueda. La ficha hace un pedido por proveedor y
 * pinta cada uno apenas llega: las tarifas de Despegar no esperan a que TBO responda (o se cuelgue
 * hasta su plazo), ni al revés.
 *
 * Es una ruta y no una acción del servidor a propósito: el cliente de Next despacha las acciones de
 * a una, así que dos acciones «en paralelo» saldrían en fila y volveríamos a esperar al más lento
 * (lo mismo que hotel-rooms-proxy.ts).
 *
 * La clave, el proveedor y la estadía llegan del navegador y se vuelven a validar aquí: sólo se
 * pide un proveedor que esté en la clave, con una estadía que pasa `parseStay`.
 */

export interface HotelRatesProxyReply {
  readonly status: number;
  readonly body: unknown;
}

/** Lo que responde la ruta: el desenlace de ese proveedor y lo que acompaña a sus tarifas. */
export interface HotelProviderRatesReply {
  readonly outcome: HotelRatesOutcome;
  /** Cuándo llegó la respuesta (epoch en ms del servidor). */
  readonly receivedAt: number;
  /** Quien financia a la agencia le bloqueó las no reembolsables (0055). Ausente si no. */
  readonly nonRefundableBlocked?: true;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

export const INVALID_KEY = 'No reconocemos ese hotel. Ábrelo desde los resultados de una búsqueda.';
export const MISSING_STAY = 'Faltan los datos de la búsqueda. Busca de nuevo desde Hoteles.';
const INCOMPLETE = 'La respuesta del proveedor llegó incompleta.';
const PERMISSIONS = '/hotels/booking-permissions';

function badRequest(message: string): HotelRatesProxyReply {
  return { status: 400, body: { statusCode: 400, error: 'Bad Request', message } };
}

export function isHotelOffer(value: unknown): value is HotelOffer {
  if (typeof value !== 'object' || value === null) return false;
  const { hotelId, roompacks } = value as { hotelId?: unknown; roompacks?: unknown };
  return typeof hotelId === 'string' && Array.isArray(roompacks);
}

/**
 * El entorno que el API pone junto a la oferta del detalle. Sólo los dos valores conocidos: otro
 * texto no avisa nada, que es mejor que avisar mal.
 */
function accountEnvironmentOf(offer: HotelOffer): HotelAccountEnvironment | undefined {
  const value = (offer as { accountEnvironment?: unknown }).accountEnvironment;
  return value === 'test' || value === 'live' ? value : undefined;
}

/** `GET /hotels/booking-permissions`: sólo un `blocked` explícito marca las tarifas. */
function nonRefundableBlockedOf(res: ApiResponse): boolean {
  if (res.kind !== 'json' || res.status !== 200) return false;
  const body = res.body;
  if (typeof body !== 'object' || body === null) return false;
  const rates = (body as { nonRefundableRates?: unknown }).nonRefundableRates;
  return (
    typeof rates === 'object' &&
    rates !== null &&
    (rates as { effective?: unknown }).effective === 'blocked'
  );
}

function errorMessageOf(res: ApiResponse): string {
  if (res.kind !== 'json') return res.message;
  return apiErrorFromBody(res.status, 'El proveedor no respondió.', res.body).message;
}

export async function proxyHotelRates(raw: unknown, call: ApiCall): Promise<HotelRatesProxyReply> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const refs = typeof input.hotelKey === 'string' ? decodeHotelKey(input.hotelKey) : undefined;
  const ref = refs?.find((r) => r.provider === input.provider);
  if (ref === undefined) return badRequest(INVALID_KEY);
  const stay = parseStay(input.stay);
  if (stay === undefined) return badRequest(MISSING_STAY);

  const body: Record<string, unknown> = {
    hotelId: ref.hotelId,
    provider: ref.provider,
    checkinDate: stay.checkinDate,
    checkoutDate: stay.checkoutDate,
    rooms: stay.rooms,
  };
  if (stay.guestNationality !== undefined) body.guestNationality = stay.guestNationality;
  if (stay.refundableOnly) body.refundableOnly = true;
  // La moneda del listado: sin ella el detalle buscaría en la de la agencia (D-TBO-15).
  if (stay.currency !== undefined) body.currency = stay.currency;

  const [detail, permission] = await Promise.all([
    call('/hotels/detail', { method: 'POST', body: JSON.stringify(body) }),
    call(PERMISSIONS, { method: 'GET' }),
  ]);

  let outcome: HotelRatesOutcome;
  if (detail.kind !== 'json' || detail.status < 200 || detail.status >= 300) {
    outcome = { ref, error: errorMessageOf(detail) };
  } else if (!isHotelOffer(detail.body)) {
    outcome = { ref, error: INCOMPLETE };
  } else {
    const environment = accountEnvironmentOf(detail.body);
    outcome =
      environment === undefined
        ? { ref, offer: detail.body }
        : { ref, offer: detail.body, accountEnvironment: environment };
  }
  const reply: HotelProviderRatesReply = {
    outcome,
    receivedAt: Date.now(),
    ...(nonRefundableBlockedOf(permission) ? { nonRefundableBlocked: true as const } : {}),
  };
  return { status: 200, body: reply };
}
