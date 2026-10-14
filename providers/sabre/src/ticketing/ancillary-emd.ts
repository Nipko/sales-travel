import { parseSabreDecimalToMinor } from '../booking/cancel.response.mapper';
import type {
  SabreAncillaryStatusName,
  SabreBookingAncillary,
  SabreBookingSnapshot,
} from '../booking/get.response.mapper';

/**
 * Qué servicios adicionales de la reserva se emiten como EMD junto con el tiquete (SAB-20).
 *
 * `fulfillFlightTickets` emite los EMD en una entrada aparte de `fulfillments[]`, por `itemId` de
 * `getBooking` (`FulfillmentDetails.ancillaryIds`, `booking-management-v1.yml:7442-7451`; docs/sabre/03
 * §5.8). Se cobran con la misma forma de pago que el tiquete: la de la cuenta, nunca tarjeta (D1).
 *
 * Va un servicio sólo si las tres cosas se cumplen, y si no, se queda fuera sin adivinar:
 *
 *  1. **La aerolínea lo confirmó** (`Confirmed` o `Confirmed with pending payment`). Uno pendiente,
 *     a pedido o sin confirmar no se cobra: el EMD de un servicio que la aerolínea todavía no dio
 *     es plata por nada.
 *  2. **No tiene EMD.** Uno con número ya se cobró; mandarlo otra vez es `DUPLICATE_ID` en el mejor
 *     caso.
 *  3. **Tiene precio y es mayor que cero.** Uno incluido en la tarifa no lleva EMD, y uno sin precio
 *     legible no se cobra a ciegas.
 *
 * Que la aerolínea acepte el EMD con CASH por este carril se confirma en CERT (SAB-21).
 */

export const SABRE_EMD_PENDING_STATUSES: ReadonlySet<SabreAncillaryStatusName> = new Set([
  'Confirmed',
  'Confirmed with pending payment',
]);

/** Por qué un servicio de la reserva no va en la emisión. Conteos para el log, nunca ids. */
export type SabreAncillaryEmdSkip =
  | 'emd-issued'
  | 'not-confirmed'
  | 'included'
  | 'price-unreadable';

export interface SabreAncillaryEmdPlan {
  /** `itemId` a emitir, sin repetidos y en el orden en que vinieron. */
  readonly itemIds: readonly string[];
  readonly skipped: Readonly<Partial<Record<SabreAncillaryEmdSkip, number>>>;
}

function skipOf(ancillary: SabreBookingAncillary): SabreAncillaryEmdSkip | undefined {
  if (ancillary.hasEmd || ancillary.statusName === 'Confirmed with EMD issued') return 'emd-issued';
  if (ancillary.statusName === undefined || !SABRE_EMD_PENDING_STATUSES.has(ancillary.statusName)) {
    return 'not-confirmed';
  }
  if (ancillary.totals === undefined) return 'price-unreadable';
  const minor = parseSabreDecimalToMinor(ancillary.totals.total, ancillary.totals.currencyCode);
  if (minor === undefined) return 'price-unreadable';
  return minor === 0 ? 'included' : undefined;
}

/**
 * Los servicios de la lectura que van como EMD. Una lectura sin la sección de servicios
 * (`ancillaries` ausente) no emite ninguno: no se sabe cuáles hay.
 */
export function pendingSabreAncillaryEmds(snapshot: SabreBookingSnapshot): SabreAncillaryEmdPlan {
  const itemIds: string[] = [];
  const skipped: Partial<Record<SabreAncillaryEmdSkip, number>> = {};
  for (const ancillary of snapshot.ancillaries ?? []) {
    const skip = skipOf(ancillary);
    if (skip !== undefined) {
      skipped[skip] = (skipped[skip] ?? 0) + 1;
      continue;
    }
    if (!itemIds.includes(ancillary.itemId)) itemIds.push(ancillary.itemId);
  }
  return { itemIds, skipped };
}
