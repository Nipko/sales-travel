import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../actions';
import {
  atHotelCharges,
  hotelCardView,
  hotelRateRows,
  ownMarginOf,
  saleTotal,
} from './hotel-rate-view';

function tarifa(
  id: string,
  netMinor: number,
  provider: string | undefined,
  extra: Partial<HotelRoompack> = {},
): HotelRoompack {
  return {
    id,
    ...(provider === undefined ? {} : { provider: { name: provider, offerRef: `${id}-REF` } }),
    board: 'RO',
    rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: netMinor, currency: 'USD' }, taxesDetail: [] },
    ...extra,
  };
}

function conVenta(finalMinor: number, costMinor: number, ownMarkupMinor: number) {
  return { pricing: { finalMinor, costMinor, ownMarkupMinor, currency: 'USD' } };
}

describe('saleTotal — la tarjeta muestra el precio de VENTA (U-06, G3)', () => {
  it('con waterfall: el precio final de la cascada, no el neto del proveedor', () => {
    const pack = tarifa('A', 100_00, 'despegar-hotels', conVenta(130_00, 110_00, 20_00));
    expect(saleTotal(pack)).toEqual({ amountMinor: 130_00, currency: 'USD' });
  });

  it('sin reglas ni piso el API no manda `pricing`: venta = neto', () => {
    expect(saleTotal(tarifa('A', 100_00, 'tbo-hotels'))).toEqual({
      amountMinor: 100_00,
      currency: 'USD',
    });
  });
});

describe('ownMarginOf — "neto + markup" con el costo de ESTE tenant', () => {
  it('el costo es el del tenant (neto más su red), nunca el neto del proveedor', () => {
    const pack = tarifa('A', 100_00, 'tbo-hotels', conVenta(140_00, 120_00, 20_00));
    expect(ownMarginOf(pack)).toEqual({
      cost: { amountMinor: 120_00, currency: 'USD' },
      margin: { amountMinor: 20_00, currency: 'USD' },
    });
  });

  it('sin margen propio no hay línea', () => {
    expect(ownMarginOf(tarifa('A', 100_00, 'tbo-hotels', conVenta(120_00, 120_00, 0)))).toBe(
      undefined,
    );
    expect(ownMarginOf(tarifa('A', 100_00, 'tbo-hotels'))).toBeUndefined();
  });
});

describe('atHotelCharges — lo que se paga en el hotel (U-07, RF-10)', () => {
  it('cada cargo por habitación con su importe y SU moneda, sin sumarlos', () => {
    const pack = tarifa('A', 100_00, 'tbo-hotels', {
      atPropertyCharges: [
        {
          roomIndex: 1,
          description: 'Tasa municipal',
          amount: { amountMinor: 20_00, currency: 'AED' },
        },
        {
          roomIndex: 2,
          description: 'Tasa municipal',
          amount: { amountMinor: 20_00, currency: 'AED' },
        },
      ],
    });
    const charges = atHotelCharges(pack);
    expect(charges).toHaveLength(2);
    expect(charges.map((c) => c.room)).toEqual([1, 2]);
    expect(charges.every((c) => c.amount.includes('20') && c.amount.includes('AED'))).toBe(true);
    // El total no cambia: el cargo no entra en el precio de venta.
    expect(saleTotal(pack).amountMinor).toBe(100_00);
  });

  it('una moneda sin 2 decimales se muestra con el literal del proveedor', () => {
    const pack = tarifa('A', 100_00, 'tbo-hotels', {
      atPropertyCharges: [
        {
          description: 'City tax',
          amount: { amountMinor: 25_810, currency: 'KWD' },
          amountText: '25.810',
        },
      ],
    });
    expect(atHotelCharges(pack)).toEqual([{ amount: '25.810 KWD', description: 'City tax' }]);
  });

  it('el cargo único en destino de Despegar también es "a pagar en el hotel"', () => {
    const pack = tarifa('A', 100_00, 'despegar-hotels', {
      price: {
        total: { amountMinor: 100_00, currency: 'USD' },
        taxesDetail: [],
        chargeAtDestination: { amountMinor: 15_00, currency: 'USD' },
      },
    });
    const [charge] = atHotelCharges(pack);
    expect(charge?.description).toBe('Cargo en destino');
    expect(charge?.room).toBeUndefined();
  });

  it('sin cargos, lista vacía', () => {
    expect(atHotelCharges(tarifa('A', 100_00, 'tbo-hotels'))).toEqual([]);
  });
});

describe('RF-40 CA 4 a 6 — las filas de tarifas de una tarjeta', () => {
  // Un hotel con una tarifa de cada proveedor, como la tarjeta agrupada por hotel canónico
  // (D-TBO-13 A): la de TBO es la más barata por precio de venta.
  const agrupada = {
    roompacks: [
      tarifa('D-1', 120_000, 'despegar-hotels'),
      tarifa('T-1', 90_000, 'tbo-hotels', conVenta(95_000, 90_000, 5_000)),
    ],
  };

  it('CA 4: encendido → cada fila con la pastilla legible de SU proveedor', () => {
    const rows = hotelRateRows(agrupada, true);
    expect(rows.map((r) => r.providerLabel)).toEqual(['TBO Holidays', 'Despegar Hotels']);
  });

  it('CA 4: el "desde" es la fila más barata por venta y lleva la pastilla de ESA tarifa', () => {
    const view = hotelCardView(agrupada, true);
    expect(view.from?.pack.id).toBe('T-1');
    expect(view.from?.providerLabel).toBe('TBO Holidays');
    expect(view.from?.sale).toEqual({ amountMinor: 95_000, currency: 'USD' });
  });

  it('CA 5: una tarjeta agrupada tiene dos pastillas distintas, una por tarifa', () => {
    const labels = hotelRateRows(agrupada, true).map((r) => r.providerLabel);
    expect(new Set(labels).size).toBe(2);
  });

  it('CA 6: apagado → ninguna pastilla, ni en el "desde" ni en las filas', () => {
    const view = hotelCardView(agrupada, false);
    expect(view.from?.providerLabel).toBeUndefined();
    expect(view.rows.every((r) => r.providerLabel === undefined)).toBe(true);
  });

  it('vencida la más barata, el "desde" pasa a la siguiente, con SU pastilla', () => {
    const view = hotelCardView(agrupada, true, (row) => row.pack.id === 'T-1');
    expect(view.from?.pack.id).toBe('D-1');
    expect(view.from?.providerLabel).toBe('Despegar Hotels');
    expect(view.fromExpired).toBe(false);
  });

  it('vencidas todas, el "desde" es la más barata y se marca vencida', () => {
    const view = hotelCardView(agrupada, true, () => true);
    expect(view.from?.pack.id).toBe('T-1');
    expect(view.fromExpired).toBe(true);
  });

  it('las claves de fila no chocan aunque dos proveedores repitan el id de tarifa', () => {
    const repetidas = {
      roompacks: [tarifa('1', 100, 'despegar-hotels'), tarifa('1', 200, 'tbo-hotels')],
    };
    const keys = hotelRateRows(repetidas, false).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('hotelRateRows — orden y contenido de cada fila', () => {
  it('de la más barata a la más cara por VENTA; ante un empate, en el orden en que llegaron', () => {
    const rows = hotelRateRows(
      {
        roompacks: [
          // Neto más barato, pero con más markup: por venta queda última.
          tarifa('A', 80_00, 'x-hotels', conVenta(130_00, 80_00, 50_00)),
          tarifa('B', 100_00, 'x-hotels'),
          tarifa('C', 100_00, 'x-hotels'),
        ],
      },
      false,
    );
    expect(rows.map((r) => r.pack.id)).toEqual(['B', 'C', 'A']);
  });

  it('régimen desde la etiqueta del proveedor, promociones, inclusiones y traslados', () => {
    const [row] = hotelRateRows(
      {
        roompacks: [
          tarifa('A', 100_00, 'tbo-hotels', {
            board: 'BB',
            boardLabel: 'Desayuno para 1 persona',
            rooms: [
              { name: 'Doble', reference: 1, bedOptions: [], promotions: ['10% off'] },
              { name: 'Doble', reference: 2, bedOptions: [], promotions: ['10% off'] },
            ],
            inclusionText: 'Wifi, Parking',
            includesTransfers: true,
            includedSupplements: [
              { description: 'Resort fee', amount: { amountMinor: 5_00, currency: 'USD' } },
            ],
          }),
        ],
      },
      false,
    );
    expect(row?.board).toBe('Desayuno para 1 persona');
    expect(row?.rooms).toBe('Doble + Doble');
    expect(row?.promotions).toEqual(['10% off']);
    expect(row?.inclusion).toBe('Wifi, Parking');
    expect(row?.transfers).toBe(true);
    expect(row?.included).toHaveLength(1);
  });

  it('el cargo por huésped adicional queda aparte, nunca en el precio (RF-11 CA 4)', () => {
    const extra = { amountMinor: 30_00, currency: 'USD' };
    const [row] = hotelRateRows(
      {
        roompacks: [
          tarifa('A', 100_00, 'tbo-hotels', {
            price: {
              total: { amountMinor: 100_00, currency: 'USD' },
              taxesDetail: [],
              extraGuestCharges: extra,
            },
          }),
        ],
      },
      false,
    );
    expect(row?.extraGuest).toEqual(extra);
    expect(row?.sale.amountMinor).toBe(100_00);
  });

  it('un hotel sin tarifas no tiene "desde"', () => {
    expect(hotelCardView({ roompacks: [] }, true).from).toBeUndefined();
  });
});
