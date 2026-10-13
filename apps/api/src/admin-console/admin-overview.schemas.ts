import { z } from '@sales-travel/validation';
import { InvalidOverviewPeriodError } from './admin-console.errors.js';

/**
 * El borde de Plataforma → Resumen: qué período y qué parte de la red se mira. Sin I/O.
 *
 * Los días son días calendario de {@link PLATFORM_TIME_ZONE}: Planetour opera desde Colombia, y un
 * "hoy" en UTC cortaría el día a las 19:00 de Bogotá.
 */

export const PLATFORM_TIME_ZONE = 'America/Bogota';

/** Sin período, los últimos 30 días contando hoy. */
export const OVERVIEW_DEFAULT_DAYS = 30;
/** Un año (bisiesto incluido): más largo, la lectura recorre la red entera para poco. */
export const OVERVIEW_MAX_DAYS = 366;
/** La tendencia: los 12 meses calendario que terminan en el mes de `to`. */
export const OVERVIEW_TREND_MONTHS = 12;
/** Los nodos que más vendieron. */
export const OVERVIEW_TOP_NODES = 10;
/**
 * Hasta dónde mira atrás un contador que no tiene "resuelto": las divergencias de conciliación y las
 * invitaciones vencidas de hace más ya no son una tarea.
 */
export const OVERVIEW_RECENT_DAYS = 30;
/** Las corridas de conciliación que se miran: la conciliación es diaria, una semana alcanza. */
export const OVERVIEW_RECONCILIATION_RUN_DAYS = 7;

/**
 * Los años que se pueden pedir. Fuera de ellos no hay ventas que leer, y en los bordes del
 * calendario de JS el período se rompería en silencio: `Date.UTC` lee los años 0-99 como 1900-1999
 * y un día después del año 9999 deja de ser `AAAA-MM-DD`.
 */
export const OVERVIEW_MIN_YEAR = 2000;
export const OVERVIEW_MAX_YEAR = 2100;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** ¿`AAAA-MM-DD` es un día que existe? (`2026-02-30` no). */
export function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function inYearRange(value: string): boolean {
  const year = Number(value.slice(0, 4));
  return year >= OVERVIEW_MIN_YEAR && year <= OVERVIEW_MAX_YEAR;
}

const CalendarDate = z
  .string()
  .regex(ISO_DATE, { message: 'la fecha va como AAAA-MM-DD' })
  .refine(inYearRange, {
    message: `la fecha tiene que caer entre ${OVERVIEW_MIN_YEAR} y ${OVERVIEW_MAX_YEAR}`,
  })
  .refine(isCalendarDate, { message: 'esa fecha no existe' });

const Uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/**
 * `GET /admin/overview`. Estricto: el BFF reconstruye la query parámetro por parámetro, así que un
 * campo de más es un error de programación y no un filtro que se ignora en silencio.
 *
 * - `from` y `to`: el período, días incluidos. Sin ellos, los últimos {@link OVERVIEW_DEFAULT_DAYS}
 *   días hasta hoy; con uno solo, el otro se completa con el mismo largo.
 * - `tenantId`: el subárbol de ese nodo (un consolidador y su red). Sin él, toda la red.
 */
export const AdminOverviewQuerySchema = z
  .object({
    from: CalendarDate.optional(),
    to: CalendarDate.optional(),
    tenantId: Uuid.optional(),
  })
  .strict();
export type AdminOverviewQuery = z.infer<typeof AdminOverviewQuerySchema>;

/** Días calendario, ambos incluidos. */
export interface OverviewPeriod {
  readonly from: string;
  readonly to: string;
}

function toUtcMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `date` corrido `days` días (negativo, hacia atrás). */
export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Cuántos días tiene el período, ambos extremos incluidos. */
export function periodDays(period: OverviewPeriod): number {
  return Math.round((toUtcMs(period.to) - toUtcMs(period.from)) / DAY_MS) + 1;
}

/** El día calendario de `now` en `timeZone`, como `AAAA-MM-DD`. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * El período que se lee: el que pidieron, completado con el largo por defecto. Al revés o más largo
 * que {@link OVERVIEW_MAX_DAYS}, 400.
 */
export function resolveOverviewPeriod(
  query: Pick<AdminOverviewQuery, 'from' | 'to'>,
  now: Date,
): OverviewPeriod {
  const span = OVERVIEW_DEFAULT_DAYS - 1;
  let { from, to } = query;
  if (to === undefined) {
    to = from === undefined ? todayIn(PLATFORM_TIME_ZONE, now) : addDays(from, span);
  }
  from ??= addDays(to, -span);

  const period = { from, to };
  if (from > to) {
    throw new InvalidOverviewPeriodError(
      'El período empieza después de terminar: revisa las fechas "desde" y "hasta".',
    );
  }
  if (periodDays(period) > OVERVIEW_MAX_DAYS) {
    throw new InvalidOverviewPeriodError(
      `El período puede tener hasta ${OVERVIEW_MAX_DAYS} días: acórtalo.`,
    );
  }
  return period;
}

/** Los `count` meses calendario (`AAAA-MM`) que terminan en el mes de `to`, del más viejo al más nuevo. */
export function trendMonths(to: string, count: number = OVERVIEW_TREND_MONTHS): string[] {
  const [year, month] = to.split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}
