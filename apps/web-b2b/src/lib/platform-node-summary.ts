import type { Route } from 'next';
import {
  ATTENTION_REASON_LABEL,
  ATTENTION_REASON_PRIORITY,
  CRITICAL_REASONS,
  ORDER_ATTENTION_REASONS,
  type OrderAttentionReason,
} from './attention-labels';
import {
  DEFAULT_ACTIVITY_FILTERS,
  activityHref,
  presetRange,
  type ActivityFilters,
} from './platform-audit';
import { parseHeld, parseNodeStats, type HeldAmount, type NodeStats } from './platform-node-stats';
import { DEFAULT_ORDERS_FILTERS, ordersHref } from './platform-orders';
import { providerMetaFor } from './provider-display';
import type { TenantProviders } from './provider-enablement';
import { isCurrencyCode, isUuid } from './wallets';

/**
 * La pestaña Resumen de cada nodo en Agencias (`GET /admin/tenants/:id/summary`): la lectura de la
 * respuesta, a dónde lleva cada número y los textos de la pantalla. Sin I/O.
 *
 * Cada sección se lee aparte: la que el API no pudo leer (`null`) o que llega con una forma que no se
 * entiende queda "sin leer" y el resto se pinta. Nunca se suman montos de monedas distintas.
 */

// ───────────────────────────── Las pestañas del nodo ─────────────────────────────

export type NodeTab = 'summary' | 'providers' | 'wallets' | 'seats';

/**
 * A dónde lleva cada pestaña. Proveedores sigue en `/admin/tenants/:id` para no romper los enlaces
 * que ya circulan (la guía de hoteles, Proveedores de la plataforma).
 */
export function nodeTabHref(tenantId: string, tab: NodeTab): Route {
  const id = tenantId.toLowerCase();
  switch (tab) {
    case 'summary':
      return `/admin/tenants/${id}/resumen`;
    case 'providers':
      return `/admin/tenants/${id}`;
    case 'wallets':
      return `/admin/tenants/${id}/carteras`;
    case 'seats':
      return `/admin/tenants/${id}/puestos`;
  }
}

/** Reservas de la red acotada al nodo y su red: las vigentes o las que necesitan a una persona. */
export function nodeOrdersHref(tenantId: string, view: 'open' | 'attention'): Route {
  return ordersHref({
    ...DEFAULT_ORDERS_FILTERS,
    tenantId: tenantId.toLowerCase(),
    subtree: true,
    attention: view === 'attention',
    statuses: view === 'open' ? ['pending', 'confirmed', 'ticketed'] : [],
  });
}

/** Los días de la actividad reciente: los mismos que las ventas. */
export const NODE_ACTIVITY_DAYS = 30;
/** Cuántos eventos trae la actividad reciente. */
export const NODE_ACTIVITY_LIMIT = 10;

/** Los filtros de la actividad del nodo y su red en los últimos 30 días (hora de Bogotá). */
export function nodeActivityFilters(tenantId: string, now: Date): ActivityFilters {
  return {
    ...DEFAULT_ACTIVITY_FILTERS,
    ...presetRange('30d', now),
    tenantId: tenantId.toLowerCase(),
  };
}

/** Plataforma → Actividad acotada al nodo y su red, en el mismo período que la lista. */
export function nodeActivityHref(tenantId: string, now: Date): Route {
  return activityHref(nodeActivityFilters(tenantId, now));
}

// ───────────────────────────── La respuesta ─────────────────────────────

export interface NodeSummaryTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
  readonly status: string;
  /** `null` en la raíz de la red. */
  readonly parent: { readonly id: string; readonly name: string } | null;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  /** ISO 8601, o `''` si no vino. */
  readonly createdAt: string;
}

/** El nodo con todo lo que cuelga de él. */
export interface NodeSubtree {
  readonly descendants: number;
  /** Personas distintas con acceso activo: una con dos nodos cuenta una vez. */
  readonly activeUsers: number;
  readonly liveSessions: number;
  readonly openOrders: number;
  readonly held: readonly HeldAmount[];
  readonly pendingDepositReports: number;
  readonly pendingInvitations: number;
}

export interface NodeSalesVertical {
  readonly vertical: string;
  readonly confirmedCount: number;
  readonly confirmedAmountMinor: number;
}

/** Las reservas del período en una moneda; "ventas" son las confirmadas o emitidas. */
export interface NodeSales {
  readonly currency: string;
  readonly exponent: number | null;
  readonly ordersCount: number;
  readonly confirmedCount: number;
  readonly confirmedAmountMinor: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
  readonly byVertical: readonly NodeSalesVertical[];
}

export interface NodeSummarySales {
  readonly days: number;
  readonly own: readonly NodeSales[];
  readonly subtree: readonly NodeSales[];
}

/** Las reservas de su red que necesitan a una persona. */
export interface NodeAttention {
  /** Reservas distintas. */
  readonly total: number;
  /** Una reserva con dos motivos cuenta en los dos. */
  readonly byReason: Readonly<Record<OrderAttentionReason, number>>;
}

export interface NodeSummary {
  readonly generatedAt: string;
  readonly tenant: NodeSummaryTenant;
  /** `null`: no se pudo leer. */
  readonly own: NodeStats | null;
  readonly subtree: NodeSubtree | null;
  readonly sales: NodeSummarySales | null;
  readonly attention: NodeAttention | null;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function minor(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseTenant(value: unknown): NodeSummaryTenant | undefined {
  const r = asRecord(value);
  const id = r?.['id'];
  const name = str(r?.['name']);
  const tenantType = str(r?.['tenantType']);
  const status = str(r?.['status']);
  if (r === undefined || !isUuid(id) || name === undefined) return undefined;
  if (tenantType === undefined || status === undefined) return undefined;
  const p = asRecord(r['parent']);
  const parentId = p?.['id'];
  const parentName = str(p?.['name']);
  return {
    id: id.toLowerCase(),
    name,
    slug: str(r['slug']) ?? '',
    tenantType,
    isBranch: r['isBranch'] === true,
    status,
    parent:
      isUuid(parentId) && parentName !== undefined
        ? { id: parentId.toLowerCase(), name: parentName }
        : null,
    countryCode: str(r['countryCode']) ?? '',
    defaultCurrency: str(r['defaultCurrency']) ?? '',
    createdAt: str(r['createdAt']) ?? '',
  };
}

function parseSubtree(value: unknown): NodeSubtree | null {
  const r = asRecord(value);
  if (r === undefined) return null;
  const held = parseHeld(r['held']);
  const numbers = {
    descendants: count(r['descendants']),
    activeUsers: count(r['activeUsers']),
    liveSessions: count(r['liveSessions']),
    openOrders: count(r['openOrders']),
    pendingDepositReports: count(r['pendingDepositReports']),
    pendingInvitations: count(r['pendingInvitations']),
  };
  if (held === undefined || Object.values(numbers).some((n) => n === undefined)) return null;
  return {
    descendants: numbers.descendants ?? 0,
    activeUsers: numbers.activeUsers ?? 0,
    liveSessions: numbers.liveSessions ?? 0,
    openOrders: numbers.openOrders ?? 0,
    held,
    pendingDepositReports: numbers.pendingDepositReports ?? 0,
    pendingInvitations: numbers.pendingInvitations ?? 0,
  };
}

function parseSalesList(value: unknown): NodeSales[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: NodeSales[] = [];
  for (const item of value) {
    const r = asRecord(item);
    const currency = r?.['currency'];
    const exponent = r?.['exponent'];
    const n = {
      ordersCount: count(r?.['ordersCount']),
      confirmedCount: count(r?.['confirmedCount']),
      cancelledCount: count(r?.['cancelledCount']),
      failedCount: count(r?.['failedCount']),
    };
    const amount = minor(r?.['confirmedAmountMinor']);
    const verticals = r?.['byVertical'];
    if (!isCurrencyCode(currency) || amount === undefined || !Array.isArray(verticals)) {
      return undefined;
    }
    if (Object.values(n).some((v) => v === undefined)) return undefined;
    const byVertical: NodeSalesVertical[] = [];
    for (const v of verticals) {
      const vr = asRecord(v);
      const vertical = str(vr?.['vertical']);
      const vCount = count(vr?.['confirmedCount']);
      const vAmount = minor(vr?.['confirmedAmountMinor']);
      if (vertical === undefined || vCount === undefined || vAmount === undefined) {
        return undefined;
      }
      byVertical.push({ vertical, confirmedCount: vCount, confirmedAmountMinor: vAmount });
    }
    out.push({
      currency,
      exponent:
        typeof exponent === 'number' && Number.isInteger(exponent) && exponent >= 0
          ? exponent
          : null,
      ordersCount: n.ordersCount ?? 0,
      confirmedCount: n.confirmedCount ?? 0,
      confirmedAmountMinor: amount,
      cancelledCount: n.cancelledCount ?? 0,
      failedCount: n.failedCount ?? 0,
      byVertical,
    });
  }
  return out;
}

function parseSales(value: unknown): NodeSummarySales | null {
  const r = asRecord(value);
  const days = count(r?.['days']);
  const own = parseSalesList(r?.['own']);
  const subtree = parseSalesList(r?.['subtree']);
  if (days === undefined || own === undefined || subtree === undefined) return null;
  return { days, own, subtree };
}

function parseAttention(value: unknown): NodeAttention | null {
  const r = asRecord(value);
  const total = count(r?.['total']);
  const raw = asRecord(r?.['byReason']);
  if (total === undefined || raw === undefined) return null;
  const byReason = Object.fromEntries(
    ORDER_ATTENTION_REASONS.map((reason) => [reason, count(raw[reason]) ?? 0]),
  ) as Record<OrderAttentionReason, number>;
  return { total, byReason };
}

/**
 * La ficha que mandó el API. Sin el nodo no hay ficha (`undefined`); una sección que no se puede
 * leer queda en `null`, como si el API no la hubiera podido leer.
 */
export function parseNodeSummary(value: unknown): NodeSummary | undefined {
  const r = asRecord(value);
  const tenant = parseTenant(r?.['tenant']);
  if (r === undefined || tenant === undefined) return undefined;
  const own = r['own'] === null ? null : (parseNodeStats(r['own']) ?? null);
  return {
    generatedAt: str(r['generatedAt']) ?? '',
    tenant,
    own: own !== null && own.tenantId === tenant.id ? own : null,
    subtree: parseSubtree(r['subtree']),
    sales: parseSales(r['sales']),
    attention: parseAttention(r['attention']),
  };
}

// ───────────────────────────── Lo que se muestra ─────────────────────────────

/** "1 reserva", "3 reservas". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('es-CO')} ${n === 1 ? one : many}`;
}

/** Una moneda de las ventas: lo del nodo y lo del nodo con su red (cualquiera puede faltar). */
export interface SalesTile {
  readonly currency: string;
  readonly exponent: number | null;
  readonly own: NodeSales | null;
  readonly subtree: NodeSales | null;
}

/**
 * Una tarjeta por moneda en la que el nodo o su red reservaron. Primero la moneda del nodo y después
 * por código: nunca se suman monedas.
 */
export function salesTiles(sales: NodeSummarySales, defaultCurrency: string): SalesTile[] {
  const currencies = new Set([...sales.own, ...sales.subtree].map((s) => s.currency));
  return [...currencies]
    .sort((a, b) =>
      a === defaultCurrency ? -1 : b === defaultCurrency ? 1 : a < b ? -1 : a > b ? 1 : 0,
    )
    .map((currency) => {
      const own = sales.own.find((s) => s.currency === currency) ?? null;
      const subtree = sales.subtree.find((s) => s.currency === currency) ?? null;
      return { currency, exponent: (own ?? subtree)?.exponent ?? null, own, subtree };
    });
}

/** "2 confirmadas · 1 cancelada · 1 fallida · 1 en curso". */
export function salesCountsLabel(sales: NodeSales | null): string {
  if (sales === null) return 'Sin reservas';
  const pending =
    sales.ordersCount - sales.confirmedCount - sales.cancelledCount - sales.failedCount;
  const parts = [plural(sales.confirmedCount, 'confirmada', 'confirmadas')];
  if (sales.cancelledCount > 0) parts.push(plural(sales.cancelledCount, 'cancelada', 'canceladas'));
  if (sales.failedCount > 0) parts.push(plural(sales.failedCount, 'fallida', 'fallidas'));
  if (pending > 0) parts.push(`${pending.toLocaleString('es-CO')} en curso`);
  return parts.join(' · ');
}

/** Un motivo con reservas, para la tarjeta "Requieren atención". */
export interface AttentionReasonLine {
  readonly reason: OrderAttentionReason;
  readonly label: string;
  readonly count: number;
  readonly critical: boolean;
}

/** Los motivos con alguna reserva, de lo más grave a lo menos. */
export function attentionLines(attention: NodeAttention): AttentionReasonLine[] {
  return ATTENTION_REASON_PRIORITY.flatMap((reason) => {
    const n = attention.byReason[reason];
    return n > 0
      ? [
          {
            reason,
            label: ATTENTION_REASON_LABEL[reason],
            count: n,
            critical: CRITICAL_REASONS.has(reason),
          },
        ]
      : [];
  });
}

/** Lo retenido de las carteras del nodo en una moneda, o `null`. */
export function heldIn(held: readonly HeldAmount[], currency: string): HeldAmount | null {
  return held.find((h) => h.currency === currency && h.amountMinor !== 0) ?? null;
}

/** El texto de "con su red" de un número, sólo si cuelgan nodos de él. */
export function withNetworkLabel(subtree: NodeSubtree | null, value: number): string | undefined {
  if (subtree === null || subtree.descendants === 0) return undefined;
  return `Con su red: ${value.toLocaleString('es-CO')}`;
}

/** "Cuelgan 3 nodos", "Cuelga 1 nodo", o nada. */
export function descendantsLabel(subtree: NodeSubtree | null): string | null {
  if (subtree === null || subtree.descendants === 0) return null;
  return subtree.descendants === 1
    ? 'Cuelga 1 nodo de él'
    : `Cuelgan ${subtree.descendants.toLocaleString('es-CO')} nodos de él`;
}

export const NODE_SUMMARY_EMPTY = 'Este nodo todavía no tiene ventas ni actividad.';

/**
 * ¿Un nodo sin nada que mostrar todavía? Nunca reservó, ni él ni su red en el período, no tiene
 * reservas vigentes, ninguna de su red espera a una persona y no hubo actividad. Si alguna de esas
 * lecturas falta, no se afirma: una reserva vieja de su red trabada no convive con "todavía no tiene
 * ventas ni actividad".
 */
export function isQuietNode(summary: NodeSummary, activityEvents: number | null): boolean {
  if (summary.own === null || summary.sales === null || summary.attention === null) return false;
  if (activityEvents === null) return false;
  return (
    summary.own.lastOrderAt === null &&
    summary.own.openOrders === 0 &&
    (summary.subtree?.openOrders ?? 0) === 0 &&
    summary.sales.subtree.length === 0 &&
    summary.attention.total === 0 &&
    activityEvents === 0
  );
}

const DAY_MONTH_YEAR = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Bogota',
});

/** "Alta: 5 ene 2026", o nada si la fecha no se puede leer. */
export function createdLabel(iso: string): string | null {
  const at = new Date(iso);
  if (iso === '' || Number.isNaN(at.getTime())) return null;
  return `Alta: ${DAY_MONTH_YEAR.format(at).replace(/\./g, '')}`;
}

/** Los proveedores del nodo, contados: cuántos puede usar y cuáles están apagados de emergencia. */
export interface ProvidersCount {
  readonly enabled: number;
  readonly total: number;
  /** Los nombres de los que tienen el apagado de emergencia puesto, con su alcance. */
  readonly killSwitched: readonly { readonly name: string; readonly salesOnly: boolean }[];
}

export function providersCount(view: TenantProviders): ProvidersCount {
  return {
    enabled: view.providers.filter((p) => p.effective.enabled).length,
    total: view.providers.length,
    killSwitched: view.providers
      .filter((p) => p.killSwitch !== null)
      .map((p) => ({ name: providerMetaFor(p.code).name, salesOnly: p.killSwitch === 'sales' })),
  };
}
