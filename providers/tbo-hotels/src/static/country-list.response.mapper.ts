import { zodIssueRefs } from '../internal/zod-issues';
import type { TboCountry, TboCountryListMapping } from './content.types';
import { TboStaticObserver, type TboStaticMapDeps } from './observer';
import {
  TBO_COUNTRY_ITEM_KEYS,
  TBO_STATIC_ROOT_KEYS,
  TboCountryItemSchema,
  type TboCountryListEnvelope,
} from './response.schema';

/**
 * `GET CountryList` → países ISO2 (docs/tbo/05 §2.2, p. 51-53). La etapa E1 del sync los usa para
 * comprobar que cada país habilitado existe en TBO antes de pedir sus ciudades.
 *
 * Un país sin código ISO2 o sin nombre se descarta y se cuenta; uno repetido, también (gana el
 * primero). Nunca lanza por un elemento: sólo por un `Status.Code` que no es de éxito, que sería un
 * error de cableado.
 */
export function mapTboCountryListResponse(
  envelope: TboCountryListEnvelope,
  deps: TboStaticMapDeps = {},
): TboCountryListMapping {
  const observer = new TboStaticObserver('countryList', deps);
  observer.assertSuccess(envelope.Status);
  observer.collectUnknownKeys(envelope, TBO_STATIC_ROOT_KEYS.countryList, '');

  const countries: TboCountry[] = [];
  const seen = new Set<string>();
  observer.container(envelope.CountryList, 'CountryList').forEach((raw, index) => {
    observer.received += 1;
    observer.collectUnknownKeys(raw, TBO_COUNTRY_ITEM_KEYS, 'CountryList[].');
    const parsed = TboCountryItemSchema.safeParse(raw);
    if (!parsed.success) {
      observer.reject('ITEM_SCHEMA', zodIssueRefs(parsed.error, `CountryList.${index}`));
      return;
    }
    const { Code: code, Name: name } = parsed.data;
    if (seen.has(code)) {
      observer.reject('DUPLICATE', [`CountryList.${index}.Code:duplicated`]);
      return;
    }
    seen.add(code);
    countries.push({ code, name });
    observer.mapped += 1;
  });

  return { countries, diagnostics: observer.finish() };
}
