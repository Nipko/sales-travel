import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import {
  PROVIDER_WRITE_OPERATION_TYPES,
  type DB,
  type OrderAncillaryLineStatus,
  type OrderOperationStatus,
} from '../database/database.types.js';
import type { AncillaryCategory, AncillarySegment } from '@sales-travel/canonical';
import type { OrderRow } from './orders.service.js';
import {
  servicesOperationBlocks,
  type ServicesOperationResult,
  type SettledServiceLine,
  type StoredServiceLine,
} from './order-services.plan.js';

/*
 * Los cambios de servicios adicionales de una orden en Postgres (0086): la operación durable
 * (`add-services` / `remove-services`, con el CAS de 0083) y las líneas agregadas. Todo con el
 * tenant fijado (RLS forzada). Las escrituras que mueven el total de la orden corren dentro de la
 * transacción de la retención de cartera (`BookingHoldPolicyService.adjustOrderHold`): el total, la
 * retención y la operación se mueven juntos o no se mueve ninguno.
 */

export type ServicesOperationType = 'add-services' | 'remove-services';

export const SERVICES_OPERATION_TYPES: readonly ServicesOperationType[] = [
  'add-services',
  'remove-services',
];

/**
 * Por qué no se tomó el claim de un cambio de servicios.
 *
 * - `not-found`: la orden no es de este tenant.
 * - `not-confirmed`: no está confirmada (emitida, cancelada o con una cancelación en curso).
 * - `currency-changed`: la moneda no es la que vio el vendedor.
 * - `already-pending`: hay otra escritura en el proveedor pendiente (0083): emitir o servicios.
 * - `previous-unverified`: el último cambio de servicios quedó en duda; se concilia antes.
 */
export type ServicesClaimRefusal =
  | 'not-found'
  | 'not-confirmed'
  | 'currency-changed'
  | 'already-pending'
  | 'previous-unverified';

/** El claim no se tomó: la transacción entera se deshace. */
export class ServicesClaimRefusedError extends Error {
  constructor(readonly refusal: ServicesClaimRefusal) {
    super(`claim de servicios rechazado: ${refusal}`);
    this.name = 'ServicesClaimRefusedError';
  }
}

/** Una línea guardada, completa: lo que ve la pantalla y lo que hace falta para quitarla. */
export interface ServiceLineRecord extends StoredServiceLine {
  readonly passengerIndex: number;
  readonly name: string;
  readonly category: AncillaryCategory;
  readonly serviceCode: string;
  readonly segments: readonly AncillarySegment[];
  readonly currency: string;
}

export interface ServicesOperationRecord {
  readonly id: string;
  readonly orderId: string;
  readonly type: ServicesOperationType;
  readonly status: OrderOperationStatus;
  readonly result: unknown;
  readonly actorUserId: string | null;
}

/** `pg` entrega BIGINT como texto. */
export function minorOf(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : Number.NaN;
}

function segmentsOf(raw: unknown): AncillarySegment[] {
  return Array.isArray(raw) ? (raw as AncillarySegment[]) : [];
}

function toLine(row: {
  id: string;
  added_operation_id: string;
  passenger_index: number;
  name: string;
  category: AncillaryCategory;
  service_code: string;
  segments: unknown;
  amount_minor: unknown;
  currency: string;
  status: OrderAncillaryLineStatus;
  provider_item_ids: string[];
  provider_item_ids_shared: boolean;
}): ServiceLineRecord {
  return {
    id: row.id,
    addedOperationId: row.added_operation_id,
    passengerIndex: row.passenger_index,
    name: row.name,
    category: row.category,
    serviceCode: row.service_code,
    segments: segmentsOf(row.segments),
    amountMinor: minorOf(row.amount_minor),
    currency: row.currency,
    status: row.status,
    providerItemIds: row.provider_item_ids,
    providerItemIdsShared: row.provider_item_ids_shared,
  };
}

const LINE_COLUMNS = [
  'id',
  'added_operation_id',
  'passenger_index',
  'name',
  'category',
  'service_code',
  'segments',
  'amount_minor',
  'currency',
  'status',
  'provider_item_ids',
  'provider_item_ids_shared',
] as const;

@Injectable()
export class OrderServicesStore {
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

  /** Las líneas de la orden, en el orden en que se agregaron. */
  async listLines(tenantId: string, orderId: string): Promise<ServiceLineRecord[]> {
    return this.db.withTenant(tenantId, (trx) => this.linesWithin(trx, orderId));
  }

  async linesWithin(trx: Transaction<DB>, orderId: string): Promise<ServiceLineRecord[]> {
    const rows = await trx
      .selectFrom('order_ancillary_lines')
      .select(LINE_COLUMNS)
      .where('order_id', '=', orderId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => toLine(row as Parameters<typeof toLine>[0]));
  }

  /**
   * ¿Hay algo que impida un cambio nuevo? `pending` si hay una escritura en el proveedor en curso
   * (cualquiera de 0083); `unverified` si el último cambio de servicios quedó en duda.
   */
  async blocking(tenantId: string, orderId: string): Promise<'pending' | 'unverified' | null> {
    return this.db.withTenant(tenantId, (trx) => this.blockingWithin(trx, orderId));
  }

  private async blockingWithin(
    trx: Transaction<DB>,
    orderId: string,
  ): Promise<'pending' | 'unverified' | null> {
    const pending = await trx
      .selectFrom('order_operations')
      .select('id')
      .where('order_id', '=', orderId)
      .where('status', '=', 'pending')
      .where('type', 'in', [...PROVIDER_WRITE_OPERATION_TYPES])
      .executeTakeFirst();
    if (pending) return 'pending';
    const latest = await trx
      .selectFrom('order_operations')
      .select(['status', 'result'])
      .where('order_id', '=', orderId)
      .where('type', 'in', [...SERVICES_OPERATION_TYPES])
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (latest && servicesOperationBlocks(latest.status, latest.result)) return 'unverified';
    return null;
  }

  /**
   * Toma el claim de un cambio de servicios dentro de la transacción de quien llama: la fila de la
   * orden bloqueada y `confirmed` (una cancelación toma el mismo lock y la deja `pending`; emitir
   * exige `confirmed` y comparte el índice de 0083), en la moneda que vio el vendedor, sin otra
   * escritura pendiente y sin un cambio anterior en duda. El INSERT es el CAS final.
   *
   * @throws ServicesClaimRefusedError si no se toma: la transacción entera se deshace.
   */
  async claimWithin(
    trx: Transaction<DB>,
    tenantId: string,
    orderId: string,
    type: ServicesOperationType,
    actorUserId: string,
    currency: string,
    result: ServicesOperationResult,
  ): Promise<{ readonly operationId: string; readonly totalMinor: number }> {
    const order = await trx
      .selectFrom('orders')
      .select(['id', 'status', 'currency', 'total_amount'])
      .where('id', '=', orderId)
      .where('tenant_id', '=', tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) throw new ServicesClaimRefusedError('not-found');
    if (order.status !== 'confirmed') throw new ServicesClaimRefusedError('not-confirmed');
    if (order.currency.trim().toUpperCase() !== currency) {
      throw new ServicesClaimRefusedError('currency-changed');
    }
    const blocked = await this.blockingWithin(trx, orderId);
    if (blocked === 'pending') throw new ServicesClaimRefusedError('already-pending');
    if (blocked === 'unverified') throw new ServicesClaimRefusedError('previous-unverified');

    const inserted = await trx
      .insertInto('order_operations')
      .values({
        tenant_id: tenantId,
        order_id: orderId,
        type,
        status: 'pending',
        last_error: null,
        result: JSON.stringify(result),
        actor_user_id: actorUserId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { operationId: inserted.id, totalMinor: minorOf(order.total_amount) };
  }

  /** Suma (o resta) al total de la orden. Devuelve el total nuevo. */
  async addToTotalWithin(
    trx: Transaction<DB>,
    orderId: string,
    deltaMinor: number,
  ): Promise<number> {
    const row = await trx
      .updateTable('orders')
      .set({ total_amount: sql<number>`total_amount + ${deltaMinor}` })
      .where('id', '=', orderId)
      .where('status', '=', 'confirmed')
      .returning('total_amount')
      .executeTakeFirst();
    if (!row) throw new ServicesClaimRefusedError('not-confirmed');
    return minorOf(row.total_amount);
  }

  /** Guarda las líneas que quedaron (o quedaron en duda) de un alta. */
  async insertLinesWithin(
    trx: Transaction<DB>,
    tenantId: string,
    orderId: string,
    operationId: string,
    lines: readonly SettledServiceLine[],
  ): Promise<void> {
    const kept = lines.filter((line) => line.status !== 'failed');
    if (kept.length === 0) return;
    await trx
      .insertInto('order_ancillary_lines')
      .values(
        kept.map((line) => ({
          tenant_id: tenantId,
          order_id: orderId,
          added_operation_id: operationId,
          service_offer_item_id: line.serviceOfferItemId,
          passenger_index: line.passengerIndex,
          category: line.category,
          service_code: line.serviceCode,
          airline_code: line.airlineCode,
          name: line.name,
          segments: JSON.stringify(line.segments),
          amount_minor: line.amountMinor,
          currency: line.currency,
          provider_item_ids: [...line.providerItemIds],
          provider_item_ids_shared: line.providerItemIdsShared,
          status: line.status === 'active' ? ('active' as const) : ('unverified' as const),
        })),
      )
      .execute();
  }

  /** Marca líneas quitadas (o quitadas en duda) por una operación. CAS: sólo las activas. */
  async markLinesWithin(
    trx: Transaction<DB>,
    orderId: string,
    lineIds: readonly string[],
    status: 'removed' | 'remove-unverified',
    operationId: string,
  ): Promise<number> {
    if (lineIds.length === 0) return 0;
    const rows = await trx
      .updateTable('order_ancillary_lines')
      .set({ status, removed_operation_id: operationId })
      .where('order_id', '=', orderId)
      .where('id', 'in', [...lineIds])
      .where('status', '=', 'active')
      .returning('id')
      .execute();
    return rows.length;
  }

  /** Cierra la operación. CAS desde `pending`: `false` = otra ejecución ya la cerró. */
  async settleWithin(
    trx: Transaction<DB>,
    operationId: string,
    status: Exclude<OrderOperationStatus, 'pending'>,
    result: ServicesOperationResult,
    lastError: string | null,
  ): Promise<boolean> {
    const row = await trx
      .updateTable('order_operations')
      .set({ status, last_error: lastError, result: JSON.stringify(result) })
      .where('id', '=', operationId)
      .where('type', 'in', [...SERVICES_OPERATION_TYPES])
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Los cambios de servicios de este tenant pendientes desde antes de `cutoff`. */
  async listStale(tenantId: string, cutoff: Date): Promise<ServicesOperationRecord[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('order_operations')
        .select(['id', 'order_id', 'type', 'status', 'result', 'actor_user_id'])
        .where('type', 'in', [...SERVICES_OPERATION_TYPES])
        .where('status', '=', 'pending')
        .where(sql<boolean>`updated_at < ${cutoff}`)
        .orderBy('updated_at')
        .limit(100)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        type: row.type as ServicesOperationType,
        status: row.status,
        result: row.result,
        actorUserId: row.actor_user_id,
      }));
    });
  }
}
