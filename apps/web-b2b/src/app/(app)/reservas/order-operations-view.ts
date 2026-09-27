/*
 * Cómo se lee cada fila del historial de operaciones de una reserva. Además de las que pide el
 * vendedor (cancelar, pagar, consultar), la post-venta de hotel escribe las suyas (0042): la
 * consulta automática del número de confirmación del hotel (`hcn-check`), la tarea que se abre
 * para que operaciones lo consiga cuando no llega (`hcn-ticket`) y la conciliación (`reconcile`).
 * Sin una etiqueta, el vendedor veía el código crudo.
 */

const TYPE_LABELS: Readonly<Record<string, string>> = {
  cancel: 'Cancelación',
  pay: 'Pago / Emisión',
  reshop: 'Reemisión',
  retrieve: 'Consulta de estado',
  'hcn-check': 'Consulta del número de confirmación del hotel',
  'hcn-ticket': 'Tarea de operaciones: conseguir el número de confirmación del hotel',
  reconcile: 'Conciliación con el proveedor',
};

/** Un tipo que esta versión no conoce sale por su código: al menos es diagnosticable. */
export function operationTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

export type OperationTone = 'ok' | 'failed' | 'pending';

export interface OperationStatusView {
  readonly label: string;
  readonly tone: OperationTone;
}

function toneOf(status: string): OperationTone {
  return status === 'success' ? 'ok' : status === 'failed' ? 'failed' : 'pending';
}

/**
 * La tarea de operaciones no "está pendiente" ni "sale bien": está abierta hasta que alguien (o una
 * lectura que trae el número) la resuelve. Los jobs automáticos corren; no esperan a nadie.
 */
export function operationStatusView(op: {
  readonly type: string;
  readonly status: string;
}): OperationStatusView {
  const tone = toneOf(op.status);
  if (op.type === 'hcn-ticket') {
    return { tone, label: tone === 'ok' ? 'Resuelta' : tone === 'failed' ? 'Falló' : 'Abierta' };
  }
  if (op.type === 'hcn-check' || op.type === 'reconcile') {
    return { tone, label: tone === 'ok' ? 'OK' : tone === 'failed' ? 'Falló' : 'En curso' };
  }
  return { tone, label: tone === 'ok' ? 'OK' : tone === 'failed' ? 'Falló' : 'Pendiente' };
}
