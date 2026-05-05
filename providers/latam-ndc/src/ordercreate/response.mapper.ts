import type { OrderCreateResult } from '@sales-travel/domain';

export function mapOrderCreateResponse(raw: unknown): OrderCreateResult {
  const warnings: string[] = [];
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderCreateRS', 'OrderCreateRS');

  if (!root) {
    return {
      success: false,
      warnings: ['No IATA_OrderViewRS root element in response.'],
      error: 'Invalid response from provider',
    };
  }

  const errorNode = pick(root, 'Error', 'Errors') as
    | { Code?: string; DescText?: string; Error?: { Code?: string; DescText?: string } }
    | undefined;
  if (errorNode) {
    const inner = (errorNode.Error ?? errorNode) as { Code?: string; DescText?: string };
    const msg = `LATAM OrderCreate error ${inner.Code ?? '?'}: ${inner.DescText ?? 'unknown'}`;
    return { success: false, warnings: [msg], error: msg };
  }

  const response = pick(root, 'Response');
  if (!response) {
    return {
      success: false,
      warnings: ['No Response element in OrderCreateRS.'],
      error: 'Empty response from provider',
    };
  }

  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  if (!order) {
    return {
      success: false,
      warnings: ['No Order element in response.'],
      error: 'No order returned by provider',
    };
  }

  const orderId = extractText(order.OrderID);
  if (!orderId) {
    warnings.push('OrderID not found in response');
  }

  return {
    success: true,
    orderId: orderId ?? undefined,
    pnr: orderId ?? undefined,
    warnings,
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
