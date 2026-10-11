import type { Route } from 'next';
import { STALE_AFTER_MS, sinceLabel } from './deposit-approvals';
import { providerMetaFor } from './provider-display';
import type { Viewer } from './viewer';
import { isCurrencyCode, isUuid } from './wallets';

/**
 * Plataforma → Resumen (`GET /admin/overview`): el período que se pide, la lectura de la respuesta y
 * los textos de la pantalla. Sin I/O.
 *
 * Nunca se suman montos de monedas distintas: cada monto viaja con su moneda y así se muestra. Lo que
 * sí se suma son cantidades (carteras, operaciones), que no tienen moneda.
 */

/** Adonde entra el superadmin al abrir el panel. */
export const PLATFORM_HOME: Route = '/admin/plataforma/resumen';

/**
 * Las invitaciones pendientes de toda la red. Hoy se ven en Equipo; cuando exista la consola de
 * usuarios de la plataforma (`/admin/plataforma/usuarios`), la tarjeta apunta allá.
 */
export const INVITATIONS_HREF: Route = '/admin/usuarios';

/** Los días del Resumen son de Bogotá, como en el API: Planetour opera desde Colombia. */
export const PLATFORM_TIME_ZONE = 'America/Bogota';

// ───────────────────────────── Período ─────────────────────────────

export type OverviewPeriodKey = 'today' | '7d' | '30d' | 'month';

export interface OverviewPeriodOption {
  readonly value: OverviewPeriodKey;
  readonly label: string;
  /** Cómo va en `?periodo=` de la pantalla. */
  readonly param: string;
}

export const OVERVIEW_PERIODS: readonly OverviewPeriodOption[] = [
  { value: 'today', label: 'Hoy', param: 'hoy' },
  { value: '7d', label: '7 días', param: '7d' },
  { value: '30d', label: '30 días', param: '30d' },
  { value: 'month', label: 'Este mes', param: 'mes' },
];

export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriodKey = '30d';

export function isOverviewPeriod(value: unknown): value is OverviewPeriodKey {
  return OVERVIEW_PERIODS.some((p) => p.value === value);
}

/** `?periodo=` de la pantalla; uno que no se conoce es el de siempre. */
export function periodFromParam(value: string | null | undefined): OverviewPeriodKey {
  return OVERVIEW_PERIODS.find((p) => p.param === value)?.value ?? DEFAULT_OVERVIEW_PERIOD;
}

export function periodParam(period: OverviewPeriodKey): string {
  return OVERVIEW_PERIODS.find((p) => p.value === period)?.param ?? '30d';
}

/** La URL de la pantalla con este período (y el nodo, si se acotó a uno). */
export function overviewHref(period: OverviewPeriodKey, tenantId: string | null): Route {
  const params = new URLSearchParams();
  if (period !== DEFAULT_OVERVIEW_PERIOD) params.set('periodo', periodParam(period));
  if (tenantId !== null) params.set('nodo', tenantId);
  const query = params.toString();
  return query === '' ? PLATFORM_HOME : `${PLATFORM_HOME}?${query}`;
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

const DAY_MS = 86_400_000;

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Los días, ambos incluidos, que pide cada período: el API recibe `from` y `to` en Bogotá. */
export function periodDates(
  period: OverviewPeriodKey,
  now: Date,
): { readonly from: string; readonly to: string } {
  const to = todayIn(PLATFORM_TIME_ZONE, now);
  switch (period) {
    case 'today':
      return { from: to, to };
    case '7d':
      return { from: addDays(to, -6), to };
    case 'month':
      return { from: `${to.slice(0, 7)}-01`, to };
    case '30d':
      return { from: addDays(to, -29), to };
  }
}

/** La query del BFF (`/api/admin/overview`). */
export function overviewSearch(period: OverviewPeriodKey, tenantId: string | null): string {
  const params = new URLSearchParams({ period });
  if (tenantId !== null) params.set('tenantId', tenantId);
  return params.toString();
}

// ───────────────────────────── La respuesta ─────────────────────────────

export interface Money {
  readonly currency: string;
  readonly exponent: number | null;
  readonly amountMinor: number;
}

export interface SalesByCurrency {
  readonly currency: string;
  readonly exponent: number | null;
  readonly confirmedCount: number;
  readonly confirmedAmountMinor: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
  readonly pendingCount: number;
  readonly averageTicketMinor: number | null;
}

export interface SalesByVertical {
  readonly vertical: string;
  readonly currency: string;
  readonly exponent: number | null;
  readonly count: number;
  readonly amountMinor: number;
}

export interface SalesByProvider {
  readonly provider: string;
  readonly currency: string;
  readonly exponent: number | null;
  readonly confirmedCount: number;
  readonly confirmedAmountMinor: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
  readonly pendingCount: number;
}

export interface OverviewSales {
  readonly byCurrency: readonly SalesByCurrency[];
  readonly byVertical: readonly SalesByVertical[];
  readonly byProvider: readonly SalesByProvider[];
  readonly quotations: { readonly created: number; readonly accepted: number };
}

export interface TrendPoint {
  readonly month: string;
  readonly count: number;
  readonly amountMinor: number;
}

export interface TrendSeries {
  readonly currency: string;
  readonly exponent: number | null;
  readonly points: readonly TrendPoint[];
}

export interface OverviewTrend {
  readonly months: readonly string[];
  readonly series: readonly TrendSeries[];
}

export interface TopNode {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
  readonly status: string;
  readonly confirmedCount: number;
  readonly amounts: readonly Money[];
}

export interface OverviewNetwork {
  readonly nodes: {
    readonly total: number;
    readonly active: number;
    readonly suspended: number;
    readonly consolidators: number;
    readonly agencies: number;
    readonly branches: number;
    readonly subagencies: number;
    readonly created: number;
  };
  readonly users: {
    readonly active: number;
    readonly locked: number;
    readonly adminsWithoutMfa: number;
    readonly loggedInPeriod: number;
  };
  readonly liveSessions: number;
}

export interface WalletExposure {
  readonly currency: string;
  readonly exponent: number | null;
  readonly wallets: number;
  readonly creditLimitMinor: number;
  readonly debtMinor: number;
  readonly fundsMinor: number;
  readonly overlimit: number;
  readonly suspended: number;
  readonly platformCreditLimitMinor: number;
  readonly platformDebtMinor: number;
}

export interface PostSaleType {
  readonly type: string;
  readonly failed: number;
  readonly stuck: number;
}

export interface OverviewAttention {
  readonly depositReports: {
    readonly total: number;
    readonly platform: number;
    readonly network: number;
  };
  readonly postSale: {
    readonly failed: number;
    readonly stuck: number;
    readonly byType: readonly PostSaleType[];
  };
  readonly hotelOrdersUnverified: number;
  readonly walletHoldConflicts: number;
  readonly reconciliation: {
    readonly critical: number;
    readonly warning: number;
    readonly sinceDays: number;
  };
  readonly invitations: {
    readonly pending: number;
    readonly expired: number;
    readonly expiredSinceDays: number;
  };
}

export type KillLevel = 'all' | 'sales';
export type CircuitState = 'open' | 'half-open';

export interface ProviderSignals {
  readonly killSwitched: readonly { readonly code: string; readonly level: KillLevel }[];
  readonly openCircuits: readonly { readonly code: string; readonly state: CircuitState }[];
  readonly disabledGlobally: readonly { readonly code: string; readonly reason: string | null }[];
}

export interface OverviewScope {
  readonly tenantId: string;
  readonly name: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
}

export interface PlatformOverview {
  /** ISO 8601: cuándo armó el API esta lectura. */
  readonly generatedAt: string;
  /** Días calendario de Bogotá, ambos incluidos. */
  readonly period: { readonly from: string; readonly to: string };
  /** `null` = toda la red. */
  readonly scope: OverviewScope | null;
  readonly sales: OverviewSales;
  readonly trend: OverviewTrend;
  readonly topNodes: readonly TopNode[];
  readonly network: OverviewNetwork;
  readonly wallets: readonly WalletExposure[];
  readonly attention: OverviewAttention;
  readonly providers: ProviderSignals;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Una cantidad o un monto en unidades menores: entero, no negativo. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function exponentOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4
    ? value
    : undefined;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

/**
 * Lee los campos numéricos de `r` que pide `keys`; `undefined` si falta o se rompió alguno. Un
 * contador que no se pudo leer no se convierte en cero: un cero diría "no hay nada".
 */
function counts<K extends string>(
  r: Rec | undefined,
  keys: readonly K[],
): Record<K, number> | undefined {
  if (r === undefined) return undefined;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const n = count(r[key]);
    if (n === undefined) return undefined;
    out[key] = n;
  }
  return out;
}

/** Una lista en la que cada elemento roto se descarta; la lista que no es lista, rompe la lectura. */
function list<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === undefined ? [] : [parsed];
  });
}

function currencyAndExponent(
  r: Rec | undefined,
): { currency: string; exponent: number | null } | undefined {
  const currency = r?.['currency'];
  const exponent = exponentOf(r?.['exponent']);
  if (!isCurrencyCode(currency) || exponent === undefined) return undefined;
  return { currency, exponent };
}

function parseSalesByCurrency(value: unknown): SalesByCurrency | undefined {
  const r = asRecord(value);
  const money = currencyAndExponent(r);
  const n = counts(r, [
    'confirmedCount',
    'confirmedAmountMinor',
    'cancelledCount',
    'failedCount',
    'pendingCount',
  ]);
  const average = r?.['averageTicketMinor'];
  if (money === undefined || n === undefined) return undefined;
  return { ...money, ...n, averageTicketMinor: count(average) ?? null };
}

function parseSalesByVertical(value: unknown): SalesByVertical | undefined {
  const r = asRecord(value);
  const money = currencyAndExponent(r);
  const vertical = text(r?.['vertical']);
  const n = counts(r, ['count', 'amountMinor']);
  if (money === undefined || vertical === undefined || n === undefined) return undefined;
  return { vertical, ...money, ...n };
}

function parseSalesByProvider(value: unknown): SalesByProvider | undefined {
  const r = asRecord(value);
  const money = currencyAndExponent(r);
  const provider = text(r?.['provider']);
  const n = counts(r, [
    'confirmedCount',
    'confirmedAmountMinor',
    'cancelledCount',
    'failedCount',
    'pendingCount',
  ]);
  if (money === undefined || provider === undefined || n === undefined) return undefined;
  return { provider, ...money, ...n };
}

function parseSales(value: unknown): OverviewSales | undefined {
  const r = asRecord(value);
  const byCurrency = list(r?.['byCurrency'], parseSalesByCurrency);
  const byVertical = list(r?.['byVertical'], parseSalesByVertical);
  const byProvider = list(r?.['byProvider'], parseSalesByProvider);
  const quotations = counts(asRecord(r?.['quotations']), ['created', 'accepted']);
  if (byCurrency === undefined || byVertical === undefined || byProvider === undefined) {
    return undefined;
  }
  return {
    byCurrency,
    byVertical,
    byProvider,
    quotations: quotations ?? { created: 0, accepted: 0 },
  };
}

function parseTrend(value: unknown): OverviewTrend {
  const r = asRecord(value);
  const rawMonths: unknown = r?.['months'];
  const months = Array.isArray(rawMonths)
    ? rawMonths.filter((m): m is string => typeof m === 'string' && ISO_MONTH.test(m))
    : [];
  const series =
    list(r?.['series'], (item): TrendSeries | undefined => {
      const s = asRecord(item);
      const money = currencyAndExponent(s);
      const points = list(s?.['points'], (p): TrendPoint | undefined => {
        const point = asRecord(p);
        const month = point?.['month'];
        const n = counts(point, ['count', 'amountMinor']);
        return typeof month === 'string' && ISO_MONTH.test(month) && n !== undefined
          ? { month, ...n }
          : undefined;
      });
      if (money === undefined || points === undefined) return undefined;
      // Un punto por mes de `months`, en su orden: un mes que no vino es un mes sin ventas.
      return {
        ...money,
        points: months.map(
          (month) => points.find((p) => p.month === month) ?? { month, count: 0, amountMinor: 0 },
        ),
      };
    }) ?? [];
  return { months, series };
}

function parseMoney(value: unknown): Money | undefined {
  const r = asRecord(value);
  const money = currencyAndExponent(r);
  const amountMinor = count(r?.['amountMinor']);
  return money === undefined || amountMinor === undefined ? undefined : { ...money, amountMinor };
}

function parseTopNode(value: unknown): TopNode | undefined {
  const r = asRecord(value);
  const tenantId = r?.['tenantId'];
  const name = text(r?.['name']);
  const confirmedCount = count(r?.['confirmedCount']);
  const amounts = list(r?.['amounts'], parseMoney);
  if (!isUuid(tenantId) || name === undefined || confirmedCount === undefined) return undefined;
  return {
    tenantId: tenantId.toLowerCase(),
    name,
    slug: text(r?.['slug']) ?? '',
    tenantType: text(r?.['tenantType']) ?? '',
    isBranch: r?.['isBranch'] === true,
    status: text(r?.['status']) ?? 'active',
    confirmedCount,
    amounts: amounts ?? [],
  };
}

function parseNetwork(value: unknown): OverviewNetwork | undefined {
  const r = asRecord(value);
  const nodes = counts(asRecord(r?.['nodes']), [
    'total',
    'active',
    'suspended',
    'consolidators',
    'agencies',
    'branches',
    'subagencies',
    'created',
  ]);
  const users = counts(asRecord(r?.['users']), [
    'active',
    'locked',
    'adminsWithoutMfa',
    'loggedInPeriod',
  ]);
  const liveSessions = count(r?.['liveSessions']);
  if (nodes === undefined || users === undefined || liveSessions === undefined) return undefined;
  return { nodes, users, liveSessions };
}

function parseWallet(value: unknown): WalletExposure | undefined {
  const r = asRecord(value);
  const money = currencyAndExponent(r);
  const n = counts(r, [
    'wallets',
    'creditLimitMinor',
    'debtMinor',
    'fundsMinor',
    'overlimit',
    'suspended',
    'platformCreditLimitMinor',
    'platformDebtMinor',
  ]);
  return money === undefined || n === undefined ? undefined : { ...money, ...n };
}

function parseAttention(value: unknown): OverviewAttention | undefined {
  const r = asRecord(value);
  const depositReports = counts(asRecord(r?.['depositReports']), ['total', 'platform', 'network']);
  const postSaleRec = asRecord(r?.['postSale']);
  const postSale = counts(postSaleRec, ['failed', 'stuck']);
  const byType = list(postSaleRec?.['byType'], (item): PostSaleType | undefined => {
    const t = asRecord(item);
    const type = text(t?.['type']);
    const n = counts(t, ['failed', 'stuck']);
    return type === undefined || n === undefined ? undefined : { type, ...n };
  });
  const single = counts(r, ['hotelOrdersUnverified', 'walletHoldConflicts']);
  const reconciliation = counts(asRecord(r?.['reconciliation']), [
    'critical',
    'warning',
    'sinceDays',
  ]);
  const invitations = counts(asRecord(r?.['invitations']), [
    'pending',
    'expired',
    'expiredSinceDays',
  ]);
  if (
    depositReports === undefined ||
    postSale === undefined ||
    byType === undefined ||
    single === undefined ||
    reconciliation === undefined ||
    invitations === undefined
  ) {
    return undefined;
  }
  return {
    depositReports,
    postSale: { ...postSale, byType },
    ...single,
    reconciliation,
    invitations,
  };
}

function parseProviders(value: unknown): ProviderSignals | undefined {
  const r = asRecord(value);
  const killSwitched = list(
    r?.['killSwitched'],
    (item): ProviderSignals['killSwitched'][number] | undefined => {
      const k = asRecord(item);
      const code = text(k?.['code']);
      const level = k?.['level'];
      return code !== undefined && (level === 'all' || level === 'sales')
        ? { code, level }
        : undefined;
    },
  );
  const openCircuits = list(
    r?.['openCircuits'],
    (item): ProviderSignals['openCircuits'][number] | undefined => {
      const c = asRecord(item);
      const code = text(c?.['code']);
      const state = c?.['state'];
      return code !== undefined && (state === 'open' || state === 'half-open')
        ? { code, state }
        : undefined;
    },
  );
  const disabledGlobally = list(r?.['disabledGlobally'], (item) => {
    const d = asRecord(item);
    const code = text(d?.['code']);
    return code === undefined ? undefined : { code, reason: text(d?.['reason']) ?? null };
  });
  if (killSwitched === undefined || openCircuits === undefined || disabledGlobally === undefined) {
    return undefined;
  }
  return { killSwitched, openCircuits, disabledGlobally };
}

function parseScope(value: unknown): OverviewScope | null | undefined {
  if (value === null || value === undefined) return null;
  const r = asRecord(value);
  const tenantId = r?.['tenantId'];
  const name = text(r?.['name']);
  if (!isUuid(tenantId) || name === undefined) return undefined;
  return {
    tenantId: tenantId.toLowerCase(),
    name,
    tenantType: text(r?.['tenantType']) ?? '',
    isBranch: r?.['isBranch'] === true,
  };
}

/**
 * La respuesta del Resumen. Si lo que espera a una persona, las ventas, la red o los proveedores no
 * se pueden leer, la respuesta entera es ilegible: mostrar "Todo en orden" sobre un contador que no
 * se leyó sería mentir. Una fila rota de una lista se descarta; un valor que esta versión no conoce
 * (un nivel de apagado, un estado de circuito) se ignora.
 */
export function parsePlatformOverview(value: unknown): PlatformOverview | undefined {
  const r = asRecord(value);
  const generatedAt = text(r?.['generatedAt']);
  const periodRec = asRecord(r?.['period']);
  const from = periodRec?.['from'];
  const to = periodRec?.['to'];
  const scope = parseScope(r?.['scope']);
  const sales = parseSales(r?.['sales']);
  const network = parseNetwork(r?.['network']);
  const attention = parseAttention(r?.['attention']);
  const providers = parseProviders(r?.['providers']);
  if (
    generatedAt === undefined ||
    Number.isNaN(Date.parse(generatedAt)) ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !ISO_DAY.test(from) ||
    !ISO_DAY.test(to) ||
    scope === undefined ||
    sales === undefined ||
    network === undefined ||
    attention === undefined ||
    providers === undefined
  ) {
    return undefined;
  }
  return {
    generatedAt,
    period: { from, to },
    scope,
    sales,
    trend: parseTrend(r?.['trend']),
    topNodes: list(r?.['topNodes'], parseTopNode) ?? [],
    network,
    wallets: list(r?.['wallets'], parseWallet) ?? [],
    attention,
    providers,
  };
}

// ───────────────────────────── Requiere tu atención ─────────────────────────────

export type Severity = 'critical' | 'warning' | 'info';

/** La severidad se lee: va escrita e ícono aparte, nunca sólo en el color. */
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  critical: 'Urgente',
  warning: 'Revisar',
  info: 'Aviso',
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, info: 2 };

export type AttentionId =
  | 'providers'
  | 'wallet-holds'
  | 'post-sale'
  | 'deposits'
  | 'hotel-orders'
  | 'reconciliation'
  | 'wallets'
  | 'security'
  | 'invitations';

/** A igual severidad, lo que corta la venta o toca plata va primero. */
const ATTENTION_ORDER: readonly AttentionId[] = [
  'providers',
  'wallet-holds',
  'post-sale',
  'deposits',
  'hotel-orders',
  'reconciliation',
  'wallets',
  'security',
  'invitations',
];

export interface AttentionAction {
  readonly label: string;
  readonly href: Route;
}

export interface AttentionItem {
  readonly id: AttentionId;
  readonly severity: Severity;
  readonly title: string;
  readonly summary: string;
  readonly details: readonly string[];
  readonly action?: AttentionAction;
}

/** "1 operación" / "3 operaciones". */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** El nombre legible de un proveedor; uno sin ficha, por su código. */
export function providerName(code: string): string {
  return providerMetaFor(code).name;
}

function providersItem(providers: ProviderSignals): AttentionItem | undefined {
  const lines = [
    ...providers.openCircuits.map((c) =>
      c.state === 'open'
        ? `${providerName(c.code)}: no está respondiendo`
        : `${providerName(c.code)}: se está recuperando, lo probamos con pocas búsquedas`,
    ),
    ...providers.killSwitched.map(
      (k) =>
        `${providerName(k.code)}: apagado de emergencia (${k.level === 'sales' ? 'solo ventas' : 'ventas y post-venta'})`,
    ),
    ...providers.disabledGlobally.map(
      (d) =>
        `${providerName(d.code)}: apagado para toda la plataforma${d.reason !== null ? ` · ${d.reason}` : ''}`,
    ),
  ];
  if (lines.length === 0) return undefined;
  const codes = new Set([
    ...providers.openCircuits.map((c) => c.code),
    ...providers.killSwitched.map((k) => k.code),
    ...providers.disabledGlobally.map((d) => d.code),
  ]);
  const severity: Severity =
    providers.openCircuits.some((c) => c.state === 'open') ||
    providers.killSwitched.some((k) => k.level === 'all')
      ? 'critical'
      : providers.openCircuits.length > 0 || providers.killSwitched.length > 0
        ? 'warning'
        : 'info';
  return {
    id: 'providers',
    severity,
    title: 'Proveedores',
    summary:
      codes.size === 1
        ? '1 proveedor no está vendiendo con normalidad.'
        : `${codes.size} proveedores no están vendiendo con normalidad.`,
    details: lines,
    action: { label: 'Ver proveedores', href: '/admin/plataforma/proveedores' },
  };
}

function walletHoldsItem(attention: OverviewAttention): AttentionItem | undefined {
  const n = attention.walletHoldConflicts;
  if (n === 0) return undefined;
  return {
    id: 'wallet-holds',
    severity: 'critical',
    title: 'Retenciones de cartera en conflicto',
    summary:
      n === 1
        ? '1 retención figuró confirmada con el proveedor y después no: hay que conciliarla a mano.'
        : `${n} retenciones figuraron confirmadas con el proveedor y después no: hay que conciliarlas a mano.`,
    details: [],
  };
}

/** Cómo se nombra cada tipo de operación de post-venta en el Resumen. */
const POST_SALE_TYPE_LABEL: Readonly<Record<string, string>> = {
  cancel: 'Cancelaciones',
  pay: 'Pagos y emisiones',
  reshop: 'Reemisiones',
  retrieve: 'Consultas de estado',
  'hcn-check': 'Consultas del número de confirmación del hotel',
  'hcn-ticket': 'Tareas para conseguir el número de confirmación del hotel',
  reconcile: 'Conciliaciones con el proveedor',
};

/** Un tipo que esta versión no conoce sale por su código: al menos es diagnosticable. */
export function postSaleTypeLabel(type: string): string {
  return POST_SALE_TYPE_LABEL[type] ?? type;
}

function postSaleLine(row: PostSaleType): string {
  const parts: string[] = [];
  if (row.failed > 0) parts.push(row.failed === 1 ? '1 fallida' : `${row.failed} fallidas`);
  if (row.stuck > 0) {
    // La tarea de operaciones no se traba: queda abierta hasta que alguien consigue el número.
    parts.push(
      row.type === 'hcn-ticket'
        ? row.stuck === 1
          ? '1 abierta'
          : `${row.stuck} abiertas`
        : `${row.stuck} sin terminar`,
    );
  }
  return `${postSaleTypeLabel(row.type)}: ${parts.join(' · ')}`;
}

function postSaleItem(attention: OverviewAttention): AttentionItem | undefined {
  const { failed, stuck, byType } = attention.postSale;
  if (failed === 0 && stuck === 0) return undefined;
  const failedText = `${plural(failed, 'operación', 'operaciones')} ${failed === 1 ? 'falló' : 'fallaron'}`;
  const stuckText = `${stuck === 1 ? 'sigue' : 'siguen'} sin terminar`;
  const summary =
    failed > 0 && stuck > 0
      ? `${failedText} y ${stuck} ${stuckText}.`
      : failed > 0
        ? `${failedText}.`
        : `${plural(stuck, 'operación', 'operaciones')} ${stuckText} hace rato.`;
  return {
    id: 'post-sale',
    severity: failed > 0 ? 'critical' : 'warning',
    title: 'Post-venta con problemas',
    summary,
    details: byType.filter((t) => t.failed > 0 || t.stuck > 0).map(postSaleLine),
  };
}

function depositsItem(
  attention: OverviewAttention,
  oldestPlatformDeposit: string | null | undefined,
  now: number,
): AttentionItem | undefined {
  const { platform, network } = attention.depositReports;
  if (platform === 0 && network === 0) return undefined;
  const action: AttentionAction = {
    label: 'Revisar depósitos',
    href: '/admin/plataforma/aprobaciones',
  };
  const networkLine =
    network === 1
      ? '1 espera a otro nodo de la red, que normalmente lo aprueba.'
      : `${network} esperan a otros nodos de la red, que normalmente los aprueban.`;
  if (platform === 0) {
    return {
      id: 'deposits',
      severity: 'info',
      title: 'Depósitos por aprobar',
      summary:
        network === 1
          ? '1 depósito espera a otro nodo de la red.'
          : `${network} depósitos esperan a otros nodos de la red.`,
      details: ['Normalmente los aprueba el nodo que financia a cada agencia.'],
      action,
    };
  }
  const oldest =
    oldestPlatformDeposit !== null && oldestPlatformDeposit !== undefined
      ? sinceLabel(oldestPlatformDeposit, now)
      : '';
  const stale =
    oldestPlatformDeposit !== null &&
    oldestPlatformDeposit !== undefined &&
    now - Date.parse(oldestPlatformDeposit) >= STALE_AFTER_MS;
  const head =
    platform === 1
      ? '1 depósito espera tu aprobación'
      : `${platform} depósitos esperan tu aprobación`;
  const age =
    oldest === '' ? '' : platform === 1 ? ` · informado ${oldest}` : ` · el más antiguo ${oldest}`;
  return {
    id: 'deposits',
    // Pasadas 48 horas, un depósito sin revisar es una agencia que no puede reservar.
    severity: stale ? 'critical' : 'warning',
    title: 'Depósitos por aprobar',
    summary: `${head}${age}.`,
    details: network > 0 ? [networkLine] : [],
    action,
  };
}

function hotelOrdersItem(attention: OverviewAttention): AttentionItem | undefined {
  const n = attention.hotelOrdersUnverified;
  if (n === 0) return undefined;
  return {
    id: 'hotel-orders',
    severity: 'warning',
    title: 'Reservas de hotel sin verificar',
    summary:
      n === 1
        ? '1 reserva de hotel no tiene su estado confirmado con el proveedor.'
        : `${n} reservas de hotel no tienen su estado confirmado con el proveedor.`,
    details: [],
  };
}

function reconciliationItem(attention: OverviewAttention): AttentionItem | undefined {
  const { critical, warning, sinceDays } = attention.reconciliation;
  if (critical === 0 && warning === 0) return undefined;
  const parts = [
    critical > 0 ? plural(critical, 'diferencia crítica', 'diferencias críticas') : null,
    warning > 0 ? plural(warning, 'advertencia', 'advertencias') : null,
  ].filter((p): p is string => p !== null);
  return {
    id: 'reconciliation',
    severity: critical > 0 ? 'critical' : 'info',
    title: 'Conciliación con los proveedores',
    summary: `${parts.join(' y ')} en los últimos ${sinceDays} días.`,
    details: [],
  };
}

function walletsItem(wallets: readonly WalletExposure[]): AttentionItem | undefined {
  const over = wallets.filter((w) => w.overlimit > 0);
  if (over.length === 0) return undefined;
  const total = over.reduce((n, w) => n + w.overlimit, 0);
  return {
    id: 'wallets',
    severity: 'warning',
    title: 'Carteras sobre el cupo',
    summary: total === 1 ? '1 cartera pasó su cupo.' : `${total} carteras pasaron su cupo.`,
    details: over.map((w) => `${w.currency}: ${plural(w.overlimit, 'cartera', 'carteras')}`),
  };
}

function securityItem(network: OverviewNetwork): AttentionItem | undefined {
  const { adminsWithoutMfa, locked } = network.users;
  const lines = [
    adminsWithoutMfa > 0
      ? adminsWithoutMfa === 1
        ? '1 administrador no activó la verificación en dos pasos.'
        : `${adminsWithoutMfa} administradores no activaron la verificación en dos pasos.`
      : null,
    locked > 0
      ? locked === 1
        ? '1 cuenta está bloqueada por intentos fallidos.'
        : `${locked} cuentas están bloqueadas por intentos fallidos.`
      : null,
  ].filter((l): l is string => l !== null);
  const [summary, ...details] = lines;
  if (summary === undefined) return undefined;
  return { id: 'security', severity: 'info', title: 'Seguridad de las cuentas', summary, details };
}

function invitationsItem(attention: OverviewAttention): AttentionItem | undefined {
  const { pending, expired, expiredSinceDays } = attention.invitations;
  if (pending === 0 && expired === 0) return undefined;
  const parts = [
    pending > 0 ? `${pending} ${pending === 1 ? 'pendiente' : 'pendientes'} de aceptar` : null,
    expired > 0
      ? `${expired} ${expired === 1 ? 'venció' : 'vencieron'} sin aceptar en los últimos ${expiredSinceDays} días`
      : null,
  ].filter((p): p is string => p !== null);
  return {
    id: 'invitations',
    severity: 'info',
    title: 'Invitaciones',
    summary: `${parts.join(' · ')}.`,
    details: [],
    action: { label: 'Ver invitaciones', href: INVITATIONS_HREF },
  };
}

/**
 * Lo que espera a una persona, de lo más grave a lo menos: sólo lo que tiene algo. Sin nada, la
 * pantalla dice "Todo en orden".
 *
 * `oldestPlatformDeposit`: cuándo se informó el depósito más viejo que espera a Planetour, si se sabe
 * (`undefined` mientras no se leyó, `null` si no hay).
 */
export function attentionItems(
  overview: Pick<PlatformOverview, 'attention' | 'providers' | 'wallets' | 'network'>,
  oldestPlatformDeposit: string | null | undefined,
  now: number,
): AttentionItem[] {
  const items = [
    providersItem(overview.providers),
    walletHoldsItem(overview.attention),
    postSaleItem(overview.attention),
    depositsItem(overview.attention, oldestPlatformDeposit, now),
    hotelOrdersItem(overview.attention),
    reconciliationItem(overview.attention),
    walletsItem(overview.wallets),
    securityItem(overview.network),
    invitationsItem(overview.attention),
  ].filter((item): item is AttentionItem => item !== undefined);
  return items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      ATTENTION_ORDER.indexOf(a.id) - ATTENTION_ORDER.indexOf(b.id),
  );
}

// ───────────────────────────── Textos ─────────────────────────────

const VERTICAL_LABEL: Readonly<Record<string, string>> = {
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
  assistance: 'Asistencia al viajero',
};

export function salesVerticalLabel(vertical: string): string {
  return VERTICAL_LABEL[vertical] ?? vertical;
}

/**
 * Un promedio en unidades enteras de la moneda: los centavos de un ticket promedio no dicen nada y
 * sólo agregan ruido ("$ 1.541.666,67" → "$ 1.541.667").
 */
export function wholeUnits(minor: number, exponent: number | null): number {
  const factor = 10 ** (exponent ?? 2);
  return Math.round(minor / factor) * factor;
}

/** "Actualizado hace 3 minutos", "Actualizado ayer". */
export function updatedLabel(generatedAt: string, now: number): string {
  const since = sinceLabel(generatedAt, now);
  return since === '' ? '' : `Actualizado ${since}`;
}

function utcDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

const DAY_MONTH = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Del 12 de septiembre al 11 de octubre de 2026", o un solo día. */
export function periodCaption(period: { readonly from: string; readonly to: string }): string {
  const from = utcDay(period.from);
  const to = utcDay(period.to);
  if (period.from === period.to) return DAY_MONTH_YEAR.format(to);
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  return `Del ${(sameYear ? DAY_MONTH : DAY_MONTH_YEAR).format(from)} al ${DAY_MONTH_YEAR.format(to)}`;
}

const MONTH_YEAR = new Intl.DateTimeFormat('es-CO', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `2026-10` → "octubre de 2026". */
export function monthLabel(month: string): string {
  if (!ISO_MONTH.test(month)) return month;
  return MONTH_YEAR.format(utcDay(`${month}-01`));
}

/** El mensaje de un Resumen que no se pudo leer. */
export function overviewErrorMessage(status: number, apiMessage?: string): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  const fromApi = apiMessage?.trim();
  if ((status === 400 || status === 403 || status === 404) && fromApi) return fromApi;
  if (status === 403) return 'Sólo el superadmin de la plataforma ve el resumen de toda la red.';
  if (status === 404) return 'Ese nodo no existe: mira toda la red.';
  if (status === 400) return 'Ese período no se puede leer: elige otro.';
  return 'No pudimos cargar el resumen. Reintenta en unos segundos.';
}

// ───────────────────────────── Entrada al panel ─────────────────────────────

/**
 * ¿El panel abre en Plataforma → Resumen? Sólo si la agencia activa es la de la plataforma con rol
 * superadmin: es el mismo criterio con que `/admin/plataforma` deja pasar, así que `/` nunca manda a
 * una pantalla que lo devuelve a `/`. Si opera como vendedor de una sucursal, ve su Inicio.
 */
export function shouldLandOnPlatformOverview(role: string | undefined, viewer: Viewer): boolean {
  return role === 'superadmin' && viewer.superadmin;
}
