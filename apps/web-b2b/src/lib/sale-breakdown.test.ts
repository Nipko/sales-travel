import { describe, expect, it } from 'vitest';
import type { Offer } from '../app/(app)/cotizaciones/actions';
import { saleBreakdown, salePerPax } from './sale-breakdown';

function offer(pricing?: Offer['pricing']): Offer {
  return {
    id: 'o1',
    tenantId: 't1',
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'r1' },
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 60_000, currency: 'USD' },
    taxes: { amountMinor: 40_000, currency: 'USD' },
    ...(pricing === undefined ? {} : { pricing }),
    fetchedAt: '2026-09-29T00:00:00Z',
    expiresAt: '2026-09-29T00:01:30Z',
  };
}

describe('saleBreakdown', () => {
  it('sin reglas de precio, venta = neto y base + impuestos = venta', () => {
    const b = saleBreakdown(offer());
    expect(b).toEqual({
      currency: 'USD',
      sellMinor: 100_000,
      baseMinor: 60_000,
      taxesMinor: 40_000,
    });
  });

  it('con markup heredado y propio, la base absorbe todo y el neto del proveedor no aparece', () => {
    // neto 1000, consolidador +50, agencia +30 → costo 1050, venta 1080.
    const b = saleBreakdown(
      offer({ costMinor: 105_000, finalMinor: 108_000, ownMarkupMinor: 3_000, currency: 'USD' }),
    );
    expect(b.baseMinor + b.taxesMinor).toBe(b.sellMinor);
    expect(b.baseMinor).toBe(68_000);
    expect(b.costMinor).toBe(105_000);
    expect(b.ownMarginMinor).toBe(3_000);
    expect(Object.values(b)).not.toContain(100_000);
  });
});

describe('salePerPax: lo que se cobra a cada adulto, niño e infante', () => {
  // Los netos de CERT (2026-10-19, BOG-MIA, 2 ADT + 1 CNN + 1 INF): 648,89 / 497,69 / 165,79.
  const familia = (pricing?: Offer['pricing']): Offer => ({
    ...offer(pricing),
    total: { amountMinor: 196_126, currency: 'USD' },
    fareBreakdown: [
      {
        paxType: 'ADT',
        paxCount: 2,
        basePerPax: { amountMinor: 39_600, currency: 'USD' },
        taxesPerPax: { amountMinor: 25_289, currency: 'USD' },
      },
      {
        paxType: 'CHD',
        paxCount: 1,
        basePerPax: { amountMinor: 29_700, currency: 'USD' },
        taxesPerPax: { amountMinor: 20_069, currency: 'USD' },
      },
      {
        paxType: 'INF',
        paxCount: 1,
        basePerPax: { amountMinor: 4_000, currency: 'USD' },
        taxesPerPax: { amountMinor: 12_579, currency: 'USD' },
      },
    ],
  });
  const suma = (sales: ReturnType<typeof salePerPax>) =>
    sales.reduce((total, s) => total + s.sellPerPaxMinor * s.paxCount, 0);

  it('sin markup, el neto de cada uno', () => {
    expect(salePerPax(familia())).toEqual([
      { paxType: 'ADT', paxCount: 2, sellPerPaxMinor: 64_889 },
      { paxType: 'CHD', paxCount: 1, sellPerPaxMinor: 49_769 },
      { paxType: 'INF', paxCount: 1, sellPerPaxMinor: 16_579 },
    ]);
  });

  it('con markup, se reparte en proporción y la suma cuadra al centavo', () => {
    const sales = salePerPax(
      familia({ costMinor: 200_000, finalMinor: 215_001, ownMarkupMinor: 15_001, currency: 'USD' }),
    );
    expect(suma(sales)).toBe(215_001);
    expect(sales.map((s) => s.paxType)).toEqual(expect.arrayContaining(['ADT', 'CHD', 'INF']));
  });

  it('sin desglose, o con uno que no suma el neto, no inventa nada', () => {
    expect(salePerPax(offer())).toEqual([]);
    expect(salePerPax({ ...familia(), total: { amountMinor: 1, currency: 'USD' } })).toEqual([]);
  });
});
