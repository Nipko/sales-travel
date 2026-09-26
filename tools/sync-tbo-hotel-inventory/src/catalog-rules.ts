import type { CityCadence } from './env.js';

/**
 * Las reglas del catálogo, sin I/O: la guarda del barrido, el centroide, `name_norm` y qué ciudad
 * toca en esta corrida. Viven aparte para que el escritor de Postgres y el doble de los tests
 * decidan exactamente igual, y para probarlas sin base de datos.
 */

/**
 * `hotel_provider_city.name_norm` (0041): minúsculas, sin acentos ni puntuación. Lo calcula el sync
 * y no un índice de expresión porque `unaccent()` no es IMMUTABLE. Mismo criterio que la búsqueda
 * por similitud con `pg_trgm` de E6 (05 §8.3): "São Paulo" y "Sao Paulo" tienen que coincidir.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Mediana, como `percentile_cont(0.5)`: con cantidad par, el promedio de los dos del medio. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

export interface ActiveHotelPoint {
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface CityStats {
  readonly hotelCount: number;
  /** Mediana por eje de los hoteles activos con coordenadas: una coordenada errónea no la mueve. */
  readonly centroid: { readonly lat: number; readonly lng: number } | null;
}

export function cityStats(activeHotels: readonly ActiveHotelPoint[]): CityStats {
  const located = activeHotels.filter(
    (h): h is { latitude: number; longitude: number } =>
      h.latitude !== null && h.longitude !== null,
  );
  const lat = median(located.map((h) => h.latitude));
  const lng = median(located.map((h) => h.longitude));
  return {
    hotelCount: activeHotels.length,
    centroid: lat === null || lng === null ? null : { lat, lng },
  };
}

/**
 * Qué pasa con los hoteles activos que la respuesta ya no trae (05 §6.5):
 *
 * - `swept`: se desactivan.
 * - `nothing-missing`: no falta ninguno.
 * - `incomplete-response`: el ACL descartó hoteles ilegibles (`ITEM_SCHEMA`). Esos hoteles existen
 *   en TBO; darlos de baja por un error de lectura nuestro sería perder hoteles vendibles.
 * - `empty-response`: la ciudad tenía hoteles y la respuesta llegó vacía. Nunca barre.
 * - `drop-exceeded`: faltan más de los que tolera `TBO_SYNC_SWEEP_MAX_DROP`. Es más probable una
 *   respuesta truncada (TBO no documenta paginación, Q-64) que media ciudad cerrada de golpe.
 */
export type SweepVerdict =
  | 'swept'
  | 'nothing-missing'
  | 'incomplete-response'
  | 'empty-response'
  | 'drop-exceeded';

export interface SweepInput {
  /** Activos del proveedor en esa ciudad (o en todo el catálogo, en E5) antes de escribir. */
  readonly previouslyActive: number;
  /** De esos, los que la respuesta no trajo. */
  readonly missing: number;
  /** Elementos legibles de la respuesta. */
  readonly received: number;
  /** Elementos que el ACL descartó por ilegibles. */
  readonly unreadable: number;
  readonly maxDrop: number;
}

export function sweepVerdict(input: SweepInput): SweepVerdict {
  if (input.missing <= 0) return 'nothing-missing';
  if (input.unreadable > 0) return 'incomplete-response';
  if (input.received <= 0) return 'empty-response';
  if (input.previouslyActive <= 0 || input.missing / input.previouslyActive > input.maxDrop) {
    return 'drop-exceeded';
  }
  return 'swept';
}

/**
 * Una anomalía no barre y deja la ciudad pendiente para la próxima corrida (05 §6.5). La respuesta
 * incompleta no es una: reintentar en una hora no arregla un error de lectura, que se ve en el
 * contador y se corrige en el ACL.
 */
export function isSweepAnomaly(verdict: SweepVerdict): boolean {
  return verdict === 'empty-response' || verdict === 'drop-exceeded';
}

export interface CityCandidate {
  readonly code: string;
  readonly countryCode: string;
  readonly hotelCount: number | null;
  readonly syncedAt: Date | null;
  readonly lastStatusCode: number | null;
  /** Búsquedas recientes de destinos mapeados a esta ciudad (`search_logs` + `hotel_destination_map`). */
  readonly demand: number;
}

export interface DueCity {
  readonly code: string;
  readonly countryCode: string;
  readonly demand: number;
}

function maxAgeFor(city: CityCandidate, cadence: CityCadence): number {
  if (city.demand > 0) return cadence.demandMaxAgeMs;
  if (city.hotelCount === 0) return cadence.emptyMaxAgeMs;
  return cadence.regularMaxAgeMs;
}

/**
 * Las ciudades que tocan en esta corrida, en orden (05 §6.3, prioridad de E3):
 *
 * 1. las de destinos con búsquedas recientes, de más a menos buscadas;
 * 2. las que nunca se sincronizaron, primero las que ni siquiera se intentaron (una ciudad que
 *    falla siempre no puede adelantarse a una que todavía no se probó);
 * 3. las más antiguas por `synced_at`.
 *
 * El checkpoint es `synced_at` (05 §6.4): una corrida cortada deja pendientes justo las que no
 * alcanzó, y la siguiente sigue desde ahí.
 */
export function selectDueCities(
  candidates: readonly CityCandidate[],
  options: { readonly now: number; readonly cadence: CityCadence; readonly limit: number },
): DueCity[] {
  if (options.limit <= 0) return [];
  const due = candidates.filter(
    (city) =>
      city.syncedAt === null ||
      options.now - city.syncedAt.getTime() >= maxAgeFor(city, options.cadence),
  );
  const neverTried = (c: CityCandidate): number =>
    c.syncedAt === null && c.lastStatusCode === null ? 0 : 1;
  due.sort(
    (a, b) =>
      b.demand - a.demand ||
      Number(b.syncedAt === null) - Number(a.syncedAt === null) ||
      neverTried(a) - neverTried(b) ||
      (a.syncedAt?.getTime() ?? 0) - (b.syncedAt?.getTime() ?? 0) ||
      a.code.localeCompare(b.code),
  );
  return due
    .slice(0, options.limit)
    .map(({ code, countryCode, demand }) => ({ code, countryCode, demand }));
}
