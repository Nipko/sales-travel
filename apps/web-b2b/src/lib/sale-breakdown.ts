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

/** Precio de venta de UN pasajero de un tipo. */
export interface PaxSale {
  readonly paxType: 'ADT' | 'CHD' | 'INF';
  readonly paxCount: number;
  /** Lo que se le vende a cada uno de los `paxCount`. */
  readonly sellPerPaxMinor: number;
}

/**
 * El precio de venta repartido por tipo de pasajero (adulto, niño, infante).
 *
 * El proveedor informa el NETO de cada uno; el markup de la red se aplica al total. Para que la
 * agencia vea lo que cobra a cada pasajero, el precio de venta se reparte en proporción al neto de
 * cada uno —un infante que cuesta el 10 % del neto se lleva el 10 % del markup— y el redondeo se
 * lo queda el primer adulto, para que la suma cuadre al centavo con el precio de venta de la
 * oferta. Sin desglose, o con uno que no suma el neto, no se inventa nada: `[]`.
 */
export function salePerPax(offer: Offer): PaxSale[] {
  const entries = offer.fareBreakdown ?? [];
  if (entries.length === 0) return [];
  const net = entries.map((e) => e.basePerPax.amountMinor + e.taxesPerPax.amountMinor);
  const netTotal = entries.reduce((sum, e, i) => sum + net[i]! * e.paxCount, 0);
  if (netTotal <= 0 || netTotal !== offer.total.amountMinor) return [];

  const sellTotal = saleBreakdown(offer).sellMinor;
  const sales = entries.map((e, i) => ({
    paxType: e.paxType,
    paxCount: e.paxCount,
    sellPerPaxMinor: Math.round((net[i]! * sellTotal) / netTotal),
  }));
  const assigned = sales.reduce((sum, s) => sum + s.sellPerPaxMinor * s.paxCount, 0);
  const remainder = sellTotal - assigned;
  if (remainder !== 0) {
    // El resto va a UN pasajero: si el primer tipo tiene varios, se separa uno para que la suma
    // cuadre sin repartir centavos que no existen.
    const first = sales[0]!;
    if (first.paxCount === 1) {
      sales[0] = { ...first, sellPerPaxMinor: first.sellPerPaxMinor + remainder };
    } else {
      sales.splice(
        0,
        1,
        { ...first, paxCount: 1, sellPerPaxMinor: first.sellPerPaxMinor + remainder },
        { ...first, paxCount: first.paxCount - 1 },
      );
    }
  }
  return sales;
}
