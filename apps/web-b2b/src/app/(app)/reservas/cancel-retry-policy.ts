export type CancelOperationOutcome = 'SUCCEEDED' | 'FAILED' | 'UNVERIFIED' | null;

export interface OrderOperationView {
  id: string;
  type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  retryable: boolean;
  outcome: CancelOperationOutcome;
  reconciliationRequired: boolean;
  /** Sólo en una cancelación que anuló (o intentó anular) los tiquetes: `VOID` (SAB-09). */
  ticketOperation?: string;
}

/** El botón de retry sólo aparece ante evidencia explícita de fallo anterior al write. */
export function canRetryCancelOperation(operation: OrderOperationView): boolean {
  return (
    operation.type === 'cancel' &&
    operation.status === 'failed' &&
    operation.retryable === true &&
    operation.outcome === 'FAILED' &&
    !operation.reconciliationRequired
  );
}

/**
 * El endpoint principal no es una vía alternativa al retry. Si ya hubo un intento fallido, se
 * conduce al historial o a conciliación en vez de ofrecer otro botón de cancelación.
 */
export function directCancellationBlock(operations: readonly OrderOperationView[]): string | null {
  const latest = operations.find((operation) => operation.type === 'cancel');
  if (!latest || latest.status === 'success' || latest.outcome === 'SUCCEEDED') return null;
  if (latest.reconciliationRequired || latest.outcome === 'UNVERIFIED') {
    return 'El proveedor no confirmó si la cancelación se aplicó. No la reenvíes: primero hay que consultar y conciliar la reserva con el proveedor.';
  }
  if (latest.status !== 'failed') {
    return 'Ya hay una cancelación en curso. Espera a que termine antes de intentar otra acción.';
  }
  if (latest.ticketOperation !== undefined) {
    // Una anulación que no salió o que la aerolínea rechazó no se continúa desde el historial: se
    // vuelve a pedir desde «Condiciones de los tiquetes», con una consulta nueva (SAB-09).
    return 'La anulación anterior no se completó. Para volver a pedirla, consulta antes las condiciones de los tiquetes.';
  }
  if (canRetryCancelOperation(latest)) {
    return 'El intento falló antes de enviar la cancelación. Continúa desde “Reintentar” en el historial; no inicies una cancelación nueva.';
  }
  return 'Este intento de cancelación no es reintentable. Revisa el motivo o escálalo al equipo de soporte.';
}
