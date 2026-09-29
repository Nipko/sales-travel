import type { Offer } from '../app/(app)/cotizaciones/actions';

/**
 * El desglose de una oferta tal como lo puede ver la agencia.
 *
 * Dos reglas, las mismas que ya siguen el PDF y los hoteles (`hotel-rate-view.ts`):
 *
 * 1. `offer.total` es el NETO DEL PROVEEDOR y no se enseña. Para una sub-agencia, `costo - neto`
 *    es exactamente lo que gana el consolidador. Lo que la agencia paga es `pricing.costMinor`.
 * 2. Base + impuestos tiene que sumar el precio de venta. Los impuestos son de la aerolínea y
 *    pasan tal cual; el markup —propio y heredado— se absorbe en la base.
 */
export interface SaleBreakdown {
  readonly currency: string;
  readonly sellMinor: number;
  readonly baseMinor: number;
  readonly taxesMinor: number;
  /** Lo que la agencia paga. Ausente cuando no hay reglas de precio: entonces costo = venta. */
  readonly costMinor?: number;
  /** El margen PROPIO de la agencia, sólo si es mayor que cero. */
  readonly ownMarginMinor?: number;
}

export function saleBreakdown(offer: Offer): SaleBreakdown {
  const currency = offer.total.currency;
  const sellMinor = offer.pricing?.finalMinor ?? offer.total.amountMinor;
  const taxesMinor = Math.min(offer.taxes.amountMinor, sellMinor);
  const ownMargin = offer.pricing?.ownMarkupMinor ?? 0;
  return {
    currency,
    sellMinor,
    taxesMinor,
    baseMinor: sellMinor - taxesMinor,
    ...(offer.pricing === undefined ? {} : { costMinor: offer.pricing.costMinor }),
    ...(ownMargin > 0 ? { ownMarginMinor: ownMargin } : {}),
  };
}
