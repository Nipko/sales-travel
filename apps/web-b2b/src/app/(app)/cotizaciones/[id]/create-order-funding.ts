import {
  NETWORK_DETAIL,
  PORTFOLIO_TITLES,
  isNetworkFundingReason,
} from '../../hoteles/checkout/_components/funding-view';

/*
 * La cartera en la reserva de un vuelo que liquida la red (SAB-10), sin React. El API retiene la
 * cartera de la agencia, y la de cada nivel de la red que la financia, ANTES de reservar, como en
 * hoteles: si no alcanza, responde 409 con el motivo (`reason`) y no le pregunta nada a la
 * aerolínea. Los títulos y el criterio son los del checkout de hoteles (`funding-view.ts`): un
 * motivo de la cartera propia lleva a Cartera B2B y uno de la red, a hablar con quien te financia.
 */

/** Qué se le ofrece al vendedor junto al aviso. */
export type CreateOrderFundingAction =
  /** Su cartera: Cartera B2B (informar un depósito) o pedir la moneda o el cupo. */
  | 'portfolios'
  /** Un nivel de su red: lo resuelve quien lo financia, fuera de este panel. */
  | 'financier'
  /** Las carteras de la red estaban ocupadas: se vuelve a reservar en unos segundos. */
  | 'retry'
  /** La cuenta del proveedor con que se cotizó ya no está activa: hay que volver a buscar. */
  | 'research';

export interface CreateOrderFundingView {
  readonly title: string;
  /** El texto del API, ya en el idioma del vendedor; sin él, uno fijo. */
  readonly detail: string;
  readonly action: CreateOrderFundingAction;
}

const MAX_MESSAGE = 500;
const OWN_DETAIL = 'Revisa la cartera de la agencia en Cartera B2B.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apiMessage(body: Record<string, unknown>): string | undefined {
  const message = body['message'];
  return typeof message === 'string' && message.trim().length > 0 && message.length <= MAX_MESSAGE
    ? message.trim()
    : undefined;
}

/**
 * El aviso de cartera de una reserva rechazada, o `undefined` si el rechazo es otra cosa. Sólo un
 * 409 con un motivo de cartera conocido: el resto sigue el camino de siempre.
 */
export function createOrderFundingView(
  status: number,
  body: unknown,
): CreateOrderFundingView | undefined {
  if (status !== 409 || !isRecord(body)) return undefined;
  const reason = body['reason'];
  if (typeof reason !== 'string') return undefined;
  const message = apiMessage(body);

  if (reason === 'PORTFOLIO_HOLD_BUSY') {
    return {
      title: 'Las carteras están ocupadas con otras reservas.',
      detail: message ?? 'No se retuvo saldo. Prueba de nuevo en unos segundos.',
      action: 'retry',
    };
  }
  if (reason === 'PORTFOLIO_HOLD_ACCOUNT_CHANGED') {
    return {
      title: 'La cuenta del proveedor cambió.',
      detail: message ?? 'Vuelve a buscar la tarifa para reservar con la cuenta vigente.',
      action: 'research',
    };
  }
  const title = PORTFOLIO_TITLES[reason];
  if (title === undefined) return undefined;
  if (isNetworkFundingReason(reason)) {
    return { title, detail: message ?? NETWORK_DETAIL, action: 'financier' };
  }
  return { title, detail: message ?? OWN_DETAIL, action: 'portfolios' };
}
