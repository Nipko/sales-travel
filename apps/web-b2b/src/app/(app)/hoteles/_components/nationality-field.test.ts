import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES } from '../../../../lib/countries';
import {
  countryNamer,
  customerIdFromQuery,
  FREQUENT_NATIONALITIES,
  nationalityOptions,
  prefillFromCustomer,
  prefillFromLastSearch,
  prefillMessage,
  prefillValue,
} from './nationality-field';

describe('prefillFromCustomer — la ficha del CRM (RF-06 CA 2)', () => {
  it("el alfa-3 del CRM se convierte: 'COL' → 'CO'", () => {
    const prefill = prefillFromCustomer({ name: 'Ana Pérez', nationality: 'COL' });
    expect(prefill).toEqual({ kind: 'crm', code: 'CO', customerName: 'Ana Pérez' });
    expect(prefillValue(prefill)).toBe('CO');
    expect(prefillMessage(prefill)).toEqual({
      tone: 'info',
      text: 'De la ficha de Ana Pérez en Clientes.',
    });
  });

  it('un texto libre que no convierte no se manda: se le pide al vendedor', () => {
    const prefill = prefillFromCustomer({ name: 'Ana Pérez', nationality: 'Colombia' });
    expect(prefillValue(prefill)).toBe('');
    expect(prefillMessage(prefill)?.tone).toBe('error');
    expect(prefillMessage(prefill)?.text).toContain('«Colombia»');
  });

  it('una ficha sin nacionalidad deja el campo vacío y lo dice', () => {
    const prefill = prefillFromCustomer({ name: 'Ana Pérez', nationality: null });
    expect(prefillValue(prefill)).toBe('');
    expect(prefillMessage(prefill)?.text).toMatch(/no tiene nacionalidad/);
  });

  it('una ficha que no se pudo leer deja el campo vacío y lo dice', () => {
    const prefill = prefillFromCustomer(null);
    expect(prefillValue(prefill)).toBe('');
    expect(prefillMessage(prefill)?.tone).toBe('error');
  });
});

describe('prefillFromLastSearch', () => {
  it('la de la última búsqueda, a la vista y con su origen', () => {
    const prefill = prefillFromLastSearch('PE');
    expect(prefillValue(prefill)).toBe('PE');
    expect(prefillMessage(prefill)?.text).toMatch(/última búsqueda/);
  });

  it('nada guardado, o algo que ya no es un país: campo vacío y sin mensaje', () => {
    for (const stored of [null, '', 'pe', 'ZZ', 'COL']) {
      const prefill = prefillFromLastSearch(stored);
      expect(prefillValue(prefill)).toBe('');
      expect(prefillMessage(prefill)).toBeUndefined();
    }
  });
});

describe('nationalityOptions', () => {
  const options = nationalityOptions(countryNamer('es'));

  it('los frecuentes arriba, en su orden, y todos los países en la lista sin repetir', () => {
    expect(options.frequent.map((o) => o.code)).toEqual([...FREQUENT_NATIONALITIES]);
    const all = [...options.frequent, ...options.others].map((o) => o.code);
    expect(new Set(all).size).toBe(COUNTRY_CODES.length);
  });

  it('con el nombre en español y el resto ordenado por nombre', () => {
    expect(options.frequent[0]).toEqual({ code: 'CO', name: 'Colombia' });
    const names = options.others.map((o) => o.name);
    const collator = new Intl.Collator('es', { sensitivity: 'base' });
    const sorted = [...names].sort((a, b) => collator.compare(a, b));
    expect(names).toEqual(sorted);
  });

  it('si el navegador no sabe nombrar un país, muestra el código', () => {
    const plain = nationalityOptions((code) => code);
    expect(plain.frequent[0]).toEqual({ code: 'CO', name: 'CO' });
  });
});

describe('customerIdFromQuery', () => {
  it('lee `cliente` del enlace de la ficha', () => {
    expect(customerIdFromQuery('?cliente=abc-123')).toBe('abc-123');
  });

  it('sin el parámetro, o vacío, no hay cliente', () => {
    expect(customerIdFromQuery('')).toBeUndefined();
    expect(customerIdFromQuery('?cliente=')).toBeUndefined();
    expect(customerIdFromQuery('?otro=1')).toBeUndefined();
  });
});
