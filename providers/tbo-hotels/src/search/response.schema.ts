import { z } from 'zod';

/**
 * Zod de la respuesta de Search (docs/tbo/02 §10; 08 RF-07, RNF-12 y §9 C-12).
 *
 * Tres niveles con tres tolerancias distintas, para que una pieza rota no tire la búsqueda entera:
 *
 * 1. **Sobre** (`TboSearchEnvelopeSchema`): `Status` y `HotelResult` como lista de desconocidos. Es
 *    lo que el cliente HTTP valida como `responseSchema`; si no pasa, la respuesta es ilegible
 *    (S-16) y sale `TboResponseMappingError`.
 * 2. **Hotel** (`TboSearchHotelSchema`) y 3. **pack** (`TboSearchRoomSchema`): el mapper los valida
 *    uno por uno con `safeParse`. Uno roto se descarta y se mide; los demás siguen.
 *
 * Tolerante donde el contrato se contradice (importes como número o string, `Supplements` como
 * array de arrays o plano, `RoomPromotion` plano o anidado, `RoomID` y `RoomId`), estricto donde
 * hay dinero: un importe con signo, separador de miles o moneda que no es ISO invalida el pack.
 *
 * Las claves desconocidas no rompen nada, pero sus NOMBRES se registran para detectar cambios del
 * contrato (C-12). Como `z.object` las descarta sin exponerlas, el mapper compara las claves con
 * las listas `*_KEYS` de abajo ANTES de parsear. Nunca se registran valores.
 *
 * Los tipos de este archivo son crudos de TBO: no salen del paquete (RF-07 CA-6).
 */

/** Decimal sin signo ni separador de miles, como texto (`"17.22"`, p. 15). */
const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

/**
 * Importe: número finito o string decimal (C-16). Un número negativo pasa el esquema a propósito:
 * lo rechaza la conversión a unidades menores con su propio motivo (`AMOUNT_NEGATIVE`), que es lo
 * que se quiere medir aparte de "no es un número".
 */
export const TboDecimalSchema = z.union([
  z.number().finite(),
  z.string().trim().regex(DECIMAL_TEXT),
]);
export type TboDecimal = z.infer<typeof TboDecimalSchema>;

/**
 * Importe opcional: vacío, sólo espacios o `null` es "no vino" (`RecommendedSellingRate` "if any",
 * p. 13). No es cero: un piso de precio de cero no es lo mismo que no tener piso.
 */
const TboOptionalDecimalSchema = z
  .union([TboDecimalSchema, z.string().regex(/^\s*$/), z.null()])
  .optional()
  .transform((value) =>
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
      ? undefined
      : value,
  );

/** Índice de habitación base 1, como número o como texto de dígitos (p. 14; Q-24). */
const RoomIndexSchema = z
  .union([z.number().int(), z.string().trim().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().positive());

/** Moneda ISO 4217 en mayúsculas. Estricto: con dinero no se adivina (`usd` no es `USD`). */
const IsoCurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);

export const TboSupplementSchema = z.object({
  Index: RoomIndexSchema,
  /** `Included`, `AtProperty` u otro: el desconocido se trata como `AtProperty` (02 §9.7). */
  Type: z.string(),
  Description: z.string().nullish(),
  Price: TboDecimalSchema,
  /** Puede no ser la del hotel: `AED` frente a `USD` en p. 15. */
  Currency: IsoCurrencySchema,
});
export type TboSupplement = z.infer<typeof TboSupplementSchema>;

export const TboCancelPolicySchema = z.object({
  /** String en la tabla (p. 14); nunca aparece en un ejemplo. Lo valida el mapper de políticas. */
  Index: z.union([z.string(), z.number()]).nullish(),
  /** `DD-MM-YYYY HH:mm:ss`, sin zona (p. 24, 50). El calendario lo comprueba el mapper. */
  FromDate: z.string().regex(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/),
  ChargeType: z.string(),
  CancellationCharge: TboDecimalSchema,
});
export type TboCancelPolicy = z.infer<typeof TboCancelPolicySchema>;

const TboDayRateSchema = z.object({ BasePrice: TboDecimalSchema });

const RoomIdListSchema = z.array(z.union([z.string(), z.number()])).nullish();

/**
 * Un elemento de `HotelResult[].Rooms[]`: UNA combinación que cubre todas las habitaciones pedidas,
 * con un `BookingCode` y un `TotalFare` (02 §9.3).
 */
export const TboSearchRoomSchema = z.object({
  /** Uno por habitación pedida, en el orden del request (p. 13). */
  Name: z.array(z.string()).min(1),
  /** Opaco (`1120548!TB!2!TB!<uuid>`, p. 15). Techo de `ProviderRef.offerRef`. */
  BookingCode: z.string().min(1).max(255),
  Inclusion: z.string().nullish(),
  /** Sólo con `IsDetailedResponse: true` (p. 11); `DayRates[j][n]`, estructura INFERIDA (Q-21). */
  DayRates: z.array(z.array(TboDayRateSchema)).nullish(),
  TotalFare: TboDecimalSchema,
  TotalTax: TboOptionalDecimalSchema,
  /** Declarado Decimal, llega como string (p. 15, C-16). Sólo informativo (Q-22). */
  ExtraGuestCharges: TboOptionalDecimalSchema,
  /** Declarado String: un importe como texto (p. 13, 15). Piso del waterfall. */
  RecommendedSellingRate: TboOptionalDecimalSchema,
  /** "List of String Array" en la tabla; array plano en los ejemplos (p. 14-15, C-18). */
  RoomPromotion: z.union([z.array(z.string()), z.array(z.array(z.string()))]).nullish(),
  /** Sólo con `IsDetailedResponse: true` (p. 11). */
  CancelPolicies: z.array(TboCancelPolicySchema).nullish(),
  MealType: z.string().nullish(),
  IsRefundable: z.boolean().nullish(),
  WithTransfers: z.boolean().nullish(),
  /** "List of Object" en la tabla; array de arrays en los ejemplos (p. 14-17, C-17). */
  Supplements: z
    .union([z.array(z.array(TboSupplementSchema)), z.array(TboSupplementSchema)])
    .nullish(),
  /** No está en la tabla de Search: sólo en la nota de p. 57, como array de strings (C-29). */
  RoomID: RoomIdListSchema,
  /** El casing de HotelDetails (p. 56-57): se aceptan los dos (02 §9.9). */
  RoomId: RoomIdListSchema,
});
export type TboSearchRoom = z.infer<typeof TboSearchRoomSchema>;

/**
 * Un `HotelResult`. `Currency` y `Rooms` se validan en el mapper para distinguir el motivo del
 * descarte ("sin moneda" no es lo mismo que "moneda con otro exponente"). `HotelCode` es String
 * (p. 13) y el catálogo de TBO lo publica como número (p. 55): se aceptan los dos.
 */
export const TboSearchHotelSchema = z.object({
  HotelCode: z.union([
    z.string().trim().min(1).max(64),
    z
      .number()
      .int()
      .nonnegative()
      .transform((code) => String(code)),
  ]),
  Currency: z.unknown(),
  Rooms: z.array(z.unknown()).nullish(),
});
export type TboSearchHotel = z.infer<typeof TboSearchHotelSchema>;

/** `Code` es Integer (p. 13); el cliente también acepta un string de 3 dígitos. */
const StatusCodeSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{3}$/)
    .transform(Number),
]);

/**
 * El sobre. `.passthrough()` conserva las claves desconocidas de la raíz para registrar sus nombres.
 * `Status` es opcional porque el desenlace ya lo decidió el clasificador del cliente, que acepta
 * variantes de casing (`status`); exigir aquí la grafía del PDF convertiría esa variante en una
 * búsqueda fallida. Sin `HotelResult` —el `201` de p. 18 no lo trae— no hay hoteles.
 */
export const TboSearchEnvelopeSchema = z
  .object({
    Status: z
      .object({ Code: StatusCodeSchema, Description: z.string().nullish() })
      .passthrough()
      .optional(),
    HotelResult: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type TboSearchEnvelope = z.infer<typeof TboSearchEnvelopeSchema>;

// Las claves conocidas salen de los propios esquemas: una lista escrita a mano derivaría en la
// siguiente edición y empezaría a reportar como "desconocido" un campo que sí se lee.
export const TBO_SEARCH_ROOT_KEYS: readonly string[] = Object.keys(TboSearchEnvelopeSchema.shape);
export const TBO_SEARCH_HOTEL_KEYS: readonly string[] = Object.keys(TboSearchHotelSchema.shape);
export const TBO_SEARCH_ROOM_KEYS: readonly string[] = Object.keys(TboSearchRoomSchema.shape);
export const TBO_SUPPLEMENT_KEYS: readonly string[] = Object.keys(TboSupplementSchema.shape);
export const TBO_CANCEL_POLICY_KEYS: readonly string[] = Object.keys(TboCancelPolicySchema.shape);
export const TBO_DAY_RATE_KEYS: readonly string[] = Object.keys(TboDayRateSchema.shape);
