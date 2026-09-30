/**
 * Lo que el ACL entrega del contenido estático de TBO (docs/tbo/05 §3-§4 y §7.3; 08 RF-32 y
 * RNF-16). Son tipos NUESTROS, ya normalizados: el esquema crudo de TBO no sale del paquete
 * (08 RF-07 CA-6) y el sync escribe estas formas en `hotel_inventory`, `hotel_provider_city` y
 * `hotel_content` sin volver a mirar el JSON del proveedor.
 *
 * Todo campo que TBO puede no mandar es `null`, nunca un valor inventado: un `0` de estrellas o un
 * `0|0` de coordenadas tienen forma de dato real y harían daño en los filtros y en el dedupe.
 */

/**
 * Idiomas de contenido. Los mismos valores que `LanguageCodeSchema` de `@sales-travel/validation`
 * y que el `CHECK` de `hotel_content.lang` (0041); el builder de HotelDetails los traduce al código
 * en mayúsculas de TBO (p. 58; 05 §10).
 */
export const TBO_CONTENT_LANGUAGES = ['es', 'pt', 'en'] as const;
export type TboContentLanguage = (typeof TBO_CONTENT_LANGUAGES)[number];

/**
 * Qué llamada produjo el contenido. Mismos valores que `hotel_content.source` (0041): `details` es
 * HotelDetails, pedido por idioma y con imágenes; `listing` es el texto que llega de paso en
 * TBOHotelCodeList, sin idioma pedido y sin imágenes (05 §6.3, E3).
 */
export type TboContentSource = 'details' | 'listing';

/** Un país de `CountryList` (p. 52). `code` es ISO 3166-1 alfa-2 en mayúsculas. */
export interface TboCountry {
  readonly code: string;
  /** En inglés y a veces abreviado (`Antigua`, p. 52): la UI usa sus propios nombres por ISO2. */
  readonly name: string;
}

/** Una ciudad de `CityList` (p. 54). El país es el que se pidió: la ciudad no lo trae. */
export interface TboCity {
  /** `provider_city_code`: string aunque la tabla diga Integer (p. 54; 05 §7.2). */
  readonly code: string;
  readonly name: string;
  readonly countryCode: string;
}

export interface TboGeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Un hotel del catálogo: las columnas de `hotel_inventory` que llena TBO (05 §7.1). `property_type`
 * y `merged_ids` no están: TBO no los tiene.
 */
export interface TboCatalogHotel {
  readonly hotelId: string;
  readonly name: string | null;
  /** 1 a 5, con medias estrellas; `null` sin clasificación o con un valor desconocido (Q-68). */
  readonly stars: number | null;
  /**
   * En TBOHotelCodeList, `Latitude`/`Longitude` si son válidas y, si no, `Map`; en HotelDetails,
   * `Map`. `null` si ninguna sirve: falta, malformada, fuera de rango o `0|0`.
   */
  readonly location: TboGeoPoint | null;
  /** Tal cual, sin parsear: se llama "first line" y trae la dirección entera (CE-12). */
  readonly address: string | null;
  readonly zipcode: string | null;
  /** ISO2 del hotel o, si no es válido, el del país con que se pidió la ciudad. */
  readonly countryCode: string | null;
  /**
   * En TBOHotelCodeList, el `CityCode` de la REQUEST: el ejemplo no trae `CityId` (p. 66-69;
   * 05 §2.5). En HotelDetails, su `CityId`, si vino.
   */
  readonly cityCode: string | null;
}

/** Una sección `<p>Etiqueta : texto</p>` de `Description`, en texto plano (05 §3). */
export interface TboContentSection {
  readonly label: string;
  readonly text: string;
}

/**
 * Contenido de un hotel en un idioma: las columnas de `hotel_content` (0041), más el texto plano
 * para WhatsApp y la lista de servicios negados.
 */
export interface TboHotelContent {
  readonly hotelId: string;
  /**
   * En `listing` es `en` por INFERENCIA: TBOHotelCodeList no tiene parámetro de idioma y sus
   * ejemplos están en inglés (p. 65-69; Q-66).
   */
  readonly lang: TboContentLanguage;
  readonly source: TboContentSource;
  readonly name: string | null;
  /** Saneado con lista blanca (`p`, `br`, `b`, `ul`, `li`), sin atributos (RNF-16). */
  readonly descriptionHtml: string | null;
  /** Texto plano derivado del HTML saneado, para WhatsApp y B2C (principio 5 de CLAUDE.md). */
  readonly descriptionText: string | null;
  readonly sections: readonly TboContentSection[];
  /** Sólo los servicios disponibles: un "… – no" nunca aparece aquí (RF-32). */
  readonly facilities: readonly string[];
  /** Los servicios que TBO lista negados, sin el sufijo: "Wheelchair accessible" (p. 61). */
  readonly unavailableFacilities: readonly string[];
  /** Saneado igual que la descripción; un solo HTML aunque TBO lo mande partido (CE-10). */
  readonly attractionsHtml: string | null;
  /** URLs absolutas `https` (RNF-16). Se guarda la URL, no se copia la imagen (Q-67). */
  readonly images: readonly string[];
  readonly phone: string | null;
  /** `http` o `https`: es un enlace, no un recurso embebido, así que no hay contenido mixto. */
  readonly websiteUrl: string | null;
  /** `HH:mm` en 24 horas (`"3:00 PM"` → `15:00`, p. 62). */
  readonly checkInTime: string | null;
  readonly checkOutTime: string | null;
}

/**
 * Por qué un elemento de una lista de TBO no salió del mapper. Nunca tumba la respuesta: se
 * descarta, se cuenta y el resto sigue (mismo criterio que Search, 02 §10).
 */
export type TboStaticRejection =
  /** Sin código legible o sin nombre donde el nombre es obligatorio (`hotel_provider_city.name`). */
  | 'ITEM_SCHEMA'
  /** El mismo código dos veces en una respuesta: gana el primero. */
  | 'DUPLICATE'
  /** HotelDetails devolvió un código que no se pidió. */
  | 'NOT_REQUESTED';

/**
 * Normalizaciones que cambiaron o descartaron un dato sin descartar el elemento. Son las cifras
 * con que el sync detecta un cambio del contrato sin mirar valores (08 §9 C-12).
 */
export type TboStaticNote =
  /** `Status.Code` 200 sin el contenedor: lista vacía, que el sync nunca usa para barrer. */
  | 'CONTAINER_MISSING'
  /** Contenedor declarado Object que llegó como objeto único y se leyó como lista de uno (CE-01). */
  | 'CONTAINER_SINGLE_OBJECT'
  /** Una clave que sólo coincide sin distinguir mayúsculas (`HotelWebsiteURL`, CE-09). */
  | 'CASING_VARIANT'
  /** Un campo con un tipo que ni la tabla ni los ejemplos admiten: se ignora ese campo. */
  | 'FIELD_INVALID'
  | 'STARS_UNKNOWN'
  | 'MAP_INVALID'
  | 'MAP_ZERO'
  /** `Latitude`/`Longitude` que no dan un punto (falta una, no es número, fuera de rango): va `Map`. */
  | 'LAT_LNG_INVALID'
  /** `Latitude` y `Longitude` en cero: dato vacío, como `Map` `0|0`; va `Map`. */
  | 'LAT_LNG_ZERO'
  | 'COUNTRY_INVALID'
  | 'COUNTRY_FROM_CITY'
  | 'IMAGE_DROPPED'
  | 'WEBSITE_DROPPED'
  | 'CHECK_TIME_INVALID'
  /** El saneador quitó al menos una etiqueta, un atributo o un bloque del HTML de TBO. */
  | 'HTML_SANITIZED'
  | 'FACILITY_NEGATED';

export interface TboStaticDiagnostics {
  readonly received: number;
  readonly mapped: number;
  readonly rejected: Readonly<Partial<Record<TboStaticRejection, number>>>;
  readonly notes: Readonly<Partial<Record<TboStaticNote, number>>>;
  /** Nombres de claves que el ACL no conoce, con su ruta. Nunca valores. */
  readonly unknownKeys: readonly string[];
}

export interface TboCountryListMapping {
  readonly countries: readonly TboCountry[];
  readonly diagnostics: TboStaticDiagnostics;
}

export interface TboCityListMapping {
  readonly countryCode: string;
  readonly cities: readonly TboCity[];
  readonly diagnostics: TboStaticDiagnostics;
}

export interface TboCityHotelsMapping {
  readonly cityCode: string;
  readonly hotels: readonly TboCatalogHotel[];
  /**
   * Contenido `listing` de los hoteles que trajeron algo de texto. El sync lo escribe sólo si
   * todavía no hay contenido `details` en inglés (05 §6.3).
   */
  readonly listingContents: readonly TboHotelContent[];
  readonly diagnostics: TboStaticDiagnostics;
}

/**
 * Cómo contestó HotelDetails a UN lote en UN idioma:
 *
 * - `DETAILS`: `Status.Code` 200. Lo que volvió está en `contents`; lo pedido que no volvió, en
 *   `missingHotelCodes`: TBO no tiene contenido de ese hotel en ese idioma.
 * - `NO_HOTELS_FOUND`: `Status.Code` 500 "No Hotels Found" rápido, con HTTP 200 (producción,
 *   2026-09-30; 05 CE-23). TBO no dio NADA del lote en ese idioma, y no se sabe si ningún código
 *   tiene contenido en ese idioma (H1) o si uno sin contenido tumba el lote entero (H2, Q-62): por
 *   eso `missingHotelCodes` son todos y no confirma nada de cada código por separado. Quien llama
 *   decide si pide el respaldo o parte el lote (`resolveTboHotelDetails`).
 */
export type TboHotelDetailsOutcome = 'DETAILS' | 'NO_HOTELS_FOUND';

export interface TboHotelDetailsMapping {
  readonly lang: TboContentLanguage;
  readonly outcome: TboHotelDetailsOutcome;
  readonly contents: readonly TboHotelContent[];
  /** Lo que HotelDetails trae del catálogo (nombre, estrellas, `Map`, `CityId`). */
  readonly hotels: readonly TboCatalogHotel[];
  /**
   * Pedidos que no volvieron. Con `DETAILS`, TBO no tiene contenido de esos en ese idioma; con
   * `NO_HOTELS_FOUND`, son todos los pedidos y no dicen nada de cada uno (Q-62).
   */
  readonly missingHotelCodes: readonly string[];
  readonly diagnostics: TboStaticDiagnostics;
}

export interface TboHotelCodeListMapping {
  /** Todos los códigos activos de TBO, como string (p. 55 los manda como enteros). */
  readonly hotelCodes: readonly string[];
  readonly diagnostics: TboStaticDiagnostics;
}
