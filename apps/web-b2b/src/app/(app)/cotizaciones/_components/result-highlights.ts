import { saleBreakdown } from '../../../../lib/sale-breakdown';
import type { FlightGroup } from './flight-row';

/**
 * Lo que la lista destaca: cuál es el más barato y cuál el más rápido, y con qué precio.
 *
 * El precio es el de VENTA (con la cascada de markup), el mismo que pinta la tarjeta: si las
 * tarjetas de orden dijeran el neto, el «Más barato» no coincidiría con ningún precio visible.
 */

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

export function findHighlights(groups: readonly FlightGroup[], leg?: number): ResultHighlights {
  const cheapest = minBy(groups, groupPrice);
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
