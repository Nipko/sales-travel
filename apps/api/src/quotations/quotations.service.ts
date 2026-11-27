import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { QuotationStatus } from '../database/database.types.js';
import { encodeBilling, type Billing } from './billing.js';

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
  billing?: unknown;
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
      // MAX + 1 sin candado repetía número cuando dos vendedores cotizaban a la vez: los dos leían
      // el mismo MAX. El lock por agencia (se suelta con la transacción) los pone en fila; el índice
      // único de db/migrations/0097 rechaza un repetido si algún camino se lo saltara.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('quote-number:' || ${tenantId}::uuid::text, 0))`.execute(
        trx,
      );
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

  /** Las `limit` más nuevas y si hay más detrás (QA-H-15). */
  async findAll(
    tenantId: string,
    limit = 100,
  ): Promise<{ rows: QuotationRow[]; hasMore: boolean }> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('quotations')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      return {
        rows: rows.slice(0, limit) as unknown as QuotationRow[],
        hasMore: rows.length > limit,
      };
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
      billing?: Billing | null;
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
          ...(data.billing === undefined
            ? {}
            : { billing: data.billing === null ? null : encodeBilling(data.billing) }),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row as unknown as QuotationRow | undefined;
    });
  }
}
