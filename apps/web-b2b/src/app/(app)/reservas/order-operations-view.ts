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
  issue: 'Emisión',
  'add-services': 'Servicios adicionales',
  'remove-services': 'Quitar servicios adicionales',
};

/**
 * Un tipo que esta versión no conoce sale por su código: al menos es diagnosticable. Una cancelación
 * que anuló los tiquetes de la reserva (`ticketOperation: 'VOID'`, SAB-09) se nombra por lo que hizo.
 */
export function operationTypeLabel(type: string, ticketOperation?: string): string {
  if (type === 'cancel' && ticketOperation === 'VOID') return 'Anulación de tiquetes';
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
  readonly reconciliationRequired?: boolean;
  readonly ticketOperation?: string;
}): OperationStatusView {
  const tone = toneOf(op.status);
  if (op.type === 'cancel' && op.ticketOperation === 'VOID') {
    // Una anulación en duda no "falló": puede haber tiquetes anulados. Se revisa, no se repite.
    if (tone === 'failed' && op.reconciliationRequired === true) {
      return { tone: 'pending', label: 'Sin confirmar' };
    }
    return {
      tone,
      label: tone === 'ok' ? 'Anulada' : tone === 'failed' ? 'No se anuló' : 'En curso',
    };
  }
  if (op.type === 'issue') {
    // Una emisión en duda no "falló": puede haber tiquetes. Se revisa, no se vuelve a pedir.
    if (tone === 'failed' && op.reconciliationRequired === true) {
      return { tone: 'pending', label: 'Sin confirmar' };
    }
    return { tone, label: tone === 'ok' ? 'Emitida' : tone === 'failed' ? 'Falló' : 'En curso' };
  }
  if (op.type === 'add-services' || op.type === 'remove-services') {
    // Un cambio de servicios en duda no «falló»: la aerolínea pudo hacerlo. Se revisa, no se repite.
    if (tone === 'failed' && op.reconciliationRequired === true) {
      return { tone: 'pending', label: 'Sin confirmar' };
    }
    return { tone, label: tone === 'ok' ? 'Hecho' : tone === 'failed' ? 'No se hizo' : 'En curso' };
  }
  if (op.type === 'hcn-ticket') {
    return { tone, label: tone === 'ok' ? 'Resuelta' : tone === 'failed' ? 'Falló' : 'Abierta' };
  }
  if (op.type === 'hcn-check' || op.type === 'reconcile') {
    return { tone, label: tone === 'ok' ? 'OK' : tone === 'failed' ? 'Falló' : 'En curso' };
  }
  return { tone, label: tone === 'ok' ? 'OK' : tone === 'failed' ? 'Falló' : 'Pendiente' };
}
