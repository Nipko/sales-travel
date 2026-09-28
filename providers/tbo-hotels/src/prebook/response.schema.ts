import { z } from 'zod';
import { TboSearchRoomSchema } from '../search/response.schema';

/**
 * Zod de la respuesta de PreBook (docs/tbo/03 §2.2; 08 RF-15, RNF-12).
 *
 * La tabla del PDF es plana y el anidamiento sale de los ejemplos 7.2.1 y 7.2.2 (p. 23-32).
 *
 * Tolerante donde el contrato se contradice —importes como número o string, `Supplements` como
 * array de arrays o plano, `Index` como string o número—, igual que Search: la habitación de PreBook
 * ES la de Search más `Amenities`, y se lee con el mismo esquema para que la comparación C1 compare
 * dos lecturas idénticas (03 §2.9).
 *
 * Estricto donde nos jugamos dinero:
 *
 * - **Exactamente un `HotelResult` y un elemento en `Rooms`.** PreBook revalida UNA unidad
 *   reservable; dos resultados obligarían a adivinar cuál es la que el vendedor eligió. Otra
 *   cardinalidad es una respuesta ilegible y sale como `TboResponseMappingError` desde el cliente.
 * - **`RateConditions` es una lista de strings** o nada. Un ítem que no es texto no se puede leer, y
 *   puede ser justo la condición "solo con aéreo" (03 §2.11): antes que vender sin haberla leído, la
 *   respuesta es ilegible.
 * - **`CreditCardBillingOptions` no se declara** (03 §2.8): Zod la descarta y no llega a ningún
 *   resultado. El mapper sólo cuenta que vino, porque con `Limit` delataría un perfil de cuenta mal
 *   configurado; nunca registra su contenido.
 *
 * Las claves que el esquema no conoce no rompen nada: sus NOMBRES se registran (C-12). Los tipos de
 * este archivo son crudos de TBO y no salen del paquete (RF-07 CA-6).
 */

/** `Code` es Integer (p. 20); el cliente también acepta un string de 3 dígitos. */
const StatusCodeSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{3}$/)
    .transform(Number),
]);

/**
 * El sobre que valida el cliente HTTP como `responseSchema`. `.passthrough()` conserva las claves
 * desconocidas de la raíz para registrar sus nombres; `Status` es opcional porque el desenlace ya
 * lo decidió el clasificador del cliente, que acepta variantes de casing.
 */
export const TboPrebookEnvelopeSchema = z
  .object({
    Status: z
      .object({ Code: StatusCodeSchema, Description: z.string().nullish() })
      .passthrough()
      .optional(),
    HotelResult: z.tuple([z.unknown()]),
  })
  .passthrough();
export type TboPrebookEnvelope = z.infer<typeof TboPrebookEnvelopeSchema>;

/** La habitación de PreBook: la de Search más `Amenities` (p. 23-25; 03 §2.7). */
export const TboPrebookRoomSchema = TboSearchRoomSchema.extend({
  /** "Amenities associated with the hotel" (p. 23), pero el ejemplo la pone en la habitación. */
  Amenities: z.array(z.string()).nullish(),
});
export type TboPrebookRoom = z.infer<typeof TboPrebookRoomSchema>;

/**
 * El `HotelResult`. `Currency` se valida en el mapper para distinguir "sin moneda" de "moneda con
 * otro exponente", como en Search; la habitación, también en el mapper, con el mapeo compartido.
 */
export const TboPrebookHotelSchema = z.object({
  HotelCode: z.union([
    z.string().trim().min(1).max(64),
    z
      .number()
      .int()
      .nonnegative()
      .transform((code) => String(code)),
  ]),
  Currency: z.unknown(),
  Rooms: z.tuple([z.unknown()]),
  /** "Hotel/Room norms associated with the bookable unit" (p. 23). Hermano de `Rooms`. */
  RateConditions: z.array(z.string()).nullish(),
});
export type TboPrebookHotel = z.infer<typeof TboPrebookHotelSchema>;

/**
 * Claves del `HotelResult` que se conocen y se descartan a propósito: no se reportan como
 * desconocidas, porque no lo son (p. 23), pero tampoco se leen.
 */
export const TBO_PREBOOK_IGNORED_HOTEL_KEYS: readonly string[] = ['CreditCardBillingOptions'];

// Las claves conocidas salen de los propios esquemas: una lista escrita a mano derivaría en la
// siguiente edición y empezaría a reportar como "desconocido" un campo que sí se lee.
export const TBO_PREBOOK_ROOT_KEYS: readonly string[] = Object.keys(TboPrebookEnvelopeSchema.shape);
export const TBO_PREBOOK_HOTEL_KEYS: readonly string[] = [
  ...Object.keys(TboPrebookHotelSchema.shape),
  ...TBO_PREBOOK_IGNORED_HOTEL_KEYS,
];
export const TBO_PREBOOK_ROOM_KEYS: readonly string[] = Object.keys(TboPrebookRoomSchema.shape);
