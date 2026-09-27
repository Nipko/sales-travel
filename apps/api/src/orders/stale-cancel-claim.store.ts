import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, OrderOperationStatus } from '../database/database.types.js';
import { persistedPriorOrderStatus } from './cancel-retry-policy.js';

/**
 * Los claims de cancelación que se quedaron en vuelo, en Postgres (HARD-1; 0021 y 0037).
 *
 * Un claim es la fila `order_operations` `cancel` en `pending`: el índice de 0037 la hace única por
 * orden y la cancelación la cierra al terminar. Si el proceso muere con el write en vuelo, la fila
 * queda `pending` para siempre y bloquea toda cancelación nueva de la orden. `updated_at` (trigger
 * de 0021) dice desde cuándo es de este claim: el INSERT del claim nuevo y el UPDATE que toma un
 * reintento lo mueven, y nada más lo toca mientras el claim está en vuelo.
 *
 * Todo corre con el tenant fijado: las tablas tienen RLS forzada y el barrido recorre los tenants
 * uno por uno.
 */

/** Un claim que lleva en vuelo más de lo que puede durar una cancelación. Sin PII. */
export interface StaleCancelClaim {
  readonly operationId: string;
  readonly orderId: string;
  readonly provider: string;
  /** El dueño de la orden. */
  readonly userId: string;
  /** Quien pidió la cancelación, si se sabe. */
  readonly actorUserId: string | null;
  /** El estado de la orden antes del claim, del resultado durable del claim. */
  readonly priorStatus: string | undefined;
}

/** Lo que queda en la operación al vencer el claim. */
export interface StaleCancelClaimExpiry {
  /** El mismo corte con que se listó: el CAS no vence un claim tomado después. */
  readonly claimedBefore: number;
  readonly lastError: string;
  readonly result: Readonly<Record<string, unknown>>;
}

@Injectable()
export class StaleCancelClaimStore {
  constructor(private readonly db: DatabaseService) {}

  /** Los claims de un tenant tomados antes de `claimedBefore`, el más viejo primero. */
  async listStale(
    tenantId: string,
    query: { readonly claimedBefore: number; readonly limit: number },
  ): Promise<StaleCancelClaim[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('order_operations as op')
        .innerJoin('orders as o', (join) =>
          join.onRef('o.id', '=', 'op.order_id').onRef('o.tenant_id', '=', 'op.tenant_id'),
        )
        .select([
          'op.id',
          'op.order_id',
          'op.result',
          'op.actor_user_id',
          'o.provider',
          'o.user_id',
        ])
        .where('op.tenant_id', '=', tenantId)
        .where('op.type', '=', 'cancel')
        .where('op.status', '=', 'pending')
        .where(sql<boolean>`op.updated_at <= ${new Date(query.claimedBefore)}`)
        .orderBy('op.updated_at')
        .limit(query.limit)
        .execute();
      return rows.map((row) => ({
        operationId: row.id,
        orderId: row.order_id,
        provider: row.provider,
        userId: row.user_id,
        actorUserId: row.actor_user_id,
        priorStatus: persistedPriorOrderStatus(row.result),
      }));
    });
  }

  /**
   * En una transacción: la operación pasa de `pending` a `failed` con el resultado dado (CAS sobre
   * el estado y sobre `updated_at`, que no puede ser posterior al corte) y `inTransaction` escribe lo
   * que acompaña al cierre. `false` = el claim ya no está en vuelo o lo tomó alguien después del
   * corte, y no se escribió nada.
   */
  async expire(
    tenantId: string,
    claim: Pick<StaleCancelClaim, 'operationId'>,
    expiry: StaleCancelClaimExpiry,
    inTransaction?: (trx: Transaction<DB>) => Promise<void>,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const expired = await trx
        .updateTable('order_operations')
        .set({
          status: 'failed' as OrderOperationStatus,
          last_error: expiry.lastError,
          result: JSON.stringify(expiry.result),
        })
        .where('id', '=', claim.operationId)
        .where('tenant_id', '=', tenantId)
        .where('type', '=', 'cancel')
        .where('status', '=', 'pending')
        .where(sql<boolean>`updated_at <= ${new Date(expiry.claimedBefore)}`)
        .returning('id')
        .executeTakeFirst();
      if (expired === undefined) return false;
      await inTransaction?.(trx);
      return true;
    });
  }
}
