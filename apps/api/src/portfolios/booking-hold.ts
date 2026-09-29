import { ConflictException } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';

/**
 * Retención de cartera ANTES de reservar con un proveedor que cobra al crédito de una cuenta
 * (docs/tbo/08 RF-23; D-TBO-21 A). Las reglas son funciones puras; `PortfoliosService` las ejecuta
 * dentro de la transacción que bloquea la cartera.
 *
 * El tope es UNO: el saldo más el cupo de la cartera de la agencia en la moneda de la tarifa. Ese
 * cupo lo fija quien la financia (su consolidador, su agencia o Planetour; db/migrations/0052), no
 * la agencia, así que también acota lo que una agencia puede deber con la cuenta de proveedor que
 * hereda de su red. Hasta 0053 había un segundo tope, el crédito interno del tenant
 * (`tenants.credit_limit`), que pasó al cupo de la cartera y ya no se lee.
 *
 * Una cartera por moneda: la retención usa la de la moneda de la tarifa y nunca convierte. Sin
 * cartera en esa moneda no se reserva, y no se abre una implícita.
 */

/** Motivos de rechazo, en el vocabulario que la web lee (`reason`). */
export type BookingHoldRejection =
  | 'PORTFOLIO_CURRENCY_NOT_ENABLED'
  | 'PORTFOLIO_INACTIVE'
  | 'PORTFOLIO_FUNDS_INSUFFICIENT';

export interface BookingHoldFacts {
  /** Precio de venta de la reserva, entero positivo en unidades menores. */
  readonly amount: Money;
  /** La cartera de la agencia en la moneda de la reserva; `null` si no tiene. */
  readonly portfolio: {
    readonly balanceMinor: number;
    readonly creditLimitMinor: number;
    readonly currency: string;
    readonly status: string;
  } | null;
}

export type BookingHoldDecision =
  | {
      readonly ok: true;
      /** Cupo de crédito con que se evalúa el débito. */
      readonly creditMinor: number;
    }
  | { readonly ok: false; readonly reason: BookingHoldRejection };

/** Un cupo negativo o corrupto no da crédito: falla cerrado. */
function credit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * ¿Se puede retener el precio de venta? Primero lo que no depende del monto (hay cartera en esa
 * moneda y está activa), después el saldo más el cupo. Una cartera en otra moneda cuenta como
 * ninguna: la retención no convierte.
 */
export function decideBookingHold(facts: BookingHoldFacts): BookingHoldDecision {
  const { amount, portfolio } = facts;
  if (portfolio === null || portfolio.currency !== amount.currency) {
    return { ok: false, reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED' };
  }
  if (portfolio.status !== 'active') return { ok: false, reason: 'PORTFOLIO_INACTIVE' };

  const creditMinor = credit(portfolio.creditLimitMinor);
  return portfolio.balanceMinor + creditMinor >= amount.amountMinor
    ? { ok: true, creditMinor }
    : { ok: false, reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' };
}

/**
 * Lo que la retención le adelanta al vendedor ANTES de cargar huéspedes (el PreBook de un hotel):
 * si la cartera de la moneda de la tarifa la cubriría ahora. Es una lectura sin bloqueo, así que no
 * promete nada: la reserva vuelve a decidir con la cartera bloqueada. Nunca lleva el saldo ni el
 * cupo, por lo mismo que {@link BookingHoldRejectedError}.
 */
export type BookingHoldPreview =
  | { readonly status: 'ok'; readonly currency: string }
  | {
      readonly status: 'blocked';
      readonly currency: string;
      readonly reason: BookingHoldRejection;
      readonly message: string;
    };

interface RejectionContext {
  readonly amountCurrency: string;
}

const MESSAGES: Readonly<Record<BookingHoldRejection, (ctx: RejectionContext) => string>> = {
  PORTFOLIO_CURRENCY_NOT_ENABLED: (ctx) =>
    `La agencia no tiene cartera en ${ctx.amountCurrency}: pedile a quien te financia que la habilite.`,
  PORTFOLIO_INACTIVE: (ctx) =>
    `La cartera en ${ctx.amountCurrency} de la agencia está suspendida, así que no se puede retener el saldo para reservar. Pedile a quien te financia que la reactive.`,
  PORTFOLIO_FUNDS_INSUFFICIENT: (ctx) =>
    `La cartera en ${ctx.amountCurrency} de la agencia no tiene saldo ni cupo suficiente para esta reserva. Informá un depósito en Cartera B2B o pedile más cupo a quien te financia.`,
};

/** Lo que ve el vendedor por un rechazo, el mismo texto en el aviso previo y en la reserva. */
export function bookingHoldMessage(reason: BookingHoldRejection, amountCurrency: string): string {
  return MESSAGES[reason]({ amountCurrency });
}

/**
 * La cartera no puede retener el precio de venta: no se reserva y no se llama al proveedor (RF-23
 * CA-1). 409 como el `300` del proveedor, con el motivo para que la web lleve a Cartera B2B.
 *
 * Nunca lleva el saldo ni el cupo: la agencia los ve en Cartera B2B, y el de la cuenta del
 * proveedor, que es de su red, no lo conocemos.
 */
export class BookingHoldRejectedError extends ConflictException {
  constructor(
    readonly reason: BookingHoldRejection,
    ctx: RejectionContext,
  ) {
    super(bookingHoldMessage(reason, ctx.amountCurrency));
    this.name = 'BookingHoldRejectedError';
  }
}
