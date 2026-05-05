import type { OrderPayResult } from '@sales-travel/domain';

export function mapOrderChangePaymentResponse(raw: unknown): OrderPayResult {
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderChangeRS');

  if (!root) {
    return {
      success: false,
      warnings: ['No root element in OrderChange response.'],
      error: 'Invalid response',
    };
  }

  const errorNode = pick(root, 'Error', 'Errors') as
    | { Code?: string; DescText?: string; Error?: { Code?: string; DescText?: string } }
    | undefined;
  if (errorNode) {
    const inner = errorNode.Error ?? errorNode;
    const msg = `LATAM error ${inner.Code ?? '?'}: ${inner.DescText ?? 'unknown'}`;
    return { success: false, warnings: [msg], error: msg };
  }

  const response = pick(root, 'Response');
  if (!response) {
    return { success: false, warnings: ['No Response element.'], error: 'Empty response' };
  }

  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  const orderId = order ? extractText(order.OrderID) : undefined;
  const statusCode = order
    ? (extractText(order.StatusCode) ?? extractText(order.OrderStatusCode))
    : undefined;

  let status: string | undefined;
  if (statusCode) {
    const s = statusCode.toLowerCase();
    if (s.includes('confirmed') || s.includes('hk')) status = 'confirmed';
    else if (s.includes('ticketed') || s.includes('issued')) status = 'ticketed';
    else if (s.includes('cancel')) status = 'cancelled';
    else if (s.includes('pending')) status = 'pending';
    else status = statusCode;
  }

  return { success: true, orderId: orderId ?? undefined, status, warnings: [] };
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
