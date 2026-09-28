import { describe, expect, it } from 'vitest';
import type { HotelCancellation, HotelRoompack, Money } from '../../actions';
import {
  nightlySale,
  ratePolicyView,
  sellingHotelNote,
  uniformNightPrice,
} from './hotel-rate-detail-view';

const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

/** Neto 400, venta 520: ningún texto del detalle puede decir "400". */
function pack(cancellation: Partial<HotelCancellation>, extra: Partial<HotelRoompack> = {}) {
  return {
    cancellation: {
      refundable: true,
      status: 'partially_refundable' as const,
      rules: [],
      policySource: 'search-indicative' as const,
      ...cancellation,
    },
    price: { total: usd(400_00), taxesDetail: [] },
    pricing: { costMinor: 450_00, finalMinor: 520_00, ownMarkupMinor: 70_00, currency: 'USD' },
    ...extra,
  };
}

function money(text: string): string {
  return text.replace(/\u00a0/g, ' ');
}

describe('ratePolicyView — tramos "sujetos a confirmación" (D-TBO-19 A)', () => {
  it('fecha local del hotel y porcentaje con su equivalente en el precio de VENTA', () => {
    const view = ratePolicyView(
      pack({
        rules: [
          { type: 'Percentage', penaltyPercentage: 0, fromLocalDateTime: '2026-10-01T00:00:00' },
          { type: 'Percentage', penaltyPercentage: 50, fromLocalDateTime: '2026-10-10T14:00:00' },
        ],
      }),
    );
    expect(view?.provisional).toBe(true);
    expect(view?.hotelLocalTime).toBe(true);
    expect(view?.caption).toBe('Sujeta a confirmación · hora local del hotel');
    expect(view?.tiers[0]).toEqual({ when: 'Desde el 1 oct 2026, 00:00', charge: 'Sin cargo' });
    expect(view?.tiers[1]?.when).toBe('Desde el 10 oct 2026, 14:00');
    expect(view?.tiers[1]?.charge).toBe('50 % del total');
    expect(money(view?.tiers[1]?.approx ?? '')).toBe('≈ 260,00 US$');
  });

  it('un importe fijo NO se muestra en neto: proporción de la tarifa y equivalente en venta (G3)', () => {
    const view = ratePolicyView(
      pack({
        rules: [
          { type: 'Fixed', penaltyAmount: usd(400_00), fromLocalDateTime: '2026-10-10T14:00:00' },
        ],
      }),
    );
    const tier = view?.tiers[0];
    expect(tier?.charge).toBe('≈ 100 % del total');
    expect(money(tier?.approx ?? '')).toBe('≈ 520,00 US$');
    expect(JSON.stringify(view)).not.toMatch(/400/);
  });

  it('por habitación: el porcentaje sin equivalente, que no se sabe cuánto pesa la habitación', () => {
    const view = ratePolicyView(
      pack({ rules: [{ type: 'Percentage', penaltyPercentage: 100, roomIndex: 2 }] }),
    );
    expect(view?.tiers[0]).toEqual({
      when: 'Desde la reserva',
      charge: '100 % de la habitación 2',
    });
  });

  it('noches y horas de anticipación, como las da Despegar', () => {
    const view = ratePolicyView(
      pack({
        policySource: undefined,
        rules: [
          { type: 'NIGHTS', penaltyNights: 1, fromHours: 48, toHours: 0 },
          { type: 'NIGHTS', penaltyNights: 2, toHours: 24 },
          { type: 'X', fromHours: 72 },
        ],
      }),
    );
    expect(view?.provisional).toBe(true);
    expect(view?.hotelLocalTime).toBe(false);
    expect(view?.caption).toBe('Sujeta a confirmación');
    expect(view?.tiers).toEqual([
      { when: 'Con 0 a 48 h de anticipación', charge: '1 noche' },
      { when: 'Con menos de 24 h de anticipación', charge: '2 noches' },
      { when: 'Con 72 h o más de anticipación', charge: 'Con cargo' },
    ]);
  });

  it('del PreBook son definitivas; sin tramos ni notas no hay bloque', () => {
    const final = ratePolicyView(
      pack({ policySource: 'prebook-final', rules: [{ type: 'P', penaltyPercentage: 10 }] }),
    );
    expect(final?.provisional).toBe(false);
    expect(final?.caption).toBeUndefined();
    expect(ratePolicyView(pack({ policySource: 'none', rules: [] }))).toBeUndefined();
    expect(ratePolicyView(pack({ rules: [], vendorNotes: '  Sin reembolso.  ' }))?.notes).toBe(
      'Sin reembolso.',
    );
  });
});

describe('nightlySale — precio por noche sobre la VENTA', () => {
  it('reparte la venta según el desglose y suma exactamente el precio de venta', () => {
    const p = pack(
      {},
      {
        price: {
          total: usd(400_00),
          taxesDetail: [],
          nightly: [[usd(100_00), usd(100_00), usd(200_00)]],
        },
      },
    );
    const nights = nightlySale(p, '2026-10-12', 3);
    expect(nights?.map((n) => n.label)).toEqual(['lun, 12 oct', 'mar, 13 oct', 'mié, 14 oct']);
    expect(nights?.map((n) => n.amount.amountMinor)).toEqual([130_00, 130_00, 260_00]);
    expect(nights?.reduce((s, n) => s + n.amount.amountMinor, 0)).toBe(520_00);
  });

  it('suma las habitaciones de cada noche y no pierde centavos al redondear', () => {
    const p = pack(
      {},
      {
        price: {
          total: usd(300_00),
          taxesDetail: [],
          nightly: [
            [usd(50_00), usd(50_00), usd(50_00)],
            [usd(50_00), usd(50_00), usd(50_00)],
          ],
        },
        pricing: { costMinor: 0, finalMinor: 100_00, ownMarkupMinor: 0, currency: 'USD' },
      },
    );
    const nights = nightlySale(p, '2026-10-12', 3) ?? [];
    expect(nights.map((n) => n.amount.amountMinor)).toEqual([33_34, 33_33, 33_33]);
    expect(uniformNightPrice(nights)).toEqual(usd(33_34));
  });

  it('sin desglose, o con uno que no cierra con la estadía, no se inventa', () => {
    expect(nightlySale(pack({}), '2026-10-12', 3)).toBeUndefined();
    const irregular = pack(
      {},
      { price: { total: usd(400_00), taxesDetail: [], nightly: [[usd(1)], [usd(1), usd(1)]] } },
    );
    expect(nightlySale(irregular, '2026-10-12', 2)).toBeUndefined();
    const otherLength = pack(
      {},
      { price: { total: usd(400_00), taxesDetail: [], nightly: [[usd(1)]] } },
    );
    expect(nightlySale(otherLength, '2026-10-12', 3)).toBeUndefined();
    const otherCurrency = pack(
      {},
      {
        price: {
          total: usd(400_00),
          taxesDetail: [],
          nightly: [[{ amountMinor: 1, currency: 'EUR' }]],
        },
      },
    );
    expect(nightlySale(otherCurrency, '2026-10-12', 1)).toBeUndefined();
  });

  it('noches distintas no se resumen en un solo precio', () => {
    expect(
      uniformNightPrice([
        { label: 'a', amount: usd(100_00) },
        { label: 'b', amount: usd(120_00) },
      ]),
    ).toBeUndefined();
  });
});

describe('sellingHotelNote — con qué nombre figura el hotel en la reserva (RF-34)', () => {
  const shown = { name: 'Hotel Plaza Bogotá', address: 'Av. 5 # 10-20' };

  it('el mismo hotel, escrito distinto, no lleva nota', () => {
    expect(sellingHotelNote({ name: 'HOTEL PLAZA BOGOTA', address: 'Av 5 #10 20' }, shown)).toBe(
      undefined,
    );
  });

  it('otro nombre o dirección del proveedor que vende: se dice, sin nombrar al proveedor', () => {
    expect(sellingHotelNote({ name: 'Plaza Hotel & Suites', address: 'Calle 1' }, shown)).toBe(
      'En la reserva figura como «Plaza Hotel & Suites», Calle 1.',
    );
  });

  it('sin datos de un lado no hay comparación', () => {
    expect(sellingHotelNote(undefined, shown)).toBeUndefined();
    expect(sellingHotelNote({}, shown)).toBeUndefined();
  });
});
