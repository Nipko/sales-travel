import { describe, expect, it } from 'vitest';
import { isCarOrder, isHotelOrder, orderProviderLabel, orderVerticalOf } from './order-vertical';

describe('orderVerticalOf — la vertical sale del criterio, no del código del proveedor', () => {
  it('hoteles por `searchCriteria.vertical`, sea cual sea el proveedor (TP-62)', () => {
    expect(
      orderVerticalOf({ provider: 'tbo-hotels', searchCriteria: { vertical: 'hotels' } }),
    ).toBe('hotels');
    expect(isHotelOrder({ provider: 'otro-hotels', searchCriteria: { vertical: 'hotels' } })).toBe(
      true,
    );
  });

  it('un código de hoteles sin la marca no se adivina: cae en vuelos, como antes', () => {
    expect(orderVerticalOf({ provider: 'tbo-hotels', searchCriteria: {} })).toBe('flights');
  });

  it('autos por la marca o por su adapter (órdenes anteriores al intent)', () => {
    expect(isCarOrder({ provider: 'agent-cars', searchCriteria: {} })).toBe(true);
    expect(isCarOrder({ provider: 'x', searchCriteria: { vertical: 'cars' } })).toBe(true);
  });

  it('sin criterio legible es un vuelo', () => {
    expect(orderVerticalOf({ provider: 'latam-ndc' })).toBe('flights');
    expect(orderVerticalOf({ provider: 'latam-ndc', searchCriteria: 'roto' })).toBe('flights');
    expect(orderVerticalOf({ provider: 'latam-ndc', searchCriteria: null })).toBe('flights');
  });
});

describe('orderProviderLabel — Carteras (TP-63)', () => {
  it('el nombre legible del proveedor, no su código', () => {
    expect(
      orderProviderLabel({ provider: 'tbo-hotels', searchCriteria: { vertical: 'hotels' } }),
    ).toBe('Hoteles (TBO Holidays)');
    expect(orderProviderLabel({ provider: 'latam-ndc', searchCriteria: {} })).toBe(
      'Vuelos (LATAM NDC)',
    );
    expect(orderProviderLabel({ provider: 'agent-cars' })).toBe('Autos (AgentCars)');
  });

  it('un proveedor sin ficha sale por su código; sin proveedor, sólo la vertical', () => {
    expect(orderProviderLabel({ provider: 'nuevo-gds' })).toBe('Vuelos (nuevo-gds)');
    expect(orderProviderLabel({ provider: '  ' })).toBe('Vuelos');
  });
});
