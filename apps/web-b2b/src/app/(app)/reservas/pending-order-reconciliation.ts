export interface PendingOrderReconciliationInput {
  readonly status: string;
  readonly pnr?: string | null;
  readonly errorMessage?: string | null;
}

/** Marker visible sólo para un intent pendiente que todavía no tiene referencia del proveedor. */
export function pendingOrderReconciliationMessage(
  order: PendingOrderReconciliationInput,
): string | null {
  if (order.status !== 'pending') return null;
  if (typeof order.pnr === 'string' && order.pnr.trim().length > 0) return null;
  if (typeof order.errorMessage !== 'string') return null;

  const message = order.errorMessage.trim();
  return message.length > 0 ? message : null;
}
