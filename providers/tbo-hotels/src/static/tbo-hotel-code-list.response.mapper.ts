import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';
import type { TboCatalogHotel, TboCityHotelsMapping, TboHotelContent } from './content.types';
import { readTboHotelRecord } from './hotel-record';
import { TboStaticObserver, type TboStaticMapDeps } from './observer';
import {
  TBO_CITY_HOTEL_FIELD_KEYS,
  TBO_STATIC_ROOT_KEYS,
  TboHotelItemSchema,
  TboStaticCodeSchema,
  type TboCityHotelsEnvelope,
} from './response.schema';

/**
 * `POST TBOHotelCodeList` → hoteles de UNA ciudad (docs/tbo/05 §2.5, p. 65-69). Etapa E3 del sync:
 * `hotel_inventory` con `provider_code = 'tbo-hotels'`, más el texto `listing` para que el detalle
 * tenga algo desde el primer día.
 *
 * - **La ciudad de cada hotel es la de la REQUEST**, no la de la respuesta: el ejemplo no trae
 *   `CityId` aunque la tabla lo declare (p. 66-69; 05 §2.5; Q-64).
 * - **El país**: el `CountryCode` ISO2 del hotel (`"US"`, p. 68) o, si no es válido, el país con
 *   que se pidió la ciudad (05 §3).
 * - **Un hotel sin `HotelCode` legible se descarta**; los demás siguen. Uno repetido también se
 *   descarta (gana el primero). Nunca se lanza por un hotel: una ciudad que pierde hoteles por un
 *   error de lectura se barrería del catálogo, y la guarda de caída máxima del sync (05 §6.5)
 *   necesita ver el conteo real de descartes.
 * - **El contenido es `listing`, en inglés por inferencia** (sin parámetro de idioma, p. 65; Q-66).
 *   `TBOHotelCodeList` no trae imágenes ni horarios (CE-09): esos campos quedan vacíos.
 * - **Coordenadas**: `Latitude`/`Longitude` de cada hotel, que TBO manda aunque el PDF no las
 *   documente (producción, 2026-09-29), y si no sirven, `Map` (05 §2.5 y §3).
 */
export interface TboCityHotelsMapContext {
  /** `CityCode` con que se pidió la lista. */
  readonly cityCode: string;
  /** ISO2 del país de la ciudad, si se conoce: respaldo del `CountryCode` de cada hotel. */
  readonly countryCode?: string;
}

function readContext(context: TboCityHotelsMapContext): {
  readonly cityCode: string;
  readonly countryCode: string | undefined;
} {
  const issues: string[] = [];
  const city = TboStaticCodeSchema.safeParse(context.cityCode);
  if (!city.success) issues.push(...zodIssueRefs(city.error, 'context.cityCode'));
  const country = context.countryCode;
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) {
    issues.push('context.countryCode:invalid_string');
  }
  if (!city.success || issues.length > 0) {
    throw new TboResponseMappingError(TBO_OPERATIONS.tboHotelCodeList.path, issues);
  }
  return { cityCode: city.data, countryCode: country };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mapTboCityHotelsResponse(
  envelope: TboCityHotelsEnvelope,
  context: TboCityHotelsMapContext,
  deps: TboStaticMapDeps = {},
): TboCityHotelsMapping {
  const { cityCode, countryCode } = readContext(context);
  const observer = new TboStaticObserver('tboHotelCodeList', deps);
  observer.assertSuccess(envelope.Status);
  observer.collectUnknownKeys(envelope, TBO_STATIC_ROOT_KEYS.tboHotelCodeList, '');

  const hotels: TboCatalogHotel[] = [];
  const listingContents: TboHotelContent[] = [];
  const seen = new Set<string>();
  observer.container(envelope.Hotels, 'Hotels').forEach((raw, index) => {
    observer.received += 1;
    observer.collectUnknownKeys(raw, TBO_CITY_HOTEL_FIELD_KEYS, 'Hotels[].');
    const parsed = TboHotelItemSchema.safeParse(raw);
    if (!parsed.success || !isRecord(raw)) {
      observer.reject(
        'ITEM_SCHEMA',
        parsed.success
          ? [`Hotels.${index}:invalid_type`]
          : zodIssueRefs(parsed.error, `Hotels.${index}`),
      );
      return;
    }
    const hotelId = parsed.data.HotelCode;
    if (seen.has(hotelId)) {
      observer.reject('DUPLICATE', [`Hotels.${index}.HotelCode:duplicated`]);
      return;
    }
    seen.add(hotelId);

    const record = readTboHotelRecord(raw, {
      observer,
      at: `Hotels.${index}`,
      hotelId,
      lang: 'en',
      source: 'listing',
      requestCityCode: cityCode,
      latitudeLongitude: true,
      ...(countryCode === undefined ? {} : { fallbackCountryCode: countryCode }),
    });
    hotels.push(record.hotel);
    if (record.hasContent) listingContents.push(record.content);
    observer.mapped += 1;
  });

  return { cityCode, hotels, listingContents, diagnostics: observer.finish() };
}

/**
 * La ciudad sin hoteles: TBO contestó `Status.Code` 500 "No Hotels Found" y el cliente HTTP ya lo
 * clasificó como resultado vacío (01 §8.5). No hay cuerpo que leer; la ciudad es la de la request,
 * validada igual que en una respuesta con hoteles. El sync la guarda con `hotel_count = 0` y nunca
 * barre con ella una ciudad que tenía hoteles (05 §6.5).
 */
export function emptyTboCityHotelsMapping(
  context: TboCityHotelsMapContext,
  deps: TboStaticMapDeps = {},
): TboCityHotelsMapping {
  const { cityCode } = readContext(context);
  const observer = new TboStaticObserver('tboHotelCodeList', deps);
  return { cityCode, hotels: [], listingContents: [], diagnostics: observer.finish() };
}
