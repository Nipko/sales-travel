import type { Offer } from '../app/(app)/cotizaciones/actions';

/**
 * Cómo se lee una política de cambio o de reembolso, con los CINCO estados que importan.
 *
 * Existe por el mismo motivo que `baggage.ts`: la tarjeta y el PDF pintaban un ✓ para «se
 * permite», y LATAM LIGHT se permite CON multa. Un «Reembolsable» a secas en el PDF es una
 * promesa de devolver el dinero entero que la aerolínea no va a cumplir. Y un dato que el
 * proveedor no mandó tampoco es un «No».
 */
export type PolicyState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'no' }
  /** Permitido y el proveedor informó cargo 0. */
  | { readonly kind: 'free' }
  /** Permitido, pero el proveedor no informó el cargo: no se puede prometer que sea gratis. */
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'fee';
      readonly fee: { readonly amountMinor: number; readonly currency: string };
    };

export type PolicyKind = 'change' | 'refund';

export function policyState(policies: Offer['policies'], which: PolicyKind): PolicyState {
  const allowed = which === 'change' ? policies?.changeable : policies?.refundable;
  if (allowed === undefined) return { kind: 'unknown' };
  if (!allowed) return { kind: 'no' };
  const fee = which === 'change' ? policies?.changeFee : policies?.refundFee;
  if (fee === undefined) return { kind: 'allowed' };
  if (fee.amountMinor === 0) return { kind: 'free' };
  return { kind: 'fee', fee };
}

type FormatMoney = (amountMinor: number, currency: string) => string;

const TEXTOS: Record<PolicyKind, Record<Exclude<PolicyState['kind'], 'fee'>, string>> = {
  change: {
    unknown: 'No informado',
    no: 'No permitidos',
    free: 'Permitidos sin cargo',
    allowed: 'Permitidos, cargo a confirmar',
  },
  refund: {
    unknown: 'No informado',
    no: 'No reembolsable',
    free: 'Reembolsable sin cargo',
    allowed: 'Reembolsable, cargo a confirmar',
  },
};

/**
 * El texto para el vendedor y para el PDF. El cargo es POR PASAJERO: Sabre lo informa por
 * ticket (`bargain-finder-max-v5.yml:8620`), y la cotización puede llevar varios.
 */
export function describePolicy(
  state: PolicyState,
  which: PolicyKind,
  formatMoney: FormatMoney,
): string {
  if (state.kind !== 'fee') return TEXTOS[which][state.kind];
  const monto = formatMoney(state.fee.amountMinor, state.fee.currency);
  return which === 'change'
    ? `Permitidos con cargo de ${monto} por pasajero`
    : `Reembolsable con cargo de ${monto} por pasajero`;
}

/** Lo corto que cabe en la etiqueta de la tarjeta, junto al icono. */
export function policyBadge(state: PolicyState, formatMoney: FormatMoney): string | undefined {
  if (state.kind === 'unknown') return 'No informado';
  if (state.kind === 'free') return 'Sin cargo';
  if (state.kind === 'allowed') return 'Cargo a confirmar';
  if (state.kind === 'fee')
    return `Cargo ${formatMoney(state.fee.amountMinor, state.fee.currency)}`;
  return undefined;
}
