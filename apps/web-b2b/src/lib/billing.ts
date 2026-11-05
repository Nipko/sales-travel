import { toCountryAlpha2 } from './countries';
import {
  crmCustomerName,
  crmDocType,
  type CrmCustomer,
  type CrmCustomerType,
  type PassengerDocType,
} from './customer-search';

/**
 * «Facturación» de una cotización de vuelos (0091): a nombre de quién sale la factura.
 *
 * Puede ser el pasajero 1 —el caso más común: viaja y paga la misma persona— u otra persona o
 * empresa. Pide los datos fiscales que exige la factura electrónica (nombre o razón social, tipo y
 * número de documento, correo, teléfono y, opcional, dirección, ciudad y país). El correo y el
 * teléfono de quien factura son también el contacto de la reserva y a donde se envía la
 * cotización: por eso se reflejan en `customerName/Email/Phone` de la cotización.
 *
 * La forma de `Billing` es una COPIA de `BillingSchema` (`apps/api/src/quotations/billing.ts`):
 * web-b2b no importa paquetes del API. El API vuelve a validar todo.
 */

export type BillingMode = 'passenger' | 'other';

export const BILLING_DOC_TYPES = [
  { value: 'CC', label: 'Cédula (CC)' },
  { value: 'CE', label: 'Cédula de extranjería (CE)' },
  { value: 'NIT', label: 'NIT' },
  { value: 'PASAPORTE', label: 'Pasaporte' },
] as const;

/** Lo que se teclea en «Facturación». Todo texto: un `<input>` controlado no admite `null`. */
export interface BillingDraft {
  readonly mode: BillingMode;
  /** Cliente del CRM elegido en la búsqueda de «Otra persona o empresa». */
  readonly customerId: string | null;
  readonly customerType: CrmCustomerType;
  readonly name: string;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
  readonly city: string;
  readonly countryCode: string;
}

/** Lo que viaja a `PATCH /quotations/:id/customer` como `billing`. */
export interface Billing {
  readonly mode: BillingMode;
  readonly customerId: string | null;
  readonly customerType: CrmCustomerType;
  readonly name: string;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
}

/** Lo que «Facturación» necesita del pasajero 1 cuando factura él. */
export interface BillingPassenger {
  readonly givenName: string;
  readonly surname: string;
  readonly identityDoc: {
    readonly type: PassengerDocType;
    readonly number: string;
    readonly issuingCountryCode: string;
  };
}

export type BillingField = 'name' | 'documentNumber' | 'email' | 'phone' | 'countryCode';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function emptyBillingDraft(): BillingDraft {
  return {
    mode: 'passenger',
    customerId: null,
    customerType: 'person',
    name: '',
    documentType: 'CC',
    documentNumber: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    countryCode: '',
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Lo guardado en la cotización → el borrador de la pantalla.
 *
 * Una cotización de antes de «Facturación» sólo tiene nombre, correo y teléfono del cliente: se
 * abre como «Otra persona o empresa» con esos tres datos, porque nada dice que el cliente viaje.
 * Sin nada guardado, se arranca con el pasajero 1, que es el caso más común.
 */
export function billingDraftFromQuotation(
  billing: unknown,
  legacy: {
    readonly customerName: string | null;
    readonly customerEmail: string | null;
    readonly customerPhone: string | null;
  },
): BillingDraft {
  const empty = emptyBillingDraft();
  if (typeof billing === 'object' && billing !== null && !Array.isArray(billing)) {
    const b = billing as Record<string, unknown>;
    const customerId = str(b['customerId']);
    return {
      mode: b['mode'] === 'other' ? 'other' : 'passenger',
      customerId: UUID_RE.test(customerId) ? customerId : null,
      customerType: b['customerType'] === 'company' ? 'company' : 'person',
      name: str(b['name']),
      documentType: str(b['documentType']) || empty.documentType,
      documentNumber: str(b['documentNumber']),
      email: str(b['email']),
      phone: str(b['phone']),
      address: str(b['address']),
      city: str(b['city']),
      countryCode: str(b['countryCode']),
    };
  }
  const name = legacy.customerName?.trim() ?? '';
  const email = legacy.customerEmail?.trim() ?? '';
  const phone = legacy.customerPhone?.trim() ?? '';
  if (!name && !email && !phone) return empty;
  return { ...empty, mode: 'other', name, email, phone };
}

/** Tipo de documento del CRM → el de la factura (el pasaporte se nombra con la palabra entera). */
export function billingDocType(crmType: string): string {
  const t = crmType.trim().toUpperCase();
  if (t === 'P' || t === 'PASSPORT') return 'PASAPORTE';
  return t;
}

/**
 * Elegir a alguien registrado en «Otra persona o empresa». El correo y el teléfono de la ficha
 * reemplazan a los tecleados sólo si la ficha los tiene.
 */
export function billingDraftFromCustomer(draft: BillingDraft, c: CrmCustomer): BillingDraft {
  return {
    ...draft,
    mode: 'other',
    customerId: c.id,
    customerType: c.customerType,
    name: crmCustomerName(c),
    documentType: billingDocType(c.documentType),
    documentNumber: c.documentNumber,
    email: c.email ?? draft.email,
    phone: c.phone ?? draft.phone,
    address: c.address ?? '',
    city: c.city ?? '',
    countryCode: (c.countryCode && toCountryAlpha2(c.countryCode)) ?? '',
  };
}

function passengerFullName(p: BillingPassenger | undefined): string {
  return p === undefined ? '' : [p.givenName.trim(), p.surname.trim()].filter(Boolean).join(' ');
}

/** «Pasajero 1 (Ana Ruiz)», o sólo «Pasajero 1» mientras no tiene nombre. */
export function passengerBillingLabel(p: BillingPassenger | undefined): string {
  const name = passengerFullName(p);
  return name ? `Pasajero 1 (${name})` : 'Pasajero 1';
}

/** El nombre y documento que de verdad van en la factura, según el modo. */
export function billingIdentity(
  draft: BillingDraft,
  passenger1: BillingPassenger | undefined,
): { name: string; documentType: string; documentNumber: string; countryCode: string } {
  if (draft.mode === 'passenger') {
    return {
      name: passengerFullName(passenger1),
      documentType: passenger1 ? crmDocType(passenger1.identityDoc.type) : 'CC',
      documentNumber: passenger1?.identityDoc.number.trim() ?? '',
      // El país, si no se escribe, es el que emitió el documento del pasajero.
      countryCode: draft.countryCode.trim() || (passenger1?.identityDoc.issuingCountryCode ?? ''),
    };
  }
  return {
    name: draft.name.trim(),
    documentType: draft.documentType,
    documentNumber: draft.documentNumber.trim(),
    countryCode: draft.countryCode.trim(),
  };
}

export interface ResolvedBilling {
  /** `null` mientras falte algo: la factura no se guarda a medias. */
  readonly billing: Billing | null;
  readonly missing: readonly BillingField[];
}

/**
 * Borrador → la facturación que se guarda, o qué le falta. Mismos mínimos que `BillingSchema`
 * del API, para no mandar algo que va a rechazar.
 */
export function resolveBilling(
  draft: BillingDraft,
  passenger1: BillingPassenger | undefined,
  passenger1CustomerId: string | null = null,
): ResolvedBilling {
  const id = billingIdentity(draft, passenger1);
  const email = draft.email.trim();
  const phone = draft.phone.trim();
  const country = id.countryCode ? toCountryAlpha2(id.countryCode) : undefined;
  const missing: BillingField[] = [];
  if (id.name.length < 2) missing.push('name');
  if (id.documentNumber.length < 3) missing.push('documentNumber');
  if (!isValidEmail(email)) missing.push('email');
  if (phone.length < 5) missing.push('phone');
  // El país es opcional, pero uno escrito tiene que ser un código ISO de dos letras.
  if (draft.countryCode.trim() && country === undefined) missing.push('countryCode');
  if (missing.length > 0) return { billing: null, missing };
  return {
    billing: {
      mode: draft.mode,
      customerId: draft.mode === 'passenger' ? passenger1CustomerId : draft.customerId,
      customerType: draft.mode === 'passenger' ? 'person' : draft.customerType,
      name: id.name,
      documentType: id.documentType,
      documentNumber: id.documentNumber,
      email,
      phone,
      address: draft.address.trim() || null,
      city: draft.city.trim() || null,
      countryCode: country ?? null,
    },
    missing: [],
  };
}

const FIELD_LABELS: Record<BillingField, string> = {
  name: 'nombre o razón social',
  documentNumber: 'número de documento',
  email: 'email válido',
  phone: 'teléfono',
  countryCode: 'país (código de dos letras, p. ej. CO)',
};

/**
 * Lo que falta en «Facturación», en una línea para el resumen junto a «Crear reserva». Con el
 * pasajero 1 como facturador, su nombre y documento ya los reclama la ficha del pasajero.
 */
export function billingProblems(
  mode: BillingMode,
  missing: readonly BillingField[],
): readonly string[] {
  const own =
    mode === 'passenger'
      ? missing.filter((f) => f === 'email' || f === 'phone' || f === 'countryCode')
      : missing;
  if (own.length === 0) return [];
  return [`Facturación: completa ${describeMissing(own)}.`];
}

/** «email válido, teléfono»: los campos que faltan, en minúscula y separados por coma. */
export function describeMissing(missing: readonly BillingField[]): string {
  return missing.map((f) => FIELD_LABELS[f]).join(', ');
}

/** El cuerpo de `PATCH /quotations/:id/customer`. */
export interface QuotationCustomerPatch {
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly customerPhone: string | null;
  readonly notes: string | null;
  /** Ausente = el API no toca la facturación guardada. */
  readonly billing?: Billing;
}

/**
 * Lo que guarda «Guardar». El nombre, correo y teléfono del cliente de la cotización son los de
 * quien factura: los usan «Enviar por email» y «Enviar por WhatsApp». La facturación sólo viaja
 * completa; a medias se guarda el contacto y se dice qué falta.
 */
export function quotationCustomerPatch(
  draft: BillingDraft,
  passenger1: BillingPassenger | undefined,
  notes: string,
  passenger1CustomerId: string | null = null,
): { patch: QuotationCustomerPatch; missing: readonly BillingField[] } {
  const { billing, missing } = resolveBilling(draft, passenger1, passenger1CustomerId);
  const name = billingIdentity(draft, passenger1).name;
  const email = draft.email.trim();
  const phone = draft.phone.trim();
  return {
    patch: {
      customerName: name || null,
      // El API rechaza un correo mal escrito: mejor no tocarlo que fallar el guardado entero.
      customerEmail: isValidEmail(email) ? email : null,
      customerPhone: phone || null,
      notes: notes.trim() || null,
      ...(billing !== null ? { billing } : {}),
    },
    missing,
  };
}
