import { readJson } from './read-json';
import type {
  CreditLimitBody,
  DepositReportBody,
  EnableWalletBody,
  EntryBody,
  EntryKind,
} from './wallet-forms';
import {
  parseAgencyWallets,
  parseDepositReport,
  parseDepositReports,
  parseFinancedWallets,
  parseMovement,
  parseMovements,
  parseWallet,
  type AgencyWallets,
  type DepositReport,
  type FinancedWallets,
  type Wallet,
  type WalletMovement,
} from './wallets';

/**
 * Las llamadas del navegador a los proxies de carteras. Cada una devuelve datos ya validados o un
 * mensaje para la pantalla, con el motivo máquina del API si vino; nunca lanza.
 */

export type WalletResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      /** Motivo máquina del API (`PORTFOLIO_FINANCIER_REQUIRED`…), si vino uno. */
      readonly reason?: string;
      /**
       * No se sabe si la escritura llegó (se cortó la conexión, el servidor no respondió con
       * datos). Se reintenta con la MISMA Idempotency-Key: si había llegado, no se duplica.
       */
      readonly uncertain?: boolean;
    };

const OFFLINE = 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.';
const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recargá la página.';
const UNCERTAIN =
  'No pudimos confirmar si se registró. Reintentá sin cambiar los datos: si ya se había registrado, no se duplica.';

/** El mensaje de un pedido fallido, para la pantalla, si el API no mandó el suyo. */
export function walletErrorMessage(
  status: number,
  kind: 'read' | 'write',
  reason?: string,
): string {
  if (status === 401) return 'Tu sesión venció. Volvé a iniciar sesión.';
  if (reason === 'PORTFOLIO_FINANCIER_REQUIRED' || status === 403) {
    return 'Sólo quien financia a este nodo gestiona sus carteras: su consolidador, su agencia o el superadmin de Planetour.';
  }
  if (status === 404) return 'No encontramos esa cartera en este nodo. Recargá la página.';
  if (status === 409) return 'La cartera cambió mientras la mirabas. Recargá la página y revisá.';
  return kind === 'write'
    ? 'No se pudo guardar el cambio. Probá de nuevo.'
    : 'No se pudieron cargar las carteras. Probá de nuevo.';
}

/**
 * ¿Releer las carteras después de una escritura que falló? Sí cuando lo que se ve ya no es lo que
 * hay: no se sabe si llegó (`uncertain`), el API dice que el estado cambió (409: otro financiador
 * ya aprobó ese depósito) o que ya no existe (404). Un error de validación o de permiso, no.
 */
export function refreshAfterFailure(
  res: Extract<WalletResult<unknown>, { readonly ok: false }>,
): boolean {
  return res.uncertain === true || res.status === 409 || res.status === 404;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function call<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
): Promise<WalletResult<T>> {
  const kind = init.method === undefined || init.method === 'GET' ? 'read' : 'write';
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return kind === 'write'
      ? { ok: false, status: 0, message: UNCERTAIN, uncertain: true }
      : { ok: false, status: 0, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!read.ok) {
    // Sin cuerpo nuestro no se sabe qué pasó con una escritura.
    return kind === 'write' && res.status >= 500
      ? { ok: false, status: res.status, message: UNCERTAIN, uncertain: true }
      : { ok: false, status: res.status, message: read.message };
  }
  if (!res.ok) {
    const body = asRecord(read.data);
    const error = body?.['error'];
    const reason = typeof body?.['reason'] === 'string' ? body['reason'] : undefined;
    const message =
      typeof error === 'string' && error.trim() !== ''
        ? error
        : walletErrorMessage(res.status, kind, reason);
    return {
      ok: false,
      status: res.status,
      message,
      ...(reason === undefined ? {} : { reason }),
      ...(kind === 'write' && res.status >= 500 ? { uncertain: true } : {}),
    };
  }
  const data = parse(read.data);
  return data === undefined
    ? { ok: false, status: res.status, message: UNREADABLE }
    : { ok: true, data };
}

function json(method: string, body: unknown, idempotencyKey?: string): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  };
}

function withCurrency(url: string, currency?: string): string {
  return currency === undefined ? url : `${url}?currency=${encodeURIComponent(currency)}`;
}

function walletOf(value: unknown): Wallet | undefined {
  return parseWallet(asRecord(value)?.['portfolio']);
}

export interface EntryResult {
  readonly portfolio: Wallet;
  readonly transaction: WalletMovement;
}

export interface ResolvedReport {
  readonly report: DepositReport;
  readonly portfolio: Wallet;
}

function resolvedOf(value: unknown): ResolvedReport | undefined {
  const r = asRecord(value);
  const report = parseDepositReport(r?.['report']);
  const portfolio = parseWallet(r?.['portfolio']);
  return report === undefined || portfolio === undefined ? undefined : { report, portfolio };
}

// ───────────────────────────── Quien financia ─────────────────────────────

function base(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/portfolios`;
}

export function loadFinancedWallets(tenantId: string): Promise<WalletResult<FinancedWallets>> {
  return call(base(tenantId), {}, parseFinancedWallets);
}

export function loadFinancedMovements(
  tenantId: string,
  currency?: string,
): Promise<WalletResult<WalletMovement[]>> {
  return call(withCurrency(`${base(tenantId)}/transactions`, currency), {}, parseMovements);
}

export function loadFinancedReports(tenantId: string): Promise<WalletResult<DepositReport[]>> {
  return call(`${base(tenantId)}/deposit-reports`, {}, parseDepositReports);
}

export function enableWallet(
  tenantId: string,
  body: EnableWalletBody,
): Promise<WalletResult<Wallet>> {
  return call(base(tenantId), json('POST', body), walletOf);
}

export function updateWallet(
  tenantId: string,
  portfolioId: string,
  body: CreditLimitBody | { readonly status: 'active' | 'suspended'; readonly reason: string },
): Promise<WalletResult<Wallet>> {
  return call(
    `${base(tenantId)}/${encodeURIComponent(portfolioId)}`,
    json('PATCH', body),
    walletOf,
  );
}

export function recordEntry(
  tenantId: string,
  portfolioId: string,
  kind: EntryKind,
  body: EntryBody,
  idempotencyKey: string,
): Promise<WalletResult<EntryResult>> {
  const path = kind === 'deposit' ? 'deposits' : 'adjustments';
  return call(
    `${base(tenantId)}/${encodeURIComponent(portfolioId)}/${path}`,
    json('POST', body, idempotencyKey),
    (value) => {
      const r = asRecord(value);
      const portfolio = parseWallet(r?.['portfolio']);
      const transaction = parseMovement(r?.['transaction']);
      return portfolio === undefined || transaction === undefined
        ? undefined
        : { portfolio, transaction };
    },
  );
}

export function approveDepositReport(
  tenantId: string,
  reportId: string,
  body: { readonly reason: string | null },
): Promise<WalletResult<ResolvedReport>> {
  return call(
    `${base(tenantId)}/deposit-reports/${encodeURIComponent(reportId)}/approve`,
    json('POST', body),
    resolvedOf,
  );
}

export function rejectDepositReport(
  tenantId: string,
  reportId: string,
  body: { readonly reason: string },
): Promise<WalletResult<ResolvedReport>> {
  return call(
    `${base(tenantId)}/deposit-reports/${encodeURIComponent(reportId)}/reject`,
    json('POST', body),
    resolvedOf,
  );
}

// ───────────────────────────── La agencia ─────────────────────────────

export function loadAgencyWallets(): Promise<WalletResult<AgencyWallets>> {
  return call('/api/portfolios', {}, parseAgencyWallets);
}

export function loadAgencyMovements(currency?: string): Promise<WalletResult<WalletMovement[]>> {
  return call(withCurrency('/api/portfolios/transactions', currency), {}, parseMovements);
}

export function loadAgencyReports(): Promise<WalletResult<DepositReport[]>> {
  return call('/api/portfolios/deposit-reports', {}, parseDepositReports);
}

export function submitDepositReport(
  body: DepositReportBody,
  idempotencyKey: string,
): Promise<WalletResult<DepositReport>> {
  return call('/api/portfolios/deposit-reports', json('POST', body, idempotencyKey), (value) =>
    parseDepositReport(asRecord(value)?.['report']),
  );
}
