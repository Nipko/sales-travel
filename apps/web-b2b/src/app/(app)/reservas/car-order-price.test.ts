import { describe, expect, it } from 'vitest';
import { carOrderPrice } from './car-order-price';

const cop = (amountMinor: number) => ({ amountMinor, currency: 'COP' });

describe('carOrderPrice — el precio del auto como se vio al reservar', () => {
  it('prepago: lo del mostrador tal cual, el resto (con el markup) al reservar', () => {
    const price = carOrderPrice({
      totalAmount: 500_000_00,
      currency: 'COP',
      selectedOffer: {
        tax: cop(80_000_00),
        paymentType: 'ppd',
        counterCharges: [
          { name: 'Impuesto aeroportuario', amount: cop(50_000_00) },
          { name: 'IVA', amount: cop(30_000_00) },
          { name: '', amount: cop(1) },
        ],
      },
    });
    expect(price.payNow).toEqual(cop(420_000_00));
    expect(price.atCounter).toEqual(cop(80_000_00));
    expect(price.counterCharges.map((c) => c.name)).toEqual(['Impuesto aeroportuario', 'IVA']);
  });

  it('pago en destino: todo en el mostrador', () => {
    const price = carOrderPrice({
      totalAmount: 300_000_00,
      currency: 'COP',
      selectedOffer: { tax: cop(50_000_00), paymentType: 'pod' },
    });
    expect(price.payNow).toBeUndefined();
    expect(price.atCounter).toEqual(cop(300_000_00));
  });

  it('una reserva vieja, sin el reparto guardado, sólo muestra el total', () => {
    const price = carOrderPrice({
      totalAmount: 100,
      currency: 'COP',
      selectedOffer: { sippCode: 'ECAR' },
    });
    expect(price).toEqual({ total: cop(100), counterCharges: [] });
  });
});
