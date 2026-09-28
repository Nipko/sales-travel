import { TBO_OPERATIONS } from '../http/operations';

/**
 * Ventana de Search a Book (docs/tbo/01 §6.3; 08 RF-09 y §9 C-17).
 *
 * El contrato sólo dice "from search to book, the timeout is 30 minutes" (p. 8), sin decir si el
 * reloj arranca al enviar o al responder ni si PreBook lo renueva (Q-29). Se toma el instante más
 * temprano posible —cuando ENVIAMOS el Search— y se descuentan el Book más largo que admite la
 * tabla y un margen: un Book que empieza en el minuto 29 puede terminar fuera de la ventana y
 * dejar una reserva de la que no sabemos nada.
 */

/** "from search to book, the timeout is 30 minutes" (p. 8). */
export const TBO_SEARCH_TO_BOOK_WINDOW_MS = 30 * 60_000;

/** Margen sobre el Book más largo: relojes, colas y el propio PreBook. INFERIDO. */
export const TBO_OFFER_SAFETY_MARGIN_MS = 60_000;

/**
 * Vida útil visible de una oferta de TBO: 30 min − 120 s de Book − 60 s = 27 min. El Book sale de
 * la tabla de operaciones y no de un literal: si alguien cambia su timeout, la ventana lo acompaña.
 */
export const TBO_OFFER_TTL_MS =
  TBO_SEARCH_TO_BOOK_WINDOW_MS - TBO_OPERATIONS.book.timeoutMs - TBO_OFFER_SAFETY_MARGIN_MS;

/**
 * `expiresAt` de todo pack de un Search enviado en `searchSentAtMs` (epoch en ms), como instante
 * ISO 8601 en UTC. Un acierto de caché conserva el `searchSentAt` original: recalcularlo con la hora
 * del acierto vendería `BookingCode` que TBO ya dio por muertos (01 §6.3 punto 4).
 *
 * `undefined` sólo si `searchSentAtMs` no es un instante: `new Date(NaN).toISOString()` lanza un
 * `RangeError` plano, y un `Error` plano no puede escapar del ACL (RNF-12). El mapper valida el
 * instante antes de llamar, así que en la búsqueda nunca llega vacío.
 */
export function tboOfferExpiresAt(searchSentAtMs: number): string | undefined {
  if (!Number.isFinite(searchSentAtMs)) return undefined;
  const expires = new Date(searchSentAtMs + TBO_OFFER_TTL_MS);
  return Number.isNaN(expires.getTime()) ? undefined : expires.toISOString();
}
