import type { Billing } from './billing';
import { crmDocType, type CrmCustomerType, type PassengerDocType } from './customer-search';

/**
 * Al reservar, los pasajeros y quien factura que no salieron de la búsqueda se guardan en
 * Clientes (`POST /customers/upsert`, que actualiza si ya hay alguien con ese documento). Así la
 * próxima venta los encuentra en «Buscar cliente registrado» en vez de volver a teclearlos.
 *
 * Guardar en Clientes nunca frena la reserva: lo que falle se avisa en una nota.
 */

/** Copia del cuerpo que acepta `CreateCustomerSchema` (`apps/api/src/customers/dto.ts`). */
export interface CustomerUpsertBody {
  readonly customerType: CrmCustomerType;
  readonly firstName: string;
  readonly lastName: string;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly documentIssuingCountry: string;
  readonly email?: string;
  readonly phone?: string;
  readonly birthdate?: string;
  readonly gender?: string;
  readonly nationality?: string;
  readonly passportExpiry?: string;
  readonly address?: string;
  readonly city?: string;
  readonly countryCode?: string;
}

/** Lo que el plan necesita de cada pasajero de la reserva. */
export interface CrmPassenger {
  readonly label: string;
  readonly givenName: string;
  readonly surname: string;
  readonly birthdate: string;
  readonly gender: 'M' | 'F';
  readonly citizenshipCountryCode: string;
  readonly identityDoc: {
    readonly type: PassengerDocType;
    readonly number: string;
    readonly issuingCountryCode: string;
    readonly expiryDate?: string;
  };
}

export type CrmUpsertRole =
  | { readonly kind: 'passenger'; readonly index: number }
  | { readonly kind: 'biller' };

export interface CrmUpsertItem {
  readonly label: string;
  readonly role: CrmUpsertRole;
  readonly body: CustomerUpsertBody;
}

export interface CrmUpsertPlan {
  readonly items: readonly CrmUpsertItem[];
  /** Quien no se puede guardar, con el porqué, para la nota. */
  readonly skipped: readonly string[];
}

export const BILLER_LABEL = 'quien factura';

function docKey(type: string, number: string): string {
  return `${type.trim().toUpperCase()}|${number.trim().toUpperCase()}`;
}

function optional<K extends string>(
  key: K,
  value: string | null | undefined,
): Partial<Record<K, string>> {
  const v = value?.trim();
  return v ? ({ [key]: v } as Record<K, string>) : {};
}

/**
 * A quién guardar en Clientes. Sólo a los que no vinieron del CRM, una vez por documento, y nunca
 * si el vendedor desmarcó «Guardar pasajeros y facturador en Clientes».
 *
 * Una persona que factura sin viajar no se puede guardar: Clientes exige a una persona fecha de
 * nacimiento, género y nacionalidad —los datos del billete— y «Facturación» no los pide.
 */
export function crmUpsertPlan(input: {
  readonly enabled: boolean;
  readonly passengers: readonly CrmPassenger[];
  /** Por pasajero, el cliente del CRM del que salió (o `null` si se tecleó). */
  readonly customerIds: readonly (string | null)[];
  readonly billing: Billing | null;
}): CrmUpsertPlan {
  if (!input.enabled) return { items: [], skipped: [] };
  const items: CrmUpsertItem[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const billing = input.billing;

  input.passengers.forEach((p, index) => {
    const type = crmDocType(p.identityDoc.type);
    const key = docKey(type, p.identityDoc.number);
    if (input.customerIds[index]) {
      seen.add(key);
      return;
    }
    if (seen.has(key) || !p.identityDoc.number.trim()) return;
    seen.add(key);
    // El pasajero 1 que factura deja en su ficha el correo, el teléfono y la dirección.
    const contact = index === 0 && billing?.mode === 'passenger' ? billing : null;
    items.push({
      label: p.label,
      role: { kind: 'passenger', index },
      body: {
        customerType: 'person',
        firstName: p.givenName.trim(),
        lastName: p.surname.trim(),
        documentType: type,
        documentNumber: p.identityDoc.number.trim(),
        documentIssuingCountry: p.identityDoc.issuingCountryCode.trim() || p.citizenshipCountryCode,
        birthdate: p.birthdate,
        gender: p.gender,
        nationality: p.citizenshipCountryCode.trim(),
        ...optional(
          'passportExpiry',
          p.identityDoc.type === 'P' ? p.identityDoc.expiryDate : undefined,
        ),
        ...optional('email', contact?.email),
        ...optional('phone', contact?.phone),
        ...optional('address', contact?.address),
        ...optional('city', contact?.city),
        ...optional('countryCode', contact?.countryCode),
      },
    });
  });

  if (billing?.mode === 'other' && !billing.customerId) {
    const key = docKey(billing.documentType, billing.documentNumber);
    if (seen.has(key)) {
      // Factura uno de los pasajeros con su mismo documento: ya está en el plan (o en el CRM).
    } else if (billing.customerType === 'person') {
      skipped.push(BILLER_LABEL);
    } else {
      const country = billing.countryCode ?? input.passengers[0]?.identityDoc.issuingCountryCode;
      items.push({
        label: BILLER_LABEL,
        role: { kind: 'biller' },
        body: {
          customerType: 'company',
          firstName: billing.name,
          lastName: '',
          documentType: billing.documentType,
          documentNumber: billing.documentNumber,
          documentIssuingCountry: country?.trim() || 'CO',
          email: billing.email,
          phone: billing.phone,
          ...optional('address', billing.address),
          ...optional('city', billing.city),
          ...optional('countryCode', billing.countryCode),
        },
      });
    }
  }
  return { items, skipped };
}

/** `{ customer: { id } }` → el id, o `null` si la respuesta no se entiende. */
export function upsertedCustomerId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const customer = (body as Record<string, unknown>)['customer'];
  if (typeof customer !== 'object' || customer === null) return null;
  const id = (customer as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * La facturación con el cliente recién guardado: así la cotización queda apuntando a su ficha.
 * `results[i]` es el id que devolvió `items[i]`, o `null` si falló.
 */
export function billingWithSavedCustomer(
  billing: Billing | null,
  plan: CrmUpsertPlan,
  results: readonly (string | null)[],
): Billing | null {
  if (billing === null || billing.customerId) return billing;
  const index = plan.items.findIndex((item) =>
    billing.mode === 'passenger'
      ? item.role.kind === 'passenger' && item.role.index === 0
      : item.role.kind === 'biller',
  );
  const id = index >= 0 ? results[index] : null;
  return id ? { ...billing, customerId: id } : billing;
}

/**
 * La nota que queda junto al resultado de la reserva. `null` si no hay nada que contar (nada que
 * guardar). No es un error: la reserva salió igual.
 */
export function crmSaveNote(
  plan: CrmUpsertPlan,
  results: readonly (string | null)[],
): string | null {
  const saved = plan.items.filter((_, i) => results[i]).length;
  const failed = plan.items.filter((_, i) => !results[i]).map((item) => item.label);
  const lines: string[] = [];
  if (saved > 0)
    lines.push(
      saved === 1
        ? 'Se guardó 1 persona en Clientes.'
        : `Se guardaron ${saved} personas en Clientes.`,
    );
  if (failed.length > 0) {
    lines.push(
      `No se pudo guardar en Clientes a: ${failed.join(', ')}. Puedes agregarlos desde Clientes.`,
    );
  }
  if (plan.skipped.length > 0) {
    lines.push(
      'Quien factura no se guardó en Clientes: para una persona, Clientes pide fecha de nacimiento, género y nacionalidad. Puedes agregarla desde Clientes.',
    );
  }
  return lines.length > 0 ? lines.join(' ') : null;
}
