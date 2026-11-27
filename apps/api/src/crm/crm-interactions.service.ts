import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { currentContext } from '../request-context/request-context.js';
import { assertCrmReferences } from './crm-references.js';

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

  /**
   * El usuario va en el contexto, no sólo el tenant: la RLS del CRM (0031) decide por él qué
   * oportunidades ve (admin del nodo: todas; vendedor: las suyas y la cola sin asignar). Con
   * `withTenant` la base no sabía quién pedía y una oportunidad asignada no la veía nadie, ni se
   * podía crear (QA-H-39).
   */
  private contexto(tenantId: string): { userId?: string; tenantId: string } {
    const userId = currentContext()?.userId;
    return userId ? { userId, tenantId } : { tenantId };
  }

  async create(tenantId: string, dto: CreateInteractionDto): Promise<InteractionRow> {
    return this.db.withRequestContext(this.contexto(tenantId), async (trx) => {
      await assertCrmReferences(trx, tenantId, dto);
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
    return this.db.withRequestContext(this.contexto(tenantId), async (trx) => {
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
