import { z } from 'zod';
import {
  TBO_BOOKING_REFERENCE_PATTERN,
  TBO_CONFIRMATION_NUMBER_PATTERN,
} from '../booking/booking-reference';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';

/**
 * Body de `BookingDetail` (docs/tbo/04 §3.1; 08 RF-24; RNF-04 capas 1 a 3).
 *
 * El request lleva `ConfirmationNumber` o `BookingReferenceId` más `PaymentMode` (p. 43-44). El PDF
 * no dice qué pasa si llegan los dos o ninguno (Q-45), así que se manda **exactamente uno**, con la
 * forma de los dos ejemplos de p. 44:
 *
 * - por `ConfirmationNumber`: la lectura normal de una reserva con localizador (cierre de la
 *   creación, antes y después de un Cancel, HCN, consulta del panel);
 * - por `BookingReferenceId`: sólo la recuperación de un Book incierto (p. 42), con NUESTRA
 *   referencia (`../booking/booking-reference`).
 *
 * `PaymentMode` va siempre, y siempre `"Limit"` (C-21): el mismo modo que PreBook y Book (03 §3.6).
 * Nunca se copia un body de Postman, que trae un comentario `//` dentro del JSON (04 §3.1).
 */

const DETAIL_PATH = TBO_OPERATIONS.bookingDetail.path;

/** El único modo de pago que sale de este paquete (D1; 03 §7). */
export const TBO_BOOKING_DETAIL_PAYMENT_MODE = 'Limit';

/** Qué reserva leer. Uno de los dos identificadores; el modo de pago no se elige. */
export type TboBookingDetailInput =
  | {
      /** Localizador de TBO, del Book o de la orden. */
      readonly confirmationNumber: string;
      readonly bookingReferenceId?: never;
      readonly PaymentMode?: never;
      readonly PaymentInfo?: never;
    }
  | {
      /** Nuestra referencia, la que salió en el Book incierto. */
      readonly bookingReferenceId: string;
      readonly confirmationNumber?: never;
      readonly PaymentMode?: never;
      readonly PaymentInfo?: never;
    };

const ByConfirmationSchema = z
  .object({
    ConfirmationNumber: z.string().regex(TBO_CONFIRMATION_NUMBER_PATTERN),
    PaymentMode: z.literal(TBO_BOOKING_DETAIL_PAYMENT_MODE),
  })
  .strict();

const ByReferenceSchema = z
  .object({
    BookingReferenceId: z.string().regex(TBO_BOOKING_REFERENCE_PATTERN),
    PaymentMode: z.literal(TBO_BOOKING_DETAIL_PAYMENT_MODE),
  })
  .strict();

/** El body exacto, en una de sus dos formas, con las claves en el orden del PDF (p. 44). */
export const TboBookingDetailRequestSchema = z.union([ByConfirmationSchema, ByReferenceSchema]);

/** Tipo crudo de TBO: no sale del paquete. `PaymentInfo?: never` es la barrera de D1 en el tipo. */
export type TboBookingDetailRequest = z.infer<typeof TboBookingDetailRequestSchema> & {
  readonly PaymentInfo?: never;
};

/**
 * Construye el body de un BookingDetail. Lanza `TboRequestBuildError` con `SCHEMA` si llegan los dos
 * identificadores o ninguno, o si el que llega no tiene su forma; nada sale hacia TBO.
 */
export function buildTboBookingDetailRequest(
  input: TboBookingDetailInput,
): TboBookingDetailRequest {
  const record = input as Readonly<Record<string, unknown>>;
  const confirmationNumber = record['confirmationNumber'];
  const bookingReferenceId = record['bookingReferenceId'];
  const hasConfirmation = confirmationNumber !== undefined;
  const hasReference = bookingReferenceId !== undefined;
  if (hasConfirmation === hasReference) {
    throw new TboRequestBuildError(DETAIL_PATH, 'SCHEMA', [
      hasConfirmation ? '<root>:both_identifiers' : '<root>:missing_identifier',
    ]);
  }

  // Se valida contra la forma pedida y no contra la unión: con una unión, Zod sólo dice
  // `invalid_union` y el issue no nombraría el campo que falló.
  const parsed = hasConfirmation
    ? ByConfirmationSchema.safeParse({
        ConfirmationNumber: confirmationNumber,
        PaymentMode: TBO_BOOKING_DETAIL_PAYMENT_MODE,
      })
    : ByReferenceSchema.safeParse({
        BookingReferenceId: bookingReferenceId,
        PaymentMode: TBO_BOOKING_DETAIL_PAYMENT_MODE,
      });
  if (!parsed.success) {
    throw new TboRequestBuildError(DETAIL_PATH, 'SCHEMA', zodIssueRefs(parsed.error));
  }
  return parsed.data;
}
