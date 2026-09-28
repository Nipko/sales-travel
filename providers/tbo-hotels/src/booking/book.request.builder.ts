import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import type { HotelBookingContact, HotelBookingRoomGuests } from '@sales-travel/domain';
import { z } from 'zod';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { compareDecimals } from '../internal/decimal';
import { MAX_ISSUE_REFS, zodIssueRefs } from '../internal/zod-issues';
import { TBO_SEARCH_LIMITS } from '../search/search.request.builder';
import { TBO_BOOKING_REFERENCE_PATTERN } from './booking-reference';

/**
 * Body de `Book` (docs/tbo/03 §3 y §7; 08 RF-18, RF-19, RF-20 CA-6; RNF-04 capas 1 a 3).
 *
 * `Book` confirma y emite el voucher en un solo paso (`BookingType` sólo admite `Voucher`, p. 33,
 * 70). Lo que sale es exactamente lo que la saga ya validó y persistió en el intent:
 *
 * - **Un `CustomerDetails` por habitación, en el orden de `PaxRooms`** (p. 34-40; CK-10): el
 *   elemento `i` es la habitación `i` del Search. En cada una, tantos `Adult` y `Child` como diga la
 *   ocupación, con un adulto primero, y **todos con nombre**, niños incluidos, como los ejemplos y
 *   los casos de certificación (03 §3.2; Q-42).
 * - **`Title` en `Mr`, `Mrs` o `Ms`**, elegido por el vendedor: no se deriva del género. `Dr` (lo
 *   usa Postman) no está en la lista del PDF y se rechaza hasta que TBO lo confirme (RF-18 CA-2;
 *   Q-41).
 * - **Nombres en ASCII** (D-TBO-23 A): `José Muñoz` sale como `Jose Munoz` y el original queda en la
 *   orden para el voucher. El PDF muestra el encoding roto (p. 51) y no documenta qué caracteres
 *   admite. Espacio, guion y apóstrofo, sin dígitos, de 2 a 40 caracteres y sin dos huéspedes
 *   iguales en la misma reserva (RF-18; Q-43).
 * - **`TotalFare` es el literal del PreBook de revalidación** (03 §3.4; CK-11): nunca una
 *   reconstrucción desde unidades menores. Sale como número JSON sólo si ese número reproduce el
 *   decimal EXACTO; si no, el builder falla cerrado y no se llama a TBO.
 * - **`BookingReferenceId` y `ClientReferenceId` con el mismo valor**, una referencia nuestra
 *   (`./booking-reference`) generada y persistida antes del Book (RF-19).
 * - **`EmailId` y `PhoneNumber`**: los del contacto que decida la saga (D-TBO-23 A: el operativo de
 *   la agencia). El teléfono va sólo con dígitos y prefijo de país, sin `+` (p. 35-36).
 * - **`BookingType: "Voucher"` y `PaymentMode: "Limit"`**, constantes y explícitos (03 §3.6).
 *
 * D1 vive aquí en las mismas tres capas que en PreBook: la entrada no tiene campos de pago (los tres
 * `?: never`), el esquema de salida es `.strict()` con los dos literales, y el cliente HTTP barre los
 * bytes que salen. No hay `PaymentInfo` en el tipo de salida más que como `?: never`.
 */

const BOOK_PATH = TBO_OPERATIONS.book.path;

/** El único modo de pago que sale de este paquete (D1; 03 §7). */
export const TBO_BOOK_PAYMENT_MODE = 'Limit';

/** El único tipo de reserva del contrato (p. 33, 70): confirma y emite el voucher. */
export const TBO_BOOK_BOOKING_TYPE = 'Voucher';

/** Los títulos de la tabla del Book (p. 32). */
export const TBO_GUEST_TITLES = ['Mr', 'Mrs', 'Ms'] as const;
export type TboGuestTitle = (typeof TBO_GUEST_TITLES)[number];

/**
 * Topes del Book. Los de nombres son provisorios (Q-43: el PDF no tiene reglas de largo ni de
 * caracteres) y no se toman de Despegar, que es otro proveedor (03 §3.2 punto 6).
 */
export const TBO_BOOK_LIMITS = Object.freeze({
  minNameLetters: 2,
  maxNameLength: 40,
  /** E.164: hasta 15 dígitos con el prefijo de país. El mínimo es nuestro (INFERIDO). */
  minPhoneDigits: 6,
  maxPhoneDigits: 15,
  maxCountryCodeDigits: 3,
  maxEmailLength: 254,
  maxRooms: TBO_SEARCH_LIMITS.maxRoomsPerSearch,
  maxGuestsPerRoom: TBO_SEARCH_LIMITS.maxAdultsPerRoom + TBO_SEARCH_LIMITS.maxChildrenPerRoom,
  /**
   * Dígitos de la parte entera de `TotalFare`. Ninguna reserva de hotel llega a mil millones en una
   * moneda de dos decimales (INFERIDO); con este techo, un número de 13 a 19 dígitos —la forma de
   * un PAN— no puede salir como importe (`pan-egress.guard.test.ts`).
   */
  maxTotalFareIntegerDigits: 9,
} as const);

// ───────────────────────── Huéspedes ─────────────────────────

/** Un huésped como sale a TBO, en vocabulario neutral. Es lo que la orden guarda como "enviado". */
export interface TboBookGuest {
  readonly title: TboGuestTitle;
  /** ASCII, normalizado (D-TBO-23 A). */
  readonly firstName: string;
  readonly lastName: string;
  readonly paxType: 'ADT' | 'CHD';
}

/**
 * Resultado de validar los huéspedes contra la ocupación. `issues` son `ruta:código` (sin valores:
 * son nombres de personas), con la ruta en el vocabulario de la entrada (`rooms.1.guests.0.lastName`).
 */
export type TboGuestCheck =
  | { readonly ok: true; readonly rooms: readonly (readonly TboBookGuest[])[] }
  | { readonly ok: false; readonly issues: readonly string[] };

export type TboNameRejection =
  | 'required'
  | 'contains_digits'
  | 'invalid_characters'
  | 'too_short'
  | 'too_long';

export type TboNameNormalization =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: TboNameRejection };

/**
 * Letras que la descomposición Unicode no separa en base + marca. Lo demás (`é`, `ñ`, `ç`, `ã`) lo
 * resuelve NFKD quitando la marca.
 */
const TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  ['ß', 'ss'],
  ['ẞ', 'SS'],
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['ł', 'l'],
  ['Ł', 'L'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['þ', 'th'],
  ['Þ', 'TH'],
  ['ı', 'i'],
  ['ħ', 'h'],
  ['Ħ', 'H'],
]);

/** Apóstrofos tipográficos y acentos sueltos que un teclado móvil pone en `O’Brien` o `D´Alessandro`. */
const APOSTROPHES = /[\u2018\u2019\u201B\u02BC\u02B9\u00B4\u0060\u2032]/g;
/** Guiones Unicode que no son el ASCII (`Ana‐María` con U+2010, pegado desde un documento). */
const HYPHENS = /[\u2010\u2011\u2012\u2013\u2014\u2212]/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const ALLOWED = /^[A-Za-z' -]+$/;

/**
 * Un nombre o apellido → ASCII (D-TBO-23 A; 03 §3.2 punto 5). Recorta, colapsa espacios, quita
 * tildes, unifica apóstrofos y guiones, y rechaza lo que no se puede transliterar sin inventar
 * (alfabetos no latinos, emojis, puntos): mejor pedir el nombre en latino que mandar signos que el
 * hotel lea como otro nombre.
 */
export function normalizeTboGuestName(raw: unknown): TboNameNormalization {
  if (typeof raw !== 'string') return { ok: false, reason: 'required' };
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return { ok: false, reason: 'required' };
  if (/\p{Nd}/u.test(collapsed)) return { ok: false, reason: 'contains_digits' };

  // Apóstrofos y guiones ANTES de descomponer: NFKD convierte `´` en espacio + acento combinante y
  // `D´Alessandro` terminaría como `D Alessandro`.
  const ascii = collapsed
    .replace(APOSTROPHES, "'")
    .replace(HYPHENS, '-')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^ -~]/g, (char) => TRANSLITERATIONS.get(char) ?? char)
    .replace(/\s+/g, ' ')
    .trim();
  if (!ALLOWED.test(ascii)) return { ok: false, reason: 'invalid_characters' };
  if ((ascii.match(/[A-Za-z]/g) ?? []).length < TBO_BOOK_LIMITS.minNameLetters) {
    return { ok: false, reason: 'too_short' };
  }
  if (ascii.length > TBO_BOOK_LIMITS.maxNameLength) return { ok: false, reason: 'too_long' };
  return { ok: true, value: ascii };
}

function isTitle(value: unknown): value is TboGuestTitle {
  return typeof value === 'string' && (TBO_GUEST_TITLES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * ¿Los huéspedes cuadran con la ocupación del Search? Pura y sin llamar a nadie: la saga la corre
 * ANTES de insertar el intent (RF-18) para responder 400 con el motivo y guardar en la orden los
 * nombres tal como van a salir; el builder la vuelve a correr y se niega a armar el body si no
 * pasa.
 *
 * Todo lo que falla se informa junto, en el orden de la entrada, hasta {@link MAX_ISSUE_REFS}.
 */
export function checkTboBookGuests(
  rooms: readonly HotelBookingRoomGuests[],
  occupancy: readonly HotelRoomOccupancy[],
): TboGuestCheck {
  const issues: string[] = [];
  const out: TboBookGuest[][] = [];
  const seen = new Set<string>();
  const roomList = asList(rooms) ?? [];
  const occupancyList = asList(occupancy) ?? [];

  if (roomList.length === 0) issues.push('rooms:empty');
  else if (roomList.length > TBO_BOOK_LIMITS.maxRooms) issues.push('rooms:too_many');
  if (roomList.length !== occupancyList.length) issues.push('rooms:count_mismatch');

  for (const [roomIndex, room] of roomList.entries()) {
    const at = `rooms.${roomIndex}`;
    const guests = isRecord(room) ? asList(room['guests']) : undefined;
    if (guests === undefined || guests.length === 0) {
      issues.push(`${at}.guests:empty`);
      continue;
    }
    if (guests.length > TBO_BOOK_LIMITS.maxGuestsPerRoom) issues.push(`${at}.guests:too_many`);

    const target: unknown = occupancyList[roomIndex];
    const expectedAdults = isRecord(target) ? target['adults'] : undefined;
    const expectedChildren = isRecord(target) ? asList(target['childrenAges'])?.length : undefined;
    let adults = 0;
    let children = 0;
    const sent: TboBookGuest[] = [];

    for (const [guestIndex, guest] of guests.entries()) {
      const here = `${at}.guests.${guestIndex}`;
      if (!isRecord(guest)) {
        issues.push(`${here}:invalid_type`);
        continue;
      }
      const paxType = guest['paxType'];
      if (paxType === 'ADT') adults += 1;
      else if (paxType === 'CHD') children += 1;
      else issues.push(`${here}.paxType:not_allowed`);
      if (guestIndex === 0 && paxType !== 'ADT') issues.push(`${here}:lead_not_adult`);

      const title = guest['title'];
      if (title === undefined || title === null || title === '') {
        issues.push(`${here}.title:required`);
      } else if (!isTitle(title)) {
        issues.push(`${here}.title:not_allowed`);
      }

      const firstName = normalizeTboGuestName(guest['firstName']);
      const lastName = normalizeTboGuestName(guest['lastName']);
      if (!firstName.ok) issues.push(`${here}.firstName:${firstName.reason}`);
      if (!lastName.ok) issues.push(`${here}.lastName:${lastName.reason}`);

      if (firstName.ok && lastName.ok) {
        // TBO recibe dos huéspedes iguales sin poder distinguirlos: el vendedor tiene que agregar un
        // segundo nombre o un sufijo (RF-18 CA-4). Se compara lo que SALE, después de transliterar.
        const key = `${firstName.value.toLowerCase()}\u0000${lastName.value.toLowerCase()}`;
        if (seen.has(key)) issues.push(`${here}:duplicate_guest`);
        seen.add(key);
      }
      if (
        firstName.ok &&
        lastName.ok &&
        isTitle(title) &&
        (paxType === 'ADT' || paxType === 'CHD')
      ) {
        sent.push({ title, firstName: firstName.value, lastName: lastName.value, paxType });
      }
    }

    if (typeof expectedAdults !== 'number' || expectedChildren === undefined) {
      if (roomIndex < occupancyList.length) issues.push(`occupancy.${roomIndex}:invalid_type`);
    } else {
      if (adults !== expectedAdults) issues.push(`${at}:adults_mismatch`);
      if (children !== expectedChildren) issues.push(`${at}:children_mismatch`);
    }
    out.push(sent);
  }

  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_ISSUE_REFS) };
  return { ok: true, rooms: out };
}

// ───────────────────────── Contacto ─────────────────────────

const EmailSchema = z.string().trim().min(1).max(TBO_BOOK_LIMITS.maxEmailLength).email();

function contactEmail(contact: HotelBookingContact | undefined, issues: string[]): unknown {
  const email: unknown = isRecord(contact) ? contact['email'] : undefined;
  if (email === undefined || email === null || email === '') {
    issues.push('contact.email:required');
    return undefined;
  }
  const parsed = EmailSchema.safeParse(email);
  if (!parsed.success) {
    issues.push('contact.email:invalid');
    return undefined;
  }
  return parsed.data;
}

/** Sólo separadores de un teléfono escrito a mano; cualquier otra cosa no es un teléfono. */
const PHONE_SEPARATORS = /[\s().+-]/g;

function phoneDigits(
  contact: HotelBookingContact | undefined,
  issues: string[],
): string | undefined {
  const phone: unknown = isRecord(contact) ? contact['phone'] : undefined;
  if (!isRecord(phone)) {
    issues.push('contact.phone:required');
    return undefined;
  }
  const parts: [string, unknown, boolean][] = [
    ['countryCode', phone['countryCode'], true],
    ['areaCode', phone['areaCode'], false],
    ['number', phone['number'], true],
  ];
  let digits = '';
  for (const [name, value, required] of parts) {
    if (value === undefined || value === null || value === '') {
      if (required) issues.push(`contact.phone.${name}:required`);
      continue;
    }
    const clean = typeof value === 'string' ? value.replace(PHONE_SEPARATORS, '') : undefined;
    if (clean === undefined || !/^\d*$/.test(clean)) {
      issues.push(`contact.phone.${name}:invalid_characters`);
      continue;
    }
    if (name === 'countryCode' && (clean.length === 0 || clean.length > 3)) {
      issues.push('contact.phone.countryCode:invalid_length');
      continue;
    }
    digits += clean;
  }
  if (digits.length > 0 && !/^[1-9]/.test(digits)) issues.push('contact.phone.countryCode:invalid');
  if (
    digits.length < TBO_BOOK_LIMITS.minPhoneDigits ||
    digits.length > TBO_BOOK_LIMITS.maxPhoneDigits
  ) {
    issues.push('contact.phone:invalid_length');
  }
  return digits;
}

// ───────────────────────── Importe ─────────────────────────

const PLAIN_DECIMAL = /^(\d+)(?:\.\d+)?$/;

/**
 * El literal de `TotalFare` → el número JSON que lo reproduce EXACTO, o el motivo por el que no se
 * puede mandar (03 §3.4 puntos 1 y 2). `Number('85.822')` es 85.822 y sale como tal; un decimal que
 * `double` no representa, o que `JSON.stringify` escribiría en notación exponencial, no sale.
 */
function exactFare(literal: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof literal !== 'string') return { ok: false, reason: 'required' };
  const match = PLAIN_DECIMAL.exec(literal);
  if (match === null) return { ok: false, reason: 'not_a_decimal' };
  const integerDigits = (match[1] ?? '').replace(/^0+(?=\d)/, '');
  if (integerDigits.length > TBO_BOOK_LIMITS.maxTotalFareIntegerDigits) {
    return { ok: false, reason: 'out_of_range' };
  }
  const value = Number(literal);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'not_positive' };
  if (!PLAIN_DECIMAL.test(String(value)) || compareDecimals(value, literal) !== 0) {
    return { ok: false, reason: 'not_exact' };
  }
  return { ok: true, value };
}

// ───────────────────────── Body ─────────────────────────

/** Lo que el builder lee. El modo de pago, el tipo de reserva y la tarjeta no se eligen. */
export interface TboBookInput {
  /** El de la respuesta del PreBook de revalidación (C2), no el de Search (Q-30). */
  readonly bookingCode: string;
  /** Nuestra referencia (`generateTboBookingReference`), ya persistida en el intent. */
  readonly bookingReferenceId: string;
  /** Literal decimal del `TotalFare` del PreBook de revalidación. */
  readonly totalFare: string;
  /** Huéspedes por habitación, en el orden de `PaxRooms`. */
  readonly rooms: readonly HotelBookingRoomGuests[];
  /** `PaxRooms` del contexto de búsqueda del servidor. */
  readonly occupancy: readonly HotelRoomOccupancy[];
  readonly contact: HotelBookingContact;
  readonly PaymentMode?: never;
  readonly PaymentInfo?: never;
  readonly BookingType?: never;
}

const NameSchema = z
  .string()
  .min(TBO_BOOK_LIMITS.minNameLetters)
  .max(TBO_BOOK_LIMITS.maxNameLength)
  .regex(ALLOWED);

const ReferenceSchema = z.string().regex(TBO_BOOKING_REFERENCE_PATTERN);

/**
 * El body exacto que sale al cable, con las claves en el orden del PDF y de Postman (p. 35-36).
 * `ClientReferenceId` y `BookingReferenceId` tienen que ser iguales (RF-19): si alguna vez TBO pide
 * que difieran (Q-34), el cambio empieza aquí y es visible.
 */
export const TboBookRequestSchema = z
  .object({
    BookingCode: z.string().min(1).max(255),
    CustomerDetails: z
      .array(
        z
          .object({
            CustomerNames: z
              .array(
                z
                  .object({
                    Title: z.enum(TBO_GUEST_TITLES),
                    FirstName: NameSchema,
                    LastName: NameSchema,
                    Type: z.enum(['Adult', 'Child']),
                  })
                  .strict(),
              )
              .min(1)
              .max(TBO_BOOK_LIMITS.maxGuestsPerRoom),
          })
          .strict(),
      )
      .min(1)
      .max(TBO_BOOK_LIMITS.maxRooms),
    ClientReferenceId: ReferenceSchema,
    BookingReferenceId: ReferenceSchema,
    TotalFare: z.number().finite().positive(),
    EmailId: z.string().max(TBO_BOOK_LIMITS.maxEmailLength).email(),
    PhoneNumber: z.string().regex(/^[1-9]\d{5,14}$/),
    BookingType: z.literal(TBO_BOOK_BOOKING_TYPE),
    PaymentMode: z.literal(TBO_BOOK_PAYMENT_MODE),
  })
  .strict()
  .refine((body) => body.ClientReferenceId === body.BookingReferenceId, {
    path: ['ClientReferenceId'],
    params: { reason: 'not_the_booking_reference' },
  });

/** Tipo crudo de TBO: no sale del paquete. `PaymentInfo?: never` es la barrera de D1 en el tipo. */
export type TboBookRequest = z.infer<typeof TboBookRequestSchema> & {
  readonly PaymentInfo?: never;
};

/**
 * Construye el body de un Book. Lanza `TboRequestBuildError` con `SCHEMA` y todos los issues juntos
 * (`ruta:código`, nunca valores) si algo no cuadra; en ese caso nada sale hacia TBO.
 */
export function buildTboBookRequest(input: TboBookInput): TboBookRequest {
  const issues: string[] = [];

  const guests = checkTboBookGuests(input.rooms, input.occupancy);
  if (!guests.ok) issues.push(...guests.issues);

  const fare = exactFare(input.totalFare);
  if (!fare.ok) issues.push(`totalFare:${fare.reason}`);

  const reference: unknown = input.bookingReferenceId;
  if (typeof reference !== 'string' || !TBO_BOOKING_REFERENCE_PATTERN.test(reference)) {
    issues.push('bookingReferenceId:invalid_format');
  }

  const email = contactEmail(input.contact, issues);
  const phone = phoneDigits(input.contact, issues);

  if (issues.length > 0 || !guests.ok || !fare.ok) {
    throw new TboRequestBuildError(BOOK_PATH, 'SCHEMA', issues.slice(0, MAX_ISSUE_REFS));
  }

  const parsed = TboBookRequestSchema.safeParse({
    BookingCode: input.bookingCode,
    CustomerDetails: guests.rooms.map((room) => ({
      CustomerNames: room.map((guest) => ({
        Title: guest.title,
        FirstName: guest.firstName,
        LastName: guest.lastName,
        Type: guest.paxType === 'ADT' ? 'Adult' : 'Child',
      })),
    })),
    ClientReferenceId: reference,
    BookingReferenceId: reference,
    TotalFare: fare.value,
    EmailId: email,
    PhoneNumber: phone,
    BookingType: TBO_BOOK_BOOKING_TYPE,
    PaymentMode: TBO_BOOK_PAYMENT_MODE,
  });
  if (!parsed.success) {
    throw new TboRequestBuildError(BOOK_PATH, 'SCHEMA', zodIssueRefs(parsed.error));
  }
  return parsed.data;
}
