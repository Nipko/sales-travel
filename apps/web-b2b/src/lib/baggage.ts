import type { Offer } from '../app/(app)/cotizaciones/actions';

/**
 * Cómo se lee una franquicia de equipaje, distinguiendo los TRES estados.
 *
 * La distinción es el motivo entero de este módulo: **«no lo sabemos» no es «no lo incluye»**.
 * Sólo una de las dos es una promesa comercial, y una de ellas acaba impresa en el PDF que el
 * vendedor le manda al cliente final.
 *
 * Antes no hacía falta porque la forma canónica obligaba a declarar las tres piezas, así que un
 * proveedor que sólo informa la facturada —el carril ATPCO de Sabre, o sea el 100% de sus
 * ofertas— no publicaba ninguna. Ahora publica lo que sabe, y quien pinte esto tiene que saber
 * que un campo ausente NO es un cero.
 */
export type BaggageState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none' }
  | { readonly kind: 'included'; readonly qty: number; readonly weightKg?: number };

type Allowance = { qty: number; weightKg?: number } | undefined;

export function baggageState(allowance: Allowance): BaggageState {
  if (allowance === undefined) return { kind: 'unknown' };
  if (allowance.qty <= 0) return { kind: 'none' };
  return {
    kind: 'included',
    qty: allowance.qty,
    ...(allowance.weightKg === undefined ? {} : { weightKg: allowance.weightKg }),
  };
}

/**
 * El texto para el vendedor y para el PDF.
 *
 * «No informado» y no un guion suelto: el vendedor tiene que poder decirle al cliente por qué no
 * hay dato, y un `—` en una tabla se lee como «nada».
 */
export function describeBaggage(allowance: Allowance): string {
  const state = baggageState(allowance);
  if (state.kind === 'unknown') return 'No informado';
  if (state.kind === 'none') return 'No incluye';
  const piezas = `${state.qty} pieza${state.qty > 1 ? 's' : ''}`;
  return state.weightKg === undefined ? piezas : `${piezas} (${state.weightKg} kg)`;
}

/** ¿Hay algo que contar de esta oferta? Con las tres piezas ausentes, no hay bloque que pintar. */
export function hasAnyBaggageInfo(baggage: Offer['baggage']): boolean {
  if (baggage === undefined) return false;
  return (
    baggage.checked !== undefined ||
    baggage.carryOn !== undefined ||
    baggage.personalItem !== undefined
  );
}
