import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { SELLING_ROLES } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, TicketingDeadlineZone } from '../database/database.types.js';
import {
  DEADLINE_ALERT_WINDOW_MS,
  type DeadlineAlertThreshold,
} from './flight-deadline-alert.plan.js';

/**
 * Lo que el aviso de vencimiento del plazo de emisión (SAB-14) lee y escribe en Postgres: las
 * órdenes cuyo plazo vence pronto, el CAS que toma un aviso (0084) y lo que pasa después con él:
 * cerrarlo o soltarlo para reintentar un correo fallido (0085).
 *
 * Todo con el tenant fijado (`withTenant`): `orders`, `flight_order_tracking`, sus documentos, las
 * operaciones y las retenciones tienen RLS forzada. El barrido recorre los tenants uno por uno.
 */

/** Una orden con plazo que vence dentro de las próximas 24 h y le falta algún aviso. */
export interface DueDeadlineAlert {
  readonly orderId: string;
  readonly orderNumber: number;
  /** El vendedor que hizo la reserva (`orders.user_id`): a quien va el aviso. */
  readonly userId: string;
  readonly provider: string;
  readonly pnr: string | null;
  readonly searchCriteria: unknown;
  readonly passengers: unknown;
  readonly selectedOffer: unknown;
  readonly deadlineAt: Date;
  readonly deadlineZone: TicketingDeadlineZone;
  /** La zona IANA de la oficina, si el plazo vino en su hora y la cuenta la declara. */
  readonly officeTimeZone: string | null;
  readonly alerted24hAt: Date | null;
  readonly alerted2hAt: Date | null;
  /** La retención de cartera abierta de la orden en el nodo que vende, o `null`. */
  readonly walletHold: 'held' | 'captured' | null;
}

/** A quién y en qué hora se escribe el aviso. */
export interface DeadlineAlertRecipient {
  /** El correo del vendedor, sólo si sigue activo y con una membresía activa en la red de la orden. */
  readonly email: string | null;
  /** `tenants.country_code` de la agencia de la orden: la hora del aviso. */
  readonly countryCode: string | null;
}

/**
 * Un aviso tomado por una corrida (`claim`): la marca que puso (`token`, que la fence de
 * `release`/`settle` compara) y cuántos correos de ese aviso ya fallaron antes de éste (0085).
 */
export interface DeadlineAlertClaim {
  readonly threshold: DeadlineAlertThreshold;
  readonly token: Date;
  readonly failures: number;
}

/** Cuántas órdenes mira el barrido por tenant y corrida: las de plazo más cercano primero. */
export const DEADLINE_ALERT_BATCH = 100;

/** Operaciones en curso que hacen callar el aviso: se está emitiendo o cancelando. */
const BUSY_OPERATION_TYPES = ['issue', 'cancel'] as const;

function dateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

@Injectable()
export class FlightDeadlineAlertStore {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Las órdenes de vuelo de ESTE tenant cuyo plazo vence en las próximas 24 h y a las que les falta
   * un aviso que ya toca: confirmadas (una emitida, cancelada o pendiente no se avisa), con instante
   * (0084), sin un tiquete emitido guardado (se emitió por otro canal y la lectura lo vio) y sin una
   * emisión o una cancelación en curso. Las de plazo más cercano primero.
   */
  async listDue(
    tenantId: string,
    now: Date,
    limit: number = DEADLINE_ALERT_BATCH,
  ): Promise<DueDeadlineAlert[]> {
    const in24h = new Date(now.getTime() + DEADLINE_ALERT_WINDOW_MS['24h']);
    const in2h = new Date(now.getTime() + DEADLINE_ALERT_WINDOW_MS['2h']);
    const rows = await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('flight_order_tracking as t')
        .innerJoin('orders as o', (join) =>
          join.onRef('o.id', '=', 't.order_id').onRef('o.tenant_id', '=', 't.tenant_id'),
        )
        .select((eb) => [
          'o.id as order_id',
          'o.order_number',
          'o.user_id',
          'o.provider',
          'o.provider_order_id',
          'o.search_criteria',
          'o.passengers',
          'o.selected_offer',
          't.ticketing_deadline_at',
          't.ticketing_deadline_zone',
          't.ticketing_deadline_time_zone',
          't.deadline_alerted_24h_at',
          't.deadline_alerted_2h_at',
          eb
            .selectFrom('wallet_hold_groups as g')
            .select('g.status')
            .whereRef('g.order_id', '=', 'o.id')
            .where('g.origin_tenant_id', '=', tenantId)
            .where('g.status', 'in', ['held', 'captured'])
            .limit(1)
            .as('wallet_hold'),
        ])
        .where('t.tenant_id', '=', tenantId)
        .where('o.status', '=', 'confirmed')
        .where('t.deadline_alerted_2h_at', 'is', null)
        .where('t.ticketing_deadline_at', '>', now)
        .where('t.ticketing_deadline_at', '<=', in24h)
        .where((eb) =>
          eb.or([
            eb('t.deadline_alerted_24h_at', 'is', null),
            eb('t.ticketing_deadline_at', '<=', in2h),
          ]),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('order_flight_documents as d')
                .select(sql<number>`1`.as('one'))
                .whereRef('d.order_id', '=', 'o.id')
                .where('d.tenant_id', '=', tenantId)
                .where('d.kind', '=', 'TICKET')
                .where('d.status', '=', 'ISSUED'),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('order_operations as op')
                .select(sql<number>`1`.as('one'))
                .whereRef('op.order_id', '=', 'o.id')
                .where('op.tenant_id', '=', tenantId)
                .where('op.status', '=', 'pending')
                .where('op.type', 'in', [...BUSY_OPERATION_TYPES]),
            ),
          ),
        )
        .orderBy('t.ticketing_deadline_at')
        .orderBy('o.id')
        .limit(limit)
        .execute(),
    );

    return rows.flatMap((row) => {
      const deadlineAt = dateOrNull(row.ticketing_deadline_at);
      if (deadlineAt === null || row.ticketing_deadline_zone === null) return [];
      return [
        {
          orderId: row.order_id,
          orderNumber: row.order_number,
          userId: row.user_id,
          provider: row.provider,
          pnr: row.provider_order_id,
          searchCriteria: row.search_criteria,
          passengers: row.passengers,
          selectedOffer: row.selected_offer,
          deadlineAt,
          deadlineZone: row.ticketing_deadline_zone,
          officeTimeZone: row.ticketing_deadline_time_zone,
          alerted24hAt: dateOrNull(row.deadline_alerted_24h_at),
          alerted2hAt: dateOrNull(row.deadline_alerted_2h_at),
          walletHold:
            row.wallet_hold === 'held' || row.wallet_hold === 'captured' ? row.wallet_hold : null,
        },
      ];
    });
  }

  /**
   * Toma el aviso `threshold` de la orden: la marca de 0084 pasa de NULL a `now`, que queda como
   * candado del envío. Devuelve `null` si no lo tomó: otra corrida lo tiene o ya lo cerró, el plazo
   * cambió desde que se leyó (otro instante, otro aviso) o la orden dejó de estar confirmada.
   *
   * Es un CAS sobre la columna en NULL, ANTES de mandar el correo: dos corridas o dos réplicas a la
   * vez no mandan dos avisos. Lo que pasa con el correo lo dice después quien lo tomó: lo cierra
   * ({@link settle}) o lo suelta para la próxima corrida ({@link release}, 0085).
   *
   * El de 2 h marca también el de 24 h, que ya no tiene sentido mandar.
   */
  async claim(
    tenantId: string,
    orderId: string,
    threshold: DeadlineAlertThreshold,
    deadlineAt: Date,
    now: Date,
  ): Promise<DeadlineAlertClaim | null> {
    return this.db.withTenant(tenantId, async (trx) => {
      const base = trx
        .updateTable('flight_order_tracking')
        .where('order_id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .where('ticketing_deadline_at', '=', deadlineAt)
        .where('deadline_alerted_2h_at', 'is', null)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('orders as o')
              .select(sql<number>`1`.as('one'))
              .where('o.id', '=', orderId)
              .where('o.tenant_id', '=', tenantId)
              .where('o.status', '=', 'confirmed'),
          ),
        );
      const claimed =
        threshold === '2h'
          ? await base
              .set({
                deadline_alerted_2h_at: now,
                deadline_alerted_24h_at: sql<Date>`coalesce(deadline_alerted_24h_at, ${now})`,
              })
              .returning('deadline_alert_2h_failures as failures')
              .executeTakeFirst()
          : await base
              .set({ deadline_alerted_24h_at: now })
              .where('deadline_alerted_24h_at', 'is', null)
              .returning('deadline_alert_24h_failures as failures')
              .executeTakeFirst();
      if (claimed === undefined) return null;
      return { threshold, token: now, failures: Number(claimed.failures) };
    });
  }

  /**
   * Suelta un aviso cuyo correo falló, para que la próxima corrida lo reintente, y cuenta el intento
   * (0085). Sólo si la marca sigue siendo la que puso `claim`: si una lectura cambió el plazo o otra
   * corrida la tiene, no toca nada. El de 24 h tampoco se suelta si ya se tomó el de 2 h, que lo
   * reemplaza. Devuelve si la soltó.
   */
  async release(tenantId: string, orderId: string, claim: DeadlineAlertClaim): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const released =
        claim.threshold === '2h'
          ? await trx
              .updateTable('flight_order_tracking')
              .set({
                deadline_alerted_2h_at: null,
                deadline_alert_2h_failures: sql<number>`deadline_alert_2h_failures + 1`,
              })
              .where('order_id', '=', orderId)
              .where('tenant_id', '=', tenantId)
              .where('deadline_alerted_2h_at', '=', claim.token)
              .returning('order_id')
              .executeTakeFirst()
          : await trx
              .updateTable('flight_order_tracking')
              .set({
                deadline_alerted_24h_at: null,
                deadline_alert_24h_failures: sql<number>`deadline_alert_24h_failures + 1`,
              })
              .where('order_id', '=', orderId)
              .where('tenant_id', '=', tenantId)
              .where('deadline_alerted_24h_at', '=', claim.token)
              .where('deadline_alerted_2h_at', 'is', null)
              .returning('order_id')
              .executeTakeFirst();
      return released !== undefined;
    });
  }

  /**
   * Cierra un aviso tomado —el correo salió, no hay a quién escribirle o se agotaron los intentos— y
   * corre `inTransaction` (el `domain_event`) en la misma transacción. La marca queda puesta: el
   * aviso no se vuelve a mandar para este instante. Con `failed`, cuenta el último intento.
   */
  async settle(
    tenantId: string,
    orderId: string,
    claim: DeadlineAlertClaim,
    failed: boolean,
    inTransaction: (trx: Transaction<DB>) => Promise<void>,
  ): Promise<void> {
    await this.db.withTenant(tenantId, async (trx) => {
      if (failed) {
        const query = trx.updateTable('flight_order_tracking');
        await (
          claim.threshold === '2h'
            ? query
                .set({ deadline_alert_2h_failures: sql<number>`deadline_alert_2h_failures + 1` })
                .where('deadline_alerted_2h_at', '=', claim.token)
            : query
                .set({ deadline_alert_24h_failures: sql<number>`deadline_alert_24h_failures + 1` })
                .where('deadline_alerted_24h_at', '=', claim.token)
        )
          .where('order_id', '=', orderId)
          .where('tenant_id', '=', tenantId)
          .execute();
      }
      await inTransaction(trx);
    });
  }

  /**
   * A quién se escribe: el vendedor de la orden si sigue activo y conserva una membresía activa en
   * la agencia de la orden o en un nodo de su red hacia arriba (quien vende por una sub-agencia),
   * con un rol que vende (`SELLING_ROLES`). Uno suspendido, quitado, sin membresía o que ya sólo es
   * cliente final no recibe datos de la reserva. Y el país de la agencia, para la hora.
   *
   * Corre con el usuario fijado: `memberships` sólo deja leer las propias (`memberships_self`).
   * `users` y `tenants` no tienen RLS.
   */
  async recipientFor(tenantId: string, userId: string): Promise<DeadlineAlertRecipient> {
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const tenant = await trx
        .selectFrom('tenants')
        .select('country_code')
        .where('id', '=', tenantId)
        .executeTakeFirst();
      const seller = await sql<{ email: string }>`
        WITH RECURSIVE chain AS (
          SELECT id, parent_tenant_id, 0 AS depth FROM tenants WHERE id = ${tenantId}
          UNION ALL
          SELECT t.id, t.parent_tenant_id, c.depth + 1
            FROM tenants t JOIN chain c ON t.id = c.parent_tenant_id
           WHERE c.depth < 16
        )
        SELECT u.email
          FROM users u
         WHERE u.id = ${userId}
           AND u.status = 'active'
           AND EXISTS (
             SELECT 1 FROM memberships m
              WHERE m.user_id = u.id
                AND m.status = 'active'
                AND m.role IN (${sql.join([...SELLING_ROLES])})
                AND m.tenant_id IN (SELECT id FROM chain)
           )
      `.execute(trx);
      return {
        email: seller.rows[0]?.email ?? null,
        countryCode: tenant?.country_code ?? null,
      };
    });
  }
}
