import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';
import type { TboCity, TboCityListMapping } from './content.types';
import { TboStaticObserver, type TboStaticMapDeps } from './observer';
import {
  TBO_CITY_ITEM_KEYS,
  TBO_STATIC_ROOT_KEYS,
  TboCityItemSchema,
  type TboCityListEnvelope,
} from './response.schema';

/**
 * `POST CityList` → ciudades del país pedido (docs/tbo/05 §2.3, p. 53-54). Etapa E2 del sync:
 * alimenta `hotel_provider_city`.
 *
 * Cada ciudad trae sólo `Code` y `Name` (p. 54): el país es el de la REQUEST y viaja en el
 * contexto. `Code` se declara Integer y llega como string; se guarda como string (05 §7.2). El
 * nombre normalizado para buscar (`name_norm`) lo calcula el sync (0041), no el ACL.
 */
export interface TboCityListMapContext {
  /** ISO2 con que se pidió `CityList`. */
  readonly countryCode: string;
}

export function mapTboCityListResponse(
  envelope: TboCityListEnvelope,
  context: TboCityListMapContext,
  deps: TboStaticMapDeps = {},
): TboCityListMapping {
  if (!/^[A-Z]{2}$/.test(context.countryCode)) {
    throw new TboResponseMappingError(TBO_OPERATIONS.cityList.path, [
      'context.countryCode:invalid_string',
    ]);
  }
  const observer = new TboStaticObserver('cityList', deps);
  observer.assertSuccess(envelope.Status);
  observer.collectUnknownKeys(envelope, TBO_STATIC_ROOT_KEYS.cityList, '');

  const cities: TboCity[] = [];
  const seen = new Set<string>();
  observer.container(envelope.CityList, 'CityList').forEach((raw, index) => {
    observer.received += 1;
    observer.collectUnknownKeys(raw, TBO_CITY_ITEM_KEYS, 'CityList[].');
    const parsed = TboCityItemSchema.safeParse(raw);
    if (!parsed.success) {
      observer.reject('ITEM_SCHEMA', zodIssueRefs(parsed.error, `CityList.${index}`));
      return;
    }
    const { Code: code, Name: name } = parsed.data;
    if (seen.has(code)) {
      observer.reject('DUPLICATE', [`CityList.${index}.Code:duplicated`]);
      return;
    }
    seen.add(code);
    cities.push({ code, name, countryCode: context.countryCode });
    observer.mapped += 1;
  });

  return { countryCode: context.countryCode, cities, diagnostics: observer.finish() };
}
