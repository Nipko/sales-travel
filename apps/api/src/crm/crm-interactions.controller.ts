import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import {
  CrmInteractionsService,
  type CreateInteractionDto,
  type InteractionRow,
} from './crm-interactions.service.js';

@Controller('crm/interactions')
export class CrmInteractionsController {
  constructor(
    private readonly interactions: CrmInteractionsService,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body() body: CreateInteractionDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
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
    const tenantId = await this.resolveActiveTenant(userId);
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
      payload:
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      createdByUserId: row.created_by_user_id,
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
