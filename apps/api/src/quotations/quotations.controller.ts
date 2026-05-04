import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import type { QuotationStatus } from '../database/database.types.js';
import { QuotationsService, type CreateQuotationDto } from './quotations.service.js';

@Controller('quotations')
export class QuotationsController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  async create(@CurrentUser() userId: string | undefined, @Body() body: CreateQuotationDto) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.create(tenantId, userId, body);
    return { quotation: this.serialize(row) };
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const rows = await this.quotations.findAll(tenantId);
    return { quotations: rows.map((r) => this.serialize(r)) };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.findById(tenantId, id);
    if (!row) throw new NotFoundException();
    return { quotation: this.serialize(row) };
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body('status') status: QuotationStatus,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.updateStatus(tenantId, id, status);
    if (!row) throw new NotFoundException();
    return { quotation: this.serialize(row) };
  }

  private serialize(row: {
    id: string;
    status: string;
    search_criteria: unknown;
    selected_offer: unknown;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    notes: string | null;
    quote_number: number;
    expires_at: Date;
    created_at: Date;
  }) {
    return {
      id: row.id,
      status: row.status,
      quoteNumber: row.quote_number,
      searchCriteria: row.search_criteria,
      selectedOffer: row.selected_offer,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      customerPhone: row.customer_phone,
      notes: row.notes,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
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
