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
 * La cancelación genérica sólo es segura antes de emisión. Un ticket exige elegir VOID o REFUND
 * y sus documentos; hasta que ese contrato exista, la UI debe fallar cerrada.
 */
export function supportsOrderCancellation(
  capabilities: Partial<OrderCapabilities> | undefined,
  status: string,
): boolean {
  return status !== 'ticketed' && supportsOrderCapability(capabilities, 'cancel');
}
