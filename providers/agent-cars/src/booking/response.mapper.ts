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
// La respuesta real es: { detail: { "1": {amount, comment}, "2": {...} }, base, realBase, total,
// tax, realTax, realCurrency, ... }. Los cargos viven en `detail` (objeto indexado), la moneda en
// `realCurrency` (no hay `currency` top-level).

interface RawRateCharge {
  amount?: number | string;
  comment?: string;
}

interface RawRateDetail {
  base?: number | string;
  tax?: number | string;
  realCurrency?: string;
  detail?: Record<string, RawRateCharge>;
}

export function mapRateDetail(raw: RawRateDetail): CarRateDetail {
  const currency = str(raw.realCurrency) || 'USD';
  const charges: RateChargeItem[] = Object.entries(raw.detail ?? {}).map(([code, c]) => ({
    code,
    name: str(c.comment),
    amount: Money.fromMajor(num(c.amount), currency),
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

/**
 * El status real de AgentCars es un texto display ("Activo"/"Active"), no el token canónico.
 * Mapea explícitamente; ante un status desconocido/vacío NO asume 'confirmed' (default conservador).
 */
function mapBookingStatus(raw: string): BookingStatus {
  const s = raw.toLowerCase();
  if (s.includes('hold')) return 'on_hold';
  if (s.includes('request')) return 'on_request';
  if (s.includes('activ') || s.includes('confirm') || s === 'ok') return 'confirmed';
  return 'on_request';
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
  /** El API lo devuelve numérico (ej: 371853); se normaliza a string. */
  voucherNumber?: string | number;
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
    ...(raw.voucherNumber != null && { voucherNumber: String(raw.voucherNumber) }),
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

export function mapDailyReport(raw: unknown): DailyReportEntry[] {
  // Defensivo: el consolidado puede venir como array o como objeto (indexado/envuelto).
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.values(raw as Record<string, unknown>).flat()
      : [];
  return list
    .filter((r): r is RawDailyEntry => r != null && typeof r === 'object')
    .map((r) => ({
      confirmationCode: str(r.confirmationCode),
      pickUpDate: str(r.pickUpDate),
      dropOffDate: str(r.dropOffDate),
      status: str(r.status),
    }));
}
