import { Injectable } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type {
  DB,
  HotelOrderSubStatus,
  OrderStatus,
  ReconciliationItemAction,
  ReconciliationRunStatus,
  ReconciliationRunTrigger,
} from '../database/database.types.js';
import type { DiscrepancySeverity, ReconciliationDiscrepancyKind } from '../orders/order-events.js';
import type { ReconciliationOrder, ReconciliationWindow } from './reconciliation.plan.js';

/**
 * Lo que la conciliación lee y escribe en Postgres (docs/tbo/09 PR-5.5; 04 §9.2 y §9.6; 0047).
 *
 * `orders`, `hotel_order_tracking`, `provider_accounts` y las tablas de 0047 tienen RLS forzada y la
 * API corre como `app_user`, sin rol de mantenimiento ni función que la salte (pendiente c de la
 * Fase 5). La conciliación es por cuenta, y las órdenes de una cuenta heredada son de varias
 * agencias: se recorren los tenants de la red del dueño de la cuenta uno por uno, cada uno con su
 * contexto (`withTenant`), y sólo se leen las órdenes hechas con ESA cuenta. `tenants` no tiene RLS.
 *
 * La corrida se escribe en el tenant del dueño. Un ítem, en el tenant que lo puede ver: el de la
 * orden, o el dueño en R2 y R6 (0047).
 */

/** Cuántas claves se mandan por consulta al buscar las órdenes que cruzan con el listado. */
const KEYS_PER_QUERY = 500;

export interface StartRunInput {
  readonly accountId: string;
  readonly providerCode: string;
  readonly trigger: ReconciliationRunTrigger;
  readonly requestedBy?: string;
  /** Una corrida `running` que empezó antes de esto se da por abandonada. */
  readonly staleBefore: number;
}

export interface FinishRunInput {
  readonly status: Exclude<ReconciliationRunStatus, 'running' | 'abandoned'>;
  readonly windows: readonly ReconciliationWindow[];
  readonly rowsRead: number;
  readonly rowsMatched: number;
  readonly discrepancies: number;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly errorClass?: string;
}

/** Una corrida tal como la ve el dueño de la cuenta. */
export interface ReconciliationRunRow {
  readonly id: string;
  readonly trigger: ReconciliationRunTrigger;
  readonly status: ReconciliationRunStatus;
  readonly windows: unknown;
  readonly rowsRead: number;
  readonly rowsMatched: number;
  readonly discrepancies: number;
  readonly summary: unknown;
  readonly errorClass: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface ReconciliationItemInput {
  readonly runId: string;
  readonly accountId: string;
  readonly providerCode: string;
  readonly kind: ReconciliationDiscrepancyKind;
  readonly severity: DiscrepancySeverity;
  readonly action: ReconciliationItemAction;
  readonly orderId?: string;
  readonly providerBookingId?: string;
  readonly dedupeKey: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ReconciliationItemRow {
  readonly id: string;
  readonly runId: string;
  readonly kind: ReconciliationDiscrepancyKind;
  readonly severity: DiscrepancySeverity;
  readonly action: ReconciliationItemAction;
  readonly orderId: string | null;
  readonly providerBookingId: string | null;
  readonly details: unknown;
  readonly createdAt: Date;
}

export interface AccountOrdersQuery {
  readonly provider: string;
  readonly accountId: string;
}

interface OrderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  status: OrderStatus;
  provider_order_id: string | null;
  provider_booking_ref: string | null;
  provider_raw_null: boolean;
  created_at: Date | string;
  sub_status: HotelOrderSubStatus | null;
  provider_status: string | null;
  refund_awaited: boolean | null;
  verify_next_at: Date | string | null;
  cancel_verify_anchor_at: Date | string | null;
  net_minor: string | null;
  net_currency: string | null;
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function dateOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** `selected_offer.pricing` (`hotel-booking.service.ts`): el neto del proveedor, si se lee. */
function netOf(minor: string | null, currency: string | null): Money | null {
  if (minor === null || currency === null || !/^[A-Z]{3}$/.test(currency)) return null;
  if (!/^-?\d{1,15}$/.test(minor)) return null;
  const amountMinor = Number(minor);
  return Number.isSafeInteger(amountMinor) ? { amountMinor, currency } : null;
}

function orderOf(r: OrderRow): ReconciliationOrder {
  return {
    tenantId: r.tenant_id,
    orderId: r.id,
    userId: r.user_id,
    status: r.status,
    subStatus: r.sub_status,
    providerStatus: r.provider_status,
    refundAwaited: r.refund_awaited === true,
    providerOrderId: r.provider_order_id,
    bookingReference: r.provider_booking_ref,
    createdAt: epoch(r.created_at),
    openIntent:
      r.status === 'pending' &&
      r.provider_raw_null &&
      r.provider_order_id === null &&
      r.provider_booking_ref !== null,
    verificationScheduled: r.verify_next_at !== null,
    cancelSince: r.cancel_verify_anchor_at === null ? null : epoch(r.cancel_verify_anchor_at),
    net: netOf(r.net_minor, r.net_currency),
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

@Injectable()
export class ReconciliationStore {
  constructor(private readonly db: DatabaseService) {}

  /** Todos los tenants, en orden estable. `tenants` no tiene RLS. */
  async allTenants(): Promise<string[]> {
    const rows = await this.db.db.selectFrom('tenants').select('id').orderBy('id').execute();
    return rows.map((r) => r.id);
  }

  /**
   * El dueño y su subárbol: los únicos tenants que pueden tener órdenes hechas con su cuenta
   * (propia o heredada). El `path` no se reescribe nunca (0011), así que la red es estable.
   */
  async networkOf(ownerTenantId: string): Promise<string[]> {
    const rows = await this.db.db
      .selectFrom('tenants as t')
      .innerJoin('tenants as owner', (join) => join.on('owner.id', '=', ownerTenantId))
      .select('t.id')
      .where(sql<boolean>`t.path OPERATOR(public.<@) owner.path`)
      .orderBy('t.id')
      .execute();
    return rows.map((r) => r.id);
  }

  /**
   * Las órdenes de la cuenta en un tenant que la corrida tiene que cubrir (tramo B, 04 §9.3): las
   * activas —`pending`, `confirmed` o `ticketed` con check-out desde `checkoutFrom`, o sin fecha de
   * salida legible— y todo intent sin desenlace, tenga la fecha que tenga.
   */
  async listAnchors(
    tenantId: string,
    query: AccountOrdersQuery & { readonly checkoutFrom: string },
  ): Promise<ReconciliationOrder[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await this.orders(trx, tenantId, query)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('o.status', '=', 'pending'),
              eb('o.provider_raw', 'is', null),
              eb('o.provider_order_id', 'is', null),
              eb('o.provider_booking_ref', 'is not', null),
            ]),
            eb.and([
              eb('o.status', 'in', ['pending', 'confirmed', 'ticketed']),
              // La fecha se compara como texto ISO, como en 0045: nunca falla con un valor raro.
              sql<boolean>`CASE
                WHEN (o.search_criteria ->> 'checkoutDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN (o.search_criteria ->> 'checkoutDate') >= ${query.checkoutFrom}
                ELSE true
              END`,
            ]),
          ]),
        )
        .execute();
      return rows.map((row) => orderOf(row as unknown as OrderRow));
    });
  }

  /**
   * Las órdenes de la cuenta en un tenant cuyo localizador o cuya referencia aparecen en el listado.
   * La comparación es sin distinguir mayúsculas, como el cruce.
   */
  async listByKeys(
    tenantId: string,
    query: AccountOrdersQuery & {
      readonly locators: readonly string[];
      readonly references: readonly string[];
    },
  ): Promise<ReconciliationOrder[]> {
    const locators = [...new Set(query.locators.map((k) => k.trim().toUpperCase()))];
    const references = [...new Set(query.references.map((k) => k.trim().toUpperCase()))];
    if (locators.length === 0 && references.length === 0) return [];
    return this.db.withTenant(tenantId, async (trx) => {
      const found = new Map<string, ReconciliationOrder>();
      const lookups: [string, string[]][] = [
        ...chunks(locators, KEYS_PER_QUERY).map((c): [string, string[]] => ['locator', c]),
        ...chunks(references, KEYS_PER_QUERY).map((c): [string, string[]] => ['reference', c]),
      ];
      for (const [by, values] of lookups) {
        const rows = await this.orders(trx, tenantId, query)
          .where(
            by === 'locator'
              ? sql<boolean>`upper(o.provider_order_id) IN (${sql.join(values)})`
              : sql<boolean>`upper(o.provider_booking_ref) IN (${sql.join(values)})`,
          )
          .execute();
        for (const row of rows) {
          const order = orderOf(row as unknown as OrderRow);
          found.set(order.orderId, order);
        }
      }
      return [...found.values()];
    });
  }

  /**
   * Abre una corrida. `undefined` = ya hay una en curso para la cuenta (el índice único de 0047):
   * otro disparo llegó antes. Una en curso desde antes de `staleBefore` se da por abandonada primero.
   */
  async startRun(ownerTenantId: string, input: StartRunInput): Promise<string | undefined> {
    await this.db.withTenant(ownerTenantId, (trx) =>
      trx
        .updateTable('provider_reconciliation_runs')
        .set({
          status: 'abandoned',
          finished_at: sql<Date>`now()`,
          error_class: 'StaleRun',
        })
        .where('tenant_id', '=', ownerTenantId)
        .where('account_id', '=', input.accountId)
        .where('status', '=', 'running')
        // `started_at` es `Generated<Timestamp>` en los tipos: la comparación va en SQL.
        .where(sql<boolean>`started_at < ${new Date(input.staleBefore)}`)
        .execute(),
    );
    try {
      const row = await this.db.withTenant(ownerTenantId, (trx) =>
        trx
          .insertInto('provider_reconciliation_runs')
          .values({
            tenant_id: ownerTenantId,
            account_id: input.accountId,
            provider_code: input.providerCode,
            trigger: input.trigger,
            requested_by: input.requestedBy ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      return row.id;
    } catch (err) {
      if (isRunningConflict(err)) return undefined;
      throw err;
    }
  }

  async finishRun(ownerTenantId: string, runId: string, input: FinishRunInput): Promise<void> {
    await this.db.withTenant(ownerTenantId, (trx) =>
      trx
        .updateTable('provider_reconciliation_runs')
        .set({
          status: input.status,
          windows: JSON.stringify(input.windows),
          rows_read: input.rowsRead,
          rows_matched: input.rowsMatched,
          discrepancies: input.discrepancies,
          summary: JSON.stringify(input.summary),
          error_class: input.errorClass?.slice(0, 200) ?? null,
          finished_at: sql<Date>`now()`,
        })
        .where('id', '=', runId)
        .where('tenant_id', '=', ownerTenantId)
        .where('status', '=', 'running')
        .execute(),
    );
  }

  /** Las corridas de la cuenta, la más nueva primero. */
  async listRuns(
    ownerTenantId: string,
    accountId: string,
    query: { readonly since?: number; readonly limit: number },
  ): Promise<ReconciliationRunRow[]> {
    const rows = await this.db.withTenant(ownerTenantId, (trx) => {
      let q = trx
        .selectFrom('provider_reconciliation_runs')
        .select([
          'id',
          'trigger',
          'status',
          'windows',
          'rows_read',
          'rows_matched',
          'discrepancies',
          'summary',
          'error_class',
          'started_at',
          'finished_at',
        ])
        .where('tenant_id', '=', ownerTenantId)
        .where('account_id', '=', accountId);
      if (query.since !== undefined) {
        q = q.where(sql<boolean>`started_at >= ${new Date(query.since)}`);
      }
      return q.orderBy('started_at', 'desc').limit(query.limit).execute();
    });
    return rows.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      windows: r.windows,
      rowsRead: Number(r.rows_read),
      rowsMatched: Number(r.rows_matched),
      discrepancies: Number(r.discrepancies),
      summary: r.summary,
      errorClass: r.error_class,
      startedAt: dateOf(r.started_at as unknown as Date | string),
      finishedAt: r.finished_at === null ? null : dateOf(r.finished_at as unknown as Date | string),
    }));
  }

  /**
   * Registra una divergencia en el tenant que la puede ver. `false` = ya estaba (la misma clase, el
   * mismo sujeto y el mismo valor observado): quien llama no vuelve a avisar (04 §9.5 punto 4).
   */
  async recordItem(tenantId: string, item: ReconciliationItemInput): Promise<boolean> {
    const row = await this.db.withTenant(tenantId, (trx) =>
      trx
        .insertInto('provider_reconciliation_items')
        .values({
          tenant_id: tenantId,
          run_id: item.runId,
          account_id: item.accountId,
          provider_code: item.providerCode,
          kind: item.kind,
          severity: item.severity,
          action: item.action,
          order_id: item.orderId ?? null,
          provider_booking_id: item.providerBookingId ?? null,
          dedupe_key: item.dedupeKey,
          details: JSON.stringify(item.details),
        })
        .onConflict((oc) => oc.columns(['account_id', 'dedupe_key']).doNothing())
        .returning('id')
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  /** Los ítems de esas corridas que el tenant puede ver (la RLS deja fuera los de otros). */
  async listItems(tenantId: string, runIds: readonly string[]): Promise<ReconciliationItemRow[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('provider_reconciliation_items')
        .select([
          'id',
          'run_id',
          'kind',
          'severity',
          'action',
          'order_id',
          'provider_booking_id',
          'details',
          'created_at',
        ])
        .where('tenant_id', '=', tenantId)
        .where('run_id', 'in', [...runIds])
        .orderBy('created_at')
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      kind: r.kind,
      severity: r.severity,
      action: r.action,
      orderId: r.order_id,
      providerBookingId: r.provider_booking_id,
      details: r.details,
      createdAt: dateOf(r.created_at as unknown as Date | string),
    }));
  }

  private orders(trx: Transaction<DB>, tenantId: string, query: AccountOrdersQuery) {
    return trx
      .selectFrom('orders as o')
      .leftJoin('hotel_order_tracking as t', (join) =>
        join.onRef('t.order_id', '=', 'o.id').onRef('t.tenant_id', '=', 'o.tenant_id'),
      )
      .select([
        'o.id',
        'o.tenant_id',
        'o.user_id',
        'o.status',
        'o.provider_order_id',
        'o.provider_booking_ref',
        'o.created_at',
        't.sub_status',
        't.provider_status',
        't.refund_awaited',
        't.verify_next_at',
        't.cancel_verify_anchor_at',
        sql<boolean>`o.provider_raw IS NULL`.as('provider_raw_null'),
        sql<string | null>`o.selected_offer -> 'pricing' ->> 'netMinor'`.as('net_minor'),
        sql<string | null>`o.selected_offer -> 'pricing' ->> 'currency'`.as('net_currency'),
      ])
      .where('o.tenant_id', '=', tenantId)
      .where('o.provider', '=', query.provider)
      .where('o.provider_account_id', '=', query.accountId);
  }
}

/** 23505 del índice de 0047 que deja una sola corrida en curso por cuenta. */
function isRunningConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === 'uq_provider_reconciliation_runs_running';
}
