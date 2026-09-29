import { z } from 'zod';

/**
 * Zod de las respuestas de contenido estático (docs/tbo/05 §2-§3; 08 RF-32 y §9 C-13).
 *
 * El contrato no cumple sus propias tablas (05 §3): contenedores declarados Object llegan como
 * array, campos Integer llegan como string, campos String llegan como array u objeto. La regla es
 * aceptar lo declarado Y lo observado, y entregar un solo tipo canónico. Tres niveles, como Search:
 *
 * 1. **Sobre**: `Status` y el contenedor, que puede faltar, ser `null`, array u objeto único. Es el
 *    `responseSchema` que valida el cliente HTTP; un escalar en el contenedor es ilegible.
 * 2. **Elemento**: sólo la clave que lo identifica (`Code`, `HotelCode`). Un elemento sin ella se
 *    descarta y se cuenta; los demás siguen.
 * 3. **Campo**: cada campo opcional se lee con su esquema; uno con un tipo imposible se ignora y
 *    se cuenta, sin tirar el hotel. Un hotel que falta en una corrida se barre del catálogo, así
 *    que perderlo por un campo decorativo roto es peor que guardarlo sin ese campo.
 *
 * Los tipos de este archivo son crudos de TBO: no salen del paquete (08 RF-07 CA-6).
 */

/** `Code` es Integer (p. 52-67); el cliente también acepta un string de 3 dígitos. */
const StatusCodeSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{3}$/)
    .transform(Number),
]);

/**
 * `Status` es opcional por la misma razón que en Search: el desenlace ya lo decidió el clasificador
 * del cliente, que acepta variantes de casing; y en `hotelcodelist` no viene (p. 55).
 */
const StatusSchema = z
  .object({ Code: StatusCodeSchema, Description: z.string().nullish() })
  .passthrough()
  .optional();

/**
 * Un contenedor de lista: array (lo observado), objeto único (lo declarado, "Object") o ausente.
 * Lo convierte en lista el mapper, que es quien cuenta cuál de las formas llegó.
 */
const ContainerSchema = z
  .union([z.array(z.unknown()), z.record(z.string(), z.unknown()), z.null()])
  .optional();

export const TboCountryListEnvelopeSchema = z
  .object({ Status: StatusSchema, CountryList: ContainerSchema })
  .passthrough();
export type TboCountryListEnvelope = z.infer<typeof TboCountryListEnvelopeSchema>;

export const TboCityListEnvelopeSchema = z
  .object({ Status: StatusSchema, CityList: ContainerSchema })
  .passthrough();
export type TboCityListEnvelope = z.infer<typeof TboCityListEnvelopeSchema>;

/** TBOHotelCodeList (p. 65-69). */
export const TboCityHotelsEnvelopeSchema = z
  .object({ Status: StatusSchema, Hotels: ContainerSchema })
  .passthrough();
export type TboCityHotelsEnvelope = z.infer<typeof TboCityHotelsEnvelopeSchema>;

export const TboHotelDetailsEnvelopeSchema = z
  .object({ Status: StatusSchema, HotelDetails: ContainerSchema })
  .passthrough();
export type TboHotelDetailsEnvelope = z.infer<typeof TboHotelDetailsEnvelopeSchema>;

/**
 * `hotelcodelist` (p. 55). Aquí el contenedor es OBLIGATORIO: esta lista decide qué hoteles se dan
 * de baja (E5, 05 §6.3), y leer "falta la lista" como "no hay hoteles" desactivaría el catálogo
 * entero. Mejor un error que el sync trata como "E5 no desactiva nada" (08 RF-30 CA-3).
 */
export const TboHotelCodeListEnvelopeSchema = z
  .object({ Status: StatusSchema, HotelCodes: z.array(z.unknown()) })
  .passthrough();
export type TboHotelCodeListEnvelope = z.infer<typeof TboHotelCodeListEnvelopeSchema>;

// ───────────────────────── Elementos ─────────────────────────

/**
 * Código de TBO (ciudad u hotel): string o entero según el método (05 §3, CE-01) → string sin
 * espacios. Sólo alfanumérico: el builder de Search arma `HotelCodes` como CSV y rechaza cualquier
 * otro carácter (S-01), así que un código que no cumple no se podría buscar después.
 */
export const TboStaticCodeSchema = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform((value) => String(value).trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9]+$/),
  );

/** Nombre obligatorio: `hotel_provider_city.name` es `NOT NULL` (0041). */
const RequiredNameSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(300));

/** `CountryList[]`: "ISO Country code (eg. AE)" (p. 52). Se admite minúscula y se sube. */
export const TboCountryItemSchema = z.object({
  Code: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/)),
  Name: RequiredNameSchema,
});

/** `CityList[]`: `Code` Integer en la tabla y string en el ejemplo (p. 54). */
export const TboCityItemSchema = z.object({ Code: TboStaticCodeSchema, Name: RequiredNameSchema });

/** `Hotels[]` y `HotelDetails[]`: sólo la clave. El resto son campos (nivel 3). */
export const TboHotelItemSchema = z.object({ HotelCode: TboStaticCodeSchema });

// ───────────────────────── Campos ─────────────────────────

/** Texto: String en la tabla; `PinCode` y `FaxNumber` se declaran Integer y llegan string (p. 62). */
export const TboTextFieldSchema = z.union([z.string(), z.number().finite()]);

/** `HotelRating`: enum `"ThreeStar"` (p. 67) o número `5` (p. 62), según el método (CE-02). */
export const TboRatingFieldSchema = z.union([z.string(), z.number()]);

/**
 * `Latitude` / `Longitude` de TBOHotelCodeList: no están en el PDF y llegan en producción
 * (2026-09-29, 05 §2.5). El log sólo dio sus nombres, así que se admite número o string; que sea
 * un número en rango lo decide `normalizeTboLatLng`.
 */
export const TboCoordinateFieldSchema = z.union([z.number(), z.string()]);

/** `HotelFacilities`, `Images`: String en la tabla, array en los ejemplos (p. 60-62, 68-69). */
export const TboListFieldSchema = z.union([z.array(z.unknown()), z.string()]);

/**
 * `Attractions`: array de trozos de un HTML (TBOHotelCodeList, p. 67-68), objeto `{"1) ": …}`
 * (HotelDetails, p. 61) o el String de la tabla (CE-10).
 */
export const TboAttractionsFieldSchema = z.union([
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
  z.string(),
]);

/**
 * Claves que el ACL lee de cada nivel, en minúsculas: el mapper las compara sin distinguir
 * mayúsculas y registra el NOMBRE de las demás (C-12). `hotelwebsiteurl` cubre las dos grafías,
 * `HotelWebsiteURL` de la tabla y `HotelWebsiteUrl` del ejemplo (CE-09).
 */
export const TBO_STATIC_ROOT_KEYS = Object.freeze({
  countryList: ['status', 'countrylist'],
  cityList: ['status', 'citylist'],
  tboHotelCodeList: ['status', 'hotels'],
  hotelDetails: ['status', 'hoteldetails'],
  hotelCodeList: ['status', 'hotelcodes'],
} as const);

export const TBO_COUNTRY_ITEM_KEYS: readonly string[] = ['code', 'name'];
export const TBO_CITY_ITEM_KEYS: readonly string[] = ['code', 'name'];

/**
 * Los campos de un hotel en TBOHotelCodeList (p. 66) y en HotelDetails (p. 58-59). `CountryName`,
 * `CityName` y `FaxNumber` se conocen y no se usan: la UI nombra países y ciudades por su código, y
 * el fax no tiene columna.
 */
export const TBO_HOTEL_FIELD_KEYS: readonly string[] = [
  'hotelcode',
  'hotelname',
  'hotelrating',
  'address',
  'attractions',
  'countryname',
  'countrycode',
  'description',
  'faxnumber',
  'hotelfacilities',
  'map',
  'phonenumber',
  'pincode',
  'cityid',
  'hotelwebsiteurl',
  'cityname',
  'images',
  'checkintime',
  'checkouttime',
];

/**
 * TBOHotelCodeList conoce además `Latitude` y `Longitude`: la primera corrida del sync en producción
 * (2026-09-29) las registró como claves desconocidas en todas las ciudades con hoteles. HotelDetails
 * no las trajo nunca, así que allí siguen siendo desconocidas: si aparecen, el log lo dice.
 */
export const TBO_CITY_HOTEL_FIELD_KEYS: readonly string[] = [
  ...TBO_HOTEL_FIELD_KEYS,
  'latitude',
  'longitude',
];
