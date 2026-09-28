import { z } from 'zod';

/**
 * Zod de la respuesta de `BookingDetailsbasedondate` (docs/tbo/04 §5.4 y §9.5; 08 RF-28; RNF-12).
 *
 * La tabla (p. 63-64) declara `BookingDetail` como Object y el ejemplo lo trae como array (PV-27);
 * `BookingStatus` no está en la tabla y el ejemplo trae `Vouchered`, fuera del enum (PV-28). De esta
 * respuesta sale una conclusión fuerte —"esta reserva NO está en TBO"— que libera intents inciertos
 * (D-TBO-24 A), así que el esquema es exigente justo en lo que permite concluirla y tolerante en el
 * resto:
 *
 * - **Estrictos por fila: `ConfirmationNo` y `BookingDate`.** Una fila sin localizador no se puede
 *   cruzar, y una sin fecha legible no se puede comprobar contra la ventana: con cualquiera de las
 *   dos la ventana entera deja de valer (04 §9.5 punto 2).
 * - **`BookingDetail` se lee en el mapper**: array, objeto único, `null` o ausente. Vacío es "no hay
 *   reservas" sólo con `Status.Code` 200 (PV-26); un escalar es una forma que el contrato no admite.
 * - **Lo comercial es tolerante** (`Currency`, montos, `AgencyName`, fechas de estadía, `BookingId`,
 *   `ClientReferenceNumber`, `BookingStatus`): lo que no se puede leer queda ausente y se cuenta.
 * - **`TripName` no se declara**: parece llevar el apellido del huésped (INFERIDO, `Sharma_02Dec_Dubai`,
 *   p. 64). Zod lo descarta al leer la fila, así que ningún objeto que arma el mapper lo contiene.
 *   Figura como clave conocida para no reportarse como contrato nuevo. `Index` tampoco se lee.
 *
 * Los tipos de este archivo son crudos de TBO y no salen del paquete (RF-07 CA-6).
 */

/** `Code` es Integer (p. 63); el cliente también acepta un string de 3 dígitos. */
const StatusCodeSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{3}$/)
    .transform(Number),
]);

/** Texto obligatorio; un entero se acepta como texto (el contrato dice String, p. 63). */
const RequiredTextSchema = z.preprocess(
  (value) => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value),
  z.string().trim().min(1),
);

export const TboBookingsByDateEnvelopeSchema = z
  .object({
    Status: z
      .object({ Code: StatusCodeSchema, Description: z.string().nullish() })
      .passthrough()
      .optional(),
    BookingDetail: z.unknown().optional(),
  })
  .passthrough();
export type TboBookingsByDateEnvelope = z.infer<typeof TboBookingsByDateEnvelopeSchema>;

export const TboBookingByDateRowSchema = z.object({
  BookingId: z.unknown().optional(),
  ConfirmationNo: RequiredTextSchema,
  /** `DD-MMM-YYYY` (p. 63); el calendario y la ventana los comprueba el mapper. */
  BookingDate: z.string().trim().min(1),
  Currency: z.unknown().optional(),
  AgentMarkup: z.unknown().optional(),
  AgencyName: z.unknown().optional(),
  BookingStatus: z.unknown().optional(),
  BookingPrice: z.unknown().optional(),
  TBOHotelCode: z.unknown().optional(),
  CheckInDate: z.unknown().optional(),
  CheckOutDate: z.unknown().optional(),
  ClientReferenceNumber: z.unknown().optional(),
});
export type TboBookingByDateRow = z.infer<typeof TboBookingByDateRowSchema>;

/** Claves conocidas que no se leen a propósito (p. 63-64). */
const IGNORED_ROW_KEYS: readonly string[] = ['Index', 'TripName'];

// Las claves conocidas salen de los propios esquemas: una lista escrita a mano derivaría.
export const TBO_BOOKINGS_BY_DATE_ROOT_KEYS: readonly string[] = Object.keys(
  TboBookingsByDateEnvelopeSchema.shape,
);
export const TBO_BOOKING_BY_DATE_ROW_KEYS: readonly string[] = [
  ...Object.keys(TboBookingByDateRowSchema.shape),
  ...IGNORED_ROW_KEYS,
];
