import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type {
  HcnState,
  HotelOrderSubStatus,
  OrderStatus,
  ProviderStatusSource,
} from '../database/database.types.js';
import type {
  HotelOrderHcnRecord,
  HotelOrderReadRecord,
  HotelOrderSnapshot,
} from '../hotels/hotel-order-state.js';

/**
 * Lo que la post-venta de una orden de hotel lee y escribe en Postgres fuera de la verificación del
 * Book (docs/tbo/09 PR-5.2; 08 RF-26, RF-29): la orden con su fila de seguimiento (0042) y el
 * registro de cada lectura.
 *
 * Todo corre con el tenant fijado (`withTenant`): `orders` y `hotel_order_tracking` tienen RLS
 * forzada. La orden se lee ANTES de llamar al proveedor, y una orden de otra agencia no existe para
 * esta consulta aunque las dos reserven con la misma cuenta heredada (RF-29 CA 3).
 */

/** Una orden con lo que su post-venta necesita. Sin pasajeros ni contacto: no hacen falta. */
export interface HotelOrderReadTarget {
  readonly orderId: string;
  readonly provider: string;
  readonly userId: string;
  readonly status: OrderStatus;
  /** Localizador del proveedor; sin él no hay nada que leer. */
  readonly providerOrderId: string | null;
  /** La cuenta con la que se reservó (0042); la post-venta usa ésta (D-TBO-28 A). */
  readonly providerAccountId: string | null;
  readonly bookingReference: string | null;
  readonly snapshot: HotelOrderSnapshot;
}

/**
 * Lo que la fila tenía cuando se leyó la orden, y sobre lo que se decidió el plan. Entre esa lectura
 * y la escritura pasa una llamada al proveedor, y en ese rato otro camino (el claim de cancelación,
 * la verificación, el HCN) puede haber escrito algo más nuevo.
 */
export type HotelOrderTrackingExpectation = Pick<
  HotelOrderSnapshot,
  'subStatus' | 'providerStatus' | 'hcn' | 'hcnState'
>;

/** Lo que una lectura deja escrito en la fila de seguimiento. */
export interface HotelOrderReadWrite {
  readonly source: ProviderStatusSource;
  readonly at: number;
  readonly record?: HotelOrderReadRecord;
  /** `undefined` = no se toca. */
  readonly subStatus?: HotelOrderSubStatus | null;
  readonly hcn?: HotelOrderHcnRecord;
  readonly expected: HotelOrderTrackingExpectation;
}

/** La fila de seguimiento tal como la lee la API, antes de pasar a la vista pública. */
export interface HotelOrderTrackingRow {
  readonly orderId: string;
  readonly subStatus: HotelOrderSubStatus | null;
  readonly providerStatus: string | null;
  readonly providerStatusAt: Date | null;
  readonly providerStatusSource: ProviderStatusSource | null;
  readonly refundAwaited: boolean;
  readonly hcn: string | null;
  readonly hcnState: HcnState | null;
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
}

/** `pg` entrega TIMESTAMPTZ como `Date`; un driver que lo entregue como texto también sirve. */
function dateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

@Injectable()
export class HotelOrderTrackingStore {
  constructor(private readonly db: DatabaseService) {}

  /** La orden de ESTE tenant y su seguimiento, o `undefined` si no la puede leer. */
  async findReadTarget(
    tenantId: string,
    orderId: string,
  ): Promise<HotelOrderReadTarget | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
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
        ])
        .where('o.id', '=', orderId)
        .where('o.tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const r: TargetRow = row;
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
      };
    });
  }

  /**
   * Registra una lectura. Crea la fila si la orden todavía no tiene seguimiento (una reserva que
   * confirmó en línea no escribe ninguna). Sólo las columnas de la lectura: el calendario de
   * verificación y el plan del HCN los escriben sus dueños.
   *
   * CAS sobre `write.expected`: si la fila cambió desde que se leyó la orden, la lectura llegó tarde
   * y no pisa lo nuevo (un `Confirmed` viejo sobre el `Cancelled` de la cancelación, o un subestado
   * `null` sobre el claim). `false` = perdió, y quien llama no emite lo que decidió con la foto vieja.
   */
  async recordRead(
    tenantId: string,
    orderId: string,
    write: HotelOrderReadWrite,
  ): Promise<boolean> {
    const values = {
      // Sin estado leído no se mueve el momento de la lectura: fecharía de nuevo un estado viejo.
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
    };
    if (Object.keys(values).length === 0) return true;
    const { expected } = write;
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .insertInto('hotel_order_tracking')
        .values({ order_id: orderId, tenant_id: tenantId, ...values })
        .onConflict((oc) =>
          oc
            .column('order_id')
            .doUpdateSet(values)
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
      return row !== undefined;
    });
  }

  /** El seguimiento de las órdenes pedidas que lo tienen. Las de otro tenant no aparecen. */
  async listTracking(
    tenantId: string,
    orderIds: readonly string[],
  ): Promise<Map<string, HotelOrderTrackingRow>> {
    if (orderIds.length === 0) return new Map();
    const rows = await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('hotel_order_tracking')
        .select([
          'order_id',
          'sub_status',
          'provider_status',
          'provider_status_at',
          'provider_status_source',
          'refund_awaited',
          'hcn',
          'hcn_state',
        ])
        .where('tenant_id', '=', tenantId)
        .where('order_id', 'in', [...orderIds])
        .execute(),
    );
    return new Map(
      rows.map((row) => [
        row.order_id,
        {
          orderId: row.order_id,
          subStatus: row.sub_status,
          providerStatus: row.provider_status,
          providerStatusAt: dateOrNull(row.provider_status_at),
          providerStatusSource: row.provider_status_source,
          refundAwaited: row.refund_awaited === true,
          hcn: row.hcn,
          hcnState: row.hcn_state,
        },
      ]),
    );
  }
}
