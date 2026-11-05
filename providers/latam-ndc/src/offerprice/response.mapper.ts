import type { Money, Offer } from '@sales-travel/canonical';
import type { OfferPriceResult } from '@sales-travel/domain';
import { buildFareBreakdown, penaltyFees, readFareLists } from '../airshopping/fare-components';
import { extractPolicies } from '../airshopping/response.mapper';
import { LatamApiError, LatamBusinessError } from '../errors';
import { arr, attr, latamErrors, money, pick, text } from '../xml';

export const OFFERPRICE_PATH = '/ndc/v192/offerPrice';

/**
 * Mapea `IATA_OfferPriceRS` sobre la oferta que se revalidó.
 *
 * Cualquier `<Error>` se LANZA. Antes se devolvía la oferta original con `priceChanged: false`, y
 * `orders.service` la daba por revalidada: el vendedor reservaba con un «precio confirmado» que
 * LATAM acababa de rechazar (p. ej. 400116010, 409116001 en `[portal:/ndc/price-offer-v2]`).
 */
export function mapOfferPriceResponse(
  raw: unknown,
  originalOffer: Offer,
  trackId?: string,
): OfferPriceResult {
  const warnings: string[] = [];
  const root = pick(raw, 'IATA_OfferPriceRS', 'OfferPriceRS');
  if (!root) throw new LatamApiError(200, 'respuesta sin IATA_OfferPriceRS', OFFERPRICE_PATH);

  const errors = latamErrors(root);
  if (errors.length > 0) throw new LatamBusinessError(errors, OFFERPRICE_PATH, trackId);

  const offerNode = pick(pick(root, 'Response'), 'PricedOffer') as
    | Record<string, unknown>
    | undefined;
  if (!offerNode) throw new LatamApiError(200, 'OfferPriceRS sin PricedOffer', OFFERPRICE_PATH);

  const tp = offerNode.TotalPrice as Record<string, unknown> | undefined;
  const newTotal = money(pick(tp, 'TotalAmount'));
  if (!newTotal) throw new LatamApiError(200, 'OfferPriceRS sin TotalAmount', OFFERPRICE_PATH);
  const newBase = money(pick(tp, 'BaseAmount')) ?? newTotal;
  const newTaxes = taxesOf(pick(tp, 'TaxSummary'), newTotal, newBase);

  // LATAM no informa vigencia en OfferPrice; si algún día la manda, manda sobre la nuestra.
  const declaredExpiry = attr(pick(offerNode.TimeLimits, 'OfferExpiration'), 'DateTime');

  // La referencia de la oferta se CONSERVA: es el OfferID de la búsqueda, con el que LATAM reserva.
  // El sandbox devuelve en `PricedOffer/OfferID` un token `SEI|…` de ~334 caracteres (no el UUID
  // de la documentación): copiarlo a `offerRef` lo sacaba de los 255 del canónico y la API rechazaba
  // crear la reserva. Se guarda aparte, en `raw`, por si hiciera falta.
  const pricedOfferId = text(offerNode.OfferID);
  const providerRaw: Offer['provider']['raw'] =
    pricedOfferId && pricedOfferId !== originalOffer.provider.offerRef
      ? { ...originalOffer.provider.raw, pricedOfferId }
      : originalOffer.provider.raw;

  const items = arr<Record<string, unknown>>(offerNode.OfferItem);
  const lists = readFareLists(pick(root, 'Response'));
  const restrictions = extractPolicies(items);
  const fees = penaltyFees(items, lists);
  const policies =
    restrictions || fees.changeFee || fees.refundFee
      ? { ...originalOffer.policies, ...restrictions, ...fees }
      : undefined;
  // Con varios pasajeros, el precio firme por pasajero es el de OfferPrice (`[portal:/ndc/order-create]`).
  const fareBreakdown = buildFareBreakdown(items, lists, newTotal);

  const updatedOffer: Offer = {
    ...originalOffer,
    provider: { ...originalOffer.provider, ...(providerRaw ? { raw: providerRaw } : {}) },
    total: newTotal,
    baseFare: newBase,
    taxes: newTaxes,
    ...(policies ? { policies } : {}),
    ...(fareBreakdown ? { fareBreakdown } : {}),
    ...(declaredExpiry ? { expiresAt: declaredExpiry, expiresAtSource: 'provider' as const } : {}),
    fetchedAt: new Date().toISOString(),
  };

  const priceChanged =
    newTotal.amountMinor !== originalOffer.total.amountMinor ||
    newTotal.currency !== originalOffer.total.currency;
  if (priceChanged) {
    warnings.push(
      `Price changed: ${originalOffer.total.amountMinor} → ${newTotal.amountMinor} ${newTotal.currency}`,
    );
  }

  // Un desglose de la búsqueda que ya no suma el total nuevo no se arrastra.
  if (!fareBreakdown && priceChanged) delete updatedOffer.fareBreakdown;

  return { offer: updatedOffer, priceChanged, warnings };
}

/**
 * Impuestos de la oferta revalidada. El ejemplo oficial trae `TaxSummary/Tax/Amount` sin
 * `TotalTaxAmount`; leer sólo este último dejaba los impuestos de la búsqueda junto al total y la
 * base nuevos, y base + impuestos dejaba de dar el total.
 */
function taxesOf(taxSummary: unknown, total: Money, base: Money): Money {
  const declared = money(pick(taxSummary, 'TotalTaxAmount'));
  if (declared && declared.currency === total.currency) return declared;

  const parts = arr(pick(taxSummary, 'Tax')).map((t) => money(pick(t, 'Amount')));
  if (
    parts.length > 0 &&
    parts.every((p): p is Money => p !== null && p.currency === total.currency)
  ) {
    const sum = parts.reduce((acc, p) => acc + p.amountMinor, 0);
    if (base.amountMinor + sum === total.amountMinor)
      return { amountMinor: sum, currency: total.currency };
  }
  return {
    amountMinor: Math.max(0, total.amountMinor - base.amountMinor),
    currency: total.currency,
  };
}
