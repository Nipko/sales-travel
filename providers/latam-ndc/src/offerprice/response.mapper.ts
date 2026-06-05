import type { Money, Offer } from '@sales-travel/canonical';
import type { OfferPriceResult } from '@sales-travel/domain';

export function mapOfferPriceResponse(raw: unknown, originalOffer: Offer): OfferPriceResult {
  const warnings: string[] = [];
  const root = pick(raw, 'IATA_OfferPriceRS', 'OfferPriceRS');

  if (!root) {
    if (process.env['LATAM_DEBUG_HTTP'] === 'true') {
      console.warn(
        '[latam-ndc] OfferPrice: no root element. Raw:',
        JSON.stringify(raw).slice(0, 1000),
      );
    } else {
      console.warn('[latam-ndc] OfferPrice: unexpected response (no root element)');
    }
    return {
      offer: originalOffer,
      priceChanged: false,
      warnings: ['No IATA_OfferPriceRS root element. Returning original offer.'],
    };
  }

  const errorNode = pick(root, 'Error') as { Code?: string; DescText?: string } | undefined;
  if (errorNode) {
    console.error(
      `[LATAM GDS OfferPrice Error] GDS returned error - Code: ${errorNode.Code ?? 'unknown'}, Desc: ${errorNode.DescText ?? 'unknown'}`,
    );
    return {
      offer: originalOffer,
      priceChanged: false,
      warnings: [
        `LATAM OfferPrice error ${errorNode.Code ?? '?'}: ${errorNode.DescText ?? 'unknown'}`,
      ],
    };
  }

  const response = pick(root, 'Response');
  if (!response) {
    return {
      offer: originalOffer,
      priceChanged: false,
      warnings: ['No Response element in OfferPriceRS.'],
    };
  }

  const pricedOffer = pick(response, 'PricedOffer', 'Offer');
  if (!pricedOffer) {
    return {
      offer: originalOffer,
      priceChanged: false,
      warnings: ['No PricedOffer in response.'],
    };
  }

  const offerNode = pricedOffer as Record<string, unknown>;
  const tp = offerNode.TotalPrice as Record<string, unknown> | undefined;

  let newTotal: Money | null = null;
  let newBaseFare: Money | null = null;
  let newTaxes: Money | null = null;

  if (tp) {
    newTotal = extractMoney(tp.TotalAmount) ?? extractMoney(tp.SimpleCurrencyPrice);
    newBaseFare = extractMoney(tp.BaseAmount);
    const taxNode = tp.TaxSummary as Record<string, unknown> | undefined;
    newTaxes = extractMoney(taxNode?.TotalTaxAmount);
  }

  const timeLimits = offerNode.TimeLimits as Record<string, unknown> | undefined;
  const expiration = timeLimits?.OfferExpiration as Record<string, unknown> | undefined;
  const newExpiresAt = expiration?.['@_DateTime'] as string | undefined;

  // Preserve the encoded OfferItemIDs from the original ref
  const rawNewId = offerNode.OfferID as string | undefined;
  const originalItemSuffix = originalOffer.provider.offerRef.includes('|')
    ? originalOffer.provider.offerRef.slice(originalOffer.provider.offerRef.indexOf('|'))
    : '';
  const newOfferRef = rawNewId
    ? `${rawNewId}${originalItemSuffix}`
    : originalOffer.provider.offerRef;

  const updatedOffer: Offer = {
    ...originalOffer,
    provider: { ...originalOffer.provider, offerRef: newOfferRef },
    total: newTotal ?? originalOffer.total,
    baseFare: newBaseFare ?? originalOffer.baseFare,
    taxes: newTaxes ?? originalOffer.taxes,
    expiresAt: newExpiresAt ? ensureIso(newExpiresAt) : originalOffer.expiresAt,
    fetchedAt: new Date().toISOString(),
  };

  const priceChanged =
    updatedOffer.total.amountMinor !== originalOffer.total.amountMinor ||
    updatedOffer.total.currency !== originalOffer.total.currency;

  if (priceChanged) {
    warnings.push(
      `Price changed: ${originalOffer.total.amountMinor} → ${updatedOffer.total.amountMinor} ${updatedOffer.total.currency}`,
    );
  }

  return { offer: updatedOffer, priceChanged, warnings };
}

function extractMoney(amountNode: unknown): Money | null {
  if (amountNode === undefined || amountNode === null) return null;

  let value: number;
  let currency: string;

  if (typeof amountNode === 'object' && amountNode !== null) {
    const obj = amountNode as Record<string, unknown>;
    const text = obj['#text'] ?? obj[''];
    value = Number(text);
    const raw = obj['@_CurCode'] ?? obj['@_Code'] ?? 'USD';
    currency = typeof raw === 'string' ? raw : 'USD';
  } else {
    value = Number(amountNode);
    currency = 'USD';
  }

  if (!Number.isFinite(value)) return null;
  return { amountMinor: Math.round(value * 100), currency: currency.toUpperCase() };
}

function ensureIso(dt: string): string {
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(dt)) return dt;
  return `${dt}Z`;
}

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in o) return o[k];
  }
  return undefined;
}
