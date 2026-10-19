import type { Offer } from '../actions';
import { saleBreakdown } from '../../../../lib/sale-breakdown';
import type { FlightGroup } from './flight-row';

/**
 * Ida y vuelta elegida por trayecto (docs/sabre/15 §5).
 *
 * Una `Offer` sigue siendo una combinación cotizada de ida + vuelta: aquí no se suman trayectos
 * sueltos ni se inventan precios. Lo que cambia es cómo se agrupan: primero por el vuelo de IDA
 * (con sus tarifas de ida), y elegida la ida, por el vuelo de VUELTA entre las combinaciones que
 * llevan esa ida con esa tarifa. Cada precio que se muestra es el total de una oferta real.
 */

/** 0 = ida, 1 = vuelta. */
export type Leg = 0 | 1;

/** Identidad de los vuelos de un trayecto, sin clase ni marca (cambian entre tarifas). */
export function legKey(offer: Offer, leg: Leg): string | null {
  const itinerary = offer.itineraries?.[leg];
  if (!itinerary?.segments.length) return null;
  return itinerary.segments
    .map((segment) => `${segment.carrier}${segment.flightNumber}-${segment.departureAt}`)
    .join('|');
}

export interface LegFare {
  /** Para agrupar: el código si lo hay, si no el nombre. */
  readonly key: string;
  readonly code?: string;
  readonly name: string;
}

/**
 * La tarifa de UN trayecto: la marca de los componentes que cubren sus segmentos.
 *
 * Con dos marcas distintas dentro del mismo trayecto (un tramo LIGHT y otro FLEX) se muestran
 * las dos juntas: es lo que se está vendiendo y no hay una sola que la represente. Sin
 * componentes se cae a `fareFamily`, que en LATAM NDC es la misma marca para todo el viaje.
 */
export function legFare(offer: Offer, leg: Leg): LegFare {
  const itineraries = offer.itineraries ?? [];
  let start = 0;
  for (let i = 0; i < leg; i += 1) start += itineraries[i]?.segments.length ?? 0;
  const end = start + (itineraries[leg]?.segments.length ?? 0);

  const fares: { code?: string; name: string }[] = [];
  for (const component of offer.fareComponents ?? []) {
    if (!component.segmentRefs.some((ref) => ref >= start && ref < end)) continue;
    const code = component.brand?.code?.trim().toUpperCase() || undefined;
    const name = component.brand?.name?.trim() || code;
    if (name === undefined) continue;
    if (!fares.some((fare) => fare.name === name)) fares.push({ ...(code ? { code } : {}), name });
  }

  if (fares.length === 1) {
    const fare = fares[0]!;
    return { key: fare.code ?? fare.name.toUpperCase(), ...fare };
  }
  if (fares.length > 1) {
    const name = fares.map((fare) => fare.name).join(' + ');
    return { key: name.toUpperCase(), name };
  }
  const family = offer.fareFamily?.name?.trim();
  if (family) return { key: family.toUpperCase(), name: family };
  return { key: 'STANDARD', name: 'Tarifa' };
}

function sellMinor(offer: Offer): number {
  return saleBreakdown(offer).sellMinor;
}

function byPrice(a: Offer, b: Offer): number {
  return sellMinor(a) - sellMinor(b);
}

/** Agrupa por los vuelos de un trayecto. Dentro de cada grupo, de la más barata a la más cara. */
export function groupByLeg(offers: readonly Offer[], leg: Leg): FlightGroup[] {
  const groups = new Map<string, Offer[]>();
  for (const offer of offers) {
    const key = legKey(offer, leg);
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(offer);
    else groups.set(key, [offer]);
  }
  return [...groups].map(([key, list]) => ({ key, offers: [...list].sort(byPrice) }));
}

/**
 * Una oferta por tarifa del trayecto: la más barata que la lleva. Es la tarjeta que el vendedor
 * compara («LIGHT desde $X, FLEX desde $Y»). Ordenadas de la más barata a la más cara.
 */
export function faresForLeg(offers: readonly Offer[], leg: Leg): Offer[] {
  const cheapest = new Map<string, Offer>();
  for (const offer of [...offers].sort(byPrice)) {
    const key = legFare(offer, leg).key;
    if (!cheapest.has(key)) cheapest.set(key, offer);
  }
  return [...cheapest.values()];
}

/** ¿Esta combinación lleva exactamente la ida y la tarifa de ida elegidas? */
export function sameOutbound(offer: Offer, outbound: Offer): boolean {
  return (
    legKey(offer, 0) === legKey(outbound, 0) && legFare(offer, 0).key === legFare(outbound, 0).key
  );
}

/**
 * Las vueltas que ya trajo la primera búsqueda para la ida elegida. Es la red cuando el
 * proveedor no sabe anclar o la búsqueda de vueltas falla: menos opciones, pero todas con
 * precio cotizado.
 */
export function returnsFromSearch(offers: readonly Offer[], outbound: Offer): Offer[] {
  return offers.filter((offer) => sameOutbound(offer, outbound));
}

/**
 * Junta las vueltas ancladas con las de la primera búsqueda, sin duplicar combinaciones: dos
 * ofertas son la misma si tienen los mismos vuelos y la misma tarifa en cada trayecto. Gana la
 * anclada, que es la cotización más reciente.
 */
export function mergeReturns(anchored: readonly Offer[], fromSearch: readonly Offer[]): Offer[] {
  const identity = (offer: Offer) =>
    `${legKey(offer, 0)}#${legFare(offer, 0).key}#${legKey(offer, 1)}#${legFare(offer, 1).key}`;
  const seen = new Set(anchored.map(identity));
  return [...anchored, ...fromSearch.filter((offer) => !seen.has(identity(offer)))];
}

/** ¿Hay un viaje de ida y vuelta en estos resultados? Decide qué flujo se muestra. */
export function isRoundTripResult(offers: readonly Offer[]): boolean {
  return offers.some((offer) => (offer.itineraries?.length ?? 0) === 2);
}
