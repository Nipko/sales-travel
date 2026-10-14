import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, TenantType } from '../database/database.types.js';
import { STALE_CANCEL_CLAIM_MS } from '../orders/stale-cancel-claim.service.js';
import { rethrowAdminDbError } from '../network/superadmin.errors.js';
import { ProviderEnablementService } from '../provider-enablement/provider-enablement.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { PlatformConsoleScopeNotFoundError } from './admin-console.errors.js';
import {
  foldAttention,
  foldNetwork,
  foldOrderAttention,
  foldReconciliationRuns,
  foldSaturatedSeats,
  foldSales,
  foldTopNodes,
  foldTrend,
  foldWallets,
  type AttentionView,
  type CatalogView,
  type NetworkView,
  type OverviewAttentionRow,
  type OverviewNetworkRow,
  type OverviewOrderAttentionRow,
  type OverviewOrdersRow,
  type OverviewPostSaleRow,
  type OverviewQuotationsRow,
  type OverviewReconciliationHealthRow,
  type OverviewSeatsRow,
  type OverviewTopNodeRow,
  type OverviewTrendRow,
  type OverviewWalletsRow,
  type ProviderSignalsView,
  type SalesView,
  type TopNodeView,
  type TrendView,
  type WalletExposureView,
} from './admin-overview.fold.js';
import {
  OVERVIEW_RECENT_DAYS,
  OVERVIEW_RECONCILIATION_RUN_DAYS,
  OVERVIEW_TOP_NODES,
  OVERVIEW_TREND_MONTHS,
  PLATFORM_TIME_ZONE,
  resolveOverviewPeriod,
  trendMonths,
  type AdminOverviewQuery,
  type OverviewPeriod,
} from './admin-overview.schemas.js';
import { readCatalogFreshness, readPostSaleSweep } from './admin-system.service.js';

/** El nodo por el que se acotó el Resumen. */
export interface OverviewScopeView {
  tenantId: string;
  name: string;
  slug: string;
  tenantType: TenantType;
  isBranch: boolean;
}

/** Plataforma → Resumen. */
export interface AdminOverviewView {
  /** ISO 8601. */
  generatedAt: string;
  /** La zona de los días del período y de los meses de la tendencia. */
  timeZone: string;
  period: OverviewPeriod;
  /** `null` = toda la red. */
  scope: OverviewScopeView | null;
  sales: SalesView;
  trend: TrendView;
  topNodes: TopNodeView[];
  network: NetworkView;
  wallets: WalletExposureView[];
  attention: AttentionView;
  providers: ProviderSignalsView;
  /** El catálogo de hoteles de cada proveedor (de la plataforma, no de un nodo). */
  catalogs: CatalogView[];
}

interface Bounds {
  from_at: Date;
  to_at: Date;
  trend_from: Date;
}

const DAY_MS = 86_400_000;

/**
 * Cómo va la plataforma, para el superadmin: ventas del período por moneda, vertical y proveedor, la
 * tendencia de 12 meses, los nodos que más venden, la red (nodos, personas, sesiones), la exposición
 * de las carteras, lo que espera a una persona (también si el barrido de post-venta dejó de correr) y
 * las señales de los proveedores.
 *
 * Toda lectura de la red pasa por las funciones de 0075, que vuelven a exigir que quien pide sea el
 * superadmin (`app.current_user_id`, por eso `withRequestContext({ userId })`) y devuelven sólo
 * agregados. Sólo lee: no escribe ni audita (mirar no cambia nada).
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly breaker: CircuitBreakerService,
    private readonly enablement: ProviderEnablementService,
  ) {}

  async overview(
    actorUserId: string,
    query: AdminOverviewQuery,
    now: Date = new Date(),
  ): Promise<AdminOverviewView> {
    const period = resolveOverviewPeriod(query, now);
    const months = trendMonths(period.to, OVERVIEW_TREND_MONTHS);
    const stuckBefore = new Date(now.getTime() - STALE_CANCEL_CLAIM_MS);
    const since = new Date(now.getTime() - OVERVIEW_RECENT_DAYS * DAY_MS);
    const runsSince = new Date(now.getTime() - OVERVIEW_RECONCILIATION_RUN_DAYS * DAY_MS);

    try {
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const scope = query.tenantId === undefined ? null : await this.scopeOf(trx, query.tenantId);
        const root = scope?.tenantId ?? null;
        const bounds = await this.bounds(trx, period, months);

        const orders = await sql<OverviewOrdersRow>`
          SELECT * FROM platform_overview_orders(${root}::uuid, ${bounds.from_at}::timestamptz, ${bounds.to_at}::timestamptz)
        `.execute(trx);
        const quotations = await sql<OverviewQuotationsRow>`
          SELECT * FROM platform_overview_quotations(${root}::uuid, ${bounds.from_at}::timestamptz, ${bounds.to_at}::timestamptz)
        `.execute(trx);
        const trend = await sql<OverviewTrendRow>`
          SELECT * FROM platform_overview_trend(${root}::uuid, ${bounds.trend_from}::timestamptz, ${bounds.to_at}::timestamptz, ${PLATFORM_TIME_ZONE})
        `.execute(trx);
        const topNodes = await sql<OverviewTopNodeRow>`
          SELECT * FROM platform_overview_top_nodes(${root}::uuid, ${bounds.from_at}::timestamptz, ${bounds.to_at}::timestamptz, ${OVERVIEW_TOP_NODES}::int)
        `.execute(trx);
        const network = await sql<OverviewNetworkRow>`
          SELECT * FROM platform_overview_network(${root}::uuid, ${bounds.from_at}::timestamptz, ${bounds.to_at}::timestamptz)
        `.execute(trx);
        const wallets = await sql<OverviewWalletsRow>`
          SELECT * FROM platform_overview_wallets(${root}::uuid)
        `.execute(trx);
        const postSale = await sql<OverviewPostSaleRow>`
          SELECT * FROM platform_overview_post_sale(${root}::uuid, ${stuckBefore}::timestamptz)
        `.execute(trx);
        const attention = await sql<OverviewAttentionRow>`
          SELECT * FROM platform_overview_attention(${root}::uuid, ${since}::timestamptz)
        `.execute(trx);
        // admin_* (0075 §7-§10) devuelven toda la red con el tenant de cada fila: se acota acá.
        const orderAttention = await sql<OverviewOrderAttentionRow>`
          SELECT a.*
            FROM admin_order_attention() a
           WHERE ${root}::uuid IS NULL
              OR a.tenant_id IN (
                   SELECT t.id FROM tenants t
                    WHERE t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${root}::uuid))
        `.execute(trx);
        const seats = await sql<OverviewSeatsRow>`
          SELECT s.tenant_id, t.name AS tenant_name, s.seat_limit, s.seats_used
            FROM admin_node_stats() s
            JOIN tenants t ON t.id = s.tenant_id
           WHERE s.seat_limit IS NOT NULL
             AND (${root}::uuid IS NULL
                  OR t.path OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${root}::uuid))
        `.execute(trx);
        const runs = await sql<OverviewReconciliationHealthRow>`
          SELECT * FROM admin_reconciliation_health(${runsSince}::timestamptz)
        `.execute(trx);
        // Catálogo de plataforma: hotel_provider_city no tiene tenant ni RLS (0041).
        const catalogs = await readCatalogFreshness(trx, now);
        // El barrido de post-venta, de su rastro en la raíz platform (Sistema › Procesos).
        const sweep = await readPostSaleSweep(trx, now);

        return {
          generatedAt: now.toISOString(),
          timeZone: PLATFORM_TIME_ZONE,
          period,
          scope,
          sales: foldSales(orders.rows, quotations.rows),
          trend: foldTrend(trend.rows, months),
          topNodes: foldTopNodes(topNodes.rows),
          network: foldNetwork(network.rows[0]),
          wallets: foldWallets(wallets.rows),
          attention: foldAttention(attention.rows[0], postSale.rows, OVERVIEW_RECENT_DAYS, {
            orders: foldOrderAttention(orderAttention.rows),
            seats: { saturated: foldSaturatedSeats(seats.rows) },
            reconciliationRuns: foldReconciliationRuns(runs.rows, OVERVIEW_RECONCILIATION_RUN_DAYS),
            jobs: { postSaleSweepStale: sweep.stale, lastOkAt: sweep.lastOkAt },
          }),
          providers: await this.providerSignals(trx),
          catalogs,
        };
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }

  /** El nodo por el que se acota. `tenants` no tiene RLS. */
  private async scopeOf(trx: Transaction<DB>, tenantId: string): Promise<OverviewScopeView> {
    const row = await trx
      .selectFrom('tenants')
      .select(['id', 'name', 'slug', 'tenant_type', 'is_branch'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (row === undefined) throw new PlatformConsoleScopeNotFoundError();
    return {
      tenantId: row.id,
      name: row.name,
      slug: row.slug,
      tenantType: row.tenant_type,
      isBranch: row.is_branch,
    };
  }

  /**
   * Los instantes de los días calendario del período en la zona de la plataforma: desde el comienzo
   * de `from` hasta el comienzo del día siguiente a `to`, y el comienzo del primer mes de la
   * tendencia. Los calcula Postgres, que conoce los cambios de hora de cada zona.
   */
  private async bounds(
    trx: Transaction<DB>,
    period: OverviewPeriod,
    months: readonly string[],
  ): Promise<Bounds> {
    const trendStart = `${months[0] ?? period.from.slice(0, 7)}-01`;
    const { rows } = await sql<Bounds>`
      SELECT (${period.from}::date::timestamp AT TIME ZONE ${PLATFORM_TIME_ZONE}) AS from_at,
             ((${period.to}::date + 1)::timestamp AT TIME ZONE ${PLATFORM_TIME_ZONE}) AS to_at,
             (${trendStart}::date::timestamp AT TIME ZONE ${PLATFORM_TIME_ZONE}) AS trend_from
    `.execute(trx);
    const bounds = rows[0];
    if (bounds === undefined) throw new Error('Postgres no devolvió los límites del período');
    return bounds;
  }

  /**
   * Las señales de los proveedores: el apagado de emergencia de cada proveedor registrado, los
   * circuitos que no están cerrados en esta réplica y lo que el superadmin apagó desde Proveedores de
   * la plataforma (`provider_enablement`, de lectura abierta en 0048).
   *
   * El apagado de emergencia sale de ProviderEnablementService.list(), el mismo que muestra
   * Proveedores de la plataforma: su `killSwitch` es el nivel efectivo, el más amplio entre
   * `PROVIDERS_DISABLED` y el apagado desde el panel (0077).
   */
  private async providerSignals(trx: Transaction<DB>): Promise<ProviderSignalsView> {
    const disabled = await trx
      .selectFrom('provider_enablement')
      .select(['provider_code', 'tenant_id', 'reason', 'updated_at'])
      .where('enabled', '=', false)
      .orderBy('provider_code')
      .execute();

    const killSwitched = (await this.enablement.list())
      .flatMap((p) => (p.killSwitch === null ? [] : [{ code: p.code, level: p.killSwitch }]))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    const openCircuits = Object.entries(this.breaker.snapshot())
      .filter(([, circuit]) => circuit.state !== 'closed')
      .map(([code, circuit]) => ({ code, state: circuit.state, failures: circuit.failures }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    return {
      killSwitched,
      openCircuits,
      disabledGlobally: disabled
        .filter((r) => r.tenant_id === null)
        .map((r) => ({
          code: r.provider_code,
          reason: r.reason,
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
      tenantOverridesDisabled: disabled.filter((r) => r.tenant_id !== null).length,
    };
  }
}
