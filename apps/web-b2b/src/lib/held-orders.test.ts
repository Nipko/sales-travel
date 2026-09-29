import { describe, expect, it } from 'vitest';
import { heldOrdersOf, passengerNames } from './held-orders';

describe('heldOrdersOf — las reservas con saldo retenido', () => {
  it('sólo las pendientes de emisión, con monto entero y moneda', () => {
    const held = heldOrdersOf({
      orders: [
        {
          id: 'o1',
          status: 'pending',
          orderNumber: 1042,
          totalAmount: 250_000,
          currency: 'USD',
          provider: 'latam-ndc',
          searchCriteria: { vertical: 'flights' },
          passengers: [{ firstName: 'Ana', lastName: 'Pérez' }],
        },
        { id: 'o2', status: 'confirmed', totalAmount: 1, currency: 'USD' },
        { id: 'o3', status: 'pending', totalAmount: 1.5, currency: 'USD' },
      ],
    });
    expect(held).toEqual([
      {
        id: 'o1',
        orderNumber: 1042,
        totalAmountMinor: 250_000,
        currency: 'USD',
        provider: 'latam-ndc',
        searchCriteria: { vertical: 'flights' },
        passengerNames: 'Ana Pérez',
      },
    ]);
  });

  it('sin listado, nada', () => {
    expect(heldOrdersOf(null)).toEqual([]);
    expect(heldOrdersOf({ orders: 'x' })).toEqual([]);
  });
});

describe('passengerNames', () => {
  it('lee el JSON guardado como texto y omite los vacíos', () => {
    expect(passengerNames(JSON.stringify([{ firstName: 'Ana', lastName: 'Pérez' }, {}]))).toBe(
      'Ana Pérez',
    );
  });

  it('sin nombres legibles, "Pasajeros"', () => {
    expect(passengerNames('{roto')).toBe('Pasajeros');
    expect(passengerNames(undefined)).toBe('Pasajeros');
    expect(passengerNames([])).toBe('Pasajeros');
  });
});
