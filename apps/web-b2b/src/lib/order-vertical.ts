import { providerMetaFor } from './provider-display';

/*
 * De qué vertical es una orden, para las pantallas que listan órdenes de todas (Reservas, Carteras).
 *
 * La dice `searchCriteria.vertical`, que escribe el intent de cada vertical (docs/tbo/06 TP-62), y
 * no el código del proveedor: un proveedor de hoteles nuevo no obliga a tocar esta lista. Autos se
 * reconoce además por su adapter, porque sus órdenes anteriores al intent no llevan la marca.
 */

export type OrderVertical = 'flights' | 'hotels' | 'cars';

export interface OrderVerticalInput {
  readonly provider?: string | null;
  readonly searchCriteria?: unknown;
}

function verticalMark(searchCriteria: unknown): unknown {
  return typeof searchCriteria === 'object' && searchCriteria !== null
    ? (searchCriteria as { vertical?: unknown }).vertical
    : undefined;
}

export function orderVerticalOf(order: OrderVerticalInput): OrderVertical {
  const mark = verticalMark(order.searchCriteria);
  if (mark === 'hotels') return 'hotels';
  if (mark === 'cars' || order.provider === 'agent-cars') return 'cars';
  return 'flights';
}

export function isHotelOrder(order: OrderVerticalInput): boolean {
  return orderVerticalOf(order) === 'hotels';
}

export function isCarOrder(order: OrderVerticalInput): boolean {
  return orderVerticalOf(order) === 'cars';
}

const VERTICAL_LABELS: Readonly<Record<OrderVertical, string>> = {
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
};

export function orderVerticalLabel(vertical: OrderVertical): string {
  return VERTICAL_LABELS[vertical];
}

/**
 * "Hoteles (TBO Holidays)": la vertical y el nombre legible del proveedor (docs/tbo/06 TP-63), con
 * la misma ficha que el panel de proveedores. Un código sin ficha sale tal cual, como en vuelos.
 */
export function orderProviderLabel(order: OrderVerticalInput): string {
  const vertical = orderVerticalLabel(orderVerticalOf(order));
  const code = order.provider?.trim();
  return code ? `${vertical} (${providerMetaFor(code).name})` : vertical;
}
