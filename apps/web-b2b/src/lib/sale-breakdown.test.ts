import { describe, expect, it } from 'vitest';
import type { Offer } from '../app/(app)/cotizaciones/actions';
import { saleBreakdown } from './sale-breakdown';

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
