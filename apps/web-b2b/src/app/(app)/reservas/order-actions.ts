import { humanizeProviderError } from '../../../lib/provider-errors';
import { readJson } from '../../../lib/read-json';
import { directCancellationBlock, type OrderOperationView } from './cancel-retry-policy';
import { parseFlightTracking, retrieveNotice } from './flight-order-view';

/*
 * Las acciones de post-venta de una reserva contra el API, sin React: la lista de Reservas y el
 * detalle de cada reserva hacen lo mismo con las mismas palabras. Ninguna lanza: cada una devuelve
 * lo que la pantalla tiene que decir.
 */

export interface ActionMessage {
  readonly success: boolean;
  readonly message: string;
}

const CONNECTION_ERROR = 'Error de conexión';

function path(orderId: string, rest = ''): string {
  return `/api/orders/${encodeURIComponent(orderId)}${rest}`;
}

export interface RetrieveResult extends ActionMessage {
  /**
   * Lo guardado tras la lectura (vuelos). `undefined`: el API no lo mandó y hay que releer la
   * orden; `null`: no se pudo leer lo guardado y la pantalla se queda con lo que mostraba.
   */
  readonly flightTracking?: unknown;
  readonly found: boolean;
}

/** «Consultar estado»: lee la reserva en el proveedor y cuenta qué quedó guardado. */
export async function retrieveOrder(order: {
  readonly id: string;
  readonly status: string;
}): Promise<RetrieveResult> {
  try {
    const res = await fetch(path(order.id, '/retrieve'), { method: 'POST' });
    const read = await readJson<{
      found?: boolean;
      status?: unknown;
      flightTracking?: unknown;
      error?: string;
    }>(res);
    const data = read.ok ? read.data : {};
    if (data.found) {
      const notice = retrieveNotice(
        parseFlightTracking(data.flightTracking),
        data.status,
        order.status,
      );
      return {
        found: true,
        success: !notice.alert,
        message: notice.message,
        flightTracking: data.flightTracking,
      };
    }
    return {
      found: false,
      success: false,
      message: humanizeProviderError(data.error ?? 'No encontramos la reserva en el proveedor.'),
    };
  } catch {
    return { found: false, success: false, message: CONNECTION_ERROR };
  }
}

/** Cancela la reserva en el proveedor (la confirmación ya la dio el vendedor). */
export async function cancelOrder(orderId: string): Promise<ActionMessage> {
  try {
    const res = await fetch(path(orderId, '/cancel'), { method: 'POST' });
    const read = await readJson<{
      success?: boolean;
      error?: string;
      message?: string | string[];
    }>(res);
    const data = read.ok ? read.data : {};
    if (data.success) return { success: true, message: 'Reserva cancelada exitosamente' };
    const detail = Array.isArray(data.message) ? data.message.join('. ') : data.message;
    return {
      success: false,
      message: humanizeProviderError(detail ?? data.error ?? 'No se pudo cancelar'),
    };
  } catch {
    return { success: false, message: CONNECTION_ERROR };
  }
}

export type CancellationCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly message: string;
      /** `true`: el historial muestra una cancelación anterior que hay que mirar primero. */
      readonly blockedByHistory: boolean;
    };

/**
 * Comprueba el historial antes de mostrar la confirmación. El backend vuelve a aplicar la misma
 * compuerta; esta lectura sólo evita ofrecer en UI un segundo write que será rechazado.
 */
export async function checkCancellation(orderId: string): Promise<CancellationCheck> {
  try {
    const res = await fetch(path(orderId, '/operations'));
    const read = await readJson<{ operations?: OrderOperationView[]; error?: string }>(res);
    if (!read.ok || !res.ok) {
      return {
        allowed: false,
        blockedByHistory: false,
        message:
          (read.ok ? read.data.error : undefined) ??
          'No pudimos comprobar si existe una cancelación anterior.',
      };
    }
    const block = directCancellationBlock(read.data.operations ?? []);
    return block ? { allowed: false, blockedByHistory: true, message: block } : { allowed: true };
  } catch {
    return {
      allowed: false,
      blockedByHistory: false,
      message:
        'No pudimos comprobar el historial de cancelación. Por seguridad no se enviará la operación.',
    };
  }
}

/** Reenvía la confirmación de la reserva al email de contacto. */
export async function sendOrderConfirmation(orderId: string): Promise<ActionMessage> {
  try {
    const res = await fetch(path(orderId, '/send-confirmation'), { method: 'POST' });
    const read = await readJson<{ sent?: boolean; to?: string; error?: string }>(res);
    const data = read.ok ? read.data : {};
    if (!res.ok) return { success: false, message: data.error ?? 'No se pudo enviar.' };
    return data.sent
      ? { success: true, message: `Confirmación enviada a ${data.to ?? ''}`.trim() }
      : { success: false, message: 'No hay correo configurado para enviar.' };
  } catch {
    return { success: false, message: 'Error de conexión.' };
  }
}

/** Reintenta una cancelación fallida del historial (sólo las que el backend marca reintentables). */
export async function retryCancelOperation(
  orderId: string,
  operationId: string,
): Promise<ActionMessage> {
  try {
    const res = await fetch(path(orderId, `/operations/${encodeURIComponent(operationId)}/retry`), {
      method: 'POST',
    });
    const read = await readJson<{
      success?: boolean;
      error?: string;
      message?: string | string[];
    }>(res);
    const data = read.ok ? read.data : {};
    if (!res.ok || data.success !== true) {
      const detail = Array.isArray(data.message) ? data.message.join('. ') : data.message;
      return {
        success: false,
        message: detail ?? data.error ?? 'No se pudo reintentar la cancelación.',
      };
    }
    return { success: true, message: 'La cancelación se completó correctamente.' };
  } catch {
    return {
      success: false,
      message: 'No pudimos comprobar el resultado. No vuelvas a enviarlo; revisa el historial.',
    };
  }
}
