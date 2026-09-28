import { normalizeName } from './catalog-rules.js';

/**
 * Las reglas de E6, sin I/O: cuándo dos hoteles de proveedores distintos son el mismo (05 §9.1;
 * 08 RF-34; D-TBO-13 A) y a qué ciudades del proveedor corresponde un destino de la UI (05 §8.3;
 * 08 RF-33; D-TBO-10 A). Viven aparte por lo mismo que `catalog-rules.ts`: el escritor de Postgres
 * y el doble de los tests deciden exactamente igual, y se prueban sin base de datos.
 *
 * Postura de todo el archivo: **una fusión falsa es peor que un duplicado** (05 §9.3), y mezclar
 * ciudades vecinas es peor que no mostrar los hoteles de ese proveedor (05 §8.4). Ante la duda,
 * `review` o `ambiguous`, que la búsqueda no usa.
 */

/**
 * El proveedor cuyo espacio de ids es el del destino de la UI: su autocompletado da el
 * `destinationId` y es el `source_provider_code` de `hotel_destination_map`. Es el mismo valor que
 * `PLATFORM_ID_SPACE_PROVIDER` de `apps/api/src/providers/hotel-provider.types.ts`, que la
 * búsqueda usa para leer el mapa; la herramienta no importa la app, así que se repite aquí.
 */
export const PLATFORM_DESTINATION_PROVIDER = 'despegar-hotels';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/** Radio medio de la Tierra; el mismo que usa el SQL de `writer.ts` para prefiltrar pares. */
export const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Haversine: no hay PostGIS ni `earthdistance` en la base (05 §7.2 punto 5). */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `score` es NUMERIC(4,3) en las dos tablas (0041). */
export function roundScore(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

// ───────────────────────── Nombres ─────────────────────────

/**
 * Palabras que no distinguen un hotel de otro: el tipo genérico y los artículos y preposiciones de
 * ES, PT y EN. Las marcas y lo que sí distingue dos hoteles del mismo edificio ("suites", "inn",
 * "resort", "budget") se conservan (05 §9.1).
 */
const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set([
  'hotel',
  'hotels',
  'hoteles',
  'hoteis',
  'the',
  'by',
  'and',
  'at',
  'y',
  'e',
  'de',
  'del',
  'da',
  'do',
  'das',
  'dos',
  'la',
  'las',
  'el',
  'los',
]);

/**
 * El nombre que se compara: `normalizeName` (minúsculas, sin acentos ni puntuación, como
 * `hotel_provider_city.name_norm`) y sin palabras genéricas. Un nombre que sólo tiene palabras
 * genéricas ("Hotel") queda vacío y no se parece a nada.
 */
export function matchName(name: string | null): string {
  if (name === null) return '';
  return normalizeName(name)
    .split(' ')
    .filter((word) => word.length > 0 && !GENERIC_NAME_WORDS.has(word))
    .join(' ');
}

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length === 0) continue;
    const padded = `  ${word.toLowerCase()} `;
    const chars = [...padded];
    for (let i = 0; i + 3 <= chars.length; i += 1) out.add(chars.slice(i, i + 3).join(''));
  }
  return out;
}

/**
 * `similarity()` de `pg_trgm`, en TypeScript: trigramas de cada palabra con dos espacios delante y
 * uno detrás, y |A ∩ B| / |A ∪ B|. Se calcula aquí y no en SQL porque `hotel_inventory` no tiene
 * `name_norm` (el nombre se normaliza con las palabras genéricas de arriba) y porque así el doble
 * de los tests decide igual que producción. El test de integración lo contrasta con `pg_trgm`.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const trigram of left) if (right.has(trigram)) common += 1;
  return common / (left.size + right.size - common);
}

// ───────────────────────── Equivalencias de hotel (hotel_match) ─────────────────────────

export interface HotelMatchRules {
  /** Distancia haversine máxima entre las coordenadas de los dos hoteles. */
  readonly maxDistanceM: number;
  /** Similitud trigram mínima entre los nombres normalizados. */
  readonly minNameSimilarity: number;
  /** Si ambos informan estrellas, la diferencia máxima. */
  readonly maxStarsDiff: number;
}

/** D-TBO-13 A: ≤ 150 m, similitud ≥ 0,5, estrellas ± 1. Umbrales iniciales, a calibrar (05 §9.1). */
export const HOTEL_MATCH_RULES: HotelMatchRules = Object.freeze({
  maxDistanceM: 150,
  minNameSimilarity: 0.5,
  maxStarsDiff: 1,
});

export type HotelMatchMethod = 'heuristic' | 'manual' | 'giata';
export type HotelMatchStatus = 'accepted' | 'review' | 'rejected';

/** Una fila de `hotel_match` (0041). */
export interface HotelMatchRow {
  readonly canonicalHotelId: string;
  readonly providerCode: string;
  readonly hotelId: string;
  readonly method: HotelMatchMethod;
  readonly score: number | null;
  readonly status: HotelMatchStatus;
}

export interface HotelRef {
  readonly providerCode: string;
  readonly hotelId: string;
}

export interface MatchHotel {
  readonly hotelId: string;
  readonly name: string | null;
  readonly stars: number | null;
  readonly location: GeoPoint;
}

/** Un hotel del proveedor (`target`) y uno del destino de la UI (`source`) cercanos. */
export interface HotelPair {
  readonly target: MatchHotel;
  readonly source: MatchHotel;
}

export interface PairEvidence {
  readonly distanceM: number;
  readonly similarity: number;
  readonly starsDiff: number | null;
  readonly qualifies: boolean;
}

export function pairEvidence(pair: HotelPair, rules: HotelMatchRules): PairEvidence {
  const distanceM = haversineMeters(pair.target.location, pair.source.location);
  const similarity = trigramSimilarity(matchName(pair.target.name), matchName(pair.source.name));
  const starsDiff =
    pair.target.stars === null || pair.source.stars === null
      ? null
      : Math.abs(pair.target.stars - pair.source.stars);
  return {
    distanceM,
    similarity,
    starsDiff,
    qualifies:
      distanceM <= rules.maxDistanceM &&
      similarity >= rules.minNameSimilarity &&
      (starsDiff === null || starsDiff <= rules.maxStarsDiff),
  };
}

/**
 * La clave del grupo: la del hotel del destino de la UI. Es estable entre recálculos (el grupo no
 * cambia de nombre si cambia el hotel del otro lado) y coincide con la clave que la búsqueda le daría
 * a un hotel sin equivalencia, `<provider_code>:<hotel_id>` (05 §9.1).
 */
export function canonicalHotelId(providerCode: string, hotelId: string): string {
  return `${providerCode}:${hotelId}`;
}

const refKey = (providerCode: string, hotelId: string): string => `${providerCode}|${hotelId}`;

export interface HotelMatchPlanInput {
  readonly sourceProvider: string;
  readonly targetProvider: string;
  /** Pares cercanos del alcance: hoteles activos y con coordenadas de los dos proveedores. */
  readonly pairs: readonly HotelPair[];
  /** Todos los hoteles del proveedor en los países de la corrida, activos o no: el alcance. */
  readonly scopeTargetIds: ReadonlySet<string>;
  /** Todo `hotel_match`: para no pisar lo manual y para ver los grupos enteros. */
  readonly stored: readonly HotelMatchRow[];
  readonly rules?: HotelMatchRules;
}

export interface HotelMatchCounts {
  readonly pairsNear: number;
  readonly pairsQualifying: number;
  /** Pares con candidato único de los dos lados: ambos hoteles `accepted`. */
  readonly acceptedPairs: number;
  /** Hoteles con más de un candidato, o cuyo candidato ya tiene una fila manual. */
  readonly reviewHotels: number;
  /** Hoteles con fila `manual` o `giata` que aparecen en algún par: no se tocan. */
  readonly protectedHotels: number;
  /** Filas que ya estaban exactamente así y no se reescriben. */
  readonly unchanged: number;
  /**
   * Filas `accepted` del alcance que dejarían de estarlo (por baja o por pasar a `review`). No
   * cuenta las que pasan a `review` porque su pareja ya es de una persona: eso no es síntoma de un
   * catálogo roto, y contarlo retendría E6 en cada corrida mientras la decisión humana siga ahí.
   */
  readonly acceptedLost: number;
  /** Filas `accepted` del alcance antes del recálculo, con la misma exclusión. */
  readonly acceptedInScope: number;
}

export interface HotelMatchPlan {
  /** Filas a escribir, siempre `heuristic`. */
  readonly upserts: readonly HotelMatchRow[];
  /** Filas `heuristic` que pasan a `rejected`: ya no las respalda ningún par. */
  readonly demotions: readonly HotelRef[];
  readonly counts: HotelMatchCounts;
}

interface Qualified {
  readonly targetId: string;
  readonly sourceId: string;
  readonly score: number;
  readonly distanceM: number;
}

/** El mejor candidato primero: más parecido, más cerca y, al final, el id, para ser determinista. */
function byStrength(a: Qualified, b: Qualified): number {
  return (
    b.score - a.score ||
    a.distanceM - b.distanceM ||
    a.sourceId.localeCompare(b.sourceId) ||
    a.targetId.localeCompare(b.targetId)
  );
}

function sameRow(stored: HotelMatchRow | undefined, desired: HotelMatchRow): boolean {
  return (
    stored !== undefined &&
    stored.method === desired.method &&
    stored.status === desired.status &&
    stored.canonicalHotelId === desired.canonicalHotelId &&
    stored.score !== null &&
    desired.score !== null &&
    Math.abs(stored.score - desired.score) < 0.0005
  );
}

/**
 * El recálculo de `hotel_match` para el alcance de la corrida (05 §9.1):
 *
 * 1. Un par califica si cumple TODO: ≤ 150 m, similitud ≥ 0,5 y, si ambos tienen estrellas, ± 1.
 * 2. Si el hotel del proveedor tiene un único candidato que califica, y ese candidato tampoco tiene
 *    otro, los dos quedan `accepted` con la clave del hotel del destino de la UI.
 * 3. Si alguno de los dos tiene otro candidato que también califica, los involucrados van a
 *    `review`: dos hoteles de una cadena en el mismo edificio no se agrupan solos.
 * 4. **Una fila `manual` o `giata` nunca se pisa**, y su hotel no se agrupa por heurística: su
 *    pareja va a `review`, para que decida la misma persona.
 * 5. Una fila `heuristic` que ya no respalda ningún par pasa a `rejected` (nunca `DELETE`): del
 *    proveedor, si su hotel es del alcance; del destino de la UI, si su grupo se quedó sin nadie
 *    de otro proveedor. Lo de países fuera de la corrida no se toca.
 */
export function planHotelMatches(input: HotelMatchPlanInput): HotelMatchPlan {
  const rules = input.rules ?? HOTEL_MATCH_RULES;
  const { sourceProvider, targetProvider } = input;
  const stored = new Map(input.stored.map((row) => [refKey(row.providerCode, row.hotelId), row]));
  const isProtected = (providerCode: string, hotelId: string): boolean => {
    const row = stored.get(refKey(providerCode, hotelId));
    return row !== undefined && row.method !== 'heuristic';
  };

  const seenPairs = new Set<string>();
  const qualified: Qualified[] = [];
  for (const pair of input.pairs) {
    const pairKey = `${pair.target.hotelId}|${pair.source.hotelId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const evidence = pairEvidence(pair, rules);
    if (!evidence.qualifies) continue;
    qualified.push({
      targetId: pair.target.hotelId,
      sourceId: pair.source.hotelId,
      score: roundScore(evidence.similarity),
      distanceM: evidence.distanceM,
    });
  }
  const byTarget = new Map<string, Qualified[]>();
  const bySource = new Map<string, Qualified[]>();
  for (const q of qualified) {
    byTarget.set(q.targetId, [...(byTarget.get(q.targetId) ?? []), q]);
    bySource.set(q.sourceId, [...(bySource.get(q.sourceId) ?? []), q]);
  }

  const desired = new Map<string, HotelMatchRow>();
  const protectedHotels = new Set<string>();
  // La pareja única de un hotel protegido: va a `review` por una decisión humana, no por el catálogo.
  const reviewedByHuman = new Set<string>();
  let acceptedPairs = 0;
  for (const q of qualified) {
    const targetProtected = isProtected(targetProvider, q.targetId);
    const sourceProtected = isProtected(sourceProvider, q.sourceId);
    if (targetProtected) protectedHotels.add(refKey(targetProvider, q.targetId));
    if (sourceProtected) protectedHotels.add(refKey(sourceProvider, q.sourceId));
    const unique = byTarget.get(q.targetId)?.length === 1 && bySource.get(q.sourceId)?.length === 1;
    if (unique && targetProtected !== sourceProtected) {
      reviewedByHuman.add(
        targetProtected ? refKey(sourceProvider, q.sourceId) : refKey(targetProvider, q.targetId),
      );
    }
    if (!unique || targetProtected || sourceProtected) continue;
    const canonical = canonicalHotelId(sourceProvider, q.sourceId);
    const row = { canonicalHotelId: canonical, method: 'heuristic', score: q.score } as const;
    desired.set(refKey(targetProvider, q.targetId), {
      ...row,
      providerCode: targetProvider,
      hotelId: q.targetId,
      status: 'accepted',
    });
    desired.set(refKey(sourceProvider, q.sourceId), {
      ...row,
      providerCode: sourceProvider,
      hotelId: q.sourceId,
      status: 'accepted',
    });
    acceptedPairs += 1;
  }

  let reviewHotels = 0;
  const addReview = (providerCode: string, hotelId: string, canonical: string, score: number) => {
    const key = refKey(providerCode, hotelId);
    if (desired.has(key) || isProtected(providerCode, hotelId)) return;
    desired.set(key, {
      canonicalHotelId: canonical,
      providerCode,
      hotelId,
      method: 'heuristic',
      score,
      status: 'review',
    });
    reviewHotels += 1;
  };
  for (const [targetId, candidates] of byTarget) {
    const best = [...candidates].sort(byStrength)[0];
    if (best === undefined) continue;
    addReview(
      targetProvider,
      targetId,
      canonicalHotelId(sourceProvider, best.sourceId),
      best.score,
    );
  }
  for (const [sourceId, candidates] of bySource) {
    const best = [...candidates].sort(byStrength)[0];
    if (best === undefined) continue;
    addReview(sourceProvider, sourceId, canonicalHotelId(sourceProvider, sourceId), best.score);
  }

  // Bajas: lo `heuristic` vivo que el recálculo ya no produce.
  const demotions: HotelRef[] = [];
  const demoted = new Set<string>();
  const live = (row: HotelMatchRow): boolean =>
    row.method === 'heuristic' && row.status !== 'rejected';
  for (const row of input.stored) {
    const key = refKey(row.providerCode, row.hotelId);
    if (!live(row) || desired.has(key)) continue;
    if (row.providerCode === targetProvider && input.scopeTargetIds.has(row.hotelId)) {
      demotions.push({ providerCode: row.providerCode, hotelId: row.hotelId });
      demoted.add(key);
    }
  }
  // Un hotel del destino de la UI sólo agrupa si alguien de OTRO proveedor sigue en su grupo.
  const groupsWithOthers = new Set<string>();
  const finalRows = new Map(stored);
  for (const [key, row] of desired) finalRows.set(key, row);
  for (const [key, row] of finalRows) {
    if (demoted.has(key) || row.status === 'rejected' || row.providerCode === sourceProvider) {
      continue;
    }
    groupsWithOthers.add(row.canonicalHotelId);
  }
  for (const row of input.stored) {
    const key = refKey(row.providerCode, row.hotelId);
    if (!live(row) || desired.has(key) || row.providerCode !== sourceProvider) continue;
    if (groupsWithOthers.has(row.canonicalHotelId)) continue;
    demotions.push({ providerCode: row.providerCode, hotelId: row.hotelId });
    demoted.add(key);
  }

  const upserts: HotelMatchRow[] = [];
  let unchanged = 0;
  for (const [key, row] of desired) {
    if (sameRow(stored.get(key), row)) unchanged += 1;
    else upserts.push(row);
  }

  // Lo `accepted` del alcance: filas del proveedor de estos países y las del destino de la UI de
  // sus grupos. Las que dejan de estarlo miden si el recálculo es una limpieza o un catálogo roto.
  const scopeGroups = new Set<string>();
  for (const row of input.stored) {
    if (row.providerCode === targetProvider && input.scopeTargetIds.has(row.hotelId)) {
      scopeGroups.add(row.canonicalHotelId);
    }
  }
  let acceptedInScope = 0;
  let acceptedLost = 0;
  for (const row of input.stored) {
    if (row.method !== 'heuristic' || row.status !== 'accepted') continue;
    const inScope =
      (row.providerCode === targetProvider && input.scopeTargetIds.has(row.hotelId)) ||
      (row.providerCode === sourceProvider && scopeGroups.has(row.canonicalHotelId));
    const key = refKey(row.providerCode, row.hotelId);
    if (!inScope || reviewedByHuman.has(key)) continue;
    acceptedInScope += 1;
    if (demoted.has(key) || (desired.get(key)?.status ?? 'accepted') !== 'accepted') {
      acceptedLost += 1;
    }
  }

  return {
    upserts,
    demotions,
    counts: {
      pairsNear: seenPairs.size,
      pairsQualifying: qualified.length,
      acceptedPairs,
      reviewHotels,
      protectedHotels: protectedHotels.size,
      unchanged,
      acceptedLost,
      acceptedInScope,
    },
  };
}

// ───────────────────────── Mapa de destinos (hotel_destination_map) ─────────────────────────

export interface DestinationMapRules {
  /** Radio de búsqueda de ciudades candidatas alrededor del centroide del destino (R). */
  readonly radiusKm: number;
  /** Equivalencias aceptadas que bastan para aceptar por solapamiento (k). */
  readonly minOverlap: number;
  /** …o esta fracción de los hoteles del lado más chico. */
  readonly minOverlapShare: number;
  /** La mejor candidata tiene que tener al menos este múltiplo del solapamiento de la segunda. */
  readonly overlapMargin: number;
  /** Sin solapamiento, la más cercana sólo se acepta a menos de r km… */
  readonly centroidMaxKm: number;
  /** …y si la segunda está a más de este múltiplo de su distancia. */
  readonly centroidSecondFactor: number;
  /** Filas `ambiguous` por destino: las candidatas que un humano tiene que mirar. */
  readonly maxAmbiguousTargets: number;
}

/** 05 §8.3: R = 25 km, k = 3 o 20 %, r = 5 km y "más del doble". Iniciales, a calibrar. */
export const DESTINATION_MAP_RULES: DestinationMapRules = Object.freeze({
  radiusKm: 25,
  minOverlap: 3,
  minOverlapShare: 0.2,
  overlapMargin: 2,
  centroidMaxKm: 5,
  centroidSecondFactor: 2,
  maxAmbiguousTargets: 3,
});

export type DestinationMethod = 'overlap' | 'centroid' | 'manual';
export type DestinationStatus = 'accepted' | 'ambiguous' | 'rejected';

/** Una fila de `hotel_destination_map` (0041) entre el destino de la UI y un proveedor. */
export interface DestinationRow {
  readonly sourceCityId: string;
  readonly targetCityCode: string;
  readonly method: DestinationMethod;
  readonly score: number | null;
  readonly status: DestinationStatus;
}

export interface DestinationRef {
  readonly sourceCityId: string;
  readonly targetCityCode: string;
}

/** Un destino de la UI: una ciudad del proveedor de origen con sus hoteles activos. */
export interface SourceCity {
  readonly cityId: string;
  readonly hotelCount: number;
  /** Mediana por eje de sus hoteles con coordenadas, como `hotel_provider_city`. */
  readonly centroid: GeoPoint | null;
}

/** Una ciudad del proveedor (`hotel_provider_city`). */
export interface TargetCity {
  readonly cityCode: string;
  readonly countryCode: string;
  readonly hotelCount: number | null;
  readonly centroid: GeoPoint | null;
  /** E3 ya la pidió alguna vez, con éxito o no. */
  readonly attempted: boolean;
}

/** Equivalencias aceptadas entre los hoteles de un destino y los de una ciudad del proveedor. */
export interface CityOverlap {
  readonly sourceCityId: string;
  readonly targetCityCode: string;
  readonly matched: number;
}

export interface DestinationCandidate {
  readonly city: TargetCity;
  readonly distanceKm: number;
  readonly overlap: number;
}

export type DestinationDecision =
  | {
      readonly kind: 'accepted';
      readonly method: 'overlap' | 'centroid';
      readonly targetCityCode: string;
      readonly score: number;
    }
  | {
      readonly kind: 'ambiguous';
      readonly method: 'overlap' | 'centroid';
      readonly targets: readonly { readonly targetCityCode: string; readonly score: number }[];
    }
  | {
      readonly kind: 'none';
      /**
       * `too-far`: sin solapamiento y la ciudad más cercana está a más de r km.
       * `catalog-incomplete`: sin solapamiento, y el país de alguna candidata tiene ciudades que E3
       * todavía no pidió nunca; una de ellas podría ser la verdadera y estar más cerca.
       */
      readonly reason: 'too-far' | 'catalog-incomplete';
    };

/**
 * Un destino de la UI → a lo sumo UNA ciudad del proveedor `accepted` (05 §8.3). Más de una sólo
 * por decisión manual (una zona hotelera con código propio).
 *
 * - **Solapamiento (señal fuerte):** equivalencias aceptadas entre los hoteles del destino y los de
 *   cada candidata. Se acepta la mejor si reúne `k` o el 20 % del lado más chico y supera a la
 *   segunda por el margen; si no, `ambiguous`.
 * - **Centroide (señal débil), sólo sin ningún solapamiento:** la más cercana, a menos de r km y
 *   con la segunda a más del doble; con la segunda cerca, `ambiguous`; más lejos que r, nada.
 * - El nombre no entra: el de Despegar no se persiste (05 §8.1), y dos ciudades homónimas del mismo
 *   país nunca se resolverían sólo por nombre (§8.3 punto 5).
 */
export function decideDestination(
  source: SourceCity,
  candidates: readonly DestinationCandidate[],
  incompleteCountries: ReadonlySet<string>,
  rules: DestinationMapRules = DESTINATION_MAP_RULES,
): DestinationDecision | undefined {
  if (candidates.length === 0) return undefined;

  const overlapping = candidates
    .filter((c) => c.overlap > 0)
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        a.distanceKm - b.distanceKm ||
        a.city.cityCode.localeCompare(b.city.cityCode),
    );
  const overlapScore = (c: DestinationCandidate): number => {
    const smaller = Math.min(source.hotelCount, c.city.hotelCount ?? source.hotelCount);
    return roundScore(Math.min(1, c.overlap / Math.max(1, smaller)));
  };
  const [best, second] = overlapping;
  if (best !== undefined) {
    const smaller = Math.min(source.hotelCount, best.city.hotelCount ?? source.hotelCount);
    const strong =
      best.overlap >= rules.minOverlap ||
      (smaller > 0 && best.overlap >= rules.minOverlapShare * smaller);
    const clear = second === undefined || best.overlap >= rules.overlapMargin * second.overlap;
    if (strong && clear) {
      return {
        kind: 'accepted',
        method: 'overlap',
        targetCityCode: best.city.cityCode,
        score: overlapScore(best),
      };
    }
    return {
      kind: 'ambiguous',
      method: 'overlap',
      targets: overlapping
        .slice(0, rules.maxAmbiguousTargets)
        .map((c) => ({ targetCityCode: c.city.cityCode, score: overlapScore(c) })),
    };
  }

  const byDistance = [...candidates].sort(
    (a, b) => a.distanceKm - b.distanceKm || a.city.cityCode.localeCompare(b.city.cityCode),
  );
  const nearest = byDistance[0] as DestinationCandidate;
  if (nearest.distanceKm > rules.centroidMaxKm) return { kind: 'none', reason: 'too-far' };
  if (byDistance.some((c) => incompleteCountries.has(c.city.countryCode))) {
    return { kind: 'none', reason: 'catalog-incomplete' };
  }
  const centroidScore = (c: DestinationCandidate): number =>
    roundScore(Math.max(0, 1 - c.distanceKm / rules.centroidMaxKm));
  const next = byDistance[1];
  if (next === undefined || next.distanceKm > rules.centroidSecondFactor * nearest.distanceKm) {
    return {
      kind: 'accepted',
      method: 'centroid',
      targetCityCode: nearest.city.cityCode,
      score: centroidScore(nearest),
    };
  }
  return {
    kind: 'ambiguous',
    method: 'centroid',
    targets: byDistance
      .filter((c) => c.distanceKm <= rules.centroidSecondFactor * nearest.distanceKm)
      .slice(0, rules.maxAmbiguousTargets)
      .map((c) => ({ targetCityCode: c.city.cityCode, score: centroidScore(c) })),
  };
}

/**
 * Índice de ciudades por celdas de ~R km, para no medir cada destino contra cada ciudad: con
 * decenas de miles de destinos y de ciudades, el producto no cabe en una corrida.
 */
class CityGrid {
  readonly #cellDeg: number;
  readonly #cells = new Map<string, { city: TargetCity; centroid: GeoPoint }[]>();

  constructor(radiusKm: number) {
    // 111,32 km por grado de latitud; la celda nunca es menor que el radio en latitud.
    this.#cellDeg = Math.max(radiusKm / 111.32, 0.01);
  }

  add(city: TargetCity, centroid: GeoPoint): void {
    const key = this.#key(this.#cell(centroid.lat), this.#cell(centroid.lng));
    const bucket = this.#cells.get(key) ?? [];
    bucket.push({ city, centroid });
    this.#cells.set(key, bucket);
  }

  near(point: GeoPoint, radiusKm: number): DestinationCandidate[] {
    const cosLat = Math.cos(toRadians(Math.min(Math.abs(point.lat), 89)));
    // Un grado de longitud mide 111,32 · cos(lat) km: cuántas celdas hacen falta hacia cada lado.
    const lngSpan = Math.ceil(radiusKm / (111.32 * cosLat) / this.#cellDeg);
    const latCell = this.#cell(point.lat);
    const lngCell = this.#cell(point.lng);
    const out: DestinationCandidate[] = [];
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLng = -lngSpan; dLng <= lngSpan; dLng += 1) {
        for (const entry of this.#cells.get(this.#key(latCell + dLat, lngCell + dLng)) ?? []) {
          const distanceKm = haversineMeters(point, entry.centroid) / 1_000;
          if (distanceKm <= radiusKm) out.push({ city: entry.city, distanceKm, overlap: 0 });
        }
      }
    }
    return out;
  }

  #cell(degrees: number): number {
    return Math.floor(degrees / this.#cellDeg);
  }

  #key(lat: number, lng: number): string {
    return `${lat}|${lng}`;
  }
}

export interface DestinationPlanInput {
  readonly sources: readonly SourceCity[];
  /** Las ciudades del proveedor en los países de la corrida: el alcance. */
  readonly targets: readonly TargetCity[];
  readonly overlaps: readonly CityOverlap[];
  /** Filas guardadas entre el destino de la UI y este proveedor. */
  readonly stored: readonly DestinationRow[];
  readonly rules?: DestinationMapRules;
}

export interface DestinationCounts {
  /** Destinos con alguna ciudad del proveedor a menos de R km. */
  readonly sourcesInScope: number;
  readonly acceptedOverlap: number;
  readonly acceptedCentroid: number;
  readonly ambiguous: number;
  readonly tooFar: number;
  readonly catalogIncomplete: number;
  /** Destinos con alguna fila manual: los decide una persona y el recálculo no los toca. */
  readonly manualOwned: number;
  readonly unchanged: number;
  /**
   * Filas automáticas `accepted` del alcance, y las que dejarían de estarlo. Sin las de destinos
   * con fila manual: su baja es la decisión de una persona, no un catálogo roto, y contarla
   * retendría el mapa en cada corrida mientras esa decisión siga ahí, con la fila automática
   * vieja sumada a la manual en la búsqueda.
   */
  readonly acceptedInScope: number;
  readonly acceptedLost: number;
}

export interface DestinationPlan {
  /** Filas a escribir: `overlap` o `centroid`, nunca `manual`. */
  readonly upserts: readonly DestinationRow[];
  /** Filas no manuales que pasan a `rejected`. */
  readonly demotions: readonly DestinationRef[];
  readonly counts: DestinationCounts;
  /** Países con ciudades que E3 nunca pidió: sin centroide para comparar, no se acepta por distancia. */
  readonly incompleteCountries: readonly string[];
}

const destinationKey = (sourceCityId: string, targetCityCode: string): string =>
  `${sourceCityId}|${targetCityCode}`;

function sameDestination(stored: DestinationRow | undefined, desired: DestinationRow): boolean {
  return (
    stored !== undefined &&
    stored.method === desired.method &&
    stored.status === desired.status &&
    stored.score !== null &&
    desired.score !== null &&
    Math.abs(stored.score - desired.score) < 0.0005
  );
}

/**
 * El recálculo de `hotel_destination_map` para las ciudades del proveedor de la corrida (05 §8.3):
 * `decideDestination` por destino y, después, las bajas.
 *
 * - **Un destino con alguna fila `manual` es de una persona:** no se calcula, y sus filas
 *   automáticas pasan a `rejected` para que la decisión humana no termine sumada a la heurística.
 * - Una fila automática que el recálculo ya no produce pasa a `rejected` (nunca `DELETE`), si su
 *   ciudad es del alcance o su destino se decidió en esta pasada.
 * - **Un destino que queda sin decidir porque E3 no terminó de recorrer el país conserva lo que
 *   tenía:** la lista de ciudades se refresca cada semana y trae ciudades nuevas que E3 todavía no
 *   pidió; darle de baja el mapeo mientras tanto dejaría de consultar a TBO en ese destino por un
 *   motivo que no es suyo.
 */
export function planDestinationMap(input: DestinationPlanInput): DestinationPlan {
  const rules = input.rules ?? DESTINATION_MAP_RULES;
  const incomplete = new Set(
    input.targets.filter((city) => !city.attempted).map((city) => city.countryCode),
  );
  const grid = new CityGrid(rules.radiusKm);
  const scopeTargets = new Set<string>();
  for (const city of input.targets) {
    scopeTargets.add(city.cityCode);
    if (city.centroid !== null) grid.add(city, city.centroid);
  }
  const overlaps = new Map<string, number>();
  for (const o of input.overlaps) {
    overlaps.set(destinationKey(o.sourceCityId, o.targetCityCode), o.matched);
  }
  const manualSources = new Set(
    input.stored.filter((row) => row.method === 'manual').map((row) => row.sourceCityId),
  );

  const desired = new Map<string, DestinationRow>();
  const decided = new Set<string>();
  const pending = new Set<string>();
  let sourcesInScope = 0;
  let acceptedOverlap = 0;
  let acceptedCentroid = 0;
  let ambiguous = 0;
  let tooFar = 0;
  let catalogIncomplete = 0;
  const manualOwned = new Set<string>();
  for (const source of input.sources) {
    if (source.centroid === null) continue;
    const candidates = grid.near(source.centroid, rules.radiusKm).map((c) => ({
      ...c,
      overlap: overlaps.get(destinationKey(source.cityId, c.city.cityCode)) ?? 0,
    }));
    if (candidates.length === 0) continue;
    sourcesInScope += 1;
    if (manualSources.has(source.cityId)) {
      manualOwned.add(source.cityId);
      continue;
    }
    decided.add(source.cityId);
    const decision = decideDestination(source, candidates, incomplete, rules);
    if (decision === undefined) continue;
    if (decision.kind === 'none') {
      if (decision.reason === 'too-far') {
        tooFar += 1;
      } else {
        catalogIncomplete += 1;
        pending.add(source.cityId);
      }
      continue;
    }
    if (decision.kind === 'accepted') {
      if (decision.method === 'overlap') acceptedOverlap += 1;
      else acceptedCentroid += 1;
      desired.set(destinationKey(source.cityId, decision.targetCityCode), {
        sourceCityId: source.cityId,
        targetCityCode: decision.targetCityCode,
        method: decision.method,
        score: decision.score,
        status: 'accepted',
      });
      continue;
    }
    ambiguous += 1;
    for (const target of decision.targets) {
      desired.set(destinationKey(source.cityId, target.targetCityCode), {
        sourceCityId: source.cityId,
        targetCityCode: target.targetCityCode,
        method: decision.method,
        score: target.score,
        status: 'ambiguous',
      });
    }
  }

  const storedByKey = new Map(
    input.stored.map((row) => [destinationKey(row.sourceCityId, row.targetCityCode), row]),
  );
  const demotions: DestinationRef[] = [];
  let acceptedInScope = 0;
  let acceptedLost = 0;
  for (const row of input.stored) {
    if (row.method === 'manual' || pending.has(row.sourceCityId)) continue;
    const humanOwned = manualSources.has(row.sourceCityId);
    const inScope =
      scopeTargets.has(row.targetCityCode) || decided.has(row.sourceCityId) || humanOwned;
    if (!inScope) continue;
    const key = destinationKey(row.sourceCityId, row.targetCityCode);
    const next = desired.get(key);
    if (row.status === 'accepted' && !humanOwned) {
      acceptedInScope += 1;
      if (next?.status !== 'accepted') acceptedLost += 1;
    }
    if (next === undefined && row.status !== 'rejected') {
      demotions.push({ sourceCityId: row.sourceCityId, targetCityCode: row.targetCityCode });
    }
  }

  const upserts: DestinationRow[] = [];
  let unchanged = 0;
  for (const [key, row] of desired) {
    if (sameDestination(storedByKey.get(key), row)) unchanged += 1;
    else upserts.push(row);
  }

  return {
    upserts,
    demotions,
    incompleteCountries: [...incomplete].sort(),
    counts: {
      sourcesInScope,
      acceptedOverlap,
      acceptedCentroid,
      ambiguous,
      tooFar,
      catalogIncomplete,
      manualOwned: manualOwned.size,
      unchanged,
      acceptedInScope,
      acceptedLost,
    },
  };
}

// ───────────────────────── Guarda de caída ─────────────────────────

/**
 * Pérdidas de `accepted` por debajo de este número son el recambio normal de un catálogo vivo y se
 * aplican siempre. Sin este piso, un país con dos equivalencias que pasan legítimamente a `review`
 * quedaría retenido para siempre, y una fusión falsa que ya no se sostiene seguiría agrupando.
 */
export const E6_GUARD_MIN_LOSSES = 20;

/**
 * Como la guarda del barrido de E3 (05 §6.5): si un recálculo deja de aceptar más de
 * `TBO_SYNC_SWEEP_MAX_DROP` de lo aceptado en su alcance, es más probable un catálogo roto (el de
 * Despegar vacío tras una descarga fallida, coordenadas corridas) que media red de equivalencias
 * cambiada de golpe. Entonces no se escribe nada y se reintenta en la próxima corrida. Importa
 * sobre todo para el mapa de destinos: sin él, la búsqueda deja de consultar a TBO.
 */
export function isMassLoss(
  counts: { readonly acceptedInScope: number; readonly acceptedLost: number },
  maxDrop: number,
): boolean {
  return (
    counts.acceptedLost >= E6_GUARD_MIN_LOSSES &&
    counts.acceptedLost / Math.max(1, counts.acceptedInScope) > maxDrop
  );
}
