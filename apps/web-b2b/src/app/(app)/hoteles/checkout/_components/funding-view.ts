/*
 * La cartera de la agencia en el checkout de hoteles (RF-23), sin React: el aviso del PreBook, para
 * que el vendedor no cargue huéspedes de una reserva que se va a rechazar, y el título de los
 * rechazos del Book. La regla la decide el API —la cartera de la moneda de la tarifa, activa, con
 * saldo más el cupo que fija quien financia—; acá sólo se lee su motivo, y nunca hay saldo ni cupo
 * que mostrar: la agencia los ve en Cartera B2B.
 */

export const PORTFOLIOS_HREF = '/carteras';
export const PORTFOLIOS_LINK_LABEL = 'Ir a Cartera B2B';

/** Los motivos de la cartera, con el título que va arriba del texto del API. */
export const PORTFOLIO_TITLES: Readonly<Record<string, string>> = {
  PORTFOLIO_CURRENCY_NOT_ENABLED: 'No se puede reservar en esta moneda.',
  PORTFOLIO_INACTIVE: 'La cartera de la agencia está suspendida.',
  PORTFOLIO_FUNDS_INSUFFICIENT: 'Falta saldo para esta reserva.',
};

const GENERIC_TITLE = 'La cartera de la agencia no cubre esta reserva.';
const GENERIC_DETAIL = 'Revisá la cartera de la agencia en Cartera B2B.';

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
  const reason = value['reason'];
  const message = value['message'];
  return {
    status: 'blocked',
    ...(typeof reason === 'string' && CODE_RE.test(reason) ? { reason } : {}),
    message:
      typeof message === 'string' && message.trim().length > 0 && message.length <= MAX_MESSAGE
        ? message.trim()
        : GENERIC_DETAIL,
  };
}

export interface FundingNoticeView {
  readonly title: string;
  readonly detail: string;
}

/** El aviso arriba de la tarifa, o `undefined` si la cartera la cubre o no se sabe. */
export function fundingNotice(funding: PrebookFunding | undefined): FundingNoticeView | undefined {
  if (funding?.status !== 'blocked') return undefined;
  return {
    title:
      (funding.reason === undefined ? undefined : PORTFOLIO_TITLES[funding.reason]) ??
      GENERIC_TITLE,
    detail: funding.message,
  };
}

/** El motivo junto al botón de seguir cuando la cartera no cubre la tarifa. */
export const FUNDING_GATE_REASON =
  'Resolvé la cartera de la agencia antes de cargar los huéspedes: esta reserva se rechazaría.';
