/*
 * El Book neutral de hotel entre el navegador y el API (docs/tbo/09 PR-6.4; 08 RF-18, RF-20, RF-22;
 * 03 §3 y §4.5): qué cuerpo sale y con qué `Idempotency-Key`.
 *
 * Lo usan las dos puntas del panel. El navegador arma el cuerpo con esto; la ruta del servidor
 * (`app/api/hotels/book`) lo vuelve a leer con {@link parseHotelBookRequest} y reenvía SÓLO lo que
 * reconoce: un campo que el navegador mande de más no llega al API. Por eso acá no existe ningún
 * campo de pago: la reserva se hace con el crédito de la cuenta (`Limit`, D1) y la agencia la
 * paga con su cartera; nunca hay tarjeta en la web.
 *
 * Tarifa, ocupación, fechas e importe del proveedor los pone el servidor con el snapshot del
 * PreBook (`prebookRef`): el navegador sólo aporta lo que el vendedor eligió y cargó.
 */

export interface HotelBookMoney {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Los títulos del Book (TBO p. 32). `Dr` no, hasta que el proveedor lo confirme (Q-41). */
export const HOTEL_GUEST_TITLES = ['Mr', 'Mrs', 'Ms'] as const;
export type HotelGuestTitle = (typeof HOTEL_GUEST_TITLES)[number];

export type HotelGuestPaxType = 'ADT' | 'CHD';

export interface HotelBookGuest {
  readonly paxType: HotelGuestPaxType;
  readonly title: HotelGuestTitle;
  readonly firstName: string;
  readonly lastName: string;
}

export interface HotelBookRoom {
  readonly guests: readonly HotelBookGuest[];
}

/** El contacto del HUÉSPED: queda en la orden y no viaja al proveedor (D-TBO-23 A). */
export interface HotelBookContact {
  readonly email: string;
  readonly phone: { readonly countryCode: string; readonly number: string };
}

export interface HotelBookRequest {
  readonly providerCode: string;
  readonly prebookRef: string;
  /** Precio de VENTA que el vendedor aceptó; el servidor lo vuelve a verificar. */
  readonly acceptedTotal: HotelBookMoney;
  /** Sólo `true`: el vendedor confirmó que le mostró al cliente los cargos a pagar en el hotel. */
  readonly atPropertyAcknowledged?: true;
  /** Una por habitación, en el orden de la búsqueda. */
  readonly rooms: readonly HotelBookRoom[];
  readonly contact: HotelBookContact;
}

/** Los topes del borde del API (`hotels.schemas.ts`): lo que no los cumple no se reenvía. */
export const HOTEL_BOOK_LIMITS = Object.freeze({
  maxRooms: 8,
  maxGuestsPerRoom: 16,
  maxNameLength: 100,
  maxEmailLength: 254,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El formato que el API exige a la clave: UUID de versión 1 a 5 (`order-create-intent.store.ts`). */
const IDEMPOTENCY_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COUNTRY_CODE_RE = /^\+?\d{1,3}$/;
const PHONE_NUMBER_RE = /^[\d\s().-]{4,20}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ───────────────────────── Idempotency-Key ─────────────────────────

export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_RE.test(value);
}

type RandomSource = {
  readonly getRandomValues: <T extends ArrayBufferView | null>(array: T) => T;
  readonly randomUUID?: () => string;
};

/**
 * Una clave NUEVA para un intento de reserva de hotel. No se comparte con nada: ni con otra
 * reserva ni con vuelos, porque el API la usa para reconocer el segundo envío del MISMO intento.
 *
 * `randomUUID` sólo existe en contextos seguros; en `http://` por IP (un entorno de prueba) no
 * está, y sin clave no hay reserva. Por eso el respaldo arma un UUID v4 con `getRandomValues`, que
 * sí está en todos.
 */
export function newIdempotencyKey(source: RandomSource = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ───────────────────────── Lectura del cuerpo ─────────────────────────

function textIn(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 && text.length <= max ? text : undefined;
}

function moneyOf(value: unknown): HotelBookMoney | undefined {
  if (!isRecord(value)) return undefined;
  const { amountMinor, currency } = value;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return undefined;
  }
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) return undefined;
  return { amountMinor, currency };
}

function guestOf(value: unknown): HotelBookGuest | undefined {
  if (!isRecord(value)) return undefined;
  const { paxType, title } = value;
  if (paxType !== 'ADT' && paxType !== 'CHD') return undefined;
  if (typeof title !== 'string' || !(HOTEL_GUEST_TITLES as readonly string[]).includes(title)) {
    return undefined;
  }
  const firstName = textIn(value['firstName'], HOTEL_BOOK_LIMITS.maxNameLength);
  const lastName = textIn(value['lastName'], HOTEL_BOOK_LIMITS.maxNameLength);
  if (firstName === undefined || lastName === undefined) return undefined;
  return { paxType, title: title as HotelGuestTitle, firstName, lastName };
}

function roomOf(value: unknown): HotelBookRoom | undefined {
  if (!isRecord(value) || !Array.isArray(value['guests'])) return undefined;
  const list: unknown[] = value['guests'];
  if (list.length === 0 || list.length > HOTEL_BOOK_LIMITS.maxGuestsPerRoom) return undefined;
  const guests = list.map(guestOf);
  return guests.every((g): g is HotelBookGuest => g !== undefined) ? { guests } : undefined;
}

function contactOf(value: unknown): HotelBookContact | undefined {
  if (!isRecord(value) || !isRecord(value['phone'])) return undefined;
  const email = typeof value['email'] === 'string' ? value['email'].trim() : '';
  if (email.length > HOTEL_BOOK_LIMITS.maxEmailLength || !EMAIL_RE.test(email)) return undefined;
  const countryCode = value['phone']['countryCode'];
  const number = value['phone']['number'];
  if (typeof countryCode !== 'string' || !COUNTRY_CODE_RE.test(countryCode.trim())) {
    return undefined;
  }
  if (typeof number !== 'string' || !PHONE_NUMBER_RE.test(number.trim())) return undefined;
  return { email, phone: { countryCode: countryCode.trim(), number: number.trim() } };
}

/**
 * El cuerpo del Book neutral, rearmado campo por campo, o `undefined` si algo no cumple los topes
 * del API. Lo que venga de más se descarta: el API es estricto y un campo desconocido haría fallar
 * la reserva, y la ruta no reenvía nada que no haya nombrado acá.
 */
export function parseHotelBookRequest(value: unknown): HotelBookRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { providerCode, prebookRef } = value;
  if (
    typeof providerCode !== 'string' ||
    providerCode.length < 2 ||
    providerCode.length > 40 ||
    !PROVIDER_CODE_RE.test(providerCode)
  ) {
    return undefined;
  }
  if (typeof prebookRef !== 'string' || !UUID_RE.test(prebookRef)) return undefined;
  const acceptedTotal = moneyOf(value['acceptedTotal']);
  if (acceptedTotal === undefined) return undefined;
  if (!Array.isArray(value['rooms'])) return undefined;
  const roomList: unknown[] = value['rooms'];
  if (roomList.length === 0 || roomList.length > HOTEL_BOOK_LIMITS.maxRooms) return undefined;
  const rooms = roomList.map(roomOf);
  if (!rooms.every((r): r is HotelBookRoom => r !== undefined)) return undefined;
  const contact = contactOf(value['contact']);
  if (contact === undefined) return undefined;
  return {
    providerCode,
    prebookRef,
    acceptedTotal,
    ...(value['atPropertyAcknowledged'] === true ? { atPropertyAcknowledged: true as const } : {}),
    rooms,
    contact,
  };
}
