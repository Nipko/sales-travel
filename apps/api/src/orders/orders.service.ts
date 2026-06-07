import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  type BookingContactInfo,
  type OrderCancelResult,
  type OrderCreateResult,
  type OrderPayResult,
  type OrderReshopRequest,
  type OrderReshopResult,
  type OrderRetrieveResult,
  type Passenger,
  type PaymentInfo,
  type ServiceListResult,
} from '@sales-travel/domain';
import type { Offer } from '@sales-travel/canonical';
import { DatabaseService } from '../database/database.service.js';
import type {
  OrderOperationStatus,
  OrderOperationType,
  OrderStatus,
} from '../database/database.types.js';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';

export interface OrderOperationRow {
  id: string;
  type: OrderOperationType;
  status: OrderOperationStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

export interface CreateOrderDto {
  offer: Offer;
  searchCriteria: unknown;
  passengers: Passenger[];
  contactInfo: BookingContactInfo;
  quotationId?: string;
}

export interface OrderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  quotation_id: string | null;
  provider: string;
  provider_order_id: string | null;
  status: OrderStatus;
  search_criteria: unknown;
  selected_offer: unknown;
  passengers: unknown;
  contact_info: unknown;
  total_amount: number;
  currency: string;
  order_number: number;
  provider_raw: unknown;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly latam: LatamNdcProviderFactory,
  ) {}

  async createOrder(
    tenantId: string,
    userId: string,
    dto: CreateOrderDto,
  ): Promise<{ order: OrderRow; providerResult: OrderCreateResult }> {
    const adapter = await this.latam.forTenant(tenantId);
    const providerResult = await adapter.createOrder(
      {
        offer: dto.offer,
        criteria: dto.offer as never,
        passengers: dto.passengers,
        contactInfo: dto.contactInfo,
      },
      { tenantId },
    );

    const order = await this.db.withTenant(tenantId, async (trx) => {
      const nextNumber = await trx
        .selectFrom('orders')
        .select(sql<number>`COALESCE(MAX(order_number), 0) + 1`.as('next'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();

      const row = await trx
        .insertInto('orders')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          quotation_id: dto.quotationId ?? null,
          provider: 'latam-ndc',
          provider_order_id: providerResult.pnr ?? null,
          status: providerResult.success ? 'confirmed' : 'failed',
          search_criteria: JSON.stringify(dto.searchCriteria),
          selected_offer: JSON.stringify(dto.offer),
          passengers: JSON.stringify(dto.passengers),
          contact_info: JSON.stringify(dto.contactInfo),
          // El cliente paga el precio final (con la cascada de markup); el proveedor
          // recibe el neto (dto.offer.total). Si no hay pricing, final = neto.
          total_amount: dto.offer.pricing?.finalMinor ?? dto.offer.total.amountMinor,
          currency: dto.offer.total.currency,
          order_number: nextNumber.next,
          provider_raw: null,
          error_message: providerResult.error ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as OrderRow;
    });

    return { order, providerResult };
  }

  async findAll(tenantId: string): Promise<OrderRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('orders')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows as unknown as OrderRow[];
    });
  }

  async findById(tenantId: string, id: string): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row as unknown as OrderRow | undefined;
    });
  }

  async retrieveFromProvider(tenantId: string, pnr: string): Promise<OrderRetrieveResult> {
    const adapter = await this.latam.forTenant(tenantId);
    return adapter.retrieveOrder(pnr, { tenantId });
  }

  async cancelOrder(
    tenantId: string,
    id: string,
    pnr: string,
    actorUserId?: string,
  ): Promise<{ result: OrderCancelResult; order?: OrderRow }> {
    const adapter = await this.latam.forTenant(tenantId);
    let result: OrderCancelResult;
    try {
      result = await adapter.cancelOrder(pnr, { tenantId });
    } catch (err) {
      await this.logOperation(
        tenantId,
        id,
        'cancel',
        'failed',
        (err as Error).message,
        actorUserId,
      );
      throw err;
    }
    await this.logOperation(
      tenantId,
      id,
      'cancel',
      result.success ? 'success' : 'failed',
      result.success ? null : (result.error ?? 'cancelación rechazada'),
      actorUserId,
    );

    if (result.success) {
      const order = await this.db.withTenant(tenantId, async (trx) => {
        const row = await trx
          .updateTable('orders')
          .set({ status: 'cancelled' as OrderStatus })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        return row as unknown as OrderRow | undefined;
      });
      return { result, order };
    }

    return { result };
  }

  async listServices(tenantId: string, row: OrderRow): Promise<ServiceListResult> {
    const passengers = (row.passengers as { paxId: string; paxType: string }[]) ?? [];
    const adapter = await this.latam.forTenant(tenantId);
    return adapter.listServices(
      { orderId: row.provider_order_id!, passengers, itemType: 'BAGGAGE' },
      { tenantId },
    );
  }

  async reshopOrder(
    tenantId: string,
    orderId: string,
    body: OrderReshopRequest,
    actorUserId?: string,
  ): Promise<OrderReshopResult> {
    const adapter = await this.latam.forTenant(tenantId);
    let result: OrderReshopResult;
    try {
      result = await adapter.reshopWithTickets(body, { tenantId });
    } catch (err) {
      await this.logOperation(
        tenantId,
        orderId,
        'reshop',
        'failed',
        (err as Error).message,
        actorUserId,
      );
      throw err;
    }
    await this.logOperation(
      tenantId,
      orderId,
      'reshop',
      result.success ? 'success' : 'failed',
      result.success ? null : (result.error ?? 'reshop rechazado'),
      actorUserId,
    );
    return result;
  }

  /** Inserta un registro durable de una operación de post-venta (trazabilidad + reintento). */
  private async logOperation(
    tenantId: string,
    orderId: string,
    type: OrderOperationType,
    status: OrderOperationStatus,
    lastError: string | null,
    actorUserId?: string,
  ): Promise<void> {
    try {
      await this.db.withTenant(tenantId, async (trx) => {
        await trx
          .insertInto('order_operations')
          .values({
            tenant_id: tenantId,
            order_id: orderId,
            type,
            status,
            last_error: lastError,
            result: JSON.stringify({ status }),
            actor_user_id: actorUserId ?? null,
          })
          .execute();
      });
    } catch {
      // El registro de la operación es best-effort: nunca debe tumbar la operación principal.
    }
  }

  /** Historial de operaciones de post-venta de una orden (más reciente primero). */
  async listOperations(tenantId: string, orderId: string): Promise<OrderOperationRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('order_operations')
        .select(['id', 'type', 'status', 'attempts', 'last_error', 'created_at'])
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows as unknown as OrderOperationRow[];
    });
  }

  /**
   * Reintenta una operación fallida. Hoy soporta 'cancel' (re-ejecuta el void con el PNR de la
   * orden). Para 'pay' no aplica (no guardamos datos de tarjeta por PCI).
   */
  async retryOperation(
    tenantId: string,
    orderId: string,
    opId: string,
    actorUserId?: string,
  ): Promise<{ result: OrderCancelResult }> {
    const op = await this.db.withTenant(tenantId, async (trx) =>
      trx
        .selectFrom('order_operations')
        .select(['type'])
        .where('id', '=', opId)
        .where('order_id', '=', orderId)
        .executeTakeFirst(),
    );
    if (!op) throw new Error('operation not found');
    if (op.type !== 'cancel') {
      throw new Error('Sólo las cancelaciones se pueden reintentar automáticamente.');
    }
    const order = await this.findById(tenantId, orderId);
    if (!order?.provider_order_id) throw new Error('order has no PNR');
    const { result } = await this.cancelOrder(
      tenantId,
      orderId,
      order.provider_order_id,
      actorUserId,
    );
    return { result };
  }

  async payOrder(
    tenantId: string,
    id: string,
    row: OrderRow,
    payment: PaymentInfo,
    actorUserId?: string,
  ): Promise<OrderPayResult> {
    const contactInfo = (row.contact_info as BookingContactInfo) ?? {
      email: '',
      phone: '',
    };
    const passengers = (row.passengers as { paxId: string; paxType: string }[]) ?? [];

    const adapter = await this.latam.forTenant(tenantId);
    let result: OrderPayResult;
    try {
      result = await adapter.payOrder(
        { orderId: row.provider_order_id!, payment, contactInfo, passengers },
        { tenantId },
      );
    } catch (err) {
      await this.logOperation(tenantId, id, 'pay', 'failed', (err as Error).message, actorUserId);
      throw err;
    }
    await this.logOperation(
      tenantId,
      id,
      'pay',
      result.success ? 'success' : 'failed',
      result.success ? null : (result.error ?? 'pago rechazado'),
      actorUserId,
    );

    if (result.success) {
      await this.db.withTenant(tenantId, async (trx) => {
        await trx
          .updateTable('orders')
          .set({ status: (result.status ?? 'confirmed') as OrderStatus })
          .where('id', '=', id)
          .execute();
      });
    }

    return result;
  }
}
