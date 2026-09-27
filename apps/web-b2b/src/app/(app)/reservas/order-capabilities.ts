export type OrderCapability = 'retrieve' | 'cancel' | 'pay' | 'services' | 'reshop';

export type OrderCapabilities = Readonly<Record<OrderCapability, boolean>>;

/** Ausencia no significa soporte: ante un API viejo/desconocido la UI falla cerrada. */
export function supportsOrderCapability(
  capabilities: Partial<OrderCapabilities> | undefined,
  capability: OrderCapability,
): boolean {
  return capabilities?.[capability] === true;
}

/**
 * Lo que dice el seguimiento de una orden de hotel (`providerTracking`) sobre una cancelación ya
 * pedida. Las demás verticales no lo traen.
 */
export interface CancellationTracking {
  readonly subStatus?: string | null;
  readonly providerStatus?: string | null;
}

/** El claim tomado y el desenlace sin verificar (docs/tbo/04 §6.3). */
const CANCEL_SUB_STATUSES: ReadonlySet<string> = new Set(['cancel-requested', 'cancel-unverified']);

/**
 * Los estados del proveedor de una cancelación que aceptó y todavía procesa (docs/tbo/04 §6.1).
 * La orden queda `pending` con el estado crudo y sin subestado: sólo el estado lo dice.
 */
export const PROVIDER_CANCELLING_STATUSES: ReadonlySet<string> = new Set([
  'CancellationInProgress',
  'CancelPending',
  'CxlRequestSentToHotel',
]);

/** Hay una cancelación pedida que todavía no terminó (D-TBO-25 A: "Cancelación en curso"). */
export function cancellationInProgress(tracking: CancellationTracking | null | undefined): boolean {
  if (!tracking) return false;
  return (
    (typeof tracking.subStatus === 'string' && CANCEL_SUB_STATUSES.has(tracking.subStatus)) ||
    (typeof tracking.providerStatus === 'string' &&
      PROVIDER_CANCELLING_STATUSES.has(tracking.providerStatus))
  );
}

/**
 * La cancelación genérica sólo es segura antes de emisión. Un ticket exige elegir VOID o REFUND
 * y sus documentos; hasta que ese contrato exista, la UI debe fallar cerrada.
 *
 * Con una cancelación de hotel en curso tampoco se ofrece otra: el backend la rechazaría, y el
 * botón le haría creer al vendedor que la primera no salió (docs/tbo/04 §12).
 */
export function supportsOrderCancellation(
  capabilities: Partial<OrderCapabilities> | undefined,
  status: string,
  tracking?: CancellationTracking | null,
): boolean {
  return (
    status !== 'ticketed' &&
    !cancellationInProgress(tracking) &&
    supportsOrderCapability(capabilities, 'cancel')
  );
}
