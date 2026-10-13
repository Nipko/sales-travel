import type { OrderOperationView } from './cancel-retry-policy';
import { parseFlightTracking } from './flight-order-view';
import { formatReadAt } from './hotel-order-view';
import { supportsOrderCapability, type OrderCapabilities } from './order-capabilities';

/*
 * Las condiciones de los tiquetes de una reserva emitida y su anulación (SAB-09), sin React.
 *
 * La consulta es en vivo y sólo cuando el vendedor la pide: la ventana para anular sin costo la
 * decide la aerolínea y cambia con el reloj, así que no se guarda ni se calcula. Por eso la pantalla
 * muestra un semáforo con lo que el proveedor dijo y la hora a la que lo dijo, nunca un contador.
 */

export const TICKET_CONDITIONS_MESSAGES = {
  heading: 'Condiciones de los tiquetes',
  hint: 'Se consultan en vivo con la aerolínea y valen para este momento.',
  check: 'Consultar condiciones',
  recheck: 'Volver a consultar',
  checking: 'Consultando con la aerolínea…',
  available: 'Se puede anular sin costo',
  unavailable: 'Ya no se puede anular',
  unknown: 'La aerolínea no informó si se puede anular',
  voidButton: 'Anular tiquetes',
  confirmButton: 'Sí, anular tiquetes',
  voiding: 'Anulando…',
  voidingNote: 'Anulando los tiquetes con la aerolínea. No cierres esta ventana.',
  voided: 'Tiquetes anulados. La reserva quedó cancelada.',
  unverified:
    'No pudimos confirmar la anulación. No reintentes: revisamos la reserva con el proveedor.',
  checkFailed: 'No pudimos consultar las condiciones. Vuelve a intentarlo en unos minutos.',
  sendUnknown:
    'No pudimos confirmar si la anulación salió. No la repitas: revisa el historial de la reserva en unos minutos.',
  voidFailed: 'No se pudieron anular los tiquetes.',
  opsLoading: 'Comprobando el historial de la reserva…',
  opsFailed:
    'No pudimos comprobar si hay una cancelación anterior. Por seguridad no se ofrece anular.',
  pendingBlock: 'Ya hay una cancelación o anulación en curso para esta reserva.',
  unverifiedBlock:
    'La anulación anterior quedó sin confirmar. No reintentes: revisamos la reserva con el proveedor.',
  cancelledBlock: 'La reserva ya registra una cancelación. Consulta su estado antes de seguir.',
  testNote: 'Reserva de prueba: la anulación se hace en el entorno de pruebas del proveedor.',
} as const;

/**
 * Los motivos máquina con los que responde `POST /orders/:id/void` (`TICKET_VOID_REASONS` del API).
 * La pantalla decide con ellos, nunca comparando textos.
 */
export const TICKET_VOID_REASONS = {
  notAvailable: 'TICKET_VOID_NOT_AVAILABLE',
  unverified: 'TICKET_VOID_UNVERIFIED',
  rejected: 'TICKET_VOID_REJECTED',
  notSent: 'TICKET_VOID_NOT_SENT',
} as const;

/** Lo que estas funciones leen de una orden de `GET /orders`. */
export interface TicketConditionsOrder {
  readonly status: string;
  readonly pnr: string | null;
  readonly orderNumber: number;
  readonly capabilities?: Partial<OrderCapabilities>;
  readonly flightTracking?: unknown;
}

/**
 * «Condiciones de los tiquetes» se ofrece en una reserva emitida, con localizador, si el proveedor
 * declara la consulta. No es venta: también la ve el superadmin.
 */
export function canCheckTicketConditions(order: TicketConditionsOrder): boolean {
  return (
    order.status === 'ticketed' &&
    typeof order.pnr === 'string' &&
    order.pnr.length > 0 &&
    supportsOrderCapability(order.capabilities, 'ticketCheck')
  );
}

export type TicketEligibilityView = 'yes' | 'no' | 'unknown';
export type VoidStatusView = 'available' | 'unavailable' | 'unknown';

export interface TicketCheckView {
  readonly checkedAt: string;
  readonly tickets: readonly {
    readonly number: string;
    readonly voidable: TicketEligibilityView;
    readonly refundable: TicketEligibilityView;
  }[];
  readonly voidAvailable: boolean;
  readonly voidStatus: VoidStatusView;
  readonly voidExpiresAt?: string;
}

const ELIGIBILITY: ReadonlySet<string> = new Set(['yes', 'no', 'unknown']);
const VOID_STATUS: ReadonlySet<string> = new Set(['available', 'unavailable', 'unknown']);
/** El número principal de un tiquete, como lo publica el API. */
const TICKET_NUMBER = /^[0-9]{10,16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eligibility(value: unknown): TicketEligibilityView {
  return typeof value === 'string' && ELIGIBILITY.has(value)
    ? (value as TicketEligibilityView)
    : 'unknown';
}

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/**
 * La respuesta de `GET /orders/:id/ticket-check`, validada. `null` si no tiene la forma: la pantalla
 * no adivina un semáforo. Sin `voidStatus` (un API anterior), se deduce de `voidAvailable` y, ante
 * la duda, es gris: nunca verde sin que el API lo diga con las dos señales.
 */
export function parseTicketCheck(raw: unknown): TicketCheckView | null {
  if (!isRecord(raw)) return null;
  const checkedAt = isoOrUndefined(raw['checkedAt']);
  const rawTickets = raw['tickets'];
  const voidAvailable = raw['voidAvailable'];
  if (checkedAt === undefined || !Array.isArray(rawTickets) || typeof voidAvailable !== 'boolean') {
    return null;
  }
  const tickets = rawTickets.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const number = entry['number'];
    if (typeof number !== 'string' || !TICKET_NUMBER.test(number)) return [];
    return [
      {
        number,
        voidable: eligibility(entry['voidable']),
        refundable: eligibility(entry['refundable']),
      },
    ];
  });
  const declared = raw['voidStatus'];
  const status: VoidStatusView =
    typeof declared === 'string' && VOID_STATUS.has(declared)
      ? (declared as VoidStatusView)
      : voidAvailable
        ? 'available'
        : 'unknown';
  // Verde sólo si las dos señales coinciden; si discrepan, gris y sin botón.
  const voidStatus: VoidStatusView = status === 'available' && !voidAvailable ? 'unknown' : status;
  const voidExpiresAt = isoOrUndefined(raw['voidExpiresAt']);
  return {
    checkedAt,
    tickets,
    voidAvailable: voidAvailable && voidStatus === 'available',
    voidStatus,
    ...(voidExpiresAt === undefined ? {} : { voidExpiresAt }),
  };
}

export type SignalTone = 'ok' | 'danger' | 'muted';

export interface VoidSignal {
  readonly tone: SignalTone;
  readonly label: string;
  /** «hasta …», en la hora local de quien mira. Sólo si el proveedor dio el plazo. */
  readonly until?: string;
}

/**
 * El semáforo: verde, rojo o gris, con texto (nunca sólo el color). El plazo sale en la hora local
 * de quien mira; `timeZone` sólo para los tests.
 */
export function voidSignalOf(check: TicketCheckView, timeZone?: string): VoidSignal {
  if (check.voidStatus === 'available') {
    return {
      tone: 'ok',
      label: TICKET_CONDITIONS_MESSAGES.available,
      ...(check.voidExpiresAt === undefined
        ? {}
        : { until: `hasta ${formatReadAt(check.voidExpiresAt, timeZone)}` }),
    };
  }
  if (check.voidStatus === 'unavailable') {
    return { tone: 'danger', label: TICKET_CONDITIONS_MESSAGES.unavailable };
  }
  return { tone: 'muted', label: TICKET_CONDITIONS_MESSAGES.unknown };
}

/** «Consultado el …», en la hora local de quien mira. */
export function checkedAtLabel(check: TicketCheckView, timeZone?: string): string {
  return `Consultado el ${formatReadAt(check.checkedAt, timeZone)}`;
}

const VOIDABLE_LABEL: Readonly<Record<TicketEligibilityView, string>> = {
  yes: 'Anulable',
  no: 'No anulable',
  unknown: 'Anulación sin dato',
};

const REFUNDABLE_LABEL: Readonly<Record<TicketEligibilityView, string>> = {
  yes: 'Reembolsable',
  no: 'No reembolsable',
  unknown: 'Reembolso sin dato',
};

export function voidableLabel(value: TicketEligibilityView): string {
  return VOIDABLE_LABEL[value];
}

export function refundableLabel(value: TicketEligibilityView): string {
  return REFUNDABLE_LABEL[value];
}

/** La cancelación más reciente del historial (el API lo devuelve del más nuevo al más viejo). */
function latestCancel(operations: readonly OrderOperationView[]): OrderOperationView | undefined {
  return operations.find((operation) => operation.type === 'cancel');
}

/**
 * Lo que impide pedir una anulación, o `null`. Es la misma compuerta del API: una cancelación
 * exitosa, una en curso o una en duda la bloquean; una que falló sin dejar nada que conciliar, no
 * (la anulación nueva viene con su propia consulta). Esto sólo evita ofrecer un pedido que el API
 * va a rechazar.
 */
export function voidBlock(operations: readonly OrderOperationView[]): string | null {
  const latest = latestCancel(operations);
  if (latest === undefined) return null;
  if (latest.status === 'success' || latest.outcome === 'SUCCEEDED') {
    return TICKET_CONDITIONS_MESSAGES.cancelledBlock;
  }
  if (latest.status === 'pending') return TICKET_CONDITIONS_MESSAGES.pendingBlock;
  if (latest.reconciliationRequired || latest.outcome === 'UNVERIFIED') {
    return TICKET_CONDITIONS_MESSAGES.unverifiedBlock;
  }
  return null;
}

/**
 * «Anular tiquetes» sólo con la consulta recién hecha en verde, la capacidad `void` y nada en curso
 * en el historial.
 */
export function canVoidTickets(
  order: TicketConditionsOrder,
  check: TicketCheckView | null,
  operations: readonly OrderOperationView[],
): boolean {
  return (
    canCheckTicketConditions(order) &&
    supportsOrderCapability(order.capabilities, 'void') &&
    check !== null &&
    check.voidAvailable &&
    voidBlock(operations) === null
  );
}

/**
 * Cuántos tiquetes se anulan: los que trae la consulta o, si el proveedor la responde por oferta
 * (sin tiquetes), los emitidos que la reserva tiene guardados. `null` si no se sabe.
 */
export function voidTicketCount(
  order: TicketConditionsOrder,
  check: TicketCheckView,
): number | null {
  if (check.tickets.length > 0) return check.tickets.length;
  const issued = (parseFlightTracking(order.flightTracking)?.documents ?? []).filter(
    (document) => document.kind === 'TICKET' && document.status === 'ISSUED',
  ).length;
  return issued > 0 ? issued : null;
}

/** El texto de la confirmación: qué pasa y cuántos tiquetes. */
export function voidConfirmMessage(count: number | null, orderNumber: number): string {
  const which =
    count === null ? 'los tiquetes' : count === 1 ? 'el tiquete' : `los ${String(count)} tiquetes`;
  return `Anular los tiquetes cancela la reserva y libera los asientos. No se cobra penalidad. ¿Anular ${which} de la reserva #${String(orderNumber)}?`;
}

/** El texto para el vendedor de una respuesta de error: `message` primero, luego `error`. */
function messageOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  for (const key of ['message', 'error']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value)) {
      const parts = value.filter((v): v is string => typeof v === 'string');
      if (parts.length > 0) return parts.join('. ');
    }
  }
  return undefined;
}

function reasonOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const reason = data['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** La respuesta de la consulta: las condiciones, o el motivo para mostrar. */
export type TicketCheckResponse =
  | { readonly ok: true; readonly check: TicketCheckView }
  | { readonly ok: false; readonly message: string };

export function ticketCheckResponseOf(status: number, data: unknown): TicketCheckResponse {
  if (status === 200) {
    const check = parseTicketCheck(data);
    if (check !== null) return { ok: true, check };
    return { ok: false, message: TICKET_CONDITIONS_MESSAGES.checkFailed };
  }
  return { ok: false, message: messageOf(data) ?? TICKET_CONDITIONS_MESSAGES.checkFailed };
}

/**
 * En qué quedó la anulación, para el vendedor.
 *
 * - `voided`: anulada; la reserva quedó cancelada.
 * - `unverified`: a medias, sin confirmar o sin respuesta legible; se concilia y NO se repite.
 * - `failed`: no se anuló nada (la ventana se cerró, la aerolínea la rechazó o no llegó a salir),
 *   con el motivo del API. Se puede volver a consultar las condiciones.
 */
export type VoidResult =
  | { readonly kind: 'voided'; readonly message: string }
  | { readonly kind: 'unverified'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

const FAILED_REASONS: ReadonlySet<string> = new Set([
  TICKET_VOID_REASONS.notAvailable,
  TICKET_VOID_REASONS.rejected,
  TICKET_VOID_REASONS.notSent,
]);

/**
 * `status` es el estado de la respuesta y `data` su cuerpo, `null` si no se pudo leer. Ante la duda,
 * `unverified`: ofrecer repetir una anulación que pudo salir es el error caro.
 */
export function voidResultOf(status: number, data: unknown): VoidResult {
  if (status === 200 && isRecord(data)) {
    const outcome = data['outcome'];
    if (outcome === 'VOIDED') return { kind: 'voided', message: TICKET_CONDITIONS_MESSAGES.voided };
    if (outcome === 'PARTIAL' || outcome === 'UNVERIFIED') {
      return { kind: 'unverified', message: TICKET_CONDITIONS_MESSAGES.unverified };
    }
  }
  const reason = reasonOf(data);
  if (reason === TICKET_VOID_REASONS.unverified) {
    return { kind: 'unverified', message: TICKET_CONDITIONS_MESSAGES.unverified };
  }
  if (reason !== undefined && FAILED_REASONS.has(reason)) {
    return { kind: 'failed', message: messageOf(data) ?? TICKET_CONDITIONS_MESSAGES.voidFailed };
  }
  if (status >= 400 && status < 500) {
    // Un rechazo del API antes de anular: rol, estado, otra cancelación en curso.
    return { kind: 'failed', message: messageOf(data) ?? TICKET_CONDITIONS_MESSAGES.voidFailed };
  }
  // Un 5xx sin motivo, un 2xx sin desenlace o nada legible: no se sabe si salió.
  return { kind: 'unverified', message: TICKET_CONDITIONS_MESSAGES.sendUnknown };
}
