import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, HotelOrderSubStatus } from '../database/database.types.js';

/**
 * Lo que la verificación de una reserva de hotel sin respuesta lee y escribe en Postgres (docs/tbo/09
 * PR-4.7; 08 RNF-10 punto 1: Postgres manda, la cola sólo despierta).
 *
 * La orden dice si sigue abierta (`pending` con `provider_raw` nulo: nadie consolidó el Book) y
 * con qué referencia y qué cuenta se reservó; la fila de seguimiento (0042 + 0044) dice qué paso
 * del calendario toca y cuándo. Todo corre con el tenant fijado (`withTenant`): las dos tablas
 * tienen RLS forzada y el barrido las recorre tenant por tenant.
 *
 * Cada escritura del calendario es un CAS sobre el paso: el job y el barrido pueden llegar al
 * mismo paso, y sólo el que lo avanza emite eventos y encola el siguiente.
 */

/** Una orden de hotel con referencia y su calendario de verificación. Sin datos personales. */
export interface HotelVerificationTarget {
  readonly orderId: string;
  readonly provider: string;
  readonly userId: string;
  /** `orders.provider_booking_ref`: con qué se lee la reserva que no respondió. */
  readonly bookingReference: string;
  /** La cuenta con la que se reservó (0042); `null` en órdenes que no la guardaron. */
  readonly providerAccountId: string | null;
  /** `pending` y sin `provider_raw`: el Book todavía no tiene desenlace consolidado. */
  readonly open: boolean;
  /** Epoch ms de la última escritura de la orden. */
  readonly updatedAt: number;
  /** Epoch ms del ancla del calendario, o `null` si la orden no tiene calendario. */
  readonly anchorAt: number | null;
  readonly step: number | null;
  readonly nextAt: number | null;
}

export interface HotelVerificationCalendar {
  readonly anchorAt: number;
  readonly step: number;
  readonly nextAt: number;
}

/** Lo que cambia en la fila al terminar un paso. */
export interface HotelVerificationAdvance {
  /** El próximo paso: siempre mayor que el que se ejecutó. */
  readonly step: number;
  /** `null` = nada más programado. */
  readonly nextAt: number | null;
  /** Ausente = no se toca. */
  readonly subStatus?: HotelOrderSubStatus | null;
  /** Estado crudo que devolvió la lectura, si encontró la reserva. */
  readonly providerStatus?: { readonly value: string; readonly at: number };
}

export interface HotelVerificationDueQuery {
  /** Pasos programados hasta este instante: vencidos más allá del margen de la cola. */
  readonly dueBefore: number;
  /** Órdenes abiertas sin calendario cuya última escritura es anterior a esto. */
  readonly orphanBefore: number;
  readonly limit: number;
}

interface TargetRow {
  order_id: string;
  provider: string;
  user_id: string;
  provider_booking_ref: string | null;
  provider_account_id: string | null;
  open: boolean | null;
  updated_at: Date | string;
  verify_anchor_at: Date | string | null;
  verify_step: number | string | null;
  verify_next_at: Date | string | null;
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function epochOrNull(value: Date | string | null): number | null {
  return value === null ? null : epoch(value);
}

function targetOf(row: TargetRow): HotelVerificationTarget | undefined {
  // El filtro de la consulta ya lo exige; si una fila llegara sin referencia, no hay qué leer.
  if (row.provider_booking_ref === null) return undefined;
  return {
    orderId: row.order_id,
    provider: row.provider,
    userId: row.user_id,
    bookingReference: row.provider_booking_ref,
    providerAccountId: row.provider_account_id,
    open: row.open === true,
    updatedAt: epoch(row.updated_at),
    anchorAt: epochOrNull(row.verify_anchor_at),
    // SMALLINT llega como número; se normaliza por si un driver lo trae como texto.
    step: row.verify_step === null ? null : Number(row.verify_step),
    nextAt: epochOrNull(row.verify_next_at),
  };
}

@Injectable()
export class HotelBookingVerificationStore {
  constructor(private readonly db: DatabaseService) {}

  /** La orden y su calendario, o `undefined` si no es una orden con referencia de este tenant. */
  async findTarget(
    tenantId: string,
    orderId: string,
  ): Promise<HotelVerificationTarget | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await this.targets(trx)
        .where('o.id', '=', orderId)
        .where('o.tenant_id', '=', tenantId)
        .where('o.provider_booking_ref', 'is not', null)
        .executeTakeFirst();
      return row === undefined ? undefined : targetOf(row as unknown as TargetRow);
    });
  }

  /**
   * Lo que el barrido tiene que ejecutar en un tenant: los pasos vencidos y las órdenes abiertas
   * que quedaron sin calendario (el proceso murió con la reserva en vuelo, o no pudo escribirlo).
   * Sólo órdenes de hotel con referencia, abiertas: una consolidada ya no se lee por aquí.
   */
  async listDue(
    tenantId: string,
    query: HotelVerificationDueQuery,
  ): Promise<HotelVerificationTarget[]> {
    const dueBefore = new Date(query.dueBefore);
    const orphanBefore = new Date(query.orphanBefore);
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await this.targets(trx)
        .where('o.tenant_id', '=', tenantId)
        .where('o.status', '=', 'pending')
        .where('o.provider_raw', 'is', null)
        .where('o.provider_booking_ref', 'is not', null)
        .where(sql<string>`o.search_criteria ->> 'vertical'`, '=', 'hotels')
        .where((eb) =>
          eb.or([
            eb.and([
              eb('t.verify_next_at', 'is not', null),
              eb('t.verify_next_at', '<=', dueBefore),
            ]),
            // `orders.updated_at` es `Generated<Timestamp>` en los tipos: la comparación va en SQL.
            eb.and([
              eb('t.verify_anchor_at', 'is', null),
              sql<boolean>`o.updated_at <= ${orphanBefore}`,
            ]),
          ]),
        )
        .orderBy('o.updated_at')
        .limit(query.limit)
        .execute();
      return rows.flatMap((row) => {
        const target = targetOf(row as unknown as TargetRow);
        return target === undefined ? [] : [target];
      });
    });
  }

  /**
   * Abre el calendario de una orden. Sólo si todavía no tiene uno: la saga y el barrido pueden
   * llegar a la vez, y el segundo no puede reiniciar el calendario del primero. `false` = ya
   * tenía calendario, y quien llama no programa nada.
   */
  async startCalendar(
    tenantId: string,
    orderId: string,
    calendar: HotelVerificationCalendar,
  ): Promise<boolean> {
    const values = {
      sub_status: 'create-uncertain' as const,
      verify_anchor_at: new Date(calendar.anchorAt),
      verify_step: calendar.step,
      verify_next_at: new Date(calendar.nextAt),
    };
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .insertInto('hotel_order_tracking')
        .values({ order_id: orderId, tenant_id: tenantId, ...values })
        .onConflict((oc) =>
          oc
            .column('order_id')
            .doUpdateSet(values)
            .where('hotel_order_tracking.verify_anchor_at', 'is', null),
        )
        .returning('order_id')
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /**
   * Termina el paso `fromStep` y deja programado el siguiente (o nada). CAS sobre el paso: `false`
   * = otro camino ya lo terminó, y quien llama no emite ni encola nada.
   */
  async advance(
    tenantId: string,
    orderId: string,
    fromStep: number,
    next: HotelVerificationAdvance,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const result = await trx
        .updateTable('hotel_order_tracking')
        .set({
          verify_step: next.step,
          verify_next_at: next.nextAt === null ? null : new Date(next.nextAt),
          ...(next.subStatus === undefined ? {} : { sub_status: next.subStatus }),
          ...(next.providerStatus === undefined
            ? {}
            : {
                provider_status: next.providerStatus.value,
                provider_status_at: new Date(next.providerStatus.at),
                provider_status_source: 'verify' as const,
              }),
        })
        .where('order_id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .where('verify_step', '=', fromStep)
        .executeTakeFirstOrThrow();
      return result.numUpdatedRows > 0n;
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
        'o.provider_booking_ref',
        'o.provider_account_id',
        'o.updated_at',
        't.verify_anchor_at',
        't.verify_step',
        't.verify_next_at',
        sql<boolean>`o.status = 'pending' AND o.provider_raw IS NULL`.as('open'),
      ]);
  }
}
