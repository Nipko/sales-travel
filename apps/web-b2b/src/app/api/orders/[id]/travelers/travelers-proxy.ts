import type { ApiResponse } from '../../../../../lib/api';
import { isUuid } from '../../../../../lib/wallets';

/*
 * `GET` y `PATCH /api/orders/:id/travelers` del panel → los mismos del API (SAB-25).
 *
 * El cuerpo del cambio se valida aquí, en el borde, con la misma forma estricta que el API: por
 * pasajero, el documento, el viajero frecuente y los servicios especiales de la lista cerrada. Un
 * campo de más (un nombre, un contacto, un texto libre) corta el pedido. El estado y el cuerpo de la
 * respuesta se reenvían COMPLETOS: un 409 («ya hay un cambio en curso») llega con su texto.
 *
 * Este borde ve números de documento: no los registra. Sin respuesta legible no se sabe si el cambio
 * quedó: sale como 5xx con un texto que pide revisar la reserva, nunca como 2xx o 4xx.
 */

/**
 * Las dos respuestas hablan de personas —la lectura, de su documento enmascarado y de sus servicios
 * especiales (salud, religión)—: ningún caché del navegador ni intermedio las guarda.
 */
export const TRAVELERS_NO_STORE = { 'cache-control': 'no-store' } as const;

export interface TravelersProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

const DOCUMENT_TYPES: ReadonlySet<string> = new Set(['PASSPORT', 'NATIONAL_ID']);
const SPECIAL_CODES: ReadonlySet<string> = new Set(['WCHR', 'WCHS', 'VGML', 'MOML', 'DBML']);
const DOCUMENT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'number',
  'issuingCountry',
  'nationality',
  'expiryDate',
  'birthDate',
]);
const LOYALTY_KEYS: ReadonlySet<string> = new Set(['carrierCode', 'number']);
const CHANGE_KEYS: ReadonlySet<string> = new Set([
  'index',
  'identityDocument',
  'loyalty',
  'specialServices',
]);
const ROOT_KEYS: ReadonlySet<string> = new Set(['travelers']);

export interface ModifyTravelersBody {
  readonly travelers: readonly Record<string, unknown>[];
}

function plain(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function onlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY = /^[A-Z]{2}$/;

function documentOk(raw: unknown): boolean {
  const doc = plain(raw);
  if (doc === null || !onlyKeys(doc, DOCUMENT_KEYS)) return false;
  return (
    typeof doc['type'] === 'string' &&
    DOCUMENT_TYPES.has(doc['type']) &&
    matches(doc['number'], /^[A-Z0-9]{4,20}$/) &&
    matches(doc['issuingCountry'], COUNTRY) &&
    matches(doc['nationality'], COUNTRY) &&
    matches(doc['expiryDate'], DATE) &&
    (doc['birthDate'] === undefined || matches(doc['birthDate'], DATE))
  );
}

function loyaltyOk(raw: unknown): boolean {
  const loyalty = plain(raw);
  if (loyalty === null || !onlyKeys(loyalty, LOYALTY_KEYS)) return false;
  return (
    matches(loyalty['carrierCode'], /^[A-Z0-9]{2}$/) &&
    matches(loyalty['number'], /^[A-Z0-9]{4,25}$/)
  );
}

function specialServicesOk(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length > SPECIAL_CODES.size) return false;
  if (!raw.every((code) => typeof code === 'string' && SPECIAL_CODES.has(code))) return false;
  return new Set(raw).size === raw.length;
}

/** El cambio validado, o `null`. */
export function modifyTravelersBodyOf(raw: unknown): ModifyTravelersBody | null {
  const record = plain(raw);
  if (record === null || !onlyKeys(record, ROOT_KEYS)) return null;
  const travelers = record['travelers'];
  if (!Array.isArray(travelers) || travelers.length < 1 || travelers.length > 9) return null;
  const indexes = new Set<number>();
  const out: Record<string, unknown>[] = [];
  for (const item of travelers) {
    const change = plain(item);
    if (change === null || !onlyKeys(change, CHANGE_KEYS)) return null;
    const index = change['index'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 8) {
      return null;
    }
    if (indexes.has(index)) return null;
    indexes.add(index);
    const hasDocument = change['identityDocument'] !== undefined;
    const hasLoyalty = change['loyalty'] !== undefined;
    const hasServices = change['specialServices'] !== undefined;
    if (!hasDocument && !hasLoyalty && !hasServices) return null;
    if (hasDocument && !documentOk(change['identityDocument'])) return null;
    if (hasLoyalty && !loyaltyOk(change['loyalty'])) return null;
    if (hasServices && !specialServicesOk(change['specialServices'])) return null;
    out.push(change);
  }
  return { travelers: out };
}

export const TRAVELERS_INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message:
    'Los datos llegaron incompletos. Vuelve a abrir los pasajeros de la reserva e inténtalo de nuevo.',
} as const;

export const TRAVELERS_INVALID_ORDER = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'La reserva no es válida. Vuelve a abrirla desde Reservas.',
} as const;

export const TRAVELERS_UNREADABLE =
  'No pudimos confirmar si los cambios se guardaron. Revisa la reserva antes de volver a intentarlo.';

export const TRAVELERS_READ_UNREADABLE =
  'No pudimos consultar los pasajeros de esta reserva. Inténtalo de nuevo en unos minutos.';

/** `GET`: la reserva enmascarada, tal como la manda el API. */
export async function proxyTravelersRead(
  orderId: string,
  call: ApiCall,
): Promise<TravelersProxyReply> {
  if (!isUuid(orderId)) return { status: 400, body: TRAVELERS_INVALID_ORDER };
  const res = await call(`/orders/${encodeURIComponent(orderId)}/travelers`, { method: 'GET' });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: TRAVELERS_READ_UNREADABLE } };
}

/** `PATCH`: el cambio validado en el borde, y el desenlace completo. */
export async function proxyTravelersChange(
  req: Request,
  orderId: string,
  call: ApiCall,
): Promise<TravelersProxyReply> {
  if (!isUuid(orderId)) return { status: 400, body: TRAVELERS_INVALID_ORDER };
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { status: 400, body: TRAVELERS_INVALID };
  }
  const body = modifyTravelersBodyOf(raw);
  if (body === null) return { status: 400, body: TRAVELERS_INVALID };

  const res = await call(`/orders/${encodeURIComponent(orderId)}/travelers`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: TRAVELERS_UNREADABLE } };
}
