import type { HotelBookingView } from '@sales-travel/domain';
import type {
  HcnState,
  HotelOrderSubStatus,
  OrderStatus,
  ProviderStatusSource,
} from '../database/database.types.js';
import {
  ORDER_EVENTS,
  publicProviderStatus,
  type DiscrepancySeverity,
  type PostSaleEscalationReason,
  type ReconciliationDiscrepancyKind,
} from '../orders/order-events.js';
import { decideAfterClosingRead } from './hotel-booking.saga.js';

/**
 * Estado de una orden de hotel según lo que se observa del proveedor: la tabla de docs/tbo/04 §6.3
 * como función pura (08 RF-26; D-TBO-25 A). Sin I/O: cada camino de la post-venta (la saga, la
 * verificación, la cancelación, la consulta manual, el HCN y la conciliación) le pasa lo que vio y
 * ejecuta el plan que vuelve.
 *
 * `orders.status` conserva su vocabulario (`pending`, `confirmed`, `cancelled`, `failed`; nunca
 * `ticketed` en hoteles). Lo que el proveedor dice con más detalle vive en la fila de seguimiento
 * (0042): el estado crudo y un subestado. Subestado `null` = el estado crudo alcanza para describir
 * la orden (la columna "Valor crudo" de la tabla).
 *
 * Dos reglas que la tabla da por supuestas y aquí son explícitas:
 *
 * - **Sólo mueve `orders.status` quien es dueño de la transición.** La cancelación y la
 *   verificación de una cancelación (`verify`) cierran lo que ellas abrieron; la conciliación cierra
 *   una divergencia después de confirmarla con una lectura (fila 14). La consulta manual y el HCN
 *   leen, registran y avisan, pero no cambian la orden: la transición trae efectos (liberar la
 *   retención de cartera, cortar el HCN, cerrar la operación de cancelación) que son de ese dueño.
 * - **Con un claim de cancelación en vuelo (`cancel-requested`) nadie más toca la orden.** El claim
 *   hace CAS sobre `pending`; cualquier otra escritura de estado lo rompería.
 *
 * Un estado que el proveedor no documenta nunca se adivina (fila 16): se guarda crudo, la orden no
 * cambia y la mira una persona. En los eventos sale como `'unknown'`.
 */

/** La orden y su fila de seguimiento antes de la observación. */
export interface HotelOrderSnapshot {
  readonly status: OrderStatus;
  readonly subStatus: HotelOrderSubStatus | null;
  /** Último estado leído, crudo. `null` = nunca se leyó. */
  readonly providerStatus: string | null;
  /** `'true'` o `'false'`, como lo guarda la fila; `null` = no se sabe. */
  readonly voucherStatus: string | null;
  readonly refundAwaited: boolean;
  readonly hcn: string | null;
  readonly hcnState: HcnState | null;
}

/** Quién leyó la reserva, fuera de la creación y de la cancelación, que tienen su observación. */
export type HotelOrderReadSource = Extract<
  ProviderStatusSource,
  'retrieve' | 'verify' | 'hcn' | 'reconciliation'
>;

/** Lo que se observó. Una variante por familia de filas de la tabla de 04 §6.3. */
export type HotelOrderObservation =
  /** Fila 1: el intent quedó escrito y el Book no salió o está en vuelo. */
  | { readonly kind: 'intent-opened' }
  /** Fila 4: el proveedor dijo que no reservó nada. */
  | { readonly kind: 'book-failed' }
  /** Fila 5: el Book no probó nada; puede haber reserva. */
  | { readonly kind: 'book-uncertain' }
  /** Filas 2 y 3: Book `200` y la lectura de cierre (`null` = falló). */
  | { readonly kind: 'book-confirmed'; readonly read: HotelBookingView | null }
  /** Fila 6 (y R1): la lectura por nuestra referencia encontró la reserva. */
  | {
      readonly kind: 'recovered';
      readonly read: HotelBookingView;
      readonly by: 'booking-reference' | 'reconciliation';
    }
  /** Fila 7: el calendario de verificación se agotó sin encontrarla. */
  | { readonly kind: 'recovery-not-found' }
  /** Fila 8: se adquirió el claim de cancelación. */
  | { readonly kind: 'cancel-claimed' }
  /** Filas 9 a 11: el proveedor aceptó la cancelación, y la lectura posterior (`null` = falló). */
  | { readonly kind: 'cancel-accepted'; readonly read: HotelBookingView | null }
  /** Fila 12: el proveedor rechazó la cancelación, y la lectura posterior. */
  | { readonly kind: 'cancel-rejected'; readonly read: HotelBookingView | null }
  /** Fila 13: no se sabe si la cancelación se aplicó. */
  | { readonly kind: 'cancel-unverified' }
  /** Filas 14 a 17: una lectura de la reserva ya creada. */
  | {
      readonly kind: 'read';
      readonly source: HotelOrderReadSource;
      readonly read: HotelBookingView;
    };

/** Qué tiene que hacer quien ejecuta el plan. Cada camino ejecuta sólo las acciones que son suyas. */
export type HotelOrderAction =
  /** Arrancar el seguimiento del HCN. */
  | 'schedule-hcn'
  /** Cortar el seguimiento del HCN: la reserva ya no está viva. */
  | 'stop-hcn'
  /** Releer la reserva por el localizador del proveedor. */
  | 'verify-by-locator'
  /** Releer por nuestra referencia a los 120 s del fallo (p. 42). */
  | 'verify-by-reference'
  /** Soltar la clave de idempotencia: no hay reserva y el vendedor puede reintentar. */
  | 'release-create-key'
  /** Consolidar el intent con el localizador leído. */
  | 'consolidate-intent'
  /** Mandar la cancelación al proveedor. */
  | 'send-cancel'
  /** Leer la reserva hasta que la cancelación termine (job de sólo lectura). */
  | 'verify-cancellation'
  /** Cancelada con el reembolso del proveedor pendiente: lo sigue la conciliación sin bloquear. */
  | 'track-refund'
  /** Nada más que leer ahora: lo resuelve la conciliación diaria. */
  | 'await-reconciliation'
  /** Avisar a la agencia de que su reserva cambió fuera de la plataforma. */
  | 'notify-agency'
  | 'human-review'
  /** La reserva sigue viva y cobrable mientras la orden dice otra cosa. */
  | 'urgent-human-review'
  /** Confirmada sin voucher emitido (PV-02). */
  | 'voucher-alert';

/** Motivos de `OrderEscalated` que puede pedir esta tabla. */
export type HotelOrderEscalationReason =
  | 'verification-unavailable'
  | 'verified-not-found'
  | 'verified-cancelled-upstream'
  | 'verified-status-unexpected'
  | 'cancellation-unverified'
  | PostSaleEscalationReason;

/**
 * Un evento a emitir. Sólo lo que la tabla decide; quien lo emite agrega proveedor, vertical,
 * localizadores y la fuente, siempre sin PII.
 */
export type HotelOrderEvent =
  | { readonly type: typeof ORDER_EVENTS.createRequested }
  | { readonly type: typeof ORDER_EVENTS.created; readonly outcome: 'CONFIRMED' | 'FAILED' }
  | { readonly type: typeof ORDER_EVENTS.createFailed; readonly uncertain: true }
  | {
      readonly type: typeof ORDER_EVENTS.verified;
      readonly recoveredBy?: 'booking-reference' | 'reconciliation';
    }
  | { readonly type: typeof ORDER_EVENTS.escalated; readonly reason: HotelOrderEscalationReason }
  | { readonly type: typeof ORDER_EVENTS.cancelled; readonly success: boolean }
  | {
      readonly type: typeof ORDER_EVENTS.providerStatusChanged;
      /** `null` = no había lectura anterior. */
      readonly previous: string | null;
      readonly current: string;
      /** Presente sólo si lo que cambió es el voucher. */
      readonly voucherIssued?: boolean;
    }
  | {
      readonly type: typeof ORDER_EVENTS.reconciliationDiscrepancy;
      readonly kind: ReconciliationDiscrepancyKind;
      readonly severity: DiscrepancySeverity;
    }
  | { readonly type: typeof ORDER_EVENTS.hotelConfirmationNumberReceived; readonly hcn: string };

/** Lo que se escribe en la fila de seguimiento con una lectura. */
export interface HotelOrderReadRecord {
  /** Crudo: el código del enum del proveedor, o el valor que no se reconoció (fila 16). */
  readonly providerStatus: string;
  /** Ausente = la lectura no lo informó y no se toca. */
  readonly voucherStatus?: 'true' | 'false';
  readonly refundAwaited: boolean;
}

export interface HotelOrderHcnRecord {
  readonly hcn: string;
  /** `false` si el seguimiento ya estaba cortado: se guarda el número sin reabrirlo. */
  readonly markReceived: boolean;
}

export interface HotelOrderPlan {
  /** `'keep'` = no se toca; `'prior'` = el estado que tenía antes del claim de cancelación. */
  readonly orderStatus: OrderStatus | 'keep' | 'prior';
  /** `'keep'` = no se toca; `null` = el estado crudo alcanza. */
  readonly subStatus: HotelOrderSubStatus | null | 'keep';
  /** Ausente = no hubo lectura que registrar. */
  readonly record?: HotelOrderReadRecord;
  readonly hcn?: HotelOrderHcnRecord;
  readonly actions: readonly HotelOrderAction[];
  readonly events: readonly HotelOrderEvent[];
}

type ReadState = 'not-found' | 'confirmed' | 'cancelling' | 'cancelled' | 'unknown' | 'unexpected';

function stateOf(view: HotelBookingView): ReadState {
  if (!view.found) return 'not-found';
  switch (view.status) {
    case 'CONFIRMED':
      return 'confirmed';
    case 'CANCELLATION_IN_PROGRESS':
      return 'cancelling';
    case 'CANCELLED':
      return 'cancelled';
    // Estados del contrato neutral que una reserva ya creada no debería tener.
    case 'PENDING':
    case 'FAILED':
      return 'unexpected';
    default:
      return 'unknown';
  }
}

/** El subestado lo puede reemplazar una lectura: nadie tiene un proceso abierto sobre la orden. */
function readOwnsSubStatus(order: HotelOrderSnapshot): boolean {
  return (
    order.subStatus === null ||
    order.subStatus === 'unknown' ||
    order.subStatus === 'unverified-read'
  );
}

/** Subestados de un proceso de creación todavía abierto: la verificación es su dueña. */
const CREATION_SUB_STATUSES: ReadonlySet<HotelOrderSubStatus | null> = new Set([
  'create-pending',
  'create-uncertain',
  'create-not-found-yet',
]);

function recordOf(view: HotelBookingView): HotelOrderReadRecord | undefined {
  if (!view.found) return undefined;
  return {
    providerStatus: view.providerStatus ?? view.status ?? 'UNKNOWN',
    ...(view.voucherIssued === undefined
      ? {}
      : { voucherStatus: view.voucherIssued ? ('true' as const) : ('false' as const) }),
    refundAwaited: view.status === 'CANCELLED' && view.refundAwaited === true,
  };
}

function hcnOf(order: HotelOrderSnapshot, view: HotelBookingView): HotelOrderHcnRecord | undefined {
  const hcn = view.hotelConfirmationNumber?.trim();
  if (stateOf(view) !== 'confirmed' || hcn === undefined || hcn.length === 0 || hcn === order.hcn) {
    return undefined;
  }
  return { hcn, markReceived: order.hcnState !== 'stopped' };
}

/**
 * `OrderProviderStatusChanged` si la lectura ve algo distinto de lo guardado (04 §6.5). La primera
 * lectura no es un cambio. Un estado desconocido no emite este evento: ya lo lleva la escalada.
 * Un voucher que deja de estar emitido sí es un cambio, aunque sea la primera vez que se informa.
 */
function statusChanged(order: HotelOrderSnapshot, view: HotelBookingView): HotelOrderEvent[] {
  const record = recordOf(view);
  const state = stateOf(view);
  if (record === undefined || state === 'unknown') return [];
  const statusMoved =
    order.providerStatus !== null && record.providerStatus !== order.providerStatus;
  const voucherLost =
    record.voucherStatus === 'false' && order.voucherStatus !== 'false' && state === 'confirmed';
  if (!statusMoved && !voucherLost) return [];
  return [
    {
      type: ORDER_EVENTS.providerStatusChanged,
      previous:
        order.providerStatus === null
          ? null
          : publicProviderStatus(order.providerStatus, order.subStatus !== 'unknown'),
      current: publicProviderStatus(record.providerStatus, true),
      ...(voucherLost ? { voucherIssued: false } : {}),
    },
  ];
}

function escalated(reason: HotelOrderEscalationReason): HotelOrderEvent {
  return { type: ORDER_EVENTS.escalated, reason };
}

function withRead(
  order: HotelOrderSnapshot,
  view: HotelBookingView,
): Pick<HotelOrderPlan, 'record' | 'hcn'> {
  const record = recordOf(view);
  const hcn = hcnOf(order, view);
  return {
    ...(record === undefined ? {} : { record }),
    ...(hcn === undefined ? {} : { hcn }),
  };
}

function hcnEvents(order: HotelOrderSnapshot, view: HotelBookingView): HotelOrderEvent[] {
  const hcn = hcnOf(order, view);
  return hcn === undefined
    ? []
    : [{ type: ORDER_EVENTS.hotelConfirmationNumberReceived, hcn: hcn.hcn }];
}

function voucherActions(view: HotelBookingView): HotelOrderAction[] {
  return stateOf(view) === 'confirmed' && view.voucherIssued === false ? ['voucher-alert'] : [];
}

/** Filas 9 a 11: lo que queda de la orden cuando el proveedor la ve cancelándose o cancelada. */
function cancellationMapping(
  view: HotelBookingView,
): Pick<HotelOrderPlan, 'orderStatus' | 'subStatus' | 'actions'> {
  if (stateOf(view) === 'cancelling') {
    return { orderStatus: 'pending', subStatus: null, actions: ['verify-cancellation'] };
  }
  return {
    orderStatus: 'cancelled',
    subStatus: null,
    actions: view.refundAwaited === true ? ['stop-hcn', 'track-refund'] : ['stop-hcn'],
  };
}

export function planHotelOrderObservation(
  order: HotelOrderSnapshot,
  observation: HotelOrderObservation,
): HotelOrderPlan {
  switch (observation.kind) {
    case 'intent-opened':
      return {
        orderStatus: 'pending',
        subStatus: 'create-pending',
        actions: [],
        events: [{ type: ORDER_EVENTS.createRequested }],
      };
    case 'book-failed':
      return {
        orderStatus: 'failed',
        subStatus: null,
        actions: ['release-create-key'],
        events: [{ type: ORDER_EVENTS.created, outcome: 'FAILED' }],
      };
    case 'book-uncertain':
      return {
        orderStatus: 'pending',
        subStatus: 'create-uncertain',
        actions: ['verify-by-reference'],
        events: [{ type: ORDER_EVENTS.createFailed, uncertain: true }],
      };
    case 'book-confirmed':
      return afterBook(order, observation.read);
    case 'recovered':
      return afterRecovery(order, observation.read, observation.by);
    case 'recovery-not-found':
      return {
        orderStatus: 'pending',
        subStatus: 'create-not-found-yet',
        actions: ['await-reconciliation'],
        events: [escalated('create-not-found')],
      };
    case 'cancel-claimed':
      return {
        orderStatus: 'pending',
        subStatus: 'cancel-requested',
        actions: ['send-cancel'],
        events: [],
      };
    case 'cancel-accepted':
      return afterCancel(order, observation.read, 'accepted');
    case 'cancel-rejected':
      return afterCancel(order, observation.read, 'rejected');
    case 'cancel-unverified':
      return {
        orderStatus: 'pending',
        subStatus: 'cancel-unverified',
        actions: ['verify-cancellation'],
        events: [escalated('cancellation-unverified')],
      };
    case 'read':
      return afterRead(order, observation.read, observation.source);
  }
}

/**
 * Filas 2 y 3. Lo que la tabla no lista (la lectura de cierre no la encuentra, o la ve cancelada o
 * con un estado raro) lo decide la saga de reserva (`decideAfterClosingRead`, PR-4.6): una sola
 * fuente para esa decisión.
 */
function afterBook(order: HotelOrderSnapshot, view: HotelBookingView | null): HotelOrderPlan {
  if (view === null) {
    return {
      orderStatus: 'confirmed',
      subStatus: 'unverified-read',
      actions: ['verify-by-locator'],
      events: [escalated('verification-unavailable')],
    };
  }
  const closing = decideAfterClosingRead(view);
  if (closing.kind === 'settled') {
    return {
      orderStatus: 'confirmed',
      subStatus: null,
      ...withRead(order, view),
      actions: ['schedule-hcn', ...voucherActions(view)],
      events: [
        { type: ORDER_EVENTS.created, outcome: 'CONFIRMED' },
        { type: ORDER_EVENTS.verified },
      ],
    };
  }
  return {
    orderStatus: closing.status,
    subStatus: stateOf(view) === 'unknown' ? 'unknown' : 'keep',
    ...withRead(order, view),
    actions: ['human-review'],
    events: [escalated(closing.reason)],
  };
}

/**
 * Fila 6 (y R1 de la conciliación). Lo que no es una reserva confirmada se retiene como en la
 * verificación de PR-4.7 (`decideVerification`): no se consolida ni se libera la clave.
 */
function afterRecovery(
  order: HotelOrderSnapshot,
  view: HotelBookingView,
  by: 'booking-reference' | 'reconciliation',
): HotelOrderPlan {
  const state = stateOf(view);
  const locator = view.providerBookingId?.trim();
  if (state === 'not-found') {
    return planHotelOrderObservation(order, { kind: 'recovery-not-found' });
  }
  if (state === 'confirmed' && locator !== undefined && locator.length > 0) {
    return {
      orderStatus: 'confirmed',
      subStatus: null,
      ...withRead(order, view),
      actions: ['consolidate-intent', 'schedule-hcn', ...voucherActions(view)],
      events: [{ type: ORDER_EVENTS.verified, recoveredBy: by }],
    };
  }
  if (state === 'cancelled' || state === 'cancelling') {
    return {
      orderStatus: 'keep',
      subStatus: 'create-uncertain',
      ...withRead(order, view),
      actions: ['human-review'],
      events: [escalated('verified-cancelled-upstream')],
    };
  }
  return {
    orderStatus: 'keep',
    subStatus: 'unknown',
    ...withRead(order, view),
    actions: ['human-review'],
    events: [escalated('provider-status-unknown')],
  };
}

/**
 * Filas 9 a 12, con la secuencia de 04 §4.4: un `200` es "cancelación aceptada" y el estado lo fija
 * la lectura posterior; un `479` con la reserva ya cancelada es un éxito idempotente.
 *
 * Con la respuesta del Cancel en la mano el claim ya no está en vuelo, así que ningún desenlace deja
 * `cancel-requested`: ese subestado bloquea a la verificación y a la conciliación
 * (`afterCancelledRead`), y la `verify-cancellation` que se agenda aquí nunca podría cerrar la orden.
 */
function afterCancel(
  order: HotelOrderSnapshot,
  view: HotelBookingView | null,
  outcome: 'accepted' | 'rejected',
): HotelOrderPlan {
  if (view === null || stateOf(view) === 'not-found') {
    // Sin lectura, las dos respuestas agendan la lectura de sólo lectura y nunca un segundo Cancel
    // (08 §9 C-05). Un `479` es un rechazo y la orden vuelve a su estado; si la lectura la encuentra
    // cancelada igual, es la fila 14 (R3) y la cierra la conciliación.
    return outcome === 'accepted'
      ? { orderStatus: 'pending', subStatus: null, actions: ['verify-cancellation'], events: [] }
      : {
          orderStatus: 'prior',
          subStatus: null,
          actions: ['verify-cancellation'],
          events: [{ type: ORDER_EVENTS.cancelled, success: false }],
        };
  }
  const state = stateOf(view);
  const read = withRead(order, view);
  switch (state) {
    case 'cancelling':
    case 'cancelled':
      return {
        ...cancellationMapping(view),
        ...read,
        events: statusChanged(order, view),
      };
    case 'confirmed':
      return outcome === 'accepted'
        ? // Aceptada y todavía vigente: puede ser asíncrona del lado del hotel.
          {
            orderStatus: 'pending',
            subStatus: null,
            ...read,
            actions: ['verify-cancellation'],
            events: statusChanged(order, view),
          }
        : {
            orderStatus: 'prior',
            subStatus: null,
            ...read,
            actions: [],
            events: [
              ...statusChanged(order, view),
              { type: ORDER_EVENTS.cancelled, success: false },
            ],
          };
    case 'unknown':
      return {
        orderStatus: 'keep',
        subStatus: 'unknown',
        ...read,
        actions: ['human-review'],
        events: [escalated('provider-status-unknown')],
      };
    default:
      return {
        orderStatus: 'keep',
        subStatus: null,
        ...read,
        actions: ['human-review'],
        events: [escalated('verified-status-unexpected')],
      };
  }
}

/** Filas 14 a 17, y lo que cualquier lectura de una reserva ya creada tiene que respetar. */
function afterRead(
  order: HotelOrderSnapshot,
  view: HotelBookingView,
  source: HotelOrderReadSource,
): HotelOrderPlan {
  const state = stateOf(view);
  const read = withRead(order, view);
  const changed = statusChanged(order, view);

  switch (state) {
    case 'not-found':
      // PV-01: un "no la encuentro" nunca prueba que no exista; se avisa y nada más.
      return order.status === 'confirmed'
        ? {
            orderStatus: 'keep',
            subStatus: 'keep',
            actions: ['human-review'],
            events: [escalated('verified-not-found')],
          }
        : { orderStatus: 'keep', subStatus: 'keep', actions: [], events: [] };

    case 'unknown':
      return {
        orderStatus: 'keep',
        subStatus: readOwnsSubStatus(order) ? 'unknown' : 'keep',
        ...read,
        actions: ['human-review'],
        events: [escalated('provider-status-unknown')],
      };

    case 'unexpected':
      return {
        orderStatus: 'keep',
        subStatus: 'keep',
        ...read,
        actions: ['human-review'],
        events: [escalated('verified-status-unexpected')],
      };

    case 'confirmed':
      return afterConfirmedRead(order, view, source, changed);

    case 'cancelling':
    case 'cancelled':
      return afterCancelledRead(order, view, source, changed);
  }
}

function afterConfirmedRead(
  order: HotelOrderSnapshot,
  view: HotelBookingView,
  source: HotelOrderReadSource,
  changed: HotelOrderEvent[],
): HotelOrderPlan {
  const read = withRead(order, view);
  switch (order.status) {
    case 'cancelled':
      // Fila 15 (R4): viva y cobrable del lado del proveedor. Nunca se reenvía un Cancel solo.
      return {
        orderStatus: 'keep',
        subStatus: 'keep',
        ...read,
        actions: ['urgent-human-review'],
        events: [
          { type: ORDER_EVENTS.reconciliationDiscrepancy, kind: 'R4', severity: 'critical' },
          ...changed,
        ],
      };
    case 'failed':
      return {
        orderStatus: 'keep',
        subStatus: 'keep',
        ...read,
        actions: ['urgent-human-review'],
        events: [escalated('verified-status-unexpected'), ...changed],
      };
    case 'pending':
      // PV-B: una cancelación sin verificar que la lectura ve vigente no autoriza reenviar nada.
      if (order.subStatus === 'cancel-unverified' && source === 'verify') {
        return {
          orderStatus: 'keep',
          subStatus: 'keep',
          ...read,
          actions: ['human-review'],
          events: [escalated('cancellation-unverified'), ...changed],
        };
      }
      return { orderStatus: 'keep', subStatus: 'keep', ...read, actions: [], events: changed };
    case 'confirmed':
    case 'ticketed':
      // Filas 2 y 17: vigente. Una lectura buena resuelve un `unknown` o una lectura de cierre que
      // había fallado.
      return {
        orderStatus: 'keep',
        subStatus: readOwnsSubStatus(order) ? null : 'keep',
        ...read,
        actions: voucherActions(view),
        events: [...changed, ...hcnEvents(order, view)],
      };
  }
}

function afterCancelledRead(
  order: HotelOrderSnapshot,
  view: HotelBookingView,
  source: HotelOrderReadSource,
  changed: HotelOrderEvent[],
): HotelOrderPlan {
  const read = withRead(order, view);
  const keep: HotelOrderPlan = {
    orderStatus: 'keep',
    subStatus: 'keep',
    ...read,
    actions: [],
    events: changed,
  };

  if (order.status === 'confirmed' || order.status === 'ticketed') {
    // Fila 14 (R3): cancelada fuera de la plataforma. Sólo la conciliación, que ya la confirmó con
    // una lectura, aplica el mapeo; quien sólo consulta avisa y la deja para ella.
    const discrepancy: HotelOrderEvent = {
      type: ORDER_EVENTS.reconciliationDiscrepancy,
      kind: 'R3',
      severity: 'warning',
    };
    if (source === 'reconciliation') {
      const mapped = cancellationMapping(view);
      return {
        ...mapped,
        ...read,
        actions: [...mapped.actions, 'notify-agency'],
        events: [discrepancy, ...changed],
      };
    }
    return {
      ...keep,
      actions: ['notify-agency', 'await-reconciliation'],
      events: [discrepancy, ...changed],
    };
  }

  if (order.status === 'pending') {
    const ownsTransition =
      (source === 'verify' || source === 'reconciliation') &&
      order.subStatus !== 'cancel-requested' &&
      !CREATION_SUB_STATUSES.has(order.subStatus);
    // Filas 9 a 11, en la dirección segura (D-TBO-25 A): la cierra el job que verifica la
    // cancelación, o la conciliación.
    if (ownsTransition) return { ...cancellationMapping(view), ...read, events: changed };
    return keep;
  }

  // Ya cancelada o fallida: sólo se registra (p. ej. el reembolso que llegó, fila 10 → 11).
  return keep;
}
