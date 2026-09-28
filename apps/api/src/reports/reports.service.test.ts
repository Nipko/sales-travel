import { describe, expect, it } from 'vitest';
import { salesVerticalLabel } from './reports.service.js';

/**
 * La vertical de cada orden en los reportes de ventas (docs/tbo/09 PR-4.6). Antes, cualquier
 * proveedor fuera de una lista fija contaba como vuelo: una reserva de hotel de TBO sumaba a
 * "Vuelos".
 */

describe('salesVerticalLabel', () => {
  it.each([
    ['tbo-hotels', 'hotels', 'Hoteles'],
    ['despegar-hotels', 'hotels', 'Hoteles'],
    ['agent-cars', 'cars', 'Autos'],
    ['sabre', 'flights', 'Vuelos'],
  ])('%s con `vertical: %s` → %s', (provider, vertical, label) => {
    expect(salesVerticalLabel(provider, vertical)).toBe(label);
  });

  it.each([
    ['hotelbeds', 'Hoteles'],
    ['hoteldo', 'Hoteles'],
    ['despegar-hotels', 'Hoteles'],
    ['assistcard', 'Asistencias'],
    ['latam-ndc', 'Vuelos'],
    // Las órdenes de vuelos no escriben `vertical`: un proveedor de vuelos nuevo sigue en Vuelos.
    ['sabre', 'Vuelos'],
  ])('sin vertical declarada, %s → %s', (provider, label) => {
    expect(salesVerticalLabel(provider, null)).toBe(label);
  });

  it('una vertical declarada que no se conoce cae a la de su proveedor', () => {
    expect(salesVerticalLabel('hotelbeds', 'cruceros')).toBe('Hoteles');
    expect(salesVerticalLabel('otro', 'cruceros')).toBe('Vuelos');
  });
});
