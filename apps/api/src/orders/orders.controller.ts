import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { orderConfirmationEmailHtml } from '../mail/templates.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { CreateOrderSchema, PayOrderSchema, ReshopOrderSchema } from './dto.js';
import { OrdersService, type CreateOrderDto, type OrderRow } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly db: DatabaseService,
    private readonly mailer: MailerService,
  ) {}

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateOrderSchema)) body: CreateOrderDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);

    const { order, providerResult } = await this.orders.createOrder(tenantId, userId, body);

    // Confirmación por email al contacto (best-effort: nunca rompe la reserva).
    if (providerResult.success) {
      void this.sendConfirmationEmail(tenantId, order);
    }

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

  /** Reenvía la confirmación de reserva por email al contacto. */
  @Post(':id/send-confirmation')
  @HttpCode(200)
  async sendConfirmation(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
  ): Promise<{ sent: boolean; to: string }> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const order = await this.orders.findById(tenantId, id);
    if (!order) throw new NotFoundException();
    const to = this.contactEmail(order);
    if (!to) throw new NotFoundException('La reserva no tiene email de contacto');
    const sent = await this.sendConfirmationEmail(tenantId, order);
    return { sent, to };
  }

  private contactEmail(order: OrderRow): string {
    const ci = order.contact_info;
    if (ci && typeof ci === 'object' && 'email' in ci) {
      const email = (ci as { email?: unknown }).email;
      return typeof email === 'string' ? email : '';
    }
    return '';
  }

  private async sendConfirmationEmail(tenantId: string, order: OrderRow): Promise<boolean> {
    const to = this.contactEmail(order);
    if (!to) return false;
    const mail = orderConfirmationEmailHtml({
      orderNumber: order.order_number,
      pnr: order.provider_order_id,
      searchCriteria: order.search_criteria,
      passengers: order.passengers,
      totalAmount: order.total_amount,
      currency: order.currency,
    });
    return this.mailer.sendToTenant(tenantId, {
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
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

  @Post(':id/services')
  async listServices(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    return this.orders.listServices(tenantId, row);
  }

  @Post(':id/reshop')
  async reshopOrder(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReshopOrderSchema))
    body: { paidOrderId: string; bnplOrderId: string; ticketDocIds: string[] },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    return this.orders.reshopOrder(tenantId, body);
  }

  @Post(':id/pay')
  async payOrder(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PayOrderSchema)) body: { payment: unknown },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    return this.orders.payOrder(tenantId, id, row, body.payment as never);
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
