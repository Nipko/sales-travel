import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';

/**
 * Reportes de ventas de la agencia activa y los KPIs de Inicio.
 *
 * Todo sale de `orders` confirmadas (`confirmed` y `ticketed`) del tenant activo. Nunca se suman
 * montos de monedas distintas: cada fila lleva su moneda. Sin ventas, listas vacías: hasta G-16 se
 * devolvían verticales, meses, vendedores y comisiones de demostración que una agencia no podía
 * distinguir de sus números.
 */

/** Etiqueta de cada vertical en los reportes. */
const VERTICAL_LABELS: Readonly<Record<string, string>> = {
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
  assistance: 'Asistencias',
};

/**
 * Proveedores de filas que no dicen su vertical. Las verticales que reservan fuera de la saga de
 * vuelos escriben `search_criteria.vertical` (`ExternalOrderIntentService`, autos), así que esto
 * sólo cubre filas viejas y proveedores de demostración.
 */
const LEGACY_PROVIDER_VERTICAL: Readonly<Record<string, string>> = {
  'latam-ndc': 'flights',
  hotelbeds: 'hotels',
  hoteldo: 'hotels',
  'despegar-hotels': 'hotels',
  assistcard: 'assistance',
};

/** Las verticales que distinguen los reportes. */
export type SalesVertical = 'flights' | 'hotels' | 'cars' | 'assistance';

function isSalesVertical(value: string | null | undefined): value is SalesVertical {
  return value !== null && value !== undefined && Object.hasOwn(VERTICAL_LABELS, value);
}

/**
 * La vertical de una orden: la que la fila declara en `search_criteria.vertical` y, si no la
 * declara, la de su proveedor. Lo que no dice nada sigue contando como vuelo, que es la única
 * vertical cuyas órdenes no escriben el campo; antes también caía ahí una reserva de hotel de un
 * proveedor que no estuviera en la lista.
 */
export function salesVertical(provider: string, declaredVertical: string | null): SalesVertical {
  if (isSalesVertical(declaredVertical)) return declaredVertical;
  const legacy = LEGACY_PROVIDER_VERTICAL[provider];
  return isSalesVertical(legacy) ? legacy : 'flights';
}

/** Etiqueta de la vertical de una orden (ver {@link salesVertical}). */
export function salesVerticalLabel(provider: string, declaredVertical: string | null): string {
  return VERTICAL_LABELS[salesVertical(provider, declaredVertical)] ?? 'Vuelos';
}

/**
 * La zona con que se cortan los meses: la de la plataforma, la misma del Resumen
 * (`PLATFORM_TIME_ZONE`). Con la de la sesión de Postgres (UTC) una venta del 30 a las 21:00 en
 * Bogotá caía en el mes siguiente.
 */
export const REPORTS_TIME_ZONE = 'America/Bogota';

/** Los meses que mira Reportes: el en curso y los once anteriores. */
export const SALES_REPORT_MONTHS = 12;

/** Los vendedores que se listan por moneda. */
export const TOP_PERFORMERS_PER_CURRENCY = 5;

/** `pg` devuelve BIGINT y NUMERIC como texto. */
type DbNumber = string | number | bigint | null | undefined;

function toNumber(value: DbNumber): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─────────────────────────── Lo que devuelve la API ───────────────────────────

export interface SalesVerticalMetric {
  vertical: SalesVertical;
  currency: string;
  totalAmountMinor: number;
  count: number;
}

export interface SalesMonthlyTrend {
  /** `YYYY-MM` en {@link REPORTS_TIME_ZONE}. */
  month: string;
  currency: string;
  amountMinor: number;
  count: number;
}

export interface TopPerformer {
  userId: string;
  /** El nombre del usuario o, si no tiene, su correo. */
  name: string;
  currency: string;
  salesMinor: number;
  count: number;
}

export interface SalesMetrics {
  /** Los meses que cubre el reporte (`YYYY-MM`, inclusive), en {@link REPORTS_TIME_ZONE}. */
  period: { from: string; to: string; timeZone: string };
  byVertical: SalesVerticalMetric[];
  monthlyTrend: SalesMonthlyTrend[];
  topPerformers: TopPerformer[];
}

/**
 * Todavía no hay de dónde sacar comisiones ni márgenes reales: el margen de cada nivel de la red no
 * se registra por venta (es trabajo pendiente). Hasta entonces se dice que no está disponible, sin
 * números: los de antes eran porcentajes fijos sobre ventas inventadas.
 */
export interface CommissionsReport {
  available: false;
  byVertical: [];
  summary: null;
}

export interface CurrencyAmount {
  currency: string;
  amountMinor: number;
}

export interface DashboardKpis {
  quotationsThisMonth: number;
  confirmedThisMonth: number;
  activeCustomers: number;
  /** Lo confirmado este mes, una entrada por moneda. Vacío si no hubo ventas. */
  salesThisMonth: CurrencyAmount[];
}

// ─────────────────────────── Filas de la base ───────────────────────────

export interface VerticalSalesRow {
  provider: string;
  declared_vertical: string | null;
  currency: string;
  orders: DbNumber;
  amount_minor: DbNumber;
}

export interface MonthlySalesRow {
  month: string;
  currency: string;
  orders: DbNumber;
  amount_minor: DbNumber;
}

export interface SellerSalesRow {
  user_id: string;
  name: string | null;
  email: string;
  currency: string;
  orders: DbNumber;
  amount_minor: DbNumber;
}

export interface CurrencySalesRow {
  currency: string;
  amount_minor: DbNumber;
}

// ─────────────────────────── De filas a reporte (sin I/O) ───────────────────────────

const VERTICAL_ORDER: readonly SalesVertical[] = ['flights', 'hotels', 'cars', 'assistance'];

/**
 * Ventas por vertical y moneda. Varias filas de la base caen en la misma vertical (un proveedor
 * viejo sin `vertical` declarada y uno nuevo que la declara): se juntan, pero nunca entre monedas.
 */
export function foldSalesByVertical(rows: readonly VerticalSalesRow[]): SalesVerticalMetric[] {
  const out = new Map<string, SalesVerticalMetric>();
  for (const row of rows) {
    const count = toNumber(row.orders);
    if (count === 0) continue;
    const vertical = salesVertical(row.provider, row.declared_vertical);
    const key = `${row.currency}\u0000${vertical}`;
    const current = out.get(key) ?? {
      vertical,
      currency: row.currency,
      totalAmountMinor: 0,
      count: 0,
    };
    current.totalAmountMinor += toNumber(row.amount_minor);
    current.count += count;
    out.set(key, current);
  }
  return [...out.values()].sort(
    (a, b) =>
      byText(a.currency, b.currency) ||
      b.totalAmountMinor - a.totalAmountMinor ||
      VERTICAL_ORDER.indexOf(a.vertical) - VERTICAL_ORDER.indexOf(b.vertical),
  );
}

/** Ventas por mes y moneda, del mes más viejo al más nuevo. Sólo los meses con ventas. */
export function foldMonthlyTrend(rows: readonly MonthlySalesRow[]): SalesMonthlyTrend[] {
  return rows
    .map((row) => ({
      month: row.month,
      currency: row.currency,
      amountMinor: toNumber(row.amount_minor),
      count: toNumber(row.orders),
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => byText(a.month, b.month) || byText(a.currency, b.currency));
}

function sellerName(row: Pick<SellerSalesRow, 'name' | 'email'>): string {
  const name = row.name?.trim();
  return name ? name : row.email;
}

/**
 * Los vendedores que más confirmaron en cada moneda, de mayor a menor monto (a igual monto, más
 * reservas y después por nombre). Un vendedor que vendió en dos monedas aparece en las dos.
 */
export function topPerformersByCurrency(
  rows: readonly SellerSalesRow[],
  limit = TOP_PERFORMERS_PER_CURRENCY,
): TopPerformer[] {
  const byCurrency = new Map<string, TopPerformer[]>();
  for (const row of rows) {
    const count = toNumber(row.orders);
    if (count === 0) continue;
    const list = byCurrency.get(row.currency) ?? [];
    list.push({
      userId: row.user_id,
      name: sellerName(row),
      currency: row.currency,
      salesMinor: toNumber(row.amount_minor),
      count,
    });
    byCurrency.set(row.currency, list);
  }
  return [...byCurrency.keys()]
    .sort(byText)
    .flatMap((currency) =>
      (byCurrency.get(currency) ?? [])
        .sort(
          (a, b) =>
            b.salesMinor - a.salesMinor ||
            b.count - a.count ||
            byText(a.name, b.name) ||
            byText(a.userId, b.userId),
        )
        .slice(0, limit),
    );
}

/** Un monto por moneda, en orden alfabético de moneda. */
export function foldSalesByCurrency(rows: readonly CurrencySalesRow[]): CurrencyAmount[] {
  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.currency, (out.get(row.currency) ?? 0) + toNumber(row.amount_minor));
  }
  return [...out.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

// ─────────────────────────── Servicio ───────────────────────────

interface ReportWindow {
  from_at: Date;
  from_month: string;
  to_month: string;
}

/** El comienzo del mes en curso, en la zona de los reportes. */
const MONTH_START = sql`(date_trunc('month', now() AT TIME ZONE ${REPORTS_TIME_ZONE}::text) AT TIME ZONE ${REPORTS_TIME_ZONE}::text)`;

@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Ventas confirmadas de los últimos {@link SALES_REPORT_MONTHS} meses: por vertical, por mes y por
   * vendedor, cada una por moneda.
   */
  async getSalesMetrics(tenantId: string): Promise<SalesMetrics> {
    return this.db.withTenant(tenantId, async (trx) => {
      const range = await this.reportWindow(trx);

      const { rows: verticals } = await sql<VerticalSalesRow>`
        SELECT o.provider,
               o.search_criteria->>'vertical' AS declared_vertical,
               o.currency,
               count(*) AS orders,
               COALESCE(sum(o.total_amount), 0) AS amount_minor
          FROM orders o
         WHERE o.tenant_id = ${tenantId}
           AND o.status IN ('confirmed', 'ticketed')
           AND o.created_at >= ${range.from_at}
         GROUP BY o.provider, o.search_criteria->>'vertical', o.currency
      `.execute(trx);

      // El mes se calcula en una subconsulta: con el mismo parámetro en el SELECT y en el GROUP BY,
      // Postgres los ve como expresiones distintas y rechaza el agrupamiento.
      const { rows: months } = await sql<MonthlySalesRow>`
        SELECT s.month, s.currency, count(*) AS orders, COALESCE(sum(s.total_amount), 0) AS amount_minor
          FROM (SELECT to_char(o.created_at AT TIME ZONE ${REPORTS_TIME_ZONE}::text, 'YYYY-MM') AS month,
                       o.currency,
                       o.total_amount
                  FROM orders o
                 WHERE o.tenant_id = ${tenantId}
                   AND o.status IN ('confirmed', 'ticketed')
                   AND o.created_at >= ${range.from_at}) s
         GROUP BY s.month, s.currency
      `.execute(trx);

      const { rows: sellers } = await sql<SellerSalesRow>`
        SELECT o.user_id, u.name, u.email, o.currency,
               count(*) AS orders,
               COALESCE(sum(o.total_amount), 0) AS amount_minor
          FROM orders o
          JOIN users u ON u.id = o.user_id
         WHERE o.tenant_id = ${tenantId}
           AND o.status IN ('confirmed', 'ticketed')
           AND o.created_at >= ${range.from_at}
         GROUP BY o.user_id, u.name, u.email, o.currency
      `.execute(trx);

      return {
        period: { from: range.from_month, to: range.to_month, timeZone: REPORTS_TIME_ZONE },
        byVertical: foldSalesByVertical(verticals),
        monthlyTrend: foldMonthlyTrend(months),
        topPerformers: topPerformersByCurrency(sellers),
      };
    });
  }

  /** Ver {@link CommissionsReport}: no hay fuente real todavía. */
  getCommissions(): CommissionsReport {
    return { available: false, byVertical: [], summary: null };
  }

  /**
   * KPIs de la portada del panel.
   *
   * El dashboard mostraba cuatro ceros HARDCODEADOS con leyendas del tipo "Cartera
   * actualizada", indistinguibles de métricas reales: una agencia que sí vendió veía
   * cero y podía concluir que la plataforma no registró sus ventas. Todo sale de las
   * mismas tablas que ya alimentan los reportes, y las ventas van por moneda.
   */
  async getDashboardKpis(tenantId: string): Promise<DashboardKpis> {
    return this.db.withTenant(tenantId, async (trx) => {
      const [quotations, orders, sales, customers] = await Promise.all([
        trx
          .selectFrom('quotations')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('tenant_id', '=', tenantId)
          .where(sql<boolean>`created_at >= ${MONTH_START}`)
          .executeTakeFirst(),
        trx
          .selectFrom('orders')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('tenant_id', '=', tenantId)
          .where('status', 'in', ['confirmed', 'ticketed'])
          .where(sql<boolean>`created_at >= ${MONTH_START}`)
          .executeTakeFirst(),
        trx
          .selectFrom('orders')
          .select(['currency', sql<string>`COALESCE(sum(total_amount), 0)`.as('amount_minor')])
          .where('tenant_id', '=', tenantId)
          .where('status', 'in', ['confirmed', 'ticketed'])
          .where(sql<boolean>`created_at >= ${MONTH_START}`)
          .groupBy('currency')
          .execute(),
        trx
          .selectFrom('customers')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst(),
      ]);

      return {
        quotationsThisMonth: toNumber(quotations?.count),
        confirmedThisMonth: toNumber(orders?.count),
        activeCustomers: toNumber(customers?.count),
        salesThisMonth: foldSalesByCurrency(sales),
      };
    });
  }

  /** Desde cuándo mira el reporte: el comienzo del primer mes, y los meses de punta a punta. */
  private async reportWindow(trx: Transaction<DB>): Promise<ReportWindow> {
    const { rows } = await sql<ReportWindow>`
      SELECT (w.start AT TIME ZONE ${REPORTS_TIME_ZONE}::text) AS from_at,
             to_char(w.start, 'YYYY-MM') AS from_month,
             to_char(now() AT TIME ZONE ${REPORTS_TIME_ZONE}::text, 'YYYY-MM') AS to_month
        FROM (SELECT date_trunc('month', now() AT TIME ZONE ${REPORTS_TIME_ZONE}::text)
                     - make_interval(months => ${SALES_REPORT_MONTHS - 1}::int) AS start) w
    `.execute(trx);
    const range = rows[0];
    if (range === undefined) throw new Error('Postgres no devolvió el período del reporte');
    return range;
  }
}
