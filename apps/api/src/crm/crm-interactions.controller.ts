import { Body, Controller, ForbiddenException, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import {
  CrmInteractionsService,
  type CreateInteractionDto,
  type InteractionRow,
} from './crm-interactions.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('crm/interactions')
export class CrmInteractionsController {
  constructor(
    private readonly interactions: CrmInteractionsService,
    private readonly db: DatabaseService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  @Post()
  async create(@CurrentUser() userId: string | undefined, @Body() body: CreateInteractionDto) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.interactions.create(tenantId, {
      ...body,
      createdByUserId: body.createdByUserId ?? userId,
    });
    return { interaction: this.serialize(row) };
  }

  @Get('customer/:customerId')
  async listByCustomer(
    @CurrentUser() userId: string | undefined,
    @Param('customerId') customerId: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const rows = await this.interactions.findByCustomer(tenantId, customerId);
    return { interactions: rows.map((r) => this.serialize(r)) };
  }

  private serialize(row: InteractionRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      opportunityId: row.opportunity_id,
      channel: row.channel,
      direction: row.direction,
      summary: row.summary,
      // El driver devuelve jsonb ya parseado, salvo cuando viaja como texto.
      payload:
        typeof row.payload === 'string'
          ? (JSON.parse(row.payload) as Record<string, unknown>)
          : (row.payload as Record<string, unknown>),
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
    };
  }
}
