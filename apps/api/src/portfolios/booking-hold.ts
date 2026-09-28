import { ConflictException } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';

/**
 * Retención de cartera ANTES de reservar con un proveedor que cobra al crédito de una cuenta
 * (docs/tbo/08 RF-23; D-TBO-21 A). Las reglas son funciones puras; `PortfoliosService` las ejecuta
 * dentro de la transacción que bloquea la cartera.
 *
 * Por qué hay dos controles:
 *
 * - **La cartera** (`agency_portfolios`): saldo más cupo de crédito de la agencia que vende. Es la
 *   retención que ya existía, ahora sobre la orden abierta y no sobre una confirmada.
 * - **El crédito interno** (`tenants.credit_limit`), sólo si la cuenta del proveedor no es de quien
 *   vende. El proveedor ve UNA cuenta aunque la hereden muchas agencias (03 §7.4): sin un tope por
 *   agencia, una sola puede agotar el crédito de su consolidador. La agencia edita el cupo de su
 *   cartera (`PATCH /portfolios/credit-limit`), no este límite; por eso el cupo efectivo es el
 *   MENOR de los dos.
 */

/** Lo que la retención tiene que saber de la cuenta con que se va a reservar. */
export interface BookingHoldPolicy {
  /**
   * La cuenta del proveedor no es de la agencia que vende: la heredó de un ancestro o es la de la
   * plataforma. Con `true`, el crédito interno de la agencia acota lo que puede deber.
   */
  readonly inheritedAccount: boolean;
}

/** Motivos de rechazo, en el vocabulario que la web lee (`reason`). */
export type BookingHoldRejection =
  | 'PORTFOLIO_INACTIVE'
  | 'PORTFOLIO_CURRENCY_MISMATCH'
  | 'INTERNAL_CREDIT_INSUFFICIENT'
  | 'PORTFOLIO_FUNDS_INSUFFICIENT';

export interface BookingHoldFacts {
  /** Precio de venta de la reserva, entero positivo en unidades menores. */
  readonly amount: Money;
  readonly portfolio: {
    readonly balanceMinor: number;
    readonly creditLimitMinor: number;
    /** `null`: la cartera tiene una moneda inválida. */
    readonly currency: string | null;
    readonly status: string;
  };
  /** Sólo con cuenta heredada. `currency: null` = el tenant no tiene una moneda válida. */
  readonly internalCredit?: {
    readonly limitMinor: number;
    readonly currency: string | null;
  };
}

export type BookingHoldDecision =
  | {
      readonly ok: true;
      /** Cupo de crédito con que se evalúa el débito: el de la cartera o el interno, el menor. */
      readonly creditMinor: number;
    }
  | { readonly ok: false; readonly reason: BookingHoldRejection };

/** Un cupo negativo o corrupto no da crédito: falla cerrado. */
function credit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * ¿Se puede retener el precio de venta? Primero lo que no depende del monto (cartera activa y en la
 * moneda de la reserva), después el cupo.
 *
 * El crédito interno está en la moneda del tenant: si no es la de la reserva no se convierte, vale
 * cero y sólo cuenta el saldo. Cuando el tope que no alcanza es el interno se dice así, aunque la
 * cartera tampoco alcance: subir el cupo de la cartera no lo resolvería, y es la agencia la que
 * tiene que pedirle crédito a su red.
 */
export function decideBookingHold(facts: BookingHoldFacts): BookingHoldDecision {
  const { amount, portfolio } = facts;
  if (portfolio.status !== 'active') return { ok: false, reason: 'PORTFOLIO_INACTIVE' };
  if (portfolio.currency === null || portfolio.currency !== amount.currency) {
    return { ok: false, reason: 'PORTFOLIO_CURRENCY_MISMATCH' };
  }

  const portfolioCredit = credit(portfolio.creditLimitMinor);
  if (facts.internalCredit === undefined) {
    return portfolio.balanceMinor + portfolioCredit >= amount.amountMinor
      ? { ok: true, creditMinor: portfolioCredit }
      : { ok: false, reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' };
  }

  const internal =
    facts.internalCredit.currency === amount.currency ? credit(facts.internalCredit.limitMinor) : 0;
  const creditMinor = Math.min(portfolioCredit, internal);
  if (portfolio.balanceMinor + creditMinor >= amount.amountMinor) return { ok: true, creditMinor };
  return {
    ok: false,
    reason:
      internal <= portfolioCredit ? 'INTERNAL_CREDIT_INSUFFICIENT' : 'PORTFOLIO_FUNDS_INSUFFICIENT',
  };
}

/**
 * `tenants.credit_limit` (unidades MAYORES, NUMERIC(14,2)) en unidades menores, con la misma regla
 * de dos decimales que `Money`. Lo que no es un número finito y no negativo vale cero.
 */
export function internalCreditMinor(creditLimit: unknown): number {
  const text = typeof creditLimit === 'number' ? String(creditLimit) : creditLimit;
  if (typeof text !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(text.trim())) return 0;
  const [whole = '0', cents = ''] = text.trim().split('.');
  return Number(whole) * 100 + Number(cents.padEnd(2, '0'));
}

interface RejectionContext {
  readonly amountCurrency: string;
  readonly portfolioCurrency: string | null;
}

const MESSAGES: Readonly<Record<BookingHoldRejection, (ctx: RejectionContext) => string>> = {
  PORTFOLIO_INACTIVE: () =>
    'La cartera de la agencia no está activa, así que no se puede retener el saldo para reservar. Pedile a tu administrador que la revise.',
  PORTFOLIO_CURRENCY_MISMATCH: (ctx) =>
    `Esta reserva se cobra en ${ctx.amountCurrency} y la cartera de la agencia está en ${
      ctx.portfolioCurrency ?? 'otra moneda'
    }: sin una cartera en esa moneda no se puede retener el saldo para reservar.`,
  INTERNAL_CREDIT_INSUFFICIENT: () =>
    'La agencia no tiene saldo en la cartera ni crédito interno suficiente para reservar con la cuenta de su red. Cargá saldo en Carteras o pedile a tu consolidador que te asigne crédito.',
  PORTFOLIO_FUNDS_INSUFFICIENT: () =>
    'La cartera de la agencia no tiene saldo ni crédito suficiente para esta reserva. Cargá saldo en Carteras para reservar.',
};

/**
 * La cartera no puede retener el precio de venta: no se reserva y no se llama al proveedor (RF-23
 * CA-1). 409 como el `300` del proveedor, con el motivo para que la web ofrezca cargar saldo.
 *
 * Nunca lleva el saldo ni el cupo: la agencia los ve en Carteras, y el de la cuenta del proveedor,
 * que es de su consolidador, no lo conocemos.
 */
export class BookingHoldRejectedError extends ConflictException {
  constructor(
    readonly reason: BookingHoldRejection,
    ctx: RejectionContext,
  ) {
    super(MESSAGES[reason](ctx));
    this.name = 'BookingHoldRejectedError';
  }
}
