import type { AgencyWallets } from '../../../../lib/wallets';

/*
 * El aviso temprano de cartera en la búsqueda de hoteles: una reserva se retiene en la cartera de
 * la agencia en la MONEDA DE LA TARIFA (decisión del founder del 2026-09-29), así que si la agencia
 * no tiene cartera activa en la moneda elegida, el vendedor lo sabe antes de elegir un hotel y no
 * al confirmar. No bloquea buscar ni cotizar: sólo avisa. El PreBook y el Book deciden igual.
 */

/** Las monedas de las carteras de la agencia, para el aviso. Sin saldo ni cupo: no hacen falta. */
export interface SearchWallets {
  /** Monedas con cartera. */
  readonly enabled: readonly string[];
  /** Monedas con cartera activa: las únicas en que se puede reservar. */
  readonly operating: readonly string[];
  /** Monedas con la cartera suspendida por quien financia. */
  readonly suspended: readonly string[];
  /** A quién pedirle una moneda. `null`: lo gestiona Planetour. */
  readonly financierName: string | null;
}

export function searchWalletsOf(wallets: AgencyWallets): SearchWallets {
  const withStatus = (status: string) =>
    wallets.portfolios.filter((w) => w.status === status).map((w) => w.currency);
  return {
    enabled: wallets.portfolios.map((w) => w.currency),
    operating: withStatus('active'),
    suspended: withStatus('suspended'),
    financierName: wallets.financier?.name ?? null,
  };
}

/**
 * El aviso bajo el selector de moneda, o `undefined` si la cartera de esa moneda opera o si no se
 * sabe (carteras que no se pudieron leer, moneda todavía sin elegir).
 */
export function searchWalletNotice(
  wallets: SearchWallets | null | undefined,
  currency: string,
): string | undefined {
  if (wallets === null || wallets === undefined || currency === '') return undefined;
  const who = wallets.financierName ?? 'Planetour';
  if (!wallets.enabled.includes(currency)) {
    return `Tu agencia no tiene cartera en ${currency}: podés cotizar, pero no reservar. Pedile a ${who} que la habilite.`;
  }
  if (wallets.operating.includes(currency)) return undefined;
  // Otro estado que activa (una cartera sobre el cupo de los datos viejos) tampoco retiene.
  const state = wallets.suspended.includes(currency) ? 'está suspendida' : 'no está activa';
  return `La cartera ${currency} de tu agencia ${state}: podés cotizar, pero no reservar hasta que ${who} la reactive.`;
}
