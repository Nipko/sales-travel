import type { CancelAllowance } from './booking/types';

/**
 * Despegar respondió, en el paso 1 de la cancelación, que esta reserva no se puede cancelar
 * (`DISALLOWED`) o no supo decirlo (`UNKNOWN`). No se pide la cotización ni se cancela: el flujo
 * no se puede saltar (docs/despegar/01 § Cancelación).
 */
export class DespegarCancelNotAllowedError extends Error {
  constructor(readonly allowance: CancelAllowance) {
    super(
      `Despegar no permite cancelar el producto (${allowance.allowance}${
        allowance.disallowedReason ? `: ${allowance.disallowedReason}` : ''
      })`,
    );
    this.name = 'DespegarCancelNotAllowedError';
  }
}

/** `/reservations` no devolvió el producto de esa reserva: no hay con qué cancelar. */
export class DespegarReservationNotFoundError extends Error {
  constructor() {
    super('Despegar no devolvió el producto de la reserva en /reservations');
    this.name = 'DespegarReservationNotFoundError';
  }
}
