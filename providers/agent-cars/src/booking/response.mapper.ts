import { Money } from '@sales-travel/canonical';
import type {
  BookingStatus,
  CarBookResult,
  CarRateDetail,
  CarReservation,
  CancelResult,
  DailyReportEntry,
  RateChargeItem,
  ReleaseResult,
} from '../types.js';
import { num, str } from '../internal/coerce.js';

// ──────────── RateInformation ────────────

interface RawRateCharge {
  code?: string;
  name?: string;
  amount?: number | string;
  currency?: string;
}

interface RawRateDetail {
  base?: number | string;
  tax?: number | string;
  currency?: string;
  charges?: RawRateCharge[];
}

export function mapRateDetail(raw: RawRateDetail): CarRateDetail {
  const currency = str(raw.currency) || 'USD';
  const charges: RateChargeItem[] = (raw.charges ?? []).map((c) => ({
    code: str(c.code),
    name: str(c.name),
    amount: Money.fromMajor(num(c.amount), str(c.currency) || currency),
  }));
  return {
    base: Money.fromMajor(num(raw.base), currency),
    tax: Money.fromMajor(num(raw.tax), currency),
    charges,
  };
}

// ──────────── Confirmation ────────────

interface RawBookResult {
  confirmationCode?: string;
  sippCode?: string;
  rateCode?: string;
  status?: string;
}

export function mapBookResult(raw: RawBookResult): CarBookResult {
  return {
    confirmationCode: str(raw.confirmationCode),
    sippCode: str(raw.sippCode),
    rateCode: str(raw.rateCode),
    status: mapBookingStatus(str(raw.status)),
  };
}

function mapBookingStatus(raw: string): BookingStatus {
  if (raw === 'on_hold') return 'on_hold';
  if (raw === 'on_request') return 'on_request';
  return 'confirmed';
}

// ──────────── MyReservation ────────────

interface RawReservation {
  confirmationCode?: string;
  firstName?: string;
  lastName?: string;
  sippCode?: string;
  rateCode?: string;
  status?: string;
  voucherInformation?: Record<string, unknown>;
  voucherNumber?: string;
}

export function mapReservation(raw: RawReservation): CarReservation {
  return {
    confirmationCode: str(raw.confirmationCode),
    firstName: str(raw.firstName),
    lastName: str(raw.lastName),
    sippCode: str(raw.sippCode),
    rateCode: str(raw.rateCode),
    status: str(raw.status),
    voucherInformation: raw.voucherInformation ?? {},
    ...(raw.voucherNumber && { voucherNumber: str(raw.voucherNumber) }),
  };
}

// ──────────── Cancel ────────────

interface RawCancelResult {
  confirmationCode?: string;
  message?: string;
}

export function mapCancelResult(raw: RawCancelResult): CancelResult {
  return {
    success: true,
    confirmationCode: str(raw.confirmationCode),
    ...(raw.message && { message: str(raw.message) }),
  };
}

// ──────────── Release ────────────

interface RawReleaseResult {
  confirmationCode?: string;
  sippCode?: string;
  rateCode?: string;
  status?: string;
}

export function mapReleaseResult(raw: RawReleaseResult): ReleaseResult {
  return {
    confirmationCode: str(raw.confirmationCode),
    sippCode: str(raw.sippCode),
    rateCode: str(raw.rateCode),
    status: str(raw.status),
  };
}

// ──────────── DailyReport ────────────

interface RawDailyEntry {
  confirmationCode?: string;
  pickUpDate?: string;
  dropOffDate?: string;
  status?: string;
}

export function mapDailyReport(raw: RawDailyEntry[]): DailyReportEntry[] {
  return raw.map((r) => ({
    confirmationCode: str(r.confirmationCode),
    pickUpDate: str(r.pickUpDate),
    dropOffDate: str(r.dropOffDate),
    status: str(r.status),
  }));
}
