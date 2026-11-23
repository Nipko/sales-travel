import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ApplicableRule } from '../pricing/pricing.service.js';
import { CreatePackageSchema, UpdatePackageSchema } from './packages.schemas.js';
import { assertSameCurrency, priceItem } from './packages.service.js';

const TENANT = '00000000-0000-4000-8000-000000000001';

const tenPercent: ApplicableRule[] = [
  {
    id: 'r1',
    tenantId: TENANT,
    tenantName: 'Agencia',
    level: 0,
    ruleType: 'percentage',
    valueMinor: 1000,
    priority: 0,
  } as unknown as ApplicableRule,
];

describe('priceItem', () => {
  it('sin reglas, el precio de venta es el neto', () => {
    expect(
      priceItem({ providerName: 'sabre', baseFareMinor: 80_000, taxesMinor: 20_000 }, [], TENANT),
    ).toEqual({ markupMinor: 0, totalMinor: 100_000 });
  });

  it('el servicio manual no pasa por la cascada aunque haya reglas', () => {
    expect(
      priceItem(
        { providerName: 'manual', baseFareMinor: 50_000, taxesMinor: 0 },
        tenPercent,
        TENANT,
      ),
    ).toEqual({ markupMinor: 0, totalMinor: 50_000 });
  });

  it('en hoteles, el piso del proveedor gana sobre una cascada que queda por debajo', () => {
    const priced = priceItem(
      {
        providerName: 'despegar-hotels',
        baseFareMinor: 100_000,
        taxesMinor: 0,
        minimumSellingMinor: 130_000,
      },
      [],
      TENANT,
    );
    expect(priced.totalMinor).toBe(130_000);
    expect(priced.markupMinor).toBe(30_000);
  });
});

describe('assertSameCurrency', () => {
  it('acepta la misma moneda sin importar mayúsculas y un ítem sin moneda', () => {
    expect(() => assertSameCurrency({ currency: 'cop' }, 'COP')).not.toThrow();
    expect(() => assertSameCurrency({}, 'COP')).not.toThrow();
  });

  it('rechaza un ítem en otra moneda: no hay tasas de cambio para sumarlo', () => {
    expect(() => assertSameCurrency({ currency: 'USD' }, 'COP')).toThrow(ConflictException);
  });
});

describe('CreatePackageSchema', () => {
  const base = { title: 'Cartagena · 5 noches', currency: 'COP' };

  it('acepta el paquete con criterios y servicios, incluido uno manual de actividades', () => {
    const parsed = CreatePackageSchema.safeParse({
      ...base,
      searchCriteria: {
        origin: 'BOG',
        destination: 'CTG',
        departureDate: '2026-12-10',
        returnDate: '2026-12-15',
        rooms: [{ adults: 2, childrenAges: [7] }],
        includes: ['flights', 'hotels'],
      },
      items: [
        {
          vertical: 'activities',
          providerName: 'manual',
          providerItemId: 'manual-1',
          baseFareMinor: 25_000_000,
          taxesMinor: 0,
          currency: 'COP',
          rawDetails: { title: 'Tour Islas del Rosario' },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rechaza un snapshot de presentación desmedido', () => {
    const parsed = CreatePackageSchema.safeParse({
      ...base,
      items: [
        {
          vertical: 'hotels',
          providerName: 'tbo-hotels',
          providerItemId: 'x',
          baseFareMinor: 1,
          taxesMinor: 0,
          rawDetails: { blob: 'x'.repeat(70 * 1024) },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('UpdatePackageSchema', () => {
  it('rechaza un cambio vacío y un estado inventado', () => {
    expect(UpdatePackageSchema.safeParse({}).success).toBe(false);
    expect(UpdatePackageSchema.safeParse({ status: 'paid' }).success).toBe(false);
    expect(UpdatePackageSchema.safeParse({ showBreakdown: true }).success).toBe(true);
  });
});
