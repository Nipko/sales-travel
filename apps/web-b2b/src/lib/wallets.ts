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
/**
 * Dónde está una retención de la red en la cartera de quien financia (db/migrations/0060):
 * retenida, cobrada al confirmarse la reserva, liberada, o en revisión (figuró confirmada y después
 * no realizada: la concilia una persona).
 */
export type NetworkHoldStatus = 'held' | 'captured' | 'released' | 'conflict';

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
  /** Nunca en los asientos de la red: los firma un vendedor de otro nodo. */
  readonly createdByName: string | null;
  /**
   * De qué reserva de la red es un asiento `NETWORK_*`. Sólo lo manda el API a quien administra el
   * nodo; `null` en los demás asientos y para el resto del personal.
   */
  readonly network: WalletMovementNetwork | null;
  readonly createdAt: string;
}

/** La reserva de la red detrás de un asiento `NETWORK_*`: de qué agencia y qué número. */
export interface WalletMovementNetwork {
  readonly originTenantId: string;
  /** `null` si el API no pudo leer el nombre: se muestra "Una agencia de tu red". */
  readonly originTenantName: string | null;
  readonly orderNumber: number | null;
  readonly status: NetworkHoldStatus;
}

/**
 * Una reserva de la red retenida en una cartera del nodo, al costo de su nivel (0060). Nunca trae
 * quién vendió, los pasajeros ni el precio de venta: son de otra agencia.
 */
export interface NetworkHold {
  readonly levelId: string;
  readonly currency: string;
  readonly exponent: number | null;
  /** Lo que retiene la cartera del nodo: el costo de su nivel, siempre positivo. */
  readonly amountMinor: number;
  readonly status: NetworkHoldStatus;
  readonly originTenantId: string;
  readonly originTenantName: string | null;
  readonly orderNumber: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Por moneda: lo retenido (retenido o en revisión) y lo cobrado por la red. */
export interface NetworkHoldTotal {
  readonly currency: string;
  readonly exponent: number | null;
  readonly heldMinor: number;
  readonly chargedMinor: number;
}

/** `GET /portfolios/network-holds` y `GET /tenants/:id/portfolios/network-holds`. */
export interface NetworkHolds {
  readonly items: readonly NetworkHold[];
  readonly totals: readonly NetworkHoldTotal[];
  /**
   * Alguna de las listas llegó al tope del API ({@link NETWORK_HOLDS_PAGE}): la lista no tiene
   * todas las reservas, aunque los totales sí las suman.
   */
  readonly truncated?: boolean;
}

/** El tope de cada listado de `network-holds` en el API (`NETWORK_HOLDS_LIMIT`). */
export const NETWORK_HOLDS_PAGE = 200;

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
  /**
   * Los proveedores en que la agencia tiene su propia cuenta, todos (también el correo). Sólo
   * códigos de proveedor. Cuáles importan para la cartera lo dice {@link reservesWithOwnAccounts}.
   */
  readonly ownProviderAccounts: readonly string[];
}

/**
 * Los proveedores cuyas reservas retienen cartera y graban en la orden la cuenta con que se
 * reservaron: los de hoteles que reservan por el Book neutral con órdenes (hoy sólo TBO; Despegar
 * no retiene, docs/platform/12 §12.8). Con la cuenta propia en ellos la reserva no retiene nada
 * (decisión del founder del 2026-09-30). Vuelos y autos no graban la cuenta, así que la propia no
 * los exime. Uno nuevo que retenga se suma acá; si falta, la web sólo avisa de más y decide la base.
 */
export const PROVIDERS_WITH_WALLET_HOLD: readonly string[] = ['tbo-hotels'];

/**
 * ¿La agencia reserva con su propia cuenta en todos los proveedores que retienen cartera? Entonces
 * sus reservas no retienen de ninguna y no hace falta avisarle que le falta una. Una cuenta que no
 * reserva (el correo) o la de un proveedor que no retiene no cuentan.
 */
export function reservesWithOwnAccounts(
  wallets: Pick<AgencyWallets, 'ownProviderAccounts'>,
): boolean {
  return PROVIDERS_WITH_WALLET_HOLD.every((code) => wallets.ownProviderAccounts.includes(code));
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

/** Un código de proveedor como los de la bóveda (`tbo-hotels`, `latam-ndc`). */
const PROVIDER_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

const NETWORK_HOLD_STATUSES: readonly NetworkHoldStatus[] = [
  'held',
  'captured',
  'released',
  'conflict',
];

function isNetworkHoldStatus(value: unknown): value is NetworkHoldStatus {
  return typeof value === 'string' && (NETWORK_HOLD_STATUSES as readonly string[]).includes(value);
}

/** Los asientos que la red deja en la cartera de quien la financia (0060). */
const NETWORK_ENTRY_TYPES: readonly string[] = ['NETWORK_HOLD', 'NETWORK_RELEASED'];

export function isNetworkMovement(movement: Pick<WalletMovement, 'transactionType'>): boolean {
  return NETWORK_ENTRY_TYPES.includes(movement.transactionType);
}

/** Un número de reserva: entero positivo, o `null`. Un número roto no tira el asiento. */
function orderNumberOf(value: unknown): number | null {
  const n = safeInt(value);
  return n !== undefined && n > 0 ? n : null;
}

function parseMovementNetwork(value: unknown): WalletMovementNetwork | null {
  const r = asRecord(value);
  const originTenantId = r?.['originTenantId'];
  const status = r?.['status'];
  if (r === undefined || !isUuid(originTenantId) || !isNetworkHoldStatus(status)) return null;
  return {
    originTenantId: originTenantId.toLowerCase(),
    originTenantName: nullableStr(r['originTenantName']),
    orderNumber: orderNumberOf(r['orderNumber']),
    status,
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
  // Un asiento de la red nunca muestra quién lo firmó, aunque el API lo mandara: es un vendedor de
  // otro nodo. Y la reserva de la red sólo va en esos asientos.
  const fromNetwork = isNetworkMovement({ transactionType });
  return {
    id: id.toLowerCase(),
    portfolioId: portfolioId.toLowerCase(),
    currency,
    exponent,
    amountMinor,
    transactionType,
    referenceId: fromNetwork ? null : nullableStr(r['referenceId']),
    notes: nullableStr(r['notes']),
    createdByName: fromNetwork ? null : nullableStr(r['createdByName']),
    network: fromNetwork ? parseMovementNetwork(r['network']) : null,
    createdAt,
  };
}

export function parseNetworkHold(value: unknown): NetworkHold | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const levelId = r['levelId'];
  const currency = r['currency'];
  const exponent = exponentOf(r['exponent']);
  const amountMinor = safeInt(r['amountMinor']);
  const status = r['status'];
  const originTenantId = r['originTenantId'];
  const createdAt = str(r['createdAt']);
  if (!isUuid(levelId) || !isCurrencyCode(currency) || exponent === undefined) return undefined;
  if (amountMinor === undefined || amountMinor <= 0 || !isNetworkHoldStatus(status)) {
    return undefined;
  }
  if (!isUuid(originTenantId) || createdAt === undefined) return undefined;
  return {
    levelId: levelId.toLowerCase(),
    currency,
    exponent,
    amountMinor,
    status,
    originTenantId: originTenantId.toLowerCase(),
    originTenantName: nullableStr(r['originTenantName']),
    orderNumber: orderNumberOf(r['orderNumber']),
    createdAt,
    updatedAt: str(r['updatedAt']) ?? createdAt,
  };
}

function parseNetworkHoldTotal(value: unknown): NetworkHoldTotal | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const currency = r['currency'];
  const exponent = exponentOf(r['exponent']);
  const heldMinor = safeInt(r['heldMinor']);
  const chargedMinor = safeInt(r['chargedMinor']);
  if (!isCurrencyCode(currency) || exponent === undefined) return undefined;
  if (heldMinor === undefined || heldMinor < 0 || chargedMinor === undefined || chargedMinor < 0) {
    return undefined;
  }
  return { currency, exponent, heldMinor, chargedMinor };
}

/**
 * Las reservas de la red del nodo. Sin listado de reservas no hay vista; sin totales legibles, la
 * lista se muestra igual y los totales no (nunca un total en cero inventado).
 */
export function parseNetworkHolds(value: unknown): NetworkHolds | undefined {
  const r = asRecord(value);
  const items = listOf(r?.['items'], parseNetworkHold);
  if (items === undefined) return undefined;
  const totals = listOf(r?.['totals'], parseNetworkHoldTotal) ?? [];
  return {
    items,
    totals: [...totals].sort((a, b) => a.currency.localeCompare(b.currency)),
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
  // Sin el dato (un API anterior), ninguna: la búsqueda avisa como siempre y decide el PreBook.
  const own =
    listOf(r['ownProviderAccounts'], (c) =>
      typeof c === 'string' && PROVIDER_CODE_RE.test(c) ? c : undefined,
    ) ?? [];
  return {
    portfolios: sortWallets(portfolios),
    financier:
      isUuid(financierId) && financierName !== undefined && financierName.trim() !== ''
        ? { tenantId: financierId.toLowerCase(), name: financierName }
        : null,
    ownProviderAccounts: [...new Set(own)].sort(),
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
  NETWORK_HOLD: 'Retención de tu red',
  NETWORK_RELEASED: 'Retención de tu red liberada',
};

export function movementLabel(type: string): string {
  return MOVEMENT_LABEL[type] ?? 'Movimiento';
}

/** Lo que queda retenido por una reserva, propia o de la red, va en su propio tono. */
const HOLD_ENTRY_TYPES: readonly string[] = ['BOOKING_HOLD', 'NETWORK_HOLD'];

/** El tono del monto: lo que suma, lo que resta y lo que queda retenido por una reserva. */
export function movementTone(
  movement: Pick<WalletMovement, 'amountMinor' | 'transactionType'>,
): Tone {
  if (HOLD_ENTRY_TYPES.includes(movement.transactionType)) return 'warning';
  if (movement.amountMinor > 0) return 'success';
  if (movement.amountMinor < 0) return 'danger';
  return 'neutral';
}

// ───────────────────────────── Reservas de la red ─────────────────────────────

/**
 * Cobrada es neutral y no "éxito": para quien financia es saldo que se fue. En revisión es peligro
 * porque la retención quedó como cargo de una reserva que no se hizo y la tiene que conciliar una
 * persona.
 */
const NETWORK_HOLD_STATUS: Readonly<Record<NetworkHoldStatus, { label: string; tone: Tone }>> = {
  held: { label: 'Retenida', tone: 'warning' },
  captured: { label: 'Cobrada', tone: 'neutral' },
  released: { label: 'Liberada', tone: 'success' },
  conflict: { label: 'En revisión', tone: 'danger' },
};

export function networkHoldStatus(status: NetworkHoldStatus): { label: string; tone: Tone } {
  return NETWORK_HOLD_STATUS[status];
}

/** "Agencia Sur · Reserva #1042": de dónde viene, sin quién la vendió. */
export function networkOriginLabel(
  origin: Pick<NetworkHold, 'originTenantName' | 'orderNumber'>,
): string {
  const agency = origin.originTenantName ?? 'Una agencia de tu red';
  return origin.orderNumber === null ? agency : `${agency} · Reserva #${origin.orderNumber}`;
}

/** Las que todavía ocupan saldo o piden atención: retenidas o en revisión. */
export function openNetworkHolds(items: readonly Pick<NetworkHold, 'status'>[]): number {
  return items.filter((h) => h.status === 'held' || h.status === 'conflict').length;
}

const ATTENTION_ORDER: Readonly<Record<NetworkHoldStatus, number>> = {
  conflict: 0,
  held: 1,
  captured: 2,
  released: 2,
};

function newerFirst(a: NetworkHold, b: NetworkHold): number {
  const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (Number.isFinite(byDate) && byDate !== 0) return byDate;
  return b.levelId.localeCompare(a.levelId);
}

/**
 * Lo que se muestra de las reservas de la red: la página reciente del API más las retenidas y las
 * en revisión pedidas aparte (`?status=held`, `?status=conflict`). El API corta cada listado en
 * {@link NETWORK_HOLDS_PAGE} por fecha y sin mirar el estado, así que con una red que vende las
 * cobradas llenan la página y las abiertas más viejas —las que concilia una persona— quedarían
 * fuera de la lista y del contador mientras siguen sumando en los totales.
 *
 * Primero las en revisión, después las retenidas y al final el resto, cada grupo de la más nueva a
 * la más vieja. Una reserva que vino en dos listas queda con su versión más reciente. Los totales
 * son los de la página reciente: el API los suma sobre todas.
 */
export function combineNetworkHolds(
  recent: NetworkHolds,
  open: readonly NetworkHolds[],
): NetworkHolds {
  const byLevel = new Map<string, NetworkHold>();
  for (const hold of [...recent.items, ...open.flatMap((o) => o.items)]) {
    const seen = byLevel.get(hold.levelId);
    if (seen === undefined || Date.parse(hold.updatedAt) > Date.parse(seen.updatedAt)) {
      byLevel.set(hold.levelId, hold);
    }
  }
  const items = [...byLevel.values()].sort(
    (a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status] || newerFirst(a, b),
  );
  const truncated = [recent, ...open].some(
    (list) => list.truncated === true || list.items.length >= NETWORK_HOLDS_PAGE,
  );
  return { items, totals: recent.totals, truncated };
}

/** Las reservas de la red de una moneda, o todas con `'all'`. */
export function networkHoldsIn(holds: NetworkHolds, currency: string): NetworkHolds {
  if (currency === 'all') return holds;
  return {
    items: holds.items.filter((h) => h.currency === currency),
    totals: holds.totals.filter((t) => t.currency === currency),
    ...(holds.truncated === undefined ? {} : { truncated: holds.truncated }),
  };
}

/**
 * El vacío de la lista de la red. Con la lista cortada, una moneda sin filas no es una red sin
 * reservas: sus totales vienen de reservas más viejas que la página, y las abiertas ya se pidieron
 * aparte, así que lo que falta está cobrado.
 */
export function networkHoldsEmpty(
  holds: Pick<NetworkHolds, 'truncated'>,
  emptyTitle: string,
  emptyText: string,
): { emptyTitle: string; emptyText: string } {
  if (holds.truncated !== true) return { emptyTitle, emptyText };
  return {
    emptyTitle: 'No hay reservas recientes en esta moneda.',
    emptyText: 'Lo que suman los totales es de reservas más viejas, ya cobradas.',
  };
}

/** ¿Hay algo de la red en las carteras del nodo, en la lista o en los totales? */
export function hasNetworkHolds(holds: NetworkHolds | null | undefined): boolean {
  if (holds === null || holds === undefined) return false;
  return holds.items.length > 0 || holds.totals.length > 0;
}

/** Las monedas de las reservas de la red y de sus totales, para filtrarlas. */
export function networkHoldCurrencies(holds: NetworkHolds): string[] {
  return [
    ...new Set([...holds.items.map((h) => h.currency), ...holds.totals.map((t) => t.currency)]),
  ].sort();
}

/**
 * ¿El nodo financia a otros, y por eso su cartera retiene por las reservas de su red? Espejo de los
 * tipos que financian en 0052 salvo la plataforma, que nunca retiene por la red (0060): los
 * consolidadores y las agencias, sucursales incluidas. Una sub-agencia no tiene red debajo.
 */
export function financesNetwork(node: { readonly tenantType: string }): boolean {
  return node.tenantType === 'consolidator' || node.tenantType === 'agency';
}

function sameId(value: unknown, wanted: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === wanted;
}

/**
 * ¿El nodo `tenantId` financia a una red, según `GET /tenants/network`? Tiene que ser de un tipo
 * que financia y tener al menos un nodo colgando de él: una agencia sin sub-agencias no tiene red
 * que retenga en sus carteras. Ese listado trae los nodos que el usuario administra y lo que
 * cuelga de ellos: si el nodo no está, el usuario no lo administra y tampoco vería su red.
 */
export function nodeFinancesNetwork(network: unknown, tenantId: string): boolean {
  const tenants = asRecord(network)?.['tenants'];
  if (!Array.isArray(tenants)) return false;
  const wanted = tenantId.toLowerCase();
  const nodes = tenants.map(asRecord);
  const tenantType = nodes.find((t) => sameId(t?.['id'], wanted))?.['tenantType'];
  if (typeof tenantType !== 'string' || !financesNetwork({ tenantType })) return false;
  return nodes.some((t) => sameId(t?.['parentTenantId'], wanted));
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
