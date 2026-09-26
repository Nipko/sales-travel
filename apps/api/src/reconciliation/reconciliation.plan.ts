import type { Money } from '@sales-travel/canonical';
import type { HotelBookingSummary } from '@sales-travel/domain';
import type { HotelOrderSubStatus, OrderStatus } from '../database/database.types.js';
import {
  publicProviderStatus,
  type DiscrepancySeverity,
  type ReconciliationDiscrepancyKind,
} from '../orders/order-events.js';

/**
 * La conciliación diaria de una cuenta de proveedor: **las decisiones, sin I/O** (docs/tbo/09
 * PR-5.5; 04 §9; 08 RF-28; D-TBO-24 A, D-TBO-27 A).
 *
 * Qué ventanas de fechas de creación se le piden al proveedor (tramos A y B de 04 §9.3), cómo se
 * cruza lo que devuelve con nuestras órdenes y qué significa cada divergencia (R1 a R8 de 04 §9.4).
 * El servicio lee, llama y ejecuta; lo que decide vive aquí (D9).
 *
 * Reglas que no se negocian:
 *
 *   - **Sólo se lee.** Ninguna rama crea ni cancela en el proveedor: R4 (la reserva sigue viva y la
 *     orden dice cancelada) va a una persona, nunca a un segundo Cancel (04 §9.5 punto 1).
 *   - **Toda divergencia de estado se confirma con una lectura de la reserva antes de actuar**
 *     (PV-33: el listado por fecha puede traer el estado de cuando se creó, no el de ahora).
 *   - **La ausencia sólo se concluye con evidencia fuerte** (D-TBO-24 A): un intent incierto pasa a
 *     fallido si, y sólo si, una respuesta válida que cubre su día de creación, con un día de margen a
 *     cada lado por la zona horaria (Q-57), tampoco lo encuentra. Todas las ventanas de la corrida
 *     son válidas o la corrida no llega hasta aquí.
 *   - **La equivalencia `ClientReferenceNumber` = nuestra referencia es INFERIDA** (PV-31, Q-58):
 *     una ausencia no se concluye sin haberla visto funcionar en la misma cuenta y la misma corrida.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Tramo A, las novedades: `[D−2, D]`, tres días de calendario con los dos extremos (04 §9.3). */
export const RECONCILIATION_RECENT_DAYS = 3;

/**
 * La zona de `BookingDate` no está documentada (Q-57): el día de creación que ve el proveedor puede
 * ser el anterior o el siguiente al nuestro en UTC. Toda cobertura se pide con un día a cada lado.
 */
export const RECONCILIATION_TZ_SLACK_DAYS = 1;

/**
 * Hasta dónde mira el tramo B hacia atrás, como mucho: siete ventanas de 60 días, lo que cuesta una
 * reserva con check-in a un año (04 §9.3). Una orden más vieja queda sin cubrir y se cuenta.
 */
export const RECONCILIATION_MAX_LOOKBACK_DAYS = 420;

/** R5: un intent sin desenlace y sin cruce, con más de 24 h (04 §9.4). */
export const RECONCILIATION_INTENT_MIN_AGE_MS = 24 * HOUR_MS;

/** R8: una cancelación en estado intermedio durante más de 72 h (04 §9.4). */
export const RECONCILIATION_CANCEL_STUCK_MS = 72 * HOUR_MS;

// ───────────────────────── Fechas de calendario ─────────────────────────

/** `YYYY-MM-DD` del instante en UTC. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function dayNumber(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return isoOfDay(dayNumber(isoDate) + days);
}

// ───────────────────────── Tramos A y B ─────────────────────────

export type ReconciliationLeg = 'A' | 'B';

/** Una ventana de fechas de creación, con los dos extremos incluidos. */
export interface ReconciliationWindow {
  readonly from: string;
  readonly to: string;
  /** A: toca los últimos tres días (novedades); B: reservas activas más viejas. */
  readonly leg: ReconciliationLeg;
}

export interface ReconciliationWindowsInput {
  readonly now: number;
  /**
   * Epoch ms de creación de cada orden que la corrida tiene que cubrir: las activas (check-out
   * pendiente, `pending` o `confirmed`) y todo intent sin desenlace.
   */
  readonly anchors: readonly number[];
  /** Días de calendario que acepta una ventana del proveedor. */
  readonly maxDays: number;
}

export interface ReconciliationWindowsPlan {
  /** Consecutivas, sin huecos ni solapes, en orden; la última termina hoy (UTC). */
  readonly windows: readonly ReconciliationWindow[];
  /** Órdenes más viejas que {@link RECONCILIATION_MAX_LOOKBACK_DAYS}: no se cubren. */
  readonly uncovered: number;
}

/**
 * Las ventanas de una corrida: el rango `[mín(creación − 1 día, D − 2), D]` partido en ventanas del
 * largo que acepta el proveedor, contadas desde hoy hacia atrás. Es el costo mínimo,
 * `ceil(rango / largo)` llamadas, y el tramo A queda siempre dentro de la última.
 */
export function planReconciliationWindows(
  input: ReconciliationWindowsInput,
): ReconciliationWindowsPlan {
  const maxDays = Number.isSafeInteger(input.maxDays) && input.maxDays >= 1 ? input.maxDays : 1;
  const today = dayNumber(utcDay(input.now));
  const floor = today - (RECONCILIATION_MAX_LOOKBACK_DAYS - 1);
  let start = today - (RECONCILIATION_RECENT_DAYS - 1);
  let uncovered = 0;
  for (const at of input.anchors) {
    const wanted = dayNumber(utcDay(at)) - RECONCILIATION_TZ_SLACK_DAYS;
    if (wanted < floor) {
      uncovered += 1;
      start = Math.min(start, floor);
    } else {
      start = Math.min(start, wanted);
    }
  }
  const recentFrom = today - (RECONCILIATION_RECENT_DAYS - 1);
  const windows: ReconciliationWindow[] = [];
  for (let to = today; to >= start; to -= maxDays) {
    const from = Math.max(start, to - maxDays + 1);
    windows.unshift({ from: isoOfDay(from), to: isoOfDay(to), leg: to >= recentFrom ? 'A' : 'B' });
  }
  return { windows, uncovered };
}

/** ¿Las ventanas cubren `day` con un día de margen a cada lado? */
export function windowsCoverDay(windows: readonly ReconciliationWindow[], day: string): boolean {
  for (
    let offset = -RECONCILIATION_TZ_SLACK_DAYS;
    offset <= RECONCILIATION_TZ_SLACK_DAYS;
    offset++
  ) {
    const wanted = addDays(day, offset);
    if (!windows.some((w) => w.from <= wanted && wanted <= w.to)) return false;
  }
  return true;
}

// ───────────────────────── Cruce y clasificación ─────────────────────────

/** Una orden de la cuenta, con lo que el cruce y el clasificador necesitan. Sin PII. */
export interface ReconciliationOrder {
  readonly tenantId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly subStatus: HotelOrderSubStatus | null;
  /** Último estado leído del proveedor, crudo; `null` = nunca se leyó. */
  readonly providerStatus: string | null;
  readonly refundAwaited: boolean;
  readonly providerOrderId: string | null;
  readonly bookingReference: string | null;
  /** Epoch ms. */
  readonly createdAt: number;
  /** `pending` sin desenlace del Book: sin `provider_raw` ni localizador. */
  readonly openIntent: boolean;
  /** La verificación del Book tiene un paso programado: todavía está buscando la reserva. */
  readonly verificationScheduled: boolean;
  /** Epoch ms desde el que corre la cancelación en curso (el ancla de su calendario), o `null`. */
  readonly cancelSince: number | null;
  /** El neto del proveedor que se guardó al reservar, si se puede leer. */
  readonly net: Money | null;
}

/**
 * `settle`: nuestra orden va detrás del proveedor sin que eso sea una divergencia (una cancelación
 * nuestra que el proveedor ya terminó, un reembolso que llegó). Se confirma con una lectura y se
 * cierra, sin ítem.
 */
export type ReconciliationReadFindingKind = 'R1' | 'R3' | 'R4' | 'R7' | 'settle';

/** Qué se vio en el precio (R6). Montos exactos, en unidades menores. */
export interface ReconciliationPriceObservation {
  /** `currency:<moneda>` o `net:<moneda>:<neto>`: el valor observado de la deduplicación. */
  readonly observed: string;
  readonly total: Money;
  readonly agencyCommission?: Money;
  readonly providerNet?: Money;
  readonly storedNet: Money;
}

export type ReconciliationFinding =
  /** Hay que leer la reserva por su localizador antes de hacer nada. */
  | {
      readonly kind: ReconciliationReadFindingKind;
      readonly order: ReconciliationOrder;
      readonly booking: HotelBookingSummary;
      readonly severity: DiscrepancySeverity;
    }
  /** R2: ninguna orden nuestra la cruza. Va al reporte del dueño de la cuenta (D-TBO-27 A). */
  | { readonly kind: 'R2'; readonly booking: HotelBookingSummary; readonly severity: 'info' }
  /** R5: evidencia fuerte de que el intent no existe en el proveedor (D-TBO-24 A). */
  | { readonly kind: 'R5'; readonly order: ReconciliationOrder; readonly severity: 'warning' }
  /** R6: sólo se registra; la relación de los montos no está confirmada (PV-32, Q-89). */
  | {
      readonly kind: 'R6';
      readonly order: ReconciliationOrder;
      readonly booking: HotelBookingSummary;
      readonly price: ReconciliationPriceObservation;
      readonly severity: 'info';
    }
  /** R8: una cancelación nuestra sin terminar después de 72 h: ticket al proveedor. */
  | {
      readonly kind: 'R8';
      readonly order: ReconciliationOrder;
      readonly booking: HotelBookingSummary;
      readonly severity: 'warning';
    };

/** Por qué un intent incierto sin cruce sigue bloqueado (D-TBO-24 A). */
export type ReconciliationHoldReason =
  /** Tiene menos de 24 h. */
  | 'too-recent'
  /** Su verificación todavía tiene pasos por delante. */
  | 'verification-running'
  /** Una lectura ya vio la reserva en el proveedor: existe, aunque no apareciera en este listado. */
  | 'seen-by-provider'
  /** No se vio a `ClientReferenceNumber` traer nuestra referencia en esta cuenta. */
  | 'reference-unproven'
  /** Se lo vio traer OTRA cosa: la equivalencia no vale en esta cuenta. */
  | 'reference-contradicted'
  /** Las ventanas leídas no cubren su día de creación con el margen. */
  | 'not-covered'
  /**
   * Una reserva sin referencia legible y sin orden, creada ese día, podría ser ésta; o el listado
   * trae su referencia en una fila ambigua.
   */
  | 'ambiguous-booking';

export type ReconciliationReferenceEvidence = 'proven' | 'unproven' | 'contradicted';

export interface ReconciliationPlanInput {
  readonly now: number;
  /** Las ventanas leídas, todas con respuesta válida. */
  readonly windows: readonly ReconciliationWindow[];
  /** Lo que devolvieron. */
  readonly bookings: readonly HotelBookingSummary[];
  /** Las órdenes de la cuenta en la red del dueño: las activas y las que cruzan por alguna clave. */
  readonly orders: readonly ReconciliationOrder[];
}

export interface ReconciliationPlan {
  readonly findings: readonly ReconciliationFinding[];
  readonly held: readonly {
    readonly order: ReconciliationOrder;
    readonly reason: ReconciliationHoldReason;
  }[];
  /** Filas que cruzaron con una orden. */
  readonly matched: number;
  /**
   * Filas sobre las que nadie actúa: su localizador aparece dos veces en el listado, o cruzan con
   * más de una orden, o con una orden que ya tiene otro localizador.
   */
  readonly ambiguous: number;
  readonly referenceEvidence: ReconciliationReferenceEvidence;
}

const SEVERITY: Readonly<Record<ReconciliationDiscrepancyKind, DiscrepancySeverity>> = {
  R1: 'warning',
  R2: 'info',
  R3: 'warning',
  R4: 'critical',
  R5: 'warning',
  R6: 'info',
  R7: 'warning',
  R8: 'warning',
};

function key(value: string): string {
  return value.trim().toUpperCase();
}

function indexBy(
  orders: readonly ReconciliationOrder[],
  pick: (order: ReconciliationOrder) => string | null,
): Map<string, ReconciliationOrder[]> {
  const index = new Map<string, ReconciliationOrder[]>();
  for (const order of orders) {
    const value = pick(order);
    if (value === null || value.trim() === '') continue;
    const k = key(value);
    index.set(k, [...(index.get(k) ?? []), order]);
  }
  return index;
}

type Match =
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }
  | {
      readonly kind: 'matched';
      readonly order: ReconciliationOrder;
      readonly by: 'locator' | 'reference';
    };

function match(
  booking: HotelBookingSummary,
  byLocator: Map<string, ReconciliationOrder[]>,
  byReference: Map<string, ReconciliationOrder[]>,
): Match {
  // 1. `ConfirmationNo` = `orders.provider_order_id`, dentro de la cuenta (04 §9.3).
  const locator = byLocator.get(key(booking.providerBookingId)) ?? [];
  if (locator.length > 1) return { kind: 'ambiguous' };
  const [byLoc] = locator;
  if (byLoc !== undefined) return { kind: 'matched', order: byLoc, by: 'locator' };
  // 2. `ClientReferenceNumber` = la referencia del intent: así aparecen los que no tienen localizador.
  if (booking.bookingReference === undefined) return { kind: 'none' };
  const reference = byReference.get(key(booking.bookingReference)) ?? [];
  if (reference.length > 1) return { kind: 'ambiguous' };
  const [byRef] = reference;
  if (byRef === undefined) return { kind: 'none' };
  // Con otro localizador ya guardado, la referencia y el localizador dicen cosas distintas.
  if (byRef.providerOrderId !== null) return { kind: 'ambiguous' };
  return { kind: 'matched', order: byRef, by: 'reference' };
}

type RowState = 'confirmed' | 'cancelling' | 'cancelled' | 'unknown' | 'other' | 'absent';

function rowState(booking: HotelBookingSummary): RowState {
  switch (booking.status) {
    case undefined:
      return 'absent';
    case 'CONFIRMED':
      return 'confirmed';
    case 'CANCELLATION_IN_PROGRESS':
      return 'cancelling';
    case 'CANCELLED':
      return 'cancelled';
    case 'UNKNOWN':
      return 'unknown';
    default:
      return 'other';
  }
}

/** Subestados de un proceso de creación abierto: la verificación del Book es su dueña. */
const CREATION_SUB_STATUSES: ReadonlySet<HotelOrderSubStatus | null> = new Set([
  'create-pending',
  'create-uncertain',
  'create-not-found-yet',
]);

function readFinding(
  kind: ReconciliationReadFindingKind,
  order: ReconciliationOrder,
  booking: HotelBookingSummary,
): ReconciliationFinding {
  return { kind, order, booking, severity: kind === 'settle' ? 'info' : SEVERITY[kind] };
}

/** R6: `BookingPrice − AgentMarkup` contra el neto guardado, y la moneda (04 §9.4). */
function priceObservation(
  order: ReconciliationOrder,
  booking: HotelBookingSummary,
): ReconciliationPriceObservation | undefined {
  const { total, agencyCommission } = booking;
  const stored = order.net;
  if (total === undefined || stored === null) return undefined;
  if (total.currency !== stored.currency) {
    return {
      observed: `currency:${total.currency}`,
      total,
      ...(agencyCommission === undefined ? {} : { agencyCommission }),
      storedNet: stored,
    };
  }
  if (agencyCommission === undefined || agencyCommission.currency !== total.currency) {
    return undefined;
  }
  const net = total.amountMinor - agencyCommission.amountMinor;
  if (net === stored.amountMinor) return undefined;
  const providerNet: Money = { amountMinor: net, currency: total.currency };
  return {
    observed: `net:${total.currency}:${net}`,
    total,
    agencyCommission,
    providerNet,
    storedNet: stored,
  };
}

function cancellationStuck(order: ReconciliationOrder, now: number): boolean {
  return order.cancelSince !== null && now - order.cancelSince >= RECONCILIATION_CANCEL_STUCK_MS;
}

/** Qué significa una fila que cruzó con una orden. */
function classifyMatched(
  order: ReconciliationOrder,
  booking: HotelBookingSummary,
  now: number,
): ReconciliationFinding[] {
  const state = rowState(booking);

  if (order.openIntent) {
    // R1: un intent sin localizador que el proveedor sí tiene. Sólo puede cruzar por referencia.
    return [readFinding('R1', order, booking)];
  }

  switch (order.status) {
    case 'confirmed':
    case 'ticketed': {
      if (state === 'cancelling' || state === 'cancelled')
        return [readFinding('R3', order, booking)];
      if (state === 'unknown') return [readFinding('R7', order, booking)];
      const price = priceObservation(order, booking);
      return price === undefined ? [] : [{ kind: 'R6', order, booking, price, severity: 'info' }];
    }

    case 'pending': {
      // Con el claim de cancelación en vuelo nadie más toca la orden; un proceso de creación abierto
      // con localizador (la lectura de cierre la contradijo) es de la verificación y de una persona.
      if (order.subStatus === 'cancel-requested' || CREATION_SUB_STATUSES.has(order.subStatus)) {
        return [];
      }
      if (state === 'cancelled') return [readFinding('settle', order, booking)];
      if (state === 'unknown') return [readFinding('R7', order, booking)];
      if ((state === 'cancelling' || state === 'confirmed') && cancellationStuck(order, now)) {
        return [{ kind: 'R8', order, booking, severity: 'warning' }];
      }
      return [];
    }

    case 'cancelled':
      if (state === 'confirmed') return [readFinding('R4', order, booking)];
      if (state === 'unknown') return [readFinding('R7', order, booking)];
      // El reembolso del proveedor llegó: se registra, no bloquea nada (04 §6.3 fila 10 → 11).
      if (state === 'cancelled' && order.refundAwaited && booking.refundAwaited !== true) {
        return [readFinding('settle', order, booking)];
      }
      return [];

    case 'failed':
      // Una orden que dimos por no hecha y que el proveedor tiene viva: "resucitada", como R4.
      if (state === 'confirmed' || state === 'cancelling') {
        return [readFinding('R4', order, booking)];
      }
      return [];
  }
}

function referenceEvidence(
  pairs: readonly { order: ReconciliationOrder; booking: HotelBookingSummary }[],
): ReconciliationReferenceEvidence {
  let proven = false;
  for (const { order, booking } of pairs) {
    if (order.bookingReference === null || booking.bookingReference === undefined) continue;
    if (key(order.bookingReference) !== key(booking.bookingReference)) return 'contradicted';
    proven = true;
  }
  return proven ? 'proven' : 'unproven';
}

/** R5 o por qué no (D-TBO-24 A). */
function intentAbsence(
  order: ReconciliationOrder,
  input: ReconciliationPlanInput,
  evidence: ReconciliationReferenceEvidence,
  unreferenced: readonly HotelBookingSummary[],
  listedReferences: ReadonlySet<string>,
): ReconciliationHoldReason | 'R5' {
  if (input.now - order.createdAt < RECONCILIATION_INTENT_MIN_AGE_MS) return 'too-recent';
  if (order.verificationScheduled) return 'verification-running';
  if (order.providerStatus !== null) return 'seen-by-provider';
  // Una fila con su referencia que no cruzó (localizador repetido, p. ej. una fila por habitación)
  // no es ausencia: el listado la trae, aunque nadie pueda actuar sobre ella.
  if (order.bookingReference !== null && listedReferences.has(key(order.bookingReference))) {
    return 'ambiguous-booking';
  }
  if (evidence === 'contradicted') return 'reference-contradicted';
  if (evidence === 'unproven') return 'reference-unproven';
  const day = utcDay(order.createdAt);
  if (!windowsCoverDay(input.windows, day)) return 'not-covered';
  const near = unreferenced.some(
    (b) =>
      b.bookingDate >= addDays(day, -RECONCILIATION_TZ_SLACK_DAYS) &&
      b.bookingDate <= addDays(day, RECONCILIATION_TZ_SLACK_DAYS),
  );
  return near ? 'ambiguous-booking' : 'R5';
}

/**
 * Cruza el listado con las órdenes y clasifica (04 §9.3 y §9.4). Cada fila cruza a lo sumo con una
 * orden; una fila sin cruce es externa (R2); un intent sin desenlace que ninguna fila cruza es R5 o
 * sigue bloqueado, con su motivo.
 */
export function planReconciliation(input: ReconciliationPlanInput): ReconciliationPlan {
  const orders = [...new Map(input.orders.map((o) => [o.orderId, o])).values()];
  const byLocator = indexBy(orders, (o) => o.providerOrderId);
  const byReference = indexBy(orders, (o) => o.bookingReference);

  const seenLocators = new Map<string, number>();
  for (const booking of input.bookings) {
    const k = key(booking.providerBookingId);
    seenLocators.set(k, (seenLocators.get(k) ?? 0) + 1);
  }

  const findings: ReconciliationFinding[] = [];
  const matchedOrders = new Set<string>();
  const byLocatorPairs: { order: ReconciliationOrder; booking: HotelBookingSummary }[] = [];
  const unreferenced: HotelBookingSummary[] = [];
  let matched = 0;
  let ambiguous = 0;

  for (const booking of input.bookings) {
    if ((seenLocators.get(key(booking.providerBookingId)) ?? 0) > 1) {
      ambiguous += 1;
      // Un localizador repetido tampoco cruzó con nadie: sin referencia, podría ser un intent nuestro.
      if (booking.bookingReference === undefined) unreferenced.push(booking);
      continue;
    }
    const m = match(booking, byLocator, byReference);
    if (m.kind === 'ambiguous') {
      ambiguous += 1;
      continue;
    }
    if (m.kind === 'none') {
      findings.push({ kind: 'R2', booking, severity: 'info' });
      // Sin referencia legible no se puede descartar que sea un intent nuestro.
      if (booking.bookingReference === undefined) unreferenced.push(booking);
      continue;
    }
    matched += 1;
    matchedOrders.add(m.order.orderId);
    if (m.by === 'locator') byLocatorPairs.push({ order: m.order, booking });
    findings.push(...classifyMatched(m.order, booking, input.now));
  }

  const evidence = referenceEvidence(byLocatorPairs);
  const listedReferences = new Set(
    input.bookings.flatMap((b) =>
      b.bookingReference === undefined ? [] : [key(b.bookingReference)],
    ),
  );
  const held: { order: ReconciliationOrder; reason: ReconciliationHoldReason }[] = [];
  for (const order of orders) {
    if (!order.openIntent || order.status !== 'pending' || matchedOrders.has(order.orderId)) {
      continue;
    }
    const verdict = intentAbsence(order, input, evidence, unreferenced, listedReferences);
    if (verdict === 'R5') findings.push({ kind: 'R5', order, severity: 'warning' });
    else held.push({ order, reason: verdict });
  }

  return { findings, held, matched, ambiguous, referenceEvidence: evidence };
}

// ───────────────────────── Deduplicación ─────────────────────────

/** El estado de una fila como código: el del enum del proveedor, o `unknown`. */
export function observedStatus(booking: HotelBookingSummary): string {
  if (booking.status === undefined) return 'absent';
  return publicProviderStatus(
    booking.providerStatus ?? booking.status,
    booking.status !== 'UNKNOWN',
  );
}

/**
 * `clase|sujeto|valor observado` (04 §9.5 punto 4): repetir una ventana no duplica el ítem ni su
 * evento, y un cambio de lo observado (otro estado, otro neto) sí vuelve a avisar.
 */
export function reconciliationDedupeKey(
  kind: ReconciliationDiscrepancyKind,
  subject: { readonly orderId?: string; readonly providerBookingId?: string },
  observed = '',
): string {
  const who =
    subject.providerBookingId === undefined
      ? `order:${subject.orderId ?? ''}`
      : `booking:${key(subject.providerBookingId)}`;
  return `${kind}|${who}|${observed}`;
}
