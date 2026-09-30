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

/** Repetir la liberación de una reserva que el proveedor ya canceló: no vuelve a tocarlo. */
export const PORTFOLIO_RELEASE_RETRY = {
  label: 'Terminar de liberar',
  title: 'Terminar de liberar el saldo',
  confirmLabel: 'Liberar el saldo',
  description:
    'La reserva ya quedó cancelada con el proveedor: sólo falta devolver el saldo retenido. No se vuelve a llamar al proveedor.',
  pending: 'Cancelada con el proveedor; falta liberar el saldo',
} as const;

/**
 * Qué pasó cuando "Cancelar y liberar" no terminó, según el motivo del API (0060):
 * - `not-cancelled`: el API rechazó antes o sin la cancelación del proveedor (400); nada cambió.
 * - `release-pending`: el proveedor canceló, pero las carteras de la red siguieron ocupadas y el
 *   saldo sigue retenido. Repetir el pedido lo libera sin volver a llamar al proveedor.
 * - `conflict`: la retención quedó como cargo y la concilia una persona.
 * - `unknown`: no se sabe en qué quedó la reserva.
 */
export type RejectionFailureKind = 'not-cancelled' | 'release-pending' | 'conflict' | 'unknown';

export interface RejectionFailure {
  readonly kind: RejectionFailureKind;
  readonly title: string;
  readonly description: string;
}

export function rejectionFailure(
  status: number,
  reason: string | undefined,
  apiMessage: string,
): RejectionFailure {
  const detail = apiMessage.trim();
  if (reason === 'PORTFOLIO_RELEASE_BUSY') {
    return {
      kind: 'release-pending',
      title: 'La reserva quedó cancelada con el proveedor; falta liberar el saldo retenido.',
      description: `Las carteras están ocupadas con otras reservas. Probá "${PORTFOLIO_RELEASE_RETRY.label}" en unos segundos.`,
    };
  }
  if (reason === 'PORTFOLIO_HOLD_STATE_CONFLICT') {
    return {
      kind: 'conflict',
      title: 'El saldo retenido no se liberó: requiere conciliación.',
      description:
        detail !== ''
          ? detail
          : 'La retención quedó como cargo. Pedile a quien te financia que la concilie.',
    };
  }
  if (status === 400) {
    return {
      kind: 'not-cancelled',
      title: 'No se canceló la reserva.',
      description: detail !== '' ? detail : 'Intentá de nuevo.',
    };
  }
  return {
    kind: 'unknown',
    title: 'No pudimos confirmar cómo quedó la reserva.',
    description: `${detail !== '' ? `${detail} ` : ''}Revisá la reserva en Mis Reservas antes de reintentar.`,
  };
}
