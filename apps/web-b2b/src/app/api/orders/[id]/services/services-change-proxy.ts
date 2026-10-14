import type { ApiResponse } from '../../../../../lib/api';
import { isUuid } from '../../../../../lib/wallets';

/*
 * `POST /api/orders/:id/services/add` y `/remove` del panel → los mismos del API (SAB-20).
 *
 * El cuerpo se valida aquí, en el borde, con la misma forma estricta que el API: sólo qué y para
 * quién (o qué líneas), y lo que el vendedor vio que suma. Ningún precio por línea ni dato de pago
 * viaja: un campo de más corta el pedido. El estado y el cuerpo de la respuesta se reenvían
 * COMPLETOS: un 409 («el precio cambió», «ya hay un cambio en curso») llega con su texto.
 *
 * Sin respuesta legible no se sabe si el cambio salió: sale como 5xx con un texto que pide NO
 * repetirlo, nunca como 2xx o 4xx. El API, además, rechaza un segundo cambio mientras haya uno.
 */

export interface ServicesChangeProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

export type ServicesChange = 'add' | 'remove';

const MAX = 20;

export interface AddServicesBody {
  readonly selections: { serviceOfferItemId: string; passengerIndexes: number[] }[];
  readonly expectedTotalMinor: number;
  readonly currency: string;
}

export interface RemoveServicesBody {
  readonly lineIds: string[];
  readonly expectedTotalMinor: number;
  readonly currency: string;
}

function plain(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function sameKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record).sort();
  return own.length === keys.length && [...keys].sort().every((k, i) => own[i] === k);
}

function totalAndCurrency(record: Record<string, unknown>): boolean {
  const total = record['expectedTotalMinor'];
  const currency = record['currency'];
  return (
    typeof total === 'number' &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    typeof currency === 'string' &&
    /^[A-Z]{3}$/.test(currency)
  );
}

/** El alta validada, o `null`. */
export function addServicesBodyOf(raw: unknown): AddServicesBody | null {
  const record = plain(raw);
  if (record === null || !sameKeys(record, ['selections', 'expectedTotalMinor', 'currency'])) {
    return null;
  }
  if (!totalAndCurrency(record)) return null;
  const selections = record['selections'];
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > MAX) return null;
  const ids = new Set<string>();
  const out: AddServicesBody['selections'] = [];
  for (const item of selections) {
    const s = plain(item);
    if (s === null || !sameKeys(s, ['serviceOfferItemId', 'passengerIndexes'])) return null;
    const id = s['serviceOfferItemId'];
    const pax = s['passengerIndexes'];
    if (typeof id !== 'string' || id.length < 1 || id.length > 200 || ids.has(id)) return null;
    if (!Array.isArray(pax) || pax.length < 1 || pax.length > 9) return null;
    if (!pax.every((p) => typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 8)) {
      return null;
    }
    if (new Set(pax).size !== pax.length) return null;
    ids.add(id);
    out.push({ serviceOfferItemId: id, passengerIndexes: pax as number[] });
  }
  return {
    selections: out,
    expectedTotalMinor: record['expectedTotalMinor'] as number,
    currency: record['currency'] as string,
  };
}

/** La baja validada, o `null`. Las líneas son ids nuestros (UUID), nunca del proveedor. */
export function removeServicesBodyOf(raw: unknown): RemoveServicesBody | null {
  const record = plain(raw);
  if (record === null || !sameKeys(record, ['lineIds', 'expectedTotalMinor', 'currency'])) {
    return null;
  }
  if (!totalAndCurrency(record)) return null;
  const lineIds = record['lineIds'];
  if (!Array.isArray(lineIds) || lineIds.length < 1 || lineIds.length > MAX) return null;
  if (!lineIds.every(isUuid) || new Set(lineIds).size !== lineIds.length) return null;
  return {
    lineIds,
    expectedTotalMinor: record['expectedTotalMinor'] as number,
    currency: record['currency'] as string,
  };
}

export const SERVICES_CHANGE_INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message:
    'El pedido llegó incompleto. Vuelve a abrir los servicios de la reserva e inténtalo de nuevo.',
} as const;

export const SERVICES_CHANGE_INVALID_ORDER = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'La reserva no es válida. Vuelve a abrirla desde Reservas.',
} as const;

export const SERVICES_CHANGE_UNREADABLE =
  'No pudimos confirmar si el cambio de servicios salió. No lo repitas: revisa la reserva en unos minutos.';

export async function proxyServicesChange(
  req: Request,
  orderId: string,
  change: ServicesChange,
  call: ApiCall,
): Promise<ServicesChangeProxyReply> {
  if (!isUuid(orderId)) return { status: 400, body: SERVICES_CHANGE_INVALID_ORDER };
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { status: 400, body: SERVICES_CHANGE_INVALID };
  }
  const body = change === 'add' ? addServicesBodyOf(raw) : removeServicesBodyOf(raw);
  if (body === null) return { status: 400, body: SERVICES_CHANGE_INVALID };

  const res = await call(`/orders/${encodeURIComponent(orderId)}/services/${change}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: SERVICES_CHANGE_UNREADABLE } };
}
