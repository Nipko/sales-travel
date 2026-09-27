import { HotelProviderCodeSchema } from '@sales-travel/canonical';
import type { HotelDestinationSuggestion, ProviderDestinationId } from '@sales-travel/domain';

/**
 * El destino de una búsqueda de hoteles y las sugerencias que salen del catálogo local
 * (docs/tbo/05 §8.5). Sin I/O: el SQL vive en `HotelsService`, junto al resto del catálogo.
 */

// ───────────────────────── Destino de la búsqueda ─────────────────────────

/**
 * Qué ciudad pidió el vendedor, según el espacio de ids en que llegó.
 *
 * - `platform`: el `city_id` del autocompletado de la plataforma (hoy, Despegar). Cada proveedor
 *   lo resuelve como siempre: por `city_id` o, con ids propios, por el mapa de destinos.
 * - `provider`: una ciudad del catálogo local de UN proveedor con ids propios. Sólo ese proveedor
 *   la busca, directo por su código de ciudad; los demás no tienen cómo traducirla.
 */
export type HotelDestination =
  | { readonly space: 'platform'; readonly cityId: number }
  | { readonly space: 'provider'; readonly providerCode: string; readonly cityCode: string };

/**
 * Código de ciudad del proveedor dentro del id. Sin `:`, así el separador es único, y con lo que
 * admite un código de hotel en la ruta de contenido. El de TBO es alfanumérico (CityList, p. 54).
 */
const PROVIDER_CITY_CODE = /^[A-Za-z0-9._-]{1,64}$/;

export const PROVIDER_DESTINATION_INVALID =
  'Destino inválido: elegí una ciudad del autocompletado (formato proveedor:ciudad).';

/** `tbo-hotels` + `150184` → `tbo-hotels:150184`. */
export function providerDestinationId(
  providerCode: string,
  cityCode: string,
): ProviderDestinationId {
  return `${providerCode}:${cityCode}`;
}

/** Proveedor y ciudad de un {@link ProviderDestinationId}, o `undefined` si no tiene esa forma. */
export function parseProviderDestinationId(
  value: string,
): { readonly providerCode: string; readonly cityCode: string } | undefined {
  const separator = value.indexOf(':');
  if (separator < 0) return undefined;
  const providerCode = value.slice(0, separator);
  const cityCode = value.slice(separator + 1);
  if (!HotelProviderCodeSchema.safeParse(providerCode).success) return undefined;
  if (!PROVIDER_CITY_CODE.test(cityCode)) return undefined;
  return { providerCode, cityCode };
}

export function isProviderDestinationId(value: string): value is ProviderDestinationId {
  return parseProviderDestinationId(value) !== undefined;
}

/**
 * El `destinationId` ya validado por el borde, en su espacio. Un texto sin la forma del
 * proveedor no es un destino: el borde no lo deja pasar, y quien llame al servicio sin pasar por
 * él obtiene "sin destino" en vez de hoteles de otra ciudad.
 */
export function destinationOf(
  destinationId: number | ProviderDestinationId | undefined,
): HotelDestination | undefined {
  if (destinationId === undefined) return undefined;
  if (typeof destinationId === 'number') return { space: 'platform', cityId: destinationId };
  const parsed = parseProviderDestinationId(destinationId);
  return parsed === undefined ? undefined : { space: 'provider', ...parsed };
}

/**
 * El destino tal como queda en `search_logs.criteria`. El de la plataforma conserva la clave
 * `destinationId` con el número, que es lo que lee el sync de TBO para medir la demanda y listar
 * destinos sin mapeo (`tools/sync-tbo-hotel-inventory/src/writer.ts`). Una ciudad del catálogo
 * local va en claves propias: con el id en `destinationId`, el sync la listaría como un destino de
 * la plataforma sin mapear.
 */
export function destinationCriteria(
  destination: HotelDestination | undefined,
): Record<string, string | number> {
  if (destination === undefined) return {};
  if (destination.space === 'platform') return { destinationId: destination.cityId };
  return {
    destinationProvider: destination.providerCode,
    destinationCityCode: destination.cityCode,
  };
}

// ───────────────────────── Sugerencias del catálogo local ─────────────────────────

/** Tantas como muestra el combobox sin desplazarse de más. */
export const CATALOG_SUGGESTION_LIMIT = 10;

/**
 * Similitud trigram mínima para sugerir una ciudad que NO contiene lo escrito: tolera una letra
 * cambiada o de menos ("bogta" → "bogota" es 0,44) sin llenar la lista de nombres parecidos por
 * dos letras. Las que contienen lo escrito salen siempre, antes.
 */
export const CATALOG_SUGGESTION_MIN_SIMILARITY = 0.4;

/**
 * Lo que escribió el vendedor, en la forma de `hotel_provider_city.name_norm`: minúsculas, sin
 * acentos ni puntuación y con los espacios colapsados. Es el MISMO algoritmo que `normalizeName`
 * del sync que llena la columna (`tools/sync-tbo-hotel-inventory/src/catalog-rules.ts`), con sus
 * mismos casos en el test: si divergen, "Bogotá" deja de encontrar "bogota".
 *
 * El resultado sólo tiene letras, dígitos y espacios, así que puede ir dentro de un `LIKE` sin
 * escapar: `%`, `_` y `\` son puntuación y se vuelven espacio.
 */
export function normalizeCityName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Una fila de `hotel_provider_city` tal como la lee la sugerencia. */
export interface CatalogCityRow {
  readonly provider_code: string;
  readonly provider_city_code: string;
  readonly name: string;
  readonly country_code: string;
}

const SUGGESTION_LANGUAGES = ['es', 'pt', 'en'] as const;
type SuggestionLanguage = (typeof SUGGESTION_LANGUAGES)[number];

/** `es_CO`, `pt-BR`, `EN` → idioma del nombre del país. Sin uno conocido, español: el del panel. */
export function suggestionLanguageOf(locale: string | undefined): SuggestionLanguage {
  const language = /^([A-Za-z]{2})(?:[-_]|$)/.exec(locale ?? '')?.[1]?.toLowerCase();
  return SUGGESTION_LANGUAGES.find((l) => l === language) ?? 'es';
}

const countryNames = new Map<SuggestionLanguage, Intl.DisplayNames>();

/**
 * Nombre del país en el idioma del vendedor. `hotel_provider_city` sólo guarda el ISO2 y el
 * proveedor no da el nombre: sale del ICU de Node, sin tabla que mantener. Un código que el ICU no
 * conoce sale tal cual, que es mejor que nada.
 */
export function countryNameOf(countryCode: string, language: SuggestionLanguage): string {
  const code = countryCode.trim().toUpperCase();
  try {
    let names = countryNames.get(language);
    if (names === undefined) {
      names = new Intl.DisplayNames([language], { type: 'region', fallback: 'code' });
      countryNames.set(language, names);
    }
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Una ciudad del catálogo como sugerencia. El id lleva el proveedor —es lo que la búsqueda
 * necesita para ir directo a su ciudad— y es también el `gid`, la clave de la lista. El nombre es
 * el del proveedor, el único que hay (CityList no tiene idioma, p. 53-54), y abajo va el país: la
 * sugerencia no dice de qué proveedor es, porque la divulgación del proveedor es un ajuste de la
 * agencia (RF-40) y aquí no se consulta.
 */
export function catalogSuggestionOf(
  row: CatalogCityRow,
  language: SuggestionLanguage,
): HotelDestinationSuggestion {
  const id = providerDestinationId(row.provider_code, row.provider_city_code);
  return {
    id,
    gid: id,
    type: 0,
    display: row.name.trim(),
    country: countryNameOf(row.country_code, language),
  };
}
