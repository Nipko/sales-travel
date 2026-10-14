/*
 * El saldo retenido de una reserva al cancelarla o anular sus tiquetes (SAB-10), sin React.
 *
 * Una reserva de un proveedor que liquida la red (Sabre, con el tiquete en CASH o a crédito) retiene
 * la cartera de la agencia y la de cada nivel de la red que la financia, como un hotel. Cancelarla
 * libera el 100 % de lo retenido en todos los niveles, también si el proveedor cobra una penalidad:
 * esa la registra aparte quien financia cada nivel, con un ajuste de la cartera (decisión del
 * founder del 2026-09-30, docs/platform/12 §14.4). El aviso sale sólo cuando `/orders` dice que la
 * orden tiene una retención abierta: sin retención, exenta por la cuenta propia de la agencia o ya
 * liberada, no hay nada que liberar.
 */

/** La retención abierta de una orden, como la manda `/orders` (`walletHold`). */
export type OrderWalletHold = 'held' | 'captured';

/** `walletHold` de la orden, o `undefined` si no tiene una retención abierta (o no se entiende). */
export function walletHoldOf(value: unknown): OrderWalletHold | undefined {
  return value === 'held' || value === 'captured' ? value : undefined;
}

/** Lo que se lee al confirmar la cancelación o la anulación de una reserva con saldo retenido. */
export const WALLET_RELEASE_NOTE =
  'Esta reserva tiene saldo retenido en la cartera. Al cancelarla se libera el 100 % de lo retenido, también en la red que te financia. Si la aerolínea cobra una penalidad, quien te financia la registra aparte en la cartera.';

/** El aviso de la cartera para la confirmación, o `undefined` si no hay saldo retenido. */
export function walletReleaseNote(order: { readonly walletHold?: unknown }): string | undefined {
  return walletHoldOf(order.walletHold) === undefined ? undefined : WALLET_RELEASE_NOTE;
}
