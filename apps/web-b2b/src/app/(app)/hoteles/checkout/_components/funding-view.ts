/*
 * La cartera de la agencia en el checkout de hoteles (RF-23), sin React: el aviso del PreBook, para
 * que el vendedor no cargue huéspedes de una reserva que se va a rechazar, y el título de los
 * rechazos del Book. La regla la decide el API —la cartera de la moneda de la tarifa, activa, con
 * saldo más el cupo que fija quien financia, y desde 0060 también la de cada nivel de su red hasta
 * el dueño de la cuenta del proveedor—; acá sólo se lee su motivo, y nunca hay saldo ni cupo que
 * mostrar: la agencia ve los suyos en Cartera B2B, y los de su red no son suyos.
 */

export const PORTFOLIOS_HREF = '/carteras';
export const PORTFOLIOS_LINK_LABEL = 'Ir a Cartera B2B';

/**
 * Los motivos de un nivel de la red (0060). El vendedor no los resuelve en su Cartera B2B: los
 * resuelve quien lo financia, así que no llevan el enlace.
 */
const NETWORK_REASONS: ReadonlySet<string> = new Set([
  'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED',
  'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
  'PORTFOLIO_NETWORK_COST_UNAVAILABLE',
]);

export function isNetworkFundingReason(reason: string | undefined): boolean {
  return reason !== undefined && NETWORK_REASONS.has(reason);
}

/**
 * Los motivos de la cartera, con el título que va arriba del texto del API. Los de la red nombran
 * lo que financia al vendedor, hacia arriba: "tu red" en Cartera B2B son las agencias que el nodo
 * financia, hacia abajo, y el texto del API ya dice "tu red" (no se repite en el título).
 */
export const PORTFOLIO_TITLES: Readonly<Record<string, string>> = {
  PORTFOLIO_CURRENCY_NOT_ENABLED: 'No se puede reservar en esta moneda.',
  PORTFOLIO_INACTIVE: 'La cartera de la agencia está suspendida.',
  PORTFOLIO_FUNDS_INSUFFICIENT: 'Falta saldo para esta reserva.',
  PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED: 'La red que te financia no opera en esta moneda.',
  PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE: 'La red que te financia no cubre esta reserva.',
  PORTFOLIO_NETWORK_COST_UNAVAILABLE: 'No se pudo calcular el costo para quien te financia.',
};

const GENERIC_TITLE = 'La cartera de la agencia no cubre esta reserva.';
const GENERIC_DETAIL = 'Revisá la cartera de la agencia en Cartera B2B.';
/** Sin el texto del API, lo que el vendedor puede hacer con un motivo de la red. */
export const NETWORK_DETAIL = 'Hablá con quien te financia antes de volver a intentarlo.';

/** Lo que el PreBook dice de la cartera. Sin él, no se sabe y decide el Book. */
export type PrebookFunding =
  | { readonly status: 'ok' }
  | {
      readonly status: 'blocked';
      /** Motivo máquina (`PORTFOLIO_CURRENCY_NOT_ENABLED`…), o `undefined` si no vino uno válido. */
      readonly reason?: string;
      /** Ya en el idioma del vendedor: lo escribe el API. */
      readonly message: string;
    };

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_MESSAGE = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * El aviso de cartera del PreBook, o `undefined` si no vino o no se entiende: entonces no se frena
 * nada acá, porque el Book decide igual con la cartera bloqueada. Un `blocked` sin motivo o sin
 * texto sigue siendo un bloqueo, con el texto genérico.
 */
export function parseFunding(value: unknown): PrebookFunding | undefined {
  if (!isRecord(value)) return undefined;
  if (value['status'] === 'ok') return { status: 'ok' };
  if (value['status'] !== 'blocked') return undefined;
  const raw = value['reason'];
  const reason = typeof raw === 'string' && CODE_RE.test(raw) ? raw : undefined;
  const message = value['message'];
  return {
    status: 'blocked',
    ...(reason === undefined ? {} : { reason }),
    message:
      typeof message === 'string' && message.trim().length > 0 && message.length <= MAX_MESSAGE
        ? message.trim()
        : isNetworkFundingReason(reason)
          ? NETWORK_DETAIL
          : GENERIC_DETAIL,
  };
}

/**
 * Qué se le ofrece al vendedor junto al aviso: su Cartera B2B, si el motivo es de su cartera, o
 * nada más que el texto si es de su red (lo resuelve quien lo financia, fuera de este panel).
 */
export type FundingAction = 'portfolios' | 'financier';

export interface FundingNoticeView {
  readonly title: string;
  readonly detail: string;
  readonly action: FundingAction;
}

/** El aviso arriba de la tarifa, o `undefined` si la cartera la cubre o no se sabe. */
export function fundingNotice(funding: PrebookFunding | undefined): FundingNoticeView | undefined {
  if (funding?.status !== 'blocked') return undefined;
  return {
    title:
      (funding.reason === undefined ? undefined : PORTFOLIO_TITLES[funding.reason]) ??
      GENERIC_TITLE,
    detail: funding.message,
    action: isNetworkFundingReason(funding.reason) ? 'financier' : 'portfolios',
  };
}

/** El motivo junto al botón de seguir cuando la cartera no cubre la tarifa. */
export const FUNDING_GATE_REASON =
  'Resolvé la cartera de la agencia antes de cargar los huéspedes: esta reserva se rechazaría.';

/** El mismo motivo cuando lo que no cubre es un nivel de la red, no la cartera de la agencia. */
export const NETWORK_FUNDING_GATE_REASON =
  'Hablá con quien te financia antes de cargar los huéspedes: esta reserva se rechazaría.';

export function fundingGateReason(
  funding: PrebookFunding & { readonly status: 'blocked' },
): string {
  return isNetworkFundingReason(funding.reason) ? NETWORK_FUNDING_GATE_REASON : FUNDING_GATE_REASON;
}
