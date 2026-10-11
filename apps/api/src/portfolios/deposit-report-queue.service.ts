import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, DepositReportStatus, TenantType } from '../database/database.types.js';
import {
  InvalidQueueCursorError,
  decodeQueueCursor,
  encodeQueueCursor,
  type DepositReportQueueQuery,
} from './deposit-report-queue.schemas.js';
import { currencyExponent } from './wallet-currency.js';
import type { DepositReportView } from './wallet-store.js';

/** El nodo que informó el depósito. */
export interface QueuedNodeView {
  id: string;
  name: string;
  slug: string;
  tenantType: TenantType;
  isBranch: boolean;
  status: string;
}

/**
 * Quien lo financia (`tenant_financier_id`, 0052): a su cuenta llegó el dinero. `null` para la raíz
 * o un nodo legado sin padre, que sólo financia el superadmin.
 */
export interface QueuedFinancierView {
  id: string;
  name: string;
  tenantType: TenantType;
}

export interface QueuedDepositReportView extends DepositReportView {
  tenantId: string;
  tenant: QueuedNodeView;
  financier: QueuedFinancierView | null;
  /** ¿Lo financia Planetour? Entonces el dinero llegó a la cuenta de la plataforma. */
  financedByPlatform: boolean;
}

/** Lo que suma la cola con sus filtros, por moneda: nunca se suman monedas distintas. */
export interface DepositReportQueueTotal {
  currency: string;
  exponent: number | null;
  count: number;
  amountMinor: number;
}

export interface DepositReportQueueView {
  status: DepositReportStatus;
  reports: QueuedDepositReportView[];
  /** Para pedir la página siguiente; `null` si no hay más. */
  nextCursor: string | null;
  /** De TODAS las filas que cumplen los filtros, no sólo de esta página. */
  totals: DepositReportQueueTotal[];
}

/** El contador del menú: lo pendiente que financia Planetour y lo que financia el resto de la red. */
export interface PendingDepositReportsCount {
  total: number;
  platform: number;
  network: number;
}

type QueueFilter = Pick<
  DepositReportQueueQuery,
  'status' | 'financedBy' | 'currency' | 'tenantId' | 'q'
>;

/** `\`, `%` y `_` son comodines de ILIKE: se buscan tal cual. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Lo que financia la plataforma: el financiador es la raíz `platform`, o no hay financiador (la raíz
 * misma, o un nodo legado que sólo gestiona el superadmin).
 */
const FINANCED_BY_PLATFORM = sql<boolean>`(f.id IS NULL OR f.tenant_type = 'platform')`;

/**
 * La cola de depósitos informados de TODA la red, para la consola de la plataforma: el superadmin ya
 * no abre nodo por nodo para encontrar qué espera su aprobación (Gestión de Agencias → nodo →
 * Carteras sigue siendo donde se resuelve uno puntual).
 *
 * Sólo lee. Aprobar y rechazar siguen siendo de WalletFinancingService, nodo por nodo (`POST
 * /tenants/:id/portfolios/deposit-reports/:reportId/approve|reject`): la misma transacción, las
 * mismas guardas de 0052 y el mismo rastro.
 *
 * Corre con el usuario que pide y sin tenant: la RLS de `portfolio_deposit_reports` (0052) le deja
 * ver los de los nodos que administra (`can_read_membership`), y además se filtra por
 * `can_finance_tenant`: la cola muestra sólo lo que quien mira podría aprobar. `tenants` y `users` no
 * tienen RLS.
 */
@Injectable()
export class DepositReportQueueService {
  constructor(private readonly db: DatabaseService) {}

  async list(actorUserId: string, query: DepositReportQueueQuery): Promise<DepositReportQueueView> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const pending = query.status === 'pending';
      const sortColumn = pending ? sql.ref('r.reported_at') : sql.ref('r.resolved_at');

      let page = this.queued(trx, query)
        .leftJoin('users as rb', 'rb.id', 'r.reported_by')
        .leftJoin('users as sb', 'sb.id', 'r.resolved_by')
        .select([
          'r.id',
          'r.tenant_id',
          'r.portfolio_id',
          'r.currency',
          'r.amount_minor',
          'r.reference',
          sql<string | null>`to_char(r.deposited_on, 'YYYY-MM-DD')`.as('deposited_on'),
          'r.notes',
          'r.status',
          'r.reported_by',
          'rb.name as reported_by_name',
          'r.reported_at',
          'r.resolved_by',
          'sb.name as resolved_by_name',
          'r.resolved_at',
          'r.resolution_reason',
          'r.portfolio_transaction_id',
          't.name as tenant_name',
          't.slug as tenant_slug',
          't.tenant_type',
          't.is_branch',
          't.status as tenant_status',
          'f.id as financier_id',
          'f.name as financier_name',
          'f.tenant_type as financier_type',
          FINANCED_BY_PLATFORM.as('financed_by_platform'),
          sql<string>`to_char(${sortColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'cursor_at',
          ),
        ]);

      // Los pendientes, del más viejo al más nuevo: es una cola, y lo que más espera va primero. Los
      // resueltos, del último resuelto hacia atrás.
      if (query.cursor !== undefined) {
        const cursor = decodeQueueCursor(query.cursor);
        if (cursor === undefined) throw new InvalidQueueCursorError();
        page = page.where(
          pending
            ? sql<boolean>`(r.reported_at, r.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : sql<boolean>`(r.resolved_at, r.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      page = pending
        ? page.orderBy('r.reported_at', 'asc').orderBy('r.id', 'asc')
        : page.orderBy('r.resolved_at', 'desc').orderBy('r.id', 'desc');

      const rows = await page.limit(query.limit + 1).execute();
      const visible = rows.slice(0, query.limit);
      const last = visible[visible.length - 1];

      const totals = await this.queued(trx, query)
        .select([
          'r.currency',
          (eb) => eb.fn.countAll<string>().as('n'),
          sql<string>`sum(r.amount_minor)::text`.as('amount_minor'),
        ])
        .groupBy('r.currency')
        .orderBy('r.currency')
        .execute();

      return {
        status: query.status,
        reports: visible.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          portfolioId: r.portfolio_id,
          currency: r.currency,
          exponent: currencyExponent(r.currency) ?? null,
          amountMinor: Number(r.amount_minor),
          reference: r.reference,
          depositedOn: r.deposited_on,
          notes: r.notes,
          status: r.status,
          reportedBy: r.reported_by,
          reportedByName: r.reported_by_name ?? null,
          reportedAt: r.reported_at as unknown as Date,
          resolvedBy: r.resolved_by,
          resolvedByName: r.resolved_by_name ?? null,
          resolvedAt: r.resolved_at,
          resolutionReason: r.resolution_reason,
          portfolioTransactionId: r.portfolio_transaction_id,
          tenant: {
            id: r.tenant_id,
            name: r.tenant_name,
            slug: r.tenant_slug,
            tenantType: r.tenant_type,
            isBranch: r.is_branch,
            status: r.tenant_status,
          },
          financier:
            r.financier_id === null || r.financier_name === null || r.financier_type === null
              ? null
              : { id: r.financier_id, name: r.financier_name, tenantType: r.financier_type },
          financedByPlatform: r.financed_by_platform,
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeQueueCursor({ at: last.cursor_at, id: last.id })
            : null,
        totals: totals.map((t) => ({
          currency: t.currency,
          exponent: currencyExponent(t.currency) ?? null,
          count: Number(t.n),
          amountMinor: Number(t.amount_minor),
        })),
      };
    });
  }

  /** Cuántos depósitos esperan aprobación, para el contador del menú. */
  async pendingCount(actorUserId: string): Promise<PendingDepositReportsCount> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const row = await this.queued(trx, { status: 'pending' })
        .select([
          (eb) => eb.fn.countAll<string>().as('total'),
          sql<string>`count(*) FILTER (WHERE ${FINANCED_BY_PLATFORM})`.as('platform'),
        ])
        .executeTakeFirst();
      const total = Number(row?.total ?? 0);
      const platform = Number(row?.platform ?? 0);
      return { total, platform, network: total - platform };
    });
  }

  /** Los informes que ve y puede resolver quien pide, con su nodo y su financiador, filtrados. */
  private queued(trx: Transaction<DB>, filter: QueueFilter) {
    let q = trx
      .selectFrom('portfolio_deposit_reports as r')
      .innerJoin('tenants as t', 't.id', 'r.tenant_id')
      .leftJoin('tenants as f', (join) =>
        join.on(sql<boolean>`f.id = tenant_financier_id(r.tenant_id)`),
      )
      .where('r.status', '=', filter.status)
      .where(sql<boolean>`can_finance_tenant(r.tenant_id)`);

    if (filter.currency !== undefined) q = q.where('r.currency', '=', filter.currency);
    if (filter.financedBy === 'platform') q = q.where(FINANCED_BY_PLATFORM);
    if (filter.financedBy === 'network') q = q.where(sql<boolean>`NOT ${FINANCED_BY_PLATFORM}`);
    if (filter.tenantId !== undefined) {
      q = q.where(
        sql<boolean>`t.path OPERATOR(public.<@) (SELECT root.path FROM tenants root WHERE root.id = ${filter.tenantId}::uuid)`,
      );
    }
    if (filter.q !== undefined) {
      const like = `%${escapeLike(filter.q)}%`;
      q = q.where((eb) =>
        eb.or([
          eb('r.reference', 'ilike', like),
          eb('t.name', 'ilike', like),
          eb('t.slug', 'ilike', like),
        ]),
      );
    }
    return q;
  }
}
