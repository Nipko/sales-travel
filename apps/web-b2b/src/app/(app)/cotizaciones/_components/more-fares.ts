import type { Offer } from '../actions';

/**
 * La aerolínea única de una oferta, o `null` si combina varias. Las otras marcas se piden acotadas
 * a UNA aerolínea (`VendorPref=Only` en Sabre): un vuelo interline no se puede escalar con
 * honestidad, así que se queda con lo que trajo la búsqueda.
 */
export function singleCarrier(offer: Offer | undefined): string | null {
  const carriers = new Set(
    (offer?.itineraries ?? []).flatMap((it) => it.segments.map((s) => s.carrier)),
  );
  return carriers.size === 1 ? [...carriers][0]! : null;
}

/** Suma ofertas nuevas a una lista sin repetir ninguna (por `id`). */
export function mergeOffers(base: readonly Offer[], extra: readonly Offer[]): Offer[] {
  if (extra.length === 0) return [...base];
  const seen = new Set(base.map((o) => o.id));
  const out = [...base];
  for (const offer of extra) {
    if (seen.has(offer.id)) continue;
    seen.add(offer.id);
    out.push(offer);
  }
  return out;
}
