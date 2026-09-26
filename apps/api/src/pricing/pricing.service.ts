import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';

/** Lo que sumó una regla de markup de un nivel de la red (consolidador, agencia, sub-agencia). */
export interface MarkupStep {
  tenantId: string;
  tenantName: string;
  level: number;
  ruleType: string;
  addedMinor: number;
}

/** `ruleType` del paso que agrega el piso del proveedor. Ninguna regla de markup puede tenerlo. */
export const PROVIDER_FLOOR_RULE_TYPE = 'provider_floor';

/**
 * Lo que subió el precio el piso del proveedor (RF-12), por encima de la cascada.
 *
 * No es una regla de ningún nivel de la red, por eso no lleva nombre ni nivel: es una condición
 * del proveedor. Se atribuye al tenant que VENDE, que es quien la cobra.
 */
export interface ProviderFloorStep {
  tenantId: string;
  ruleType: typeof PROVIDER_FLOOR_RULE_TYPE;
  addedMinor: number;
}

export type WaterfallStep = MarkupStep | ProviderFloorStep;

export interface WaterfallResult {
  netMinor: number;
  finalMinor: number;
  totalMarkupMinor: number;
  breakdown: WaterfallStep[];
}

/**
 * Pricing tal como puede verlo un tenant concreto.
 *
 * Lo que se manda al browser en los resultados de búsqueda. Deliberadamente NO lleva
 * `netMinor` ni el `breakdown` paso a paso: ambos revelan cuánto gana el consolidador
 * sobre la agencia que está mirando. La agencia ve su COSTO (el neto del proveedor más
 * lo que le carga su red por encima) y su PROPIO margen, que es lo que necesita para
 * vender; el desglose completo sólo se expone en /pricing/waterfall, que un consolidador
 * consulta sobre su propia red.
 */
export interface TenantPricingView {
  costMinor: number;
  finalMinor: number;
  ownMarkupMinor: number;
  currency: string;
}

/**
 * El piso del proveedor nunca entra al costo de nadie: si lo hiciera, la agencia que vende vería
 * como margen de su consolidador un importe que el consolidador no configuró, y pagaría por él.
 * Sólo lo cuenta como margen propio el tenant al que se atribuyó, que es el que vende.
 */
export function toTenantView(
  w: WaterfallResult,
  tenantId: string,
  currency: string,
): TenantPricingView {
  let own = 0;
  let fromAncestors = 0;
  for (const step of w.breakdown) {
    if (step.tenantId === tenantId) own += step.addedMinor;
    else if (step.ruleType !== PROVIDER_FLOOR_RULE_TYPE) fromAncestors += step.addedMinor;
  }
  return {
    costMinor: w.netMinor + fromAncestors,
    finalMinor: w.finalMinor,
    ownMarkupMinor: own,
    currency,
  };
}

export interface ApplicableRule {
  tenantId: string;
  tenantName: string;
  level: number;
  ruleType: string;
  valueMinor: number;
}

/**
 * Aplica la cascada en JS (misma semántica que compute_price_waterfall): cada regla se
 * compone sobre el running total; 'percentage' suma running*(value/10000), 'fixed' suma value.
 * Se usa para precios en batch (cada oferta de una búsqueda) tras traer las reglas una vez.
 */
export function applyCascade(netMinor: number, rules: ApplicableRule[]): WaterfallResult {
  let running = netMinor;
  const breakdown: WaterfallStep[] = [];
  for (const r of rules) {
    const add =
      r.ruleType === 'percentage' ? Math.round(running * (r.valueMinor / 10000)) : r.valueMinor;
    running += add;
    breakdown.push({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      level: r.level,
      ruleType: r.ruleType,
      addedMinor: add,
    });
  }
  return {
    netMinor,
    finalMinor: running,
    totalMarkupMinor: running - netMinor,
    breakdown,
  };
}

/**
 * Piso de precio del proveedor, DESPUÉS de la cascada (RF-12, D-TBO-16 A):
 * `finalMinor = max(finalMinor de la cascada, floorMinor)`.
 *
 * TBO prohíbe vender por debajo de su `RecommendedSellingRate` en cualquier canal. Si la cascada
 * ya queda en el piso o por encima, el resultado es el mismo objeto: no hay paso que registrar.
 * Si queda por debajo, la diferencia entra al `breakdown` como paso `provider_floor` atribuido a
 * `sellerTenantId` —el tenant que vende—, así la vista de cualquier ancestro no la cuenta como
 * margen propio ni como costo de la agencia.
 *
 * Sin piso (`undefined`) no cambia nada: los proveedores que no lo informan, como Despegar,
 * siguen con la cascada tal cual.
 */
export function applyProviderFloor(
  w: WaterfallResult,
  floorMinor: number | undefined,
  sellerTenantId: string,
): WaterfallResult {
  if (floorMinor === undefined || floorMinor <= w.finalMinor) return w;
  return {
    netMinor: w.netMinor,
    finalMinor: floorMinor,
    totalMarkupMinor: floorMinor - w.netMinor,
    breakdown: [
      ...w.breakdown,
      {
        tenantId: sellerTenantId,
        ruleType: PROVIDER_FLOOR_RULE_TYPE,
        addedMinor: floorMinor - w.finalMinor,
      },
    ],
  };
}

/**
 * Motor de pricing waterfall: aplica las markup_rules de cada nivel del path
 * (consolidador → agencia → sub-agencia) en cascada sobre el neto. La autorización
 * (quién puede calcular para qué tenant) vive en el controlador.
 */
@Injectable()
export class PricingService {
  constructor(private readonly db: DatabaseService) {}

  /** Reglas aplicables (propias + heredadas de ancestros) a un tenant/vertical, en orden de cascada. */
  async getApplicableRules(tenantId: string, vertical: string): Promise<ApplicableRule[]> {
    const res = await sql<{
      tenant_id: string;
      tenant_name: string;
      lvl: number;
      rule_type: string;
      value_minor: string | number;
    }>`SELECT * FROM applicable_markup_rules(${tenantId}::uuid, ${vertical})`.execute(this.db.db);
    return res.rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      level: Number(r.lvl),
      ruleType: r.rule_type,
      valueMinor: Number(r.value_minor),
    }));
  }

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
