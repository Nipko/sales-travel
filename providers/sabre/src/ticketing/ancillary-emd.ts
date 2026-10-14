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
 *
 * Y lo que se cobra tiene que ser lo que la plataforma vendió (`TicketIssueOptions.ancillaryCharge`,
 * lo que la cartera de la red retiene por los servicios): la reserva puede tener servicios que
 * nadie vendió desde aquí (agregados en el GDS), y uno de los nuestros puede no estar confirmado o
 * tener otro precio. Ver {@link sabreAncillaryChargeVerdict}.
 */

export const SABRE_EMD_PENDING_STATUSES: ReadonlySet<SabreAncillaryStatusName> = new Set([
  'Confirmed',
  'Confirmed with pending payment',
]);

/**
 * Por qué un servicio de la reserva no va en la emisión. Conteos para el log, nunca ids.
 * `not-sold`: cobrable, pero la plataforma no vendió servicios en esta reserva.
 */
export type SabreAncillaryEmdSkip =
  | 'emd-issued'
  | 'not-confirmed'
  | 'included'
  | 'price-unreadable'
  | 'not-sold';

export interface SabreAncillaryEmdPlan {
  /** `itemId` a emitir, sin repetidos y en el orden en que vinieron. */
  readonly itemIds: readonly string[];
  readonly skipped: Readonly<Partial<Record<SabreAncillaryEmdSkip, number>>>;
  /** Lo que suman esos EMD, por moneda, en unidades menores (cada `itemId` una vez). */
  readonly totals: Readonly<Record<string, number>>;
}

function skipOf(ancillary: SabreBookingAncillary): SabreAncillaryEmdSkip | number {
  if (ancillary.hasEmd || ancillary.statusName === 'Confirmed with EMD issued') return 'emd-issued';
  if (ancillary.statusName === undefined || !SABRE_EMD_PENDING_STATUSES.has(ancillary.statusName)) {
    return 'not-confirmed';
  }
  if (ancillary.totals === undefined) return 'price-unreadable';
  const minor = parseSabreDecimalToMinor(ancillary.totals.total, ancillary.totals.currencyCode);
  if (minor === undefined) return 'price-unreadable';
  return minor === 0 ? 'included' : minor;
}

/**
 * Los servicios de la lectura que van como EMD. Una lectura sin la sección de servicios
 * (`ancillaries` ausente) no emite ninguno: no se sabe cuáles hay.
 */
export function pendingSabreAncillaryEmds(snapshot: SabreBookingSnapshot): SabreAncillaryEmdPlan {
  const itemIds: string[] = [];
  const skipped: Partial<Record<SabreAncillaryEmdSkip, number>> = {};
  const totals: Record<string, number> = {};
  for (const ancillary of snapshot.ancillaries ?? []) {
    const skip = skipOf(ancillary);
    if (typeof skip === 'string') {
      skipped[skip] = (skipped[skip] ?? 0) + 1;
      continue;
    }
    if (itemIds.includes(ancillary.itemId)) continue;
    itemIds.push(ancillary.itemId);
    // `skipOf` sólo devuelve un monto con `totals` legibles.
    const currency = ancillary.totals?.currencyCode ?? '';
    totals[currency] = (totals[currency] ?? 0) + skip;
  }
  return { itemIds, skipped, totals };
}

/**
 * Qué hacer con los servicios de la reserva al emitir, comparados con lo que la plataforma vendió:
 *
 * - `none`: no vendió nada y no hay nada que cobrar.
 * - `not-sold`: no vendió nada y la reserva tiene servicios cobrables (agregados por fuera): se
 *   emiten sólo los tiquetes, como antes de SAB-20. Nunca se cobra lo que nadie retuvo.
 * - `charge`: lo cobrable es EXACTAMENTE lo vendido, en su moneda: van los EMD.
 * - `mismatch`: vendió algo y lo cobrable suma otra cosa, viene en otra moneda o no hay nada: no se
 *   emite. De más, lo pagaría la cuenta sin retención; de menos, quedaría retenido sin servicio.
 */
export type SabreAncillaryChargeVerdict = 'none' | 'not-sold' | 'charge' | 'mismatch';

export function sabreAncillaryChargeVerdict(
  plan: SabreAncillaryEmdPlan,
  sold: { readonly amountMinor: number; readonly currency: string } | undefined,
): SabreAncillaryChargeVerdict {
  if (sold === undefined || sold.amountMinor === 0) {
    return plan.itemIds.length === 0 ? 'none' : 'not-sold';
  }
  if (!Number.isSafeInteger(sold.amountMinor) || sold.amountMinor < 0) return 'mismatch';
  const currencies = Object.keys(plan.totals);
  if (currencies.length !== 1 || currencies[0] !== sold.currency) return 'mismatch';
  return plan.totals[sold.currency] === sold.amountMinor ? 'charge' : 'mismatch';
}
