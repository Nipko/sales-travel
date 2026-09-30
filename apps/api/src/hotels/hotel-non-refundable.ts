import type { HotelCancellationRule, HotelRoompack, Money } from '@sales-travel/canonical';
import { saleTotalOf } from './hotel-pricing.js';

/**
 * ¿La tarifa es, EN LOS HECHOS, no reembolsable? Sin I/O (pedido del founder del 2026-09-29,
 * "tarifas no reembolsables", puntos b y c: máxima claridad para agencias y clientes).
 *
 * Se lee de forma conservadora, del lado que cuesta menos equivocarse:
 *
 * - **Declarada no reembolsable** (`refundable: false` o `status: 'non_refundable'`), digan lo que
 *   digan los tramos. Si TBO manda `IsRefundable=false` con tramos a 0 (p. 50), el ACL guarda lo que
 *   dijo sin derivar uno del otro (C-24) y acá gana lo más caro: no reembolsable.
 * - **Reembolsable con la penalidad del 100 % ya vigente**: cancelar cuesta lo mismo que en una no
 *   reembolsable, así que se trata igual. Los tramos están en hora LOCAL del hotel y el proveedor no
 *   da la zona (Q-24): se compara contra la hora local más adelantada del planeta (UTC+14). Si el
 *   100 % PUEDE estar rigiendo, rige.
 *
 * El 100 % se cuenta por habitación: con tramos por habitación, la tarifa cuesta el total cuando
 * TODAS lo cobran. Un importe fijo sólo cuenta como el total si es de toda la reserva, en la moneda
 * del neto y no menor que él. Tramos sin fecha local (horas antes del check-in, de otros
 * proveedores) no se pueden ubicar y no cuentan.
 *
 * Es la misma lectura que la web (`rate-refundability.ts`): la pantalla y el servidor no pueden
 * discrepar sobre si una tarifa exige la confirmación.
 */

/** Cuánto puede adelantarse la hora local de un hotel respecto de UTC (Kiribati, UTC+14). */
export const HOTEL_LOCAL_MAX_AHEAD_MS = 14 * 60 * 60_000;

export type HotelNonRefundableReason =
  /** El proveedor la declara no reembolsable. */
  | 'declared'
  /** Es reembolsable, pero el cargo del 100 % ya rige (o puede regir). */
  | 'full-penalty-in-force';

/** Lo que el vendedor tiene que aceptar antes de reservar una tarifa no reembolsable. */
export interface HotelNonRefundableTerms {
  readonly reason: HotelNonRefundableReason;
  /** Lo que se pierde si se cancela, se modifica o el huésped no se presenta: el precio de venta. */
  readonly penalty: Money;
  /** Con `full-penalty-in-force`: desde cuándo cobra el 100 %, en hora local del hotel. */
  readonly fullPenaltySinceLocal?: string;
}

/** La hora local más adelantada que puede tener un hotel en `nowMs`, sin zona. */
export function latestHotelLocalNow(nowMs: number): string {
  return new Date(nowMs + HOTEL_LOCAL_MAX_AHEAD_MS).toISOString().slice(0, 19);
}

/** La forma del contrato (`HotelLocalDateTimeSchema`): así se compara como texto. */
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** La fecha local de un tramo si se puede ubicar; `undefined` sin fecha o con otra forma. */
function localOf(value: string | undefined): string | undefined {
  return value !== undefined && LOCAL_RE.test(value) ? value : undefined;
}

function isFullPenalty(rule: HotelCancellationRule, net: Money): boolean {
  if ((rule.penaltyPercentage ?? 0) >= 100) return true;
  return (
    rule.roomIndex === undefined &&
    rule.penaltyAmount !== undefined &&
    rule.penaltyAmount.currency === net.currency &&
    net.amountMinor > 0 &&
    rule.penaltyAmount.amountMinor >= net.amountMinor
  );
}

/** Desde cuándo un conjunto de tramos cobra el 100 % y ya no baja (un tramo vale hasta el siguiente). */
function fullPenaltySince(rules: readonly HotelCancellationRule[], net: Money): string | undefined {
  const dated = rules
    .map((rule) => ({ rule, from: localOf(rule.fromLocalDateTime) }))
    .filter((r): r is { rule: HotelCancellationRule; from: string } => r.from !== undefined)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let since: string | undefined;
  for (const { rule, from } of dated) {
    if (isFullPenalty(rule, net)) since ??= from;
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
  const { rules } = pack.cancellation;
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
 * Las condiciones de no reembolsable que rigen en `nowMs`, o `undefined` si cancelar hoy no cuesta
 * el total. `penalty` es el precio de VENTA: lo que la agencia paga y le responde a su cliente.
 */
export function effectiveNonRefundable(
  pack: HotelRoompack,
  nowMs: number,
): HotelNonRefundableTerms | undefined {
  const c = pack.cancellation;
  const penalty = saleTotalOf(pack);
  if (!c.refundable || c.status === 'non_refundable') return { reason: 'declared', penalty };
  const since = fullPenaltySinceLocal(pack);
  if (since !== undefined && since <= latestHotelLocalNow(nowMs)) {
    return { reason: 'full-penalty-in-force', penalty, fullPenaltySinceLocal: since };
  }
  return undefined;
}
