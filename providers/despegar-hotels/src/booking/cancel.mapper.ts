import type { CancelReason, CancelReservationResult } from './types';

/** Cuerpo del POST /reservations/{id}/cancels. La razón es obligatoria; default OTHER. */
export function buildCancelBody(reason?: CancelReason): Record<string, unknown> {
  return { reason: reason ?? 'OTHER' };
}

interface RawCancelResponse {
  flow_id?: string;
  product_id?: string;
  product_type?: string;
  related_products_cancellations?: unknown;
}

/**
 * Mapea la respuesta de cancelación. Que el endpoint responda 2xx implica que la cancelación se
 * aceptó (es irreversible); el proveedor no devuelve montos/penalidad aquí.
 */
export function mapCancelResult(raw: RawCancelResponse): CancelReservationResult {
  const result: CancelReservationResult = { success: true };
  if (raw.flow_id) result.flowId = raw.flow_id;
  if (raw.product_id) result.productId = raw.product_id;
  if (raw.product_type) result.productType = raw.product_type;
  return result;
}
