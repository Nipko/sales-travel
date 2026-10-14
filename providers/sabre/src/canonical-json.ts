import { createHash } from 'node:crypto';

/**
 * Serialización canónica de un cuerpo de escritura y su huella: la base de las claves de
 * idempotencia de las operaciones que mueven dinero (`cancelBooking`, `fulfillFlightTickets`).
 *
 * Vive en un módulo propio para que haya UNA sola regla. Dos builders con su copia de la función
 * acaban produciendo claves distintas para el mismo pedido el día que una copia cambia y la otra no,
 * y entonces el saga trata el reintento como una operación nueva.
 */

/** Claves ordenadas en todo el árbol y `undefined` fuera. Misma petición ⇒ mismos bytes. */
export function sabreCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(sabreCanonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${sabreCanonicalJson(entryValue)}`).join(',')}}`;
}

/**
 * `sha256` hexadecimal del cuerpo canónico. Estable entre procesos mientras el cuerpo no lleve
 * relojes ni UUIDs, que es una regla de los builders que lo usan.
 *
 * No es un secreto ni un dato personal —es un hash de identificadores de reserva— pero tampoco hay
 * razón para publicarlo fuera del saga.
 */
export function sabreBodyDigest(body: unknown): string {
  return createHash('sha256').update(sabreCanonicalJson(body)).digest('hex');
}
