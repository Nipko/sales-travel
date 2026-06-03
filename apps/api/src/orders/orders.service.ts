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
import type { OrderStatus } from '../database/database.types.js';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';

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
          total_amount: dto.offer.total.amountMinor,
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
  ): Promise<{ result: OrderCancelResult; order?: OrderRow }> {
    const adapter = await this.latam.forTenant(tenantId);
    const result = await adapter.cancelOrder(pnr, { tenantId });

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

  async reshopOrder(tenantId: string, body: OrderReshopRequest): Promise<OrderReshopResult> {
    const adapter = await this.latam.forTenant(tenantId);
    return adapter.reshopWithTickets(body, { tenantId });
  }

  async payOrder(
    tenantId: string,
    id: string,
    row: OrderRow,
    payment: PaymentInfo,
  ): Promise<OrderPayResult> {
    const contactInfo = (row.contact_info as BookingContactInfo) ?? {
      email: '',
      phone: '',
    };
    const passengers = (row.passengers as { paxId: string; paxType: string }[]) ?? [];

    const adapter = await this.latam.forTenant(tenantId);
    const result = await adapter.payOrder(
      { orderId: row.provider_order_id!, payment, contactInfo, passengers },
      { tenantId },
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
