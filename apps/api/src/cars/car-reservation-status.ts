/**
 * Qué dice el estado que devuelve `/my-reservation` sobre una orden de auto que quedó `pending`
 * (en espera u on request). AgentCars no manda un token sino un texto para mostrar, en el idioma
 * pedido («Activo», «Active», «On Request», «Cancelada»…): se clasifica por raíces y, ante la duda,
 * `unknown`, que no toca la orden. Mejor una reserva pendiente un rato más que una confirmada falsa.
 *
 * - `confirmed`: la arrendadora la confirmó (o se activó una en espera).
 * - `pending`: sigue en espera o a confirmar.
 * - `cancelled`: se canceló o venció (una en espera sin activar 48 h antes la cancela AgentCars).
 * - `rejected`: la arrendadora no la aceptó (on request rechazada).
 */
export type CarReservationOutcome = 'confirmed' | 'pending' | 'cancelled' | 'rejected' | 'unknown';

export function classifyCarReservationStatus(raw: string): CarReservationOutcome {
  const s = raw.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
  if (!s) return 'unknown';
  // Antes que «activ»: «inactivo» contiene «activ».
  if (/(cancel|anulad|expir|vencid|inactiv|no.?show)/.test(s)) return 'cancelled';
  if (/(reject|rechaz|denied|denegad|declin|negad|unavailable|no disponible)/.test(s)) {
    return 'rejected';
  }
  if (/(hold|request|espera|solicit|pend)/.test(s)) return 'pending';
  if (/(activ|confirm)/.test(s) || s === 'ok') return 'confirmed';
  return 'unknown';
}
