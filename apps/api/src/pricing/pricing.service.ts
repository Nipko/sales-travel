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
