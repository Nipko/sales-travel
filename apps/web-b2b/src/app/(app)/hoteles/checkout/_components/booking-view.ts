import type { Money } from '../../actions';
import { formatMoney } from '../../_components/hotel-format';
import { NETWORK_DETAIL, PORTFOLIO_TITLES, isNetworkFundingReason } from './funding-view';
import {
  AT_PROPERTY_FIELD,
  AT_PROPERTY_REQUIRED,
  fieldErrorsFromGuestIssues,
  fieldErrorsFromValidation,
} from './guest-form-view';
import {
  NON_REFUNDABLE_FIELD,
  NON_REFUNDABLE_REQUIRED,
  parseNonRefundable,
  type PrebookNonRefundable,
} from './non-refundable-view';
import type { PriceChangeView } from './prebook-view';

/*
 * La reserva del paso 2 sin React (U-13, U-14, U-18, U-19; RF-20, RF-22; D-TBO-09 A): qué hacer
 * con cada respuesta de `POST /api/hotels/book`, cómo se sigue una orden que quedó en curso y
 * cuándo se conserva la `Idempotency-Key`.
 *
 * La regla de fondo es la de vuelos: una respuesta que no se entiende NO es un rechazo. Sólo se
 * ofrece volver a reservar con otra clave cuando el servidor dijo con todas las letras que no
 * reservó nada; si no se sabe, se conserva la clave del intento —reenviarla no puede reservar dos
 * veces: el servidor la reconoce y responde con la orden— y se mira la orden.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function moneyOf(value: unknown): Money | undefined {
  if (!isRecord(value)) return undefined;
  const { amountMinor, currency } = value;
  return typeof amountMinor === 'number' &&
    Number.isInteger(amountMinor) &&
    typeof currency === 'string' &&
    /^[A-Z]{3}$/.test(currency)
    ? { amountMinor, currency }
    : undefined;
}

// ───────────────────────── Respuesta del Book ─────────────────────────

export type HotelOrderStatus = 'pending' | 'confirmed' | 'ticketed' | 'cancelled' | 'failed';

const ORDER_STATUSES: ReadonlySet<string> = new Set<HotelOrderStatus>([
  'pending',
  'confirmed',
  'ticketed',
  'cancelled',
  'failed',
]);

/** Lo que responde el Book con `201` o `202`. Sin datos de huéspedes. */
export interface HotelBookingSummary {
  readonly orderId: string;
  readonly orderNumber?: number;
  readonly status: HotelOrderStatus;
  readonly providerBookingId?: string;
  /** Nuestra referencia, la que el proveedor devuelve en su conciliación. */
  readonly bookingReference?: string;
  /** Precio de venta. */
  readonly total?: Money;
  /** Motivo máquina del desenlace (`book-in-progress`, `session-expired`…). */
  readonly reason?: string;
  /** Ya en el idioma del vendedor. */
  readonly message?: string;
  readonly warnings: readonly string[];
}

export function parseBookingSummary(value: unknown): HotelBookingSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { orderId, status, orderNumber } = value;
  if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) return undefined;
  if (typeof status !== 'string' || !ORDER_STATUSES.has(status)) return undefined;
  const providerBookingId = nonEmpty(value['providerBookingId']);
  const bookingReference = nonEmpty(value['bookingReference']);
  const total = moneyOf(value['total']);
  const reason = nonEmpty(value['reason']);
  const message = nonEmpty(value['message']);
  const warnings = Array.isArray(value['warnings'])
    ? value['warnings'].filter((w): w is string => typeof w === 'string')
    : [];
  return {
    orderId,
    status: status as HotelOrderStatus,
    ...(typeof orderNumber === 'number' && Number.isInteger(orderNumber) ? { orderNumber } : {}),
    ...(providerBookingId ? { providerBookingId } : {}),
    ...(bookingReference ? { bookingReference } : {}),
    ...(total ? { total } : {}),
    ...(reason ? { reason } : {}),
    ...(message ? { message } : {}),
    warnings,
  };
}

/** Qué le queda al vendedor después de un Book que el proveedor rechazó. */
export type FailedNext =
  /** Volver al hotel a buscar la tarifa de nuevo: venció o se agotó. */
  | 'research'
  /** Nada salió hacia el proveedor: se puede volver a confirmar (con otra clave). */
  | 'retry'
  /** No se reintenta: es de la cuenta del proveedor o de la reserva misma (U-19). */
  | 'none';

export interface FailedView {
  readonly title: string;
  readonly next: FailedNext;
}

/** Los motivos del Book que TBO rechazó (`classify-book-outcome.ts`), con lo que corresponde. */
const FAILED_BY_REASON: Readonly<Record<string, FailedView>> = {
  'session-expired': { title: 'La tarifa venció.', next: 'research' },
  'no-availability': { title: 'La habitación ya no está disponible.', next: 'research' },
  'rate-unavailable': { title: 'La tarifa ya no está disponible.', next: 'research' },
  'insufficient-balance': {
    title: 'La cuenta del proveedor no tiene saldo suficiente.',
    next: 'none',
  },
  'agent-blocked': { title: 'La cuenta del proveedor está bloqueada.', next: 'none' },
  'credentials-invalid': {
    title: 'El proveedor rechazó las credenciales de la cuenta.',
    next: 'none',
  },
  'invalid-request': { title: 'El proveedor rechazó la reserva.', next: 'none' },
  'not-dispatched': { title: 'La reserva no llegó a enviarse al proveedor.', next: 'retry' },
};

export function failedViewOf(reason: string | undefined): FailedView {
  return (
    (reason === undefined ? undefined : FAILED_BY_REASON[reason]) ?? {
      title: 'No se pudo hacer la reserva.',
      next: 'none',
    }
  );
}

export type BookOutcome =
  /** Confirmada por el proveedor. */
  | { readonly kind: 'confirmed'; readonly summary: HotelBookingSummary }
  /** El proveedor dijo que no reservó: la orden quedó fallida. */
  | {
      readonly kind: 'failed';
      readonly summary: HotelBookingSummary;
      readonly view: FailedView;
      readonly message: string;
    }
  /** Hay una orden y todavía no se sabe en qué termina: se consulta (RF-22, U-14). */
  | {
      readonly kind: 'tracking';
      readonly orderId: string;
      readonly summary?: HotelBookingSummary;
      readonly message?: string;
    }
  /** Datos del formulario que el servidor no aceptó: se corrigen y se vuelve a confirmar. */
  | {
      readonly kind: 'fix';
      readonly message: string;
      readonly fieldErrors: Readonly<Record<string, string>>;
      /**
       * El servidor la tiene por no reembolsable (el 100 % pasó a regir después del PreBook): la
       * casilla aparece aunque la pantalla no la hubiera pedido.
       */
      readonly nonRefundable?: PrebookNonRefundable;
    }
  /** Subió el precio al revalidar antes del Book y hay con qué reservar el nuevo (D-TBO-20 A). */
  | {
      readonly kind: 'repriced';
      readonly message: string;
      readonly acceptedTotal: Money;
      readonly currentTotal: Money;
      readonly prebookRef: string;
    }
  /** La tarifa cambió o su revalidación ya no vale: se vuelve a revalidar en el paso 1. */
  | { readonly kind: 'revalidate'; readonly title: string; readonly message: string }
  /** La tarifa venció o se agotó: se vuelve al hotel a buscarla de nuevo (U-18). */
  | { readonly kind: 'research'; readonly title: string; readonly message: string }
  /** Un rechazo previo al Book: nada salió hacia el proveedor. */
  | {
      readonly kind: 'rejected';
      readonly title: string;
      readonly message: string;
      /** Se puede volver a confirmar (con otra clave) una vez resuelto. */
      readonly retry: boolean;
      readonly action?: 'portfolios' | 'agency';
    }
  /** No se sabe qué pasó: se conserva la clave y NO se ofrece reservar de nuevo con otra. */
  | { readonly kind: 'unknown'; readonly message: string };

const REVALIDATE: Readonly<Record<string, string>> = {
  CONDITIONS_CHANGED: 'Cambiaron las condiciones de la tarifa.',
  ACCEPTED_TOTAL_MISMATCH: 'El precio de la tarifa cambió.',
  PREBOOK_EXPIRED: 'La revalidación de la tarifa ya no está vigente.',
  PRICE_INCREASED: 'El precio de la tarifa subió.',
};

const RESEARCH: Readonly<Record<string, string>> = {
  OFFER_EXPIRED: 'La tarifa venció.',
  SEARCH_CONTEXT_EXPIRED: 'La tarifa venció.',
  OFFER_UNAVAILABLE: 'La tarifa ya no está disponible.',
  RATE_UNAVAILABLE: 'La tarifa ya no está disponible.',
  NO_AVAILABILITY: 'La habitación ya no está disponible.',
  PACKAGE_ONLY_RATE: 'Esta tarifa sólo se vende en un paquete con aéreo.',
  OFFER_NOT_IN_SEARCH: 'Hay que volver a buscar la tarifa.',
  SEARCH_ACCOUNT_CHANGED: 'Cambió la cuenta del proveedor.',
  // La cuenta con que se cotizó ya no se resuelve para el nodo (0060): sin saber quién le paga al
  // proveedor no se sabe hasta dónde retener. Se busca la tarifa con la cuenta de hoy.
  PORTFOLIO_HOLD_ACCOUNT_CHANGED: 'La cuenta del proveedor cambió.',
  GUEST_NATIONALITY_MISSING: 'Falta la nacionalidad del pasajero principal.',
  REQUEST_NOT_ELIGIBLE: 'El proveedor no admite esta búsqueda.',
};

/** De la cuenta del proveedor: el vendedor no lo resuelve reintentando (U-19). */
const ACCOUNT: Readonly<Record<string, string>> = {
  INSUFFICIENT_BALANCE: 'La cuenta del proveedor no tiene saldo suficiente.',
  ACCOUNT_BLOCKED: 'La cuenta del proveedor está bloqueada.',
  CREDENTIALS_INVALID: 'El proveedor rechazó las credenciales de la cuenta.',
  ACCOUNT_CONFIG_INVALID: 'La configuración de la cuenta del proveedor es inválida.',
  ACCOUNT_INCOMPLETE: 'A la cuenta del proveedor le faltan datos.',
  UNSUPPORTED_CURRENCY: 'La cuenta del proveedor cotiza en una moneda que no podemos mostrar.',
};

/**
 * El proveedor no respondió al revalidar (antes del Book, así que no hay reserva): se puede
 * volver a confirmar en unos segundos.
 */
const TRANSIENT: ReadonlySet<string> = new Set([
  'THROTTLED',
  'NOT_DISPATCHED',
  'TRANSPORT',
  'UPSTREAM',
  'MALFORMED_RESPONSE',
  'UNKNOWN_CODE',
  'RESPONSE_UNREADABLE',
  'SEARCH_CONTEXT_UNAVAILABLE',
]);

const UNKNOWN_MESSAGE =
  'No recibimos la respuesta de la reserva y puede haberse hecho igual. No la repitas con otros datos: consúltala en Mis Reservas o reintenta sin cambiar nada, que no se duplica.';

const FIX_MESSAGE = 'Revisa los datos marcados y vuelve a confirmar.';

/**
 * Qué hacer con la respuesta de `POST /api/hotels/book`.
 *
 * - `201`/`202` con la orden: confirmada, fallida o a consultar, según su estado.
 * - Un error con `orderId` (doble envío, orden cerrada por otro camino): hay una orden, se consulta
 *   y NO se reserva de nuevo.
 * - Un error con motivo conocido: todos ocurren ANTES del Book —el servidor no deja que un error
 *   del Book salga como HTTP—, así que no hay reserva y se dice qué hacer.
 * - Cualquier otra cosa (un 5xx sin motivo, una página de un proxy, un corte): no se sabe.
 */
export function classifyBookResponse(status: number, body: unknown): BookOutcome {
  if (status === 201 || status === 202) {
    const summary = parseBookingSummary(body);
    if (summary === undefined) return { kind: 'unknown', message: UNKNOWN_MESSAGE };
    if (summary.status === 'confirmed' || summary.status === 'ticketed') {
      return { kind: 'confirmed', summary };
    }
    if (summary.status === 'failed') {
      const view = failedViewOf(summary.reason);
      return {
        kind: 'failed',
        summary,
        view,
        message: summary.message ?? 'El proveedor no confirmó la reserva.',
      };
    }
    return {
      kind: 'tracking',
      orderId: summary.orderId,
      summary,
      ...(summary.message ? { message: summary.message } : {}),
    };
  }

  const b = isRecord(body) ? body : {};
  const message = nonEmpty(b['message']);
  const reason = nonEmpty(b['reason']);
  const details = isRecord(b['details']) ? b['details'] : {};

  const orderId = b['orderId'];
  if (typeof orderId === 'string' && UUID_RE.test(orderId)) {
    return { kind: 'tracking', orderId, ...(message ? { message } : {}) };
  }
  // Prohibido repetir y sin una orden que consultar: lo único seguro es no reservar de nuevo.
  if (b['retryForbidden'] === true || b['duplicateRequest'] === true) {
    return { kind: 'unknown', message: message ?? UNKNOWN_MESSAGE };
  }

  if (reason === 'GUESTS_INVALID') {
    const issues = Array.isArray(details['issues'])
      ? details['issues'].filter((i): i is string => typeof i === 'string')
      : [];
    return {
      kind: 'fix',
      message: message ?? FIX_MESSAGE,
      fieldErrors: fieldErrorsFromGuestIssues(issues),
    };
  }
  if (reason === 'AT_PROPERTY_NOT_ACKNOWLEDGED') {
    return {
      kind: 'fix',
      message: message ?? AT_PROPERTY_REQUIRED,
      fieldErrors: { [AT_PROPERTY_FIELD]: AT_PROPERTY_REQUIRED },
    };
  }
  if (reason === 'NON_REFUNDABLE_NOT_ACKNOWLEDGED') {
    const nonRefundable = parseNonRefundable(details);
    return {
      kind: 'fix',
      message: message ?? NON_REFUNDABLE_REQUIRED,
      fieldErrors: { [NON_REFUNDABLE_FIELD]: NON_REFUNDABLE_REQUIRED },
      ...(nonRefundable === undefined ? {} : { nonRefundable }),
    };
  }
  if (reason === 'PRICE_INCREASED') {
    const acceptedTotal = moneyOf(details['acceptedTotal']);
    const currentTotal = moneyOf(details['currentTotal']);
    const prebookRef = details['prebookRef'];
    if (
      acceptedTotal &&
      currentTotal &&
      typeof prebookRef === 'string' &&
      UUID_RE.test(prebookRef)
    ) {
      return {
        kind: 'repriced',
        message: message ?? 'El precio subió al revalidar la tarifa antes de reservar.',
        acceptedTotal,
        currentTotal,
        prebookRef,
      };
    }
  }
  if (reason !== undefined && REVALIDATE[reason]) {
    return {
      kind: 'revalidate',
      title: REVALIDATE[reason],
      message: message ?? 'Revalida la tarifa para ver sus condiciones actuales.',
    };
  }
  if (reason !== undefined && RESEARCH[reason]) {
    return {
      kind: 'research',
      title: RESEARCH[reason],
      message: message ?? 'Vuelve al hotel para buscar tarifas actualizadas.',
    };
  }
  if (reason !== undefined && ACCOUNT[reason]) {
    return {
      kind: 'rejected',
      title: ACCOUNT[reason],
      message: message ?? 'Avísale a quien administra la cuenta del proveedor.',
      retry: false,
    };
  }
  // De un nivel de la red que financia a la agencia (0060): el vendedor no lo resuelve en su
  // Cartera B2B, sino quien lo financia. No se retuvo nada, así que después se vuelve a confirmar.
  if (reason !== undefined && isNetworkFundingReason(reason) && PORTFOLIO_TITLES[reason]) {
    return {
      kind: 'rejected',
      title: PORTFOLIO_TITLES[reason],
      message: message ?? NETWORK_DETAIL,
      retry: true,
    };
  }
  // Las carteras de la red siguieron ocupadas por otras reservas: no se retuvo nada ni salió nada
  // hacia el proveedor, y en unos segundos se puede volver a confirmar.
  if (reason === 'PORTFOLIO_HOLD_BUSY') {
    return {
      kind: 'rejected',
      title: 'Las carteras están ocupadas con otras reservas.',
      message: message ?? 'No se retuvo saldo. Prueba de nuevo en unos segundos.',
      retry: true,
    };
  }
  // De la cartera de la agencia en la moneda de la tarifa: la resuelve quien la financia (habilita
  // la moneda, la reactiva, aprueba un depósito o sube el cupo) y se vuelve a confirmar.
  if (reason !== undefined && PORTFOLIO_TITLES[reason]) {
    return {
      kind: 'rejected',
      title: PORTFOLIO_TITLES[reason],
      message: message ?? 'Revisa la cartera de la agencia en Cartera B2B.',
      retry: true,
      action: 'portfolios',
    };
  }
  // Quien financia a la agencia le bloqueó las no reembolsables: reintentar no cambia nada.
  if (reason === 'NON_REFUNDABLE_BLOCKED') {
    return {
      kind: 'rejected',
      title: 'Tu agencia no puede reservar tarifas no reembolsables.',
      message:
        message ??
        'Quien financia a tu agencia las tiene bloqueadas. Elige una tarifa reembolsable del hotel.',
      retry: false,
    };
  }
  if (reason === 'AGENCY_CONTACT_MISSING') {
    return {
      kind: 'rejected',
      title: 'Falta el contacto de soporte de la agencia.',
      message: message ?? 'Configúralo en Mi agencia para reservar hoteles.',
      retry: true,
      action: 'agency',
    };
  }
  if (reason !== undefined && TRANSIENT.has(reason)) {
    return {
      kind: 'rejected',
      title: 'El proveedor no respondió a tiempo.',
      message: message ?? 'No se hizo ninguna reserva. Prueba de nuevo en unos segundos.',
      retry: true,
    };
  }

  if (status === 400) {
    const fieldErrors = fieldErrorsFromValidation(b['fields']);
    if (Object.keys(fieldErrors).length > 0) {
      return { kind: 'fix', message: FIX_MESSAGE, fieldErrors };
    }
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'rejected',
      title: 'No se pudo reservar.',
      message: message ?? 'Tu sesión no es válida para esta operación. Vuelve a iniciar sesión.',
      retry: false,
    };
  }
  // Un 4xx del servidor que no lleva motivo conocido igual es un rechazo antes de abrir la orden.
  if (status >= 400 && status < 500 && status !== 408 && message !== undefined) {
    return { kind: 'rejected', title: 'No se pudo reservar.', message, retry: true };
  }
  return { kind: 'unknown', message: UNKNOWN_MESSAGE };
}

/**
 * ¿Se conserva la clave del intento? Sólo cuando no se sabe qué pasó: reenviarla es la forma de
 * preguntar sin arriesgar una segunda reserva. Cualquier respuesta cierta cierra el intento, y el
 * siguiente —con los datos corregidos o el precio nuevo— lleva otra.
 */
export function keepsAttempt(outcome: BookOutcome): boolean {
  return outcome.kind === 'unknown';
}

// ───────────────────────── Precio nuevo en la reserva ─────────────────────────

/** El aviso del precio que subió en la revalidación previa al Book, con su aceptación. */
export function repricedChangeView(
  outcome: Extract<BookOutcome, { kind: 'repriced' }>,
): PriceChangeView {
  const after = formatMoney(outcome.currentTotal);
  const comparable = outcome.acceptedTotal.currency === outcome.currentTotal.currency;
  const diff = outcome.currentTotal.amountMinor - outcome.acceptedTotal.amountMinor;
  return {
    tone: 'warning',
    title: 'El precio subió al revalidar la tarifa antes de reservar.',
    ...(comparable ? { before: formatMoney(outcome.acceptedTotal) } : {}),
    after,
    ...(comparable && diff > 0
      ? {
          delta: `+ ${formatMoney({ amountMinor: diff, currency: outcome.currentTotal.currency })}`,
        }
      : {}),
    changes: 'No se hizo la reserva. Si aceptas el precio nuevo, confírmala de nuevo.',
    requiresAcceptance: true,
    acceptLabel: `Acepto el precio nuevo de ${after}.`,
  };
}

// ───────────────────────── Seguimiento de la orden ─────────────────────────

/** Lo que el seguimiento necesita de `GET /orders/:id`. Sin huéspedes ni contacto. */
export interface HotelOrderStatusView {
  readonly status: HotelOrderStatus;
  readonly orderNumber?: number;
  readonly providerBookingId?: string;
  readonly total?: Money;
  /** Ya humanizado por el API. */
  readonly errorMessage?: string;
  /** `create-uncertain`, `create-not-found-yet`… */
  readonly subStatus?: string;
}

export function parseOrderStatus(value: unknown): HotelOrderStatusView | undefined {
  if (!isRecord(value)) return undefined;
  const { status, orderNumber, totalAmount, currency } = value;
  if (typeof status !== 'string' || !ORDER_STATUSES.has(status)) return undefined;
  const pnr = nonEmpty(value['pnr']);
  const errorMessage = nonEmpty(value['errorMessage']);
  const tracking = isRecord(value['providerTracking']) ? value['providerTracking'] : {};
  const subStatus = nonEmpty(tracking['subStatus']);
  const total = moneyOf({ amountMinor: totalAmount, currency });
  return {
    status: status as HotelOrderStatus,
    ...(typeof orderNumber === 'number' && Number.isInteger(orderNumber) ? { orderNumber } : {}),
    ...(pnr ? { providerBookingId: pnr } : {}),
    ...(total ? { total } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(subStatus ? { subStatus } : {}),
  };
}

export type TrackingPhase =
  /** El Book sigue en vuelo: el proveedor puede tardar hasta 2 minutos. */
  | 'confirming'
  /** No hubo respuesta cierta: se lee la reserva en el proveedor (U-14). */
  | 'verifying'
  /** Se leyó y todavía no aparece: la cierra la conciliación, nunca un reintento. */
  | 'not-found-yet';

/**
 * En qué está una orden `pending`. El Book todavía en vuelo es "confirmando"; cualquier desenlace
 * incierto es "verificando con el proveedor", nunca "fallida" (U-14).
 */
export function trackingPhaseOf(input: {
  readonly reason?: string;
  readonly subStatus?: string;
  readonly previous?: TrackingPhase;
}): TrackingPhase {
  if (input.subStatus === 'create-not-found-yet') return 'not-found-yet';
  if (input.subStatus === 'create-uncertain' || input.subStatus === 'unverified-read') {
    return 'verifying';
  }
  if (input.previous !== undefined) return input.previous;
  return input.reason === undefined || input.reason === 'book-in-progress'
    ? 'confirming'
    : 'verifying';
}

export const TRACKING_TEXT: Readonly<
  Record<TrackingPhase, { readonly title: string; readonly detail: string }>
> = {
  confirming: {
    title: 'Confirmando la reserva con el proveedor…',
    detail:
      'El proveedor puede tardar hasta 2 minutos en responder. No la repitas: si cierras esta pantalla, la reserva sigue y la encuentras en Mis Reservas.',
  },
  verifying: {
    title: 'Verificando con el proveedor…',
    detail:
      'No recibimos la confirmación a tiempo, así que le preguntamos al proveedor si la reserva quedó hecha. La primera consulta sale a los 2 minutos del corte. No la repitas.',
  },
  'not-found-yet': {
    title: 'El proveedor todavía no muestra la reserva.',
    detail:
      'La seguimos verificando y el equipo la revisa. No la repitas: el estado final lo vas a ver en Mis Reservas.',
  },
};

/**
 * Cada cuánto se consulta la orden según el tiempo que lleva: seguido mientras el Book puede
 * estar por responder, más espaciado mientras corre la verificación, y nada pasados los 6 minutos
 * (la primera lectura del proveedor sale a los 2 minutos del corte, y el corte puede llegar a los
 * 2 minutos del envío). Después, a pedido.
 */
export function nextPollDelayMs(elapsedMs: number): number | undefined {
  if (elapsedMs < 30_000) return 3_000;
  if (elapsedMs < 180_000) return 5_000;
  if (elapsedMs < 360_000) return 10_000;
  return undefined;
}

export type TrackingResult =
  | { readonly kind: 'pending'; readonly phase: TrackingPhase }
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'cancelled' };

export function trackingResultOf(
  order: HotelOrderStatusView,
  previous: TrackingPhase,
): TrackingResult {
  switch (order.status) {
    case 'confirmed':
    case 'ticketed':
      return { kind: 'confirmed' };
    case 'failed':
      return {
        kind: 'failed',
        message: order.errorMessage ?? 'El proveedor no confirmó la reserva.',
      };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'pending':
      return {
        kind: 'pending',
        phase: trackingPhaseOf({
          previous,
          ...(order.subStatus ? { subStatus: order.subStatus } : {}),
        }),
      };
  }
}

// ───────────────────────── Confirmar ─────────────────────────

export interface BookGate {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * ¿Se puede tocar "Confirmar reserva"? Lo que falte en el formulario NO lo deshabilita: al tocarlo
 * se marca cada campo y el foco va al primero, que es lo que se entiende con teclado y lector. Sí
 * lo deshabilitan lo que el vendedor no puede resolver acá y el envío en curso.
 */
export function bookGate(input: {
  readonly expired: boolean;
  readonly submitting: boolean;
  /** Un rechazo que no se resuelve reintentando (U-19) o que pide volver atrás. */
  readonly blockedReason?: string;
  /** Subió el precio y todavía no se aceptó el nuevo. */
  readonly repricedPending: boolean;
}): BookGate {
  if (input.expired) {
    return { ok: false, reason: 'La tarifa venció: vuelve al hotel para buscarla de nuevo.' };
  }
  if (input.blockedReason) return { ok: false, reason: input.blockedReason };
  if (input.repricedPending) {
    return { ok: false, reason: 'Acepta el precio nuevo para confirmar la reserva.' };
  }
  if (input.submitting) return { ok: false };
  return { ok: true };
}

/** "Se reservó por X" cuando el precio bajó al revalidar (D-TBO-20 A: se sigue y se avisa). */
export function bookingWarningsText(summary: Pick<HotelBookingSummary, 'warnings' | 'total'>) {
  return summary.warnings.includes('PRICE_DECREASED') && summary.total
    ? `El precio bajó al revalidar la tarifa: se reservó por ${formatMoney(summary.total)}.`
    : undefined;
}

// ───────────────────────── Reserva confirmada ─────────────────────────

export interface ConfirmedView {
  /** Con esto se abre la reserva en Mis Reservas y se pide su voucher (U-15). */
  readonly orderId?: string;
  readonly orderNumber?: number;
  /** Localizador del proveedor (`ConfirmationNumber` en TBO). */
  readonly providerBookingId?: string;
  readonly bookingReference?: string;
  readonly total?: Money;
  /** Lo que quedó sin comprobar después de confirmar (la lectura de cierre), ya humanizado. */
  readonly note?: string;
  readonly priceNote?: string;
}

/**
 * La reserva confirmada con lo que se sepa de ella: la respuesta del Book y, si se llegó
 * consultando, la orden, que manda en número, localizador e importe. `orderId` es el de la orden
 * que se consultó, para cuando no hubo respuesta del Book (un envío repetido).
 */
export function confirmedViewOf(
  summary: HotelBookingSummary | undefined,
  order?: HotelOrderStatusView,
  orderId?: string,
): ConfirmedView {
  const id = orderId ?? summary?.orderId;
  const orderNumber = order?.orderNumber ?? summary?.orderNumber;
  const providerBookingId = order?.providerBookingId ?? summary?.providerBookingId;
  const total = order?.total ?? summary?.total;
  // El mensaje de un `202` es el de la espera; sólo el de una confirmada habla de la reserva.
  const note =
    summary?.status === 'confirmed' || summary?.status === 'ticketed' ? summary.message : undefined;
  const priceNote = summary ? bookingWarningsText(summary) : undefined;
  return {
    ...(id === undefined ? {} : { orderId: id }),
    ...(orderNumber === undefined ? {} : { orderNumber }),
    ...(providerBookingId === undefined ? {} : { providerBookingId }),
    ...(summary?.bookingReference ? { bookingReference: summary.bookingReference } : {}),
    ...(total === undefined ? {} : { total }),
    ...(note ? { note } : {}),
    ...(priceNote ? { priceNote } : {}),
  };
}

// ───────────────────────── La espera, paso a paso ─────────────────────────

/** Lo que devuelve la consulta de la orden (la acción del servidor). */
export type OrderStatusRead =
  | { readonly ok: true; readonly order: HotelOrderStatusView }
  | {
      readonly ok: false;
      /** Ya en el idioma del vendedor. */
      readonly error: string;
      /** La orden no existe para esta agencia (o no se pudo leer como orden). */
      readonly notFound: boolean;
    };

export interface TrackingState {
  readonly kind: 'tracking';
  readonly orderId: string;
  /** La respuesta del Book, si la hubo (un doble envío no la trae). */
  readonly summary?: HotelBookingSummary;
  readonly trackPhase: TrackingPhase;
  /** Cuándo se tocó "Confirmar" (epoch en ms): de ahí se cuenta la espera que se ve. */
  readonly startedAt: number;
  /** Desde cuándo corre el calendario de consultas ({@link nextPollDelayMs}). */
  readonly pollFrom: number;
  readonly orderNumber?: number;
  /** Cuántas consultas van: una respuesta vieja no pisa a una nueva. */
  readonly tick: number;
  /** Terminó la consulta automática. */
  readonly stopped: boolean;
  readonly polling: boolean;
  /** Algo que decir además del estado (la consulta falló, el envío ya había llegado). */
  readonly note?: string;
}

export type FinalState =
  | { readonly kind: 'confirmed'; readonly view: ConfirmedView }
  | {
      readonly kind: 'failed';
      readonly view: FailedView;
      readonly message: string;
      readonly orderNumber?: number;
    }
  | { readonly kind: 'cancelled'; readonly orderNumber?: number };

export function startTracking(
  outcome: Extract<BookOutcome, { kind: 'tracking' }>,
  startedAt: number,
): TrackingState {
  const { summary } = outcome;
  // Con `summary`, su mensaje es el de la espera y ya lo dice el panel; sin él, es el del
  // servidor sobre el envío repetido, que sí hay que mostrar.
  const note = summary === undefined ? outcome.message : undefined;
  return {
    kind: 'tracking',
    orderId: outcome.orderId,
    ...(summary ? { summary } : {}),
    trackPhase: trackingPhaseOf(summary?.reason === undefined ? {} : { reason: summary.reason }),
    startedAt,
    pollFrom: startedAt,
    ...(summary?.orderNumber === undefined ? {} : { orderNumber: summary.orderNumber }),
    tick: 0,
    stopped: false,
    polling: false,
    ...(note ? { note } : {}),
  };
}

const POLL_FAILED =
  'No pudimos consultar el estado de la reserva en este momento. Seguimos intentando.';

/** El siguiente estado después de consultar la orden. */
export function afterPoll(state: TrackingState, read: OrderStatusRead): TrackingState | FinalState {
  if (!read.ok) {
    const base = { ...state, tick: state.tick + 1, polling: false };
    return read.notFound
      ? { ...base, stopped: true, note: read.error }
      : { ...base, note: POLL_FAILED };
  }
  const { order } = read;
  const orderNumber = order.orderNumber ?? state.orderNumber;
  const result = trackingResultOf(order, state.trackPhase);
  switch (result.kind) {
    case 'confirmed':
      return { kind: 'confirmed', view: confirmedViewOf(state.summary, order, state.orderId) };
    case 'failed':
      return {
        kind: 'failed',
        view: failedViewOf(undefined),
        message: result.message,
        ...(orderNumber === undefined ? {} : { orderNumber }),
      };
    case 'cancelled':
      return { kind: 'cancelled', ...(orderNumber === undefined ? {} : { orderNumber }) };
    case 'pending': {
      // La consulta salió bien: el aviso de una consulta anterior ya no vale.
      const next: { -readonly [K in keyof TrackingState]: TrackingState[K] } = {
        ...state,
        trackPhase: result.phase,
        tick: state.tick + 1,
        polling: false,
      };
      delete next.note;
      if (orderNumber !== undefined) next.orderNumber = orderNumber;
      return next;
    }
  }
}

/** Consultar a pedido, pasada la consulta automática: otra ventana de 3 minutos, cada 10 s. */
export function resumeTracking(state: TrackingState, now: number): TrackingState {
  return { ...state, stopped: false, pollFrom: now - 180_000 };
}

/** Cuándo sale la próxima consulta, o `undefined` si ya no toca ninguna automática. */
export function pollDelayFor(state: TrackingState, now: number): number | undefined {
  if (state.stopped || state.polling) return undefined;
  return nextPollDelayMs(now - state.pollFrom);
}
