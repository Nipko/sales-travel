import type { QuotationStatus, TenantType } from '../database/database.types.js';
import { currencyExponent } from '../portfolios/wallet-currency.js';
import { salesVertical, type SalesVertical } from '../reports/reports.service.js';
import type { KillLevel } from '../search/circuit-breaker.service.js';

/**
 * Plataforma → Resumen: de las filas de las funciones de 0075 a la vista que muestra la web. Sin I/O.
 *
 * Nunca se suman monedas distintas: todo monto va con su moneda y su exponente (las unidades menores
 * de COP son centavos; las de CLP, pesos).
 */

/** `pg` devuelve BIGINT y NUMERIC como texto. */
type DbNumber = string | number | bigint | null | undefined;

function toNumber(value: DbNumber): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function exponentOf(currency: string): number | null {
  return currencyExponent(currency) ?? null;
}

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
  exponent: number | null;
  count: number;
  amountMinor: number;
}

export interface SalesByProviderView {
  provider: string;
  currency: string;
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
  exponent: number | null;
  points: TrendPointView[];
}

export interface TrendView {
  months: string[];
  series: TrendSeriesView[];
}

export interface MoneyView {
  currency: string;
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

/** Lo que espera a una persona. Cada contador lleva a su cola. */
export interface AttentionView {
  depositReports: { total: number; platform: number; network: number };
  postSale: { failed: number; stuck: number; byType: PostSaleTypeView[] };
  hotelOrdersUnverified: number;
  walletHoldConflicts: number;
  reconciliation: { critical: number; warning: number; sinceDays: number };
  invitations: { pending: number; expired: number; expiredSinceDays: number };
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
  /** `PROVIDERS_DISABLED`: apagados por entorno, le ganan a todo. */
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
    const exponent = exponentOf(row.currency);

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
        exponent: exponentOf(currency),
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
      exponent: exponentOf(row.currency),
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

export function foldAttention(
  row: OverviewAttentionRow | undefined,
  postSale: readonly OverviewPostSaleRow[],
  recentDays: number,
): AttentionView {
  const platform = toNumber(row?.deposit_reports_platform);
  const network = toNumber(row?.deposit_reports_network);
  const byType = postSale
    .map((r) => ({ type: r.op_type, failed: toNumber(r.failed), stuck: toNumber(r.stuck) }))
    .filter((r) => r.failed > 0 || r.stuck > 0)
    .sort((a, b) => byText(a.type, b.type));
  return {
    depositReports: { total: platform + network, platform, network },
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

/**
 * Los códigos que nombra `PROVIDERS_DISABLED` (`código` o `código:ventas`, separados por coma), sin
 * repetir y en orden. El nivel de cada uno lo decide `killLevel`, que es quien lo aplica.
 */
export function killSwitchedCodes(raw: string | undefined): string[] {
  const codes = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const code = entry.split(':')[0]?.trim() ?? '';
    if (code !== '') codes.add(code);
  }
  return [...codes].sort(byText);
}
