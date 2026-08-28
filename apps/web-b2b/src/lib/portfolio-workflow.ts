/**
 * Contrato visible del flujo de cartera.
 *
 * La emisión se mantiene cerrada hasta que el backend tenga un fulfillment real que pueda
 * confirmar el proveedor antes de convertir la retención en cargo. No se debe presentar una
 * escritura local como si fuera ticketing.
 */
export const PORTFOLIO_ISSUANCE = {
  enabled: false,
  label: 'Emisión no disponible',
  description:
    'La emisión desde cartera aún no está conectada a una operación real del proveedor; la retención no se debita desde esta pantalla.',
} as const;

export const PORTFOLIO_REJECTION = {
  confirmLabel: 'Cancelar y liberar',
  description:
    'Primero se solicitará la cancelación al proveedor. El saldo sólo se libera si el proveedor confirma la cancelación.',
  success: 'Cancelación confirmada por el proveedor y saldo retenido liberado.',
} as const;
