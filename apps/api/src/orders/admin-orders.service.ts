import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { PlatformConsoleScopeNotFoundError } from '../admin-console/admin-console.errors.js';
import { PLATFORM_TIME_ZONE } from '../admin-console/admin-overview.schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { rethrowAdminDbError } from '../network/superadmin.errors.js';
import {
  adminOrderEvent,
  adminOrdersPage,
  adminOrderTenant,
  adminOrderView,
  adminReconciliationItem,
  adminWalletHold,
  sortAttention,
  type AdminOrderDetail,
  type AdminOrderEventView,
  type AdminOrderSearchRow,
  type AdminOrdersPage,
  type ReconciliationItemRow,
  type WalletHoldRow,
} from './admin-order-view.js';
import { AdminOrderNotFoundError } from './admin-orders.errors.js';
import type { AdminOrdersQuery } from './admin-orders.schemas.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { OrdersService } from './orders.service.js';

/** El evento que deja cada ficha abierta, en el nodo de la reserva. */
export const ADMIN_ORDER_VIEWED_EVENT = 'platform.order.viewed';

/** Los últimos eventos de la orden que muestra la ficha. */
export const ADMIN_ORDER_EVENTS_LIMIT = 50;
/** Las divergencias de conciliación que muestra la ficha (la conciliación es diaria). */
export const ADMIN_ORDER_RECONCILIATION_LIMIT = 50;

/**
 * Plataforma → Reservas de la red: buscar cualquier reserva de cualquier nodo y abrir su ficha.
 *
 * La búsqueda es `admin_search_orders` (0076), que vuelve a exigir en la base que quien pide sea el
 * superadmin (`app.current_user_id`, por eso `withRequestContext({ userId })`) y no devuelve
 * pasajeros ni contacto.
 *
 * La ficha no lee por una puerta amplia: `admin_order_tenant` (misma guarda) dice de qué nodo es la
 * orden, y con ese tenant fijado se usan las lecturas de siempre (las de Reservas de la agencia y la
 * RLS de cada tabla). Lo que sale pasa por admin-order-view.ts (pasajeros sin documentos ni fecha de
 * nacimiento, contacto sólo con correo y teléfono, payloads sin claves sensibles), y cada ficha
 * abierta queda en la auditoría del nodo. Sólo lee: nunca vende ni cambia la reserva.
 */
@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly orders: OrdersService,
    private readonly hotelReads: HotelOrderReadsService,
    private readonly audit: AuditService,
  ) {}

  async search(actorUserId: string, query: AdminOrdersQuery): Promise<AdminOrdersPage> {
    const root = query.tenantId ?? null;
    const before = query.cursor ?? null;
    // Se pide una de más para saber si hay otra página.
    const limit = query.limit + 1;

    try {
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        if (root !== null) await this.assertNode(trx, root);

        // Los días son de Bogotá: desde el comienzo de `from` hasta el comienzo del día siguiente
        // a `to`. Los instantes los calcula Postgres, que conoce los cambios de hora de cada zona.
        const { rows } = await sql<AdminOrderSearchRow>`
          SELECT s.*,
                 to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
            FROM admin_search_orders(
                   ${root}::uuid,
                   ${query.subtree}::boolean,
                   ${query.vertical ?? null}::text,
                   ${query.provider === undefined ? null : [query.provider]}::text[],
                   ${query.status ?? null}::text[],
                   (${query.from ?? null}::date::timestamp AT TIME ZONE ${PLATFORM_TIME_ZONE}),
                   ((${query.to ?? null}::date + 1)::timestamp AT TIME ZONE ${PLATFORM_TIME_ZONE}),
                   ${query.q ?? null}::text,
                   ${query.attention ?? false}::boolean,
                   ${before?.at ?? null}::timestamptz,
                   ${before?.id ?? null}::uuid,
                   ${limit}::int
                 ) s
           ORDER BY s.created_at DESC, s.id DESC
        `.execute(trx);

        return adminOrdersPage(rows, query.limit);
      });
    } catch (err) {
      rethrowAdminDbError(err);
    }
  }

  /**
   * La ficha de la reserva `orderId`, de cualquier nodo. 404 si no existe. Deja
   * `platform.order.viewed` en el nodo de la reserva: el superadmin leyó datos de sus clientes.
   */
  async detail(actorUserId: string, orderId: string): Promise<AdminOrderDetail> {
    const id = orderId.toLowerCase();
    let read: { owner: string; detail: AdminOrderDetail };
    try {
      read = await this.read(actorUserId, id);
    } catch (err) {
      rethrowAdminDbError(err);
    }

    // Best-effort, como toda la auditoría: un fallo al escribirla no le niega la ficha a quien ya
    // pasó las dos guardas. Va en el nodo de la reserva para que su administrador lo vea.
    await this.audit.emit({
      eventType: ADMIN_ORDER_VIEWED_EVENT,
      tenantId: read.owner,
      actorUserId,
      aggregateType: 'order',
      aggregateId: id,
      payload: { orderId: id },
    });

    return read.detail;
  }

  private async read(
    actorUserId: string,
    id: string,
  ): Promise<{ owner: string; detail: AdminOrderDetail }> {
    const owner = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const { rows } = await sql<{ tenant_id: string | null }>`
        SELECT admin_order_tenant(${id}::uuid) AS tenant_id
      `.execute(trx);
      return rows[0]?.tenant_id ?? null;
    });
    if (owner === null) throw new AdminOrderNotFoundError();

    // Las lecturas de Reservas de la agencia, con su tenant fijado.
    const row = await this.orders.findById(owner, id);
    if (row === undefined) throw new AdminOrderNotFoundError();
    const operations = await this.orders.listOperations(owner, id);
    const tracking = this.hotelReads.handles(row.provider)
      ? ((await this.hotelReads.trackingOf(owner, [id])).get(id) ?? null)
      : null;

    // La retención la ve el nodo que vende (0060) y la conciliación, el de la orden (0047).
    const { hold, reconciliation } = await this.db.withTenant(owner, async (trx) => {
      const { rows: holds } = await sql<WalletHoldRow>`
        SELECT g.status, g.mode, g.currency, g.sale_amount_minor, g.credential_source,
               g.created_at, g.captured_at, g.closed_at
          FROM wallet_hold_groups g
         WHERE g.order_id = ${id}::uuid
      `.execute(trx);
      const { rows: items } = await sql<ReconciliationItemRow>`
        SELECT i.kind, i.severity, i.action, i.created_at
          FROM provider_reconciliation_items i
         WHERE i.order_id = ${id}::uuid
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT ${ADMIN_ORDER_RECONCILIATION_LIMIT}
      `.execute(trx);
      return { hold: holds[0], reconciliation: items };
    });

    // Lo de la red, como superadmin: el nodo y su camino, el vendedor, los motivos y los eventos
    // (domain_events tiene RLS por subárbol administrado, 0029: el superadmin los ve todos).
    const network = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const tenant = await trx
        .selectFrom('tenants')
        .select(['id', 'name', 'slug', 'tenant_type', 'is_branch', 'status'])
        .where('id', '=', owner)
        .executeTakeFirstOrThrow();
      const { rows: path } = await sql<{ id: string; name: string }>`
        SELECT a.id, a.name
          FROM tenants a
          JOIN tenants t ON t.id = ${owner}::uuid
         WHERE a.path OPERATOR(public.@>) t.path
         ORDER BY nlevel(a.path)
      `.execute(trx);
      const seller = await trx
        .selectFrom('users')
        .select(['id', 'email', 'name'])
        .where('id', '=', row.user_id)
        .executeTakeFirst();
      const { rows: attention } = await sql<{ reason: string; since: Date }>`
        SELECT a.reason, a.since FROM admin_order_attention() a WHERE a.order_id = ${id}::uuid
      `.execute(trx);
      return { tenant, path, seller, attention, events: await this.events(trx, id) };
    });

    return {
      owner,
      detail: {
        order: adminOrderView(row, tracking),
        tenant: adminOrderTenant(network.tenant, network.path),
        seller: network.seller ?? null,
        operations,
        providerTracking: tracking,
        walletHold: hold === undefined ? null : adminWalletHold(hold),
        reconciliation: reconciliation.map(adminReconciliationItem),
        attention: sortAttention(network.attention),
        events: network.events,
      },
    };
  }

  /**
   * Los últimos eventos de la orden, del más nuevo al más viejo, sin los de las fichas abiertas
   * (cada vez que alguien la mira sumaría uno y empujaría fuera los que cuentan qué le pasó).
   */
  private async events(trx: Transaction<DB>, orderId: string): Promise<AdminOrderEventView[]> {
    const { rows } = await sql<{
      id: string;
      occurred_at: Date;
      event_type: string;
      tenant_id: string | null;
      actor_user_id: string | null;
      actor_email: string | null;
      payload: unknown;
    }>`
      SELECT e.id, e.occurred_at, e.event_type, e.tenant_id, e.actor_user_id,
             u.email AS actor_email, e.payload
        FROM domain_events e
        LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.aggregate_type = 'order'
         AND e.aggregate_id = ${orderId}
         AND e.event_type <> ${ADMIN_ORDER_VIEWED_EVENT}
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT ${ADMIN_ORDER_EVENTS_LIMIT}
    `.execute(trx);
    return rows.map(adminOrderEvent);
  }

  /** El nodo por el que se filtra existe. `tenants` no tiene RLS. */
  private async assertNode(trx: Transaction<DB>, tenantId: string): Promise<void> {
    const row = await trx
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (row === undefined) throw new PlatformConsoleScopeNotFoundError();
  }
}
