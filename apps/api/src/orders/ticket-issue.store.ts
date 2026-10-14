import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, OrderOperationStatus, OrderStatus } from '../database/database.types.js';
import { uniqueViolationConstraint } from './order-create-intent.store.js';
import type { OrderRow } from './orders.service.js';
import {
  issueOperationPolicy,
  persistedIssueResult,
  type IssueOperationResult,
  type IssueStage,
} from './ticket-issue.plan.js';

/*
 * La operación `issue` de `order_operations` en Postgres (0083). Cada escritura es un CAS sobre la
 * fila —por estado y por etapa—, siempre con el tenant fijado (RLS forzada): dos jobs, el barrido y
 * el vendedor pueden tocar la misma emisión, y sólo uno gana cada transición.
 */

/** El índice de 0083. Un 23505 de otro índice no es "ya hay una emisión": sale tal cual. */
export const PENDING_PROVIDER_WRITE_CONSTRAINT = 'uq_order_operations_pending_provider_write';

export interface IssueOperationRecord {
  readonly id: string;
  readonly orderId: string;
  readonly status: OrderOperationStatus;
  readonly result: IssueOperationResult;
  readonly lastError: string | null;
  readonly actorUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Por qué no se tomó el claim de una emisión nueva.
 *
 * - `not-found`: la orden no es de este tenant o no existe.
 * - `not-confirmed`: la orden no está confirmada (también la que tiene una cancelación en curso, que
 *   la deja `pending`).
 * - `already-pending`: hay una escritura pendiente en el proveedor (0083).
 * - `already-issued`: la última emisión salió bien.
 * - `previous-unverified`: la última quedó en duda; mientras no se concilie, no se reemite.
 */
export type IssueClaimRefusal =
  | 'not-found'
  | 'not-confirmed'
  | 'already-pending'
  | 'already-issued'
  | 'previous-unverified';

export type IssueClaimOutcome =
  | { readonly claimed: true; readonly operationId: string }
  | { readonly claimed: false; readonly refusal: IssueClaimRefusal };

/** Una CAS de cierre: desde qué estados (y, si se dice, desde qué etapa) se puede pasar. */
export interface IssueTransition {
  readonly from: readonly OrderOperationStatus[];
  readonly stage?: IssueStage;
}

export type FinalizeOutcome =
  | { readonly kind: 'finalized'; readonly order: OrderRow }
  | { readonly kind: 'already' }
  | { readonly kind: 'order-changed' };

/** La orden cambió de estado a mitad del cierre: se deshace la transacción entera. */
class OrderChangedDuringFinalize extends Error {
  constructor() {
    super('la orden ya no estaba confirmada al cerrar la emisión');
    this.name = 'OrderChangedDuringFinalize';
  }
}

/** `pg` entrega TIMESTAMPTZ como `Date`; un driver que lo entregue como texto también sirve. */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toRecord(row: {
  id: string;
  order_id: string;
  status: OrderOperationStatus;
  result: unknown;
  last_error: string | null;
  actor_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}): IssueOperationRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status,
    result: persistedIssueResult(row.result),
    lastError: row.last_error,
    actorUserId: row.actor_user_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

const OPERATION_COLUMNS = [
  'id',
  'order_id',
  'status',
  'result',
  'last_error',
  'actor_user_id',
  'created_at',
  'updated_at',
] as const;

@Injectable()
export class TicketIssueStore {
  constructor(private readonly db: DatabaseService) {}

  async findOrder(tenantId: string, orderId: string): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .executeTakeFirst();
      return row as unknown as OrderRow | undefined;
    });
  }

  /**
   * Toma el claim de una emisión nueva: la operación `issue` pendiente, en la etapa `requested`.
   *
   * La fila de la orden se bloquea primero y se exige `confirmed`: una cancelación toma el mismo
   * lock (deja la orden `pending`), así que las dos no se cruzan. Después, la última emisión manda:
   * una en duda no se reemite hasta conciliarla. El INSERT es el CAS final contra un doble clic
   * (índice 0083).
   */
  async claim(
    tenantId: string,
    orderId: string,
    actorUserId: string | null,
    result: IssueOperationResult,
  ): Promise<IssueClaimOutcome> {
    try {
      return await this.db.withTenant(tenantId, async (trx): Promise<IssueClaimOutcome> => {
        const order = await trx
          .selectFrom('orders')
          .select(['id', 'status'])
          .where('id', '=', orderId)
          .forUpdate()
          .executeTakeFirst();
        if (!order) return { claimed: false, refusal: 'not-found' };
        if (order.status !== 'confirmed') return { claimed: false, refusal: 'not-confirmed' };

        const latest = await trx
          .selectFrom('order_operations')
          .select(['status', 'result'])
          .where('order_id', '=', orderId)
          .where('type', '=', 'issue')
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (latest?.status === 'pending') return { claimed: false, refusal: 'already-pending' };
        if (latest?.status === 'success') return { claimed: false, refusal: 'already-issued' };
        if (
          latest?.status === 'failed' &&
          issueOperationPolicy('failed', latest.result).reconciliationRequired
        ) {
          return { claimed: false, refusal: 'previous-unverified' };
        }

        const inserted = await trx
          .insertInto('order_operations')
          .values({
            tenant_id: tenantId,
            order_id: orderId,
            type: 'issue',
            status: 'pending',
            last_error: null,
            result: JSON.stringify(result),
            actor_user_id: actorUserId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return { claimed: true, operationId: inserted.id };
      });
    } catch (error) {
      if (uniqueViolationConstraint(error) === PENDING_PROVIDER_WRITE_CONSTRAINT) {
        return { claimed: false, refusal: 'already-pending' };
      }
      throw error;
    }
  }

  async getOperation(
    tenantId: string,
    orderId: string,
    operationId: string,
  ): Promise<IssueOperationRecord | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('order_operations')
        .select(OPERATION_COLUMNS)
        .where('id', '=', operationId)
        .where('order_id', '=', orderId)
        .where('type', '=', 'issue')
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    });
  }

  /**
   * El write-ahead: `requested` → `sent`, ANTES de llamar al proveedor. Sólo una ejecución lo gana;
   * la que pierde no llama a nadie. Desde aquí la emisión no se reenvía nunca.
   */
  async markSent(
    tenantId: string,
    operationId: string,
    result: IssueOperationResult,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('order_operations')
        .set({ result: JSON.stringify(result) })
        .where('id', '=', operationId)
        .where('type', '=', 'issue')
        .where('status', '=', 'pending')
        .where(sql<string>`result->>'stage'`, '=', 'requested')
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /**
   * Cierra la operación SIN pasar la orden a `ticketed`: rechazada, en duda o abandonada. CAS sobre
   * el estado (y la etapa, si se pide): `false` = otra ejecución ya la movió.
   */
  async settle(
    tenantId: string,
    operationId: string,
    transition: IssueTransition,
    status: Exclude<OrderOperationStatus, 'pending'>,
    result: IssueOperationResult,
    lastError: string | null,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      let query = trx
        .updateTable('order_operations')
        .set({ status, last_error: lastError, result: JSON.stringify(result) })
        .where('id', '=', operationId)
        .where('type', '=', 'issue')
        .where('status', 'in', [...transition.from]);
      if (transition.stage !== undefined) {
        query = query.where(sql<string>`result->>'stage'`, '=', transition.stage);
      }
      const row = await query.returning('id').executeTakeFirst();
      return row !== undefined;
    });
  }

  /**
   * Rehace el `result` sin tocar el estado: el calendario de relecturas o la marca de escalada. CAS
   * sobre el estado que se leyó.
   */
  async updateResult(
    tenantId: string,
    operationId: string,
    expected: OrderOperationStatus,
    result: IssueOperationResult,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('order_operations')
        .set({ result: JSON.stringify(result) })
        .where('id', '=', operationId)
        .where('type', '=', 'issue')
        .where('status', '=', expected)
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /**
   * El cierre de una emisión que salió bien, todo o nada en UNA transacción: la operación en
   * `success`, la orden en `ticketed`, los documentos guardados y el evento (`inTransaction`).
   *
   * - `already`: la operación ya estaba en `success`; no se toca nada.
   * - `order-changed`: la orden ya no estaba confirmada (ni emitida); se deshace todo y lo decide
   *   quien llama.
   */
  async finalizeTicketed(
    tenantId: string,
    orderId: string,
    operationId: string,
    result: IssueOperationResult,
    inTransaction: (trx: Transaction<DB>, order: OrderRow) => Promise<void>,
  ): Promise<FinalizeOutcome> {
    try {
      return await this.db.withTenant(tenantId, async (trx): Promise<FinalizeOutcome> => {
        const closed = await trx
          .updateTable('order_operations')
          .set({ status: 'success', last_error: null, result: JSON.stringify(result) })
          .where('id', '=', operationId)
          .where('order_id', '=', orderId)
          .where('type', '=', 'issue')
          .where('status', '<>', 'success')
          .returning('id')
          .executeTakeFirst();
        if (!closed) return { kind: 'already' };

        const order = await trx
          .updateTable('orders')
          .set({ status: 'ticketed' as OrderStatus })
          .where('id', '=', orderId)
          .where('status', 'in', ['confirmed', 'ticketed'])
          .returningAll()
          .executeTakeFirst();
        if (!order) throw new OrderChangedDuringFinalize();

        const row = order as unknown as OrderRow;
        await inTransaction(trx, row);
        return { kind: 'finalized', order: row };
      });
    } catch (error) {
      if (error instanceof OrderChangedDuringFinalize) return { kind: 'order-changed' };
      throw error;
    }
  }

  /** Las emisiones de este tenant que siguen pendientes desde antes de `cutoff`. */
  async listStale(tenantId: string, cutoff: Date): Promise<IssueOperationRecord[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('order_operations')
        .select(OPERATION_COLUMNS)
        .where('type', '=', 'issue')
        .where('status', '=', 'pending')
        .where(sql<boolean>`updated_at < ${cutoff}`)
        .orderBy('updated_at')
        .limit(100)
        .execute();
      return rows.map(toRecord);
    });
  }
}
