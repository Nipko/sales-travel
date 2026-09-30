import type { Money } from '../hoteles/actions';
import { formatMoney } from '../hoteles/_components/hotel-format';
import {
  canRetryCancelOperation,
  directCancellationBlock,
  type OrderOperationView,
} from './cancel-retry-policy';

/*
 * La cancelación de una reserva de hotel sin React (docs/tbo/09 PR-6.5; U-17; 08 RF-25; D-TBO-25 A,
 * D-TBO-26 A): la penalidad estimada que se muestra antes de confirmar y qué decirle al vendedor
 * con cada respuesta del pedido.
 *
 * El proveedor no informa cargo ni reembolso al cancelar (04 §4.5). La penalidad la estima el API
 * con la política que la orden guardó del PreBook, y la estima sobre el total del PreBook, que es
 * el NETO del proveedor. Acá se expresa como proporción de ese total aplicada al precio de VENTA de
 * la orden: el importe neto le diría a una sub-agencia cuánto cuesta la tarifa al consolidador (G3).
 */

export type CancellationBasis = 'free' | 'charged' | 'non-refundable';

/** Espejo de `HotelCancellationEstimate` del API. */
export type HotelCancellationEstimate =
  | {
      readonly kind: 'estimated';
      readonly penalty: Money;
      readonly base: Money;
      readonly basis: CancellationBasis;
      readonly policySource: string;
      readonly conservative: boolean;
      readonly checkInReached: boolean;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function moneyOf(value: unknown): Money | undefined {
  if (!isRecord(value)) return undefined;
  const { amountMinor, currency } = value;
  return typeof amountMinor === 'number' &&
    Number.isInteger(amountMinor) &&
    amountMinor >= 0 &&
    typeof currency === 'string' &&
    /^[A-Z]{3}$/.test(currency)
    ? { amountMinor, currency }
    : undefined;
}

const BASES: ReadonlySet<string> = new Set<CancellationBasis>([
  'free',
  'charged',
  'non-refundable',
]);

/** La respuesta de `GET /orders/:id/cancellation-estimate`, o `undefined` si no se entiende. */
export function parseCancellationEstimate(body: unknown): HotelCancellationEstimate | undefined {
  const estimate = isRecord(body) ? body['estimate'] : undefined;
  if (!isRecord(estimate)) return undefined;
  if (estimate['kind'] === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: typeof estimate['reason'] === 'string' ? estimate['reason'] : 'unknown',
    };
  }
  if (estimate['kind'] !== 'estimated') return undefined;
  const penalty = moneyOf(estimate['penalty']);
  const base = moneyOf(estimate['base']);
  const basis = estimate['basis'];
  if (penalty === undefined || base === undefined) return undefined;
  if (typeof basis !== 'string' || !BASES.has(basis)) return undefined;
  return {
    kind: 'estimated',
    penalty,
    base,
    basis: basis as CancellationBasis,
    policySource: typeof estimate['policySource'] === 'string' ? estimate['policySource'] : '',
    // Sin el dato, lo que no se sabe se toma del lado que avisa de más.
    conservative: estimate['conservative'] !== false,
    checkInReached: estimate['checkInReached'] === true,
  };
}

export interface PenaltyView {
  /** La cifra: "≈ 120,00 US$", "Sin cargo" o que no se puede estimar. */
  readonly headline: string;
  readonly tone: 'free' | 'charged' | 'unknown';
  /** Aclaraciones, en orden de importancia. */
  readonly notes: readonly string[];
  /**
   * Desde el día de entrada la cancelación no se hace desde acá: la gestiona soporte (04 PV-22;
   * RF-25). La penalidad se muestra igual.
   */
  readonly blocked?: string;
  /** Hay o puede haber cargo: se pide aceptarlo de forma explícita antes de cancelar. */
  readonly requiresAcknowledgement: boolean;
  /**
   * Cancelar cuesta el 100 %: la tarifa es no reembolsable (lo guardó la orden o lo dice la
   * política) o el cargo vigente ya es el total. Se pide una segunda confirmación (pedido del
   * 2026-09-29, punto d).
   */
  readonly fullCharge: boolean;
  /** El texto de la casilla. */
  readonly ackLabel: string;
}

/** D-TBO-26 A, en una frase: de dónde sale la cifra y quién decide el reembolso. */
export const ESTIMATE_DISCLAIMER =
  'Es una estimación con la política que se aceptó al reservar: el proveedor no informa el cargo al cancelar, lo factura después. El reembolso al cliente lo aprueba el back-office cuando cuadra con esa factura.';

const CHECK_IN_BLOCK =
  'Ya es el día de entrada en la hora del hotel, o puede serlo. Desde ese día la cancelación no se hace desde acá: la gestiona soporte con el proveedor.';

const UNAVAILABLE_NOTES: Readonly<Record<string, string>> = {
  'no-snapshot':
    'La reserva no guarda la política con la que se vendió, así que no hay con qué estimar el cargo. Lo define el proveedor al cancelar.',
  'no-policy':
    'El proveedor no informó los tramos de la política de esta tarifa. El cargo lo define él al cancelar.',
};

const PERCENT = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });

const NON_REFUNDABLE_NOTE = 'La tarifa no es reembolsable: se cobra el total de la reserva.';

const FULL_CHARGE_NOTE =
  'Es una tarifa no reembolsable: cancelar cuesta el 100 % de la reserva y no se recupera. Se descuenta de la cartera o del crédito de la agencia.';

/** La casilla cuando cancelar cuesta el total: el monto, dicho con todas las letras. */
export function fullChargeAckLabel(sale: Money): string {
  return `Entiendo que cancelar esta reserva cuesta el 100 % (${formatMoney(sale)}) y que no se recupera.`;
}

function ackLabelOf(tone: PenaltyView['tone']): string {
  return `Entiendo que la cancelación no se puede deshacer y que el proveedor puede cobrar ${tone === 'unknown' ? 'un cargo que no podemos estimar' : 'esta penalidad'}.`;
}

/**
 * La penalidad en el precio de venta de la orden (`sale`, `totalAmount`/`currency`).
 *
 * - No reembolsable: el total de la venta, y se pide una segunda confirmación.
 * - Sin cargo: sin cargo, aunque la estimación sea conservadora (el peor tramo posible es gratis).
 * - Con cargo: la misma proporción del total, con "≈" porque es una estimación; si no se puede
 *   expresar en el precio de venta, se dice que hay cargo sin inventar un importe. Si el cargo ya
 *   es el total, es lo mismo que una no reembolsable.
 *
 * `nonRefundable`: la orden dice que la tarifa es no reembolsable (`hotelNonRefundableOf`). Manda
 * sobre la estimación: una estimación que no se pudo hacer o que diera menos no le quita el 100 %.
 */
export function penaltyViewOf(
  estimate: HotelCancellationEstimate,
  sale: Money,
  nonRefundable = false,
): PenaltyView {
  const view = estimatedPenaltyViewOf(estimate, sale);
  const fullCharge =
    nonRefundable ||
    (estimate.kind === 'estimated' &&
      (estimate.basis === 'non-refundable' ||
        (estimate.penalty.currency === estimate.base.currency &&
          estimate.base.amountMinor > 0 &&
          estimate.penalty.amountMinor >= estimate.base.amountMinor)));
  if (!fullCharge) return view;
  return {
    ...view,
    headline: `100 % · ${formatMoney(sale)}`,
    tone: 'charged',
    notes: [FULL_CHARGE_NOTE, ...view.notes.filter((n) => n !== NON_REFUNDABLE_NOTE)],
    requiresAcknowledgement: true,
    fullCharge: true,
    ackLabel: fullChargeAckLabel(sale),
  };
}

function estimatedPenaltyViewOf(estimate: HotelCancellationEstimate, sale: Money): PenaltyView {
  if (estimate.kind === 'unavailable') {
    return {
      headline: 'No podemos estimar la penalidad',
      tone: 'unknown',
      notes: [
        UNAVAILABLE_NOTES[estimate.reason] ??
          'No hay con qué estimar el cargo. Lo define el proveedor al cancelar.',
      ],
      requiresAcknowledgement: true,
      fullCharge: false,
      ackLabel: ackLabelOf('unknown'),
    };
  }

  const notes: string[] = [];
  let headline: string;
  let tone: PenaltyView['tone'];

  if (estimate.basis === 'non-refundable') {
    headline = `${formatMoney(sale)} (el total)`;
    tone = 'charged';
    notes.push(NON_REFUNDABLE_NOTE);
  } else if (estimate.basis === 'free' || estimate.penalty.amountMinor === 0) {
    headline = 'Sin cargo';
    tone = 'free';
    notes.push('Según la política de la reserva, cancelar ahora no tiene cargo.');
  } else {
    tone = 'charged';
    const comparable =
      estimate.penalty.currency === estimate.base.currency && estimate.base.amountMinor > 0;
    const ratio = comparable
      ? Math.min(1, estimate.penalty.amountMinor / estimate.base.amountMinor)
      : undefined;
    if (ratio !== undefined && sale.currency === estimate.base.currency) {
      headline = `≈ ${formatMoney({ amountMinor: Math.round(sale.amountMinor * ratio), currency: sale.currency })}`;
      notes.push(
        `Aproximadamente el ${PERCENT.format(ratio * 100)} % del total de la reserva (${formatMoney(sale)}).`,
      );
    } else {
      headline = 'Con cargo';
      notes.push('La política cobra un cargo que no podemos expresar en el precio de venta.');
    }
    if (estimate.conservative) {
      notes.push(
        'Es el cargo más alto que puede estar vigente ahora: la hora exacta en el hotel o algún tramo de la política no se pueden precisar.',
      );
    }
  }

  if (estimate.policySource !== 'prebook-final') {
    notes.push(
      'La política no es la que el proveedor confirmó al revalidar la tarifa: el cargo real puede ser otro.',
    );
  }

  return {
    headline,
    tone,
    notes,
    ...(estimate.checkInReached ? { blocked: CHECK_IN_BLOCK } : {}),
    requiresAcknowledgement: tone !== 'free',
    fullCharge: false,
    ackLabel: ackLabelOf(tone),
  };
}

// ───────────────────────── Qué impide enviarla ─────────────────────────

const STALE_RETRY =
  'Ese intento de cancelación ya no se puede reintentar: la reserva cambió desde que abriste el historial. Cierra y revisa su estado actualizado.';

/**
 * Qué impide enviar la cancelación, con el historial recién leído, o `null` si nada.
 *
 * Un reintento (`retryOperationId`) pasa por la misma penalidad y el mismo bloqueo del día de
 * entrada que una cancelación nueva: entre el intento que falló y el reintento puede haber vencido
 * el tramo sin cargo. Y sólo vale para el último intento, si sigue siendo reintentable: el API
 * rechaza cualquier otro.
 */
export function hotelCancellationBlock(
  operations: readonly OrderOperationView[],
  retryOperationId?: string,
): string | null {
  if (retryOperationId === undefined) return directCancellationBlock(operations);
  const latest = operations.find((operation) => operation.type === 'cancel');
  if (!latest || latest.id !== retryOperationId) return STALE_RETRY;
  if (canRetryCancelOperation(latest)) return null;
  return directCancellationBlock(operations) ?? STALE_RETRY;
}

// ───────────────────────── La respuesta del pedido ─────────────────────────

export type HotelCancelOutcome =
  /** El proveedor confirmó la cancelación. */
  | { readonly kind: 'cancelled'; readonly title: string; readonly message: string }
  /** La aceptó y todavía la procesa, o el pedido sigue en vuelo: "Cancelación en curso". */
  | { readonly kind: 'in-progress'; readonly title: string; readonly message: string }
  /** El proveedor no la aceptó: la reserva sigue vigente. */
  | { readonly kind: 'rejected'; readonly title: string; readonly message: string }
  /** El servidor respondió con un error: su mensaje dice si salió y qué hacer. */
  | { readonly kind: 'error'; readonly title: string; readonly message: string }
  /** No hubo respuesta: pudo haber salido. Nunca se ofrece repetirla. */
  | { readonly kind: 'unknown'; readonly title: string; readonly message: string };

/** El aviso del API cuando se agotó el presupuesto de la petición (04 §4.3, HARD-1). */
export const CANCELLATION_STILL_RUNNING = 'CANCELLATION_STILL_RUNNING';

const UNKNOWN: HotelCancelOutcome = {
  kind: 'unknown',
  title: 'No sabemos si la cancelación se envió',
  message:
    'No recibimos la respuesta. No la vuelvas a cancelar: actualiza el estado de la reserva en unos minutos. Si salió, aparece como Cancelación en curso o Cancelada.',
};

/** Estados en que el pedido pudo haber llegado al proveedor aunque no haya respuesta. */
function unanswered(status: number): boolean {
  return status === 0 || status === 408 || status === 524 || status >= 500;
}

/**
 * Qué pasó con `POST /api/orders/:id/cancel` de una orden de hotel. Un `200` del proveedor es
 * "aceptada", no "cancelada": el estado final lo decide la lectura posterior (RF-25), y el API lo
 * devuelve en `settlement`.
 */
export function hotelCancelOutcomeOf(status: number, body: unknown): HotelCancelOutcome {
  if (unanswered(status)) return UNKNOWN;
  const b = isRecord(body) ? body : {};

  if (status >= 200 && status < 300) {
    if (typeof b['success'] !== 'boolean') return UNKNOWN;
    const warnings = Array.isArray(b['warnings']) ? b['warnings'] : [];
    if (!b['success']) {
      return {
        kind: 'rejected',
        title: 'El proveedor no aceptó la cancelación',
        message:
          'La reserva sigue vigente. Revisa su política y, si hace falta, consúltalo con soporte antes de volver a intentar.',
      };
    }
    if (warnings.includes(CANCELLATION_STILL_RUNNING)) {
      return {
        kind: 'in-progress',
        title: 'Cancelación en curso',
        message:
          'El proveedor está tardando en responder, pero el pedido sigue en curso. El estado final aparece en la reserva: no la vuelvas a cancelar.',
      };
    }
    if (b['settlement'] === 'in-progress') {
      return {
        kind: 'in-progress',
        title: 'Cancelación en curso',
        message:
          'El proveedor aceptó la cancelación y la está procesando con el hotel. La reserva pasa a Cancelada cuando lo confirme: no la vuelvas a cancelar.',
      };
    }
    return {
      kind: 'cancelled',
      title: 'Reserva cancelada',
      message:
        b['refundAwaited'] === true
          ? 'El proveedor confirmó la cancelación. El reembolso del proveedor a la cuenta sigue pendiente; no hace falta hacer nada.'
          : 'El proveedor confirmó la cancelación.',
    };
  }

  // El motivo lo redacta el API y es el que dice qué hacer: otra cancelación en curso, una que
  // quedó sin verificar después de enviarse, la cuenta de la reserva. No se afirma que no salió.
  const message =
    typeof b['error'] === 'string' && b['error'].trim() ? b['error'].trim() : undefined;
  return {
    kind: 'error',
    title: 'La cancelación no se completó',
    message:
      message ??
      'El servidor no aceptó el pedido. Actualiza el estado de la reserva antes de volver a intentar.',
  };
}
