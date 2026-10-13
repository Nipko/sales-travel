import { describe, expect, it } from 'vitest';
import { isTestFare, isTestOrder, testFareShare } from './test-content';

/*
 * La marca de las tarifas y reservas del entorno de pruebas del proveedor, como la lee el panel:
 * sólo lo que dice el API, y sólo `test` / `true` explícitos. Todo lo demás es real.
 */

const real = { provider: { name: 'alfa-air' } };
const realExplicita = { provider: { name: 'alfa-air', environment: 'live' } };
const prueba = { provider: { name: 'alfa-air', environment: 'test' } };

describe('isTestFare', () => {
  it('sólo `test` explícito es de pruebas', () => {
    expect(isTestFare(prueba)).toBe(true);
    expect(isTestFare(real)).toBe(false);
    expect(isTestFare(realExplicita)).toBe(false);
  });

  it('un valor que no se reconoce, o una oferta sin proveedor, se lee como real', () => {
    expect(isTestFare({ provider: { environment: 'cert' } })).toBe(false);
    expect(isTestFare({ provider: { environment: true } })).toBe(false);
    expect(isTestFare({})).toBe(false);
    expect(isTestFare(null)).toBe(false);
    expect(isTestFare(undefined)).toBe(false);
  });
});

describe('isTestOrder', () => {
  it('sólo `testContent: true` es de prueba', () => {
    expect(isTestOrder({ testContent: true })).toBe(true);
    expect(isTestOrder({ testContent: false })).toBe(false);
    expect(isTestOrder({ testContent: 'true' })).toBe(false);
    expect(isTestOrder({})).toBe(false);
    expect(isTestOrder(undefined)).toBe(false);
  });
});

describe('testFareShare', () => {
  it('ninguna, algunas o todas', () => {
    expect(testFareShare([real, realExplicita])).toBe('none');
    expect(testFareShare([real, prueba])).toBe('some');
    expect(testFareShare([prueba, prueba])).toBe('all');
  });

  it('un vuelo sin tarifas no se marca', () => {
    expect(testFareShare([])).toBe('none');
  });
});
