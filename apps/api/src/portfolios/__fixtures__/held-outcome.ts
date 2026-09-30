import type { BookingHoldOutcome } from '../portfolios.service.js';

/** La retención que se esperaba, o un error claro si la venta resultó con la cuenta propia. */
export function held(
  outcome: BookingHoldOutcome,
): Extract<BookingHoldOutcome, { readonly status: 'held' }> {
  if (outcome.status !== 'held') {
    throw new Error(`esperaba una retención en la cartera y fue ${outcome.status}`);
  }
  return outcome;
}
