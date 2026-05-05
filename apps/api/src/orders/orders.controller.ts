import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  async create(@CurrentUser() userId: string | undefined, @Body() body: CreateOrderDto) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);

    const { order, providerResult } = await this.orders.createOrder(tenantId, userId, body);

    return {
      order: this.serialize(order),
      providerResult: {
        success: providerResult.success,
        pnr: providerResult.pnr,
        warnings: providerResult.warnings,
        error: providerResult.error,
      },
    };
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const rows = await this.orders.findAll(tenantId);
    return { orders: rows.map((r) => this.serialize(r)) };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row) return { order: null };
    return { order: this.serialize(row) };
  }

  @Post(':id/retrieve')
  async retrieve(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    const result = await this.orders.retrieveFromProvider(tenantId, row.provider_order_id);
    return result;
  }

  @Post(':id/cancel')
  async cancel(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    const { result } = await this.orders.cancelOrder(tenantId, id, row.provider_order_id);
    return result;
  }

  private serialize(row: {
    id: string;
    tenant_id: string;
    user_id: string;
    quotation_id: string | null;
    provider: string;
    provider_order_id: string | null;
    status: string;
    search_criteria: unknown;
    selected_offer: unknown;
    passengers: unknown;
    contact_info: unknown;
    total_amount: number;
    currency: string;
    order_number: number;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      quotationId: row.quotation_id,
      provider: row.provider,
      pnr: row.provider_order_id,
      status: row.status,
      searchCriteria: row.search_criteria,
      selectedOffer: row.selected_offer,
      passengers: row.passengers,
      contactInfo: row.contact_info,
      totalAmount: row.total_amount,
      currency: row.currency,
      orderNumber: row.order_number,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async resolveActiveTenant(userId: string): Promise<string> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select(['tenant_id'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      if (!row) throw new ForbiddenException('user has no active membership');
      return row.tenant_id;
    });
  }
}
