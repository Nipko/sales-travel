import type { HotelRoompack, Money } from '../../actions';
import { formatHotelLocalDateTime, formatMoney } from '../../_components/hotel-format';
import { saleTotal } from '../../_components/hotel-rate-view';
import { rateRefundability } from '../../_components/rate-refundability';

/*
 * Tarifas no reembolsables en el checkout, sin React (pedido del founder del 2026-09-29, puntos b y
 * c: máxima claridad para agencias y clientes).
 *
 * Qué es "no reembolsable" lo decide el servidor con la política FINAL del PreBook y lo manda en
 * `nonRefundable`: declarada así (también si TBO la declara no reembolsable con tramos a 0), o
 * reembolsable con el 100 % ya vigente. La pantalla lo toma de ahí y, además, mira el reloj: una
 * tarifa que pasa a cobrar el 100 % mientras el vendedor carga los huéspedes también pide la
 * confirmación, con la misma lectura que el servidor (`rate-refundability.ts`). Si discreparan, el
 * servidor rechaza el Book con `NON_REFUNDABLE_NOT_ACKNOWLEDGED` y la casilla aparece igual.
 */

export type NonRefundableReason = 'declared' | 'full-penalty-in-force';

/** Espejo de `HotelNonRefundableTerms` del API. */
export interface PrebookNonRefundable {
  readonly reason: NonRefundableReason;
  /** El 100 %: el precio de VENTA de la tarifa, lo que la agencia paga. */
  readonly penalty: Money;
  /** Con `full-penalty-in-force`: desde cuándo cobra el 100 %, en hora local del hotel. */
  readonly fullPenaltySinceLocal?: string;
}

/** La casilla del checkout, en los errores de campo como la nombra el API. */
export const NON_REFUNDABLE_FIELD = 'nonRefundableAcknowledged';

export const NON_REFUNDABLE_REQUIRED =
  'Confirmá que entendés que la tarifa no es reembolsable para reservarla.';

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

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
    CURRENCY_RE.test(currency)
    ? { amountMinor, currency }
    : undefined;
}

/**
 * `nonRefundable` del PreBook (o `details` de un rechazo del Book), o `undefined` si no está o no
 * se entiende. Un motivo desconocido se lee como `declared`: lo que importa es que no se recupera.
 */
export function parseNonRefundable(value: unknown): PrebookNonRefundable | undefined {
  if (!isRecord(value)) return undefined;
  const penalty = moneyOf(value['penalty']);
  if (penalty === undefined) return undefined;
  const since = value['fullPenaltySinceLocal'];
  const reason = value['reason'] ?? value['nonRefundableReason'];
  return {
    reason: reason === 'full-penalty-in-force' ? 'full-penalty-in-force' : 'declared',
    penalty,
    ...(typeof since === 'string' && LOCAL_RE.test(since) ? { fullPenaltySinceLocal: since } : {}),
  };
}

/**
 * Lo que rige al pintar: lo que dijo el servidor o, si el reloj ya la volvió no reembolsable, lo
 * mismo leído en la pantalla. `undefined` si cancelar hoy no cuesta el total.
 */
export function nonRefundableAt(
  input: {
    readonly roompack: Pick<HotelRoompack, 'cancellation' | 'price' | 'pricing' | 'rooms'>;
    readonly nonRefundable?: PrebookNonRefundable;
  },
  nowMs: number,
): PrebookNonRefundable | undefined {
  if (input.nonRefundable !== undefined) return input.nonRefundable;
  const read = rateRefundability(input.roompack, nowMs);
  if (read.kind !== 'non_refundable') return undefined;
  const penalty = saleTotal(input.roompack);
  return read.fullPenaltySinceLocal === undefined
    ? { reason: 'declared', penalty }
    : {
        reason: 'full-penalty-in-force',
        penalty,
        fullPenaltySinceLocal: read.fullPenaltySinceLocal,
      };
}

/**
 * El 100 % sobre el precio de venta con el que se va a reservar (`acceptedTotal`). Si en el paso 2
 * se aceptó un precio nuevo, el monto de la casilla es ése y no el del PreBook: lo que se confirma es
 * lo que se descuenta.
 */
export function nonRefundableForTotal(
  nr: PrebookNonRefundable | undefined,
  total: Money,
): PrebookNonRefundable | undefined {
  return nr === undefined ? undefined : { ...nr, penalty: { ...total } };
}

/**
 * A qué monto corresponde una confirmación. Una casilla marcada para un monto no vale para otro: si
 * el 100 % cambia, hay que volver a confirmarlo.
 */
export function nonRefundableAckKey(nr: PrebookNonRefundable | undefined): string | undefined {
  return nr === undefined ? undefined : `${nr.penalty.amountMinor} ${nr.penalty.currency}`;
}

export interface NonRefundableNoticeView {
  readonly title: string;
  /** El 100 %, con su moneda: "321,34 US$". */
  readonly amount: string;
  readonly currency: string;
  /** La frase que acompaña al importe. */
  readonly lead: string;
  /** Qué significa para la agencia, en el orden en que le importa. */
  readonly points: readonly string[];
  /** Una reembolsable con el 100 % vigente: desde cuándo, en hora local del hotel. */
  readonly since?: string;
}

/** El aviso grande del paso 1 y del detalle de una orden. */
export function nonRefundableNoticeView(nr: PrebookNonRefundable): NonRefundableNoticeView {
  const amount = formatMoney(nr.penalty);
  return {
    title: 'Tarifa no reembolsable',
    amount,
    currency: nr.penalty.currency,
    lead: 'Si se cancela, se modifica o el pasajero no se presenta, se cobra el 100 %:',
    points: [
      'No se recupera: ni la agencia ni el cliente reciben un reembolso.',
      `Se descuenta de la cartera o del crédito de la agencia en ${nr.penalty.currency}.`,
      'La agencia responde ante su cliente por ese monto.',
    ],
    ...(nr.fullPenaltySinceLocal === undefined
      ? {}
      : {
          since: `El proveedor la vende como reembolsable, pero el cargo del 100 % rige desde el ${formatHotelLocalDateTime(nr.fullPenaltySinceLocal)} (hora local del hotel): se trata igual que una no reembolsable.`,
        }),
  };
}

/** El texto de la casilla obligatoria del checkout, con el monto exacto. */
export function nonRefundableAckLabel(nr: PrebookNonRefundable): string {
  return `Entiendo que esta tarifa no es reembolsable: si se cancela, modifica o el pasajero no se presenta, se cobra el 100 % (${formatMoney(nr.penalty)}).`;
}

/** Al lado de la casilla: lo que ya no se puede corregir después de reservar. */
export const NON_REFUNDABLE_REVIEW_REMINDER =
  'Antes de confirmar, revisá los nombres de los huéspedes y las fechas: un error se corrige cancelando, y cancelar cuesta el total.';
