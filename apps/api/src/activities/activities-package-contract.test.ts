import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PackageItemInputSchema } from '../packages/packages.schemas.js';
import { assertSameCurrency, priceItem } from '../packages/packages.service.js';

/*
 * El contrato acordado con Paquetes (docs/platform/20-paquetes.md) para una actividad de Despegar:
 * lo que arma `toPackageItemInput` en la web lo acepta el borde de Paquetes, lleva la cascada de la
 * vertical `activities` (no es un servicio manual) y una moneda distinta a la del paquete es 409.
 */

const ITEM = {
  vertical: 'activities',
  providerName: 'despegar-activities',
  providerItemId: 'eyJjaG9pY2UiOiJVTl9PUkwtMjAyNi0xMi0xMCJ9',
  rawDetails: {
    kind: 'activity',
    title: 'Universal Orlando Resort',
    category: 'ticket',
    modality: '1 parque, 1 día',
    date: '2026-12-10',
    participants: { adults: 2, childrenAges: [7, 1] },
    cancellation: { refundable: true, tiers: [{ from: '2026-11-23', percentage: 0 }] },
    ticketValidity: { useDate: '2026-12-10' },
    images: [],
  },
  baseFareMinor: 38000,
  taxesMinor: 3700,
  currency: 'USD',
};

describe('actividad como ítem de paquete', () => {
  it('el borde de Paquetes acepta el ítem tal como lo arma la sección de Actividades', () => {
    expect(PackageItemInputSchema.safeParse(ITEM).success).toBe(true);
  });

  it('lleva la cascada de la vertical sobre neto + impuestos (no es manual)', () => {
    const rules = [
      { tenantId: 't', tenantName: 'A', level: 0, ruleType: 'percentage', valueMinor: 1000 },
    ];
    expect(priceItem(ITEM, rules, 't')).toEqual({ markupMinor: 4170, totalMinor: 45870 });
  });

  it('una moneda distinta a la del paquete se rechaza con 409', () => {
    expect(() => assertSameCurrency(ITEM, 'COP')).toThrow(ConflictException);
    expect(() => assertSameCurrency(ITEM, 'usd')).not.toThrow();
  });
});
