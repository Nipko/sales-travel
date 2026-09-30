import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import {
  BookingHoldRejectedError,
  PortfolioHoldAccountChangedError,
  type BookingHoldRejection,
} from './booking-hold.js';

/**
 * Los errores de las carteras, con motivo máquina (`reason`) para que la web decida qué ofrecer
 * sin interpretar el texto, y la traducción de los que lanza la base (db/migrations/0052 y 0060).
 *
 * - `STW01`: la operación viola una regla de las carteras o de los depósitos informados → 409.
 *   Las reglas `hold_*` de 0060 (el estado de la reserva o de su retención) las traduce
 *   {@link walletHoldHttpError}, con las excepciones que la API daba antes de 0060.
 * - `STW02` (0060): la retención se rechaza porque una cartera, la propia o la de un nivel de la
 *   red, no puede cubrir la reserva → 409 {@link BookingHoldRejectedError} con su motivo.
 * - `42501` con la regla `portfolio_financier_required`, `deposit_report_resolver` o
 *   `portfolio_entry_author` → 403. Cualquier otro 42501 (la RLS, un REVOKE, las guardas de 0060
 *   `wallet_hold_*` y `*_reserved`, que son errores de programación) no es de acá: sale como 500.
 *
 * Como en `tenant-hierarchy-errors.ts`, el texto que ve el usuario sale de las tablas de abajo y no
 * del de la base, que trae ids en DETAIL: una regla que la tabla no conoce sale con un mensaje
 * genérico.
 */
export const PORTFOLIO_RULE_SQLSTATE = 'STW01';
/** 0060: la retención se rechaza; no se escribió nada y el proveedor no se llamó. */
export const WALLET_HOLD_REJECTED_SQLSTATE = 'STW02';
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

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function pgFields(error: unknown): { code: unknown; rule: string | undefined } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as PgErrorFields;
  return { code, rule: typeof constraint === 'string' ? constraint : undefined };
}

/** El motivo que ve el vendedor de cada regla STW02 de 0060. */
const HOLD_REJECTIONS: ReadonlyMap<string, BookingHoldRejection> = new Map([
  ['hold_currency_not_enabled', 'PORTFOLIO_CURRENCY_NOT_ENABLED'],
  ['hold_inactive', 'PORTFOLIO_INACTIVE'],
  ['hold_funds_insufficient', 'PORTFOLIO_FUNDS_INSUFFICIENT'],
  ['network_currency_not_enabled', 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED'],
  ['network_funds_unavailable', 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE'],
  ['network_cost_unavailable', 'PORTFOLIO_NETWORK_COST_UNAVAILABLE'],
]);

/** El motivo de una regla STW02 (también la devuelve `wallet_hold_preview`), o `undefined`. */
export function holdRejectionOfRule(
  rule: string | null | undefined,
): BookingHoldRejection | undefined {
  return rule === null || rule === undefined ? undefined : HOLD_REJECTIONS.get(rule);
}

/** Las reglas STW01 de 0060: el estado de la reserva o de su retención. */
export type WalletHoldStateRule =
  | 'hold_order_not_found'
  | 'hold_order_not_holdable'
  | 'hold_already_exists'
  | 'hold_amount_invalid'
  | 'hold_owner_unresolvable'
  | 'hold_release_order_open'
  | 'hold_release_out_of_range';

const HOLD_STATE_RULES: ReadonlySet<string> = new Set<WalletHoldStateRule>([
  'hold_order_not_found',
  'hold_order_not_holdable',
  'hold_already_exists',
  'hold_amount_invalid',
  'hold_owner_unresolvable',
  'hold_release_order_open',
  'hold_release_out_of_range',
]);

/** La regla STW01 de 0060 de un error de la base, o `undefined` si es otra cosa. */
export function walletHoldStateRule(error: unknown): WalletHoldStateRule | undefined {
  const fields = pgFields(error);
  if (fields?.code !== PORTFOLIO_RULE_SQLSTATE || fields.rule === undefined) return undefined;
  return HOLD_STATE_RULES.has(fields.rule) ? (fields.rule as WalletHoldStateRule) : undefined;
}

/** Cuando la moneda de la reserva no se conoce (la red de seguridad del filtro global). */
const UNKNOWN_CURRENCY = 'la moneda de la tarifa';

export interface WalletHoldErrorContext {
  /** La moneda de la reserva, para el texto del rechazo. */
  readonly currency?: string;
  /** El texto de `hold_order_not_holdable` de cada vía (intent abierto o reserva confirmada). */
  readonly notHoldableMessage?: string;
}

/**
 * La excepción HTTP de un error de las retenciones de 0060, o `undefined` si el error es otra cosa.
 * Los 42501 de 0060 (sin tenant, un actor fuera de la red, un asiento o un saldo escritos fuera de
 * las funciones) no se traducen: son errores de programación y salen como 500 con su log.
 */
export function walletHoldHttpError(
  error: unknown,
  ctx: WalletHoldErrorContext = {},
): HttpException | undefined {
  const fields = pgFields(error);
  if (fields === undefined) return undefined;

  if (fields.code === WALLET_HOLD_REJECTED_SQLSTATE) {
    const reason = holdRejectionOfRule(fields.rule);
    return reason === undefined
      ? new PortfolioConflictError('PORTFOLIO_RULE_VIOLATION')
      : new BookingHoldRejectedError(reason, { amountCurrency: ctx.currency ?? UNKNOWN_CURRENCY });
  }

  switch (walletHoldStateRule(error)) {
    case 'hold_order_not_found':
      return new BadRequestException(
        'No se encontró la reserva. No se modificó el saldo de la cartera.',
      );
    case 'hold_order_not_holdable':
      return new BadRequestException(
        ctx.notHoldableMessage ??
          'La reserva no está en un estado que pueda retener saldo de cartera.',
      );
    case 'hold_already_exists':
      return new ConflictException(
        'Esta reserva ya tiene una retención activa. No se realizó un segundo débito.',
      );
    case 'hold_amount_invalid':
      return new BadRequestException(
        'La reserva no tiene un total y una moneda válidos para crear la retención.',
      );
    case 'hold_owner_unresolvable':
      return new PortfolioHoldAccountChangedError();
    case 'hold_release_order_open':
      return new ConflictException(
        'La reserva no está en el estado que la liberación exige: su retención de saldo se mantiene.',
      );
    case 'hold_release_out_of_range':
      return new PortfolioConflictError('PORTFOLIO_BALANCE_OUT_OF_RANGE');
    case undefined:
      return undefined;
  }
}

/**
 * La excepción HTTP de un error de las carteras que lanzó la base, o `undefined` si el error es
 * otra cosa (y sigue su camino). Las reglas de las retenciones de 0060 no son de acá: las traduce
 * {@link walletHoldHttpError}.
 */
export function portfolioHttpError(
  error: unknown,
): PortfolioConflictError | PortfolioForbiddenError | undefined {
  const fields = pgFields(error);
  if (fields === undefined) return undefined;
  const { code, rule } = fields;
  if (code === PORTFOLIO_RULE_SQLSTATE) {
    if (rule !== undefined && HOLD_STATE_RULES.has(rule)) return undefined;
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

/** Relanza `error` traducido si es de las carteras o de sus retenciones; si no, tal cual. */
export function rethrowPortfolioError(error: unknown): never {
  throw walletHoldHttpError(error) ?? portfolioHttpError(error) ?? error;
}
