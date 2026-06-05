import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';

export interface WaterfallStep {
  tenantId: string;
  tenantName: string;
  level: number;
  ruleType: string;
  addedMinor: number;
}

export interface WaterfallResult {
  netMinor: number;
  finalMinor: number;
  totalMarkupMinor: number;
  breakdown: WaterfallStep[];
}

/**
 * Motor de pricing waterfall: aplica las markup_rules de cada nivel del path
 * (consolidador → agencia → sub-agencia) en cascada sobre el neto. La autorización
 * (quién puede calcular para qué tenant) vive en el controlador.
 */
@Injectable()
export class PricingService {
  constructor(private readonly db: DatabaseService) {}

  /** Lista las reglas de markup propias del tenant (no las heredadas). */
  async listRules(tenantId: string) {
    const rows = await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('markup_rules')
        .select(['id', 'vertical', 'rule_type', 'value_minor', 'priority', 'status', 'created_at'])
        .where('tenant_id', '=', tenantId)
        .orderBy('priority')
        .orderBy('created_at')
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id,
      vertical: r.vertical,
      ruleType: r.rule_type,
      valueMinor: Number(r.value_minor),
      priority: Number(r.priority),
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  async createRule(
    tenantId: string,
    input: {
      vertical: string;
      ruleType: 'percentage' | 'fixed';
      valueMinor: number;
      priority?: number;
    },
  ): Promise<{ id: string }> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .insertInto('markup_rules')
        .values({
          tenant_id: tenantId,
          vertical: input.vertical,
          rule_type: input.ruleType,
          value_minor: Math.trunc(input.valueMinor),
          priority: input.priority ?? 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: row.id };
    });
  }

  async deleteRule(tenantId: string, ruleId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const res = await trx
        .deleteFrom('markup_rules')
        .where('id', '=', ruleId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return Number(res.numDeletedRows ?? 0) > 0;
    });
  }

  async computeWaterfall(
    tenantId: string,
    vertical: string,
    netMinor: number,
  ): Promise<WaterfallResult> {
    const result = await sql<{
      net_minor: string | number;
      final_minor: string | number;
      total_markup_minor: string | number;
      breakdown: unknown;
    }>`SELECT * FROM compute_price_waterfall(${tenantId}::uuid, ${vertical}, ${netMinor}::bigint)`.execute(
      this.db.db,
    );

    const row = result.rows[0];
    return {
      netMinor: Number(row?.net_minor ?? netMinor),
      finalMinor: Number(row?.final_minor ?? netMinor),
      totalMarkupMinor: Number(row?.total_markup_minor ?? 0),
      breakdown: (row?.breakdown as WaterfallStep[] | null) ?? [],
    };
  }
}
