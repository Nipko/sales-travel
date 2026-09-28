import {
  HotelCancellationSchema,
  MoneySchema,
  type HotelCancellation,
  type HotelCancellationRule,
  type HotelPolicySource,
  type Money,
} from '@sales-travel/canonical';
import type {
  HotelBookingView,
  HotelCancelResult,
  OrderCancelSettlement,
} from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import type { OrderStatus } from '../database/database.types.js';
import {
  planHotelOrderObservation,
  type HotelOrderObservation,
  type HotelOrderPlan,
  type HotelOrderSnapshot,
} from './hotel-order-state.js';

/**
 * La cancelación de una reserva de hotel: **las decisiones, sin I/O** (docs/tbo/09 PR-5.3; 08 RF-25;
 * 04 §4.4 y §4.5; D-TBO-25 A, D-TBO-26 A).
 *
 * Dos piezas:
 *
 * 1. **La penalidad estimada** que se muestra antes de confirmar. El proveedor no informa cargo ni
 *    reembolso al cancelar (p. 42), y las políticas del PreBook son las finales (p. 71): se toma el
 *    tramo vigente "ahora" en la hora del hotel y se aplica sobre el total del PreBook. Es nuestra
 *    estimación y va en su propio campo, nunca en `refundAmount`.
 * 2. **Qué queda de la orden** con la respuesta del proveedor: la tabla de 04 §6.3
 *    (`planHotelOrderObservation`) llevada a un estado final de la orden.
 */

// ───────────────────────── La penalidad estimada ─────────────────────────

const HOUR = 3_600_000;

/**
 * Los husos horarios extremos que existen (UTC−12 y UTC+14). Sin la zona del hotel, "ahora en la
 * hora del hotel" es cualquier instante de esa franja, y la estimación toma el tramo más caro que
 * puede estar vigente: prometer una cancelación gratuita que el hotel ya no da es el error caro.
 */
const EARLIEST_OFFSET_MS = -12 * HOUR;
const LATEST_OFFSET_MS = 14 * HOUR;

/** Lo que la estimación necesita del snapshot de la orden (`orders.selected_offer`). */
export interface HotelCancellationSnapshot {
  /** El total del PreBook: lo que el proveedor carga a la cuenta. */
  readonly total: Money;
  readonly roomCount: number;
  readonly cancellation: HotelCancellation;
  /** YYYY-MM-DD, como lo pidió la búsqueda. */
  readonly checkinDate: string;
}

const SelectedOfferSchema = z.object({
  checkinDate: z.string().date(),
  roompack: z.object({
    price: z.object({ total: MoneySchema }),
    rooms: z.array(z.unknown()).min(1),
    cancellation: HotelCancellationSchema,
  }),
});

/**
 * El snapshot de `orders.selected_offer`, validado: la columna es JSON escrito por otra versión del
 * código, y una estimación sobre un campo que cambió de forma sería un número inventado.
 */
export function hotelCancellationSnapshotOf(
  selectedOffer: unknown,
): HotelCancellationSnapshot | undefined {
  let value = selectedOffer;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  const parsed = SelectedOfferSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { roompack, checkinDate } = parsed.data;
  return {
    total: roompack.price.total,
    roomCount: roompack.rooms.length,
    cancellation: roompack.cancellation,
    checkinDate,
  };
}

/** Por qué no hay estimación. */
export type HotelCancellationEstimateGap =
  /** La orden no guarda un snapshot legible. */
  | 'no-snapshot'
  /** Reembolsable sin un solo tramo: no se sabe cuánto cobra el proveedor. */
  | 'no-policy';

export type HotelCancellationEstimate =
  | {
      readonly kind: 'estimated';
      /** Lo que se estima que cobra el proveedor, en la moneda del pack. */
      readonly penalty: Money;
      /** Sobre qué se estimó: el total del PreBook. */
      readonly base: Money;
      /** `free`: ningún tramo cobra ahora; `non-refundable`: la tarifa no se reembolsa. */
      readonly basis: 'free' | 'charged' | 'non-refundable';
      /** De dónde salieron las políticas; sólo `prebook-final` las presenta como definitivas. */
      readonly policySource: HotelPolicySource | 'undeclared';
      /** Cómo se ubicó "ahora" en la hora del hotel. */
      readonly clock: 'hotel-time-zone' | 'widest-offset';
      /**
       * `true`: el número depende de algo que no se sabe (la zona del hotel, un tramo sin fecha o
       * sin cargo legible) y se tomó el mayor posible.
       */
      readonly conservative: boolean;
      /**
       * Ya es (o, sin la zona, puede ser) el día de entrada en la hora del hotel. Desde ese día la
       * cancelación la gestiona soporte (04 PV-22).
       */
      readonly checkInReached: boolean;
    }
  | { readonly kind: 'unavailable'; readonly reason: HotelCancellationEstimateGap };

export interface HotelCancellationEstimateInput {
  readonly snapshot: HotelCancellationSnapshot | undefined;
  /** Epoch ms. */
  readonly now: number;
  /** Zona IANA del hotel. Ausente: no se conoce (hoy, siempre: 05 §9.6). */
  readonly timeZone?: string;
}

/** `YYYY-MM-DDTHH:mm:ss` de un instante leído como si fuera UTC. */
function utcLocal(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19);
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/** `YYYY-MM-DDTHH:mm:ss` de un instante en la zona dada, o `undefined` si la zona no existe. */
function zonedLocal(epochMs: number, timeZone: string): string | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(epochMs);
  } catch {
    return undefined;
  }
  const v: LocalParts = { year: '', month: '', day: '', hour: '', minute: '', second: '' };
  for (const part of parts) (v as unknown as Record<string, string>)[part.type] = part.value;
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}`;
}

interface RuleCharge {
  readonly amountMinor: number;
  /** El tramo no dice cuánto cobra en una forma que se entienda: se cobró la parte entera. */
  readonly guessed: boolean;
}

/**
 * Lo que cobra un tramo sobre `shareMinor` (el total, o la parte de una habitación). Un tramo sin
 * cargo legible cobra la parte entera: el error menos dañino es avisar de más (02 §9.6).
 */
function chargeOf(
  rule: HotelCancellationRule,
  shareMinor: number,
  divisor: number,
  currency: string,
): RuleCharge {
  if (rule.penaltyAmount !== undefined) {
    if (rule.penaltyAmount.currency === currency) {
      return { amountMinor: rule.penaltyAmount.amountMinor, guessed: false };
    }
    return { amountMinor: Math.round(shareMinor / divisor), guessed: true };
  }
  if (rule.penaltyPercentage !== undefined) {
    // Centésimas de punto en enteros: 33,33 % de un total no puede depender del redondeo de un float.
    const hundredths = Math.round(rule.penaltyPercentage * 100);
    return {
      amountMinor: Math.round((shareMinor * hundredths) / (10_000 * divisor)),
      guessed: false,
    };
  }
  return { amountMinor: Math.round(shareMinor / divisor), guessed: true };
}

/** Un tramo con inicio: el único que se puede ubicar en el tiempo. */
type DatedRule = HotelCancellationRule & { readonly fromLocalDateTime: string };

function isDated(rule: HotelCancellationRule): rule is DatedRule {
  return rule.fromLocalDateTime !== undefined;
}

/** El tramo vigente a la hora local `at`: el último que ya empezó, en el orden de su inicio. */
function inForce(rules: readonly DatedRule[], at: string): DatedRule | undefined {
  let current: DatedRule | undefined;
  for (const rule of rules) {
    if (rule.fromLocalDateTime <= at) current = rule;
  }
  return current;
}

function byStart(a: DatedRule, b: DatedRule): number {
  // Comparación de código de carácter: la hora local sin zona ordena igual como texto.
  return a.fromLocalDateTime < b.fromLocalDateTime
    ? -1
    : a.fromLocalDateTime > b.fromLocalDateTime
      ? 1
      : 0;
}

interface PenaltyAt {
  readonly amountMinor: number;
  readonly guessed: boolean;
}

/**
 * La penalidad a la hora local `at`. Los tramos de toda la reserva se aplican sobre el total; los de
 * una habitación, sobre su parte del total (el proveedor no desglosa el precio por habitación). Si
 * hay de las dos clases, rige la mayor.
 */
function penaltyAt(
  snapshot: HotelCancellationSnapshot,
  dated: readonly DatedRule[],
  at: string,
): PenaltyAt {
  const { total, roomCount } = snapshot;
  const rules = [...dated].sort(byStart);
  const whole = inForce(
    rules.filter((r) => r.roomIndex === undefined),
    at,
  );
  const wholeCharge =
    whole === undefined ? undefined : chargeOf(whole, total.amountMinor, 1, total.currency);

  let roomsMinor = 0;
  let roomsGuessed = false;
  const rooms = new Set(rules.flatMap((r) => (r.roomIndex === undefined ? [] : [r.roomIndex])));
  for (const room of rooms) {
    const rule = inForce(
      rules.filter((r) => r.roomIndex === room),
      at,
    );
    if (rule === undefined) continue;
    const charge = chargeOf(rule, total.amountMinor, roomCount, total.currency);
    roomsMinor += charge.amountMinor;
    roomsGuessed ||= charge.guessed;
  }

  const wholeMinor = wholeCharge?.amountMinor ?? 0;
  const amountMinor = Math.min(total.amountMinor, Math.max(wholeMinor, roomsMinor));
  const guessed = wholeMinor >= roomsMinor ? wholeCharge?.guessed === true : roomsGuessed;
  return { amountMinor, guessed };
}

/**
 * La penalidad estimada de cancelar AHORA (04 §4.4 punto 1, §4.5; D-TBO-26 A).
 *
 * - Tarifa no reembolsable: el total.
 * - Reembolsable sin tramos: sin estimación (no se inventa "gratis").
 * - Un tramo sin inicio legible no se puede ubicar en el tiempo: rige el más caro de todos.
 * - Sin la zona del hotel: el tramo más caro que puede estar vigente en alguna zona real.
 */
export function estimateHotelCancellationPenalty(
  input: HotelCancellationEstimateInput,
): HotelCancellationEstimate {
  const { snapshot, now } = input;
  if (snapshot === undefined) return { kind: 'unavailable', reason: 'no-snapshot' };
  const { total, cancellation } = snapshot;
  const policySource: HotelPolicySource | 'undeclared' = cancellation.policySource ?? 'undeclared';

  const zoned = input.timeZone === undefined ? undefined : zonedLocal(now, input.timeZone);
  const earliest = zoned ?? utcLocal(now + EARLIEST_OFFSET_MS);
  const latest = zoned ?? utcLocal(now + LATEST_OFFSET_MS);
  const common = {
    base: total,
    policySource,
    clock: zoned === undefined ? ('widest-offset' as const) : ('hotel-time-zone' as const),
    checkInReached: latest.slice(0, 10) >= snapshot.checkinDate,
  };

  if (!cancellation.refundable) {
    return {
      kind: 'estimated',
      ...common,
      penalty: total,
      basis: 'non-refundable',
      conservative: false,
    };
  }
  if (cancellation.rules.length === 0) return { kind: 'unavailable', reason: 'no-policy' };

  const dated = cancellation.rules.filter(isDated);
  // Sin inicio no hay forma de saber si ya rige: se da por vigente el tramo más caro de la reserva
  // y, de cada habitación, el suyo. Las habitaciones se cancelan juntas (04 PV-19): sus cargos se
  // suman, como en `penaltyAt`; el mayor de un solo tramo subestimaría una reserva de varias.
  if (dated.length !== cancellation.rules.length) {
    let wholeMinor = 0;
    const roomsMinor = new Map<number, number>();
    for (const rule of cancellation.rules) {
      const room = rule.roomIndex;
      const { amountMinor } = chargeOf(
        rule,
        total.amountMinor,
        room === undefined ? 1 : snapshot.roomCount,
        total.currency,
      );
      if (room === undefined) wholeMinor = Math.max(wholeMinor, amountMinor);
      else roomsMinor.set(room, Math.max(roomsMinor.get(room) ?? 0, amountMinor));
    }
    const roomsTotal = [...roomsMinor.values()].reduce((sum, minor) => sum + minor, 0);
    const amountMinor = Math.min(total.amountMinor, Math.max(wholeMinor, roomsTotal));
    return {
      kind: 'estimated',
      ...common,
      penalty: { amountMinor, currency: total.currency },
      basis: amountMinor === 0 ? 'free' : 'charged',
      conservative: true,
    };
  }

  // Los instantes en que puede cambiar el tramo vigente dentro de la franja posible.
  const candidates = [
    earliest,
    ...dated.map((r) => r.fromLocalDateTime).filter((from) => from > earliest && from <= latest),
    latest,
  ];
  const penalties = candidates.map((at) => penaltyAt(snapshot, dated, at));
  const worst = penalties.reduce((a, b) => (b.amountMinor > a.amountMinor ? b : a));
  const varies = penalties.some((p) => p.amountMinor !== worst.amountMinor);
  return {
    kind: 'estimated',
    ...common,
    penalty: { amountMinor: worst.amountMinor, currency: total.currency },
    basis: worst.amountMinor === 0 ? 'free' : 'charged',
    conservative: varies || worst.guessed,
  };
}

// ───────────────────────── La respuesta del proveedor ─────────────────────────

/**
 * La respuesta del Cancel como observación de la tabla de 04 §6.3. `success` dice si la
 * cancelación quedó pedida; la lectura posterior, si quedó cancelada o en curso. Sin
 * `bookingStatus`, la lectura no se hizo, falló o no encontró la reserva: las tres cosas no deciden
 * nada y quedan para la verificación.
 */
export function hotelCancelObservationOf(
  result: HotelCancelResult,
): Extract<HotelOrderObservation, { kind: 'cancel-accepted' | 'cancel-rejected' }> {
  const read: HotelBookingView | null =
    result.bookingStatus === undefined
      ? null
      : {
          found: true,
          status: result.bookingStatus,
          ...(result.providerStatus === undefined ? {} : { providerStatus: result.providerStatus }),
          ...(result.refundAwaited === true ? { refundAwaited: true } : {}),
          warnings: [],
        };
  return { kind: result.success ? 'cancel-accepted' : 'cancel-rejected', read };
}

export interface HotelCancelOutcome {
  /** El estado con que la orden cierra la operación de cancelación. */
  readonly orderStatus: OrderStatus;
  /** `final` sólo si la orden queda cancelada. */
  readonly settlement: OrderCancelSettlement;
  readonly plan: HotelOrderPlan;
}

/**
 * Qué queda de la orden con la respuesta del proveedor.
 *
 * @param order la orden y su seguimiento con el claim de cancelación tomado (`pending`).
 * @param prior el estado que tenía antes del claim: al que vuelve con un rechazo.
 */
export function settleHotelCancel(
  order: HotelOrderSnapshot,
  prior: OrderStatus,
  result: HotelCancelResult,
): HotelCancelOutcome {
  const plan = planHotelOrderObservation(order, hotelCancelObservationOf(result));
  const orderStatus =
    plan.orderStatus === 'prior'
      ? prior
      : plan.orderStatus === 'keep'
        ? order.status
        : plan.orderStatus;
  return { orderStatus, settlement: orderStatus === 'cancelled' ? 'final' : 'in-progress', plan };
}
