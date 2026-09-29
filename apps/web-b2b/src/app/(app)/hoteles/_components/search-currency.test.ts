import { describe, expect, it } from 'vitest';
import type { HotelProviderOutcome } from '../actions';
import {
  currencyFieldMessage,
  currencyFromQuery,
  currencyNamer,
  currencyOptionLabel,
  currencySwitchSuggestion,
  initialSearchCurrency,
  isCurrencyCode,
  parseCurrencyField,
  parseSearchCurrencies,
  queryWithCurrency,
  type SearchCurrencies,
} from './search-currency';

/** La moneda de la búsqueda de hoteles (docs/tbo/08 D-TBO-15, selector del 2026-09-29). */

const AGENCIA_COP: SearchCurrencies = { defaultCurrency: 'COP', currencies: ['COP', 'USD'] };

describe('parseSearchCurrencies — la lista del API, sin confiar en su forma', () => {
  it('la de la agencia primero, sin repetir', () => {
    expect(
      parseSearchCurrencies({ defaultCurrency: 'COP', currencies: ['USD', 'COP', 'USD'] }),
    ).toEqual({ defaultCurrency: 'COP', currencies: ['COP', 'USD'] });
  });

  it('descarta lo que no es un código ISO', () => {
    expect(
      parseSearchCurrencies({ defaultCurrency: 'COP', currencies: ['COP', 'usd', 7, 'EURO'] }),
    ).toEqual({ defaultCurrency: 'COP', currencies: ['COP'] });
  });

  it('sin una moneda por defecto que esté en la lista no hay selector', () => {
    expect(parseSearchCurrencies({ defaultCurrency: 'COP', currencies: ['USD'] })).toBeUndefined();
    expect(parseSearchCurrencies({ defaultCurrency: 'cop', currencies: ['cop'] })).toBeUndefined();
    expect(parseSearchCurrencies({ currencies: ['USD'] })).toBeUndefined();
    expect(parseSearchCurrencies({ defaultCurrency: 'USD', currencies: 'USD' })).toBeUndefined();
    expect(parseSearchCurrencies(null)).toBeUndefined();
  });
});

describe('parseCurrencyField — lo que manda el formulario', () => {
  it('vacía: la de la agencia, que pone el API', () => {
    expect(parseCurrencyField('')).toEqual({ ok: true });
    expect(parseCurrencyField('  ')).toEqual({ ok: true });
  });

  it('un código ISO, normalizado', () => {
    expect(parseCurrencyField(' usd ')).toEqual({ ok: true, currency: 'USD' });
  });

  it('otra cosa no se manda', () => {
    expect(parseCurrencyField('dólares')).toEqual({ ok: false });
    expect(parseCurrencyField('US')).toEqual({ ok: false });
  });
});

describe('la última elección, en la URL', () => {
  it('se lee de `?moneda=`, en mayúsculas', () => {
    expect(currencyFromQuery('?moneda=usd')).toBe('USD');
    expect(currencyFromQuery('?cliente=abc&moneda=USD')).toBe('USD');
    expect(currencyFromQuery('?moneda=dolar')).toBeUndefined();
    expect(currencyFromQuery('')).toBeUndefined();
  });

  it('la recordada sólo si la agencia la puede usar; si no, la de la agencia', () => {
    expect(initialSearchCurrency(AGENCIA_COP, 'USD')).toBe('USD');
    expect(initialSearchCurrency(AGENCIA_COP, 'EUR')).toBe('COP');
    expect(initialSearchCurrency(AGENCIA_COP, undefined)).toBe('COP');
  });

  it('se escribe sin tocar el resto de la URL, y la de la agencia no se escribe', () => {
    expect(queryWithCurrency('?cliente=abc', 'USD', 'COP')).toBe('?cliente=abc&moneda=USD');
    expect(queryWithCurrency('?cliente=abc&moneda=USD', 'COP', 'COP')).toBe('?cliente=abc');
    expect(queryWithCurrency('?moneda=USD', 'COP', 'COP')).toBe('');
    expect(queryWithCurrency('', 'USD', 'COP')).toBe('?moneda=USD');
  });
});

describe('lo que muestra el campo', () => {
  it('el código y el nombre; sólo el código si no hay nombre', () => {
    const nameOf = (c: string) => (c === 'USD' ? 'dólar estadounidense' : c);
    expect(currencyOptionLabel('USD', nameOf)).toBe('USD · dólar estadounidense');
    expect(currencyOptionLabel('XXX', nameOf)).toBe('XXX');
  });

  it('el navegador nombra las monedas en español', () => {
    expect(currencyNamer('es')('USD').toLowerCase()).toContain('dólar');
  });

  it('dice cuál es la de la agencia y que no hay conversión', () => {
    expect(currencyFieldMessage(AGENCIA_COP, 'COP')).toBe(
      'La de tu agencia. Sin conversión: se ven sólo las tarifas en COP.',
    );
    expect(currencyFieldMessage(AGENCIA_COP, 'USD')).toBe(
      'Sin conversión: se ven sólo las tarifas en USD. La de tu agencia es COP.',
    );
    expect(currencyFieldMessage(null, '')).toBe(
      'No pudimos leer las monedas: se busca en la de la agencia.',
    );
    expect(currencyFieldMessage(undefined, '')).toBe(
      'Sin conversión: se ven sólo las tarifas en la moneda elegida.',
    );
  });
});

describe('currencySwitchSuggestion — "Buscar en USD" del aviso', () => {
  const tboEnUsd: HotelProviderOutcome = {
    code: 'tbo-hotels',
    status: 'skipped',
    count: 0,
    skipReason: 'currency-mismatch',
    reason: 'Cotiza en USD y esta búsqueda es en COP.',
    droppedForCurrency: 12,
    droppedCurrencies: ['USD'],
  };
  const despegarOk: HotelProviderOutcome = { code: 'despegar-hotels', status: 'ok', count: 4 };

  it('la moneda en que cotizó el proveedor, si la agencia la puede usar', () => {
    expect(currencySwitchSuggestion([despegarOk, tboEnUsd], AGENCIA_COP.currencies, 'COP')).toBe(
      'USD',
    );
  });

  it('buscando en USD, un proveedor en COP sugiere volver a COP', () => {
    const enCop = { ...tboEnUsd, droppedCurrencies: ['COP'] };
    expect(currencySwitchSuggestion([enCop], AGENCIA_COP.currencies, 'USD')).toBe('COP');
  });

  it('en una moneda que la agencia no puede usar: nada, repetir no lo arregla', () => {
    const enEur = { ...tboEnUsd, droppedCurrencies: ['EUR'] };
    expect(currencySwitchSuggestion([enEur], AGENCIA_COP.currencies, 'COP')).toBeUndefined();
  });

  it('un API que no dice en qué moneda cotizó: USD, si se puede y no se buscó en USD', () => {
    const { droppedCurrencies: _d, ...sinMonedas } = tboEnUsd;
    expect(currencySwitchSuggestion([sinMonedas], AGENCIA_COP.currencies, 'COP')).toBe('USD');
    expect(currencySwitchSuggestion([sinMonedas], AGENCIA_COP.currencies, 'USD')).toBeUndefined();
    expect(currencySwitchSuggestion([sinMonedas], ['COP'], 'COP')).toBeUndefined();
  });

  it('sin proveedores fuera por moneda, o sin la lista de monedas, no hay botón', () => {
    const parcial: HotelProviderOutcome = {
      code: 'x',
      status: 'ok',
      count: 1,
      droppedForCurrency: 1,
      droppedCurrencies: ['USD'],
    };
    expect(currencySwitchSuggestion([despegarOk, parcial], AGENCIA_COP.currencies, 'COP')).toBe(
      undefined,
    );
    expect(currencySwitchSuggestion([tboEnUsd], undefined, 'COP')).toBeUndefined();
  });

  it('nunca la misma moneda que se buscó', () => {
    const raro = { ...tboEnUsd, droppedCurrencies: ['COP'] };
    expect(currencySwitchSuggestion([raro], AGENCIA_COP.currencies, 'COP')).toBeUndefined();
  });
});

describe('isCurrencyCode', () => {
  it('tres letras mayúsculas', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode(840)).toBe(false);
  });
});
