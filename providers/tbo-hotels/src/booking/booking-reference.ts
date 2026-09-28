import { randomBytes } from 'node:crypto';
import { TBO_ENVIRONMENTS, type TboEnvironment } from '../config';
import { TboConfigError } from '../errors';

/**
 * Referencias de una reserva de TBO (docs/tbo/03 §3.3; 08 RF-19; BK-03).
 *
 * `BookingReferenceId` y `ClientReferenceId` los genera el cliente (p. 33) y el contrato no dice ni
 * su formato ni su alcance de unicidad: "Unique booking reference ID" (p. 43), pero el mismo valor se
 * repite en dos ejemplos (p. 37, 40) (Q-34). Es la única clave con la que se puede preguntar por un
 * Book cuya respuesta no llegó ("mandatory to call the BookingDetail method by using
 * BookingReferenceId", p. 42), así que:
 *
 * - **Se genera en el servidor con un generador criptográfico**, nunca desde el `Idempotency-Key`
 *   del navegador: ése es único por tenant, y las sub-agencias que heredan la cuenta del
 *   consolidador comparten cuenta TBO. El índice único entre tenants lo pone la base (PR-4.3).
 * - **Uno por request de Book y nunca se reutiliza**: si una verificación concluye que no hubo
 *   reserva, el nuevo intento lleva otra referencia. Reusarla dependería de una idempotencia que TBO
 *   no documenta (Q-35).
 * - **Formato**: `ST` + un carácter de entorno (`T` test y certificación, `P` producción) + 17
 *   caracteres Crockford base32, 85 bits aleatorios. 20 caracteres, sólo `[0-9A-Z]` y sin `I`, `L`,
 *   `O` ni `U`: nada que se confunda al dictarlo por teléfono ni que TBO pueda rechazar por largo o
 *   por caracteres (los ejemplos llegan a 24, p. 35).
 * - `ClientReferenceId` lleva el MISMO valor: es la única referencia nuestra que vuelve en la
 *   conciliación por fecha (`ClientReferenceNumber`, p. 64). Si TBO exige que difieran, pasa a ser
 *   este valor con el sufijo `C` (Q-34).
 *
 * El número de confirmación de TBO vive aquí también porque es la otra referencia de la reserva:
 * lo emite TBO en el Book (p. 40) y con él se lee y se cancela.
 */

/** Crockford base32 (sin `I`, `L`, `O` ni `U`), en orden de valor. */
export const TBO_BOOKING_REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const PREFIX = 'ST';
const RANDOM_CHARS = 17;
const BITS_PER_CHAR = 5;
const RANDOM_BITS = RANDOM_CHARS * BITS_PER_CHAR;
/** Bytes que se piden al generador: 88 bits, de los que se usan los 85 más altos. */
const RANDOM_BYTES = Math.ceil(RANDOM_BITS / 8);

const ENVIRONMENT_CHAR: Readonly<Record<TboEnvironment, string>> = Object.freeze({
  test: 'T',
  live: 'P',
});

/** Forma exacta de una referencia nuestra. El builder de Book y el de BookingDetail la exigen. */
export const TBO_BOOKING_REFERENCE_PATTERN = /^ST[TP][0-9A-HJKMNP-TV-Z]{17}$/;

/**
 * Forma aceptada de un `ConfirmationNumber` de TBO. El contrato no la documenta (p. 40, 43); los
 * ejemplos son seis alfanuméricos (`FL1IMA`, `YOSUR8`; Postman: `KOI5G4`). Se acepta algo más ancho
 * para no rechazar un localizador real por una suposición, pero nada que no sea un identificador:
 * sin espacios, sin puntuación y con techo.
 */
export const TBO_CONFIRMATION_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Fuente de bytes aleatorios. Por defecto `crypto.randomBytes`; se inyecta sólo en los tests. */
export type TboRandomBytes = (size: number) => Uint8Array;

/**
 * Una referencia nueva para UN request de Book. Lanza `TboConfigError` si el entorno no es de TBO o
 * si el generador inyectado no entrega los bytes pedidos: una referencia con menos entropía de la
 * declarada no se completa con ceros.
 */
export function generateTboBookingReference(
  environment: TboEnvironment,
  random: TboRandomBytes = randomBytes,
): string {
  const environmentChar: unknown = (TBO_ENVIRONMENTS as readonly string[]).includes(environment)
    ? ENVIRONMENT_CHAR[environment]
    : undefined;
  if (typeof environmentChar !== 'string') {
    throw new TboConfigError(['environment:invalid_enum_value']);
  }
  const bytes: unknown = random(RANDOM_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length < RANDOM_BYTES) {
    throw new TboConfigError(['random:insufficient_bytes']);
  }

  let value = 0n;
  for (const byte of bytes.subarray(0, RANDOM_BYTES)) value = (value << 8n) | BigInt(byte);
  value >>= BigInt(RANDOM_BYTES * 8 - RANDOM_BITS);

  let body = '';
  for (let index = RANDOM_CHARS - 1; index >= 0; index -= 1) {
    const symbol = Number((value >> BigInt(index * BITS_PER_CHAR)) & 31n);
    body += TBO_BOOKING_REFERENCE_ALPHABET.charAt(symbol);
  }
  return `${PREFIX}${environmentChar}${body}`;
}

export function isTboBookingReference(value: unknown): value is string {
  return typeof value === 'string' && TBO_BOOKING_REFERENCE_PATTERN.test(value);
}

/**
 * Entorno en el que se generó una referencia. Una referencia de producción no se manda a la cuenta
 * de test ni al revés: mezclarlas es cómo una prueba termina conciliándose contra una reserva real.
 */
export function tboBookingReferenceEnvironment(reference: string): TboEnvironment | undefined {
  if (!isTboBookingReference(reference)) return undefined;
  return reference.charAt(PREFIX.length) === ENVIRONMENT_CHAR.live ? 'live' : 'test';
}

export function isTboConfirmationNumber(value: unknown): value is string {
  return typeof value === 'string' && TBO_CONFIRMATION_NUMBER_PATTERN.test(value);
}
