import type { OrderCancelResult, OrderRetrieveResult } from '@sales-travel/domain';

export function mapOrderRetrieveResponse(raw: unknown): OrderRetrieveResult {
  const warnings: string[] = [];
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderRetrieveRS');

  if (!root) {
    return { found: false, warnings: ['No root element in OrderRetrieve response.'] };
  }

  const errorNode = pick(root, 'Error', 'Errors') as
    | { Code?: string; DescText?: string; Error?: { Code?: string; DescText?: string } }
    | undefined;
  if (errorNode) {
    const inner = (errorNode.Error ?? errorNode) as { Code?: string; DescText?: string };
    return {
      found: false,
      warnings: [`LATAM error ${inner.Code ?? '?'}: ${inner.DescText ?? 'unknown'}`],
    };
  }

  const response = pick(root, 'Response');
  if (!response) {
    return { found: false, warnings: ['No Response element.'] };
  }

  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  if (!order) {
    return { found: false, warnings: ['No Order in response.'] };
  }

  const orderId = extractText(order.OrderID);
  const statusCode = extractText(order.StatusCode) ?? extractText(order.OrderStatusCode);

  const ticketNumbers: string[] = [];
  const ticketDocs = arr(pick(order, 'TicketDocInfo'));
  for (const td of ticketDocs) {
    const node = td as Record<string, unknown>;
    const num = extractText(node.TicketDocNbr) ?? extractText(node.TicketNumber);
    if (num) ticketNumbers.push(num);
  }

  let status = 'unknown';
  if (statusCode) {
    const s = statusCode.toLowerCase();
    if (s.includes('confirmed') || s.includes('hk')) status = 'confirmed';
    else if (s.includes('ticketed') || s.includes('issued')) status = 'ticketed';
    else if (s.includes('cancel')) status = 'cancelled';
    else if (s.includes('pending')) status = 'pending';
    else status = statusCode;
  }

  return {
    found: true,
    orderId: orderId ?? undefined,
    status,
    ticketNumbers: ticketNumbers.length > 0 ? ticketNumbers : undefined,
    warnings,
  };
}

export function mapOrderCancelResponse(raw: unknown): OrderCancelResult {
  const warnings: string[] = [];
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderCancelRS', 'OrderCancelRS');

  if (!root) {
    return {
      success: false,
      warnings: ['No root element in OrderCancel response.'],
      error: 'Invalid response from provider',
    };
  }

  const errorNode = pick(root, 'Error', 'Errors') as
    | { Code?: string; DescText?: string; Error?: { Code?: string; DescText?: string } }
    | undefined;
  if (errorNode) {
    const inner = (errorNode.Error ?? errorNode) as { Code?: string; DescText?: string };
    const msg = `LATAM error ${inner.Code ?? '?'}: ${inner.DescText ?? 'unknown'}`;
    return { success: false, warnings: [msg], error: msg };
  }

  const response = pick(root, 'Response');
  if (!response) {
    return { success: false, warnings: ['No Response element.'], error: 'Empty response' };
  }

  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  if (!order) {
    return { success: false, warnings: ['No Order in response.'], error: 'No order returned' };
  }

  let refundAmount: { amountMinor: number; currency: string } | undefined;
  const refundNode = pick(order, 'RefundAmount', 'TotalRefundAmount') as
    | Record<string, unknown>
    | undefined;
  if (refundNode) {
    const text = refundNode['#text'] ?? refundNode['TotalAmount'];
    const value = Number(text);
    const currency = (refundNode['@_CurCode'] as string) ?? 'USD';
    if (Number.isFinite(value)) {
      refundAmount = { amountMinor: Math.round(value * 100), currency };
    }
  }

  return { success: true, refundAmount, warnings };
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

function arr(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
