import { Money } from '@sales-travel/canonical';
import { num } from '../internal/coerce';
import type { PaymentModality, PaymentOptionsQuery } from './types';

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
interface RawPaymentOption {
  option_type?: string;
  group_plans?: string;
}
interface RawModality {
  modality?: string;
  price_information?: RawPriceInfo;
  payment_options?: RawPaymentOption[];
}
interface RawPaymentsResponse {
  modalities?: RawModality[];
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
      options: (m.payment_options ?? []).map((o) => ({
        optionType: o.option_type ?? '',
        planId: o.group_plans,
      })),
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
