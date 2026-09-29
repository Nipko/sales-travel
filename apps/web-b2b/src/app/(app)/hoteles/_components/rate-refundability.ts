import type { HotelCancellationRule, HotelRoompack, Money } from '../actions';
import { formatHotelLocalDateTime } from './hotel-format';

/*
 * Si una tarifa se puede cancelar sin perder todo lo pagado, leído de forma conservadora (pedido del
 * founder del 2026-09-29, "tarifas no reembolsables": máxima claridad para la agencia).
 *
 * - `refundable: false` es no reembolsable, digan lo que digan los tramos. Si TBO manda
 *   `IsRefundable=false` con tramos a 0, el ACL guarda `false` tal cual y acá se cree lo más caro.
 * - Una tarifa reembolsable cuya penalidad del 100 % ya rige se trata igual que una no reembolsable:
 *   cancelarla cuesta lo mismo. La hora de un tramo es la LOCAL del hotel y el proveedor no dice la
 *   zona, así que se compara contra la hora más adelantada del planeta (UTC+14): si la penalidad
 *   total PUEDE estar rigiendo, se trata como vigente. Equivocarse para este lado cuesta una venta;
 *   para el otro, el 100 % de una reserva.
 * - Lo mismo con la cancelación gratis: si su fin puede haber pasado, ya no se promete.
 */

/** Cuánto puede adelantarse la hora local de un hotel respecto de UTC (Kiribati, UTC+14). */
export const HOTEL_LOCAL_MAX_AHEAD_MS = 14 * 60 * 60_000;

export type RateRefundKind =
  /** No se recupera nada: declarada así, o con la penalidad del 100 % ya vigente. */
  | 'non_refundable'
  /** Se cancela sin cargo (hasta `freeUntilLocal`, si el proveedor dio la fecha). */
  | 'free_cancellation'
  /** Se recupera una parte: hay un cargo que ya rige o que rige desde el primer tramo. */
  | 'refundable_with_charge'
  /** El proveedor dijo "reembolsable" sin tramos: los plazos se conocen al revisar la tarifa. */
  | 'refundable_terms_pending';

export interface RateRefundability {
  readonly kind: RateRefundKind;
  /** Se puede cancelar sin perder el 100 %: todo menos `non_refundable`. */
  readonly refundable: boolean;
  /**
   * Una tarifa que el proveedor declaró reembolsable pero cuya penalidad del 100 % ya rige (o puede
   * regir): desde cuándo, en hora local del hotel.
   */
  readonly fullPenaltySinceLocal?: string;
  /** Fin de la cancelación sin cargo, en hora local del hotel. */
  readonly freeUntilLocal?: string;
  /**
   * Sin fecha, cuántas horas antes del check-in termina la cancelación sin cargo (Despegar la da
   * así): "Cancelación gratis" sin ese plazo prometería más de lo que vende el proveedor.
   */
  readonly freeUntilHoursBeforeCheckin?: number;
  /** Políticas de una búsqueda: el PreBook las confirma o las cambia. */
  readonly indicative: boolean;
}

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** `YYYY-MM-DDTHH:mm:ss`, para comparar como texto; `undefined` si no tiene esa forma. */
function normalizeLocal(value: string | undefined): string | undefined {
  if (value === undefined || !LOCAL_RE.test(value)) return undefined;
  return value.length === 16 ? `${value}:00` : value;
}

/** La hora local más adelantada que puede tener un hotel en el instante `nowMs`, sin zona. */
export function latestHotelLocalNow(nowMs: number): string {
  return new Date(nowMs + HOTEL_LOCAL_MAX_AHEAD_MS).toISOString().slice(0, 19);
}

function isFullPenalty(rule: HotelCancellationRule, netTotal: Money): boolean {
  if ((rule.penaltyPercentage ?? 0) >= 100) return true;
  // Un importe fijo sólo se compara contra el total cuando el tramo es de toda la reserva (de una
  // habitación no se sabe cuánto vale su parte) y está en la misma moneda: comparar COP con USD
  // daría "100 %" o "nada" según cuál de las dos cifras sea más grande.
  return (
    rule.roomIndex === undefined &&
    rule.penaltyAmount !== undefined &&
    rule.penaltyAmount.currency === netTotal.currency &&
    netTotal.amountMinor > 0 &&
    rule.penaltyAmount.amountMinor >= netTotal.amountMinor
  );
}

/**
 * Desde cuándo un conjunto de tramos cobra el 100 % y ya no baja. La semántica es la de TBO: un
 * tramo vale hasta el inicio del siguiente. Tramos sin fecha local (horas antes del check-in de
 * otros proveedores) no se pueden ubicar y no cuentan.
 */
function fullPenaltySince(
  rules: readonly HotelCancellationRule[],
  netTotal: Money,
): string | undefined {
  const dated = rules
    .map((rule) => ({ rule, from: normalizeLocal(rule.fromLocalDateTime) }))
    .filter((r): r is { rule: HotelCancellationRule; from: string } => r.from !== undefined)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let since: string | undefined;
  for (const { rule, from } of dated) {
    if (isFullPenalty(rule, netTotal)) since ??= from;
    else since = undefined;
  }
  return since;
}

/**
 * Desde cuándo cancelar la tarifa cuesta el 100 % de la reserva, en hora local del hotel, o
 * `undefined` si no hay un momento así. Con tramos por habitación, cuando TODAS cobran el 100 %.
 */
export function fullPenaltySinceLocal(
  pack: Pick<HotelRoompack, 'cancellation' | 'price' | 'rooms'>,
): string | undefined {
  const rules = pack.cancellation.rules;
  const net = pack.price.total;
  const roomCount = Math.max(1, pack.rooms.length);
  let latest: string | undefined;
  for (let room = 1; room <= roomCount; room += 1) {
    const applying = rules.filter((r) => r.roomIndex === undefined || r.roomIndex === room);
    const since = fullPenaltySince(applying, net);
    if (since === undefined) return undefined;
    if (latest === undefined || since > latest) latest = since;
  }
  return latest;
}

/**
 * Cómo se lee la cancelación de UNA tarifa. Sin `nowMs` no se mira el reloj: sólo lo declarado
 * (así lo usan pantallas que todavía no pasan la hora de la búsqueda).
 */
export function rateRefundability(
  pack: Pick<HotelRoompack, 'cancellation' | 'price' | 'rooms'>,
  nowMs?: number,
): RateRefundability {
  const c = pack.cancellation;
  const indicative = c.policySource === 'search-indicative' || c.policySource === 'none';
  // `refundable` y `status` no deberían contradecirse (el contrato lo valida), pero la pantalla no
  // depende de que un API de otra versión lo haga: si cualquiera de los dos dice "no", es no.
  if (!c.refundable || c.status === 'non_refundable') {
    return { kind: 'non_refundable', refundable: false, indicative };
  }

  const localNow = nowMs === undefined ? undefined : latestHotelLocalNow(nowMs);
  const since = fullPenaltySinceLocal(pack);
  if (since !== undefined && localNow !== undefined && since <= localNow) {
    return { kind: 'non_refundable', refundable: false, fullPenaltySinceLocal: since, indicative };
  }
  if (c.policySource === 'none') {
    return { kind: 'refundable_terms_pending', refundable: true, indicative };
  }
  if (c.status === 'fully_refundable') {
    const freeUntil = normalizeLocal(c.freeCancellationUntilLocal);
    if (freeUntil !== undefined && localNow !== undefined && freeUntil <= localNow) {
      return { kind: 'refundable_with_charge', refundable: true, indicative };
    }
    const hours = c.hoursBeforePenalty;
    return {
      kind: 'free_cancellation',
      refundable: true,
      indicative,
      ...(c.freeCancellationUntilLocal === undefined
        ? hours !== undefined && Number.isFinite(hours) && hours > 0
          ? { freeUntilHoursBeforeCheckin: hours }
          : {}
        : { freeUntilLocal: c.freeCancellationUntilLocal }),
    };
  }
  return { kind: 'refundable_with_charge', refundable: true, indicative };
}

export type RefundTone = 'warning' | 'success' | 'neutral';

/** La etiqueta corta de la tarjeta: una palabra que se lee de un vistazo. */
export interface RefundBadge {
  readonly tone: RefundTone;
  readonly label: string;
}

export function refundBadge(r: RateRefundability): RefundBadge {
  switch (r.kind) {
    case 'non_refundable':
      return { tone: 'warning', label: 'No reembolsable' };
    case 'free_cancellation':
      return { tone: 'success', label: 'Cancelación gratis' };
    case 'refundable_with_charge':
      return { tone: 'neutral', label: 'Reembolsable con cargo' };
    case 'refundable_terms_pending':
      return { tone: 'neutral', label: 'Reembolsable' };
  }
}

/** La línea de cancelación de una fila de tarifa: la etiqueta y su aclaración. */
export interface RefundLine extends RefundBadge {
  readonly note?: string;
}

export function refundLine(r: RateRefundability): RefundLine {
  const badge = refundBadge(r);
  switch (r.kind) {
    case 'non_refundable':
      return r.fullPenaltySinceLocal === undefined
        ? badge
        : {
            ...badge,
            note: `el cargo del 100 % rige desde el ${formatHotelLocalDateTime(r.fullPenaltySinceLocal)} (hora local del hotel)`,
          };
    case 'free_cancellation':
      if (r.freeUntilLocal !== undefined) {
        return {
          ...badge,
          label: `Sin cargo hasta el ${formatHotelLocalDateTime(r.freeUntilLocal)}`,
          note: r.indicative
            ? 'hora local del hotel, sujeta a confirmación'
            : 'hora local del hotel',
        };
      }
      if (r.freeUntilHoursBeforeCheckin !== undefined) {
        const h = r.freeUntilHoursBeforeCheckin;
        return {
          ...badge,
          note: `hasta ${h} h antes del check-in${r.indicative ? ', sujeta a confirmación' : ''}`,
        };
      }
      return r.indicative ? { ...badge, note: 'sujeta a confirmación' } : badge;
    case 'refundable_with_charge':
      return r.indicative ? { ...badge, note: 'sujeta a confirmación' } : badge;
    case 'refundable_terms_pending':
      return { ...badge, note: 'plazos a confirmar' };
  }
}
