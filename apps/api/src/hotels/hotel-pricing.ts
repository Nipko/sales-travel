import type { HotelRoompack, Money } from '@sales-travel/canonical';
import {
  applyCascade,
  applyProviderFloor,
  toTenantView,
  type ApplicableRule,
} from '../pricing/pricing.service.js';

/**
 * Precio de venta de UNA tarifa: el waterfall de la red y, encima, el piso del proveedor (RF-12).
 * `price.total` (el neto) NO se muta.
 *
 * El piso se aplica aunque el tenant no tenga reglas: sin él, el precio de venta sería el neto y
 * quedaría por debajo del mínimo que el proveedor permite. Una tarifa sin reglas NI piso —todas
 * las de Despegar en un tenant sin markup— sale como la mapeó el ACL, sin `pricing`.
 *
 * El piso llega en la moneda de `price.total`: lo exige el esquema neutral, que valida el ACL. Es
 * la misma función para la búsqueda y para el PreBook, que la vuelve a aplicar con el neto y el
 * piso revalidados (RF-12: "se vuelve a aplicar con el valor de PreBook").
 */
export function priceRoompack(
  pack: HotelRoompack,
  rules: ApplicableRule[],
  sellerTenantId: string,
): HotelRoompack {
  const floor = pack.price.minimumSellingPrice;
  if (rules.length === 0 && floor === undefined) return pack;
  const waterfall = applyProviderFloor(
    applyCascade(pack.price.total.amountMinor, rules),
    floor?.amountMinor,
    sellerTenantId,
  );
  return {
    ...pack,
    pricing: toTenantView(waterfall, sellerTenantId, pack.price.total.currency),
  };
}

/**
 * El precio de venta de una tarifa ya pasada por {@link priceRoompack}: el de la cascada con el
 * piso, o el neto si no llevó `pricing`. Es lo que el vendedor acepta y lo que paga el cliente.
 */
export function saleTotalOf(pack: HotelRoompack): Money {
  return {
    amountMinor: pack.pricing?.finalMinor ?? pack.price.total.amountMinor,
    currency: pack.price.total.currency,
  };
}
