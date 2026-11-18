import { Money } from '@sales-travel/canonical';
import { num } from '../internal/coerce';
import type { PaymentModality, PaymentOptionsQuery, PaymentPlan } from './types';

export function buildPaymentOptionsQuery(
  q: PaymentOptionsQuery,
): Record<string, string | number | boolean | undefined> {
  return {
    prebook_id: q.prebookId,
    input_points: q.inputPoints,
    include_hints: q.includeHints,
  };
}

interface RawTaxBreakdown {
  code?: string;
  amount?: number | string;
}
interface RawPriceTotal {
  base?: number | string;
  taxes?: number | string;
  fees?: number | string;
  discount?: number | string;
  processing_cost?: number | string;
  total?: number | string;
  tax_breakdown?: RawTaxBreakdown[];
}
interface RawPriceInfo {
  total?: RawPriceTotal;
  currency?: string;
}
interface RawPlan {
  id?: string | number;
  type?: string;
  price?: { currency?: string; total?: number | string };
  installments?: number;
  card_brand?: string;
  deferred_conditions?: { deadline?: string; reason?: string };
}
interface RawGroupPlan {
  type?: string;
  plans?: RawPlan[];
}
interface RawPaymentOption {
  option_type?: string;
  /** Una lista de grupos; versiones viejas del contrato lo daban como texto suelto. */
  group_plans?: RawGroupPlan[] | string;
}
interface RawModality {
  modality?: string;
  price_information?: RawPriceInfo;
  payment_options?: RawPaymentOption[];
}
interface RawPaymentsResponse {
  modalities?: RawModality[];
}

function mapPlan(p: RawPlan, groupType: string | undefined, fallbackCurrency: string): PaymentPlan {
  const plan: PaymentPlan = { id: String(p.id) };
  if (groupType) plan.groupType = groupType;
  if (p.type) plan.type = p.type;
  if (p.price?.total != null) {
    plan.price = Money.fromMajor(num(p.price.total), p.price.currency ?? fallbackCurrency);
  }
  if (typeof p.installments === 'number') plan.installments = p.installments;
  if (p.card_brand) plan.cardBrand = p.card_brand;
  if (p.deferred_conditions?.deadline) plan.deferredDeadline = p.deferred_conditions.deadline;
  if (p.deferred_conditions?.reason) plan.deferredReason = p.deferred_conditions.reason;
  return plan;
}

function mapPlans(groups: RawPaymentOption['group_plans'], currency: string): PaymentPlan[] {
  if (typeof groups === 'string') return groups ? [{ id: groups }] : [];
  return (groups ?? []).flatMap((g) =>
    (g.plans ?? [])
      .filter((p) => p.id != null && p.id !== '')
      .map((p) => mapPlan(p, g.type, currency)),
  );
}

export function mapPaymentOptions(raw: RawPaymentsResponse): PaymentModality[] {
  return (raw.modalities ?? []).map((m) => {
    const currency = m.price_information?.currency ?? 'USD';
    const t = m.price_information?.total;
    const modality: PaymentModality = {
      modality: m.modality ?? '',
      total: Money.fromMajor(num(t?.total), currency),
      taxBreakdown: (t?.tax_breakdown ?? []).map((tb) => ({
        code: tb.code ?? '',
        amount: Money.fromMajor(num(tb.amount), currency),
      })),
      options: (m.payment_options ?? []).map((o) => {
        const plans = mapPlans(o.group_plans, currency);
        const choice: PaymentModality['options'][number] = {
          optionType: o.option_type ?? '',
          plans,
        };
        if (plans[0]) choice.planId = plans[0].id;
        return choice;
      }),
    };
    if (t?.base != null) modality.base = Money.fromMajor(num(t.base), currency);
    if (t?.taxes != null) modality.taxes = Money.fromMajor(num(t.taxes), currency);
    if (t?.fees != null) modality.fees = Money.fromMajor(num(t.fees), currency);
    if (t?.discount != null) modality.discount = Money.fromMajor(num(t.discount), currency);
    if (t?.processing_cost != null) {
      modality.processingCost = Money.fromMajor(num(t.processing_cost), currency);
    }
    return modality;
  });
}
