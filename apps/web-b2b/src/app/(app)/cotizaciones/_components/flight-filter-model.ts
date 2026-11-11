import { fareAttributes } from '../../../../lib/fare-attributes';
import type { FlightGroup } from './flight-row';
import { groupCurrency, groupPrice, mainCurrency } from './result-highlights';

/**
 * Filtros de resultados de vuelo. TODO en el navegador, sobre lo ya traído: filtrar no puede costar
 * una llamada al proveedor (docs/platform/18).
 *
 * Los filtros miran los tramos que la lista muestra: todos (solo ida, multidestino) o uno solo
 * (`leg`, cada paso de ida y vuelta). Los horarios van por «tramo visible»: el índice 0 es el
 * primero que se ve, sea la ida de un multidestino o la vuelta del paso 2.
 */

export type HourWindow = readonly [number, number];

export interface FlightFilterState {
  /** 0 = directo, 1 = hasta una escala, `null` = cualquiera. Cuenta la peor escala de los tramos. */
  readonly maxStops: number | null;
  readonly carriers: readonly string[];
  /** Franja de salida por tramo visible, en la hora LOCAL del aeropuerto. */
  readonly departure: readonly (HourWindow | null)[];
  readonly arrival: readonly (HourWindow | null)[];
  readonly maxDurationMinutes: number | null;
  readonly baggage: { readonly checked: boolean; readonly carryOn: boolean };
  /** Aeropuertos descartados de una búsqueda por ciudad (MCO / SFB). */
  readonly excludedAirports: readonly string[];
  readonly maxPriceMinor: number | null;
}

export const EMPTY_FILTERS: FlightFilterState = {
  maxStops: null,
  carriers: [],
  departure: [],
  arrival: [],
  maxDurationMinutes: null,
  baggage: { checked: false, carryOn: false },
  excludedAirports: [],
  maxPriceMinor: null,
};

export const HOUR_WINDOWS: readonly { readonly label: string; readonly range: HourWindow }[] = [
  { label: 'Madrugada', range: [0, 6] },
  { label: 'Mañana', range: [6, 12] },
  { label: 'Tarde', range: [12, 18] },
  { label: 'Noche', range: [18, 24] },
];

type Itinerary = NonNullable<FlightGroup['offers'][number]['itineraries']>[number];

/** Los tramos que la lista muestra de este vuelo. */
export function visibleLegs(group: FlightGroup, leg?: number): Itinerary[] {
  const itineraries = group.offers[0]?.itineraries ?? [];
  return leg === undefined ? itineraries : itineraries.slice(leg, leg + 1);
}

/** La hora escrita en el ISO, que es la del aeropuerto: `new Date()` la pasaría a la del navegador. */
export function localHour(iso: string | undefined): number | null {
  const match = iso ? /T(\d{2}):/.exec(iso) : null;
  return match ? Number(match[1]) : null;
}

function inWindow(hour: number | null, window: HourWindow | null | undefined): boolean {
  if (!window) return true;
  return hour !== null && hour >= window[0] && hour < window[1];
}

export function stopsOf(group: FlightGroup, leg?: number): number {
  return Math.max(0, ...visibleLegs(group, leg).map((it) => it.stops));
}

export function carriersOf(group: FlightGroup, leg?: number): string[] {
  return [...new Set(visibleLegs(group, leg).flatMap((it) => it.segments.map((s) => s.carrier)))];
}

export function durationOf(group: FlightGroup, leg?: number): number {
  return visibleLegs(group, leg).reduce((sum, it) => sum + it.totalDurationMinutes, 0);
}

/** Los aeropuertos de salida y llegada de cada tramo visible. */
export function endpointsOf(group: FlightGroup, leg?: number): string[] {
  return visibleLegs(group, leg).flatMap((it) => {
    const first = it.segments[0];
    const last = it.segments[it.segments.length - 1];
    return [first?.origin, last?.destination].filter((c): c is string => Boolean(c));
  });
}

const NO_MONEY = () => '';

/** ¿Alguna tarifa del vuelo incluye esta pieza? El filtro no puede esconder la tarifa que sí la trae. */
export function includesBaggage(
  group: FlightGroup,
  piece: 'checked' | 'carryOn',
  leg?: number,
): boolean {
  return group.offers.some((offer) => fareAttributes(offer, leg, NO_MONEY)[piece].value === 'yes');
}

/** Cada regla por separado: los conteos del panel necesitan aplicar todas menos una. */
type Rule = 'stops' | 'carriers' | 'times' | 'duration' | 'baggage' | 'airports' | 'price';

function passes(
  group: FlightGroup,
  f: FlightFilterState,
  leg: number | undefined,
  skip?: Rule,
): boolean {
  if (skip !== 'stops' && f.maxStops !== null && stopsOf(group, leg) > f.maxStops) return false;
  if (
    skip !== 'carriers' &&
    f.carriers.length > 0 &&
    !carriersOf(group, leg).some((c) => f.carriers.includes(c))
  ) {
    return false;
  }
  if (skip !== 'times') {
    const legs = visibleLegs(group, leg);
    for (let i = 0; i < legs.length; i += 1) {
      const it = legs[i]!;
      const dep = it.segments[0]?.departureAt;
      const arr = it.segments[it.segments.length - 1]?.arrivalAt;
      if (!inWindow(localHour(dep), f.departure[i])) return false;
      if (!inWindow(localHour(arr), f.arrival[i])) return false;
    }
  }
  if (
    skip !== 'duration' &&
    f.maxDurationMinutes !== null &&
    durationOf(group, leg) > f.maxDurationMinutes
  ) {
    return false;
  }
  if (skip !== 'baggage') {
    if (f.baggage.checked && !includesBaggage(group, 'checked', leg)) return false;
    if (f.baggage.carryOn && !includesBaggage(group, 'carryOn', leg)) return false;
  }
  if (
    skip !== 'airports' &&
    f.excludedAirports.length > 0 &&
    endpointsOf(group, leg).some((c) => f.excludedAirports.includes(c))
  ) {
    return false;
  }
  if (skip !== 'price' && f.maxPriceMinor !== null && groupPrice(group) > f.maxPriceMinor) {
    return false;
  }
  return true;
}

export function applyFlightFilters(
  groups: readonly FlightGroup[],
  f: FlightFilterState,
  leg?: number,
): FlightGroup[] {
  return groups.filter((g) => passes(g, f, leg));
}

export function activeFilterCount(f: FlightFilterState): number {
  return (
    (f.maxStops === null ? 0 : 1) +
    (f.carriers.length > 0 ? 1 : 0) +
    f.departure.filter(Boolean).length +
    f.arrival.filter(Boolean).length +
    (f.maxDurationMinutes === null ? 0 : 1) +
    (f.baggage.checked ? 1 : 0) +
    (f.baggage.carryOn ? 1 : 0) +
    (f.excludedAirports.length > 0 ? 1 : 0) +
    (f.maxPriceMinor === null ? 0 : 1)
  );
}

/** Cuántos vuelos quedan con esa opción y desde qué precio (en la moneda principal). */
export interface OptionStat {
  readonly count: number;
  readonly minPriceMinor: number | null;
}

function stat(groups: readonly FlightGroup[], currency: string | undefined): OptionStat {
  const prices = groups.filter((g) => groupCurrency(g) === currency).map(groupPrice);
  return { count: groups.length, minPriceMinor: prices.length > 0 ? Math.min(...prices) : null };
}

export interface FilterOptions {
  readonly currency: string;
  readonly stops: { readonly direct: OptionStat; readonly upToOne: OptionStat };
  readonly carriers: readonly ({ readonly code: string } & OptionStat)[];
  readonly baggage: { readonly checked: OptionStat; readonly carryOn: OptionStat };
  /** Cuántos tramos visibles tiene la lista: una fila de horarios por cada uno. */
  readonly legSlots: number;
  readonly duration: { readonly min: number; readonly max: number } | null;
  /** Sólo si algún extremo tiene más de un aeropuerto (búsqueda por ciudad). */
  readonly airports: readonly ({ readonly code: string } & OptionStat)[];
  readonly maxPriceMinor: number;
}

/**
 * Las opciones salen de los resultados, con conteos calculados aplicando los DEMÁS filtros: así
 * «Directo (8)» dice cuántos quedan si se marca, no cuántos había antes de filtrar.
 */
export function deriveFilterOptions(
  groups: readonly FlightGroup[],
  f: FlightFilterState,
  leg?: number,
  preferredCurrency?: string,
): FilterOptions {
  const currency = mainCurrency(groups, preferredCurrency);
  const without = (rule: Rule) => groups.filter((g) => passes(g, f, leg, rule));

  const byStops = without('stops');
  const byCarrier = without('carriers');
  const carrierCodes = [...new Set(groups.flatMap((g) => carriersOf(g, leg)))];
  const carriers = carrierCodes
    .map((code) => ({
      code,
      ...stat(
        byCarrier.filter((g) => carriersOf(g, leg).includes(code)),
        currency,
      ),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const byBaggage = without('baggage');
  const durations = groups.map((g) => durationOf(g, leg));

  // Aeropuertos: por posición (salida del tramo 1, llegada del tramo 1…), sólo donde hay varios.
  const byAirport = without('airports');
  const positions = new Map<number, Set<string>>();
  for (const g of groups) {
    endpointsOf(g, leg).forEach((code, i) => {
      positions.set(i, (positions.get(i) ?? new Set()).add(code));
    });
  }
  const multi = new Set(
    [...positions.values()].filter((codes) => codes.size > 1).flatMap((codes) => [...codes]),
  );
  const airports = [...multi]
    .map((code) => ({
      code,
      ...stat(
        byAirport.filter((g) => endpointsOf(g, leg).includes(code)),
        currency,
      ),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const prices = groups.filter((g) => groupCurrency(g) === currency).map(groupPrice);

  return {
    currency: currency ?? 'COP',
    stops: {
      direct: stat(
        byStops.filter((g) => stopsOf(g, leg) === 0),
        currency,
      ),
      upToOne: stat(
        byStops.filter((g) => stopsOf(g, leg) <= 1),
        currency,
      ),
    },
    carriers,
    baggage: {
      checked: stat(
        byBaggage.filter((g) => includesBaggage(g, 'checked', leg)),
        currency,
      ),
      carryOn: stat(
        byBaggage.filter((g) => includesBaggage(g, 'carryOn', leg)),
        currency,
      ),
    },
    legSlots: Math.max(0, ...groups.map((g) => visibleLegs(g, leg).length)),
    duration:
      durations.length > 0 ? { min: Math.min(...durations), max: Math.max(...durations) } : null,
    airports,
    maxPriceMinor: prices.length > 0 ? Math.max(...prices) : 0,
  };
}

/** Pone o quita la franja de un tramo visible. */
export function toggleWindow(
  windows: readonly (HourWindow | null)[],
  slot: number,
  range: HourWindow,
): (HourWindow | null)[] {
  const next = [...windows];
  while (next.length <= slot) next.push(null);
  const current = next[slot];
  next[slot] = current && current[0] === range[0] && current[1] === range[1] ? null : range;
  return next;
}
