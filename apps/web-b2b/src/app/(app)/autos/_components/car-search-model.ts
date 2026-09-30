import { formatDayShort } from '../../../../components/ui/date-range-picker';
import type { CarLocation, CarSearchValues, PaymentType } from '../actions';

/*
 * El formulario de búsqueda de autos, sin React: los horarios que se ofrecen, cómo se arma el
 * pedido a partir de lo elegido (aeropuerto por IATA, ciudad por coordenadas) y cómo se resume lo
 * que se buscó en la barra de arriba de los resultados.
 */

/** Horarios cada media hora: así los manejan los mostradores de las arrendadoras. */
export const HOUR_SLOTS: readonly string[] = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, '0');
  return `${h}:${i % 2 === 0 ? '00' : '30'}`;
});

export const DEFAULT_HOUR = '10:00';

export interface CarSearchDraft {
  readonly pickup: CarLocation | null;
  readonly dropoff: CarLocation | null;
  /** Devolver en otro lugar que el de recogida. */
  readonly otherDropoff: boolean;
  readonly pickUpDate: string;
  readonly dropOffDate: string;
  readonly pickUpTime: string;
  readonly dropOffTime: string;
  readonly paymentType: PaymentType;
  readonly rateType: string;
}

export type SearchField = 'pickup' | 'dropoff' | 'pickUpDate' | 'dropOffDate' | 'pickUpTime';

export type BuiltSearch =
  | { readonly ok: true; readonly values: CarSearchValues }
  | { readonly ok: false; readonly field: SearchField; readonly error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fecha y hora de "ahora" en el lugar de recogida: el auto se retira con el reloj de ese mostrador,
 * no con el del vendedor. Sin zona válida, la del navegador.
 */
export function nowAt(now: Date, timeZone?: string): { date: string; time: string } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now);
      const get = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === type)?.value ?? '';
      return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${get('hour')}:${get('minute')}`,
      };
    } catch {
      // Zona desconocida para este navegador: se usa la local.
    }
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

/**
 * El pedido de búsqueda a partir del formulario, o el primer problema con el campo al que llevar
 * el foco. Un lugar con IATA va por su código; uno sin IATA (una ciudad) va como "City"/"City2"
 * con sus coordenadas, que es como AgentCars lo pide.
 */
export function buildSearchValues(draft: CarSearchDraft, now: Date = new Date()): BuiltSearch {
  const { pickup } = draft;
  if (!pickup) {
    return { ok: false, field: 'pickup', error: 'Elige el lugar de recogida de la lista.' };
  }
  const dropLoc = draft.otherDropoff ? draft.dropoff : pickup;
  if (!dropLoc) {
    return { ok: false, field: 'dropoff', error: 'Elige el lugar de devolución de la lista.' };
  }
  if (!DATE_RE.test(draft.pickUpDate)) {
    return { ok: false, field: 'pickUpDate', error: 'Elige la fecha de recogida.' };
  }
  if (!DATE_RE.test(draft.dropOffDate)) {
    return { ok: false, field: 'dropOffDate', error: 'Elige la fecha de devolución.' };
  }
  const here = nowAt(now, pickup.timezone);
  if (draft.pickUpDate < here.date) {
    return { ok: false, field: 'pickUpDate', error: 'La recogida no puede ser anterior a hoy.' };
  }
  if (draft.pickUpDate === here.date && draft.pickUpTime <= here.time) {
    return { ok: false, field: 'pickUpTime', error: 'Esa hora de recogida ya pasó.' };
  }
  if (`${draft.dropOffDate}T${draft.dropOffTime}` <= `${draft.pickUpDate}T${draft.pickUpTime}`) {
    return {
      ok: false,
      field: 'dropOffDate',
      error: 'La devolución tiene que ser después de la recogida.',
    };
  }

  const country = pickup.countryCode.trim().toUpperCase();
  const pickUpLocation = pickup.iata ?? 'City';
  const dropOffLocation = draft.otherDropoff ? (dropLoc.iata ?? 'City2') : pickUpLocation;
  const values: CarSearchValues = {
    pickUpLocation,
    dropOffLocation,
    country,
    pickUpDate: draft.pickUpDate,
    dropOffDate: draft.dropOffDate,
    pickUpHour: draft.pickUpTime,
    dropOffHour: draft.dropOffTime,
    rateType: draft.rateType || 'best',
    paymentType: draft.paymentType,
  };
  if (pickUpLocation === 'City') {
    values.lat = pickup.latitude;
    values.lng = pickup.longitude;
  }
  if (dropOffLocation === 'City2') {
    values.latDropOff = dropLoc.latitude;
    values.lngDropOff = dropLoc.longitude;
  }
  return { ok: true, values };
}

/** "10:00" o "1000" → minutos desde la medianoche. */
function minutesOf(hour: string): number {
  const digits = hour.replace(/\D/g, '').padStart(4, '0');
  return Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

/**
 * Días de alquiler: períodos de 24 h desde la hora de recogida, redondeando hacia arriba, como
 * cobran las arrendadoras (del 22 a las 10:00 al 29 a las 11:00 son 8 días). Mínimo uno.
 */
export function rentalDays(
  v: Pick<CarSearchValues, 'pickUpDate' | 'dropOffDate' | 'pickUpHour' | 'dropOffHour'>,
): number {
  const minutes =
    (dayNumber(v.dropOffDate) - dayNumber(v.pickUpDate)) * 1440 +
    minutesOf(v.dropOffHour) -
    minutesOf(v.pickUpHour);
  if (!Number.isFinite(minutes)) return 1;
  return Math.max(1, Math.ceil(minutes / 1440));
}

export function daysLabel(days: number): string {
  return `${days} ${days === 1 ? 'día' : 'días'}`;
}

/** "10:00" a partir de "1000" o "10:00". */
export function hourLabel(hour: string): string {
  const digits = hour.replace(/\D/g, '').padStart(4, '0');
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

/** "jue 22 oct · 10:00" */
export function whenLabel(date: string, hour: string): string {
  return `${formatDayShort(date)} · ${hourLabel(hour)}`;
}

/** "Aeropuerto El Dorado (BOG)": el primer tramo del nombre, con el código si lo tiene. */
export function placeLabel(loc: Pick<CarLocation, 'value' | 'iata'>): string {
  const name = loc.value.split(',')[0]?.trim() || loc.value.trim();
  return loc.iata ? `${name} (${loc.iata})` : name;
}

export const PAYMENT_LABELS: Readonly<Record<PaymentType, string>> = {
  ppd: 'Prepago',
  pod: 'Pago en destino',
};

/** Lo que se buscó, con los lugares elegidos: para la barra de arriba de los resultados. */
export interface CarSearchCriteria {
  readonly values: CarSearchValues;
  readonly pickup: CarLocation;
  /** Sólo si se devuelve en otro lugar. */
  readonly dropoff?: CarLocation;
}

export interface SearchSummaryView {
  readonly place: string;
  /** El lugar de devolución, sólo si es otro. */
  readonly dropoffPlace?: string;
  readonly pickUp: string;
  readonly dropOff: string;
  readonly days: string;
  readonly payment: string;
}

export function searchSummaryView(c: CarSearchCriteria): SearchSummaryView {
  const v = c.values;
  return {
    place: placeLabel(c.pickup),
    ...(c.dropoff ? { dropoffPlace: placeLabel(c.dropoff) } : {}),
    pickUp: whenLabel(v.pickUpDate, v.pickUpHour),
    dropOff: whenLabel(v.dropOffDate, v.dropOffHour),
    days: daysLabel(rentalDays(v)),
    payment: PAYMENT_LABELS[v.paymentType ?? 'ppd'],
  };
}
