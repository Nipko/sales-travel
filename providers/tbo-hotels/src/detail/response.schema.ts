import { z } from 'zod';
import { optionalBoolean } from '../internal/coerce';
import { TboDecimalSchema } from '../search/response.schema';

/**
 * Zod de la respuesta de `BookingDetail` (docs/tbo/04 §3.3 y §3.7; 08 RF-24; RNF-12).
 *
 * La tabla del PDF es plana y tiene una página en blanco (p. 44-49); el anidamiento sale del único
 * ejemplo (p. 49-51), que además trae comillas tipográficas, un `BookingDate` imposible y un
 * carácter de reemplazo en `RateConditions`. Por eso el esquema es tolerante en todo lo que no
 * decide el estado de la reserva, y exigente sólo en lo que sí:
 *
 * - **`BookingDetail` es obligatorio.** Un `200` sin él es un error de mapeo, no una reserva vacía
 *   (RF-24). Un "no existe" llega con otro `Status.Code` (forma desconocida, Q-37; sonda PR-05).
 * - **`BookingStatus` es un string abierto**, nunca `z.enum`: `Vouchered` ya está fuera del enum
 *   (p. 64). Lo normaliza `./booking-status`.
 * - **`ConfirmationNumber` es obligatorio**: sin localizador no hay reserva que leer.
 * - **`VoucherStatus` booleano o string** (Boolean en la tabla, "Confirm, Voucher" en la descripción,
 *   p. 45; PV-02). **`HotelConfirmationNumber` nullish**: `""` es "todavía sin HCN" (PV-05); un
 *   relleno como `NA` también, pero eso lo decide el mapper, que lo cuenta.
 * - **Fechas como texto**: el mapper toma la fecha sólo si tiene forma (PV-03). `BookingDate` es
 *   informativo y uno roto no rompe nada.
 * - **`Rooms` en sus dos formas** (PV-07): un elemento por habitación o uno con `Name[]` de N
 *   entradas. La cantidad de habitaciones la dicen `NoOfRooms` y la ocupación guardada.
 * - **`HotelDetails`, `Rooms` y `RateConditions` se leen por partes** en el mapper, cada una con su
 *   propio esquema: son datos del voucher y no deciden el estado. Una habitación o una norma que no
 *   se puede leer se descarta y se mide; no deja sin leer el estado de una reserva que existe, que
 *   es lo único que la recuperación de un Book incierto necesita saber (p. 42).
 * - **`CustomerDetails` no se declara**: son nombres de huéspedes (p. 48, 50) y Zod los descarta al
 *   leer la reserva y cada habitación, así que ningún objeto que arma el mapper los contiene. No se
 *   leen, no se loguean y no se copian a ningún resultado (RF-24 CA-3). Lo mismo **`CreditCardOptions`** (D1; p. 48-49). Las dos claves
 *   figuran como conocidas para no reportarse como contrato nuevo.
 * - `CancelPolicies` y `Supplements` quedan sin modelar (`z.unknown()`): la política final es la del
 *   PreBook (KP-3, p. 71), la ubicación de `Supplements` no está confirmada (PV-06) y el voucher los
 *   toma del snapshot de la orden. Validar lo que no se usa sólo agrega formas de fallar una lectura.
 *
 * Las claves desconocidas no rompen nada: sus NOMBRES se registran. Los tipos de este archivo son
 * crudos de TBO y no salen del paquete (RF-07 CA-6).
 */

/** `Code` es Integer (p. 44); el cliente también acepta un string de 3 dígitos. */
const StatusCodeSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{3}$/)
    .transform(Number),
]);

/** Texto opcional: `null` o sólo espacios es "no vino". */
const OptionalTextSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  });

/** Entero como número o como texto de dígitos (`Index` es String en una tabla, PV-08). */
const OptionalCountSchema = z
  .union([z.number().int().nonnegative(), z.string().trim().regex(/^\d+$/).transform(Number)])
  .nullish()
  .transform((value) => value ?? undefined);

/**
 * Etiqueta del voucher como texto; un número finito pasa a texto. `HotelRating` llega como texto o
 * como número según el método (p. 62, 67), y una estrella numérica no vuelve ilegible una reserva.
 */
const OptionalLabelSchema = z
  .union([z.string(), z.number().finite().transform(String), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  });

/**
 * Una habitación reservada. Se valida UNA por UNA en el mapper: la que no pasa se descarta y se
 * mide, y las demás y el estado se leen igual. `TotalFare` y `TotalTax` siguen estrictos porque
 * son dinero: una habitación con un importe ilegible no entra en el total.
 */
export const TboBookedRoomSchema = z.object({
  Currency: OptionalTextSchema,
  /** Lista o texto (PV-07); los elementos que no son texto los descarta el mapper. */
  Name: z.unknown().optional(),
  Inclusion: OptionalTextSchema,
  TotalFare: TboDecimalSchema.nullish(),
  TotalTax: TboDecimalSchema.nullish(),
  RoomPromotion: z.unknown().optional(),
  CancelPolicies: z.unknown().optional(),
  /** Enum abierto: la tabla lista 3 valores y el ejemplo usa un cuarto (PV-11). */
  MealType: OptionalTextSchema,
  /** Boolean en la tabla; `"true"`/`"false"` se aceptan y cualquier otra cosa es "no vino". */
  IsRefundable: z.unknown().transform(optionalBoolean),
  Supplements: z.unknown().optional(),
  /** La tabla la pone después de `CustomerNames`; el ejemplo, a nivel de reserva (PV-06). */
  RateConditions: z.unknown().optional(),
});
export type TboBookedRoom = z.infer<typeof TboBookedRoomSchema>;

export const TboBookedHotelSchema = z.object({
  HotelName: OptionalLabelSchema,
  Rating: OptionalLabelSchema,
  AddressLine1: OptionalLabelSchema,
  AddressLine2: OptionalLabelSchema,
  Map: OptionalLabelSchema,
  City: OptionalLabelSchema,
});
export type TboBookedHotelDetails = z.infer<typeof TboBookedHotelSchema>;

/**
 * El núcleo de la reserva: lo que decide su estado y sus identificadores, estricto. `HotelDetails`,
 * `Rooms` y `RateConditions` quedan como `unknown` aquí y los lee el mapper por partes.
 */
export const TboBookingDetailSchema = z.object({
  BookingStatus: z.string().trim().min(1),
  VoucherStatus: z.union([z.boolean(), z.string()]).nullish(),
  ConfirmationNumber: z.string().trim().min(1),
  HotelConfirmationNumber: OptionalTextSchema,
  InvoiceNumber: OptionalTextSchema,
  CheckIn: OptionalTextSchema,
  CheckOut: OptionalTextSchema,
  BookingDate: OptionalTextSchema,
  NoOfRooms: OptionalCountSchema,
  HotelDetails: z.unknown().optional(),
  Rooms: z.unknown().optional(),
  Supplements: z.unknown().optional(),
  RateConditions: z.unknown().optional(),
});
export type TboBookingDetail = z.infer<typeof TboBookingDetailSchema>;

/**
 * El sobre que valida el cliente HTTP como `responseSchema`. `BookingDetail` sólo tiene que ser un
 * objeto: su contenido lo lee el mapper, que antes registra los nombres de las claves desconocidas.
 */
export const TboBookingDetailEnvelopeSchema = z
  .object({
    Status: z
      .object({ Code: StatusCodeSchema, Description: z.string().nullish() })
      .passthrough()
      .optional(),
    BookingDetail: z.record(z.unknown()),
  })
  .passthrough();
export type TboBookingDetailEnvelope = z.infer<typeof TboBookingDetailEnvelopeSchema>;

/**
 * Claves conocidas que no se leen a propósito: no se reportan como desconocidas (p. 48-49). Las dos
 * se buscan en la reserva y en cada habitación, porque la tabla es plana (PV-06).
 */
const IGNORED_DETAIL_KEYS: readonly string[] = ['CustomerDetails', 'CreditCardOptions'];

// Las claves conocidas salen de los propios esquemas: una lista escrita a mano derivaría.
export const TBO_BOOKING_DETAIL_ROOT_KEYS: readonly string[] = Object.keys(
  TboBookingDetailEnvelopeSchema.shape,
);
export const TBO_BOOKING_DETAIL_KEYS: readonly string[] = [
  ...Object.keys(TboBookingDetailSchema.shape),
  ...IGNORED_DETAIL_KEYS,
];
export const TBO_BOOKED_HOTEL_KEYS: readonly string[] = Object.keys(TboBookedHotelSchema.shape);
export const TBO_BOOKED_ROOM_KEYS: readonly string[] = [
  ...Object.keys(TboBookedRoomSchema.shape),
  ...IGNORED_DETAIL_KEYS,
];
