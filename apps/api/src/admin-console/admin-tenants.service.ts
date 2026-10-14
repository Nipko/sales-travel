import { HttpException, Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { TenantHierarchyNotFoundError } from '../database/tenant-hierarchy-errors.js';
import type { DB, TenantStatus, TenantType } from '../database/database.types.js';
import {
  isAdminSuperadminDenial,
  rethrowAdminDbError,
  SuperadminRequiredError,
} from '../network/superadmin.errors.js';
import { currencyExponent } from '../portfolios/wallet-currency.js';
import {
  ORDER_AMOUNT_EXPONENT,
  foldOrderAttention,
  type OrderAttentionView,
  type OverviewOrderAttentionRow,
} from './admin-overview.fold.js';
import { readOrderAttention } from './admin-overview.service.js';

/**
 * Plataforma → Agencias en números: cuánto ocupa, vende y espera cada nodo, y qué arrastraría
 * suspender uno con su red. Lee `admin_node_stats()` (0075), que vuelve a exigir en la base que
 * quien pide sea el superadmin y devuelve sólo agregados.
 *
 * Va aparte de `GET /admin/tenants` (TenantsService.listNetwork) para que la lista de la red no
 * dependa de estas lecturas: si fallan, el árbol se sigue viendo y se corrige.
 *
 * Nunca se suman monedas distintas: lo retenido va por moneda, con su exponente ISO (montos de
 * cartera); las ventas, con el de reservas ({@link ORDER_AMOUNT_EXPONENT}: centésimos en toda moneda).
 *
 * Las ventas son las del Resumen y Reportes: reservas confirmadas o emitidas (`admin_sales_summary`).
 * `orders_30d` y `last_order_at` de `admin_node_stats()` cuentan órdenes en cualquier estado, las
 * fallidas y canceladas incluidas: sirven como actividad, no como ventas.
 *
 * La ficha de cada nodo (`GET /admin/tenants/:id/summary`) junta lo mismo para un nodo: su fila, su
 * subárbol sumado como el impacto, sus ventas de 30 días y las reservas que esperan a una persona.
 */

/** `pg` devuelve BIGINT y NUMERIC como texto. */
type DbNumber = string | number | bigint | null | undefined;

/** Una fila de `admin_node_stats()`. */
export interface NodeStatsRow {
  tenant_id: string;
  active_users: DbNumber;
  live_sessions: DbNumber;
  seat_limit: DbNumber;
  seats_used: DbNumber;
  orders_30d: DbNumber;
  last_order_at: Date | string | null;
  open_orders: DbNumber;
  /** Moneda → unidades menores retenidas en las carteras del nodo. */
  held: unknown;
  pending_deposit_reports: DbNumber;
  pending_invitations: DbNumber;
}

/** Lo retenido en una moneda. */
export interface HeldAmountView {
  currency: string;
  /** El exponente ISO 4217, o `null` si el código no es una moneda en circulación. */
  exponent: number | null;
  amountMinor: number;
}

/** Un nodo en números (`GET /admin/tenants/stats`). */
export interface NodeStatsView {
  tenantId: string;
  /** El cupo de sesiones simultáneas propio del nodo; `null` si no fija uno (comparte el del padre). */
  seatLimit: number | null;
  /** Los puestos que ocupa contra su cupo; `null` sin cupo propio. */
  seatsUsed: number | null;
  liveSessions: number;
  activeUsers: number;
  /** Órdenes creadas en 30 días, en cualquier estado (fallidas y canceladas incluidas). */
  orders30d: number;
  /**
   * Ventas de 30 días: órdenes creadas en 30 días que hoy están confirmadas o emitidas, como las
   * cuenta el Resumen.
   */
  sales30d: number;
  /** La última reserva, en cualquier estado: ISO 8601, o `null` si nunca reservó. */
  lastOrderAt: string | null;
  /** Órdenes pending, confirmed o ticketed. */
  openOrders: number;
  pendingDepositReports: number;
  pendingInvitations: number;
  held: HeldAmountView[];
}

/** El nodo sobre el que se calcula el impacto. */
export interface ImpactTenantView {
  id: string;
  name: string;
  tenantType: TenantType;
  isBranch: boolean;
  status: TenantStatus;
}

/**
 * Qué arrastraría suspender un nodo (`GET /admin/tenants/:id/impact`): todo su subárbol, el nodo
 * incluido.
 */
export interface NodeImpactView {
  tenant: ImpactTenantView;
  /** Los nodos que cuelgan de él, a cualquier profundidad. */
  descendants: number;
  /** Personas distintas con un acceso activo en el subárbol (una con dos nodos cuenta una vez). */
  activeUsers: number;
  liveSessions: number;
  openOrders: number;
  held: HeldAmountView[];
  pendingDepositReports: number;
  pendingInvitations: number;
}

/** El subárbol de un nodo sumado, él incluido: lo mismo que el impacto, sin el nodo. */
export type NodeSubtreeView = Omit<NodeImpactView, 'tenant'>;

/** Los días de las ventas de la ficha: los mismos de la columna "Ventas 30 d" de la lista. */
export const NODE_SUMMARY_SALES_DAYS = 30;

/** Una fila de `admin_sales_summary` del subárbol, sumada por (¿del nodo?, vertical, moneda). */
export interface NodeSalesRow {
  /** `true`: del nodo mismo; `false`: de un nodo que cuelga de él. */
  own: boolean;
  vertical: string;
  currency: string;
  orders_count: DbNumber;
  confirmed_count: DbNumber;
  confirmed_amount_minor: DbNumber;
  cancelled_count: DbNumber;
  failed_count: DbNumber;
}

/** Lo confirmado (confirmed o ticketed) de una vertical, en una moneda. */
export interface NodeSalesVerticalView {
  vertical: string;
  confirmedCount: number;
  confirmedAmountMinor: number;
}

/** Las reservas del período en una moneda: cuántas, y lo vendido (confirmadas o emitidas). */
export interface NodeSalesView {
  currency: string;
  /**
   * Siempre {@link ORDER_AMOUNT_EXPONENT}: `orders.total_amount` va en centésimos en toda moneda, así
   * que no es el ISO (en CLP sería 0 y la venta se vería 100 veces más grande).
   */
  exponent: number | null;
  /** Creadas en el período, en cualquier estado. */
  ordersCount: number;
  confirmedCount: number;
  confirmedAmountMinor: number;
  cancelledCount: number;
  failedCount: number;
  /** Sólo las verticales con algo confirmado: vuelos, hoteles, autos (y lo que no se conozca). */
  byVertical: NodeSalesVerticalView[];
}

export interface NodeSummarySalesView {
  days: number;
  /** Las del nodo mismo, por moneda. */
  own: NodeSalesView[];
  /** Las del nodo y todo lo que cuelga de él, por moneda. */
  subtree: NodeSalesView[];
}

/** Las reservas del subárbol que necesitan a una persona: cuántas y por qué (sin la muestra). */
export type NodeAttentionView = Omit<OrderAttentionView, 'sample'>;

/** El nodo de la ficha. */
export interface NodeSummaryTenantView {
  id: string;
  name: string;
  slug: string;
  tenantType: TenantType;
  isBranch: boolean;
  status: TenantStatus;
  /** `null` en la raíz de la red. */
  parent: { id: string; name: string } | null;
  countryCode: string;
  defaultCurrency: string;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * La ficha de un nodo (`GET /admin/tenants/:id/summary`). Cada sección se lee por separado: la que
 * no se pudo leer llega en `null` y el resto se ve igual.
 */
export interface NodeSummaryView {
  /** ISO 8601. */
  generatedAt: string;
  tenant: NodeSummaryTenantView;
  /**
   * Su fila de `admin_node_stats()`. `sales30d` sale de `sales` (sus confirmadas): 0 si las ventas
   * no se pudieron leer.
   */
  own: NodeStatsView | null;
  subtree: NodeSubtreeView | null;
  sales: NodeSummarySalesView | null;
  attention: NodeAttentionView | null;
}

/** Las secciones de la ficha que se leen cada una en su transacción. */
export type NodeSummarySection = 'network' | 'sales' | 'attention';

function toNumber(value: DbNumber): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toNullableNumber(value: DbNumber): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function byCurrency(a: HeldAmountView, b: HeldAmountView): number {
  return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
}

/** Moneda → monto, como lo arma `jsonb_object_agg`. Lo que no es un monto se descarta. */
function heldEntries(value: unknown): Array<[string, number]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([currency, amount]) => {
    const n = typeof amount === 'number' || typeof amount === 'string' ? Number(amount) : NaN;
    return Number.isFinite(n) && n !== 0 ? [[currency, n] as [string, number]] : [];
  });
}

/** Lo retenido de varias filas, sumado SÓLO dentro de cada moneda, por código. */
export function foldHeld(values: readonly unknown[]): HeldAmountView[] {
  const totals = new Map<string, number>();
  for (const value of values) {
    for (const [currency, amount] of heldEntries(value)) {
      totals.set(currency, (totals.get(currency) ?? 0) + amount);
    }
  }
  return [...totals]
    .filter(([, amountMinor]) => amountMinor !== 0)
    .map(([currency, amountMinor]) => ({
      currency,
      exponent: currencyExponent(currency) ?? null,
      amountMinor,
    }))
    .sort(byCurrency);
}

/**
 * Un nodo a la vista. `sales30d` viene aparte (`admin_sales_summary`): un nodo sin ventas no tiene
 * fila ahí.
 */
export function foldNodeStats(row: NodeStatsRow, sales30d: DbNumber = 0): NodeStatsView {
  return {
    tenantId: row.tenant_id,
    seatLimit: toNullableNumber(row.seat_limit),
    seatsUsed: toNullableNumber(row.seats_used),
    liveSessions: toNumber(row.live_sessions),
    activeUsers: toNumber(row.active_users),
    orders30d: toNumber(row.orders_30d),
    sales30d: toNumber(sales30d),
    lastOrderAt: isoOf(row.last_order_at),
    openOrders: toNumber(row.open_orders),
    pendingDepositReports: toNumber(row.pending_deposit_reports),
    pendingInvitations: toNumber(row.pending_invitations),
    held: foldHeld([row.held]),
  };
}

/**
 * El subárbol de `tenantId` sumado: las filas de `admin_node_stats()` de su subárbol (la suya
 * incluida), y las personas contadas aparte (`activeUsers`), sin repetir a quien tiene acceso a dos
 * nodos del subárbol.
 */
export function foldSubtree(
  tenantId: string,
  subtree: readonly NodeStatsRow[],
  activeUsers: number,
): NodeSubtreeView {
  const sum = (pick: (row: NodeStatsRow) => DbNumber) =>
    subtree.reduce((total, row) => total + toNumber(pick(row)), 0);
  return {
    descendants: subtree.filter((row) => row.tenant_id !== tenantId).length,
    activeUsers,
    liveSessions: sum((row) => row.live_sessions),
    openOrders: sum((row) => row.open_orders),
    held: foldHeld(subtree.map((row) => row.held)),
    pendingDepositReports: sum((row) => row.pending_deposit_reports),
    pendingInvitations: sum((row) => row.pending_invitations),
  };
}

/** El impacto de suspender `tenant`: su subárbol sumado ({@link foldSubtree}). */
export function foldImpact(
  tenant: ImpactTenantView,
  subtree: readonly NodeStatsRow[],
  activeUsers: number,
): NodeImpactView {
  return { tenant, ...foldSubtree(tenant.id, subtree, activeUsers) };
}

/** Las verticales en el orden de la consola; una que no se conoce, al final. */
const VERTICAL_ORDER: readonly string[] = ['flights', 'hotels', 'cars'];

function verticalRank(vertical: string): number {
  const i = VERTICAL_ORDER.indexOf(vertical);
  return i === -1 ? VERTICAL_ORDER.length : i;
}

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Las filas por moneda, sumadas SÓLO dentro de cada moneda, por código. */
function foldSalesRows(rows: readonly NodeSalesRow[]): NodeSalesView[] {
  const byCurrency = new Map<string, NodeSalesView>();
  const verticalsOf = new Map<string, Map<string, NodeSalesVerticalView>>();
  for (const row of rows) {
    const total = byCurrency.get(row.currency) ?? {
      currency: row.currency,
      exponent: ORDER_AMOUNT_EXPONENT,
      ordersCount: 0,
      confirmedCount: 0,
      confirmedAmountMinor: 0,
      cancelledCount: 0,
      failedCount: 0,
      byVertical: [],
    };
    const confirmedCount = toNumber(row.confirmed_count);
    const confirmedAmountMinor = toNumber(row.confirmed_amount_minor);
    total.ordersCount += toNumber(row.orders_count);
    total.confirmedCount += confirmedCount;
    total.confirmedAmountMinor += confirmedAmountMinor;
    total.cancelledCount += toNumber(row.cancelled_count);
    total.failedCount += toNumber(row.failed_count);
    byCurrency.set(row.currency, total);

    if (confirmedCount > 0) {
      const verticals = verticalsOf.get(row.currency) ?? new Map<string, NodeSalesVerticalView>();
      const v = verticals.get(row.vertical) ?? {
        vertical: row.vertical,
        confirmedCount: 0,
        confirmedAmountMinor: 0,
      };
      v.confirmedCount += confirmedCount;
      v.confirmedAmountMinor += confirmedAmountMinor;
      verticals.set(row.vertical, v);
      verticalsOf.set(row.currency, verticals);
    }
  }
  return [...byCurrency.values()]
    .filter((total) => total.ordersCount > 0)
    .map((total) => ({
      ...total,
      byVertical: [...(verticalsOf.get(total.currency)?.values() ?? [])].sort(
        (a, b) =>
          verticalRank(a.vertical) - verticalRank(b.vertical) || byCode(a.vertical, b.vertical),
      ),
    }))
    .sort((a, b) => byCode(a.currency, b.currency));
}

/** Las ventas de la ficha: las del nodo y las del nodo con su red, cada moneda por su lado. */
export function foldNodeSales(
  rows: readonly NodeSalesRow[],
  days: number = NODE_SUMMARY_SALES_DAYS,
): NodeSummarySalesView {
  return {
    days,
    own: foldSalesRows(rows.filter((row) => row.own)),
    subtree: foldSalesRows(rows),
  };
}

/** Lo que leyó cada sección de la ficha; `null` si no se pudo leer. */
export interface NodeSummaryReads {
  generatedAt: Date;
  tenant: NodeSummaryTenantView;
  network: { rows: readonly NodeStatsRow[]; people: number } | null;
  sales: readonly NodeSalesRow[] | null;
  attention: readonly OverviewOrderAttentionRow[] | null;
}

/** Una fila en cero, para un nodo que `admin_node_stats()` no devolvió (se borró entre lecturas). */
function emptyStatsRow(tenantId: string): NodeStatsRow {
  return {
    tenant_id: tenantId,
    active_users: 0,
    live_sessions: 0,
    seat_limit: null,
    seats_used: null,
    orders_30d: 0,
    last_order_at: null,
    open_orders: 0,
    held: {},
    pending_deposit_reports: 0,
    pending_invitations: 0,
  };
}

/**
 * La ficha a la vista: el nodo con su fila, su subárbol sumado, sus ventas (las suyas y con su red)
 * y las reservas que esperan a una persona en su red. Una sección sin leer queda en `null`.
 */
export function foldNodeSummary(reads: NodeSummaryReads): NodeSummaryView {
  const { tenant, network, sales, attention } = reads;
  const ownSales =
    sales === null
      ? 0
      : sales.filter((row) => row.own).reduce((n, row) => n + toNumber(row.confirmed_count), 0);
  const ownRow =
    network === null
      ? null
      : (network.rows.find((row) => row.tenant_id === tenant.id) ?? emptyStatsRow(tenant.id));
  let attentionView: NodeAttentionView | null = null;
  if (attention !== null) {
    const { total, byReason } = foldOrderAttention(attention, 0);
    attentionView = { total, byReason };
  }
  return {
    generatedAt: reads.generatedAt.toISOString(),
    tenant,
    own: ownRow === null ? null : foldNodeStats(ownRow, ownSales),
    subtree: network === null ? null : foldSubtree(tenant.id, network.rows, network.people),
    sales: sales === null ? null : foldNodeSales(sales),
    attention: attentionView,
  };
}

/** Lo que se registra de un error de una sección: su código de Postgres o su clase, nunca el texto. */
function errorTag(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return 'unknown';
}

/** El subárbol de `tenantId` (él incluido) en `admin_node_stats()`, que exige al superadmin. */
async function readSubtreeStats(trx: Transaction<DB>, tenantId: string): Promise<NodeStatsRow[]> {
  const { rows } = await sql<NodeStatsRow>`
    SELECT s.*
      FROM admin_node_stats() s
      JOIN tenants t ON t.id = s.tenant_id
     WHERE t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${tenantId}::uuid)
  `.execute(trx);
  return rows;
}

/**
 * Personas distintas con un acceso activo (membership y usuario activos) en el subárbol: una con dos
 * nodos cuenta una vez. Personas, no memberships: la RLS de memberships deja leer todo al superadmin
 * (0020). Va siempre después de `admin_node_stats()` en la misma transacción: si quien pide dejó de
 * ser superadmin, la base corta ahí (42501) antes de leer las memberships, que la RLS le dejaría ver
 * vacías.
 */
async function readSubtreePeople(trx: Transaction<DB>, tenantId: string): Promise<number> {
  const { rows } = await sql<{ n: DbNumber }>`
    SELECT count(DISTINCT m.user_id) AS n
      FROM memberships m
      JOIN users u   ON u.id = m.user_id
      JOIN tenants t ON t.id = m.tenant_id
     WHERE m.status = 'active'
       AND u.status = 'active'
       AND t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${tenantId}::uuid)
  `.execute(trx);
  return toNumber(rows[0]?.n);
}

/** El nodo de la ficha con su padre. 404 `TENANT_NOT_FOUND` si no existe. `tenants` no tiene RLS. */
async function readSummaryTenant(
  trx: Transaction<DB>,
  tenantId: string,
): Promise<NodeSummaryTenantView> {
  const row = await trx
    .selectFrom('tenants as t')
    .leftJoin('tenants as p', 'p.id', 't.parent_tenant_id')
    .select([
      't.id',
      't.name',
      't.slug',
      't.tenant_type',
      't.is_branch',
      't.status',
      't.country_code',
      't.default_currency',
      't.created_at',
      'p.id as parent_id',
      'p.name as parent_name',
    ])
    .where('t.id', '=', tenantId)
    .executeTakeFirst();
  if (row === undefined) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tenantType: row.tenant_type,
    isBranch: row.is_branch,
    status: row.status,
    parent:
      row.parent_id === null || row.parent_name === null
        ? null
        : { id: row.parent_id, name: row.parent_name },
    countryCode: row.country_code,
    defaultCurrency: row.default_currency,
    // pg devuelve Date para timestamptz; el tipo Kysely es ColumnType (Timestamp).
    createdAt: isoOf(row.created_at as unknown as Date) ?? '',
  };
}

@Injectable()
export class AdminTenantsService {
  private readonly logger = new Logger(AdminTenantsService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Cada nodo de la red en números, en el orden de `path`. Sólo lee: no audita. Las ventas de 30
   * días salen de `admin_sales_summary` (confirmadas o emitidas), que también exige al superadmin.
   */
  async stats(actorUserId: string): Promise<NodeStatsView[]> {
    try {
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const { rows } = await sql<NodeStatsRow>`SELECT * FROM admin_node_stats()`.execute(trx);
        const sales = await sql<{ tenant_id: string; n: DbNumber }>`
          SELECT s.tenant_id, sum(s.confirmed_count) AS n
            FROM admin_sales_summary(now() - interval '30 days', now()) s
           GROUP BY s.tenant_id
        `.execute(trx);
        const salesOf = new Map(sales.rows.map((r) => [r.tenant_id, r.n]));
        return rows.map((row) => foldNodeStats(row, salesOf.get(row.tenant_id)));
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }

  /**
   * Qué arrastraría suspender el nodo con todo su subárbol: nodos, personas, sesiones vivas,
   * reservas abiertas, lo retenido en sus carteras, depósitos por aprobar e invitaciones vigentes.
   * 404 `TENANT_NOT_FOUND` si el nodo no existe.
   *
   * `admin_node_stats()` va primero: si quien pide dejó de ser superadmin, la base corta ahí (42501,
   * el 403 de la guarda) antes de leer las memberships, que la RLS le dejaría ver vacías.
   */
  async impact(actorUserId: string, tenantId: string): Promise<NodeImpactView> {
    try {
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const subtree = await readSubtreeStats(trx, tenantId);

        // `tenants` no tiene RLS.
        const row = await trx
          .selectFrom('tenants')
          .select(['id', 'name', 'tenant_type', 'is_branch', 'status'])
          .where('id', '=', tenantId)
          .executeTakeFirst();
        if (row === undefined) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');

        return foldImpact(
          {
            id: row.id,
            name: row.name,
            tenantType: row.tenant_type,
            isBranch: row.is_branch,
            status: row.status,
          },
          subtree,
          await readSubtreePeople(trx, tenantId),
        );
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }

  /**
   * La ficha de un nodo: quién es (tipo, estado, de quién cuelga), su fila en números y su subárbol
   * sumado, lo que vendió en {@link NODE_SUMMARY_SALES_DAYS} días (él solo y con su red, por moneda
   * y vertical) y las reservas de su red que esperan a una persona, por motivo. 404
   * `TENANT_NOT_FOUND` si el nodo no existe. Sólo lee: no audita.
   *
   * Cada sección corre en su transacción: si una falla (una lectura lenta que corta el
   * statement_timeout, por ejemplo) llega en `null` y el resto se ve. El rechazo de la base a quien
   * no es superadmin no es una falla de sección: es el 403 de la guarda.
   */
  async summary(
    actorUserId: string,
    tenantId: string,
    now: Date = new Date(),
  ): Promise<NodeSummaryView> {
    let tenant: NodeSummaryTenantView;
    try {
      // `tenants` no tiene RLS; cada sección de abajo vuelve a exigir al superadmin en la base.
      tenant = await this.db.withRequestContext({ userId: actorUserId }, (trx) =>
        readSummaryTenant(trx, tenantId),
      );
    } catch (err) {
      rethrowAdminDbError(err);
    }

    // Las tres a la vez, cada una en su transacción: la ficha tarda lo que la más lenta, no la suma.
    const [network, sales, attention] = await Promise.all([
      this.section('network', actorUserId, tenantId, async (trx) => {
        const rows = await readSubtreeStats(trx, tenantId);
        return { rows, people: await readSubtreePeople(trx, tenantId) };
      }),
      this.section('sales', actorUserId, tenantId, (trx) => readSubtreeSales(trx, tenantId)),
      this.section('attention', actorUserId, tenantId, (trx) => readOrderAttention(trx, tenantId)),
    ]);

    return foldNodeSummary({ generatedAt: now, tenant, network, sales, attention });
  }

  /**
   * Una sección de la ficha en su transacción. Si falla (una lectura lenta que corta el
   * statement_timeout, por ejemplo), `null` y una advertencia con el código del error, nunca su
   * texto. Lo que es de permisos no se tapa como una sección sin leer: el rechazo a quien no es
   * superadmin es el 403 de la guarda, y cualquier otro 42501 (un GRANT que falta) o error HTTP sale
   * tal cual.
   */
  private async section<T>(
    section: NodeSummarySection,
    actorUserId: string,
    tenantId: string,
    read: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await this.db.withRequestContext({ userId: actorUserId }, read);
    } catch (err) {
      if (isAdminSuperadminDenial(err)) throw new SuperadminRequiredError();
      if (isPermissionError(err)) throw err;
      this.logger.warn(
        `admin.node-summary.section-unavailable section=${section} tenant=${tenantId} error=${errorTag(err)}`,
      );
      return null;
    }
  }
}

/** Un error de permisos: un 42501 de la base o una respuesta HTTP ya decidida (401, 403…). */
function isPermissionError(err: unknown): boolean {
  if (err instanceof HttpException) return true;
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42501';
}

/**
 * Las ventas de {@link NODE_SUMMARY_SALES_DAYS} días del subárbol de `tenantId` (él incluido), por
 * (¿del nodo?, vertical, moneda). Cada orden es de un solo nodo: sumar el subárbol no repite nada.
 */
async function readSubtreeSales(trx: Transaction<DB>, tenantId: string): Promise<NodeSalesRow[]> {
  const { rows } = await sql<NodeSalesRow>`
    SELECT s.tenant_id = ${tenantId}::uuid AS own,
           s.vertical,
           s.currency,
           sum(s.orders_count)           AS orders_count,
           sum(s.confirmed_count)        AS confirmed_count,
           sum(s.confirmed_amount_minor) AS confirmed_amount_minor,
           sum(s.cancelled_count)        AS cancelled_count,
           sum(s.failed_count)           AS failed_count
      FROM admin_sales_summary(now() - make_interval(days => ${NODE_SUMMARY_SALES_DAYS}::int), now()) s
      JOIN tenants t ON t.id = s.tenant_id
     WHERE t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${tenantId}::uuid)
     GROUP BY 1, 2, 3
  `.execute(trx);
  return rows;
}
