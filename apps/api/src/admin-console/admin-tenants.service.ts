import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { TenantHierarchyNotFoundError } from '../database/tenant-hierarchy-errors.js';
import type { TenantStatus, TenantType } from '../database/database.types.js';
import { rethrowAdminDbError } from '../network/superadmin.errors.js';
import { currencyExponent } from '../portfolios/wallet-currency.js';

/**
 * Plataforma → Agencias en números: cuánto ocupa, vende y espera cada nodo, y qué arrastraría
 * suspender uno con su red. Lee `admin_node_stats()` (0075), que vuelve a exigir en la base que
 * quien pide sea el superadmin y devuelve sólo agregados.
 *
 * Va aparte de `GET /admin/tenants` (TenantsService.listNetwork) para que la lista de la red no
 * dependa de estas lecturas: si fallan, el árbol se sigue viendo y se corrige.
 *
 * Nunca se suman monedas distintas: lo retenido va por moneda, con su exponente.
 *
 * Las ventas son las del Resumen y Reportes: reservas confirmadas o emitidas (`admin_sales_summary`).
 * `orders_30d` y `last_order_at` de `admin_node_stats()` cuentan órdenes en cualquier estado, las
 * fallidas y canceladas incluidas: sirven como actividad, no como ventas.
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
 * El impacto de suspender `tenant`: las filas de `admin_node_stats()` de su subárbol (la suya
 * incluida) sumadas, y las personas contadas aparte (`activeUsers`), sin repetir a quien tiene
 * acceso a dos nodos del subárbol.
 */
export function foldImpact(
  tenant: ImpactTenantView,
  subtree: readonly NodeStatsRow[],
  activeUsers: number,
): NodeImpactView {
  const sum = (pick: (row: NodeStatsRow) => DbNumber) =>
    subtree.reduce((total, row) => total + toNumber(pick(row)), 0);
  return {
    tenant,
    descendants: subtree.filter((row) => row.tenant_id !== tenant.id).length,
    activeUsers,
    liveSessions: sum((row) => row.live_sessions),
    openOrders: sum((row) => row.open_orders),
    held: foldHeld(subtree.map((row) => row.held)),
    pendingDepositReports: sum((row) => row.pending_deposit_reports),
    pendingInvitations: sum((row) => row.pending_invitations),
  };
}

@Injectable()
export class AdminTenantsService {
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
        const subtree = await sql<NodeStatsRow>`
          SELECT s.*
            FROM admin_node_stats() s
            JOIN tenants t ON t.id = s.tenant_id
           WHERE t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${tenantId}::uuid)
        `.execute(trx);

        // `tenants` no tiene RLS.
        const row = await trx
          .selectFrom('tenants')
          .select(['id', 'name', 'tenant_type', 'is_branch', 'status'])
          .where('id', '=', tenantId)
          .executeTakeFirst();
        if (row === undefined) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');

        // Personas, no memberships: la RLS de memberships deja leer todo al superadmin (0020).
        const people = await sql<{ n: DbNumber }>`
          SELECT count(DISTINCT m.user_id) AS n
            FROM memberships m
            JOIN users u   ON u.id = m.user_id
            JOIN tenants t ON t.id = m.tenant_id
           WHERE m.status = 'active'
             AND u.status = 'active'
             AND t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${tenantId}::uuid)
        `.execute(trx);

        return foldImpact(
          {
            id: row.id,
            name: row.name,
            tenantType: row.tenant_type,
            isBranch: row.is_branch,
            status: row.status,
          },
          subtree.rows,
          toNumber(people.rows[0]?.n),
        );
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }
}
