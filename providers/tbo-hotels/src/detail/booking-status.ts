import type { HotelBookingStatus } from '@sales-travel/domain';

/**
 * `BookingDetail.BookingStatus` → estado neutral de la reserva (docs/tbo/04 §6.1 y §6.3; 08 RF-24).
 * Función pura.
 *
 * El enum `Booking Status` del PDF tiene seis valores (p. 70-71) y el ejemplo de conciliación usa un
 * séptimo que no está en él, `Vouchered` (p. 64). No hay estado de fallo ni de pendiente de
 * confirmación (Q-48). Por eso el valor se lee como string abierto y nunca con `z.enum`:
 *
 * | TBO                                                           | Neutral                    |
 * | ------------------------------------------------------------- | -------------------------- |
 * | `Confirmed`, `Vouchered`                                      | `CONFIRMED`                |
 * | `CancellationInProgress`, `CancelPending`, `CxlRequestSentToHotel` | `CANCELLATION_IN_PROGRESS` |
 * | `CancelledAndRefundAwaited`                                   | `CANCELLED`, reembolso pendiente |
 * | `Cancelled`                                                   | `CANCELLED`                |
 * | cualquier otro                                                | `UNKNOWN`                  |
 *
 * - **`CancelledAndRefundAwaited` es cancelada** (RF-24 CA-2): la habitación ya está liberada y lo
 *   que falta es el reembolso de TBO a la cuenta, que sigue la conciliación sin bloquear nada.
 * - **Lo desconocido no se adivina**: `UNKNOWN` escala y la orden no cambia de estado (04 §6.3). Se
 *   conserva como CÓDIGO (sólo letras, dígitos, `_` y `-`, con techo), nunca como texto libre, para
 *   que el valor pueda viajar en un evento.
 * - Se compara sin distinguir mayúsculas ni separadores, porque el PDF mezcla el casing de sus
 *   claves (p. 56, 63); el valor que sale es la grafía del enum, así el mismo estado no aparece de
 *   dos formas en los eventos. Que haya llegado con otra grafía se informa aparte.
 */

export interface TboBookingStatusReading {
  readonly status: HotelBookingStatus;
  /** Grafía del enum de TBO si se reconoció; si no, el valor saneado como código. */
  readonly providerStatus: string;
  /** Cancelada con el reembolso de TBO a la cuenta todavía pendiente. */
  readonly refundAwaited: boolean;
  /** El valor no está en el enum (ni es `Vouchered`): escalar, no cambiar el estado. */
  readonly unknown: boolean;
  /** Se reconoció, pero no llegó con la grafía del enum. */
  readonly casingVariant: boolean;
}

interface Known {
  readonly spelling: string;
  readonly status: HotelBookingStatus;
  readonly refundAwaited: boolean;
}

const KNOWN: readonly Known[] = [
  { spelling: 'Confirmed', status: 'CONFIRMED', refundAwaited: false },
  { spelling: 'Vouchered', status: 'CONFIRMED', refundAwaited: false },
  { spelling: 'CancellationInProgress', status: 'CANCELLATION_IN_PROGRESS', refundAwaited: false },
  { spelling: 'CancelPending', status: 'CANCELLATION_IN_PROGRESS', refundAwaited: false },
  { spelling: 'CxlRequestSentToHotel', status: 'CANCELLATION_IN_PROGRESS', refundAwaited: false },
  { spelling: 'CancelledAndRefundAwaited', status: 'CANCELLED', refundAwaited: true },
  { spelling: 'Cancelled', status: 'CANCELLED', refundAwaited: false },
];

/** Los valores que TBO documenta (p. 70-71) más `Vouchered` (p. 64), en su grafía. */
export const TBO_BOOKING_STATUSES: readonly string[] = KNOWN.map((known) => known.spelling);

const PROVIDER_STATUS_MAX = 64;

function comparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BY_COMPARABLE: ReadonlyMap<string, Known> = new Map(
  KNOWN.map((known) => [comparable(known.spelling), known]),
);

/** Un valor fuera del enum como código: sin espacios ni puntuación que lo vuelvan texto libre. */
function asCode(raw: string): string {
  const code = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, PROVIDER_STATUS_MAX);
  return code.length > 0 ? code : 'unknown';
}

export function readTboBookingStatus(raw: string): TboBookingStatusReading {
  const known = BY_COMPARABLE.get(comparable(raw));
  if (known === undefined) {
    return {
      status: 'UNKNOWN',
      providerStatus: asCode(raw),
      refundAwaited: false,
      unknown: true,
      casingVariant: false,
    };
  }
  return {
    status: known.status,
    providerStatus: known.spelling,
    refundAwaited: known.refundAwaited,
    unknown: false,
    casingVariant: raw !== known.spelling,
  };
}
