import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, ISO_ALPHA3_TO_ALPHA2, isCountryAlpha2, toCountryAlpha2 } from './countries';

/** La tabla de la fuente (`packages/validation`), leída como texto: web-b2b no depende del paquete. */
function sourceTable(): Record<string, string> {
  const path = fileURLToPath(
    new URL('../../../../packages/validation/src/iso-3166.ts', import.meta.url),
  );
  const text = readFileSync(path, 'utf8');
  const entries = [...text.matchAll(/^\s+([A-Z]{3}): '([A-Z]{2})',$/gm)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
  return Object.fromEntries(entries);
}

describe('ISO_ALPHA3_TO_ALPHA2 — copia de la tabla de packages/validation', () => {
  it('es idéntica a la fuente, entrada por entrada', () => {
    const fuente = sourceTable();
    // Si la lectura de la fuente se rompe, el test tiene que fallar y no comparar dos vacíos.
    expect(Object.keys(fuente).length).toBe(249);
    expect({ ...ISO_ALPHA3_TO_ALPHA2 }).toEqual(fuente);
  });

  it('cada alfa-2 aparece una sola vez', () => {
    expect(new Set(Object.values(ISO_ALPHA3_TO_ALPHA2)).size).toBe(COUNTRY_CODES.length);
  });
});

describe('toCountryAlpha2', () => {
  it('convierte el alfa-3 del CRM', () => {
    expect(toCountryAlpha2('COL')).toBe('CO');
    expect(toCountryAlpha2('bra')).toBe('BR');
    expect(toCountryAlpha2(' per ')).toBe('PE');
  });

  it('acepta un alfa-2 oficial y lo devuelve en mayúsculas', () => {
    expect(toCountryAlpha2('co')).toBe('CO');
  });

  it('no adivina: texto libre, códigos no oficiales y letras no ASCII quedan sin convertir', () => {
    expect(toCountryAlpha2('Colombia')).toBeUndefined();
    expect(toCountryAlpha2('XK')).toBeUndefined();
    expect(toCountryAlpha2('ZZZ')).toBeUndefined();
    expect(toCountryAlpha2('ß')).toBeUndefined();
    expect(toCountryAlpha2('')).toBeUndefined();
  });
});

describe('isCountryAlpha2', () => {
  it('exige mayúsculas y código oficial', () => {
    expect(isCountryAlpha2('CO')).toBe(true);
    expect(isCountryAlpha2('co')).toBe(false);
    expect(isCountryAlpha2('COL')).toBe(false);
  });
});
