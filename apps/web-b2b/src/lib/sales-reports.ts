import { csvDecimal, toCsv, type CsvValue } from './csv';
import { currencyDecimals, formatMoney } from './flight-format';
import { isCurrencyCode } from './wallets';

/*
 * Reportes de ventas de la agencia y las ventas del mes de Inicio (`/reports/*` del API). Sin I/O.
 *
 * Todo monto viaja con su moneda y en centésimas (`Money.fromMajor`). Nunca se suman monedas
 * distintas: cada moneda tiene su resumen, su serie de meses y sus vendedores.
 */

export type SalesVerticalCode = 'flights' | 'hotels' | 'cars' | 'assistance';

const VERTICAL_NAMES: Readonly<Record<SalesVerticalCode, string>> = {
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
  assistance: 'Asistencias',
};

function isVerticalCode(value: string): value is SalesVerticalCode {
  return Object.hasOwn(VERTICAL_NAMES, value);
}

/** "Vuelos", "Hoteles"… Una vertical que la web no conoce se muestra con su código. */
export function salesVerticalName(code: string): string {
  return isVerticalCode(code) ? VERTICAL_NAMES[code] : code;
}

export interface SalesVerticalMetric {
  readonly vertical: string;
  readonly currency: string;
  readonly totalAmountMinor: number;
  readonly count: number;
}

export interface SalesMonthlyTrend {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly count: number;
}

export interface TopPerformer {
  readonly userId: string;
  readonly name: string;
  readonly currency: string;
  readonly salesMinor: number;
  readonly count: number;
}

export interface SalesPeriod {
  /** Primer mes (`YYYY-MM`). */
  readonly from: string;
  /** Último mes, el en curso (`YYYY-MM`). */
  readonly to: string;
}

export interface SalesMetrics {
  readonly period: SalesPeriod;
  readonly byVertical: readonly SalesVerticalMetric[];
  readonly monthlyTrend: readonly SalesMonthlyTrend[];
  readonly topPerformers: readonly TopPerformer[];
}

export interface CurrencyAmount {
  readonly currency: string;
  readonly amountMinor: number;
}

export interface DashboardKpis {
  readonly quotationsThisMonth: number;
  readonly confirmedThisMonth: number;
  readonly activeCustomers: number;
  /** Una entrada por moneda; vacío si no hubo ventas este mes. */
  readonly salesThisMonth: readonly CurrencyAmount[];
}

// ─────────────────────────── Lectura de la respuesta ───────────────────────────

const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMonth(value: unknown): value is string {
  return typeof value === 'string' && ISO_MONTH.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Todos los elementos o nada: una fila que no se entiende no se dibuja como si fuera un cero. */
function listOf<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseVertical(value: unknown): SalesVerticalMetric | undefined {
  const r = asRecord(value);
  if (
    !r ||
    !isText(r['vertical']) ||
    !isCurrencyCode(r['currency']) ||
    !isCount(r['totalAmountMinor']) ||
    !isCount(r['count'])
  ) {
    return undefined;
  }
  return {
    vertical: r['vertical'],
    currency: r['currency'],
    totalAmountMinor: r['totalAmountMinor'],
    count: r['count'],
  };
}

function parseMonth(value: unknown): SalesMonthlyTrend | undefined {
  const r = asRecord(value);
  if (
    !r ||
    !isMonth(r['month']) ||
    !isCurrencyCode(r['currency']) ||
    !isCount(r['amountMinor']) ||
    !isCount(r['count'])
  ) {
    return undefined;
  }
  return {
    month: r['month'],
    currency: r['currency'],
    amountMinor: r['amountMinor'],
    count: r['count'],
  };
}

function parsePerformer(value: unknown): TopPerformer | undefined {
  const r = asRecord(value);
  if (
    !r ||
    !isText(r['userId']) ||
    !isText(r['name']) ||
    !isCurrencyCode(r['currency']) ||
    !isCount(r['salesMinor']) ||
    !isCount(r['count'])
  ) {
    return undefined;
  }
  return {
    userId: r['userId'],
    name: r['name'],
    currency: r['currency'],
    salesMinor: r['salesMinor'],
    count: r['count'],
  };
}

/** La respuesta de `GET /reports/sales-metrics`, o `undefined` si no tiene la forma esperada. */
export function parseSalesMetrics(value: unknown): SalesMetrics | undefined {
  const r = asRecord(value);
  const period = asRecord(r?.['period']);
  if (!r || !period || !isMonth(period['from']) || !isMonth(period['to'])) return undefined;
  if (period['from'] > period['to']) return undefined;
  const byVertical = listOf(r['byVertical'], parseVertical);
  const monthlyTrend = listOf(r['monthlyTrend'], parseMonth);
  const topPerformers = listOf(r['topPerformers'], parsePerformer);
  if (!byVertical || !monthlyTrend || !topPerformers) return undefined;
  return {
    period: { from: period['from'], to: period['to'] },
    byVertical,
    monthlyTrend,
    topPerformers,
  };
}

function parseCurrencyAmount(value: unknown): CurrencyAmount | undefined {
  const r = asRecord(value);
  if (!r || !isCurrencyCode(r['currency']) || !isCount(r['amountMinor'])) return undefined;
  return { currency: r['currency'], amountMinor: r['amountMinor'] };
}

/** La respuesta de `GET /reports/dashboard`, o `undefined` si no tiene la forma esperada. */
export function parseDashboardKpis(value: unknown): DashboardKpis | undefined {
  const r = asRecord(value);
  if (
    !r ||
    !isCount(r['quotationsThisMonth']) ||
    !isCount(r['confirmedThisMonth']) ||
    !isCount(r['activeCustomers'])
  ) {
    return undefined;
  }
  const salesThisMonth = listOf(r['salesThisMonth'], parseCurrencyAmount);
  if (!salesThisMonth) return undefined;
  return {
    quotationsThisMonth: r['quotationsThisMonth'],
    confirmedThisMonth: r['confirmedThisMonth'],
    activeCustomers: r['activeCustomers'],
    salesThisMonth,
  };
}

// ─────────────────────────── Por moneda ───────────────────────────

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface CurrencySummary {
  readonly currency: string;
  readonly amountMinor: number;
  readonly count: number;
  /** En centésimas, redondeado. `null` sin reservas. */
  readonly averageMinor: number | null;
}

/** Lo confirmado del período en cada moneda: la que más reservas tuvo primero. */
export function currencySummaries(metrics: SalesMetrics): CurrencySummary[] {
  const totals = new Map<string, { amountMinor: number; count: number }>();
  for (const row of metrics.byVertical) {
    const current = totals.get(row.currency) ?? { amountMinor: 0, count: 0 };
    current.amountMinor += row.totalAmountMinor;
    current.count += row.count;
    totals.set(row.currency, current);
  }
  return [...totals.entries()]
    .map(([currency, t]) => ({
      currency,
      amountMinor: t.amountMinor,
      count: t.count,
      averageMinor: t.count > 0 ? Math.round(t.amountMinor / t.count) : null,
    }))
    .sort((a, b) => b.count - a.count || byText(a.currency, b.currency));
}

/** Las monedas en que hubo ventas en el período, en el orden de {@link currencySummaries}. */
export function reportCurrencies(metrics: SalesMetrics): string[] {
  return currencySummaries(metrics).map((s) => s.currency);
}

/** Los meses del período, del primero al último. */
export function periodMonths(period: SalesPeriod): string[] {
  const [fromYear, fromMonth] = period.from.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = period.to.split('-').map(Number) as [number, number];
  const out: string[] = [];
  let y = fromYear;
  let m = fromMonth;
  // Tope de seguridad: el API manda 12 meses; un período absurdo no cuelga la página.
  while ((y < toYear || (y === toYear && m <= toMonth)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Un punto por mes del período en esta moneda; los meses sin ventas, en cero. */
export function monthlySeries(metrics: SalesMetrics, currency: string): SalesMonthlyTrend[] {
  const sold = new Map(
    metrics.monthlyTrend.filter((m) => m.currency === currency).map((m) => [m.month, m]),
  );
  return periodMonths(metrics.period).map(
    (month) => sold.get(month) ?? { month, currency, amountMinor: 0, count: 0 },
  );
}

export interface VerticalShare extends SalesVerticalMetric {
  /** Porcentaje del monto de la moneda (0-100). */
  readonly share: number;
}

/** Las verticales vendidas en esta moneda, de mayor a menor monto, con su parte del total. */
export function verticalShares(metrics: SalesMetrics, currency: string): VerticalShare[] {
  const rows = metrics.byVertical.filter((v) => v.currency === currency);
  const total = rows.reduce((sum, v) => sum + v.totalAmountMinor, 0);
  return rows
    .map((v) => ({ ...v, share: total > 0 ? (v.totalAmountMinor / total) * 100 : 0 }))
    .sort((a, b) => b.totalAmountMinor - a.totalAmountMinor || b.count - a.count);
}

/** Los vendedores de esta moneda, en el orden del API (de más a menos vendido). */
export function topPerformersIn(metrics: SalesMetrics, currency: string): TopPerformer[] {
  return metrics.topPerformers.filter((p) => p.currency === currency);
}

// ─────────────────────────── Textos ───────────────────────────

/** Con el símbolo de la moneda: "$ 1.500.000", "US$ 80,50". */
export function reportMoney(minor: number, currency: string): string {
  return formatMoney(minor, currency);
}

/** "{monto} {moneda}": "1.500.000 COP", "80,50 USD". */
export function amountWithCode(minor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const amount = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(minor / 100);
  return `${amount} ${currency}`;
}

/** Las líneas del KPI de ventas del mes de Inicio: una por moneda. */
export function salesThisMonthLines(sales: readonly CurrencyAmount[]): string[] {
  return sales.map((s) => amountWithCode(s.amountMinor, s.currency));
}

const MONTH_YEAR = new Intl.DateTimeFormat('es-CO', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const SHORT_MONTH = new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' });

function monthDate(month: string): Date {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}

/** `2026-10` → "octubre de 2026". */
export function monthName(month: string): string {
  return isMonth(month) ? MONTH_YEAR.format(monthDate(month)) : month;
}

/** `2026-10` → "oct 2026". */
export function shortMonthName(month: string): string {
  if (!isMonth(month)) return month;
  return `${SHORT_MONTH.format(monthDate(month)).replace('.', '')} ${month.slice(0, 4)}`;
}

/** "De noviembre de 2025 a octubre de 2026". */
export function periodText(period: SalesPeriod): string {
  return period.from === period.to
    ? monthName(period.to)
    : `De ${monthName(period.from)} a ${monthName(period.to)}`;
}

export function bookingsText(count: number): string {
  return count === 1 ? '1 reserva' : `${count} reservas`;
}

// ─────────────────────────── CSV ───────────────────────────

/**
 * En unidades de la moneda, con punto decimal: lo lee cualquier planilla. Los montos van en
 * centésimas en toda moneda (`Money.fromMajor`).
 */
function csvAmount(minor: number): CsvValue {
  return csvDecimal(minor, 2);
}

export const SALES_CSV_HEADER = ['Corte', 'Detalle', 'Moneda', 'Reservas confirmadas', 'Monto'];

/**
 * El reporte en CSV: sólo filas reales (ninguna fila en cero ni totales entre monedas), todas las
 * monedas, cada fila con la suya. Una tabla "larga": se filtra por Corte (Vertical, Mes, Vendedor)
 * y por Moneda en cualquier planilla.
 *
 * Cada celda pasa por las reglas de lib/csv, las de la consola de la plataforma: un nombre de
 * vendedor que empieza con `=` lleva su apóstrofo, y uno con `;` o tabulación va entre comillas
 * porque Excel en es-CO, es-PE o pt-BR separa por `;`.
 */
export function salesReportCsv(metrics: SalesMetrics): string {
  const currencies = reportCurrencies(metrics);
  const rows: CsvValue[][] = [];
  for (const currency of currencies) {
    for (const v of verticalShares(metrics, currency)) {
      rows.push([
        'Vertical',
        salesVerticalName(v.vertical),
        currency,
        v.count,
        csvAmount(v.totalAmountMinor),
      ]);
    }
  }
  const months = [...metrics.monthlyTrend].sort(
    (a, b) => byText(a.month, b.month) || byText(a.currency, b.currency),
  );
  for (const m of months) {
    rows.push(['Mes', m.month, m.currency, m.count, csvAmount(m.amountMinor)]);
  }
  for (const currency of currencies) {
    for (const p of topPerformersIn(metrics, currency)) {
      rows.push(['Vendedor', p.name, currency, p.count, csvAmount(p.salesMinor)]);
    }
  }
  return toCsv(SALES_CSV_HEADER, rows);
}

export function salesReportFilename(period: SalesPeriod): string {
  return `ventas-${period.from}-a-${period.to}.csv`;
}
