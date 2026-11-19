/**
 * Prefijo telefónico del contacto de una reserva de vuelo.
 *
 * Antes salía siempre `+57` y área `1`: una agencia de Perú o Brasil le mandaba a la aerolínea un
 * teléfono colombiano que nadie contesta. El prefijo arranca con el del país de la agencia y el
 * vendedor lo cambia si el cliente es de otro lado. El código de área no se pide: un celular no
 * lo tiene, y LATAM lo trata como opcional.
 */

/** Prefijo (sin `+`) por país ISO alfa-2. Sólo los que la región usa; el resto arranca vacío. */
const DIAL_CODES: Readonly<Record<string, string>> = Object.freeze({
  AR: '54',
  BO: '591',
  BR: '55',
  CA: '1',
  CL: '56',
  CO: '57',
  CR: '506',
  CU: '53',
  DO: '1',
  EC: '593',
  ES: '34',
  GT: '502',
  HN: '504',
  MX: '52',
  NI: '505',
  PA: '507',
  PE: '51',
  PR: '1',
  PT: '351',
  PY: '595',
  SV: '503',
  US: '1',
  UY: '598',
  VE: '58',
});

/**
 * Con qué prefijo arranca el campo. Si la agencia no tiene país (o no está en la tabla) se queda en
 * `+57`, lo que se mandaba antes, pero ahora a la vista y editable.
 */
export const FALLBACK_DIAL_CODE = '57';

export function dialCodeForCountry(countryCode: string | null | undefined): string {
  const code = (countryCode ?? '').trim().toUpperCase();
  return DIAL_CODES[code] ?? FALLBACK_DIAL_CODE;
}

const DIAL_CODE_RE = /^\d{1,3}$/;

/** Lo que tecleó el vendedor (`+51`, `51`, ` + 51 `) → `51`; `undefined` si no es un prefijo. */
export function normalizeDialCode(input: string): string | undefined {
  const digits = input.trim().replace(/^\+/, '').replace(/\s+/g, '');
  return DIAL_CODE_RE.test(digits) ? digits : undefined;
}

export interface FlightContactPhone {
  readonly phone: string;
  readonly countryDialingCode: string;
}

/**
 * El teléfono como lo espera `POST /orders`: el número aparte del prefijo. Si el vendedor pegó el
 * número con su `+prefijo` delante, se le quita para no mandarlo dos veces.
 */
export function flightContactPhone(dialCode: string, phone: string): FlightContactPhone {
  const trimmed = phone.trim();
  const withPlus = `+${dialCode}`;
  const number = trimmed.startsWith(withPlus) ? trimmed.slice(withPlus.length).trim() : trimmed;
  return { phone: number, countryDialingCode: dialCode };
}

/**
 * Los dígitos para `wa.me`, que pide el número internacional sin `+`: sin el prefijo, el enlace
 * abría un chat con un número que no existe. Un número escrito con `+` ya es internacional.
 */
export function whatsappDigits(dialCode: string | undefined, phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (phone.trim().startsWith('+') || !dialCode) return digits;
  return `${dialCode}${digits}`;
}
