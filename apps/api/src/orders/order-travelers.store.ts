import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import {
  PROVIDER_WRITE_OPERATION_TYPES,
  type DB,
  type OrderOperationStatus,
} from '../database/database.types.js';
import type { OrderRow } from './orders.service.js';
import {
  TRAVELERS_MODIFIABLE_STATUSES,
  type TravelersOperationResult,
} from './order-travelers.plan.js';

/*
 * La operación `modify` de una orden en Postgres (SAB-25): el claim durable con el CAS de 0083 —una
 * escritura pendiente en el proveedor por orden y tenant: emitir, servicios o esto—, su cierre y los
 * pasajeros de la orden con lo que cambió, enmascarado. Todo con el tenant fijado (RLS forzada).
 *
 * El claim ES el lock de la reserva que pide RF-17 CA-4: mientras haya una `modify` pendiente nadie
 * más escribe en esa reserva desde la plataforma, y un segundo pedido choca con el índice.
 */

export const TRAVELERS_OPERATION_TYPE = 'modify';

/**
 * Por qué no se tomó el claim:
 *
 * - `not-found`: la orden no es de este tenant (o no existe).
 * - `not-modifiable`: no está confirmada ni emitida (una cancelación en curso la deja `pending`).
 * - `already-pending`: hay otra escritura en el proveedor pendiente para esta orden (0083).
 */
export type TravelersClaimRefusal = 'not-found' | 'not-modifiable' | 'already-pending';

/** El claim no se tomó: la transacción entera se deshace. */
export class TravelersClaimRefusedError extends Error {
  constructor(readonly refusal: TravelersClaimRefusal) {
    super(`claim de datos de pasajeros rechazado: ${refusal}`);
    this.name = 'TravelersClaimRefusedError';
  }
}

export interface TravelersOperationRecord {
  readonly id: string;
  readonly orderId: string;
  readonly status: OrderOperationStatus;
  readonly result: unknown;
  readonly actorUserId: string | null;
}

@Injectable()
export class OrderTravelersStore {
  constructor(private readonly db: DatabaseService) {}

  /** Una transacción simple con el tenant fijado. */
  run<T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.withTenant(tenantId, fn);
  }

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

  /** ¿Hay una escritura en el proveedor en curso para la orden (cualquiera de 0083)? */
  async pendingWrite(tenantId: string, orderId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, (trx) => this.pendingWithin(trx, orderId));
  }

  private async pendingWithin(trx: Transaction<DB>, orderId: string): Promise<boolean> {
    const pending = await trx
      .selectFrom('order_operations')
      .select('id')
      .where('order_id', '=', orderId)
      .where('status', '=', 'pending')
      .where('type', 'in', [...PROVIDER_WRITE_OPERATION_TYPES])
      .executeTakeFirst();
    return pending !== undefined;
  }

  /**
   * Toma el claim: la fila de la orden bloqueada (una cancelación y una emisión toman el mismo lock),
   * confirmada o emitida, sin otra escritura pendiente. El INSERT es el CAS final contra el índice
   * de 0083: dos pedidos que pasan juntos la comprobación chocan ahí.
   *
   * @throws TravelersClaimRefusedError si no se toma; la violación del índice sube tal cual.
   */
  async claim(
    tenantId: string,
    orderId: string,
    actorUserId: string,
    result: TravelersOperationResult,
  ): Promise<{ readonly operationId: string }> {
    return this.db.withTenant(tenantId, async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .select(['id', 'status'])
        .where('id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new TravelersClaimRefusedError('not-found');
      if (!TRAVELERS_MODIFIABLE_STATUSES.includes(order.status)) {
        throw new TravelersClaimRefusedError('not-modifiable');
      }
      if (await this.pendingWithin(trx, orderId)) {
        throw new TravelersClaimRefusedError('already-pending');
      }
      const inserted = await trx
        .insertInto('order_operations')
        .values({
          tenant_id: tenantId,
          order_id: orderId,
          type: TRAVELERS_OPERATION_TYPE,
          status: 'pending',
          last_error: null,
          result: JSON.stringify(result),
          actor_user_id: actorUserId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { operationId: inserted.id };
    });
  }

  /**
   * Cierra la operación y, si hay qué, deja en la orden los pasajeros con lo que cambió
   * (enmascarado). Una transacción: o se cierra con los pasajeros al día, o nada. CAS desde
   * `pending`: `false` = otra ejecución (el barrido) ya la cerró, y la orden no se toca.
   *
   * `passengersOf` recibe los pasajeros de la orden leídos AQUÍ, con la fila bloqueada, y no la
   * copia que el pedido leyó antes del claim: entre esa lectura y el claim pudo cerrar otro cambio
   * de pasajeros, y escribir sobre la copia vieja le borraría lo suyo —o devolvería a la base el
   * número entero de un documento que ya no es el de la reserva—.
   */
  async settle(
    tenantId: string,
    orderId: string,
    operationId: string,
    status: Exclude<OrderOperationStatus, 'pending'>,
    result: TravelersOperationResult,
    lastError: string | null,
    passengersOf?: (current: unknown) => readonly Record<string, unknown>[] | undefined,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('order_operations')
        .set({ status, last_error: lastError, result: JSON.stringify(result) })
        .where('id', '=', operationId)
        .where('order_id', '=', orderId)
        .where('type', '=', TRAVELERS_OPERATION_TYPE)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (row === undefined) return false;
      if (passengersOf !== undefined) {
        const current = await trx
          .selectFrom('orders')
          .select('passengers')
          .where('id', '=', orderId)
          .forUpdate()
          .executeTakeFirst();
        const passengers = current === undefined ? undefined : passengersOf(current.passengers);
        if (passengers !== undefined) {
          await trx
            .updateTable('orders')
            .set({ passengers: JSON.stringify(passengers) })
            .where('id', '=', orderId)
            .execute();
        }
      }
      return true;
    });
  }

  /** Las `modify` de este tenant pendientes desde antes de `cutoff`. */
  async listStale(tenantId: string, cutoff: Date): Promise<TravelersOperationRecord[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('order_operations')
        .select(['id', 'order_id', 'status', 'result', 'actor_user_id'])
        .where('type', '=', TRAVELERS_OPERATION_TYPE)
        .where('status', '=', 'pending')
        .where(sql<boolean>`updated_at < ${cutoff}`)
        .orderBy('updated_at')
        .limit(100)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        status: row.status,
        result: row.result,
        actorUserId: row.actor_user_id,
      }));
    });
  }
}
