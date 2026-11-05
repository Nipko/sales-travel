import type { BookingOutcomeView, CreateOrderResponseBody } from './create-order-reconciliation';

/*
 * Qué pasa en la pantalla cuando la reserva sale. Una reserva creada no se queda en el checkout
 * con un recuadro verde: se abre su detalle (`/reservas/[id]`), que es donde se paga, se emite y
 * se ve todo lo reservado. Lo que no quedó cerrado —pendiente, incierto, fallido— se queda aquí,
 * con su aviso, como siempre.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El id de la reserva LOCAL (la fila de `orders`) que devolvió `POST /api/orders`. */
export function createdOrderId(data: CreateOrderResponseBody): string | undefined {
  const id = data.order?.id ?? data.orderId;
  return typeof id === 'string' && UUID.test(id.trim()) ? id.trim() : undefined;
}

/**
 * A dónde ir tras reservar. Sólo `CONFIRMED` o `PARTIAL` con reserva local: las dos tienen PNR y
 * se gestionan desde su detalle. `PENDING`, `UNCERTAIN` y `FAILED` se quedan en el checkout.
 */
export function reservationHref(view: BookingOutcomeView | null): string | null {
  if (view === null || view.orderId === undefined) return null;
  if (view.outcome !== 'CONFIRMED' && view.outcome !== 'PARTIAL') return null;
  return `/reservas/${encodeURIComponent(view.orderId)}`;
}

export interface BookingToast {
  readonly tone: 'success' | 'warning';
  readonly title: string;
  readonly description?: string;
}

/** El aviso que acompaña la navegación: lo que no se vio en el checkout no se pierde. */
export function bookingToast(view: BookingOutcomeView): BookingToast {
  const notes = [
    ...(view.outcome === 'PARTIAL'
      ? ['Hay servicios sin confirmar: revísalos en el detalle.']
      : []),
    ...(view.seatNotices ?? []),
  ];
  return {
    tone: view.outcome === 'CONFIRMED' && notes.length === 0 ? 'success' : 'warning',
    title: 'Reserva creada',
    ...(notes.length > 0 ? { description: notes.join(' ') } : {}),
  };
}

const PAX_WORDS = {
  adults: ['adulto', 'adultos'],
  children: ['niño', 'niños'],
  infants: ['infante', 'infantes'],
} as const;

/** «2 adultos, 1 niño». */
export function paxCountLabel(pax: {
  readonly adults: number;
  readonly children: number;
  readonly infants: number;
}): string {
  const parts = (Object.keys(PAX_WORDS) as (keyof typeof PAX_WORDS)[])
    .filter((key) => pax[key] > 0)
    .map((key) => `${pax[key]} ${PAX_WORDS[key][pax[key] === 1 ? 0 : 1]}`);
  return parts.length > 0 ? parts.join(', ') : 'Sin pasajeros';
}

export function totalPassengers(pax: {
  readonly adults: number;
  readonly children: number;
  readonly infants: number;
}): number {
  return pax.adults + pax.children + pax.infants;
}
