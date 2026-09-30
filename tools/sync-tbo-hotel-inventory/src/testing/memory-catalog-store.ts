import type {
  TboCatalogHotel,
  TboCity,
  TboContentLanguage,
  TboContentSection,
  TboContentSource,
} from '@sales-travel/tbo-hotels';
import {
  cityStats,
  isSweepAnomaly,
  normalizeName,
  sweepVerdict,
  type CityCandidate,
} from '../catalog-rules.js';
import type {
  CatalogStore,
  CityCandidatesQuery,
  CityHotelsWrite,
  CityWriteResult,
  ContentCandidatesQuery,
  ContentWriteResult,
  DeactivateMissingInput,
  DeactivateMissingResult,
  DestinationMapWrite,
  DestinationScope,
  DestinationScopeQuery,
  HotelContentsWrite,
  HotelMatchScope,
  HotelMatchScopeQuery,
  HotelMatchWrite,
  MatchWriteResult,
  UnmappedDestination,
  UnmappedDestinationsQuery,
} from '../catalog-store.js';
import {
  CONTENT_WRITE_COUNTER,
  contentHash,
  contentWriteAction,
  type ContentCandidate,
  type ContentWriteCounter,
} from '../content-rules.js';
import {
  PLATFORM_DESTINATION_PROVIDER,
  haversineMeters,
  type DestinationRow,
  type HotelMatchRow,
  type HotelPair,
  type MatchHotel,
} from '../match-rules.js';

/**
 * Doble en memoria del escritor, con las MISMAS reglas (`catalog-rules.ts`) y la misma forma de
 * fila que la 0041. Las tablas son compartidas entre proveedores igual que en Postgres, para que
 * un test pueda sembrar filas de Despegar y comprobar que nadie las toca.
 *
 * Las escrituras de una ciudad se aplican sobre una copia y se publican al final, como una
 * transacción: `failNextWrite` simula una base que se cae a mitad y deja todo como estaba.
 */

export interface MemoryHotelRow {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly cityId: number | null;
  readonly countryCode: string | null;
  readonly name: string | null;
  readonly stars: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly address: string | null;
  readonly zipcode: string | null;
  readonly providerCityCode: string | null;
  readonly active: boolean;
  readonly lastSeenAt: Date | null;
}

export interface MemoryCityRow {
  readonly providerCode: string;
  readonly code: string;
  readonly countryCode: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly hotelCount: number | null;
  readonly centroidLat: number | null;
  readonly centroidLng: number | null;
  readonly syncedAt: Date | null;
  readonly lastStatusCode: number | null;
}

/** Una fila de `hotel_content` (0041), con las columnas JSONB ya como valores. */
export interface MemoryContentRow {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly lang: TboContentLanguage;
  readonly name: string | null;
  readonly descriptionHtml: string | null;
  readonly sections: readonly TboContentSection[];
  readonly facilities: readonly string[];
  readonly attractionsHtml: string | null;
  readonly images: readonly string[];
  readonly phone: string | null;
  readonly websiteUrl: string | null;
  readonly checkInTime: string | null;
  readonly checkOutTime: string | null;
  readonly source: TboContentSource;
  readonly contentHash: string;
  readonly fetchedAt: Date;
}

/** Una fila de `hotel_destination_map` (0041) entre el destino de la UI y el proveedor. */
export interface MemoryDestinationRow extends DestinationRow {
  readonly computedAt: Date;
}

/** Una fila de `hotel_match` (0041). */
export interface MemoryMatchRow extends HotelMatchRow {
  readonly computedAt: Date;
}

const key = (provider: string, id: string): string => `${provider}|${id}`;
const destinationKey = (sourceCityId: string, targetCityCode: string): string =>
  `${sourceCityId}|${targetCityCode}`;

interface LocatedRow {
  readonly latitude: number;
  readonly longitude: number;
}

function matchHotel(row: MemoryHotelRow & LocatedRow): MatchHotel {
  return {
    hotelId: row.hotelId,
    name: row.name,
    stars: row.stars,
    location: { lat: row.latitude, lng: row.longitude },
  };
}
const contentKey = (provider: string, hotelId: string, lang: string): string =>
  `${provider}|${hotelId}|${lang}`;

export class MemoryCatalogStore implements CatalogStore {
  hotels = new Map<string, MemoryHotelRow>();
  cities = new Map<string, MemoryCityRow>();
  contents = new Map<string, MemoryContentRow>();
  /** Filas de contenido insertadas o reescritas enteras: lo que `content_hash` tiene que evitar. */
  contentRewrites = 0;
  /** La próxima escritura de contenido lanza antes de confirmar. */
  failNextContentWrite = false;
  /**
   * Búsquedas recientes por código de ciudad del proveedor, fijadas a mano. Sin valor para una
   * ciudad, la demanda sale como en Postgres: búsquedas de `searchesByDestination` de los destinos
   * con fila `accepted` hacia esa ciudad.
   */
  readonly demand = new Map<string, number>();
  /** Búsquedas recientes por `destinationId` (lo que `search_logs` da agrupado por búsqueda). */
  readonly searchesByDestination = new Map<string, number>();
  /**
   * Búsquedas recientes de una ciudad del catálogo local de este proveedor
   * (`destinationProvider` + `destinationCityCode`), por código de ciudad: no pasan por el mapa.
   */
  readonly searchesByProviderCity = new Map<string, number>();
  /** El destino de la UI: `source_provider_code` del mapa y el otro lado de las equivalencias. */
  sourceProviderCode = PLATFORM_DESTINATION_PROVIDER;
  /** `hotel_match`, de todos los proveedores. */
  matches = new Map<string, MemoryMatchRow>();
  /** `hotel_destination_map` entre `sourceProviderCode` y este proveedor. */
  destinations = new Map<string, MemoryDestinationRow>();
  /** Nombre de cada operación, en orden. */
  readonly operations: string[] = [];
  lockedElsewhere = false;
  locked = false;
  /** La próxima escritura de ciudad lanza después del upsert, antes de confirmar. */
  failNextWrite = false;

  constructor(
    readonly providerCode: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  seedHotel(row: Partial<MemoryHotelRow> & Pick<MemoryHotelRow, 'hotelId'>): void {
    const full: MemoryHotelRow = {
      providerCode: this.providerCode,
      cityId: null,
      countryCode: null,
      name: null,
      stars: null,
      latitude: null,
      longitude: null,
      address: null,
      zipcode: null,
      providerCityCode: null,
      active: true,
      lastSeenAt: null,
      ...row,
    };
    this.hotels.set(key(full.providerCode, full.hotelId), full);
  }

  seedCity(row: Partial<MemoryCityRow> & Pick<MemoryCityRow, 'code' | 'countryCode'>): void {
    const name = row.name ?? `City ${row.code}`;
    this.cities.set(key(this.providerCode, row.code), {
      providerCode: this.providerCode,
      name,
      nameNorm: normalizeName(name),
      hotelCount: null,
      centroidLat: null,
      centroidLng: null,
      syncedAt: null,
      lastStatusCode: null,
      ...row,
    });
  }

  hotel(hotelId: string, provider = this.providerCode): MemoryHotelRow | undefined {
    return this.hotels.get(key(provider, hotelId));
  }

  city(code: string): MemoryCityRow | undefined {
    return this.cities.get(key(this.providerCode, code));
  }

  match(hotelId: string, provider = this.providerCode): MemoryMatchRow | undefined {
    return this.matches.get(key(provider, hotelId));
  }

  destination(sourceCityId: string, targetCityCode: string): MemoryDestinationRow | undefined {
    return this.destinations.get(destinationKey(sourceCityId, targetCityCode));
  }

  seedMatch(row: Omit<MemoryMatchRow, 'computedAt'> & { readonly computedAt?: Date }): void {
    this.matches.set(key(row.providerCode, row.hotelId), { computedAt: this.clock(), ...row });
  }

  seedDestination(
    row: Omit<MemoryDestinationRow, 'computedAt'> & { readonly computedAt?: Date },
  ): void {
    this.destinations.set(destinationKey(row.sourceCityId, row.targetCityCode), {
      computedAt: this.clock(),
      ...row,
    });
  }

  content(hotelId: string, lang: TboContentLanguage): MemoryContentRow | undefined {
    return this.contents.get(contentKey(this.providerCode, hotelId, lang));
  }

  /** Una fila `details` ya guardada, con lo mínimo para decidir si toca pedirla otra vez. */
  seedContent(
    row: Partial<MemoryContentRow> & Pick<MemoryContentRow, 'hotelId' | 'lang' | 'fetchedAt'>,
  ): void {
    const full: MemoryContentRow = {
      providerCode: this.providerCode,
      name: null,
      descriptionHtml: null,
      sections: [],
      facilities: [],
      attractionsHtml: null,
      images: [],
      phone: null,
      websiteUrl: null,
      checkInTime: null,
      checkOutTime: null,
      source: 'details',
      contentHash: 'sembrado',
      ...row,
    };
    this.contents.set(contentKey(full.providerCode, full.hotelId, full.lang), full);
  }

  tryLock(): Promise<boolean> {
    this.operations.push('tryLock');
    if (this.lockedElsewhere || this.locked) return Promise.resolve(false);
    this.locked = true;
    return Promise.resolve(true);
  }

  unlock(): Promise<void> {
    this.operations.push('unlock');
    this.locked = false;
    return Promise.resolve();
  }

  countCitiesByCountry(countries: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    for (const city of this.cities.values()) {
      if (city.providerCode !== this.providerCode || !countries.includes(city.countryCode))
        continue;
      counts.set(city.countryCode, (counts.get(city.countryCode) ?? 0) + 1);
    }
    return Promise.resolve(counts);
  }

  upsertCities(countryCode: string, cities: readonly TboCity[]): Promise<number> {
    this.operations.push(`upsertCities:${countryCode}`);
    let written = 0;
    for (const city of cities) {
      const existing = this.city(city.code);
      const nameNorm = normalizeName(city.name);
      if (
        existing?.countryCode === countryCode &&
        existing.name === city.name &&
        existing.nameNorm === nameNorm
      ) {
        continue;
      }
      this.cities.set(key(this.providerCode, city.code), {
        hotelCount: null,
        centroidLat: null,
        centroidLng: null,
        syncedAt: null,
        lastStatusCode: null,
        ...existing,
        providerCode: this.providerCode,
        code: city.code,
        countryCode,
        name: city.name,
        nameNorm,
      });
      written += 1;
    }
    return Promise.resolve(written);
  }

  listCityCandidates(query: CityCandidatesQuery): Promise<readonly CityCandidate[]> {
    return Promise.resolve(
      [...this.cities.values()]
        .filter(
          (c) =>
            c.providerCode === this.providerCode &&
            (query.countries.includes(c.countryCode) || this.#demandOf(c.code) > 0) &&
            (query.cities === undefined || query.cities.includes(c.code)),
        )
        .map((c) => ({
          code: c.code,
          countryCode: c.countryCode,
          hotelCount: c.hotelCount,
          syncedAt: c.syncedAt,
          lastStatusCode: c.lastStatusCode,
          demand: this.#demandOf(c.code),
        })),
    );
  }

  writeCityHotels(input: CityHotelsWrite): Promise<CityWriteResult> {
    this.operations.push(`writeCityHotels:${input.cityCode}`);
    const hotels = new Map(this.hotels);
    const inCity = (row: MemoryHotelRow): boolean =>
      row.providerCode === this.providerCode &&
      row.providerCityCode === input.cityCode &&
      row.active;
    const before = [...hotels.values()].filter(inCity).map((row) => row.hotelId);

    const received = new Set<string>();
    let upserted = 0;
    for (const hotel of input.hotels) {
      if (received.has(hotel.hotelId)) continue;
      received.add(hotel.hotelId);
      hotels.set(key(this.providerCode, hotel.hotelId), this.#row(hotel, input));
      upserted += 1;
    }
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error('simulated database failure'));
    }

    const missing = before.filter((id) => !received.has(id)).length;
    const verdict = sweepVerdict({
      previouslyActive: before.length,
      missing,
      received: received.size,
      unreadable: input.unreadable,
      maxDrop: input.maxDrop,
    });
    let deactivated = 0;
    if (verdict === 'swept') {
      for (const [k, row] of hotels) {
        if (!inCity(row)) continue;
        if (row.lastSeenAt !== null && row.lastSeenAt >= input.runStart) continue;
        hotels.set(k, { ...row, active: false });
        deactivated += 1;
      }
    }
    const stats = cityStats([...hotels.values()].filter(inCity));
    const checkpointAdvanced = !isSweepAnomaly(verdict);
    const city = this.city(input.cityCode);
    if (city !== undefined) {
      this.cities.set(key(this.providerCode, input.cityCode), {
        ...city,
        hotelCount: stats.hotelCount,
        centroidLat: stats.centroid?.lat ?? null,
        centroidLng: stats.centroid?.lng ?? null,
        lastStatusCode: 200,
        syncedAt: checkpointAdvanced ? this.clock() : city.syncedAt,
      });
    }
    this.hotels = hotels;
    return Promise.resolve({
      upserted,
      previouslyActive: before.length,
      missing,
      verdict,
      deactivated,
      hotelCount: stats.hotelCount,
      checkpointAdvanced,
    });
  }

  recordCityFailure(cityCode: string, statusCode: number): Promise<void> {
    this.operations.push(`recordCityFailure:${cityCode}:${statusCode}`);
    const city = this.city(cityCode);
    if (city !== undefined) {
      this.cities.set(key(this.providerCode, cityCode), { ...city, lastStatusCode: statusCode });
    }
    return Promise.resolve();
  }

  deactivateMissing(input: DeactivateMissingInput): Promise<DeactivateMissingResult> {
    this.operations.push('deactivateMissing');
    const listed = new Set(input.hotelCodes);
    const active = [...this.hotels.values()].filter(
      (row) => row.providerCode === this.providerCode && row.active,
    );
    const unlisted = active.filter((row) => !listed.has(row.hotelId));
    const verdict = sweepVerdict({
      previouslyActive: active.length,
      missing: unlisted.length,
      received: listed.size,
      unreadable: input.unreadable,
      maxDrop: input.maxDrop,
    });
    const staleIds = unlisted
      .filter((row) => row.lastSeenAt === null || row.lastSeenAt < input.seenSince)
      .map((row) => row.hotelId);
    let deactivated = 0;
    if (verdict === 'swept') {
      for (const id of staleIds) {
        const row = this.hotel(id);
        if (row === undefined) continue;
        this.hotels.set(key(this.providerCode, id), { ...row, active: false });
        deactivated += 1;
      }
    }
    return Promise.resolve({
      previouslyActive: active.length,
      missing: unlisted.length,
      verdict,
      deactivated,
    });
  }

  listContentCandidates(query: ContentCandidatesQuery): Promise<readonly ContentCandidate[]> {
    const candidates: ContentCandidate[] = [];
    for (const hotel of this.hotels.values()) {
      if (hotel.providerCode !== this.providerCode || !hotel.active) continue;
      if (hotel.providerCityCode === null) continue;
      if (query.cities !== undefined && !query.cities.includes(hotel.providerCityCode)) continue;
      const city = this.city(hotel.providerCityCode);
      if (city === undefined) continue;
      const demand = this.#demandOf(city.code);
      if (!query.countries.includes(city.countryCode) && demand <= 0) continue;
      if (query.onlyDemand && demand <= 0) continue;
      const detailsFetchedAt: Partial<Record<TboContentLanguage, Date>> = {};
      for (const row of this.contents.values()) {
        if (row.providerCode !== this.providerCode || row.hotelId !== hotel.hotelId) continue;
        if (row.source === 'details') detailsFetchedAt[row.lang] = row.fetchedAt;
      }
      candidates.push({ hotelId: hotel.hotelId, demand, detailsFetchedAt });
    }
    return Promise.resolve(candidates);
  }

  writeHotelContents(input: HotelContentsWrite): Promise<ContentWriteResult> {
    this.operations.push(`writeHotelContents:${input.contents.length}`);
    const contents = new Map(this.contents);
    const counts: Record<ContentWriteCounter, number> = {
      inserted: 0,
      rewritten: 0,
      touched: 0,
      unchanged: 0,
      protected: 0,
    };
    const seen = new Set<string>();
    let rewrites = 0;
    for (const content of input.contents) {
      const k = contentKey(this.providerCode, content.hotelId, content.lang);
      if (seen.has(k)) continue;
      seen.add(k);
      const stored = contents.get(k);
      const hash = contentHash(content);
      const action = contentWriteAction(stored, { source: content.source, contentHash: hash });
      counts[CONTENT_WRITE_COUNTER[action]] += 1;
      if (action === 'touch' && stored !== undefined) {
        contents.set(k, { ...stored, fetchedAt: input.fetchedAt });
      } else if (action === 'insert' || action === 'rewrite') {
        rewrites += 1;
        contents.set(k, {
          providerCode: this.providerCode,
          hotelId: content.hotelId,
          lang: content.lang,
          name: content.name,
          descriptionHtml: content.descriptionHtml,
          sections: content.sections,
          facilities: content.facilities,
          attractionsHtml: content.attractionsHtml,
          images: content.images,
          phone: content.phone,
          websiteUrl: content.websiteUrl,
          checkInTime: content.checkInTime,
          checkOutTime: content.checkOutTime,
          source: content.source,
          contentHash: hash,
          fetchedAt: input.fetchedAt,
        });
      }
    }
    if (this.failNextContentWrite) {
      this.failNextContentWrite = false;
      return Promise.reject(new Error('simulated database failure'));
    }
    this.contents = contents;
    this.contentRewrites += rewrites;
    return Promise.resolve(counts);
  }

  listHotelMatchScope(query: HotelMatchScopeQuery): Promise<HotelMatchScope> {
    this.operations.push('listHotelMatchScope');
    const inScope = (row: MemoryHotelRow): boolean => {
      if (row.providerCode !== this.providerCode || row.providerCityCode === null) return false;
      const city = this.city(row.providerCityCode);
      return city !== undefined && query.countries.includes(city.countryCode);
    };
    const located = (row: MemoryHotelRow): row is MemoryHotelRow & LocatedRow =>
      row.active && row.latitude !== null && row.longitude !== null;
    const all = [...this.hotels.values()];
    const targets = all.filter(inScope);
    const sources = all.filter((row) => row.providerCode === this.sourceProviderCode);
    const locatedSources = sources.filter(located);
    const pairs: HotelPair[] = [];
    for (const target of targets.filter(located)) {
      for (const source of locatedSources) {
        const pair: HotelPair = {
          target: matchHotel(target),
          source: matchHotel(source),
        };
        if (haversineMeters(pair.target.location, pair.source.location) <= query.maxDistanceM) {
          pairs.push(pair);
        }
      }
    }
    return Promise.resolve({ pairs, targetHotelIds: targets.map((row) => row.hotelId) });
  }

  listHotelMatches(): Promise<readonly HotelMatchRow[]> {
    return Promise.resolve(
      [...this.matches.values()].map(({ computedAt: _computedAt, ...row }) => row),
    );
  }

  writeHotelMatches(input: HotelMatchWrite): Promise<MatchWriteResult> {
    this.operations.push(`writeHotelMatches:${input.upserts.length}:${input.demotions.length}`);
    const allowed = [this.providerCode, this.sourceProviderCode];
    if ([...input.upserts, ...input.demotions].some((r) => !allowed.includes(r.providerCode))) {
      return Promise.reject(
        new Error('E6: equivalencia de un proveedor que no es el de la corrida'),
      );
    }
    let written = 0;
    for (const row of input.upserts) {
      const k = key(row.providerCode, row.hotelId);
      const existing = this.matches.get(k);
      if (existing !== undefined && existing.method !== 'heuristic') continue;
      this.matches.set(k, { ...row, method: 'heuristic', computedAt: input.computedAt });
      written += 1;
    }
    let demoted = 0;
    for (const ref of input.demotions) {
      const k = key(ref.providerCode, ref.hotelId);
      const existing = this.matches.get(k);
      if (existing?.method !== 'heuristic' || existing.status === 'rejected') continue;
      this.matches.set(k, { ...existing, status: 'rejected', computedAt: input.computedAt });
      demoted += 1;
    }
    return Promise.resolve({ written, demoted });
  }

  listDestinationScope(query: DestinationScopeQuery): Promise<DestinationScope> {
    this.operations.push('listDestinationScope');
    const byCity = new Map<number, MemoryHotelRow[]>();
    for (const row of this.hotels.values()) {
      if (row.providerCode !== this.sourceProviderCode || !row.active || row.cityId === null) {
        continue;
      }
      byCity.set(row.cityId, [...(byCity.get(row.cityId) ?? []), row]);
    }
    const sources = [...byCity].map(([cityId, rows]) => {
      const stats = cityStats(rows);
      return { cityId: String(cityId), hotelCount: stats.hotelCount, centroid: stats.centroid };
    });

    const scopeCities = [...this.cities.values()].filter(
      (c) => c.providerCode === this.providerCode && query.countries.includes(c.countryCode),
    );
    const targets = scopeCities.map((c) => ({
      cityCode: c.code,
      countryCode: c.countryCode,
      hotelCount: c.hotelCount,
      centroid:
        c.centroidLat === null || c.centroidLng === null
          ? null
          : { lat: c.centroidLat, lng: c.centroidLng },
      attempted: c.syncedAt !== null || c.lastStatusCode !== null,
    }));

    const scopeCodes = new Set(scopeCities.map((c) => c.code));
    const matched = new Map<string, Set<string>>();
    const accepted = [...this.matches.values()].filter((m) => m.status === 'accepted');
    for (const mt of accepted) {
      if (mt.providerCode !== this.providerCode) continue;
      const target = this.hotel(mt.hotelId);
      if (target?.active !== true || target.providerCityCode === null) continue;
      if (!scopeCodes.has(target.providerCityCode)) continue;
      for (const ms of accepted) {
        if (ms.providerCode !== this.sourceProviderCode) continue;
        if (ms.canonicalHotelId !== mt.canonicalHotelId) continue;
        const source = this.hotel(ms.hotelId, this.sourceProviderCode);
        if (source?.active !== true || source.cityId === null) continue;
        const k = destinationKey(String(source.cityId), target.providerCityCode);
        matched.set(k, (matched.get(k) ?? new Set()).add(source.hotelId));
      }
    }
    const overlaps = [...matched].map(([k, hotels]) => {
      const [sourceCityId = '', targetCityCode = ''] = k.split('|');
      return { sourceCityId, targetCityCode, matched: hotels.size };
    });

    const stored = [...this.destinations.values()].map(
      ({ computedAt: _computedAt, ...row }) => row,
    );
    return Promise.resolve({ sources, targets, overlaps, stored });
  }

  writeDestinationMap(input: DestinationMapWrite): Promise<MatchWriteResult> {
    this.operations.push(`writeDestinationMap:${input.upserts.length}:${input.demotions.length}`);
    if (input.upserts.some((row) => row.method === 'manual')) {
      return Promise.reject(new Error('E6: el recálculo no escribe filas manuales'));
    }
    let written = 0;
    for (const row of input.upserts) {
      const k = destinationKey(row.sourceCityId, row.targetCityCode);
      if (this.destinations.get(k)?.method === 'manual') continue;
      this.destinations.set(k, { ...row, computedAt: input.computedAt });
      written += 1;
    }
    let demoted = 0;
    for (const ref of input.demotions) {
      const k = destinationKey(ref.sourceCityId, ref.targetCityCode);
      const existing = this.destinations.get(k);
      if (existing === undefined || existing.method === 'manual') continue;
      if (existing.status === 'rejected') continue;
      this.destinations.set(k, { ...existing, status: 'rejected', computedAt: input.computedAt });
      demoted += 1;
    }
    return Promise.resolve({ written, demoted });
  }

  listUnmappedDestinations(
    query: UnmappedDestinationsQuery,
  ): Promise<readonly UnmappedDestination[]> {
    const rows = [...this.destinations.values()];
    const out: UnmappedDestination[] = [];
    for (const [destinationId, searches] of this.searchesByDestination) {
      const own = rows.filter((row) => row.sourceCityId === destinationId);
      if (own.some((row) => row.status === 'accepted')) continue;
      out.push({
        destinationId,
        searches,
        pendingReview: own.some((row) => row.status === 'ambiguous'),
      });
    }
    out.sort((a, b) => b.searches - a.searches || a.destinationId.localeCompare(b.destinationId));
    return Promise.resolve(out.slice(0, query.limit));
  }

  #demandOf(cityCode: string): number {
    const fixed = this.demand.get(cityCode);
    if (fixed !== undefined) return fixed;
    let searches = this.searchesByProviderCity.get(cityCode) ?? 0;
    for (const row of this.destinations.values()) {
      if (row.targetCityCode !== cityCode || row.status !== 'accepted') continue;
      searches += this.searchesByDestination.get(row.sourceCityId) ?? 0;
    }
    return searches;
  }

  #row(hotel: TboCatalogHotel, input: CityHotelsWrite): MemoryHotelRow {
    return {
      providerCode: this.providerCode,
      hotelId: hotel.hotelId,
      cityId: null,
      countryCode: hotel.countryCode,
      name: hotel.name,
      stars: hotel.stars,
      latitude: hotel.location?.lat ?? null,
      longitude: hotel.location?.lng ?? null,
      address: hotel.address,
      zipcode: hotel.zipcode,
      providerCityCode: input.cityCode,
      active: true,
      lastSeenAt: input.runStart,
    };
  }
}
