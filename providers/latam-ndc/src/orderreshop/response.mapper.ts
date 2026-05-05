import type { OrderReshopResult } from '@sales-travel/domain';

export function mapOrderReshopResponse(raw: unknown): OrderReshopResult {
  const root = pick(raw, 'IATA_OrderReshopRS', 'OrderReshopRS');

  if (!root) {
    return {
      success: false,
      amountDue: { amount: 0, currency: 'USD' },
      isResidualValue: false,
      warnings: ['No root element in OrderReshop response.'],
      error: 'Invalid response',
    };
  }

  const errorNode = pick(root, 'Error', 'Errors') as
    | { Code?: string; DescText?: string; Error?: { Code?: string; DescText?: string } }
    | undefined;
  if (errorNode) {
    const inner = errorNode.Error ?? errorNode;
    const msg = `LATAM error ${inner.Code ?? '?'}: ${inner.DescText ?? 'unknown'}`;
    return {
      success: false,
      amountDue: { amount: 0, currency: 'USD' },
      isResidualValue: false,
      warnings: [msg],
      error: msg,
    };
  }

  const response = pick(root, 'Response') as Record<string, unknown> | undefined;
  if (!response) {
    return {
      success: false,
      amountDue: { amount: 0, currency: 'USD' },
      isResidualValue: false,
      warnings: ['No Response element.'],
      error: 'Empty response',
    };
  }

  const reshopResults = pick(response, 'ReshopResults') as Record<string, unknown> | undefined;
  const repricedOffer = reshopResults
    ? (pick(reshopResults, 'RepricedOffer') as Record<string, unknown> | undefined)
    : undefined;

  if (!repricedOffer) {
    return {
      success: false,
      amountDue: { amount: 0, currency: 'USD' },
      isResidualValue: false,
      warnings: ['No RepricedOffer in response.'],
      error: 'No repriced offer',
    };
  }

  const offerRefId = extractText(repricedOffer.OfferRefID) ?? undefined;

  const repricedItem = pick(repricedOffer, 'RepricedOfferItem') as
    | Record<string, unknown>
    | undefined;
  const totalPrice = repricedItem
    ? (pick(repricedItem, 'TotalPrice') as Record<string, unknown> | undefined)
    : undefined;

  let amount = 0;
  let currency = 'USD';

  if (totalPrice) {
    const totalAmount = totalPrice.TotalAmount;
    if (totalAmount && typeof totalAmount === 'object') {
      const ta = totalAmount as Record<string, unknown>;
      amount = Number(ta['#text'] ?? ta['']) || 0;
      currency = (ta['@_CurCode'] as string) ?? 'USD';
    } else if (typeof totalAmount === 'string') {
      amount = Number(totalAmount) || 0;
    } else if (typeof totalAmount === 'number') {
      amount = totalAmount;
    }
  }

  const isResidualValue = amount < 0;

  return {
    success: true,
    offerRefId,
    amountDue: { amount, currency },
    isResidualValue,
    warnings: [],
  };
}

function extractText(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const text = obj['#text'] ?? obj[''];
    if (typeof text === 'string') return text;
    if (typeof text === 'number') return String(text);
  }
  return undefined;
}

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in o) return o[k];
  }
  return undefined;
}
