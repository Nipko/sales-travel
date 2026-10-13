/*
 * El contacto de soporte de la agencia en Mi Agencia → Marca. Además de ir en vouchers y
 * cotizaciones, es el que el Book de hoteles manda al proveedor (docs/tbo/03 §3.5): sin email y
 * teléfono internacional, propios o heredados del consolidador, el Book rechaza con
 * `AGENCY_CONTACT_MISSING` y el checkout no deja cargar huéspedes. La regla la decide el API
 * (`hotel-booking-contact.ts`); acá sólo se avisa mientras se escribe, sin impedir guardar: un
 * teléfono local sigue sirviendo en los documentos del cliente.
 */

export interface SupportContactFields {
  readonly supportEmail: string | null;
  readonly supportPhone: string | null;
}

/** Lo que un teléfono escrito a mano puede traer además de dígitos. */
const SEPARATORS = /[\s().-]/g;

/** E.164: el prefijo de país y hasta 15 dígitos en total; menos de 7 no es un número de nadie. */
const E164_DIGITS = /^[1-9]\d{6,14}$/;

/** El mismo criterio que `parseInternationalPhone` del API: con `+` y de 7 a 15 dígitos. */
export function isInternationalPhone(raw: string | null): boolean {
  const trimmed = raw?.trim();
  if (trimmed === undefined || !trimmed.startsWith('+')) return false;
  return E164_DIGITS.test(trimmed.slice(1).replace(SEPARATORS, ''));
}

/** El aviso bajo el teléfono, o `undefined` si está vacío (se hereda) o sirve para reservar. */
export function supportPhoneHint(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '' || isInternationalPhone(raw)) return undefined;
  return 'Así no se pueden reservar hoteles: escríbelo con + y el código de país.';
}

/** Lo que se guarda: sin espacios de más, y vacío como `null` para heredar del consolidador. */
export function trimmedSupportContact<T extends SupportContactFields>(branding: T): T {
  const clean = (value: string | null) => {
    const trimmed = value?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
  };
  return {
    ...branding,
    supportEmail: clean(branding.supportEmail),
    supportPhone: clean(branding.supportPhone),
  };
}
