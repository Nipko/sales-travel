import { describe, expect, it } from 'vitest';
import {
  catalogSuggestionOf,
  countryNameOf,
  destinationCriteria,
  destinationOf,
  normalizeCityName,
  parseProviderDestinationId,
  providerDestinationId,
  suggestionLanguageOf,
} from './hotel-destination.js';

/**
 * El destino de la búsqueda y las sugerencias del catálogo local (docs/tbo/05 §8.5), sin base: la
 * forma del id que viaja entre el autocompletado y la búsqueda, la normalización que tiene que
 * coincidir con la del sync y lo que ve el vendedor en cada sugerencia.
 */

describe('id de destino de un proveedor', () => {
  it('ida y vuelta: proveedor y ciudad', () => {
    const id = providerDestinationId('tbo-hotels', '150184');
    expect(id).toBe('tbo-hotels:150184');
    expect(parseProviderDestinationId(id)).toEqual({
      providerCode: 'tbo-hotels',
      cityCode: '150184',
    });
  });

  it.each([
    ['150184', 'sin separador'],
    ['TBO:150184', 'código de proveedor que no es del registry'],
    ['tbo-hotels:', 'sin ciudad'],
    [':150184', 'sin proveedor'],
    ['tbo-hotels:15 01', 'ciudad con espacio'],
    ['tbo-hotels:1:2', 'dos separadores'],
    [`tbo-hotels:${'1'.repeat(65)}`, 'ciudad de más de 64'],
  ])('%s no es un destino de proveedor (%s)', (value) => {
    expect(parseProviderDestinationId(value)).toBeUndefined();
  });
});

describe('destinationOf — el espacio de cada destino', () => {
  it('un número es de la plataforma; un id de proveedor, de ese proveedor', () => {
    expect(destinationOf(2345)).toEqual({ space: 'platform', cityId: 2345 });
    expect(destinationOf('tbo-hotels:150184')).toEqual({
      space: 'provider',
      providerCode: 'tbo-hotels',
      cityCode: '150184',
    });
  });

  it('sin destino, o con uno que no tiene la forma, no hay destino (nunca otra ciudad)', () => {
    expect(destinationOf(undefined)).toBeUndefined();
    expect(destinationOf('TBO:1')).toBeUndefined();
  });
});

describe('destinationCriteria — lo que queda en search_logs', () => {
  it('el de la plataforma conserva `destinationId`, que es lo que lee el sync de TBO', () => {
    expect(destinationCriteria({ space: 'platform', cityId: 2345 })).toEqual({
      destinationId: 2345,
    });
  });

  it('una ciudad del catálogo local va en claves propias, nunca en `destinationId`', () => {
    const criteria = destinationCriteria({
      space: 'provider',
      providerCode: 'tbo-hotels',
      cityCode: '150184',
    });
    expect(criteria).toEqual({ destinationProvider: 'tbo-hotels', destinationCityCode: '150184' });
    expect(criteria).not.toHaveProperty('destinationId');
  });

  it('sin destino, nada', () => {
    expect(destinationCriteria(undefined)).toEqual({});
  });
});

describe('normalizeCityName — la misma forma que `hotel_provider_city.name_norm`', () => {
  it('los casos de `normalizeName` del sync (tools/sync-tbo-hotel-inventory/src/catalog-rules.test.ts)', () => {
    expect(normalizeCityName('São Paulo')).toBe('sao paulo');
    expect(normalizeCityName('  Bogotá, D.C. ')).toBe('bogota d c');
    expect(normalizeCityName("N'Djamena")).toBe('n djamena');
    expect(normalizeCityName('Abtenau')).toBe('abtenau');
  });

  it('mayúsculas y acentos dan lo mismo', () => {
    expect(normalizeCityName('BOGOTÁ')).toBe(normalizeCityName('bogota'));
  });

  it('los comodines de LIKE no sobreviven: el resultado va dentro de un LIKE sin escapar', () => {
    expect(normalizeCityName('100%_x\\y')).toBe('100 x y');
    expect(normalizeCityName('%%')).toBe('');
  });
});

describe('suggestionLanguageOf — idioma del nombre del país', () => {
  it.each([
    ['es_CO', 'es'],
    ['pt-BR', 'pt'],
    ['EN', 'en'],
    ['fr_FR', 'es'],
    ['english', 'es'],
    [undefined, 'es'],
  ] as const)('%s → %s', (locale, language) => {
    expect(suggestionLanguageOf(locale)).toBe(language);
  });
});

describe('countryNameOf — el país en el idioma del vendedor', () => {
  it('del ISO2 del catálogo, sin tabla propia', () => {
    expect(countryNameOf('CO', 'es')).toBe('Colombia');
    expect(countryNameOf('PE', 'es')).toBe('Perú');
    expect(countryNameOf('BR', 'pt')).toBe('Brasil');
    expect(countryNameOf('co ', 'en')).toBe('Colombia');
  });

  it('un código que el ICU no acepta sale tal cual', () => {
    expect(countryNameOf('1', 'es')).toBe('1');
  });
});

describe('catalogSuggestionOf — lo que ve el vendedor', () => {
  it('id y gid del proveedor, nombre del catálogo, país legible y sin nombrar al proveedor', () => {
    const suggestion = catalogSuggestionOf(
      {
        provider_code: 'tbo-hotels',
        provider_city_code: '150184',
        name: ' Bogota ',
        country_code: 'CO',
      },
      'es',
    );

    expect(suggestion).toEqual({
      id: 'tbo-hotels:150184',
      gid: 'tbo-hotels:150184',
      type: 0,
      display: 'Bogota',
      country: 'Colombia',
    });
    expect(`${suggestion.display} ${suggestion.country ?? ''}`).not.toMatch(/tbo/i);
  });
});
