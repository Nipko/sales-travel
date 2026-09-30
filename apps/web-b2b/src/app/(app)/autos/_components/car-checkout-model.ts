import { addDays } from '../../../../components/ui/date-range-picker';
import type {
  BookingStatus,
  CarRateDetail,
  CarSearchValues,
  CarSelection,
  Money,
  PaymentType,
} from '../actions';
import { saleOf } from './car-format';
import { hourLabel, nowAt, whenLabel } from './car-search-model';

/*
 * El paso de conductor y confirmación de un auto, sin React: cuánto le queda a la tarifa elegida,
 * qué se valida del conductor y cómo se reparte el precio entre lo que se paga al reservar y lo que
 * se paga en el mostrador.
 */

/** La selección (`uniqid`) vale 15 minutos: después AgentCars ya no confirma con esa tarifa. */
export const SESSION_TTL_MS = 15 * 60_000;
/** Desde acá la cuenta regresiva se pinta como aviso. */
const SESSION_WARNING_MS = 2 * 60_000;

export type SessionTone = 'ok' | 'warning' | 'expired';

export function sessionRemainingMs(selectedAt: number, now: number): number {
  return Math.max(0, selectedAt + SESSION_TTL_MS - now);
}

export function sessionTone(remainingMs: number): SessionTone {
  if (remainingMs <= 0) return 'expired';
  return remainingMs <= SESSION_WARNING_MS ? 'warning' : 'ok';
}

/** "14:05": minutos y segundos, redondeando hacia arriba para no mostrar 0:00 con tiempo. */
export function countdownLabel(remainingMs: number): string {
  const total = Math.ceil(Math.max(0, remainingMs) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ───────────────────────── Conductor ─────────────────────────

export interface DriverDraft {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  /** Como se tipeó: el campo es texto numérico para no perder un valor a medio escribir. */
  readonly age: string;
}

export type DriverField = keyof DriverDraft;

export const MIN_DRIVER_AGE = 18;
export const MAX_DRIVER_AGE = 99;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Lo que falta o está mal, por campo. Vacío: se puede confirmar. */
export function checkDriver(d: DriverDraft): Partial<Record<DriverField, string>> {
  const issues: Partial<Record<DriverField, string>> = {};
  if (!d.firstName.trim()) issues.firstName = 'Escribe el nombre del conductor.';
  if (!d.lastName.trim()) {
    issues.lastName = 'Escribe el apellido: con él se consulta y se cancela la reserva.';
  }
  if (!EMAIL_RE.test(d.email.trim())) issues.email = 'Escribe un correo válido.';
  const age = Number(d.age);
  if (!/^\d{1,2}$/.test(d.age.trim()) || age < MIN_DRIVER_AGE || age > MAX_DRIVER_AGE) {
    issues.age = `La edad va de ${MIN_DRIVER_AGE} a ${MAX_DRIVER_AGE} años.`;
  }
  return issues;
}

/**
 * Edad con recargo en la mayoría de las arrendadoras. Es un aviso, no una regla: el cargo exacto lo
 * informa el mostrador y a veces el voucher.
 */
export function youngDriver(age: string): boolean {
  const n = Number(age);
  return Number.isFinite(n) && n >= MIN_DRIVER_AGE && n < 25;
}

// ───────────────────────── Precio ─────────────────────────

export interface CounterCharge {
  readonly name: string;
  readonly amount: Money;
}

export interface PriceBreakdown {
  /** Precio de venta total. */
  readonly sale: Money;
  /** Prepago: lo que se cobra al reservar (venta menos lo del mostrador). */
  readonly payNow?: Money;
  /** Prepago: impuestos y cargos que el cliente paga en el mostrador al retirar el auto. */
  readonly atCounter?: Money;
  readonly counterCharges: readonly CounterCharge[];
  /** Lo que la agencia paga, sólo si hay reglas de precio. */
  readonly cost?: Money;
  /** El margen PROPIO de la agencia, sólo si es mayor que cero. */
  readonly ownMargin?: Money;
}

/**
 * El reparto del precio que puede ver la agencia.
 *
 * Las mismas reglas que vuelos y hoteles (`sale-breakdown.ts`): el neto del proveedor no se enseña
 * —para una sub-agencia, costo menos neto es lo que gana el consolidador—, y lo que se paga en el
 * mostrador pasa tal cual porque lo cobra la arrendadora; el markup se absorbe en lo que se paga al
 * reservar. En pago en destino todo se paga en el mostrador y no hay reparto que mostrar.
 */
export function priceBreakdown(
  selection: Pick<CarSelection, 'pricing' | 'rateAmount' | 'tax'>,
  detail: CarRateDetail | null,
  paymentType: PaymentType,
): PriceBreakdown {
  const sale = saleOf(selection);
  const pricing = selection.pricing;
  const extras = {
    ...(pricing ? { cost: { amountMinor: pricing.costMinor, currency: pricing.currency } } : {}),
    ...(pricing && pricing.ownMarkupMinor > 0
      ? { ownMargin: { amountMinor: pricing.ownMarkupMinor, currency: pricing.currency } }
      : {}),
  };
  if (paymentType === 'pod') return { sale, counterCharges: [], ...extras };

  const counter = detail?.tax ?? selection.tax;
  const counterMinor =
    counter.currency === sale.currency
      ? Math.min(Math.max(0, counter.amountMinor), sale.amountMinor)
      : 0;
  if (counterMinor === 0) return { sale, counterCharges: [], ...extras };
  return {
    sale,
    payNow: { amountMinor: sale.amountMinor - counterMinor, currency: sale.currency },
    atCounter: { amountMinor: counterMinor, currency: sale.currency },
    counterCharges: (detail?.charges ?? [])
      .filter((c) => c.name.trim() && c.amount.amountMinor > 0)
      .map((c) => ({ name: c.name.trim(), amount: c.amount })),
    ...extras,
  };
}

// ───────────────────────── Reserva en espera ─────────────────────────

/** ON HOLD se activa hasta 48 h antes del retiro; si no, AgentCars la cancela sola. */
const HOLD_LEAD_MINUTES = 48 * 60;

function minutesSinceEpochDay(date: string, hour: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const digits = hour.replace(/\D/g, '').padStart(4, '0');
  const day = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000;
  return day * 1440 + Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
}

/** ¿Queda margen para una reserva en espera? Con menos de 48 h al retiro no tiene sentido. */
export function canHold(
  v: Pick<CarSearchValues, 'pickUpDate' | 'pickUpHour'>,
  now: Date,
  timeZone?: string,
): boolean {
  const here = nowAt(now, timeZone);
  return (
    minutesSinceEpochDay(v.pickUpDate, v.pickUpHour) - minutesSinceEpochDay(here.date, here.time) >
    HOLD_LEAD_MINUTES
  );
}

/** Hasta cuándo se puede activar una reserva en espera: "mar 20 oct · 10:00". */
export function holdDeadlineLabel(v: Pick<CarSearchValues, 'pickUpDate' | 'pickUpHour'>): string {
  return whenLabel(addDays(v.pickUpDate, -2), hourLabel(v.pickUpHour));
}

// ───────────────────────── Resultado de la reserva ─────────────────────────

export interface BookingStatusView {
  readonly title: string;
  readonly tone: 'success' | 'warning';
  readonly note: string;
}

export function bookingStatusView(
  status: BookingStatus,
  paymentType: PaymentType,
  holdDeadline: string,
): BookingStatusView {
  switch (status) {
    case 'on_hold':
      return {
        title: 'Reserva en espera',
        tone: 'warning',
        note: `Actívala desde «Gestionar reserva» antes del ${holdDeadline} o AgentCars la cancela sola.`,
      };
    case 'on_request':
      return {
        title: 'Reserva a confirmar',
        tone: 'warning',
        note: 'La arrendadora tiene que confirmar la disponibilidad. Consulta el estado desde «Gestionar reserva» antes de avisarle al cliente.',
      };
    default:
      return {
        title: 'Reserva confirmada',
        tone: 'success',
        note:
          paymentType === 'ppd'
            ? 'El voucher tiene el número que el cliente presenta en el mostrador: compártelo desde «Ver voucher».'
            : 'El cliente paga el total en el mostrador al retirar el auto.',
      };
  }
}
