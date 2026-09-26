import type { HotelBookingContact } from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import type { SupportContact } from '../branding/branding.service.js';

/**
 * El contacto que viaja al proveedor en el Book de una reserva con órdenes (docs/tbo/03 §3.5;
 * D-TBO-23 A, contacto operativo de la agencia).
 *
 * Es el de soporte de la agencia que vende, con la herencia de marca de 0030: si no lo configuró,
 * el de su consolidador. El del huésped NO sale: queda en `orders.contact_info`. Con marca blanca,
 * mandarlo dejaría al cliente final expuesto al proveedor y al hotel.
 *
 * Sin email válido o sin teléfono en formato internacional no hay contacto que mandar, y no se
 * inventa ni se toma el del huésped: la reserva se rechaza antes de abrir la orden.
 */

const EmailSchema = z.string().trim().min(3).max(254).email();

/** Lo que un teléfono escrito a mano puede traer además de dígitos. */
const SEPARATORS = /[\s().-]/g;

/** E.164: hasta 15 dígitos con el prefijo de país; menos de 7 no es un número de nadie. */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/**
 * Prefijos de país de dos dígitos (UIT-T E.164). Los prefijos son libres de prefijo: `1` y `7` son
 * de un dígito, éstos de dos y todo lo demás de tres. El proveedor recibe los dígitos juntos; el
 * corte sólo existe porque el contrato neutral separa el prefijo del número.
 */
const TWO_DIGIT_COUNTRY_CODES: ReadonlySet<string> = new Set([
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
]);

function countryCodeLength(digits: string): number {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1;
  return TWO_DIGIT_COUNTRY_CODES.has(digits.slice(0, 2)) ? 2 : 3;
}

/**
 * Un teléfono en formato internacional (`+57 300 123 4567`) → prefijo y número. Sin `+` no se
 * sabe de qué país es, y adivinarlo por el país de la agencia mandaría el número de otro.
 */
export function parseInternationalPhone(
  raw: string | null,
): HotelBookingContact['phone'] | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || !trimmed.startsWith('+')) return undefined;
  const digits = trimmed.slice(1).replace(SEPARATORS, '');
  if (!/^[1-9]\d*$/.test(digits) || digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    return undefined;
  }
  const cut = countryCodeLength(digits);
  return { countryCode: digits.slice(0, cut), number: digits.slice(cut) };
}

/** El contacto operativo de la agencia, o `undefined` si no tiene email y teléfono utilizables. */
export function agencyBookingContact(support: SupportContact): HotelBookingContact | undefined {
  const email = EmailSchema.safeParse(support.email ?? '');
  const phone = parseInternationalPhone(support.phone);
  if (!email.success || phone === undefined) return undefined;
  return { email: email.data, phone };
}
