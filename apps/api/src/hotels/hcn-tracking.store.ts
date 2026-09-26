import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type {
  DB,
  HcnPriority,
  HcnState,
  HotelOrderSubStatus,
  OrderStatus,
} from '../database/database.types.js';
import type { HotelOrderReadRecord, HotelOrderSnapshot } from './hotel-order-state.js';

/**
 * Lo que el seguimiento del HCN lee y escribe en Postgres (docs/tbo/09 PR-5.4; 08 RF-27, RNF-10;
 * columnas `hcn_*` de 0042).
 *
 * La fila de seguimiento es la fuente de verdad del plan: estado, prioridad, próxima lectura y
 * lecturas hechas. La cola sólo despierta cada lectura, y el barrido relee de aquí lo vencido y las
 * órdenes confirmadas que se quedaron sin plan.
 *
 * Todo corre con el tenant fijado (`withTenant`): `orders`, `order_operations` y
 * `hotel_order_tracking` tienen RLS forzada, y el barrido recorre los tenants uno por uno (pendiente
 * c de la Fase 5). Nada de aquí salta la RLS.
 *
 * Cada escritura del plan es un CAS sobre el estado y las lecturas hechas: el job y el barrido
 * pueden llegar a la misma lectura, y sólo el que la registra emite y encola la siguiente. La tarea
 * de operaciones (`order_operations.type = 'hcn-ticket'`) se inserta en la MISMA transacción que
 * marca el HCN como perdido: sin el CAS habría dos tareas, y sin la transacción, ninguna.
 */

/** El plan tal como lo guarda la fila. */
export interface HcnTracking {
  /** `null` = la orden todavía no tiene plan. */
  readonly state: HcnState | null;
  readonly priority: HcnPriority | null;
  readonly nextAt: number | null;
  /** Lecturas hechas. */
  readonly attempts: number;
}

/** Una orden de hotel con lo que su seguimiento necesita. Sin pasajeros ni contacto. */
export interface HcnTarget {
  readonly orderId: string;
  readonly provider: string;
  readonly userId: string;
  readonly status: OrderStatus;
  /** Localizador del proveedor: con él se lee la reserva. */
  readonly providerOrderId: string | null;
  /** La cuenta con la que se reservó (0042); la post-venta usa ésta (D-TBO-28 A). */
  readonly providerAccountId: string | null;
  readonly bookingReference: string | null;
  /** Epoch ms de la orden, que se abre segundos antes de la reserva: de ahí corre el SLA. */
  readonly createdAt: number;
  /** Tal como está en `orders.search_criteria`: lo valida quien lo usa. */
  readonly checkinDate: string | null;
  readonly checkoutDate: string | null;
  readonly hotelId: string | null;
  readonly snapshot: HotelOrderSnapshot;
  readonly tracking: HcnTracking;
}

/** Lo que una lectura del proveedor deja en la fila, además del plan. */
export interface HcnReadWrite {
  /** Epoch ms de la lectura. */
  readonly at: number;
  /** Ausente = la lectura no trajo estado que registrar. */
  readonly record?: HotelOrderReadRecord;
  /** Ausente = no se toca. */
  readonly subStatus?: HotelOrderSubStatus | null;
  /** El HCN que llegó. */
  readonly hcn?: string;
}

/** Cómo queda el plan después de una lectura, una pausa, un corte o la entrada en ventana. */
export interface HcnWrite {
  readonly state: HcnState;
  readonly attempts: number;
  /** `null` = nada más programado. */
  readonly nextAt: number | null;
  /** Ausente = no se toca. */
  readonly priority?: HcnPriority;
  readonly read?: HcnReadWrite;
  /** La tarea de operaciones, ya sin PII: se guarda tal cual en `order_operations.result`. */
  readonly ticket?: Readonly<Record<string, unknown>>;
}

/**
 * Sobre qué se decidió la escritura. Entre esa lectura de la fila y la escritura pasa una llamada al
 * proveedor, y en ese rato otro camino (el claim de una cancelación, la consulta manual) puede haber
 * escrito algo más nuevo: la escritura llega tarde y no pisa.
 */
export interface HcnExpectation {
  readonly state: HcnState;
  readonly attempts: number;
  /** Con una lectura: lo que la fila tenía de la reserva, como `recordRead` (PR-5.2). */
  readonly snapshot?: Pick<HotelOrderSnapshot, 'subStatus' | 'providerStatus' | 'hcn'>;
}

export interface HcnOpeningWrite {
  readonly state: HcnState;
  readonly priority: HcnPriority | null;
  readonly nextAt: number | null;
}

export interface HcnDueQuery {
  /** Lecturas programadas hasta este instante: vencidas más allá del margen de la cola. */
  readonly scheduledBefore: number;
  /** Entradas en ventana hasta este instante (no tienen job: sólo las despierta el barrido). */
  readonly windowBefore: number;
  readonly limit: number;
}

export interface HcnUnplannedQuery {
  /** Proveedores cuyas reservas se pueden leer. Vacío = ninguna orden. */
  readonly providers: readonly string[];
  /** `YYYY-MM-DD`: el check-in más viejo que todavía puede estar en curso. */
  readonly checkinFrom: string;
  readonly limit: number;
}

interface TargetRow {
  order_id: string;
  provider: string;
  user_id: string;
  status: OrderStatus;
  provider_order_id: string | null;
  provider_account_id: string | null;
  provider_booking_ref: string | null;
  created_at: Date | string;
  checkin_date: string | null;
  checkout_date: string | null;
  hotel_id: string | null;
  provider_status: string | null;
  provider_voucher_status: string | null;
  sub_status: HotelOrderSubStatus | null;
  refund_awaited: boolean | null;
  hcn: string | null;
  hcn_state: HcnState | null;
  hcn_priority: HcnPriority | null;
  hcn_next_check_at: Date | string | null;
  hcn_attempts: number | string | null;
}

/** `pg` entrega TIMESTAMPTZ como `Date`; un driver que lo entregue como texto también sirve. */
function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function targetOf(r: TargetRow): HcnTarget {
  return {
    orderId: r.order_id,
    provider: r.provider,
    userId: r.user_id,
    status: r.status,
    providerOrderId: r.provider_order_id,
    providerAccountId: r.provider_account_id,
    bookingReference: r.provider_booking_ref,
    createdAt: epoch(r.created_at),
    checkinDate: r.checkin_date,
    checkoutDate: r.checkout_date,
    hotelId: r.hotel_id,
    snapshot: {
      status: r.status,
      subStatus: r.sub_status,
      providerStatus: r.provider_status,
      voucherStatus: r.provider_voucher_status,
      refundAwaited: r.refund_awaited === true,
      hcn: r.hcn,
      hcnState: r.hcn_state,
    },
    tracking: {
      state: r.hcn_state,
      priority: r.hcn_priority,
      nextAt: r.hcn_next_check_at === null ? null : epoch(r.hcn_next_check_at),
      // Sin fila de seguimiento (LEFT JOIN) no hubo lecturas. INTEGER llega como número; se
      // normaliza por si un driver lo trae como texto.
      attempts: r.hcn_attempts === null ? 0 : Number(r.hcn_attempts),
    },
  };
}

/** Las columnas de lo que dejó una lectura. `hcn_state` lo pone el plan, no esto. */
function readColumns(read: HcnReadWrite | undefined) {
  if (read === undefined) return {};
  const at = new Date(read.at);
  return {
    ...(read.record === undefined
      ? {}
      : {
          provider_status: read.record.providerStatus,
          provider_status_at: at,
          provider_status_source: 'hcn' as const,
          refund_awaited: read.record.refundAwaited,
          ...(read.record.voucherStatus === undefined
            ? {}
            : { provider_voucher_status: read.record.voucherStatus }),
        }),
    ...(read.subStatus === undefined ? {} : { sub_status: read.subStatus }),
    ...(read.hcn === undefined ? {} : { hcn: read.hcn, hcn_received_at: at }),
  };
}

@Injectable()
export class HcnTrackingStore {
  constructor(private readonly db: DatabaseService) {}

  /** La orden de ESTE tenant con su plan, o `undefined` si no la puede leer. */
  async findTarget(tenantId: string, orderId: string): Promise<HcnTarget | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await this.targets(trx)
        .where('o.id', '=', orderId)
        .where('o.tenant_id', '=', tenantId)
        .executeTakeFirst();
      return row === undefined ? undefined : targetOf(row);
    });
  }

  /** Las lecturas vencidas y las entradas en ventana de un tenant, la más atrasada primero. */
  async listDue(tenantId: string, query: HcnDueQuery): Promise<HcnTarget[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await this.targets(trx)
        .where('o.tenant_id', '=', tenantId)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('t.hcn_state', '=', 'scheduled'),
              eb('t.hcn_next_check_at', '<=', new Date(query.scheduledBefore)),
            ]),
            eb.and([
              eb('t.hcn_state', '=', 'out-of-window'),
              eb('t.hcn_next_check_at', '<=', new Date(query.windowBefore)),
            ]),
          ]),
        )
        .orderBy('t.hcn_next_check_at')
        .limit(query.limit)
        .execute();
      return rows.map((row) => targetOf(row));
    });
  }

  /**
   * Las órdenes de hotel confirmadas de un tenant que no tienen plan: el proceso murió entre la
   * confirmación y el plan, la lectura de cierre falló, o no se pudo escribir. Sólo las que se pueden
   * leer (localizador y proveedor con lectura) y cuyo check-in todavía puede estar en curso: las demás
   * no se vuelven a mirar nunca, así que no tapan a las que sí.
   */
  async listUnplanned(tenantId: string, query: HcnUnplannedQuery): Promise<HcnTarget[]> {
    if (query.providers.length === 0) return [];
    const checkin = sql<string>`o.search_criteria ->> 'checkinDate'`;
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await this.targets(trx)
        .where('o.tenant_id', '=', tenantId)
        .where('o.status', '=', 'confirmed')
        .where('o.provider_order_id', 'is not', null)
        .where('o.provider', 'in', [...query.providers])
        .where(sql<string>`o.search_criteria ->> 'vertical'`, '=', 'hotels')
        .where('t.hcn_state', 'is', null)
        .where(checkin, '~', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        .where(checkin, '>=', query.checkinFrom)
        .orderBy('o.created_at')
        .limit(query.limit)
        .execute();
      return rows.map((row) => targetOf(row));
    });
  }

  /**
   * Abre el plan. Sólo si la orden todavía no tiene uno: la confirmación y el barrido pueden llegar
   * a la vez, y un plan ya abierto (o terminado) no se reabre. `false` = ya tenía.
   */
  async open(tenantId: string, orderId: string, opening: HcnOpeningWrite): Promise<boolean> {
    const values = {
      hcn_state: opening.state,
      hcn_priority: opening.priority,
      hcn_next_check_at: opening.nextAt === null ? null : new Date(opening.nextAt),
      hcn_attempts: 0,
    };
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .insertInto('hotel_order_tracking')
        .values({ order_id: orderId, tenant_id: tenantId, ...values })
        .onConflict((oc) =>
          oc
            .column('order_id')
            .doUpdateSet(values)
            .where('hotel_order_tracking.hcn_state', 'is', null),
        )
        .returning('order_id')
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /**
   * Mueve el plan desde `from` (CAS) y, si hay tarea de operaciones, la crea en la misma
   * transacción. `false` = otro camino llegó antes y no se escribió nada.
   */
  async advance(
    tenantId: string,
    orderId: string,
    from: HcnExpectation,
    write: HcnWrite,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      let update = trx
        .updateTable('hotel_order_tracking')
        .set({
          ...readColumns(write.read),
          hcn_state: write.state,
          hcn_attempts: write.attempts,
          hcn_next_check_at: write.nextAt === null ? null : new Date(write.nextAt),
          ...(write.priority === undefined ? {} : { hcn_priority: write.priority }),
        })
        .where('order_id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .where('hcn_state', '=', from.state)
        .where('hcn_attempts', '=', from.attempts);
      if (from.snapshot !== undefined) {
        update = update
          .where('sub_status', 'is not distinct from', from.snapshot.subStatus)
          .where('provider_status', 'is not distinct from', from.snapshot.providerStatus)
          .where('hcn', 'is not distinct from', from.snapshot.hcn);
      }
      const result = await update.executeTakeFirstOrThrow();
      if (result.numUpdatedRows === 0n) return false;

      if (write.ticket !== undefined) {
        await trx
          .insertInto('order_operations')
          .values({
            tenant_id: tenantId,
            order_id: orderId,
            type: 'hcn-ticket',
            // Una tarea abierta: la cierra una persona cuando consigue el HCN por el canal comercial.
            status: 'pending',
            result: JSON.stringify(write.ticket),
            // La abre el sistema, no un usuario.
            actor_user_id: null,
          })
          .execute();
      }
      return true;
    });
  }

  private targets(trx: Transaction<DB>) {
    return trx
      .selectFrom('orders as o')
      .leftJoin('hotel_order_tracking as t', (join) =>
        join.onRef('t.order_id', '=', 'o.id').onRef('t.tenant_id', '=', 'o.tenant_id'),
      )
      .select([
        'o.id as order_id',
        'o.provider',
        'o.user_id',
        'o.status',
        'o.provider_order_id',
        'o.provider_account_id',
        'o.provider_booking_ref',
        // `Generated<Timestamp>` en los tipos anida el `ColumnType`: se lee con su tipo real en SQL.
        sql<Date | string>`o.created_at`.as('created_at'),
        sql<string | null>`o.search_criteria ->> 'checkinDate'`.as('checkin_date'),
        sql<string | null>`o.search_criteria ->> 'checkoutDate'`.as('checkout_date'),
        sql<string | null>`o.search_criteria ->> 'hotelId'`.as('hotel_id'),
        't.provider_status',
        't.provider_voucher_status',
        't.sub_status',
        't.refund_awaited',
        't.hcn',
        't.hcn_state',
        't.hcn_priority',
        't.hcn_next_check_at',
        't.hcn_attempts',
      ]);
  }
}
