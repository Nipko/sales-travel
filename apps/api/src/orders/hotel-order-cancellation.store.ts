import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type {
  DB,
  HcnState,
  HotelOrderSubStatus,
  OrderStatus,
  ProviderStatusSource,
} from '../database/database.types.js';
import { resolvePendingHcnTickets } from '../hotels/hcn-ticket.js';
import type { HotelCancelVerifyCalendar } from '../hotels/hotel-cancellation-verification.js';
import type {
  HotelOrderHcnRecord,
  HotelOrderReadRecord,
  HotelOrderSnapshot,
} from '../hotels/hotel-order-state.js';
import { CANCEL_SUCCESS_POLICY, persistedCancelRetryPolicy } from './cancel-retry-policy.js';

/**
 * Lo que la cancelación de una orden de hotel lee y escribe en Postgres (docs/tbo/09 PR-5.3; 08
 * RF-25, RF-26, RF-38; 0042 y 0046).
 *
 * Dos clases de escritura:
 *
 * - **Dentro de la transacción de la cancelación** (`markRequested`, `writeOutcome`): el subestado
 *   del claim y lo que dejó la respuesta del proveedor se escriben junto con la operación
 *   `cancel` y `orders.status`. Si fueran aparte, un proceso que muere entre las dos dejaría la
 *   orden con `cancel-requested` para siempre, y ese subestado bloquea a la verificación y a la
 *   conciliación.
 * - **La verificación** (`advance`, `close`): CAS sobre el paso del calendario, como la del Book
 *   (0044). El job y el barrido pueden llegar al mismo paso; sólo el que lo avanza sigue.
 *
 * Todo corre con el tenant fijado: `orders`, `order_operations` y `hotel_order_tracking` tienen RLS
 * forzada, y el barrido recorre los tenants uno por uno (pendiente c de la Fase 5).
 */

/** Una orden de hotel con lo que su cancelación y su verificación necesitan. Sin PII. */
export interface HotelCancelTarget {
  readonly orderId: string;
  readonly provider: string;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly providerOrderId: string | null;
  /** La cuenta con la que se reservó (0042); la post-venta usa ésta (D-TBO-28 A). */
  readonly providerAccountId: string | null;
  readonly bookingReference: string | null;
  readonly snapshot: HotelOrderSnapshot;
  readonly calendar: HotelCancelVerifyCalendar;
}

/**
 * Lo que la cancelación (o su verificación, o la conciliación que ve una cancelación hecha fuera)
 * deja en la fila de seguimiento.
 */
export interface HotelCancelTrackingWrite {
  /** Epoch ms de la observación. */
  readonly at: number;
  readonly source: Extract<ProviderStatusSource, 'cancel' | 'verify' | 'reconciliation'>;
  /** Ausente = no hubo lectura que registrar. */
  readonly record?: HotelOrderReadRecord;
  /** Ausente = no se toca. */
  readonly subStatus?: HotelOrderSubStatus | null;
  readonly hcn?: HotelOrderHcnRecord;
  /** La reserva ya no está viva: el seguimiento del HCN se corta. */
  readonly stopHcn?: boolean;
  /** Abre el calendario de verificación en el paso 0 (reemplaza uno anterior). */
  readonly openCalendar?: { readonly anchorAt: number; readonly nextAt: number };
}

/** Lo que cambia en la fila al terminar un paso de la verificación. */
export interface HotelCancelVerifyAdvance {
  /** El próximo paso: siempre mayor que el que se ejecutó. */
  readonly step: number;
  /** `null` = nada más programado. */
  readonly nextAt: number | null;
  readonly write?: Omit<HotelCancelTrackingWrite, 'openCalendar'>;
}

interface TargetRow {
  id: string;
  provider: string;
  user_id: string;
  status: OrderStatus;
  provider_order_id: string | null;
  provider_account_id: string | null;
  provider_booking_ref: string | null;
  provider_status: string | null;
  provider_voucher_status: string | null;
  sub_status: HotelOrderSubStatus | null;
  refund_awaited: boolean | null;
  hcn: string | null;
  hcn_state: HcnState | null;
  cancel_verify_anchor_at: Date | string | null;
  cancel_verify_step: number | string | null;
  cancel_verify_next_at: Date | string | null;
}

function epochOrNull(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function targetOf(r: TargetRow): HotelCancelTarget {
  return {
    orderId: r.id,
    provider: r.provider,
    userId: r.user_id,
    status: r.status,
    providerOrderId: r.provider_order_id,
    providerAccountId: r.provider_account_id,
    bookingReference: r.provider_booking_ref,
    snapshot: {
      status: r.status,
      subStatus: r.sub_status,
      providerStatus: r.provider_status,
      voucherStatus: r.provider_voucher_status,
      refundAwaited: r.refund_awaited === true,
      hcn: r.hcn,
      hcnState: r.hcn_state,
    },
    calendar: {
      anchorAt: epochOrNull(r.cancel_verify_anchor_at),
      // SMALLINT llega como número; se normaliza por si un driver lo trae como texto.
      step: r.cancel_verify_step === null ? null : Number(r.cancel_verify_step),
      nextAt: epochOrNull(r.cancel_verify_next_at),
    },
  };
}

/** Las columnas de una escritura, para el INSERT (fila nueva) y para el UPDATE (fila existente). */
function columnsOf(write: HotelCancelTrackingWrite) {
  const common = {
    ...(write.record === undefined
      ? {}
      : {
          provider_status: write.record.providerStatus,
          provider_status_at: new Date(write.at),
          provider_status_source: write.source,
          refund_awaited: write.record.refundAwaited,
          ...(write.record.voucherStatus === undefined
            ? {}
            : { provider_voucher_status: write.record.voucherStatus }),
        }),
    ...(write.subStatus === undefined ? {} : { sub_status: write.subStatus }),
    ...(write.hcn === undefined
      ? {}
      : {
          hcn: write.hcn.hcn,
          hcn_received_at: new Date(write.at),
          // El CHECK de 0042 no deja una fila `received` con una hora de despertar.
          ...(write.hcn.markReceived
            ? { hcn_state: 'received' as const, hcn_next_check_at: null }
            : {}),
        }),
    ...(write.openCalendar === undefined
      ? {}
      : {
          cancel_verify_anchor_at: new Date(write.openCalendar.anchorAt),
          cancel_verify_step: 0,
          cancel_verify_next_at: new Date(write.openCalendar.nextAt),
        }),
  };
  // Cortar el HCN sólo toca un seguimiento en curso: uno recibido o dado por perdido se queda como
  // está. Una fila nueva no tiene seguimiento que cortar.
  const stop =
    write.stopHcn === true
      ? {
          hcn_state: sql<HcnState | null>`CASE WHEN hotel_order_tracking.hcn_state IN ('out-of-window', 'scheduled') THEN 'stopped' ELSE hotel_order_tracking.hcn_state END`,
          hcn_next_check_at: null,
        }
      : {};
  return { insert: common, update: { ...common, ...stop } };
}

/** Una escritura que trae el HCN cierra, en su transacción, la tarea `hcn-ticket` abierta. */
async function resolveHcnTicketsOf(
  trx: Transaction<DB>,
  tenantId: string,
  orderId: string,
  write: Pick<HotelCancelTrackingWrite, 'hcn' | 'source' | 'at'>,
): Promise<void> {
  if (write.hcn === undefined) return;
  await resolvePendingHcnTickets(trx, tenantId, orderId, {
    reason: 'hcn-received',
    source: write.source,
    at: write.at,
  });
}

@Injectable()
export class HotelOrderCancellationStore {
  constructor(private readonly db: DatabaseService) {}

  /** La orden de ESTE tenant, con su seguimiento y su calendario, o `undefined`. */
  async findTarget(tenantId: string, orderId: string): Promise<HotelCancelTarget | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await this.targets(trx)
        .where('o.id', '=', orderId)
        .where('o.tenant_id', '=', tenantId)
        .executeTakeFirst();
      return row === undefined ? undefined : targetOf(row);
    });
  }

  /**
   * Los pasos vencidos de un tenant, el más atrasado primero: una orden cuya lectura falló queda
   * reprogramada más adelante y deja pasar al resto (HARD-2).
   */
  async listDue(
    tenantId: string,
    query: { readonly dueBefore: number; readonly limit: number },
  ): Promise<HotelCancelTarget[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await this.targets(trx)
        .where('o.tenant_id', '=', tenantId)
        .where('t.cancel_verify_next_at', 'is not', null)
        .where('t.cancel_verify_next_at', '<=', new Date(query.dueBefore))
        .orderBy('t.cancel_verify_next_at')
        .limit(query.limit)
        .execute();
      return rows.map((row) => targetOf(row as TargetRow));
    });
  }

  /**
   * Dentro del claim de cancelación: la orden queda en manos de la cancelación. También apaga un
   * calendario anterior (un rechazo que se estaba verificando): la cancelación nueva abre el suyo.
   */
  async markRequested(trx: Transaction<DB>, tenantId: string, orderId: string): Promise<void> {
    await trx
      .insertInto('hotel_order_tracking')
      .values({ order_id: orderId, tenant_id: tenantId, sub_status: 'cancel-requested' })
      .onConflict((oc) =>
        oc
          .column('order_id')
          .doUpdateSet({ sub_status: 'cancel-requested', cancel_verify_next_at: null }),
      )
      .execute();
  }

  /**
   * Dentro de la transacción que cierra la operación `cancel`: lo que dejó la respuesta del
   * proveedor. Sin CAS: el claim es de esta cancelación y nadie más escribe el subestado mientras
   * dura; perder esta escritura por una lectura concurrente dejaría el claim puesto.
   */
  async writeOutcome(
    trx: Transaction<DB>,
    tenantId: string,
    orderId: string,
    write: HotelCancelTrackingWrite,
  ): Promise<void> {
    const { insert, update } = columnsOf(write);
    if (Object.keys(update).length === 0) return;
    await trx
      .insertInto('hotel_order_tracking')
      .values({ order_id: orderId, tenant_id: tenantId, ...insert })
      .onConflict((oc) => oc.column('order_id').doUpdateSet(update))
      .execute();
    await resolveHcnTicketsOf(trx, tenantId, orderId, write);
  }

  /**
   * Termina el paso `fromStep` sin cerrar la orden y deja programado el siguiente (o nada). CAS
   * sobre el paso: `false` = otro camino ya lo terminó, y quien llama no emite ni encola nada.
   */
  async advance(
    tenantId: string,
    orderId: string,
    fromStep: number,
    next: HotelCancelVerifyAdvance,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, (trx) =>
      this.advanceIn(trx, tenantId, orderId, fromStep, next),
    );
  }

  /**
   * Corre la próxima lectura del paso guardado a `nextAt`, sin avanzarlo: la del barrido falló y no
   * dijo nada. CAS sobre el ancla y el paso: si otro camino lo avanzó, lo cerró o abrió el calendario
   * de una cancelación nueva, no se toca.
   */
  async postpone(
    tenantId: string,
    orderId: string,
    from: { readonly anchorAt: number; readonly step: number },
    nextAt: number,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const result = await trx
        .updateTable('hotel_order_tracking')
        .set({ cancel_verify_next_at: new Date(nextAt) })
        .where('order_id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .where('cancel_verify_anchor_at', '=', new Date(from.anchorAt))
        .where('cancel_verify_step', '=', from.step)
        .where('cancel_verify_next_at', 'is not', null)
        .executeTakeFirstOrThrow();
      return result.numUpdatedRows > 0n;
    });
  }

  /**
   * La lectura la ve cancelada: en una transacción, el paso (CAS), la orden de `pending` a
   * `cancelled` y, si la cancelación había quedado sin verificar, su operación, que pasa a exitosa
   * con la evidencia de la lectura (PV-B). `false` = otro camino llegó antes (el paso ya no es el
   * de la fila, o la orden ya no está `pending`) y no se escribió nada.
   */
  async close(
    tenantId: string,
    orderId: string,
    fromStep: number,
    write: Omit<HotelCancelTrackingWrite, 'openCalendar'>,
  ): Promise<boolean> {
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const stepped = await this.advanceIn(trx, tenantId, orderId, fromStep, {
          step: fromStep + 1,
          nextAt: null,
          write,
        });
        if (!stepped) return false;

        const order = await trx
          .updateTable('orders')
          .set({ status: 'cancelled' as OrderStatus })
          .where('id', '=', orderId)
          .where('tenant_id', '=', tenantId)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();
        // El paso ya se avanzó dentro de esta transacción: se deshace entera.
        if (order === undefined) throw new OrderNoLongerPending();

        await this.resolveUnverifiedCancel(trx, orderId);
        return true;
      });
    } catch (err) {
      if (err instanceof OrderNoLongerPending) return false;
      throw err;
    }
  }

  /**
   * La conciliación confirmó con una lectura que la reserva se canceló (o se está cancelando) fuera
   * de una cancelación en curso nuestra (docs/tbo/04 §6.3 fila 14 y §9.4 R3): en una transacción, la
   * orden de `from` a `to` (CAS sobre su estado), la fila de seguimiento (CAS sobre la foto con la
   * que se decidió) y, si queda `cancelled`, la operación `cancel` que había quedado sin verificar.
   *
   * `false` = otro camino llegó antes (la orden ya no está en `from`, o la fila cambió) y no se
   * escribió nada.
   */
  async transitionByReading(
    tenantId: string,
    orderId: string,
    change: {
      readonly from: OrderStatus;
      readonly to: OrderStatus;
      readonly expected: Pick<
        HotelOrderSnapshot,
        'subStatus' | 'providerStatus' | 'hcn' | 'hcnState'
      >;
      readonly write: HotelCancelTrackingWrite;
    },
  ): Promise<boolean> {
    const { insert, update: written } = columnsOf(change.write);
    // Cerrada, ya no hay cancelación en curso que verificar: un paso que quedara programado sólo
    // releería al proveedor para nada.
    const update =
      change.to === 'cancelled' ? { ...written, cancel_verify_next_at: null } : written;
    const { expected } = change;
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const order = await trx
          .updateTable('orders')
          .set({ status: change.to })
          .where('id', '=', orderId)
          .where('tenant_id', '=', tenantId)
          .where('status', '=', change.from)
          .returning('id')
          .executeTakeFirst();
        if (order === undefined) return false;

        const row = await trx
          .insertInto('hotel_order_tracking')
          .values({ order_id: orderId, tenant_id: tenantId, ...insert })
          .onConflict((oc) =>
            oc
              .column('order_id')
              .doUpdateSet(update)
              .where('hotel_order_tracking.sub_status', 'is not distinct from', expected.subStatus)
              .where(
                'hotel_order_tracking.provider_status',
                'is not distinct from',
                expected.providerStatus,
              )
              .where('hotel_order_tracking.hcn', 'is not distinct from', expected.hcn)
              .where('hotel_order_tracking.hcn_state', 'is not distinct from', expected.hcnState),
          )
          .returning('order_id')
          .executeTakeFirst();
        // La orden ya cambió dentro de esta transacción: se deshace entera.
        if (row === undefined) throw new ReadingSuperseded();

        await resolveHcnTicketsOf(trx, tenantId, orderId, change.write);
        if (change.to === 'cancelled') await this.resolveUnverifiedCancel(trx, orderId);
        return true;
      });
    } catch (err) {
      if (err instanceof ReadingSuperseded) return false;
      throw err;
    }
  }

  private async advanceIn(
    trx: Transaction<DB>,
    tenantId: string,
    orderId: string,
    fromStep: number,
    next: HotelCancelVerifyAdvance,
  ): Promise<boolean> {
    const update = next.write === undefined ? {} : columnsOf(next.write).update;
    const result = await trx
      .updateTable('hotel_order_tracking')
      .set({
        ...update,
        cancel_verify_step: next.step,
        cancel_verify_next_at: next.nextAt === null ? null : new Date(next.nextAt),
      })
      .where('order_id', '=', orderId)
      .where('tenant_id', '=', tenantId)
      .where('cancel_verify_step', '=', fromStep)
      .where('cancel_verify_next_at', 'is not', null)
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows === 0n) return false;
    if (next.write !== undefined) await resolveHcnTicketsOf(trx, tenantId, orderId, next.write);
    return true;
  }

  /**
   * La última operación `cancel`, si quedó `UNVERIFIED`, se cierra como exitosa: la lectura probó
   * que la cancelación se aplicó, y dejarla "a conciliar" en el historial contradiría la orden.
   */
  private async resolveUnverifiedCancel(trx: Transaction<DB>, orderId: string): Promise<void> {
    const latest = await trx
      .selectFrom('order_operations')
      .select(['id', 'status', 'result'])
      .where('order_id', '=', orderId)
      .where('type', '=', 'cancel')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (latest === undefined || latest.status !== 'failed') return;
    if (persistedCancelRetryPolicy(latest.result).outcome !== 'UNVERIFIED') return;
    const prior = priorStatusOf(latest.result);
    await trx
      .updateTable('order_operations')
      .set({
        status: 'success',
        last_error: null,
        result: JSON.stringify({
          status: 'success',
          ...CANCEL_SUCCESS_POLICY,
          ...(prior === undefined ? {} : { priorOrderStatus: prior }),
          resolvedBy: 'verify-cancellation',
        }),
      })
      .where('id', '=', latest.id)
      .where('status', '=', 'failed')
      .execute();
  }

  private targets(trx: Transaction<DB>) {
    return trx
      .selectFrom('orders as o')
      .leftJoin('hotel_order_tracking as t', (join) =>
        join.onRef('t.order_id', '=', 'o.id').onRef('t.tenant_id', '=', 'o.tenant_id'),
      )
      .select([
        'o.id',
        'o.provider',
        'o.user_id',
        'o.status',
        'o.provider_order_id',
        'o.provider_account_id',
        'o.provider_booking_ref',
        't.provider_status',
        't.provider_voucher_status',
        't.sub_status',
        't.refund_awaited',
        't.hcn',
        't.hcn_state',
        't.cancel_verify_anchor_at',
        't.cancel_verify_step',
        't.cancel_verify_next_at',
      ]);
  }
}

/** Marca interna para deshacer la transacción del cierre. */
class OrderNoLongerPending extends Error {
  constructor() {
    super('la orden ya no está pendiente');
    this.name = 'OrderNoLongerPending';
  }
}

/** Marca interna para deshacer una transición cuando la fila cambió desde la lectura. */
class ReadingSuperseded extends Error {
  constructor() {
    super('la fila de seguimiento cambió desde la lectura');
    this.name = 'ReadingSuperseded';
  }
}

function priorStatusOf(result: unknown): string | undefined {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const prior = (value as Record<string, unknown>)['priorOrderStatus'];
  return typeof prior === 'string' ? prior : undefined;
}
