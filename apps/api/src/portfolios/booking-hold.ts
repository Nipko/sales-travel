import { ConflictException } from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';

/**
 * Retención de cartera ANTES de reservar con un proveedor que cobra al crédito de una cuenta
 * (docs/tbo/08 RF-23; D-TBO-21 A), y en cascada por la red de financiación desde 0060 ("opción 1"
 * del founder, 2026-09-29; docs/platform/12 §12).
 *
 * La regla vive en la base (`wallet_hold_retain`, `wallet_hold_preview`): el nodo que vende retiene
 * el precio de venta en su cartera de la moneda de la tarifa, y cada nivel que lo financia hasta el
 * dueño de la credencial retiene su costo en la suya. Con la cuenta propia del nodo (O = T) no se
 * retiene nada ni hace falta cartera (decisión del founder del 2026-09-30, opción B). Acá quedan el
 * vocabulario que la web lee (`reason`), los textos que ve el vendedor y los errores HTTP.
 *
 * Los textos de la red hablan sólo de "tu red" y de "quien te financia": el vendedor no ve qué nivel
 * falló, ni montos, ni nombres de sus ancestros.
 */

/** Motivos de rechazo, en el vocabulario que la web lee (`reason`). */
export type BookingHoldRejection =
  | 'PORTFOLIO_CURRENCY_NOT_ENABLED'
  | 'PORTFOLIO_INACTIVE'
  | 'PORTFOLIO_FUNDS_INSUFFICIENT'
  | 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED'
  | 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE'
  | 'PORTFOLIO_NETWORK_COST_UNAVAILABLE';

const NETWORK_REJECTIONS: ReadonlySet<BookingHoldRejection> = new Set([
  'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED',
  'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
  'PORTFOLIO_NETWORK_COST_UNAVAILABLE',
]);

/** ¿El rechazo es de un nivel de la red y no de la cartera propia? */
export function isNetworkRejection(reason: BookingHoldRejection): boolean {
  return NETWORK_REJECTIONS.has(reason);
}

/** Las verticales que retienen o pueden anticipar una retención. */
export type BookingHoldVertical = 'hotels' | 'flights' | 'cars';

/**
 * Lo que el aviso previo (PreBook, verificación antes de C2) sabe de una venta antes de que exista
 * la orden. La reserva no lo usa: la base lee todo de la orden.
 */
export interface BookingHoldQuote {
  /** Precio de venta, entero positivo en unidades menores. */
  readonly amount: Money;
  /**
   * El neto del proveedor en la moneda de `amount`, el mismo que la base leerá de la orden
   * (`selected_offer.pricing.netMinor`). `null` si no se conoce: con red por encima, el costo de
   * esos niveles no se puede calcular y la retención se rechaza.
   */
  readonly netMinor: number | null;
  readonly vertical: BookingHoldVertical;
  readonly providerCode: string;
  /**
   * La cuenta de la bóveda con que se reservaría. `null` = no se sabe cuál: la base toma la que la
   * bóveda le resuelve al nodo para el proveedor, o la raíz con credenciales de entorno.
   */
  readonly providerAccountId: string | null;
}

/**
 * Lo que la retención le adelanta al vendedor ANTES de cargar huéspedes (el PreBook de un hotel):
 * si su cartera y la de cada nivel de su red la cubrirían ahora. Es una lectura sin bloqueo, así que
 * no promete nada: la reserva vuelve a decidir con las carteras bloqueadas. Nunca lleva saldos,
 * cupos ni qué nivel falló, por lo mismo que {@link BookingHoldRejectedError}.
 *
 * `own-account`: se reserva con la cuenta propia de la agencia en el proveedor, así que no se retiene
 * nada de ninguna cartera y no hay nada que avisar por la cartera.
 */
export type BookingHoldPreview =
  | { readonly status: 'ok'; readonly currency: string }
  | { readonly status: 'own-account'; readonly currency: string }
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
  PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED: (ctx) =>
    `Tu red todavía no opera en ${ctx.amountCurrency}, así que no se puede retener saldo para esta reserva. Pedile a quien te financia que lo habilite.`,
  PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE: (ctx) =>
    `Tu red no tiene cupo disponible en ${ctx.amountCurrency} para esta reserva. Pedile a quien te financia que lo revise.`,
  PORTFOLIO_NETWORK_COST_UNAVAILABLE: () =>
    'No se pudo calcular el costo de esta reserva para tu red, así que no se retuvo saldo. Avisale a quien te financia.',
};

/**
 * Lo que se le dice a quien pide retener una reserva hecha con la cuenta propia de la agencia
 * (`POST /portfolios/hold-booking`): no es un error, no hay nada que retener.
 */
export const OWN_PROVIDER_ACCOUNT_MESSAGE =
  'La reserva se hizo con la cuenta del proveedor de tu agencia: no se retiene saldo de ninguna cartera.';

/** Lo que ve el vendedor por un rechazo, el mismo texto en el aviso previo y en la reserva. */
export function bookingHoldMessage(reason: BookingHoldRejection, amountCurrency: string): string {
  return MESSAGES[reason]({ amountCurrency });
}

/**
 * Una cartera no puede retener la reserva, la propia o la de un nivel de la red: no se reserva y no
 * se llama al proveedor (RF-23 CA-1). 409 como el `300` del proveedor, con el motivo para que la web
 * lleve a Cartera B2B o a hablar con quien financia.
 *
 * Nunca lleva saldos ni cupos: la agencia ve los suyos en Cartera B2B, y los de su red no son suyos.
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

/**
 * Las carteras de la red siguieron bloqueadas por otras reservas después de los reintentos: no se
 * retuvo nada y el vendedor puede volver a intentar en unos segundos.
 */
export class PortfolioHoldBusyError extends ConflictException {
  readonly reason = 'PORTFOLIO_HOLD_BUSY';

  constructor() {
    super(
      'Tu red está procesando otras reservas en este momento y no se retuvo saldo. Probá de nuevo en unos segundos.',
    );
    this.name = 'PortfolioHoldBusyError';
  }
}

/**
 * Lo mismo del lado de la liberación: quien la pide ya cerró la reserva (el proveedor la canceló o
 * no la hizo), así que decir "no se retuvo" o "no se canceló" sería falso. Lo que falta es devolver
 * el saldo retenido, y repetir el pedido lo termina sin volver a tocar al proveedor.
 */
export class PortfolioReleaseBusyError extends ConflictException {
  readonly reason = 'PORTFOLIO_RELEASE_BUSY';

  constructor() {
    super(
      'Tu red está procesando otras reservas en este momento y todavía no se liberó el saldo retenido de esta reserva. El estado de la reserva no cambia por esto: probá de nuevo en unos segundos para terminar de liberarlo.',
    );
    this.name = 'PortfolioReleaseBusyError';
  }
}

/**
 * La cuenta del proveedor con que se cotizó ya no se resuelve para el nodo (se desactivó, dejó de
 * heredarse o cambió de dueño): sin saber quién paga al proveedor no se sabe hasta dónde retener.
 */
export class PortfolioHoldAccountChangedError extends ConflictException {
  readonly reason = 'PORTFOLIO_HOLD_ACCOUNT_CHANGED';

  constructor() {
    super(
      'La cuenta del proveedor con que se cotizó esta reserva ya no está activa en tu red, así que no se retuvo saldo. Volvé a buscar la tarifa.',
    );
    this.name = 'PortfolioHoldAccountChangedError';
  }
}

/**
 * La reserva figuró confirmada (la retención pasó a cargo) y después quedó como no realizada, o el
 * libro tiene una liberación que no casa: no se mueve saldo solo, lo concilia una persona.
 */
export class WalletHoldStateConflictError extends ConflictException {
  readonly reason = 'PORTFOLIO_HOLD_STATE_CONFLICT';

  constructor() {
    super(
      'La reserva figuró confirmada antes de cerrarse como no realizada: su retención quedó como cargo y requiere conciliación manual.',
    );
    this.name = 'WalletHoldStateConflictError';
  }
}
