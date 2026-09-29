import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  HotelRatesCurrencyMismatchError,
  HotelSearchCurrencyMarkupError,
  HotelSearchCurrencyNotAllowedError,
  assertRulesPriceIn,
  hotelSearchCurrencies,
  hotelSearchCurrencyOptions,
  resolveHotelSearchCurrency,
} from './hotel-search-currency.js';

/** La moneda de la búsqueda de hoteles (docs/tbo/08 D-TBO-15, selector de moneda, 2026-09-29). */

describe('hotelSearchCurrencies — la de la agencia y USD', () => {
  it('la de la agencia primero, después USD', () => {
    expect(hotelSearchCurrencies('COP')).toEqual(['COP', 'USD']);
    expect(hotelSearchCurrencies('PEN')).toEqual(['PEN', 'USD']);
  });

  it('una agencia en USD tiene una sola: no se repite', () => {
    expect(hotelSearchCurrencies('USD')).toEqual(['USD']);
  });

  it('las opciones del selector traen elegida la de la agencia', () => {
    expect(hotelSearchCurrencyOptions('BRL')).toEqual({
      defaultCurrency: 'BRL',
      currencies: ['BRL', 'USD'],
    });
  });
});

describe('resolveHotelSearchCurrency', () => {
  it('sin moneda pedida, la de la agencia', () => {
    expect(resolveHotelSearchCurrency(undefined, 'COP')).toBe('COP');
  });

  it('la de la agencia o USD, tal cual', () => {
    expect(resolveHotelSearchCurrency('COP', 'COP')).toBe('COP');
    expect(resolveHotelSearchCurrency('USD', 'COP')).toBe('USD');
  });

  it('otra moneda es un 400 que dice cuáles se pueden elegir', () => {
    let error: unknown;
    try {
      resolveHotelSearchCurrency('EUR', 'COP');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HotelSearchCurrencyNotAllowedError);
    const e = error as HotelSearchCurrencyNotAllowedError;
    expect(e.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(e.message).toBe(
      'Los hoteles se buscan en COP o USD: la moneda EUR no está disponible para esta agencia.',
    );
    expect(e.allowed).toEqual(['COP', 'USD']);
  });

  it('una agencia en USD sólo busca en USD', () => {
    expect(() => resolveHotelSearchCurrency('COP', 'USD')).toThrow(
      'Los hoteles se buscan en USD: la moneda COP no está disponible para esta agencia.',
    );
  });
});

describe('assertRulesPriceIn — un markup fijo no se suma en otra moneda', () => {
  const porcentaje = { ruleType: 'percentage', valueMinor: 1000 };
  const fijo = { ruleType: 'fixed', valueMinor: 5_000_000 };

  it('en la moneda de la agencia vale todo', () => {
    expect(() => assertRulesPriceIn([porcentaje, fijo], 'COP', 'COP')).not.toThrow();
  });

  it('en otra moneda, los porcentajes sí', () => {
    expect(() => assertRulesPriceIn([porcentaje], 'USD', 'COP')).not.toThrow();
    expect(() => assertRulesPriceIn([], 'USD', 'COP')).not.toThrow();
  });

  it('un fijo en cero no suma nada: no bloquea', () => {
    expect(() =>
      assertRulesPriceIn([porcentaje, { ruleType: 'fixed', valueMinor: 0 }], 'USD', 'COP'),
    ).not.toThrow();
  });

  it('un fijo distinto de cero en otra moneda es un 409 que dice cómo seguir', () => {
    let error: unknown;
    try {
      assertRulesPriceIn([porcentaje, fijo], 'USD', 'COP');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HotelSearchCurrencyMarkupError);
    const e = error as HotelSearchCurrencyMarkupError;
    expect(e.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(e.message).toBe(
      'El markup de hoteles de tu red incluye un monto fijo, que está en COP, y no se puede sumar a tarifas en USD sin convertir la moneda. Buscá en COP, o pedí que ese markup se configure como porcentaje.',
    );
  });

  it('cualquier tipo que no sea porcentaje cuenta como fijo, como en la cascada', () => {
    expect(() => assertRulesPriceIn([{ ruleType: 'otro', valueMinor: 10 }], 'USD', 'COP')).toThrow(
      HotelSearchCurrencyMarkupError,
    );
  });
});

describe('HotelRatesCurrencyMismatchError', () => {
  it('es un 409 con el motivo tal cual', () => {
    const e = new HotelRatesCurrencyMismatchError('Cotiza en USD y esta búsqueda es en COP.');
    expect(e.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(e.message).toBe('Cotiza en USD y esta búsqueda es en COP.');
  });
});
