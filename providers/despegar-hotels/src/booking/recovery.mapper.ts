import type { RecoveryRequest, RecoveryResult } from './types';

/** Cuerpo del PATCH /book/{id}/recovery: confirma o rechaza cada price-jump detectado. */
export function buildRecoveryBody(req: RecoveryRequest): Record<string, unknown> {
  return {
    message_type: req.messageType,
    price_jump_confirmations:
      req.confirmations.length > 0
        ? req.confirmations.map((c) => ({ flavor_id: c.flavorId, confirm: c.confirm }))
        : undefined,
    payment_type: req.paymentType,
  };
}

interface RawRecoveryResponse {
  item?: Record<string, unknown>;
}

export function mapRecoveryResult(raw: RawRecoveryResponse): RecoveryResult {
  const result: RecoveryResult = {};
  if (raw.item) result.item = raw.item;
  return result;
}
