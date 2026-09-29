/**
 * Las carteras de un nodo en el panel, sin I/O: cómo se leen las respuestas del API, cómo se
 * muestran los montos y qué dice cada movimiento o depósito informado.
 *
 * Una cartera por moneda (db/migrations/0052). Su saldo, su cupo y sus movimientos van en unidades
 * MENORES de su moneda, con el exponente ISO 4217 que manda el API: nadie lo supone al mostrar ni
 * al cargar un monto. Quién puede qué lo decide el API y la base (decisión del founder del
 * 2026-09-29, opción A: la cartera la establece quien financia al nodo); esto sólo lo presenta.
 */

export type WalletStatus = 'active' | 'suspended' | 'overlimit';
export type DepositReportStatus = 'pending' | 'approved' | 'rejected';

export interface Wallet {
  readonly id: string;
  readonly tenantId: string;
  /** ISO 4217, en mayúsculas. */
  readonly currency: string;
  /** Decimales de la moneda. `null`: moneda retirada de ISO 4217, que ya no se opera. */
  readonly exponent: number | null;
  readonly creditLimitMinor: number;
  readonly balanceMinor: number;
  /** Saldo más cupo: lo que la agencia puede retener para reservar. Negativo si se pasó. */
  readonly availableMinor: number;
  readonly status: string;
  readonly updatedAt: string;
}

export interface WalletMovement {
  readonly id: string;
  readonly portfolioId: string;
  readonly currency: string;
  readonly exponent: number | null;
  /** Con signo: positivo acredita, negativo debita. */
  readonly amountMinor: number;
  readonly transactionType: string;
  readonly referenceId: string | null;
  readonly notes: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
}

export interface DepositReport {
  readonly id: string;
  readonly portfolioId: string;
  readonly currency: string;
  readonly exponent: number | null;
  readonly amountMinor: number;
  readonly reference: string;
  /** `AAAA-MM-DD`, como lo informó la agencia. */
  readonly depositedOn: string | null;
  readonly notes: string | null;
  readonly status: DepositReportStatus;
  readonly reportedByName: string | null;
  readonly reportedAt: string;
  readonly resolvedByName: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionReason: string | null;
}

/** Lo que ve la agencia en Cartera B2B (`GET /portfolios`). */
export interface AgencyWallets {
  readonly portfolios: readonly Wallet[];
  /** A quién pedirle una moneda, cupo o que apruebe un depósito. `null`: lo gestiona Planetour. */
  readonly financier: { readonly tenantId: string; readonly name: string } | null;
}

/** El nodo cuyas carteras gestiona quien lo financia. */
export interface FinancedNode {
  readonly id: string;
  readonly name: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
  readonly status: string;
  readonly defaultCurrency: string;
}

/** Lo que ve quien financia (`GET /tenants/:id/portfolios`). */
export interface FinancedWallets {
  readonly tenant: FinancedNode;
  readonly portfolios: readonly Wallet[];
  readonly pendingDepositReports: number;
  /** Monedas que se le pueden habilitar: las que todavía no tiene. */
  readonly availableCurrencies: readonly string[];
}

// ───────────────────────────── Lectura ─────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_RE.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function safeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function exponentOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  const n = safeInt(value);
  return n !== undefined && n >= 0 && n <= 4 ? n : undefined;
}

/** Un listado: se descartan los elementos con forma rota, no el listado entero. */
function listOf<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === undefined ? [] : [parsed];
  });
}

export function parseWallet(value: unknown): Wallet | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const id = r['id'];
  const tenantId = r['tenantId'];
  const currency = r['currency'];
  const exponent = exponentOf(r['exponent']);
  const creditLimitMinor = safeInt(r['creditLimitMinor']);
  const balanceMinor = safeInt(r['balanceMinor']);
  const status = str(r['status']);
  if (!isUuid(id) || !isUuid(tenantId) || !isCurrencyCode(currency) || exponent === undefined) {
    return undefined;
  }
  if (creditLimitMinor === undefined || balanceMinor === undefined || status === undefined) {
    return undefined;
  }
  // El disponible se recalcula: es la regla del API (saldo más cupo) y no depende de que venga.
  return {
    id: id.toLowerCase(),
    tenantId: tenantId.toLowerCase(),
    currency,
    exponent,
    creditLimitMinor,
    balanceMinor,
    availableMinor: balanceMinor + creditLimitMinor,
    status,
    updatedAt: str(r['updatedAt']) ?? '',
  };
}

export function parseMovement(value: unknown): WalletMovement | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const id = r['id'];
  const portfolioId = r['portfolioId'];
  const currency = r['currency'];
  const exponent = exponentOf(r['exponent']);
  const amountMinor = safeInt(r['amountMinor']);
  const transactionType = str(r['transactionType']);
  const createdAt = str(r['createdAt']);
  if (!isUuid(id) || !isUuid(portfolioId) || !isCurrencyCode(currency) || exponent === undefined) {
    return undefined;
  }
  if (amountMinor === undefined || transactionType === undefined || createdAt === undefined) {
    return undefined;
  }
  return {
    id: id.toLowerCase(),
    portfolioId: portfolioId.toLowerCase(),
    currency,
    exponent,
    amountMinor,
    transactionType,
    referenceId: nullableStr(r['referenceId']),
    notes: nullableStr(r['notes']),
    createdByName: nullableStr(r['createdByName']),
    createdAt,
  };
}

const REPORT_STATUSES: readonly DepositReportStatus[] = ['pending', 'approved', 'rejected'];

function isReportStatus(value: unknown): value is DepositReportStatus {
  return typeof value === 'string' && (REPORT_STATUSES as readonly string[]).includes(value);
}

export function parseDepositReport(value: unknown): DepositReport | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const id = r['id'];
  const portfolioId = r['portfolioId'];
  const currency = r['currency'];
  const exponent = exponentOf(r['exponent']);
  const amountMinor = safeInt(r['amountMinor']);
  const reference = str(r['reference']);
  const status = r['status'];
  const reportedAt = str(r['reportedAt']);
  if (!isUuid(id) || !isUuid(portfolioId) || !isCurrencyCode(currency) || exponent === undefined) {
    return undefined;
  }
  if (amountMinor === undefined || reference === undefined || !isReportStatus(status)) {
    return undefined;
  }
  if (reportedAt === undefined) return undefined;
  const depositedOn = str(r['depositedOn']);
  return {
    id: id.toLowerCase(),
    portfolioId: portfolioId.toLowerCase(),
    currency,
    exponent,
    amountMinor,
    reference,
    depositedOn:
      depositedOn !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(depositedOn) ? depositedOn : null,
    notes: nullableStr(r['notes']),
    status,
    reportedByName: nullableStr(r['reportedByName']),
    reportedAt,
    resolvedByName: nullableStr(r['resolvedByName']),
    resolvedAt: nullableStr(r['resolvedAt']),
    resolutionReason: nullableStr(r['resolutionReason']),
  };
}

export function parseAgencyWallets(value: unknown): AgencyWallets | undefined {
  const r = asRecord(value);
  const portfolios = listOf(r?.['portfolios'], parseWallet);
  if (r === undefined || portfolios === undefined) return undefined;
  const f = asRecord(r['financier']);
  const financierId = f?.['tenantId'];
  const financierName = str(f?.['name']);
  return {
    portfolios: sortWallets(portfolios),
    financier:
      isUuid(financierId) && financierName !== undefined && financierName.trim() !== ''
        ? { tenantId: financierId.toLowerCase(), name: financierName }
        : null,
  };
}

export function parseFinancedWallets(value: unknown): FinancedWallets | undefined {
  const r = asRecord(value);
  const t = asRecord(r?.['tenant']);
  const portfolios = listOf(r?.['portfolios'], parseWallet);
  if (r === undefined || t === undefined || portfolios === undefined) return undefined;
  const id = t['id'];
  const name = str(t['name']);
  const tenantType = str(t['tenantType']);
  const status = str(t['status']);
  if (!isUuid(id) || name === undefined || tenantType === undefined || status === undefined) {
    return undefined;
  }
  const available = listOf(r['availableCurrencies'], (c) => (isCurrencyCode(c) ? c : undefined));
  const pending = safeInt(r['pendingDepositReports']);
  const defaultCurrency = t['defaultCurrency'];
  return {
    tenant: {
      id: id.toLowerCase(),
      name,
      tenantType,
      isBranch: t['isBranch'] === true,
      status,
      defaultCurrency: isCurrencyCode(defaultCurrency) ? defaultCurrency : '',
    },
    portfolios: sortWallets(portfolios),
    pendingDepositReports: pending !== undefined && pending > 0 ? pending : 0,
    availableCurrencies: available ?? [],
  };
}

export function parseMovements(value: unknown): WalletMovement[] | undefined {
  return listOf(asRecord(value)?.['transactions'], parseMovement);
}

export function parseDepositReports(value: unknown): DepositReport[] | undefined {
  return listOf(asRecord(value)?.['reports'], parseDepositReport);
}

/** Por moneda, en orden alfabético: el mismo orden en cada pantalla y en cada recarga. */
export function sortWallets(wallets: readonly Wallet[]): Wallet[] {
  return [...wallets].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Los depósitos informados, con los pendientes primero y del más nuevo al más viejo. */
export function sortDepositReports(reports: readonly DepositReport[]): DepositReport[] {
  return [...reports].sort((a, b) => {
    const pa = a.status === 'pending' ? 0 : 1;
    const pb = b.status === 'pending' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.reportedAt.localeCompare(a.reportedAt);
  });
}

// ───────────────────────────── Montos ─────────────────────────────

const LOCALE = 'es-CO';

/**
 * Un monto en unidades menores, con su moneda. Los centavos se muestran sólo si los hay: un depósito
 * de 1.500.000 pesos no necesita ",00", y uno de 1.500.000,50 no los pierde.
 */
export function formatMinor(minor: number, currency: string, exponent: number | null): string {
  const digits = exponent ?? 2;
  const factor = 10 ** digits;
  const fraction = minor % factor !== 0 ? digits : 0;
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    }).format(minor / factor);
  } catch {
    return `${(minor / factor).toFixed(fraction)} ${currency}`;
  }
}

/** Con signo explícito (`+` o `−`): el signo se lee, no depende sólo del color. */
export function formatSignedMinor(
  minor: number,
  currency: string,
  exponent: number | null,
): string {
  const abs = formatMinor(Math.abs(minor), currency, exponent);
  if (minor > 0) return `+${abs}`;
  if (minor < 0) return `−${abs}`;
  return abs;
}

/** "Dólar estadounidense", "Peso colombiano". Sin nombre conocido, el código. */
export function currencyName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['es'], { type: 'currency' }).of(code);
    if (name === undefined || name === code) return code;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return code;
  }
}

/** Fecha y hora corta en la zona del navegador ("29 sept 2026, 14:05"). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** Un día `AAAA-MM-DD`, sin pasarlo por la zona horaria: es el día que informó la agencia. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

// ───────────────────────────── Estados y etiquetas ─────────────────────────────

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

const WALLET_STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  active: { label: 'Activa', tone: 'success' },
  suspended: { label: 'Suspendida', tone: 'danger' },
  overlimit: { label: 'Sobre el cupo', tone: 'warning' },
};

export function walletStatus(status: string): { label: string; tone: Tone } {
  return WALLET_STATUS[status] ?? { label: status, tone: 'neutral' };
}

/** ¿Se puede reservar con esta cartera? Sólo activa: suspendida o sobre el cupo, no retiene. */
export function walletOperates(wallet: Pick<Wallet, 'status'>): boolean {
  return wallet.status === 'active';
}

/** ¿Quien financia puede mover esta cartera? No si la moneda ya no está en ISO 4217. */
export function walletEditable(wallet: Pick<Wallet, 'exponent'>): boolean {
  return wallet.exponent !== null;
}

/**
 * Lo que dice la tarjeta debajo del disponible, o `undefined` si no hay nada que advertir.
 * Suspendida primero: con la cartera suspendida el saldo no importa.
 */
export function walletNotice(wallet: Wallet): { tone: Tone; text: string } | undefined {
  if (wallet.status === 'suspended') {
    return { tone: 'danger', text: `Suspendida: no se puede reservar en ${wallet.currency}.` };
  }
  if (wallet.status === 'overlimit') {
    return { tone: 'warning', text: `Sobre el cupo: no se puede reservar en ${wallet.currency}.` };
  }
  if (wallet.availableMinor < 0) {
    return {
      tone: 'warning',
      text: 'Se pasó del cupo: no puede retener más hasta cubrir la diferencia.',
    };
  }
  if (wallet.availableMinor === 0) {
    return {
      tone: 'neutral',
      text: 'Sin saldo ni cupo: todavía no puede reservar en esta moneda.',
    };
  }
  return undefined;
}

const MOVEMENT_LABEL: Readonly<Record<string, string>> = {
  DEPOSIT_PAYMENT: 'Depósito',
  MANUAL_ADJUSTMENT: 'Ajuste',
  BOOKING_HOLD: 'Retención por reserva',
  BOOKING_RELEASED: 'Retención liberada',
  BOOKING_CHARGE: 'Cargo por emisión',
};

export function movementLabel(type: string): string {
  return MOVEMENT_LABEL[type] ?? 'Movimiento';
}

/** El tono del monto: lo que suma, lo que resta y lo que queda retenido por una reserva. */
export function movementTone(
  movement: Pick<WalletMovement, 'amountMinor' | 'transactionType'>,
): Tone {
  if (movement.transactionType === 'BOOKING_HOLD') return 'warning';
  if (movement.amountMinor > 0) return 'success';
  if (movement.amountMinor < 0) return 'danger';
  return 'neutral';
}

const REPORT_STATUS: Readonly<Record<DepositReportStatus, { label: string; tone: Tone }>> = {
  pending: { label: 'Pendiente', tone: 'warning' },
  approved: { label: 'Aprobado', tone: 'success' },
  rejected: { label: 'Rechazado', tone: 'danger' },
};

export function reportStatus(status: DepositReportStatus): { label: string; tone: Tone } {
  return REPORT_STATUS[status];
}

/** Cuántos depósitos informados esperan, dicho para un título o una insignia. */
export function pendingReportsLabel(count: number): string {
  if (count <= 0) return 'Ningún depósito informado espera revisión.';
  return count === 1
    ? '1 depósito informado espera revisión.'
    : `${count} depósitos informados esperan revisión.`;
}

/** Las monedas de las carteras, para filtrar los movimientos. */
export function walletCurrencies(wallets: readonly Pick<Wallet, 'currency'>[]): string[] {
  return [...new Set(wallets.map((w) => w.currency))].sort();
}

/** Los movimientos de una moneda, o todos con `'all'`. */
export function movementsIn(
  movements: readonly WalletMovement[],
  currency: string,
): WalletMovement[] {
  return currency === 'all' ? [...movements] : movements.filter((m) => m.currency === currency);
}
