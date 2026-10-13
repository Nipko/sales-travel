import {
  canRetryCancelOperation,
  directCancellationBlock,
  type OrderOperationView,
} from '../app/(app)/reservas/cancel-retry-policy';
import {
  CANCELLATION_STILL_RUNNING,
  penaltyViewOf,
  type HotelCancellationEstimate,
} from '../app/(app)/reservas/hotel-cancellation-view';
import { parseHotelTracking } from '../app/(app)/reservas/hotel-order-view';
import { supportsOrderCancellation } from '../app/(app)/reservas/order-capabilities';
import { orderVerticalOf } from './order-vertical';
import { parsePlatformOrderDetail, type PlatformOrderDetail } from './platform-orders';

/**
 * Plataforma → Reservas de la red: la post-venta que el superadmin hace desde la ficha de una
 * reserva de cualquier nodo (FD-1 C, 2026-10-13). Reenviar la confirmación, consultar el estado al
 * proveedor, reintentar una cancelación fallida y cancelar en nombre de la agencia. Nada de esto
 * vende. Sin I/O: qué se ofrece, los textos y la lectura de las respuestas.
 *
 * Cada acción pide un motivo, que queda en la auditoría del nodo de la reserva (lo ven la agencia y
 * la plataforma). Qué se puede de verdad lo decide el API con las mismas reglas que Reservas de la
 * agencia; acá sólo se evita ofrecer lo que el API va a rechazar.
 */

// ───────────────────────────── El motivo ─────────────────────────────

/** ADMIN_ORDER_ACTION_REASON_MIN/MAX del API. */
export const ORDER_ACTION_REASON_MIN = 5;
export const ORDER_ACTION_REASON_MAX = 500;

export const ORDER_ACTION_REASON_LABEL = 'Motivo (queda en la auditoría)';

/** Un carácter de control que no es salto de línea ni tabulación (el motivo se escribe en un área). */
const CONTROL_CHARACTER = /(?![\n\r\t])\p{Cc}/u;

/** Qué le falta al motivo, o `undefined` si sirve. Se mide recortado, como el API. */
export function actionReasonError(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return 'Escribe el motivo: queda en la auditoría.';
  if (trimmed.length < ORDER_ACTION_REASON_MIN) {
    return `Escribe al menos ${ORDER_ACTION_REASON_MIN} caracteres.`;
  }
  if (trimmed.length > ORDER_ACTION_REASON_MAX) {
    return `El motivo puede tener hasta ${ORDER_ACTION_REASON_MAX} caracteres.`;
  }
  if (CONTROL_CHARACTER.test(trimmed)) return 'El motivo tiene caracteres no válidos.';
  return undefined;
}

// ───────────────────────────── Qué se ofrece ─────────────────────────────

/** La acción que abre el diálogo. */
export type PlatformOrderAction =
  | { readonly kind: 'send-confirmation'; readonly to: string }
  | { readonly kind: 'retrieve' }
  | { readonly kind: 'retry-cancel'; readonly operationId: string }
  | { readonly kind: 'cancel' };

export interface PlatformOrderActions {
  /** Reenviar la confirmación: sólo una confirmada o emitida, con correo de contacto. */
  readonly sendConfirmation: { readonly to: string } | null;
  /** Consultar al proveedor: si su proveedor sabe y la reserva tiene localizador. */
  readonly retrieve: boolean;
  /**
   * Cancelar en nombre de la agencia. `null` si no corresponde (cancelada, fallida, emitida, sin
   * localizador o un proveedor que no cancela); `blocked` dice por qué no se ofrece ahora aunque se
   * pueda (un intento anterior que hay que reintentar o conciliar).
   */
  readonly cancel: { readonly blocked: string | null } | null;
}

function hasLocator(detail: PlatformOrderDetail): boolean {
  return detail.order.pnr !== null && detail.order.pnr.trim() !== '';
}

/** Lo que la ficha ofrece, con las reglas de Reservas de la agencia. */
export function platformOrderActionsOf(detail: PlatformOrderDetail): PlatformOrderActions {
  const { order, capabilities } = detail;
  const email = order.contact.email;
  const sendConfirmation =
    (order.status === 'confirmed' || order.status === 'ticketed') && email !== null
      ? { to: email }
      : null;
  const cancellable =
    hasLocator(detail) &&
    order.status !== 'cancelled' &&
    order.status !== 'failed' &&
    supportsOrderCancellation(
      capabilities,
      order.status,
      parseHotelTracking(order.providerTracking),
    );
  return {
    sendConfirmation,
    retrieve: capabilities.retrieve && hasLocator(detail),
    cancel: cancellable ? { blocked: directCancellationBlock(detail.operations) } : null,
  };
}

/**
 * ¿Se ofrece "Reintentar" en esta operación del historial? La misma regla que la agencia (sólo la
 * cancelación que falló antes de enviarse), y sólo si el proveedor de la reserva cancela.
 */
export function canRetryFromConsole(
  detail: PlatformOrderDetail,
  operation: OrderOperationView,
): boolean {
  return detail.capabilities.cancel && hasLocator(detail) && canRetryCancelOperation(operation);
}

/** Si el texto escrito es el número de la orden. Acepta "1042" y "#1042". */
export function typedOrderNumberMatches(typed: string, orderNumber: number): boolean {
  const value = typed.trim().replace(/^#\s*/, '');
  return /^\d{1,10}$/.test(value) && Number(value) === orderNumber;
}

// ───────────────────────────── Textos del diálogo ─────────────────────────────

export interface ActionDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly pendingLabel: string;
  readonly destructive: boolean;
}

export function actionDialogCopy(
  action: PlatformOrderAction,
  detail: PlatformOrderDetail,
): ActionDialogCopy {
  const node = detail.tenant.name;
  switch (action.kind) {
    case 'send-confirmation':
      return {
        title: `Reenviar la confirmación a ${action.to}`,
        description: `Le llega al cliente con la marca y el correo de ${node}, como si la reenviara la agencia.`,
        confirmLabel: 'Reenviar confirmación',
        pendingLabel: 'Enviando…',
        destructive: false,
      };
    case 'retrieve':
      return {
        title: 'Consultar el estado al proveedor',
        description: `Leemos la reserva ${detail.order.pnr ?? ''} con la cuenta de ${node}. No cambia nada en el proveedor.`,
        confirmLabel: 'Consultar',
        pendingLabel: 'Consultando…',
        destructive: false,
      };
    case 'retry-cancel':
      return {
        title: 'Reintentar la cancelación',
        description: `La agencia ya pidió cancelar y el intento falló antes de llegar al proveedor. Se reintenta ese mismo pedido, en nombre de ${node}.`,
        confirmLabel: 'Reintentar',
        pendingLabel: 'Reintentando…',
        destructive: false,
      };
    case 'cancel':
      return {
        title: `Cancelar la reserva #${detail.order.orderNumber} de ${node}`,
        description:
          'La cancelas en nombre de la agencia y no se puede deshacer. La agencia la ve cancelada por ti.',
        confirmLabel: 'Cancelar reserva',
        pendingLabel: 'Cancelando…',
        destructive: true,
      };
  }
}

/** La pista del campo de confirmación de cancelar. */
export function typedConfirmationHint(orderNumber: number): string {
  return `Escribe ${orderNumber} para confirmar.`;
}

// ───────────────────────────── La penalidad ─────────────────────────────

/** Lo que se sabe de la penalidad antes de cancelar. */
export type PenaltyState =
  | { readonly kind: 'loading' }
  /** Vuelos y autos: la plataforma no la estima, la informa el proveedor al cancelar. */
  | { readonly kind: 'not-estimated' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly estimate: HotelCancellationEstimate };

/** ¿Hay que pedir la penalidad estimada? Sólo existe para reservas de hotel. */
export function needsPenaltyEstimate(detail: PlatformOrderDetail): boolean {
  return orderVerticalOf(detail.order) === 'hotels';
}

export interface PenaltyLine {
  /** La frase principal. */
  readonly line: string;
  /** Aclaraciones de la estimación, en orden de importancia. */
  readonly notes: readonly string[];
  /** Por qué no se puede cancelar desde acá (desde el día de entrada la gestiona soporte). */
  readonly blocked: string | null;
}

function lowerFirst(text: string): string {
  return /^\p{Lu}\p{Ll}/u.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

export function penaltyLineOf(state: PenaltyState, detail: PlatformOrderDetail): PenaltyLine {
  switch (state.kind) {
    case 'loading':
      return { line: 'Calculando la penalidad estimada…', notes: [], blocked: null };
    case 'not-estimated':
      return {
        line: 'Penalidad: la informa el proveedor al cancelar. No tenemos una estimación propia para esta reserva.',
        notes: [],
        blocked: null,
      };
    case 'error':
      // Sin la penalidad a la vista no se cancela: se ofrece volver a calcularla.
      return {
        line: `No pudimos calcular la penalidad estimada. ${state.message}`,
        notes: [],
        blocked: null,
      };
    case 'ready': {
      const sale = { amountMinor: detail.order.totalAmount, currency: detail.order.currency };
      const view = penaltyViewOf(state.estimate, sale);
      const line =
        view.tone === 'unknown'
          ? 'Penalidad estimada: no la podemos calcular. La define el proveedor al cancelar.'
          : `Penalidad estimada: ${lowerFirst(view.headline)}. Es nuestra estimación, no un dato del proveedor.`;
      return { line, notes: view.notes, blocked: view.blocked ?? null };
    }
  }
}

// ───────────────────────────── Las respuestas ─────────────────────────────

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** `POST …/send-confirmation`: si salió y a quién. */
export function parseConfirmationSent(
  body: unknown,
): { readonly sent: boolean; readonly to: string } | undefined {
  const r = asRecord(body);
  const sent = r?.['sent'];
  const to = r?.['to'];
  if (typeof sent !== 'boolean' || typeof to !== 'string') return undefined;
  return { sent, to: to.slice(0, 254) };
}

export interface RetrieveResult {
  /** Si el proveedor tiene la reserva. */
  readonly found: boolean;
  /** Su estado en el proveedor, en su código; `null` si no lo informó. */
  readonly providerStatus: string | null;
  /** La ficha releída; `undefined` si no vino o no se pudo leer (se vuelve a pedir). */
  readonly detail: PlatformOrderDetail | undefined;
}

/** `POST …/retrieve`: la lectura del proveedor y la ficha ya actualizada. */
export function parseRetrieveResult(body: unknown): RetrieveResult | undefined {
  const r = asRecord(body);
  const reading = asRecord(r?.['reading']);
  if (reading === undefined || typeof reading['found'] !== 'boolean') return undefined;
  const status = reading['status'];
  return {
    found: reading['found'],
    providerStatus: typeof status === 'string' && status.trim() !== '' ? status.slice(0, 60) : null,
    detail: r?.['detail'] === null ? undefined : parsePlatformOrderDetail(r?.['detail']),
  };
}

// ───────────────────────────── Los mensajes ─────────────────────────────

/** Los textos por defecto de Nest, en inglés: no se le muestran a nadie. */
const NEST_DEFAULT =
  /^(?:Not Found|Forbidden|Bad Request|Conflict|Unauthorized|Internal Server Error|Too Many Requests|Unprocessable Entity)$/;

function apiText(message: string | undefined): string | undefined {
  const text = message?.trim() ?? '';
  return text === '' || NEST_DEFAULT.test(text) ? undefined : text;
}

/** El mensaje de una acción que el servidor rechazó, en tú. */
export function actionErrorMessage(status: number, apiMessage: string | undefined): string {
  const fromApi = apiText(apiMessage);
  if (status === 0) {
    return 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
  }
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) {
    return fromApi ?? 'Sólo el superadmin de la plataforma puede hacer esto.';
  }
  if (status === 404) return fromApi ?? 'Esa reserva no existe o ya no está disponible.';
  if (status === 429)
    return 'Demasiados pedidos seguidos. Espera un momento y vuelve a intentarlo.';
  if (status >= 400 && status < 500) {
    return fromApi ?? 'No se pudo hacer: revisa el estado de la reserva y vuelve a intentarlo.';
  }
  return 'No pudimos completar la acción. Reintenta en unos segundos.';
}

export const CONFIRMATION_NOT_SENT =
  'El correo no salió. Revisa la configuración de correo del nodo y vuelve a intentarlo.';

export function confirmationSentToast(to: string): string {
  return `Confirmación enviada a ${to}.`;
}

export const RETRIEVE_DONE_TOAST = 'Estado actualizado con el proveedor.';
export const RETRIEVE_NOT_FOUND_TOAST =
  'El proveedor no encuentra esta reserva. Revisa el localizador con la agencia.';
export const RETRY_SENT_TOAST = 'Reintento enviado. Te avisamos el resultado en el historial.';

/** Cómo terminó una cancelación (nueva o reintentada) pedida desde la consola. */
export type ConsoleCancelOutcome =
  /** El proveedor la aceptó: cancelada, o en curso si todavía la procesa. */
  | { readonly kind: 'done'; readonly inProgress: boolean }
  /** El proveedor no la aceptó, o el servidor la rechazó: la reserva sigue como estaba. */
  | { readonly kind: 'failed'; readonly message: string }
  /** Sin respuesta: pudo haber salido. Nunca se ofrece repetirla sin mirar el estado. */
  | { readonly kind: 'unknown'; readonly message: string };

export const CANCEL_UNKNOWN_MESSAGE =
  'No recibimos la respuesta y la cancelación pudo haber salido. No la repitas: espera unos minutos y revisa el estado de la reserva.';

/** Estados en que el pedido pudo haber llegado al proveedor aunque no haya respuesta. */
function unanswered(status: number): boolean {
  return status === 0 || status === 408 || status === 524 || status >= 500;
}

/**
 * Qué pasó con `POST …/cancel` o `…/operations/:opId/retry`. Un 200 no siempre es "cancelada": el
 * proveedor puede rechazarla (`success: false`) o seguir procesándola (`settlement: in-progress`).
 */
export function consoleCancelOutcomeOf(status: number, body: unknown): ConsoleCancelOutcome {
  if (unanswered(status)) return { kind: 'unknown', message: CANCEL_UNKNOWN_MESSAGE };
  const r = asRecord(body) ?? {};
  if (status >= 200 && status < 300) {
    if (typeof r['success'] !== 'boolean') {
      return { kind: 'unknown', message: CANCEL_UNKNOWN_MESSAGE };
    }
    if (!r['success']) {
      return {
        kind: 'failed',
        message:
          'El proveedor no aceptó la cancelación: la reserva sigue vigente. Revisa su política antes de volver a intentar.',
      };
    }
    const warnings = Array.isArray(r['warnings']) ? r['warnings'] : [];
    return {
      kind: 'done',
      inProgress:
        r['settlement'] === 'in-progress' || warnings.includes(CANCELLATION_STILL_RUNNING),
    };
  }
  const error = r['error'];
  return {
    kind: 'failed',
    message: actionErrorMessage(status, typeof error === 'string' ? error : undefined),
  };
}

export function cancelDoneToast(orderNumber: number, inProgress: boolean): string {
  return inProgress
    ? `Cancelación de la reserva #${orderNumber} en curso: el estado final aparece en la ficha.`
    : `Reserva #${orderNumber} cancelada.`;
}

export function retryDoneToast(inProgress: boolean): string {
  return inProgress
    ? 'Reintento en curso con el proveedor. Te avisamos el resultado en el historial.'
    : RETRY_SENT_TOAST;
}
