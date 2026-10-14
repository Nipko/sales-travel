import type { QuotationStatus, TenantType } from '../database/database.types.js';
import { MONEY_EXPONENT, currencyExponent } from '../portfolios/wallet-currency.js';
import { salesVertical, type SalesVertical } from '../reports/reports.service.js';
import type { KillLevel } from '../search/circuit-breaker.service.js';
import {
  ORDER_ATTENTION_REASONS,
  attentionRank,
  isOrderAttentionReason,
  type OrderAttentionReason,
} from './attention.js';

/**
 * Plataforma → Resumen: de las filas de las funciones de 0075 a la vista que muestra la web. Sin I/O.
 *
 * Nunca se suman monedas distintas: todo monto va con su moneda y el exponente de SUS unidades
 * menores. No es el mismo en todos los montos:
 *
 *   - lo de reservas (ventas, tendencia, top de nodos) sale de `orders.total_amount`, que va SIEMPRE
 *     en centésimos ({@link ORDER_AMOUNT_EXPONENT});
 *   - lo de carteras, en las unidades menores ISO 4217 de su moneda (wallet-currency.ts).
 */

/** `pg` devuelve BIGINT y NUMERIC como texto. */
type DbNumber = string | number | bigint | null | undefined;

function toNumber(value: DbNumber): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** El exponente ISO 4217 de una cartera: sus montos van en las unidades menores de su moneda. */
function exponentOf(currency: string): number | null {
  return currencyExponent(currency) ?? null;
}

/**
 * El exponente de un monto de reservas, en toda moneda: `orders.total_amount` va SIEMPRE en centésimos
 * (`Money.fromMajor` de @sales-travel/canonical multiplica por 100, también en CLP o JPY), como lo
 * leen la consola de Reservas (formatMoney del panel) y su CSV. Con el exponente ISO, una venta de
 * 150.000 pesos chilenos (15.000.000 centésimos) se vería 100 veces más grande.
 */
export const ORDER_AMOUNT_EXPONENT = MONEY_EXPONENT;

// ─────────────────────────── Filas de 0075 ───────────────────────────

export interface OverviewOrdersRow {
  currency: string;
  provider: string;
  declared_vertical: string | null;
  status: string;
  orders: DbNumber;
  amount_minor: DbNumber;
}

export interface OverviewTrendRow {
  month: string;
  currency: string;
  orders: DbNumber;
  amount_minor: DbNumber;
}

export interface OverviewTopNodeRow {
  tenant_id: string;
  name: string;
  slug: string;
  tenant_type: string;
  is_branch: boolean;
  status: string;
  orders_total: DbNumber;
  currency: string;
  orders: DbNumber;
  amount_minor: DbNumber;
}

export interface OverviewQuotationsRow {
  status: string;
  quotations: DbNumber;
}

export interface OverviewNetworkRow {
  nodes_total: DbNumber;
  nodes_active: DbNumber;
  nodes_suspended: DbNumber;
  nodes_archived: DbNumber;
  consolidators: DbNumber;
  agencies: DbNumber;
  branches: DbNumber;
  subagencies: DbNumber;
  nodes_created: DbNumber;
  users_active: DbNumber;
  users_suspended: DbNumber;
  users_locked: DbNumber;
  admins_without_mfa: DbNumber;
  users_logged_in: DbNumber;
  live_sessions: DbNumber;
}

export interface OverviewWalletsRow {
  currency: string;
  wallets: DbNumber;
  credit_limit_minor: DbNumber;
  debt_minor: DbNumber;
  funds_minor: DbNumber;
  overlimit: DbNumber;
  suspended: DbNumber;
  platform_credit_limit_minor: DbNumber;
  platform_debt_minor: DbNumber;
}

export interface OverviewPostSaleRow {
  op_type: string;
  failed: DbNumber;
  stuck: DbNumber;
}

/** `admin_order_attention()`: una fila por (orden, motivo). */
export interface OverviewOrderAttentionRow {
  order_id: string;
  tenant_id: string;
  tenant_name: string;
  order_number: DbNumber;
  provider: string;
  provider_order_id: string | null;
  order_status: string;
  reason: string;
  since: Date | string;
}

/** `admin_node_stats()` de los nodos con cupo, con su nombre. */
export interface OverviewSeatsRow {
  tenant_id: string;
  tenant_name: string;
  seat_limit: DbNumber;
  seats_used: DbNumber;
}

/** `admin_reconciliation_health(p_since)`. */
export interface OverviewReconciliationHealthRow {
  provider_code: string;
  runs: DbNumber;
  failed_runs: DbNumber;
  last_finished_at: Date | string | null;
  last_status: string | null;
  critical_items: DbNumber;
  warning_items: DbNumber;
}

/** `hotel_provider_city` por proveedor (catálogo de plataforma, sin RLS). */
export interface OverviewCatalogRow {
  provider_code: string;
  cities: DbNumber;
  synced_last_48h: DbNumber;
  failed_cities: DbNumber;
  last_synced_at: Date | string | null;
}

export interface OverviewAttentionRow {
  deposit_reports_platform: DbNumber;
  deposit_reports_network: DbNumber;
  hotel_orders_unverified: DbNumber;
  wallet_hold_conflicts: DbNumber;
  reconciliation_critical: DbNumber;
  reconciliation_warning: DbNumber;
  invitations_pending: DbNumber;
  invitations_expired: DbNumber;
}

// ─────────────────────────── La vista ───────────────────────────

/** Lo creado en el período en una moneda. "Confirmadas" son `confirmed` y `ticketed`: la venta. */
export interface SalesByCurrencyView {
  currency: string;
  /** De reservas: siempre {@link ORDER_AMOUNT_EXPONENT} (centésimos), no el ISO de la moneda. */
  exponent: number | null;
  confirmedCount: number;
  confirmedAmountMinor: number;
  /** Creadas en el período y ya canceladas. */
  cancelledCount: number;
  cancelledAmountMinor: number;
  failedCount: number;
  /** Ni confirmadas ni cerradas todavía (un estado desconocido cuenta acá). */
  pendingCount: number;
  /** Venta confirmada / reservas confirmadas, redondeado; `null` sin confirmadas. */
  averageTicketMinor: number | null;
}

/** Lo confirmado en una vertical y una moneda. */
export interface SalesByVerticalView {
  vertical: SalesVertical;
  currency: string;
  /** De reservas: siempre {@link ORDER_AMOUNT_EXPONENT} (centésimos), no el ISO de la moneda. */
  exponent: number | null;
  count: number;
  amountMinor: number;
}

export interface SalesByProviderView {
  provider: string;
  currency: string;
  /** De reservas: siempre {@link ORDER_AMOUNT_EXPONENT} (centésimos), no el ISO de la moneda. */
  exponent: number | null;
  confirmedCount: number;
  confirmedAmountMinor: number;
  cancelledCount: number;
  failedCount: number;
  pendingCount: number;
}

export interface QuotationsView {
  created: number;
  accepted: number;
  byStatus: Record<QuotationStatus, number>;
}

export interface SalesView {
  byCurrency: SalesByCurrencyView[];
  byVertical: SalesByVerticalView[];
  byProvider: SalesByProviderView[];
  quotations: QuotationsView;
}

export interface TrendPointView {
  month: string;
  count: number;
  amountMinor: number;
}

/** Una serie por moneda, con un punto por cada mes de `months` (cero si no hubo ventas). */
export interface TrendSeriesView {
  currency: string;
  /** De reservas: siempre {@link ORDER_AMOUNT_EXPONENT} (centésimos), no el ISO de la moneda. */
  exponent: number | null;
  points: TrendPointView[];
}

export interface TrendView {
  months: string[];
  series: TrendSeriesView[];
}

export interface MoneyView {
  currency: string;
  /** De reservas: siempre {@link ORDER_AMOUNT_EXPONENT} (centésimos), no el ISO de la moneda. */
  exponent: number | null;
  amountMinor: number;
}

/** Un nodo del ranking, por cantidad de reservas confirmadas, con lo vendido en cada moneda. */
export interface TopNodeView {
  tenantId: string;
  name: string;
  slug: string;
  tenantType: TenantType;
  isBranch: boolean;
  status: string;
  confirmedCount: number;
  amounts: MoneyView[];
}

export interface NetworkView {
  nodes: {
    /** Sin la raíz de la plataforma. */
    total: number;
    active: number;
    suspended: number;
    archived: number;
    consolidators: number;
    /** Agencias que no son sucursal. */
    agencies: number;
    /** Sucursales de Planetour (0050). */
    branches: number;
    subagencies: number;
    /** Altas en el período. */
    created: number;
  };
  users: {
    /** Cuenta activa con al menos una membership activa en la red que se mira. */
    active: number;
    /** Suspendidas en toda la plataforma. */
    suspended: number;
    /** Bloqueadas ahora por intentos fallidos. */
    locked: number;
    /** Con un rol de admin activo y sin segundo factor: el MFA es obligatorio para ellos. */
    adminsWithoutMfa: number;
    /** Activas cuyo último ingreso cae en el período. */
    loggedInPeriod: number;
  };
  /** Sesiones vivas ahora (no revocadas, no vencidas y dentro de su inactividad). */
  liveSessions: number;
}

export interface WalletExposureView {
  currency: string;
  /** El ISO 4217 de la moneda: los montos de una cartera van en sus unidades menores. */
  exponent: number | null;
  wallets: number;
  creditLimitMinor: number;
  /** Lo que se debe: la suma de los saldos negativos, en positivo. */
  debtMinor: number;
  /** Saldo a favor de las agencias. */
  fundsMinor: number;
  overlimit: number;
  suspended: number;
  /** El cupo y la deuda de lo que financia Planetour: su propia exposición. */
  platformCreditLimitMinor: number;
  platformDebtMinor: number;
}

export interface PostSaleTypeView {
  type: string;
  /** Órdenes cuya última operación de este tipo falló. */
  failed: number;
  /** Órdenes con una operación de este tipo en vuelo hace más de lo que puede durar. */
  stuck: number;
}

/** Una reserva de la muestra, con el motivo más grave que tiene. Sin datos de pasajeros. */
export interface OrderAttentionSampleView {
  orderId: string;
  tenantId: string;
  tenantName: string;
  orderNumber: number;
  provider: string;
  providerOrderId: string | null;
  orderStatus: string;
  reason: OrderAttentionReason;
  /** ISO 8601: desde cuándo (el hecho que dispara ese motivo). */
  since: string;
}

/** Las reservas que necesitan a una persona (`admin_order_attention`, 0075 §7). */
export interface OrderAttentionView {
  /** Reservas distintas con al menos un motivo. */
  total: number;
  /** Reservas por motivo: una reserva con dos motivos cuenta en los dos. */
  byReason: Record<OrderAttentionReason, number>;
  /** Hasta {@link ORDER_ATTENTION_SAMPLE} reservas, de la que más espera a la que menos. */
  sample: OrderAttentionSampleView[];
}

export interface SaturatedSeatsView {
  tenantId: string;
  tenantName: string;
  used: number;
  limit: number;
}

export interface ReconciliationRunsView {
  sinceDays: number;
  /** Corridas fallidas (failed, invalid, abandoned) en la ventana, de todos los proveedores. */
  failedRuns: number;
  byProvider: {
    providerCode: string;
    runs: number;
    failedRuns: number;
    /** ISO 8601, o `null` si nunca terminó una. */
    lastFinishedAt: string | null;
    lastStatus: string | null;
    criticalItems: number;
    warningItems: number;
  }[];
}

/** Las tareas automáticas que dejaron de correr (Plataforma → Sistema › Procesos). */
export interface JobsAttentionView {
  /** El barrido de post-venta no tiene una corrida correcta en 45 minutos (o ninguna). */
  postSaleSweepStale: boolean;
  /** ISO 8601: su última corrida correcta, o `null` si no hay rastro de ninguna. */
  lastOkAt: string | null;
}

/** Lo que espera a una persona. Cada contador lleva a su cola. */
export interface AttentionView {
  depositReports: { total: number; platform: number; network: number };
  orders: OrderAttentionView;
  postSale: { failed: number; stuck: number; byType: PostSaleTypeView[] };
  hotelOrdersUnverified: number;
  walletHoldConflicts: number;
  reconciliation: { critical: number; warning: number; sinceDays: number };
  /** De toda la plataforma aunque se acote a un nodo: una corrida es de la cuenta del proveedor. */
  reconciliationRuns: ReconciliationRunsView;
  invitations: { pending: number; expired: number; expiredSinceDays: number };
  /** Los nodos con cupo al {@link SEAT_SATURATION_RATIO} o más. */
  seats: { saturated: SaturatedSeatsView[] };
  /** De la plataforma aunque se acote a un nodo: el barrido recorre toda la red. */
  jobs: JobsAttentionView;
}

/** El catálogo de hoteles de un proveedor: cuán fresco está. */
export interface CatalogView {
  providerCode: string;
  cities: number;
  syncedLast48h: number;
  /** Ciudades cuya última sincronización respondió con un error (HTTP 400 o más). */
  failedCities: number;
  /** ISO 8601, o `null` si nunca se sincronizó. */
  lastSyncedAt: string | null;
  /** La última sincronización tiene más de {@link CATALOG_STALE_HOURS} horas (o no hubo). */
  stale: boolean;
}

export interface KillSwitchView {
  code: string;
  level: KillLevel;
}

export interface OpenCircuitView {
  code: string;
  state: string;
  failures: number;
}

export interface DisabledProviderView {
  code: string;
  reason: string | null;
  /** ISO 8601. */
  updatedAt: string;
}

export interface ProviderSignalsView {
  /** Apagados de emergencia (hoy `PROVIDERS_DISABLED`): le ganan a todo. */
  killSwitched: KillSwitchView[];
  /**
   * Circuitos abiertos o en prueba. El estado vive en la memoria de cada réplica de la API: esto es
   * lo que ve la que respondió.
   */
  openCircuits: OpenCircuitView[];
  /** Apagados para toda la plataforma desde Proveedores de la plataforma. */
  disabledGlobally: DisabledProviderView[];
  /** Ajustes por nodo que apagan un proveedor, en toda la plataforma. */
  tenantOverridesDisabled: number;
}

// ─────────────────────────── Plegados ───────────────────────────

type StatusBucket = 'confirmed' | 'cancelled' | 'failed' | 'pending';

/** `confirmed` y `ticketed` son la venta; lo que no está cerrado, en curso. */
export function orderStatusBucket(status: string): StatusBucket {
  switch (status) {
    case 'confirmed':
    case 'ticketed':
      return 'confirmed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

const VERTICAL_ORDER: readonly SalesVertical[] = ['flights', 'hotels', 'cars', 'assistance'];

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function getOrSet<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

export function foldSales(
  orders: readonly OverviewOrdersRow[],
  quotations: readonly OverviewQuotationsRow[],
): SalesView {
  const currencies = new Map<string, SalesByCurrencyView>();
  const verticals = new Map<string, SalesByVerticalView>();
  const providers = new Map<string, SalesByProviderView>();

  for (const row of orders) {
    const count = toNumber(row.orders);
    const amount = toNumber(row.amount_minor);
    const bucket = orderStatusBucket(row.status);
    const exponent = ORDER_AMOUNT_EXPONENT;

    const c = getOrSet(currencies, row.currency, () => ({
      currency: row.currency,
      exponent,
      confirmedCount: 0,
      confirmedAmountMinor: 0,
      cancelledCount: 0,
      cancelledAmountMinor: 0,
      failedCount: 0,
      pendingCount: 0,
      averageTicketMinor: null,
    }));
    const p = getOrSet(providers, `${row.provider}\u0000${row.currency}`, () => ({
      provider: row.provider,
      currency: row.currency,
      exponent,
      confirmedCount: 0,
      confirmedAmountMinor: 0,
      cancelledCount: 0,
      failedCount: 0,
      pendingCount: 0,
    }));

    switch (bucket) {
      case 'confirmed': {
        c.confirmedCount += count;
        c.confirmedAmountMinor += amount;
        p.confirmedCount += count;
        p.confirmedAmountMinor += amount;
        const vertical = salesVertical(row.provider, row.declared_vertical);
        const v = getOrSet(verticals, `${vertical}\u0000${row.currency}`, () => ({
          vertical,
          currency: row.currency,
          exponent,
          count: 0,
          amountMinor: 0,
        }));
        v.count += count;
        v.amountMinor += amount;
        break;
      }
      case 'cancelled':
        c.cancelledCount += count;
        c.cancelledAmountMinor += amount;
        p.cancelledCount += count;
        break;
      case 'failed':
        c.failedCount += count;
        p.failedCount += count;
        break;
      case 'pending':
        c.pendingCount += count;
        p.pendingCount += count;
        break;
    }
  }

  const byCurrency = [...currencies.values()]
    .map((c) => ({
      ...c,
      averageTicketMinor:
        c.confirmedCount > 0 ? Math.round(c.confirmedAmountMinor / c.confirmedCount) : null,
    }))
    .sort((a, b) => byText(a.currency, b.currency));

  const byVertical = [...verticals.values()].sort(
    (a, b) =>
      VERTICAL_ORDER.indexOf(a.vertical) - VERTICAL_ORDER.indexOf(b.vertical) ||
      byText(a.currency, b.currency),
  );

  const byProvider = [...providers.values()].sort(
    (a, b) => byText(a.provider, b.provider) || byText(a.currency, b.currency),
  );

  return { byCurrency, byVertical, byProvider, quotations: foldQuotations(quotations) };
}

const QUOTATION_STATUSES: readonly QuotationStatus[] = [
  'draft',
  'sent',
  'accepted',
  'expired',
  'cancelled',
];

export function foldQuotations(rows: readonly OverviewQuotationsRow[]): QuotationsView {
  const byStatus = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, 0])) as Record<
    QuotationStatus,
    number
  >;
  let created = 0;
  for (const row of rows) {
    const n = toNumber(row.quotations);
    created += n;
    if ((QUOTATION_STATUSES as readonly string[]).includes(row.status)) {
      byStatus[row.status as QuotationStatus] += n;
    }
  }
  return { created, accepted: byStatus.accepted, byStatus };
}

/** Una serie por moneda con un punto por mes, en el orden de `months`; los meses sin venta, en cero. */
export function foldTrend(rows: readonly OverviewTrendRow[], months: readonly string[]): TrendView {
  const series = new Map<string, Map<string, TrendPointView>>();
  for (const row of rows) {
    if (!months.includes(row.month)) continue;
    const points = getOrSet(series, row.currency, () => new Map<string, TrendPointView>());
    const point = getOrSet(points, row.month, () => ({
      month: row.month,
      count: 0,
      amountMinor: 0,
    }));
    point.count += toNumber(row.orders);
    point.amountMinor += toNumber(row.amount_minor);
  }
  return {
    months: [...months],
    series: [...series.entries()]
      .sort(([a], [b]) => byText(a, b))
      .map(([currency, points]) => ({
        currency,
        exponent: ORDER_AMOUNT_EXPONENT,
        points: months.map((month) => points.get(month) ?? { month, count: 0, amountMinor: 0 }),
      })),
  };
}

/** Las filas vienen ordenadas por ranking (0075): un nodo por entrada, con sus monedas. */
export function foldTopNodes(rows: readonly OverviewTopNodeRow[]): TopNodeView[] {
  const nodes = new Map<string, TopNodeView>();
  for (const row of rows) {
    const node = getOrSet(nodes, row.tenant_id, () => ({
      tenantId: row.tenant_id,
      name: row.name,
      slug: row.slug,
      tenantType: row.tenant_type as TenantType,
      isBranch: row.is_branch,
      status: row.status,
      confirmedCount: toNumber(row.orders_total),
      amounts: [],
    }));
    node.amounts.push({
      currency: row.currency,
      exponent: ORDER_AMOUNT_EXPONENT,
      amountMinor: toNumber(row.amount_minor),
    });
  }
  return [...nodes.values()].map((n) => ({
    ...n,
    amounts: [...n.amounts].sort((a, b) => byText(a.currency, b.currency)),
  }));
}

export function foldNetwork(row: OverviewNetworkRow | undefined): NetworkView {
  const n = (v: DbNumber) => toNumber(v);
  return {
    nodes: {
      total: n(row?.nodes_total),
      active: n(row?.nodes_active),
      suspended: n(row?.nodes_suspended),
      archived: n(row?.nodes_archived),
      consolidators: n(row?.consolidators),
      agencies: n(row?.agencies),
      branches: n(row?.branches),
      subagencies: n(row?.subagencies),
      created: n(row?.nodes_created),
    },
    users: {
      active: n(row?.users_active),
      suspended: n(row?.users_suspended),
      locked: n(row?.users_locked),
      adminsWithoutMfa: n(row?.admins_without_mfa),
      loggedInPeriod: n(row?.users_logged_in),
    },
    liveSessions: n(row?.live_sessions),
  };
}

export function foldWallets(rows: readonly OverviewWalletsRow[]): WalletExposureView[] {
  return rows
    .map((row) => ({
      currency: row.currency,
      exponent: exponentOf(row.currency),
      wallets: toNumber(row.wallets),
      creditLimitMinor: toNumber(row.credit_limit_minor),
      debtMinor: toNumber(row.debt_minor),
      fundsMinor: toNumber(row.funds_minor),
      overlimit: toNumber(row.overlimit),
      suspended: toNumber(row.suspended),
      platformCreditLimitMinor: toNumber(row.platform_credit_limit_minor),
      platformDebtMinor: toNumber(row.platform_debt_minor),
    }))
    .sort((a, b) => byText(a.currency, b.currency));
}

/** Lo que se pliega aparte y entra a {@link AttentionView} tal cual. */
export interface AttentionExtras {
  orders: OrderAttentionView;
  seats: { saturated: SaturatedSeatsView[] };
  reconciliationRuns: ReconciliationRunsView;
  jobs: JobsAttentionView;
}

export function foldAttention(
  row: OverviewAttentionRow | undefined,
  postSale: readonly OverviewPostSaleRow[],
  recentDays: number,
  extras: AttentionExtras,
): AttentionView {
  const platform = toNumber(row?.deposit_reports_platform);
  const network = toNumber(row?.deposit_reports_network);
  const byType = postSale
    .map((r) => ({ type: r.op_type, failed: toNumber(r.failed), stuck: toNumber(r.stuck) }))
    .filter((r) => r.failed > 0 || r.stuck > 0)
    .sort((a, b) => byText(a.type, b.type));
  return {
    depositReports: { total: platform + network, platform, network },
    orders: extras.orders,
    seats: extras.seats,
    reconciliationRuns: extras.reconciliationRuns,
    jobs: extras.jobs,
    postSale: {
      failed: byType.reduce((sum, r) => sum + r.failed, 0),
      stuck: byType.reduce((sum, r) => sum + r.stuck, 0),
      byType,
    },
    hotelOrdersUnverified: toNumber(row?.hotel_orders_unverified),
    walletHoldConflicts: toNumber(row?.wallet_hold_conflicts),
    reconciliation: {
      critical: toNumber(row?.reconciliation_critical),
      warning: toNumber(row?.reconciliation_warning),
      sinceDays: recentDays,
    },
    invitations: {
      pending: toNumber(row?.invitations_pending),
      expired: toNumber(row?.invitations_expired),
      expiredSinceDays: recentDays,
    },
  };
}

/** Cuántas reservas trae la muestra del Resumen. */
export const ORDER_ATTENTION_SAMPLE = 10;

function isoOf(value: Date | string): string | undefined {
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * De las filas (orden, motivo) a la vista: cuántas reservas, cuántas por motivo y una muestra de las
 * que más esperan, una por reserva con su motivo más grave (ATTENTION_PRIORITY). Un motivo que esta
 * versión no conoce se ignora: el test de contrato con 0075 impide que pase sin que nadie lo vea.
 */
export function foldOrderAttention(
  rows: readonly OverviewOrderAttentionRow[],
  sampleSize: number = ORDER_ATTENTION_SAMPLE,
): OrderAttentionView {
  const byReason = Object.fromEntries(ORDER_ATTENTION_REASONS.map((r) => [r, 0])) as Record<
    OrderAttentionReason,
    number
  >;
  const worst = new Map<string, OrderAttentionSampleView>();
  for (const row of rows) {
    if (!isOrderAttentionReason(row.reason)) continue;
    const since = isoOf(row.since);
    if (since === undefined) continue;
    byReason[row.reason] += 1;
    const current = worst.get(row.order_id);
    if (current !== undefined && attentionRank(current.reason) <= attentionRank(row.reason)) {
      continue;
    }
    worst.set(row.order_id, {
      orderId: row.order_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      orderNumber: toNumber(row.order_number),
      provider: row.provider,
      providerOrderId: row.provider_order_id,
      orderStatus: row.order_status,
      reason: row.reason,
      since,
    });
  }
  const sample = [...worst.values()]
    .sort((a, b) => byText(a.since, b.since) || byText(a.orderId, b.orderId))
    .slice(0, Math.max(0, sampleSize));
  return { total: worst.size, byReason, sample };
}

/** Un nodo con cupo está saturado desde el 90 % de sus puestos en uso. */
export const SEAT_SATURATION_RATIO = 0.9;

/** Los nodos con cupo al 90 % o más, del más lleno al menos (y por nombre). */
export function foldSaturatedSeats(rows: readonly OverviewSeatsRow[]): SaturatedSeatsView[] {
  return rows
    .flatMap((row) => {
      const limit = toNumber(row.seat_limit);
      const used = toNumber(row.seats_used);
      if (limit <= 0 || used < Math.ceil(SEAT_SATURATION_RATIO * limit)) return [];
      return [{ tenantId: row.tenant_id, tenantName: row.tenant_name, used, limit }];
    })
    .sort((a, b) => b.used / b.limit - a.used / a.limit || byText(a.tenantName, b.tenantName));
}

export function foldReconciliationRuns(
  rows: readonly OverviewReconciliationHealthRow[],
  sinceDays: number,
): ReconciliationRunsView {
  const byProvider = rows
    .map((row) => ({
      providerCode: row.provider_code,
      runs: toNumber(row.runs),
      failedRuns: toNumber(row.failed_runs),
      lastFinishedAt: row.last_finished_at === null ? null : (isoOf(row.last_finished_at) ?? null),
      lastStatus: row.last_status,
      criticalItems: toNumber(row.critical_items),
      warningItems: toNumber(row.warning_items),
    }))
    .sort((a, b) => byText(a.providerCode, b.providerCode));
  return {
    sinceDays,
    failedRuns: byProvider.reduce((sum, p) => sum + p.failedRuns, 0),
    byProvider,
  };
}

/** Un catálogo sin sincronizar hace más de 36 horas quedó atrás: el sync corre a diario. */
export const CATALOG_STALE_HOURS = 36;

export function foldCatalogs(rows: readonly OverviewCatalogRow[], now: Date): CatalogView[] {
  const staleBefore = now.getTime() - CATALOG_STALE_HOURS * 3_600_000;
  return rows
    .map((row) => {
      const lastSyncedAt = row.last_synced_at === null ? null : (isoOf(row.last_synced_at) ?? null);
      return {
        providerCode: row.provider_code,
        cities: toNumber(row.cities),
        syncedLast48h: toNumber(row.synced_last_48h),
        failedCities: toNumber(row.failed_cities),
        lastSyncedAt,
        stale: lastSyncedAt === null || Date.parse(lastSyncedAt) < staleBefore,
      };
    })
    .sort((a, b) => byText(a.providerCode, b.providerCode));
}
