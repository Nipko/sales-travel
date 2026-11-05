import { toCountryAlpha2 } from './countries';

/**
 * Clientes registrados (CRM) tal como los usa el checkout de vuelos: buscarlos desde la ficha de
 * un pasajero o desde «Facturación» y volcar sus datos en el formulario.
 *
 * El API (`GET /customers/search`) devuelve la ficha completa. Acá se lee campo por campo y lo
 * que no tiene la forma esperada se descarta: una fila rota no debe tumbar el desplegable.
 */

export type CrmCustomerType = 'person' | 'company';

export interface CrmCustomer {
  readonly id: string;
  readonly customerType: CrmCustomerType;
  /** En una empresa, la razón social entera. */
  readonly firstName: string;
  /** En una empresa va vacío. */
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly documentIssuingCountry: string | null;
  readonly birthdate: string | null;
  readonly gender: string | null;
  readonly nationality: string | null;
  readonly passportExpiry: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
}

/** Lo mínimo que hay que teclear antes de buscar (el API exige lo mismo). */
export const CUSTOMER_SEARCH_MIN_CHARS = 2;
export const CUSTOMER_SEARCH_MAX_CHARS = 120;
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;
export const CUSTOMER_SEARCH_LIMIT = 8;

/** El texto a buscar, o `null` si todavía no alcanza para buscar. */
export function customerSearchTerm(raw: string): string | null {
  const term = raw.trim().replace(/\s+/g, ' ');
  if (term.length < CUSTOMER_SEARCH_MIN_CHARS) return null;
  return term.slice(0, CUSTOMER_SEARCH_MAX_CHARS);
}

/** La URL del proxy del panel para un término ya normalizado. */
export function customerSearchUrl(term: string, limit = CUSTOMER_SEARCH_LIMIT): string {
  return `/api/customers/search?q=${encodeURIComponent(term)}&limit=${limit}`;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Una fila del API → cliente, o `null` si le falta lo indispensable (id, nombre, documento). */
export function parseCrmCustomer(raw: unknown): CrmCustomer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = text(r['id']);
  const firstName = text(r['firstName']);
  const documentType = text(r['documentType']);
  const documentNumber = text(r['documentNumber']);
  if (id === null || firstName === null || documentType === null || documentNumber === null) {
    return null;
  }
  return {
    id,
    customerType: r['customerType'] === 'company' ? 'company' : 'person',
    firstName,
    lastName: text(r['lastName']) ?? '',
    email: text(r['email']),
    phone: text(r['phone']),
    documentType,
    documentNumber,
    documentIssuingCountry: text(r['documentIssuingCountry']),
    birthdate: text(r['birthdate']),
    gender: text(r['gender']),
    nationality: text(r['nationality']),
    passportExpiry: text(r['passportExpiry']),
    address: text(r['address']),
    city: text(r['city']),
    countryCode: text(r['countryCode']),
  };
}

/** `{ customers: [...] }` → los clientes legibles. Cualquier otra forma es «sin resultados». */
export function parseCustomerSearchResponse(body: unknown): CrmCustomer[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as Record<string, unknown>)['customers'];
  if (!Array.isArray(list)) return [];
  return list.map(parseCrmCustomer).filter((c): c is CrmCustomer => c !== null);
}

/** Nombre completo o razón social. */
export function crmCustomerName(c: CrmCustomer): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}

/** Tipo de documento del CRM legible: `PASAPORTE` → «Pasaporte». */
export function documentTypeLabel(type: string): string {
  const t = type.trim().toUpperCase();
  if (t === 'P' || t === 'PASAPORTE' || t === 'PASSPORT') return 'Pasaporte';
  return t;
}

/** La segunda línea de una opción: documento y correo, para distinguir homónimos. */
export function crmCustomerDetail(c: CrmCustomer): string {
  const parts = [`${documentTypeLabel(c.documentType)} ${c.documentNumber}`];
  if (c.customerType === 'company') parts.unshift('Empresa');
  if (c.email) parts.push(c.email);
  return parts.join(' · ');
}

// ---- Cliente → pasajero ----

export type PassengerDocType = 'P' | 'DNI' | 'CC' | 'CE';

/** Lo que una ficha del CRM le puede dar a un pasajero de la reserva. */
export interface PassengerFill {
  readonly givenName: string;
  readonly surname: string;
  readonly birthdate?: string;
  readonly gender?: 'M' | 'F';
  readonly citizenshipCountryCode?: string;
  readonly identityDoc: {
    readonly type: PassengerDocType;
    readonly number: string;
    readonly issuingCountryCode?: string;
    readonly expiryDate?: string;
  };
}

/** Documento del CRM (`PASAPORTE`, `CC`, …) → el del billete. `null` si el billete no lo admite. */
export function passengerDocType(crmType: string): PassengerDocType | null {
  const t = crmType.trim().toUpperCase();
  if (t === 'P' || t === 'PASAPORTE' || t === 'PASSPORT') return 'P';
  if (t === 'CC' || t === 'CE' || t === 'DNI') return t;
  return null;
}

/** Documento del billete → el del CRM, que nombra el pasaporte con la palabra entera. */
export function crmDocType(type: PassengerDocType): string {
  return type === 'P' ? 'PASAPORTE' : type;
}

/** `YYYY-MM-DD` de una fecha que el CRM puede guardar como ISO completo. */
function isoDay(value: string | null): string | undefined {
  if (value === null) return undefined;
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  return day !== undefined && !Number.isNaN(Date.parse(day)) ? day : undefined;
}

function genderOf(value: string | null): 'M' | 'F' | undefined {
  const g = (value ?? '').trim().toUpperCase();
  if (g === 'F' || g === 'FEMENINO' || g === 'FEMALE') return 'F';
  if (g === 'M' || g === 'MASCULINO' || g === 'MALE') return 'M';
  return undefined;
}

function country(value: string | null): string | undefined {
  return value === null ? undefined : toCountryAlpha2(value);
}

/**
 * Los datos del billete que salen de una ficha del CRM. Lo que la ficha no trae (o trae en un
 * formato que no se entiende) queda fuera, para que el formulario conserve lo que ya tenía.
 */
export function passengerFromCustomer(c: CrmCustomer): PassengerFill {
  const birthdate = isoDay(c.birthdate);
  const gender = genderOf(c.gender);
  const nationality = country(c.nationality);
  const issuing = country(c.documentIssuingCountry);
  const docType = passengerDocType(c.documentType);
  const expiry = docType === 'P' ? isoDay(c.passportExpiry) : undefined;
  return {
    givenName: c.firstName,
    surname: c.lastName,
    ...(birthdate !== undefined ? { birthdate } : {}),
    ...(gender !== undefined ? { gender } : {}),
    ...(nationality !== undefined ? { citizenshipCountryCode: nationality } : {}),
    identityDoc: {
      type: docType ?? 'CC',
      number: c.documentNumber,
      ...(issuing !== undefined ? { issuingCountryCode: issuing } : {}),
      ...(expiry !== undefined ? { expiryDate: expiry } : {}),
    },
  };
}

/** Un pasajero sólo puede ser una persona: las empresas no salen en su búsqueda. */
export function isTravelerCandidate(c: CrmCustomer): boolean {
  return c.customerType === 'person';
}

/**
 * El vínculo con la ficha del CRM se mantiene mientras el número de documento sea el de la ficha
 * elegida: corregir una letra del nombre no lo rompe, pero cambiar el documento es otra persona.
 */
export interface CrmLink {
  readonly customerId: string;
  readonly documentNumber: string;
}

export function linkedCustomerId(
  link: CrmLink | undefined,
  currentDocumentNumber: string,
): string | null {
  if (link === undefined) return null;
  return link.documentNumber.trim() === currentDocumentNumber.trim() ? link.customerId : null;
}
