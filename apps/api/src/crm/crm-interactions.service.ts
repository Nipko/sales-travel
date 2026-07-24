import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export interface CreateInteractionDto {
  customerId: string;
  opportunityId?: string | null;
  channel: string; // 'WHATSAPP', 'VOICE_CALL', 'EMAIL', 'INTERNAL_NOTE', 'AI_SYSTEM_EVENT'
  direction: string; // 'INBOUND', 'OUTBOUND', 'INTERNAL'
  summary: string;
  payload?: unknown;
  createdByUserId?: string | null;
}

export interface InteractionRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  opportunity_id: string | null;
  channel: string;
  direction: string;
  summary: string;
  payload: unknown;
  created_by_user_id: string | null;
  created_at: Date;
}

@Injectable()
export class CrmInteractionsService {
  constructor(private readonly db: DatabaseService) {}

  async create(tenantId: string, dto: CreateInteractionDto): Promise<InteractionRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .insertInto('crm_interactions')
        .values({
          tenant_id: tenantId,
          customer_id: dto.customerId,
          opportunity_id: dto.opportunityId ?? null,
          channel: dto.channel,
          direction: dto.direction,
          summary: dto.summary,
          payload: dto.payload ? JSON.stringify(dto.payload) : '{}',
          created_by_user_id: dto.createdByUserId ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as InteractionRow;
    });
  }

  async findByCustomer(tenantId: string, customerId: string): Promise<InteractionRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('crm_interactions')
        .selectAll()
        .where('customer_id', '=', customerId)
        .orderBy('created_at', 'desc')
        .execute();

      return rows as unknown as InteractionRow[];
    });
  }
}
