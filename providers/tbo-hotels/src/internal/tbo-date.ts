/**
 * Los tres formatos de fecha del contrato de TBO, y ninguno lleva zona horaria:
 *
 * - `YYYY-MM-DD` en `CheckIn`/`CheckOut` (p. 10) y en `FromDate`/`ToDate` de
 *   BookingDetailsbasedondate (p. 62). BookingDetail declara el mismo formato pero el ejemplo trae
 *   `2021-10-16T00:00:00` (p. 45, 49; docs/tbo/04 PV-03).
 * - `DD-MM-YYYY HH:mm:ss` en `CancelPolicies[].FromDate`. El orden día-mes sale de
 *   `15-10-2021 00:00:00` (p. 50): no hay mes 15 (docs/tbo/02 §9.6).
 * - `DD-MMM-YYYY` en BookingDetailsbasedondate (`10-Nov-2023`, p. 63-64), con meses en inglés.
 *
 * Todo se devuelve como fecha o fecha-hora LOCAL sin offset. La zona no está documentada (Q-24) y
 * el único indicio es "the cancellation policy is based on the hotel's time" (p. 51): inventar un
 * offset convertiría un dato desconocido en uno falso. Un texto ilegible da `undefined`.
 */

const MONTHS_EN: readonly string[] = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Aritmética de calendario explícita: `Date` corrige el 31 de abril a 1 de mayo sin avisar. */
function isCalendarDate(year: number, month: number, day: number): boolean {
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function isClockTime(hours: number, minutes: number, seconds: number): boolean {
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ¿Es `YYYY-MM-DD` y una fecha que existe? Para validar lo que sale en un request. */
export function isTboIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  return isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Fecha de una respuesta: `YYYY-MM-DD`, o con una hora detrás como en el ejemplo de BookingDetail.
 * Sólo se toma la fecha si el resto tiene forma de hora: `2021-07-1317T00:00:00` (p. 45) no es una
 * fecha con basura al final, es una fecha rota.
 */
export function parseTboResponseDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.exec(raw);
  const date = match?.[1];
  return date !== undefined && isTboIsoDate(date) ? date : undefined;
}

/** `DD-MM-YYYY HH:mm:ss` → `YYYY-MM-DDTHH:mm:ss`, local y sin offset. */
export function parseTboCancelPolicyDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (match === null) return undefined;
  const [day, month, year, hours, minutes, seconds] = match.slice(1).map(Number);
  if (
    day === undefined ||
    month === undefined ||
    year === undefined ||
    hours === undefined ||
    minutes === undefined ||
    seconds === undefined ||
    !isCalendarDate(year, month, day) ||
    !isClockTime(hours, minutes, seconds)
  ) {
    return undefined;
  }
  const time = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
  return `${isoDate(year, month, day)}T${time}`;
}

/**
 * `DD-MMM-YYYY` → `YYYY-MM-DD`. Los meses se comparan contra una tabla fija en inglés y sin
 * distinguir mayúsculas, no con `Date.parse`, cuyo resultado depende del runtime (docs/tbo/04 PV-30).
 */
export function parseTboDayMonthNameDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
  if (match === null) return undefined;
  const monthIndex = MONTHS_EN.indexOf((match[2] ?? '').toLowerCase());
  const day = Number(match[1]);
  const year = Number(match[3]);
  const month = monthIndex + 1;
  if (monthIndex < 0 || !isCalendarDate(year, month, day)) return undefined;
  return isoDate(year, month, day);
}
