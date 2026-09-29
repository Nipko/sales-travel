import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { isUniqueViolation } from './booking-hold.ledger.js';

/**
 * Los errores de las carteras, con motivo máquina (`reason`) para que la web decida qué ofrecer
 * sin interpretar el texto, y la traducción de los que lanza la base (db/migrations/0052).
 *
 * - `STW01`: la operación viola una regla de las carteras o de los depósitos informados → 409.
 * - `42501` con la regla `portfolio_financier_required`, `deposit_report_resolver` o
 *   `portfolio_entry_author` → 403. Cualquier otro 42501 (la RLS, un REVOKE) no es de acá.
 *
 * Como en `tenant-hierarchy-errors.ts`, el texto que ve el usuario sale de la tabla de abajo y no
 * del de la base, que trae ids en DETAIL: una regla que la tabla no conoce sale con un mensaje
 * genérico.
 */
export const PORTFOLIO_RULE_SQLSTATE = 'STW01';
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';
const FORBIDDEN_RULES: ReadonlySet<string> = new Set([
  'portfolio_financier_required',
  'deposit_report_resolver',
  'portfolio_entry_author',
]);
/** La cartera de esa moneda ya existe: el UNIQUE (tenant_id, currency) de 0052. */
const WALLET_CURRENCY_KEY = 'agency_portfolios_tenant_currency_key';

export type PortfolioReason =
  | 'PORTFOLIO_FINANCIER_REQUIRED'
  | 'PORTFOLIO_CURRENCY_NOT_ENABLED'
  | 'PORTFOLIO_ALREADY_ENABLED'
  | 'PORTFOLIO_NOT_FOUND'
  | 'PORTFOLIO_BALANCE_OUT_OF_RANGE'
  | 'PORTFOLIO_IDEMPOTENCY_KEY_REUSED'
  | 'PORTFOLIO_IDENTITY_IMMUTABLE'
  | 'PORTFOLIO_ENTRY_AUTHOR'
  | 'PORTFOLIO_RULE_VIOLATION'
  | 'DEPOSIT_REPORT_NOT_FOUND'
  | 'DEPOSIT_REPORT_NOT_PENDING'
  | 'DEPOSIT_REPORT_BORN_PENDING'
  | 'DEPOSIT_REPORT_TRANSITION'
  | 'DEPOSIT_REPORT_IMMUTABLE'
  | 'DEPOSIT_REPORT_RESOLVER'
  | 'DEPOSIT_REPORT_LEDGER_ENTRY';

const MESSAGES: Readonly<Record<PortfolioReason, string>> = {
  PORTFOLIO_FINANCIER_REQUIRED:
    'Sólo quien financia a este nodo gestiona sus carteras: su consolidador, su agencia o el ' +
    'superadmin de Planetour.',
  PORTFOLIO_CURRENCY_NOT_ENABLED:
    'La agencia no tiene cartera en esa moneda: pedile a quien te financia que la habilite.',
  PORTFOLIO_ALREADY_ENABLED: 'El nodo ya tiene una cartera en esa moneda.',
  PORTFOLIO_NOT_FOUND: 'La cartera no existe en este nodo.',
  PORTFOLIO_BALANCE_OUT_OF_RANGE:
    'El movimiento dejaría el saldo fuera del rango que la cartera puede registrar.',
  PORTFOLIO_IDEMPOTENCY_KEY_REUSED:
    'La Idempotency-Key ya se usó para otro movimiento o con otros datos: generá una nueva.',
  PORTFOLIO_IDENTITY_IMMUTABLE:
    'La moneda y el nodo de una cartera no cambian: para otra moneda se habilita otra cartera.',
  PORTFOLIO_ENTRY_AUTHOR: 'Un depósito o un ajuste de cartera lo firma el usuario que lo registra.',
  PORTFOLIO_RULE_VIOLATION: 'La operación no respeta las reglas de las carteras.',
  DEPOSIT_REPORT_NOT_FOUND: 'El depósito informado no existe en este nodo.',
  DEPOSIT_REPORT_NOT_PENDING:
    'El depósito informado ya fue resuelto: se aprueba o se rechaza una sola vez.',
  DEPOSIT_REPORT_BORN_PENDING:
    'Un depósito informado nace pendiente: lo aprueba o lo rechaza quien financia a la agencia.',
  DEPOSIT_REPORT_TRANSITION: 'Un depósito informado sólo pasa de pendiente a aprobado o rechazado.',
  DEPOSIT_REPORT_IMMUTABLE:
    'Lo que informó la agencia no se modifica: si está mal, se rechaza y la agencia lo informa de nuevo.',
  DEPOSIT_REPORT_RESOLVER: 'Quien resuelve un depósito informado es el usuario que lo resuelve.',
  DEPOSIT_REPORT_LEDGER_ENTRY:
    'La aprobación tiene que apuntar al depósito que acreditó ese monto en esa cartera.',
};

/** Las reglas STW01 de 0052 que la API conoce. Es el nombre de la regla en mayúsculas. */
const DB_RULES: ReadonlySet<PortfolioReason> = new Set([
  'PORTFOLIO_IDENTITY_IMMUTABLE',
  'DEPOSIT_REPORT_NOT_PENDING',
  'DEPOSIT_REPORT_BORN_PENDING',
  'DEPOSIT_REPORT_TRANSITION',
  'DEPOSIT_REPORT_IMMUTABLE',
  'DEPOSIT_REPORT_LEDGER_ENTRY',
]);

/** 409: la operación choca con el estado de la cartera o del depósito informado. */
export class PortfolioConflictError extends ConflictException {
  readonly reason: PortfolioReason;

  constructor(reason: PortfolioReason, message: string = MESSAGES[reason]) {
    super(message);
    this.reason = reason;
    this.name = 'PortfolioConflictError';
  }
}

/** 403: quien actúa no puede gestionar esa cartera. */
export class PortfolioForbiddenError extends ForbiddenException {
  readonly reason: PortfolioReason;

  constructor(reason: PortfolioReason, message: string = MESSAGES[reason]) {
    super(message);
    this.reason = reason;
    this.name = 'PortfolioForbiddenError';
  }
}

/** 404: la cartera o el depósito informado no son de ese nodo (o no existen). */
export class PortfolioNotFoundError extends NotFoundException {
  readonly reason: PortfolioReason;

  constructor(reason: 'PORTFOLIO_NOT_FOUND' | 'DEPOSIT_REPORT_NOT_FOUND') {
    super(MESSAGES[reason]);
    this.reason = reason;
    this.name = 'PortfolioNotFoundError';
  }
}

/**
 * El nodo no tiene cartera en la moneda de la operación. Nunca se abre una implícita: qué monedas
 * opera una agencia lo decide quien la financia.
 */
export function walletNotEnabled(currency: string): PortfolioConflictError {
  return new PortfolioConflictError(
    'PORTFOLIO_CURRENCY_NOT_ENABLED',
    `La agencia no tiene cartera en ${currency}: pedile a quien te financia que la habilite.`,
  );
}

export function walletAlreadyEnabled(currency: string): PortfolioConflictError {
  return new PortfolioConflictError(
    'PORTFOLIO_ALREADY_ENABLED',
    `El nodo ya tiene una cartera en ${currency}.`,
  );
}

interface PgErrorFields {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

/**
 * La excepción HTTP de un error de las carteras que lanzó la base, o `undefined` si el error es
 * otra cosa (y sigue su camino).
 */
export function portfolioHttpError(
  error: unknown,
): PortfolioConflictError | PortfolioForbiddenError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as PgErrorFields;
  const rule = typeof constraint === 'string' ? constraint : undefined;
  if (code === PORTFOLIO_RULE_SQLSTATE) {
    const candidate = (rule?.toUpperCase() ?? '') as PortfolioReason;
    return new PortfolioConflictError(
      DB_RULES.has(candidate) ? candidate : 'PORTFOLIO_RULE_VIOLATION',
    );
  }
  if (code === INSUFFICIENT_PRIVILEGE_SQLSTATE && rule !== undefined && FORBIDDEN_RULES.has(rule)) {
    return new PortfolioForbiddenError(rule.toUpperCase() as PortfolioReason);
  }
  if (isUniqueViolation(error) && rule === WALLET_CURRENCY_KEY) {
    return new PortfolioConflictError('PORTFOLIO_ALREADY_ENABLED');
  }
  return undefined;
}

/** Relanza `error` traducido si es de las carteras; si no, tal cual. */
export function rethrowPortfolioError(error: unknown): never {
  throw portfolioHttpError(error) ?? error;
}
