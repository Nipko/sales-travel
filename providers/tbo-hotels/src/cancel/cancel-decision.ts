import type { HotelBookingView, HotelCancelResult } from '@sales-travel/domain';
import type { TboCancelReply } from './response.mapper';

/**
 * La secuencia de cancelación de docs/tbo/04 §4.4 como dos funciones puras (08 RF-25; D-TBO-25 A):
 * qué hacer con la lectura PREVIA —mandar el Cancel o no— y qué devolver según lo que dijo `/Cancel`
 * y la lectura POSTERIOR. El adapter sólo llama a TBO y pasa lo que vio.
 *
 * El criterio, en una línea: `success` dice si la cancelación quedó PEDIDA en TBO (por nosotros o
 * antes), y `bookingStatus` si quedó cancelada o sólo en curso. Nunca se da por cancelada una
 * reserva sin una lectura que lo diga (R-14 de 08: "Cancelada" mientras el hotel no la liberó).
 *
 * | Lectura previa             | ¿Se manda? | Resultado                                              |
 * | -------------------------- | ---------- | ------------------------------------------------------ |
 * | `CONFIRMED`                | Sí         | Lo decide `/Cancel` con la lectura posterior           |
 * | `CANCELLED`                | No         | Éxito idempotente (PV-17)                              |
 * | `CANCELLATION_IN_PROGRESS` | No         | Éxito "en curso": ya hay una cancelación pedida        |
 * | Estado desconocido         | No         | Rechazo: no se escribe con dinero sobre lo que no se entiende |
 * | No encontrada              | No         | Rechazo: no hay nada que cancelar con ese localizador  |
 *
 * | `/Cancel` | Lectura posterior          | `success` | `bookingStatus`            | Aviso                              |
 * | --------- | -------------------------- | --------- | -------------------------- | ---------------------------------- |
 * | `200`     | `CANCELLED`                | `true`    | `CANCELLED`                | —                                  |
 * | `200`     | `CANCELLATION_IN_PROGRESS` | `true`    | `CANCELLATION_IN_PROGRESS` | —                                  |
 * | `200`     | `CONFIRMED`                | `true`    | `CONFIRMED`                | `BOOKING_STILL_CONFIRMED`          |
 * | `200`     | desconocido                | `true`    | `UNKNOWN`                  | `BOOKING_STATUS_UNKNOWN`           |
 * | `200`     | no encontrada o fallida    | `true`    | —                          | `POST_CANCEL_READ_…`               |
 * | `479`     | `CANCELLED`                | `true`    | `CANCELLED`                | `ALREADY_CANCELLED`                |
 * | `479`     | `CANCELLATION_IN_PROGRESS` | `true`    | `CANCELLATION_IN_PROGRESS` | `CANCELLATION_ALREADY_IN_PROGRESS` |
 * | `479`     | `CONFIRMED`                | `false`   | `CONFIRMED`                | — (`error: TBO_CANCEL_FAIL`)       |
 * | `479`     | desconocido                | `false`   | `UNKNOWN`                  | `BOOKING_STATUS_UNKNOWN`           |
 * | `479`     | no encontrada o fallida    | `false`   | —                          | `POST_CANCEL_READ_…`               |
 *
 * - **Un `200` sigue siendo un `200` aunque la lectura falle** (C-05): el resultado del write ya se
 *   conoce, y volverlo incierto habilitaría un segundo Cancel. El aviso deja la verificación a
 *   `verify-cancellation`, que sólo lee.
 * - **`refundAmount` queda vacío** (04 §4.5): TBO no informa cargo ni reembolso, y una estimación
 *   nuestra no se presenta como dato del proveedor.
 */

/** Por qué una cancelación no llega a TBO: el `error` de un resultado con `success: false`. */
export const TBO_CANCEL_ERRORS = [
  /** `479 CANCEL_FAIL` y la reserva sigue viva (o no se pudo leer). */
  'TBO_CANCEL_FAIL',
  /** La lectura previa no encontró la reserva con ese localizador: no se mandó nada. */
  'TBO_BOOKING_NOT_FOUND',
  /** La lectura previa trajo un estado fuera del enum: no se mandó nada, se escala. */
  'TBO_BOOKING_STATUS_UNKNOWN',
] as const;
export type TboCancelError = (typeof TBO_CANCEL_ERRORS)[number];

/** Avisos del resultado, como códigos cerrados: nunca texto del proveedor. */
export const TBO_CANCEL_WARNINGS = [
  /** La reserva ya estaba cancelada: éxito idempotente. */
  'ALREADY_CANCELLED',
  /** Ya había una cancelación en curso en TBO. */
  'CANCELLATION_ALREADY_IN_PROGRESS',
  /** `/Cancel` respondió `200` y la lectura todavía dice `Confirmed`: a verificar. */
  'BOOKING_STILL_CONFIRMED',
  /** La lectura trajo un `BookingStatus` fuera del enum. */
  'BOOKING_STATUS_UNKNOWN',
  /** La lectura posterior no encontró la reserva: a verificar. */
  'POST_CANCEL_READ_NOT_FOUND',
  /** La lectura posterior falló: a verificar, nunca a reenviar. */
  'POST_CANCEL_READ_FAILED',
] as const;
export type TboCancelWarning = (typeof TBO_CANCEL_WARNINGS)[number];

/** Por qué no salió el `POST /Cancel`, según la lectura previa. */
export const TBO_CANCEL_SKIP_REASONS = [
  'ALREADY_CANCELLED',
  'ALREADY_IN_PROGRESS',
  'NOT_FOUND',
  'STATUS_UNKNOWN',
] as const;
export type TboCancelSkipReason = (typeof TBO_CANCEL_SKIP_REASONS)[number];

export type TboCancelPreflight =
  | { readonly send: true }
  | {
      readonly send: false;
      readonly skipReason: TboCancelSkipReason;
      readonly result: HotelCancelResult;
    };

/** La lectura posterior al Cancel: la vista (encontrada o no) o que la lectura misma falló. */
export type TboCancelAfterReading =
  | { readonly state: 'read'; readonly view: HotelBookingView }
  | { readonly state: 'failed' };

type StatusFields = Pick<HotelCancelResult, 'bookingStatus' | 'providerStatus' | 'refundAwaited'>;

/**
 * `CancelledAndRefundAwaited` llega como `CANCELLED` más `refundAwaited`: sin la marca, la
 * post-venta no sabría que el reembolso de TBO a la cuenta sigue pendiente.
 */
function statusOf(view: HotelBookingView): StatusFields {
  return {
    ...(view.status === undefined ? {} : { bookingStatus: view.status }),
    ...(view.providerStatus === undefined ? {} : { providerStatus: view.providerStatus }),
    ...(view.status === 'CANCELLED' && view.refundAwaited === true ? { refundAwaited: true } : {}),
  };
}

function rejected(
  error: TboCancelError,
  warnings: readonly TboCancelWarning[],
  fields: StatusFields = {},
): HotelCancelResult {
  return { success: false, error, ...fields, warnings: [...warnings] };
}

function accepted(
  warnings: readonly TboCancelWarning[],
  fields: StatusFields = {},
): HotelCancelResult {
  return { success: true, ...fields, warnings: [...warnings] };
}

/** Lectura previa → mandar el Cancel o no, y con qué resultado si no. */
export function decideTboCancelPreflight(before: HotelBookingView): TboCancelPreflight {
  // Un "no encontrada" sin lectura: `providerStatus` sería un `Status.Code`, no un estado.
  if (!before.found) {
    return {
      send: false,
      skipReason: 'NOT_FOUND',
      result: rejected('TBO_BOOKING_NOT_FOUND', []),
    };
  }
  const fields = statusOf(before);
  switch (before.status) {
    case 'CONFIRMED':
      return { send: true };
    case 'CANCELLED':
      return {
        send: false,
        skipReason: 'ALREADY_CANCELLED',
        result: accepted(['ALREADY_CANCELLED'], fields),
      };
    case 'CANCELLATION_IN_PROGRESS':
      return {
        send: false,
        skipReason: 'ALREADY_IN_PROGRESS',
        result: accepted(['CANCELLATION_ALREADY_IN_PROGRESS'], fields),
      };
    default:
      return {
        send: false,
        skipReason: 'STATUS_UNKNOWN',
        result: rejected('TBO_BOOKING_STATUS_UNKNOWN', ['BOOKING_STATUS_UNKNOWN'], fields),
      };
  }
}

/** Lo que dijo `/Cancel` (`200` o `479`) más la lectura posterior → el resultado del puerto. */
export function decideTboCancelResult(
  reply: TboCancelReply,
  after: TboCancelAfterReading,
): HotelCancelResult {
  const settle = (warnings: readonly TboCancelWarning[], fields = {}): HotelCancelResult =>
    reply.success ? accepted(warnings, fields) : rejected('TBO_CANCEL_FAIL', warnings, fields);

  if (after.state === 'failed') return settle(['POST_CANCEL_READ_FAILED']);
  const { view } = after;
  if (!view.found) return settle(['POST_CANCEL_READ_NOT_FOUND']);

  const fields = statusOf(view);
  switch (view.status) {
    case 'CANCELLED':
      return accepted(reply.success ? [] : ['ALREADY_CANCELLED'], fields);
    case 'CANCELLATION_IN_PROGRESS':
      return accepted(reply.success ? [] : ['CANCELLATION_ALREADY_IN_PROGRESS'], fields);
    case 'CONFIRMED':
      return settle(reply.success ? ['BOOKING_STILL_CONFIRMED'] : [], fields);
    default:
      return settle(['BOOKING_STATUS_UNKNOWN'], fields);
  }
}
