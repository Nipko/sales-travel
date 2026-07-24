import { Injectable } from '@nestjs/common';
import { type UpdateObject } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { type DB, type CrmOpportunityStage } from '../database/database.types.js';

export interface CreateOpportunityDto {
  customerId: string;
  assignedUserId?: string | null;
  stage?: CrmOpportunityStage;
  title: string;
  estimatedValueMinor?: number;
  currency?: string;
  destinationCity?: string | null;
  travelStartDate?: string | Date | null;
  travelEndDate?: string | Date | null;
  paxCount?: number;
  packageQuotationId?: string | null;
  sourceChannel?: string;
  isAiControlled?: boolean;
}

export interface UpdateOpportunityDto {
  assignedUserId?: string | null;
  stage?: CrmOpportunityStage;
  title?: string;
  estimatedValueMinor?: number;
  currency?: string;
  destinationCity?: string | null;
  travelStartDate?: string | Date | null;
  travelEndDate?: string | Date | null;
  paxCount?: number;
  packageQuotationId?: string | null;
  orderId?: string | null;
  sourceChannel?: string;
  isAiControlled?: boolean;
  lostReason?: string | null;
}

export interface OpportunityRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  assigned_user_id: string | null;
  stage: CrmOpportunityStage;
  title: string;
  estimated_value_minor: number;
  currency: string;
  destination_city: string | null;
  travel_start_date: Date | null;
  travel_end_date: Date | null;
  pax_count: number;
  package_quotation_id: string | null;
  order_id: string | null;
  source_channel: string;
  is_ai_controlled: boolean;
  lost_reason: string | null;
  created_at: Date;
  updated_at: Date;

  // Joined Customer Details
  customer_first_name?: string;
  customer_last_name?: string;
  customer_phone?: string;
  customer_email?: string;
}

@Injectable()
export class CrmOpportunitiesService {
  constructor(private readonly db: DatabaseService) {}

  async create(tenantId: string, dto: CreateOpportunityDto): Promise<OpportunityRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .insertInto('crm_opportunities')
        .values({
          tenant_id: tenantId,
          customer_id: dto.customerId,
          assigned_user_id: dto.assignedUserId ?? null,
          stage: dto.stage ?? 'AI_HANDLING',
          title: dto.title,
          estimated_value_minor: dto.estimatedValueMinor ?? 0,
          currency: dto.currency ?? 'COP',
          destination_city: dto.destinationCity ?? null,
          travel_start_date: dto.travelStartDate ? new Date(dto.travelStartDate) : null,
          travel_end_date: dto.travelEndDate ? new Date(dto.travelEndDate) : null,
          pax_count: dto.paxCount ?? 1,
          package_quotation_id: dto.packageQuotationId ?? null,
          source_channel: dto.sourceChannel ?? 'WHATSAPP',
          is_ai_controlled: dto.isAiControlled ?? true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as OpportunityRow;
    });
  }

  async findAll(tenantId: string, stage?: CrmOpportunityStage): Promise<OpportunityRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      let query = trx
        .selectFrom('crm_opportunities')
        .innerJoin('customers', 'customers.id', 'crm_opportunities.customer_id')
        .select([
          'crm_opportunities.id',
          'crm_opportunities.tenant_id',
          'crm_opportunities.customer_id',
          'crm_opportunities.assigned_user_id',
          'crm_opportunities.stage',
          'crm_opportunities.title',
          'crm_opportunities.estimated_value_minor',
          'crm_opportunities.currency',
          'crm_opportunities.destination_city',
          'crm_opportunities.travel_start_date',
          'crm_opportunities.travel_end_date',
          'crm_opportunities.pax_count',
          'crm_opportunities.package_quotation_id',
          'crm_opportunities.order_id',
          'crm_opportunities.source_channel',
          'crm_opportunities.is_ai_controlled',
          'crm_opportunities.lost_reason',
          'crm_opportunities.created_at',
          'crm_opportunities.updated_at',
          'customers.first_name as customer_first_name',
          'customers.last_name as customer_last_name',
          'customers.phone as customer_phone',
          'customers.email as customer_email',
        ]);

      if (stage) {
        query = query.where('crm_opportunities.stage', '=', stage);
      }

      const rows = await query.orderBy('crm_opportunities.created_at', 'desc').execute();
      return rows as unknown as OpportunityRow[];
    });
  }

  async findById(tenantId: string, id: string): Promise<OpportunityRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('crm_opportunities')
        .innerJoin('customers', 'customers.id', 'crm_opportunities.customer_id')
        .select([
          'crm_opportunities.id',
          'crm_opportunities.tenant_id',
          'crm_opportunities.customer_id',
          'crm_opportunities.assigned_user_id',
          'crm_opportunities.stage',
          'crm_opportunities.title',
          'crm_opportunities.estimated_value_minor',
          'crm_opportunities.currency',
          'crm_opportunities.destination_city',
          'crm_opportunities.travel_start_date',
          'crm_opportunities.travel_end_date',
          'crm_opportunities.pax_count',
          'crm_opportunities.package_quotation_id',
          'crm_opportunities.order_id',
          'crm_opportunities.source_channel',
          'crm_opportunities.is_ai_controlled',
          'crm_opportunities.lost_reason',
          'crm_opportunities.created_at',
          'crm_opportunities.updated_at',
          'customers.first_name as customer_first_name',
          'customers.last_name as customer_last_name',
          'customers.phone as customer_phone',
          'customers.email as customer_email',
        ])
        .where('crm_opportunities.id', '=', id)
        .executeTakeFirst();

      return row as unknown as OpportunityRow | undefined;
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateOpportunityDto,
  ): Promise<OpportunityRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const updateData: UpdateObject<DB, 'crm_opportunities'> = {};
      if (dto.assignedUserId !== undefined) updateData.assigned_user_id = dto.assignedUserId;
      if (dto.stage !== undefined) updateData.stage = dto.stage;
      if (dto.title !== undefined) updateData.title = dto.title;
      if (dto.estimatedValueMinor !== undefined)
        updateData.estimated_value_minor = dto.estimatedValueMinor;
      if (dto.currency !== undefined) updateData.currency = dto.currency;
      if (dto.destinationCity !== undefined) updateData.destination_city = dto.destinationCity;
      if (dto.travelStartDate !== undefined)
        updateData.travel_start_date = dto.travelStartDate ? new Date(dto.travelStartDate) : null;
      if (dto.travelEndDate !== undefined)
        updateData.travel_end_date = dto.travelEndDate ? new Date(dto.travelEndDate) : null;
      if (dto.paxCount !== undefined) updateData.pax_count = dto.paxCount;
      if (dto.packageQuotationId !== undefined)
        updateData.package_quotation_id = dto.packageQuotationId;
      if (dto.orderId !== undefined) updateData.order_id = dto.orderId;
      if (dto.sourceChannel !== undefined) updateData.source_channel = dto.sourceChannel;
      if (dto.isAiControlled !== undefined) updateData.is_ai_controlled = dto.isAiControlled;
      if (dto.lostReason !== undefined) updateData.lost_reason = dto.lostReason;

      await trx
        .updateTable('crm_opportunities')
        .set(updateData)
        .where('id', '=', id)
        .execute();

      return this.findById(tenantId, id);
    });
  }
}
