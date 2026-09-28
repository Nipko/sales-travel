import {
  HOTEL_BOOK_LIMITS,
  HOTEL_GUEST_TITLES,
  type HotelBookContact,
  type HotelBookRoom,
  type HotelGuestPaxType,
  type HotelGuestTitle,
} from '../../../../../lib/hotel-book';
import type { RoomDistribution } from '../../actions';

/*
 * Los huéspedes del paso 2 sin React (U-12; RF-18; docs/tbo/03 §3.2): un bloque por habitación en
 * el orden de la búsqueda, cada huésped con su tipo fijo —el que ocupa en esa habitación—, el
 * título elegido (nunca derivado de nada) y nombre y apellido; más el contacto del huésped.
 *
 * Las reglas de los nombres son las del servidor para el proveedor que hoy reserva con este flujo
 * (TBO: letras latinas, espacio, guion y apóstrofo, sin números, de 2 a 40 caracteres, sin dos
 * huéspedes iguales). Acá se adelantan para que el vendedor las vea al lado del campo; quien
 * decide es el servidor, y lo que rechace vuelve al mismo campo ({@link fieldErrorsFromGuestIssues}).
 */

export type GuestTitleDraft = HotelGuestTitle | '';

export interface GuestSlotDraft {
  readonly paxType: HotelGuestPaxType;
  /** Edad del niño en la búsqueda. */
  readonly age?: number;
  readonly title: GuestTitleDraft;
  readonly firstName: string;
  readonly lastName: string;
}

export interface GuestRoomDraft {
  readonly guests: readonly GuestSlotDraft[];
}

export interface GuestContactDraft {
  readonly email: string;
  readonly phoneCountryCode: string;
  readonly phoneNumber: string;
}

export interface GuestDraft {
  readonly rooms: readonly GuestRoomDraft[];
  readonly contact: GuestContactDraft;
}

/** Ruta de un campo, la misma que usa el API en sus motivos (`rooms.1.guests.0.lastName`). */
export type GuestFieldPath = string;

export function guestFieldPath(
  room: number,
  guest: number,
  field: 'title' | 'firstName' | 'lastName',
): GuestFieldPath {
  return `rooms.${room}.guests.${guest}.${field}`;
}

export const CONTACT_FIELDS = {
  email: 'contact.email',
  phoneCountryCode: 'contact.phone.countryCode',
  phoneNumber: 'contact.phone.number',
} as const;

/** La casilla de los cargos a pagar en el hotel. */
export const AT_PROPERTY_FIELD = 'atPropertyAcknowledged';

export const TITLE_OPTIONS: readonly { readonly value: HotelGuestTitle; readonly label: string }[] =
  HOTEL_GUEST_TITLES.map((value) => ({
    value,
    label: value === 'Mr' ? 'Sr. (Mr)' : value === 'Mrs' ? 'Sra. (Mrs)' : 'Srta. (Ms)',
  }));

/**
 * Prefijo telefónico de los países que están arriba en la nacionalidad. Arranca el campo con algo
 * que el vendedor ve y cambia; para los demás, vacío: un prefijo inventado es un teléfono ajeno.
 */
const DIAL_CODES: Readonly<Record<string, string>> = {
  CO: '+57',
  PE: '+51',
  BR: '+55',
  AR: '+54',
  CL: '+56',
  EC: '+593',
  MX: '+52',
  US: '+1',
  ES: '+34',
};

export function dialCodeFor(nationality: string): string {
  return DIAL_CODES[nationality] ?? '';
}

/**
 * El formulario vacío de una estadía: por habitación, primero los adultos —el primero es el
 * titular, y el proveedor lo exige adulto— y después los niños en el orden de sus edades en la
 * búsqueda. Así el huésped `i` de la habitación `r` es el mismo hueco que el servidor valida.
 */
export function emptyGuestDraft(
  rooms: readonly RoomDistribution[],
  guestNationality: string,
): GuestDraft {
  return {
    rooms: rooms.map((room) => ({
      guests: [
        ...Array.from({ length: room.adults }, () => blankGuest('ADT')),
        ...room.childrenAges.map((age) => ({ ...blankGuest('CHD'), age })),
      ],
    })),
    contact: {
      email: '',
      phoneCountryCode: dialCodeFor(guestNationality),
      phoneNumber: '',
    },
  };
}

function blankGuest(paxType: HotelGuestPaxType): GuestSlotDraft {
  return { paxType, title: '', firstName: '', lastName: '' };
}

/** ¿El borrador guardado sirve para esta estadía? Sólo si tiene los mismos huecos. */
export function draftFitsRooms(draft: GuestDraft, rooms: readonly RoomDistribution[]): boolean {
  return (
    draft.rooms.length === rooms.length &&
    draft.rooms.every((room, i) => {
      const target = rooms[i];
      if (target === undefined) return false;
      const adults = room.guests.filter((g) => g.paxType === 'ADT').length;
      const children = room.guests.filter((g) => g.paxType === 'CHD').length;
      return adults === target.adults && children === target.childrenAges.length;
    })
  );
}

export function withGuest(
  draft: GuestDraft,
  room: number,
  guest: number,
  patch: Partial<Pick<GuestSlotDraft, 'title' | 'firstName' | 'lastName'>>,
): GuestDraft {
  return {
    ...draft,
    rooms: draft.rooms.map((r, ri) =>
      ri !== room
        ? r
        : { guests: r.guests.map((g, gi) => (gi === guest ? { ...g, ...patch } : g)) },
    ),
  };
}

export function withContact(draft: GuestDraft, patch: Partial<GuestContactDraft>): GuestDraft {
  return { ...draft, contact: { ...draft.contact, ...patch } };
}

// ───────────────────────── Rótulos ─────────────────────────

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function childAgeLabel(age: number | undefined): string {
  if (age === undefined) return '';
  if (age < 1) return 'menos de 1 año';
  return plural(age, 'año', 'años');
}

/** "Adulto 1 (titular)", "Adulto 2", "Niño 1 · 7 años": el hueco que ocupa en la habitación. */
export function guestSlotLabel(room: GuestRoomDraft, guestIndex: number): string {
  const slot = room.guests[guestIndex];
  if (slot === undefined) return '';
  const sameType = room.guests.slice(0, guestIndex + 1).filter((g) => g.paxType === slot.paxType);
  const n = sameType.length;
  if (slot.paxType === 'ADT') return n === 1 ? 'Adulto 1 (titular)' : `Adulto ${n}`;
  const age = childAgeLabel(slot.age);
  return age ? `Niño ${n} · ${age}` : `Niño ${n}`;
}

/** "2 adultos · 1 niño", con el nombre de la habitación de la tarifa si se sabe cuál es. */
export function roomDetails(room: GuestRoomDraft, roomName: string | undefined): string {
  const adults = room.guests.filter((g) => g.paxType === 'ADT').length;
  const children = room.guests.length - adults;
  const parts = [plural(adults, 'adulto', 'adultos')];
  if (children > 0) parts.push(plural(children, 'niño', 'niños'));
  const name = roomName?.trim();
  return name ? `${name} · ${parts.join(' · ')}` : parts.join(' · ');
}

/**
 * El nombre de la habitación `i` de la tarifa, sólo si la tarifa trae una por habitación: si trae
 * otra cantidad, no se sabe cuál es cuál y no se adivina.
 */
export function roomNameAt(
  roomNames: readonly string[],
  roomCount: number,
  index: number,
): string | undefined {
  if (roomNames.length !== roomCount) return undefined;
  const name = roomNames[index]?.trim();
  return name ? name : undefined;
}

// ───────────────────────── Nombres ─────────────────────────

const NAME_MAX = 40;
const NAME_MIN_LETTERS = 2;

/** Letras que la descomposición Unicode no separa en base y marca (las mismas que el servidor). */
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
const APOSTROPHES = /[‘’‛ʼʹ´`′]/g;
const HYPHENS = /[‐‑‒–—−]/g;
const COMBINING_MARKS = /[̀-ͯ]/g;
const ALLOWED = /^[A-Za-z' -]+$/;

export type GuestNameProblem =
  | 'required'
  | 'contains_digits'
  | 'invalid_characters'
  | 'too_short'
  | 'too_long';

/** Recorte y espacios colapsados: lo que se manda es lo que se escribió, sin bordes. */
export function tidyName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * El nombre como lo recibe el proveedor: `José Muñoz` → `Jose Munoz` (D-TBO-23 A). `undefined` si
 * tiene algo que no se puede pasar a letras latinas sin inventar (otro alfabeto, un emoji, un
 * punto).
 */
export function asciiName(raw: string): string | undefined {
  const ascii = tidyName(raw)
    .replace(APOSTROPHES, "'")
    .replace(HYPHENS, '-')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^ -~]/g, (char) => TRANSLITERATIONS.get(char) ?? char)
    .replace(/\s+/g, ' ')
    .trim();
  return ALLOWED.test(ascii) ? ascii : undefined;
}

export function guestNameProblem(raw: string): GuestNameProblem | undefined {
  const text = tidyName(raw);
  if (text.length === 0) return 'required';
  if (/\p{Nd}/u.test(text)) return 'contains_digits';
  const ascii = asciiName(text);
  if (ascii === undefined) return 'invalid_characters';
  if ((ascii.match(/[A-Za-z]/g) ?? []).length < NAME_MIN_LETTERS) return 'too_short';
  if (ascii.length > NAME_MAX) return 'too_long';
  return undefined;
}

const NAME_MESSAGES: Readonly<Record<GuestNameProblem, (field: string) => string>> = {
  required: (field) => `Completá el ${field}.`,
  contains_digits: (field) => `El ${field} no puede tener números.`,
  invalid_characters: () => 'Usá sólo letras, espacios, guiones o apóstrofos.',
  too_short: () => 'Tiene que tener al menos 2 letras.',
  too_long: () => `Puede tener hasta ${NAME_MAX} caracteres.`,
};

const FIELD_NOUN = { firstName: 'nombre', lastName: 'apellido' } as const;

export const TITLE_REQUIRED = 'Elegí el título.';
export const DUPLICATE_GUEST =
  'Hay otro huésped con el mismo nombre y apellido: agregá un segundo nombre o un sufijo para distinguirlos.';
export const AT_PROPERTY_REQUIRED =
  'Confirmá que le mostraste al cliente los cargos a pagar en el hotel.';

function nameMessage(field: 'firstName' | 'lastName', problem: GuestNameProblem): string {
  return NAME_MESSAGES[problem](FIELD_NOUN[field]);
}

// ───────────────────────── Contacto ─────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COUNTRY_CODE_RE = /^\+?[1-9]\d{0,2}$/;
const PHONE_NUMBER_RE = /^[\d\s().-]{4,20}$/;

export const CONTACT_MESSAGES = {
  emailRequired: 'Completá el email.',
  emailInvalid: 'Revisá el formato del email (por ejemplo, nombre@dominio.com).',
  countryCodeRequired: 'Completá el prefijo.',
  countryCodeInvalid: 'El prefijo tiene de 1 a 3 dígitos, por ejemplo +57.',
  numberRequired: 'Completá el teléfono.',
  numberInvalid: 'Usá sólo números, espacios o guiones (de 4 a 20 caracteres).',
} as const;

// ───────────────────────── Validación ─────────────────────────

export interface GuestIssue {
  readonly path: GuestFieldPath;
  readonly message: string;
}

export type GuestFormCheck =
  | {
      readonly ok: true;
      readonly rooms: readonly HotelBookRoom[];
      readonly contact: HotelBookContact;
    }
  /** `issues` en el orden de la pantalla: el primero es el que recibe el foco. */
  | { readonly ok: false; readonly issues: readonly GuestIssue[] };

/**
 * Todo lo que falta o no cumple, en el orden en que se ve, o el cuerpo de huéspedes y contacto
 * listo para el Book. Los nombres salen como se escribieron (sin bordes): la transliteración la
 * hace el servidor, que guarda el original para el voucher.
 */
export function checkGuestDraft(
  draft: GuestDraft,
  atProperty: { readonly required: boolean; readonly acknowledged: boolean },
): GuestFormCheck {
  const issues: GuestIssue[] = [];
  const seen = new Set<string>();

  draft.rooms.forEach((room, r) => {
    room.guests.forEach((guest, g) => {
      if (guest.title === '') {
        issues.push({ path: guestFieldPath(r, g, 'title'), message: TITLE_REQUIRED });
      }
      const first = guestNameProblem(guest.firstName);
      const last = guestNameProblem(guest.lastName);
      if (first) {
        issues.push({
          path: guestFieldPath(r, g, 'firstName'),
          message: nameMessage('firstName', first),
        });
      }
      if (last) {
        issues.push({
          path: guestFieldPath(r, g, 'lastName'),
          message: nameMessage('lastName', last),
        });
      }
      if (!first && !last) {
        // Se compara lo que sale al proveedor: `José` y `Jose` son el mismo huésped para él.
        const key = `${asciiName(guest.firstName)?.toLowerCase()}\u0000${asciiName(guest.lastName)?.toLowerCase()}`;
        if (seen.has(key)) {
          issues.push({ path: guestFieldPath(r, g, 'lastName'), message: DUPLICATE_GUEST });
        }
        seen.add(key);
      }
    });
  });

  const email = draft.contact.email.trim();
  if (email.length === 0) {
    issues.push({ path: CONTACT_FIELDS.email, message: CONTACT_MESSAGES.emailRequired });
  } else if (email.length > HOTEL_BOOK_LIMITS.maxEmailLength || !EMAIL_RE.test(email)) {
    issues.push({ path: CONTACT_FIELDS.email, message: CONTACT_MESSAGES.emailInvalid });
  }
  const countryCode = draft.contact.phoneCountryCode.replace(/\s+/g, '');
  if (countryCode.length === 0) {
    issues.push({
      path: CONTACT_FIELDS.phoneCountryCode,
      message: CONTACT_MESSAGES.countryCodeRequired,
    });
  } else if (!COUNTRY_CODE_RE.test(countryCode)) {
    issues.push({
      path: CONTACT_FIELDS.phoneCountryCode,
      message: CONTACT_MESSAGES.countryCodeInvalid,
    });
  }
  const number = draft.contact.phoneNumber.trim();
  if (number.length === 0) {
    issues.push({ path: CONTACT_FIELDS.phoneNumber, message: CONTACT_MESSAGES.numberRequired });
  } else if (!PHONE_NUMBER_RE.test(number) || number.replace(/\D/g, '').length < 4) {
    issues.push({ path: CONTACT_FIELDS.phoneNumber, message: CONTACT_MESSAGES.numberInvalid });
  }

  if (atProperty.required && !atProperty.acknowledged) {
    issues.push({ path: AT_PROPERTY_FIELD, message: AT_PROPERTY_REQUIRED });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    rooms: draft.rooms.map((room) => ({
      guests: room.guests.map((guest) => ({
        paxType: guest.paxType,
        title: guest.title as HotelGuestTitle,
        firstName: tidyName(guest.firstName),
        lastName: tidyName(guest.lastName),
      })),
    })),
    contact: {
      email,
      phone: {
        countryCode: countryCode.startsWith('+') ? countryCode : `+${countryCode}`,
        number,
      },
    },
  };
}

export function issuesByPath(issues: readonly GuestIssue[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const issue of issues) out[issue.path] ??= issue.message;
  return out;
}

// ───────────────────────── Lo que rechaza el servidor ─────────────────────────

const GUEST_ISSUE_RE = /^rooms\.(\d+)\.guests\.(\d+)(?:\.(title|firstName|lastName))?:([a-z_]+)$/;

const NAME_PROBLEMS: ReadonlySet<string> = new Set<GuestNameProblem>([
  'required',
  'contains_digits',
  'invalid_characters',
  'too_short',
  'too_long',
]);

/**
 * Los motivos `ruta:código` de un `GUESTS_INVALID` (RF-18) sobre sus campos. Los que no son de un
 * campo (la habitación no cuadra con la búsqueda, el titular no es adulto) no se ubican: los dice
 * el mensaje general del servidor.
 */
export function fieldErrorsFromGuestIssues(
  issues: readonly string[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const m = GUEST_ISSUE_RE.exec(issue);
    if (!m) continue;
    const [, room, guest, field, code] = m;
    const r = Number(room);
    const g = Number(guest);
    if (code === 'duplicate_guest') {
      out[guestFieldPath(r, g, 'lastName')] ??= DUPLICATE_GUEST;
    } else if (field === 'title') {
      out[guestFieldPath(r, g, 'title')] ??= TITLE_REQUIRED;
    } else if ((field === 'firstName' || field === 'lastName') && code && NAME_PROBLEMS.has(code)) {
      out[guestFieldPath(r, g, field)] ??= nameMessage(field, code as GuestNameProblem);
    }
  }
  return out;
}

const FIELD_FALLBACKS: readonly (readonly [RegExp, string])[] = [
  [/^rooms\.\d+\.guests\.\d+\.title$/, TITLE_REQUIRED],
  [/^rooms\.\d+\.guests\.\d+\.firstName$/, 'Revisá el nombre.'],
  [/^rooms\.\d+\.guests\.\d+\.lastName$/, 'Revisá el apellido.'],
  [/^contact\.email$/, CONTACT_MESSAGES.emailInvalid],
  [/^contact\.phone\.countryCode$/, CONTACT_MESSAGES.countryCodeInvalid],
  [/^contact\.phone\.number$/, CONTACT_MESSAGES.numberInvalid],
];

/**
 * Los campos de un 400 de validación del API (`fields[].field`) sobre los del formulario. El
 * texto de esos errores es técnico y en inglés: se reemplaza por el nuestro de cada campo.
 */
export function fieldErrorsFromValidation(fields: unknown): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!Array.isArray(fields)) return out;
  for (const item of fields as unknown[]) {
    const path =
      typeof item === 'object' && item !== null ? (item as { field?: unknown }).field : undefined;
    if (typeof path !== 'string') continue;
    const match = FIELD_FALLBACKS.find(([re]) => re.test(path));
    if (match) out[path] ??= match[1];
  }
  return out;
}

/**
 * Los campos que cambiaron entre dos versiones del formulario: el error que el servidor puso en
 * un campo se va cuando el vendedor lo toca, no antes ni el de otro.
 */
export function changedGuestPaths(prev: GuestDraft, next: GuestDraft): GuestFieldPath[] {
  const out: GuestFieldPath[] = [];
  next.rooms.forEach((room, r) => {
    room.guests.forEach((guest, g) => {
      const before = prev.rooms[r]?.guests[g];
      for (const field of ['title', 'firstName', 'lastName'] as const) {
        if (before?.[field] !== guest[field]) out.push(guestFieldPath(r, g, field));
      }
    });
  });
  if (prev.contact.email !== next.contact.email) out.push(CONTACT_FIELDS.email);
  if (prev.contact.phoneCountryCode !== next.contact.phoneCountryCode) {
    out.push(CONTACT_FIELDS.phoneCountryCode);
  }
  if (prev.contact.phoneNumber !== next.contact.phoneNumber) out.push(CONTACT_FIELDS.phoneNumber);
  return out;
}
