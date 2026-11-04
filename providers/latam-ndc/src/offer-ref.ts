import type { Offer } from '@sales-travel/canonical';

/**
 * Cómo viaja la referencia de una oferta LATAM dentro de la Offer canónica.
 *
 * `provider.offerRef` lleva sólo el `OfferID` (un UUID). Los `OfferItemID` —uno por trayecto,
 * largos: `SEI|<base64>|<base64>|…`— van en `provider.raw.offerItemIds`.
 *
 * Antes iban concatenados en `offerRef` (`OfferID|item1,item2`). Mientras el parser convertía los
 * textos a número se acortaban por accidente; leídos completos, un ida y vuelta pasa los 255
 * caracteres que admite `offerRef` (`packages/canonical/src/offer.ts`) y la API rechazaba revalidar
 * y elegir la vuelta. Las ofertas guardadas con la forma vieja se siguen leyendo.
 */
export const LATAM_OFFER_ITEMS_KEY = 'offerItemIds';

export function latamProviderRef(
  offerId: string,
  offerItemIds: readonly string[],
): Pick<Offer['provider'], 'offerRef' | 'raw'> {
  return {
    offerRef: offerId,
    ...(offerItemIds.length > 0 ? { raw: { [LATAM_OFFER_ITEMS_KEY]: [...offerItemIds] } } : {}),
  };
}

export function readLatamOfferRef(provider: Offer['provider']): {
  offerId: string;
  offerItemIds: string[];
} {
  const raw = provider.raw?.[LATAM_OFFER_ITEMS_KEY];
  if (Array.isArray(raw)) {
    const items = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (items.length > 0) return { offerId: provider.offerRef, offerItemIds: items };
  }
  // Forma vieja: `OfferID|item1,item2`. El OfferID es un UUID (sin `|`); los ítems no traen `,`.
  const ref = provider.offerRef;
  const pipe = ref.indexOf('|');
  if (pipe === -1) return { offerId: ref, offerItemIds: [`${ref}-ITEM1`] };
  const offerId = ref.slice(0, pipe);
  const items = ref
    .slice(pipe + 1)
    .split(',')
    .filter(Boolean);
  return { offerId, offerItemIds: items.length > 0 ? items : [`${offerId}-ITEM1`] };
}
