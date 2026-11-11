import { saleBreakdown } from '../../../../lib/sale-breakdown';
import type { FlightGroup } from './flight-row';

/**
 * Lo que la lista destaca: cuál es el más barato y cuál el más rápido, y con qué precio.
 *
 * El precio es el de VENTA (con la cascada de markup), el mismo que pinta la tarjeta: si las
 * tarjetas de orden dijeran el neto, el «Más barato» no coincidiría con ningún precio visible.
 */

export function groupCurrency(group: FlightGroup): string | undefined {
  return group.offers[0]?.total.currency;
}

/**
 * La moneda en la que vienen más vuelos. Un proveedor puede cotizar en otra (LATAM NDC en BRL
 * mientras Sabre cotiza en COP): las cifras de monedas distintas no se comparan, así que el
 * «Más barato» y el orden por precio se deciden dentro de ésta y el resto va después.
 */
export function mainCurrency(
  groups: readonly FlightGroup[],
  preferred?: string,
): string | undefined {
  // La moneda de venta de la agencia manda si hay vuelos en ella.
  if (preferred && groups.some((g) => groupCurrency(g) === preferred)) return preferred;
  const counts = new Map<string, number>();
  for (const group of groups) {
    const currency = groupCurrency(group);
    if (currency) counts.set(currency, (counts.get(currency) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

/** Precio de venta de la tarifa más barata del vuelo. */
export function groupPrice(group: FlightGroup): number {
  const cheapest = group.offers[0];
  return cheapest ? saleBreakdown(cheapest).sellMinor : Number.POSITIVE_INFINITY;
}

/**
 * Duración del vuelo: la suma de sus tramos, o la de un tramo cuando la lista elige por trayecto
 * (ida y vuelta: la lista de idas compara idas, no la vuelta que trae la combinación más barata).
 */
export function groupDuration(group: FlightGroup, leg?: number): number {
  const itineraries = group.offers[0]?.itineraries ?? [];
  const shown = leg === undefined ? itineraries : itineraries.slice(leg, leg + 1);
  if (shown.length === 0) return Number.POSITIVE_INFINITY;
  return shown.reduce((sum, it) => sum + it.totalDurationMinutes, 0);
}

function minBy(groups: readonly FlightGroup[], score: (g: FlightGroup) => number) {
  let best: FlightGroup | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const group of groups) {
    const s = score(group);
    if (s < bestScore) {
      best = group;
      bestScore = s;
    }
  }
  return best;
}

export interface ResultHighlights {
  readonly cheapest?: FlightGroup;
  readonly fastest?: FlightGroup;
}

export function findHighlights(
  groups: readonly FlightGroup[],
  leg?: number,
  preferred?: string,
): ResultHighlights {
  const currency = mainCurrency(groups, preferred);
  const cheapest = minBy(
    groups.filter((g) => groupCurrency(g) === currency),
    groupPrice,
  );
  const fastest = minBy(groups, (g) => groupDuration(g, leg));
  return { ...(cheapest ? { cheapest } : {}), ...(fastest ? { fastest } : {}) };
}

/**
 * Las etiquetas de cada vuelo. Con un solo resultado no se etiqueta nada: «Más barato» de uno
 * no dice nada. Si el más rápido es también el más barato, lleva las dos.
 */
export function highlightTags(
  groups: readonly FlightGroup[],
  highlights: ResultHighlights,
): ReadonlyMap<string, readonly string[]> {
  const tags = new Map<string, string[]>();
  if (groups.length < 2) return tags;
  const add = (group: FlightGroup | undefined, tag: string) => {
    if (!group) return;
    tags.set(group.key, [...(tags.get(group.key) ?? []), tag]);
  };
  add(highlights.cheapest, 'Más barato');
  add(highlights.fastest, 'Más rápido');
  return tags;
}

/**
 * Ordena las tarifas DENTRO de cada vuelo: primero las de la moneda de venta, y por precio de venta.
 *
 * El mismo vuelo llega por Sabre en COP y por LATAM NDC en BRL; ordenadas por la cifra, «1.734»
 * (BRL) le ganaba a «1.138.700» (COP) y la tarjeta mostraba el precio en reales escondiendo la
 * tarifa en pesos, que era la más barata de toda la búsqueda.
 */
export function preferSaleCurrency(
  groups: readonly FlightGroup[],
  currency: string | undefined,
): FlightGroup[] {
  if (currency === undefined) return [...groups];
  return groups.map((group) => ({
    ...group,
    offers: [...group.offers].sort((a, b) => {
      const offA = a.total.currency === currency ? 0 : 1;
      const offB = b.total.currency === currency ? 0 : 1;
      if (offA !== offB) return offA - offB;
      return saleBreakdown(a).sellMinor - saleBreakdown(b).sellMinor;
    }),
  }));
}
