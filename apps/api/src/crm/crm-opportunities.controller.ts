import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import {
  CrmOpportunitiesService,
  type CreateOpportunityDto,
  type UpdateOpportunityDto,
  type OpportunityRow,
} from './crm-opportunities.service.js';
import { type CrmOpportunityStage } from '../database/database.types.js';

@Controller('crm/opportunities')
export class CrmOpportunitiesController {
  constructor(
    private readonly opportunities: CrmOpportunitiesService,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body() body: CreateOpportunityDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.opportunities.create(tenantId, body);
    return { opportunity: this.serialize(row) };
  }

  @Get()
  async list(
    @CurrentUser() userId: string | undefined,
    @Query('stage') stage?: CrmOpportunityStage,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const rows = await this.opportunities.findAll(tenantId, stage);
    return { opportunities: rows.map((r) => this.serialize(r)) };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.opportunities.findById(tenantId, id);
    if (!row) throw new NotFoundException();
    return { opportunity: this.serialize(row) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body() body: UpdateOpportunityDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.opportunities.update(tenantId, id, body);
    if (!row) throw new NotFoundException();
    return { opportunity: this.serialize(row) };
  }

  private serialize(row: OpportunityRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      assignedUserId: row.assigned_user_id,
      stage: row.stage,
      title: row.title,
      estimatedValueMinor: Number(row.estimated_value_minor),
      currency: row.currency,
      destinationCity: row.destination_city,
      travelStartDate: row.travel_start_date,
      travelEndDate: row.travel_end_date,
      paxCount: row.pax_count,
      packageQuotationId: row.package_quotation_id,
      orderId: row.order_id,
      sourceChannel: row.source_channel,
      isAiControlled: row.is_ai_controlled,
      lostReason: row.lost_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      customer: {
        firstName: row.customer_first_name,
        lastName: row.customer_last_name,
        phone: row.customer_phone,
        email: row.customer_email,
      },
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
