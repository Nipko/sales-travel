import {
  ISO_3166_ALPHA3_TO_ALPHA2,
  isIsoCountryAlpha2,
  toIsoCountryAlpha2,
} from '@sales-travel/validation';
import { describe, expect, it } from 'vitest';

/**
 * Tabla ISO 3166-1 de `packages/validation` (docs/tbo/09 PR-2.4; 08 RF-06 CA 2).
 *
 * Vive acá porque `packages/validation` no tiene runner de tests, igual que
 * `validation-dtos.test.ts`. Se prueba lo que se importa por el nombre del paquete: el `dist` que
 * corre en producción, no el fuente.
 */

const tabla = Object.entries(ISO_3166_ALPHA3_TO_ALPHA2);

describe('ISO_3166_ALPHA3_TO_ALPHA2', () => {
  it('los 249 códigos oficialmente asignados, sin repetir ni un alfa-3 ni un alfa-2', () => {
    expect(tabla).toHaveLength(249);
    expect(new Set(tabla.map(([, a2]) => a2)).size).toBe(249);
  });

  it('cada entrada tiene la forma de su código', () => {
    for (const [a3, a2] of tabla) {
      expect(a3).toMatch(/^[A-Z]{3}$/);
      expect(a2).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('cada alfa-2 es una región que el runtime reconoce: una errata no pasa por país', () => {
    const regiones = new Intl.DisplayNames(['en'], { type: 'region' });
    const sinNombre = tabla.filter(([, a2]) => regiones.of(a2) === a2).map(([a3]) => a3);
    expect(sinNombre).toEqual([]);
  });

  it.each([
    ['COL', 'CO'],
    ['BRA', 'BR'],
    ['PER', 'PE'],
    ['VEN', 'VE'],
    ['ARG', 'AR'],
    ['USA', 'US'],
    ['ESP', 'ES'],
    // Los que no empiezan con la misma letra son los que una tabla hecha a ojo se equivoca.
    ['SRB', 'RS'],
    ['PRK', 'KP'],
    ['CYM', 'KY'],
    ['COM', 'KM'],
  ])('%s → %s', (a3, a2) => {
    expect(ISO_3166_ALPHA3_TO_ALPHA2[a3]).toBe(a2);
  });

  it('no se puede modificar en tiempo de ejecución', () => {
    expect(Object.isFrozen(ISO_3166_ALPHA3_TO_ALPHA2)).toBe(true);
  });
});

describe('toIsoCountryAlpha2', () => {
  it("RF-06 CA 2: 'COL' del CRM → 'CO'", () => {
    expect(toIsoCountryAlpha2('COL')).toBe('CO');
  });

  it('acepta alfa-2 y alfa-3 sin distinguir mayúsculas ni espacios en los bordes', () => {
    expect(toIsoCountryAlpha2('co')).toBe('CO');
    expect(toIsoCountryAlpha2(' col ')).toBe('CO');
    expect(toIsoCountryAlpha2('Bra')).toBe('BR');
  });

  it.each(['', 'Colombia', 'colombiano', 'XX', 'XK', 'XKX', 'C0', 'CO L'])(
    '"%s" no convierte: no se adivina un país',
    (valor) => {
      expect(toIsoCountryAlpha2(valor)).toBeUndefined();
    },
  );

  /*
   * MUTACIÓN: pasar a mayúsculas antes de exigir letras ASCII convierte 'ß' en 'SS' (Sudán del
   * Sur), 'ﬁ' en 'FI' (Finlandia) y 'cıv' en 'CIV' (Costa de Marfil).
   */
  it.each(['ß', 'ﬁ', 'ﬆ', 'cıv'])(
    '"%s" no convierte aunque en mayúsculas parezca un código',
    (valor) => {
      expect(toIsoCountryAlpha2(valor)).toBeUndefined();
    },
  );
});

describe('isIsoCountryAlpha2', () => {
  it('sólo códigos oficiales y en mayúsculas', () => {
    expect(isIsoCountryAlpha2('CO')).toBe(true);
    expect(isIsoCountryAlpha2('co')).toBe(false);
    expect(isIsoCountryAlpha2('XX')).toBe(false);
    expect(isIsoCountryAlpha2('COL')).toBe(false);
  });
});
