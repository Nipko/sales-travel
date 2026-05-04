import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { QuotationStatus } from '../database/database.types.js';

export interface CreateQuotationDto {
  searchCriteria: unknown;
  selectedOffer: unknown;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  notes?: string;
  expiresAt: string;
}

export interface QuotationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  status: QuotationStatus;
  search_criteria: unknown;
  selected_offer: unknown;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  notes: string | null;
  quote_number: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class QuotationsService {
  constructor(private readonly db: DatabaseService) {}

  async create(tenantId: string, userId: string, dto: CreateQuotationDto): Promise<QuotationRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const nextNumber = await trx
        .selectFrom('quotations')
        .select(sql<number>`COALESCE(MAX(quote_number), 0) + 1`.as('next'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();

      const row = await trx
        .insertInto('quotations')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          search_criteria: JSON.stringify(dto.searchCriteria),
          selected_offer: JSON.stringify(dto.selectedOffer),
          customer_name: dto.customerName ?? null,
          customer_email: dto.customerEmail ?? null,
          customer_phone: dto.customerPhone ?? null,
          notes: dto.notes ?? null,
          quote_number: nextNumber.next,
          expires_at: dto.expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as QuotationRow;
    });
  }

  async findAll(tenantId: string): Promise<QuotationRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('quotations')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows as unknown as QuotationRow[];
    });
  }

  async findById(tenantId: string, id: string): Promise<QuotationRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('quotations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row as unknown as QuotationRow | undefined;
    });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: QuotationStatus,
  ): Promise<QuotationRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('quotations')
        .set({ status })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row as unknown as QuotationRow | undefined;
    });
  }

  async updateCustomer(
    tenantId: string,
    id: string,
    data: {
      customerName?: string | null;
      customerEmail?: string | null;
      customerPhone?: string | null;
      notes?: string | null;
    },
  ): Promise<QuotationRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('quotations')
        .set({
          customer_name: data.customerName ?? null,
          customer_email: data.customerEmail ?? null,
          customer_phone: data.customerPhone ?? null,
          notes: data.notes ?? null,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row as unknown as QuotationRow | undefined;
    });
  }
}
