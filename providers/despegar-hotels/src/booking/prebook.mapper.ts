import { Money } from '@sales-travel/canonical';
import { num } from '../internal/coerce';
import type { PrebookCommission, PrebookResult } from './types';

interface RawPrebookCommission {
  amount?: number | string;
  max_amount?: number | string;
  min_amount?: number | string;
}

interface RawPrebookResponse {
  prebook_id?: string;
  expiration?: string;
  status?: string;
  flow?: string;
  total?: number | string;
  currency?: string;
  commission?: RawPrebookCommission;
  extended_info?: { exchange_policies?: unknown; hints?: unknown };
}

export function mapPrebook(raw: RawPrebookResponse): PrebookResult {
  const currency = raw.currency ?? 'USD';
  const result: PrebookResult = {
    prebookId: raw.prebook_id ?? '',
    status: raw.status ?? '',
    total: Money.fromMajor(num(raw.total), currency),
  };
  if (raw.expiration) result.expiration = raw.expiration;
  if (raw.flow) result.flow = raw.flow;
  if (raw.commission) {
    const c: PrebookCommission = { amount: Money.fromMajor(num(raw.commission.amount), currency) };
    if (raw.commission.max_amount != null) {
      c.maxAmount = Money.fromMajor(num(raw.commission.max_amount), currency);
    }
    if (raw.commission.min_amount != null) {
      c.minAmount = Money.fromMajor(num(raw.commission.min_amount), currency);
    }
    result.commission = c;
  }
  // `include: ['EXCHANGE_POLICIES', 'HINTS']`: la certificación pide registrarlos. Viajan tal cual.
  const ext = raw.extended_info;
  if (ext?.exchange_policies != null) result.exchangePolicies = ext.exchange_policies;
  if (ext?.hints != null) result.hints = ext.hints;
  return result;
}
