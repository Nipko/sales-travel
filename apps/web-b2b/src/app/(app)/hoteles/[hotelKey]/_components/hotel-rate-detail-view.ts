import type { HotelCancellationRule, HotelRoompack, Money } from '../../actions';
import { formatHotelLocalDateTime, formatMoney } from '../../_components/hotel-format';
import { saleTotal } from '../../_components/hotel-rate-view';

/*
 * Lo que el detalle de un hotel suma a cada tarifa del listado (D-TBO-19 A): los tramos de la
 * política de cancelación y el precio por noche, "sujetos a confirmación" hasta el PreBook, y con
 * qué nombre figura el hotel en la reserva cuando lo vende otro proveedor (RF-34).
 *
 * Nada de esto muestra un importe NETO del proveedor. Los importes fijos de una penalidad y el
 * precio por noche llegan en neto; pintarlos le diría a una sub-agencia cuánto cuesta la tarifa al
 * consolidador (G3). Se muestran como proporción de la tarifa y, cuando se puede, sobre el precio
 * de VENTA, con un "≈" que dice que es una estimación.
 */

export interface PolicyTier {
  /** Desde cuándo rige el tramo. */
  readonly when: string;
  /** Qué se cobra si se cancela en el tramo. */
  readonly charge: string;
  /** Su equivalente estimado en el precio de VENTA ("≈ 260,00 US$"), cuando se puede calcular. */
  readonly approx?: string;
}

export interface RatePolicyView {
  readonly tiers: readonly PolicyTier[];
  /** Sólo el PreBook las da por definitivas: todo lo demás está sujeto a confirmación. */
  readonly provisional: boolean;
  /** Algún tramo está en hora local del hotel, que el proveedor no acompaña de zona. */
  readonly hotelLocalTime: boolean;
  /** Las dos aclaraciones anteriores en una frase, o nada. */
  readonly caption?: string;
  /** Notas del proveedor sobre la política, como texto. */
  readonly notes?: string;
}

const PERCENT = new Intl.NumberFormat('es', { maximumFractionDigits: 2 });

function percentText(value: number): string {
  return `${PERCENT.format(value)} %`;
}

function scaled(money: Money, ratio: number): Money {
  return { amountMinor: Math.round(money.amountMinor * ratio), currency: money.currency };
}

function roomSuffix(rule: HotelCancellationRule): string {
  return rule.roomIndex === undefined ? '' : ` de la habitación ${rule.roomIndex}`;
}

function whenOf(rule: HotelCancellationRule): string {
  if (rule.fromLocalDateTime) return `Desde el ${formatHotelLocalDateTime(rule.fromLocalDateTime)}`;
  const { fromHours: from, toHours: to } = rule;
  if (from !== undefined && to !== undefined) {
    return `Con ${Math.min(from, to)} a ${Math.max(from, to)} h de anticipación`;
  }
  if (from !== undefined) return `Con ${from} h o más de anticipación`;
  if (to !== undefined) return `Con menos de ${to} h de anticipación`;
  return 'Desde la reserva';
}

/**
 * Qué se cobra en un tramo, sin mostrar neto:
 * - Un porcentaje, tal cual; sobre toda la reserva, además, su equivalente en el precio de venta.
 * - Noches, tal cual.
 * - Un importe fijo, como proporción del neto de la tarifa y su equivalente en el precio de venta.
 */
function chargeOf(
  rule: HotelCancellationRule,
  pack: Pick<HotelRoompack, 'price' | 'pricing'>,
): Pick<PolicyTier, 'charge' | 'approx'> {
  const sale = saleTotal(pack);
  const pct = rule.penaltyPercentage;
  if (pct !== undefined) {
    if (pct === 0) return { charge: 'Sin cargo' };
    if (rule.roomIndex !== undefined) return { charge: `${percentText(pct)}${roomSuffix(rule)}` };
    return {
      charge: `${percentText(pct)} del total`,
      approx: `≈ ${formatMoney(scaled(sale, pct / 100))}`,
    };
  }
  const nights = rule.penaltyNights;
  if (nights !== undefined) {
    if (nights === 0) return { charge: 'Sin cargo' };
    return { charge: `${nights} noche${nights === 1 ? '' : 's'}${roomSuffix(rule)}` };
  }
  const amount = rule.penaltyAmount;
  if (amount !== undefined) {
    if (amount.amountMinor === 0) return { charge: 'Sin cargo' };
    const net = pack.price.total;
    if (amount.currency !== net.currency || net.amountMinor <= 0) return { charge: 'Con cargo' };
    const ratio = Math.min(1, amount.amountMinor / net.amountMinor);
    const room = rule.roomIndex === undefined ? '' : ` · habitación ${rule.roomIndex}`;
    return {
      charge: `≈ ${percentText(Math.round(ratio * 100))} del total${room}`,
      approx: `≈ ${formatMoney(scaled(sale, ratio))}`,
    };
  }
  return { charge: 'Con cargo' };
}

/**
 * Los tramos de la política de una tarifa, en el orden en que los dio el proveedor. `undefined`
 * si no hay tramos ni notas: entonces alcanza con lo que ya dice la fila (reembolsable o no y,
 * sin tramos, "plazos a confirmar").
 */
export function ratePolicyView(
  pack: Pick<HotelRoompack, 'cancellation' | 'price' | 'pricing'>,
): RatePolicyView | undefined {
  const c = pack.cancellation;
  const notes = c.vendorNotes?.trim();
  if (c.rules.length === 0 && !notes) return undefined;
  const provisional = c.policySource !== 'prebook-final';
  const hotelLocalTime = c.rules.some((r) => !!r.fromLocalDateTime);
  const caption = [
    provisional ? 'sujeta a confirmación' : undefined,
    hotelLocalTime ? 'hora local del hotel' : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  return {
    tiers: c.rules.map((rule) => ({ when: whenOf(rule), ...chargeOf(rule, pack) })),
    provisional,
    hotelLocalTime,
    ...(caption ? { caption: caption.charAt(0).toUpperCase() + caption.slice(1) } : {}),
    ...(notes ? { notes } : {}),
  };
}

// ───────────────────────── Precio por noche ─────────────────────────

export interface NightPrice {
  /** Fecha de la noche ("vie, 12 oct"). */
  readonly label: string;
  readonly amount: Money;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function nightLabel(checkinDate: string, index: number): string | undefined {
  const m = DATE_RE.exec(checkinDate);
  if (!m) return undefined;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + index));
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('es', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
    .format(date)
    .replace(/\./g, '');
}

/**
 * El precio de VENTA repartido por noche según el desglose del proveedor (`price.nightly`, por
 * habitación y noche, en neto): cada noche pesa lo que pesa en el neto, y las partes suman
 * exactamente el precio de venta. `undefined` si no hay desglose o no cuadra con la estadía —
 * habitaciones con distinta cantidad de noches, otra moneda, otra cantidad de noches—: un reparto
 * sobre datos que no cierran sería inventado.
 */
export function nightlySale(
  pack: Pick<HotelRoompack, 'price' | 'pricing'>,
  checkinDate: string,
  nights: number,
): NightPrice[] | undefined {
  const nightly = pack.price.nightly;
  if (nightly === undefined || nightly.length === 0) return undefined;
  const length = nightly[0]?.length ?? 0;
  if (length === 0 || length !== nights || nightly.some((room) => room.length !== length)) {
    return undefined;
  }
  const currency = pack.price.total.currency;
  if (nightly.some((room) => room.some((n) => n.currency !== currency))) return undefined;

  const perNight = Array.from({ length }, (_, n) =>
    nightly.reduce((sum, room) => sum + (room[n]?.amountMinor ?? 0), 0),
  );
  const weight = perNight.reduce((a, b) => a + b, 0);
  if (weight <= 0 || perNight.some((v) => v < 0)) return undefined;

  // Mayor resto: los centavos que el redondeo hacia abajo deja sueltos van a las noches con la
  // parte decimal más grande, así la suma es el precio de venta y no uno parecido.
  const sale = saleTotal(pack);
  const exact = perNight.map((v) => (sale.amountMinor * v) / weight);
  const floors = exact.map(Math.floor);
  let left = sale.amountMinor - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }

  const out: NightPrice[] = [];
  for (let n = 0; n < length; n += 1) {
    const label = nightLabel(checkinDate, n);
    if (label === undefined) return undefined;
    out.push({ label, amount: { amountMinor: floors[n] ?? 0, currency: sale.currency } });
  }
  return out;
}

/** Todas las noches valen lo mismo: se dice una vez y no se lista. */
export function uniformNightPrice(nights: readonly NightPrice[]): Money | undefined {
  const [first] = nights;
  if (first === undefined) return undefined;
  const spread = nights.every(
    (n) => Math.abs(n.amount.amountMinor - first.amount.amountMinor) <= 1,
  );
  return spread ? first.amount : undefined;
}

// ───────────────────────── Con qué nombre se reserva ─────────────────────────

export interface HotelFacts {
  readonly name?: string;
  readonly address?: string;
}

function normalized(text: string | undefined): string | undefined {
  const t = text
    ?.normalize('NFD')
    // Rango de marcas diacríticas combinantes, escapado como en `lib/airports.ts`: escrito literal
    // son caracteres invisibles que un reencode del fichero rompe sin que se note.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
  return t ? t : undefined;
}

/**
 * El nombre y la dirección con que figura el hotel en la reserva de una tarifa, cuando no son los
 * del encabezado: en una tarjeta agrupada, la ficha es de un proveedor y la tarifa puede ser de
 * otro, y en el detalle, el PreBook y el voucher manda el proveedor que VENDE (docs/tbo/05 §4).
 * No nombra al proveedor: eso lo decide la divulgación (RF-40).
 */
export function sellingHotelNote(
  seller: HotelFacts | undefined,
  shown: HotelFacts | undefined,
): string | undefined {
  if (seller === undefined || shown === undefined) return undefined;
  const differs = (a: string | undefined, b: string | undefined) => {
    const na = normalized(a);
    const nb = normalized(b);
    return na !== undefined && nb !== undefined && na !== nb;
  };
  if (!differs(seller.name, shown.name) && !differs(seller.address, shown.address)) {
    return undefined;
  }
  const name = seller.name ?? shown.name;
  const where = seller.address ? `, ${seller.address}` : '';
  return name
    ? `En la reserva figura como «${name}»${where}.`
    : `En la reserva figura en ${seller.address}.`;
}
