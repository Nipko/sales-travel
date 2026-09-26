import type {
  TboCatalogHotel,
  TboCity,
  TboContentLanguage,
  TboContentSource,
  TboHotelContent,
} from '@sales-travel/tbo-hotels';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  cityStats,
  isSweepAnomaly,
  normalizeName,
  sweepVerdict,
  type CityCandidate,
} from './catalog-rules.js';
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
} from './catalog-store.js';
import {
  CONTENT_WRITE_COUNTER,
  contentHash,
  contentWriteAction,
  type ContentCandidate,
  type ContentWriteCounter,
  type StoredContentRef,
} from './content-rules.js';
import {
  EARTH_RADIUS_M,
  PLATFORM_DESTINATION_PROVIDER,
  type DestinationMethod,
  type DestinationStatus,
  type HotelMatchMethod,
  type HotelMatchRow,
  type HotelMatchStatus,
} from './match-rules.js';

/**
 * El escritor del catálogo TBO sobre Postgres (docs/tbo/05 §6.5 y §7.3; tablas de la 0041).
 *
 * Reglas que no se negocian:
 *
 * - **Nunca `DELETE`.** Las bajas son `active = false`. Una corrida cortada a mitad con borrado deja
 *   ciudades vacías, y un hotel dado de baja tiene que seguir existiendo para las reservas y los
 *   vouchers ya emitidos. Lo vigila un test sobre el texto de este archivo.
 * - **Cada escritura filtra por `provider_code`.** `hotel_inventory` es compartida con el sync de
 *   Despegar, que hace `DELETE` + `INSERT` de sus filas cada noche: aquí nada puede alcanzarlas. El
 *   `INSERT … ON CONFLICT (provider_code, hotel_id)` inserta siempre con el código de TBO, así que el
 *   conflicto sólo puede ser con una fila de TBO.
 * - **Una transacción corta por ciudad**, no una por corrida: cientos de miles de filas en una sola
 *   transacción de horas bloquearían la tabla que lee la búsqueda (05 §6.1).
 * - **`hotel_content` sólo se reescribe si cambió** (`content_hash`) y un `listing` nunca pisa un
 *   `details`. `hotel_room_content` no se escribe: el detalle por habitación sigue apagado hasta
 *   tener un fixture real (08 N10; Q-65), y un test lo vigila sobre el texto de este archivo.
 * - **E6 sólo escribe lo automático.** `hotel_match` lleva filas de los DOS lados de cada
 *   equivalencia (el proveedor y el destino de la UI), porque la búsqueda sólo agrupa si ambos
 *   tienen fila; pero nunca una `manual` o `giata`, y `hotel_destination_map` nunca una `manual`:
 *   el `WHERE` de cada upsert y de cada baja lo impide aunque el plan se equivocara. E6 no toca
 *   `hotel_inventory`.
 *
 * Corre como `postgres` (el workflow del sync de Despegar hace lo mismo): la app sólo tiene
 * `SELECT` sobre estas tablas (0041 §6), y `search_logs`, que lleva RLS, se lee sin tenant.
 */

/** Lo que el escritor necesita de `pg.Client`: una sola conexión, para que el lock sea de la sesión. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface PgCatalogStoreOptions {
  readonly providerCode: string;
  /**
   * El espacio de ids del destino de la UI (hoy, el de Despegar: `PLATFORM_ID_SPACE_PROVIDER` de
   * `apps/api/src/providers/hotel-provider.types.ts`). Sale de `hotel_destination_map`.
   */
  readonly destinationSourceProvider?: string;
}

/** 'TBOS': espacio de claves del lock consultivo, para no chocar con otro `pg_advisory_lock`. */
const LOCK_NAMESPACE = 0x54424f53;

/** Parámetros propios de cada hotel en el `INSERT`; ciudad y `last_seen_at` van una sola vez. */
const HOTEL_COLUMNS = 9;
/** 4.500 parámetros por sentencia, lejos del tope de 65.535 de Postgres. */
const HOTEL_CHUNK = 500;
const CITY_CHUNK = 500;
const DEACTIVATE_CHUNK = 1_000;
/** Parámetros propios de cada fila de `hotel_content`; `fetched_at` va una sola vez. */
const CONTENT_COLUMNS = 15;
/** 3.000 parámetros por sentencia; las filas llevan HTML y JSON, así que el lote es más chico. */
const CONTENT_CHUNK = 200;
const CONTENT_READ_CHUNK = 1_000;
/** Parámetros propios de cada fila de `hotel_match`; `computed_at` va una sola vez. */
const MATCH_COLUMNS = 5;
const MATCH_CHUNK = 1_000;
/** Parámetros propios de cada fila de `hotel_destination_map`; proveedores y fecha van una vez. */
const DESTINATION_COLUMNS = 5;
const DESTINATION_CHUNK = 1_000;

/**
 * Celda de la rejilla con que el SQL de pares cruza los dos catálogos por igualdad en vez de medir
 * cada hotel contra todos: 0,01° son ~1,1 km de latitud, así que las 9 celdas vecinas cubren los
 * 150 m de la regla hasta ~82° de latitud, donde un grado de longitud ya mide menos.
 */
const PAIR_GRID_DEG = 0.01;

const EMPTY_CONTENT_WRITE: ContentWriteResult = Object.freeze({
  inserted: 0,
  rewritten: 0,
  touched: 0,
  unchanged: 0,
  protected: 0,
});

/**
 * Búsquedas recientes por ciudad del proveedor, la demanda de 05 §6.3: destinos buscados hace poco
 * (`search_logs.criteria.destinationId`, que guarda `HotelsService`) traducidos a ciudades TBO por
 * el mapa ACEPTADO de E6. Sin mapa todavía (PR-3.4), no hay demanda. Se cuentan BÚSQUEDAS, no
 * filas: un fan-out escribe una fila por proveedor con el mismo `search_group_id`, y el `COALESCE`
 * es el mismo de la cuota (0035) para las filas anteriores. La usan E3 y E4.
 */
function demandByCitySql(params: {
  readonly provider: string;
  readonly since: string;
  readonly source: string;
}): string {
  return `SELECT m.target_city_code,
                 count(DISTINCT COALESCE(s.search_group_id, s.id)) AS searches
            FROM search_logs s
            JOIN hotel_destination_map m
              ON m.source_city_id = s.criteria->>'destinationId'
           WHERE s.vertical = 'hotels'
             AND s.occurred_at >= ${params.since}
             AND m.source_provider_code = ${params.source}
             AND m.target_provider_code = ${params.provider}
             AND m.status = 'accepted'
           GROUP BY m.target_city_code`;
}

/**
 * Pares de hoteles a ≤ `$5` metros entre el proveedor (`$1`, en los países `$2`) y el destino de la
 * UI (`$3`), con la rejilla de `PAIR_GRID_DEG` (`$4`): un hash join por celda vecina, sin índice
 * geográfico (no hay PostGIS, 05 §7.2). La distancia es la haversine de `haversineMeters`, y las
 * reglas de nombre y estrellas se aplican en TypeScript (`planHotelMatches`).
 */
const HOTEL_PAIRS_SQL = `WITH tgt AS (
    SELECT h.hotel_id, h.name, h.stars::float8 AS stars, h.latitude, h.longitude,
           floor(h.latitude / $4)::int AS cell_lat, floor(h.longitude / $4)::int AS cell_lng
      FROM hotel_inventory h
      JOIN hotel_provider_city c
        ON c.provider_code = h.provider_code
       AND c.provider_city_code = h.provider_city_code
     WHERE h.provider_code = $1
       AND h.active
       AND c.country_code::text = ANY($2::text[])
       AND h.latitude IS NOT NULL
       AND h.longitude IS NOT NULL
  ), src AS (
    SELECT hotel_id, name, stars::float8 AS stars, latitude, longitude,
           floor(latitude / $4)::int AS cell_lat, floor(longitude / $4)::int AS cell_lng
      FROM hotel_inventory
     WHERE provider_code = $3
       AND active
       AND latitude IS NOT NULL
       AND longitude IS NOT NULL
  ), nearby AS (
    SELECT t.hotel_id AS target_id, t.name AS target_name, t.stars AS target_stars,
           t.latitude AS target_lat, t.longitude AS target_lng,
           s.hotel_id AS source_id, s.name AS source_name, s.stars AS source_stars,
           s.latitude AS source_lat, s.longitude AS source_lng,
           2 * ${EARTH_RADIUS_M} * asin(least(1, sqrt(
             power(sin(radians(s.latitude - t.latitude) / 2), 2)
             + cos(radians(t.latitude)) * cos(radians(s.latitude))
               * power(sin(radians(s.longitude - t.longitude) / 2), 2)))) AS distance_m
      FROM tgt t
     CROSS JOIN generate_series(-1, 1) AS d_lat(v)
     CROSS JOIN generate_series(-1, 1) AS d_lng(v)
      JOIN src s
        ON s.cell_lat = t.cell_lat + d_lat.v
       AND s.cell_lng = t.cell_lng + d_lng.v
  )
  SELECT target_id, target_name, target_stars, target_lat, target_lng,
         source_id, source_name, source_stars, source_lat, source_lng
    FROM nearby
   WHERE distance_m <= $5`;

/** FNV-1a de 32 bits con signo: la segunda mitad de la clave del lock, una por proveedor. */
export function advisoryLockKey(providerCode: string): readonly [number, number] {
  let hash = 0x811c9dc5;
  for (const char of providerCode) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return [LOCK_NAMESPACE, hash | 0];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** El primero gana, como en los mappers del ACL: un `ON CONFLICT` no admite la misma clave dos veces. */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, (_, row) => {
    const params = Array.from({ length: columns }, (_, col) => `$${row * columns + col + 1}`);
    return `(${params.join(',')})`;
  }).join(',');
}

interface HotelIdRow extends QueryResultRow {
  hotel_id: string;
}

interface PointRow extends QueryResultRow {
  latitude: number | null;
  longitude: number | null;
}

interface CandidateRow extends QueryResultRow {
  provider_city_code: string;
  country_code: string;
  hotel_count: number | null;
  synced_at: Date | null;
  last_status_code: number | null;
  demand: number;
}

interface ContentCandidateRow extends QueryResultRow {
  hotel_id: string;
  demand: number;
  /** Paralelos: el idioma y el `fetched_at` de cada fila `details`, en el mismo orden. */
  detail_langs: TboContentLanguage[];
  detail_fetched_at: Date[];
}

interface StoredContentRow extends QueryResultRow {
  hotel_id: string;
  lang: string;
  source: TboContentSource;
  content_hash: string;
}

interface PairRow extends QueryResultRow {
  target_id: string;
  target_name: string | null;
  target_stars: number | null;
  target_lat: number;
  target_lng: number;
  source_id: string;
  source_name: string | null;
  source_stars: number | null;
  source_lat: number;
  source_lng: number;
}

interface MatchRow extends QueryResultRow {
  canonical_hotel_id: string;
  provider_code: string;
  hotel_id: string;
  method: HotelMatchMethod;
  score: number | null;
  status: HotelMatchStatus;
}

interface SourceCityRow extends QueryResultRow {
  city_id: string;
  hotel_count: number;
  centroid_lat: number | null;
  centroid_lng: number | null;
}

interface TargetCityRow extends QueryResultRow {
  provider_city_code: string;
  country_code: string;
  hotel_count: number | null;
  centroid_lat: number | null;
  centroid_lng: number | null;
  attempted: boolean;
}

interface OverlapRow extends QueryResultRow {
  source_city_id: string;
  target_city_code: string;
  matched: number;
}

interface DestinationDbRow extends QueryResultRow {
  source_city_id: string;
  target_city_code: string;
  method: DestinationMethod;
  score: number | null;
  status: DestinationStatus;
}

interface UnmappedRow extends QueryResultRow {
  destination_id: string;
  searches: number;
  pending_review: boolean;
}

function point(lat: number | null, lng: number | null): { lat: number; lng: number } | null {
  return lat === null || lng === null ? null : { lat, lng };
}

interface ContentToWrite {
  readonly content: TboHotelContent;
  readonly hash: string;
}

const contentKey = (hotelId: string, lang: string): string => `${hotelId}|${lang}`;

export class PgCatalogStore implements CatalogStore {
  readonly #db: Queryable;
  readonly #provider: string;
  readonly #destinationSource: string;
  readonly #lockKey: readonly [number, number];

  constructor(db: Queryable, options: PgCatalogStoreOptions) {
    this.#db = db;
    this.#provider = options.providerCode;
    this.#destinationSource = options.destinationSourceProvider ?? PLATFORM_DESTINATION_PROVIDER;
    this.#lockKey = advisoryLockKey(options.providerCode);
  }

  async tryLock(): Promise<boolean> {
    const res = await this.#db.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked',
      [...this.#lockKey],
    );
    return res.rows[0]?.locked === true;
  }

  async unlock(): Promise<void> {
    await this.#db.query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [...this.#lockKey]);
  }

  async countCitiesByCountry(countries: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const res = await this.#db.query<{ country_code: string; cities: number }>(
      `SELECT country_code::text AS country_code, count(*)::int AS cities
         FROM hotel_provider_city
        WHERE provider_code = $1 AND country_code::text = ANY($2::text[])
        GROUP BY country_code`,
      [this.#provider, [...countries]],
    );
    return new Map(res.rows.map((row) => [row.country_code, row.cities]));
  }

  async upsertCities(countryCode: string, cities: readonly TboCity[]): Promise<number> {
    const unique = uniqueBy(cities, (city) => city.code);
    if (unique.length === 0) return 0;
    return this.#transaction(async () => {
      let written = 0;
      for (const chunk of chunks(unique, CITY_CHUNK)) {
        const values = chunk.flatMap((city) => [
          this.#provider,
          city.code,
          countryCode,
          city.name,
          normalizeName(city.name),
        ]);
        // Sólo nombre y país: centroide, conteo y checkpoint son de E3 y un refresco de la lista
        // de ciudades no puede reiniciarlos. El `WHERE` evita reescribir filas que no cambiaron.
        const res = await this.#db.query(
          `INSERT INTO hotel_provider_city
             (provider_code, provider_city_code, country_code, name, name_norm)
           VALUES ${placeholders(chunk.length, 5)}
           ON CONFLICT (provider_code, provider_city_code) DO UPDATE
              SET country_code = EXCLUDED.country_code,
                  name         = EXCLUDED.name,
                  name_norm    = EXCLUDED.name_norm
            WHERE hotel_provider_city.country_code IS DISTINCT FROM EXCLUDED.country_code
               OR hotel_provider_city.name         IS DISTINCT FROM EXCLUDED.name
               OR hotel_provider_city.name_norm    IS DISTINCT FROM EXCLUDED.name_norm`,
          values,
        );
        written += res.rowCount ?? 0;
      }
      return written;
    });
  }

  async listCityCandidates(query: CityCandidatesQuery): Promise<readonly CityCandidate[]> {
    // Sin mapa de destinos todavía, la demanda es 0 y el orden cae en "nunca sincronizadas" y "más
    // antiguas" (`selectDueCities`).
    const res = await this.#db.query<CandidateRow>(
      `SELECT c.provider_city_code,
              c.country_code::text AS country_code,
              c.hotel_count,
              c.synced_at,
              c.last_status_code,
              COALESCE(d.searches, 0)::int AS demand
         FROM hotel_provider_city c
         LEFT JOIN (${demandByCitySql({ provider: '$1', since: '$3', source: '$4' })}) d
           ON d.target_city_code = c.provider_city_code
        WHERE c.provider_code = $1
          AND c.country_code::text = ANY($2::text[])`,
      [this.#provider, [...query.countries], query.demandSince, this.#destinationSource],
    );
    return res.rows.map((row) => ({
      code: row.provider_city_code,
      countryCode: row.country_code,
      hotelCount: row.hotel_count,
      syncedAt: row.synced_at,
      lastStatusCode: row.last_status_code,
      demand: row.demand,
    }));
  }

  async writeCityHotels(input: CityHotelsWrite): Promise<CityWriteResult> {
    const hotels = uniqueBy(input.hotels, (hotel) => hotel.hotelId);
    return this.#transaction(async () => {
      const before = await this.#db.query<HotelIdRow>(
        `SELECT hotel_id FROM hotel_inventory
          WHERE provider_code = $1 AND provider_city_code = $2 AND active`,
        [this.#provider, input.cityCode],
      );
      const upserted = await this.#upsertHotels(input.cityCode, hotels, input.runStart);

      const received = new Set(hotels.map((hotel) => hotel.hotelId));
      const missing = before.rows.filter((row) => !received.has(row.hotel_id)).length;
      const verdict = sweepVerdict({
        previouslyActive: before.rows.length,
        missing,
        received: hotels.length,
        unreadable: input.unreadable,
        maxDrop: input.maxDrop,
      });

      let deactivated = 0;
      if (verdict === 'swept') {
        const res = await this.#db.query(
          `UPDATE hotel_inventory
              SET active = false
            WHERE provider_code = $1
              AND provider_city_code = $2
              AND active
              AND (last_seen_at IS NULL OR last_seen_at < $3)`,
          [this.#provider, input.cityCode, input.runStart],
        );
        deactivated = res.rowCount ?? 0;
      }

      const points = await this.#db.query<PointRow>(
        `SELECT latitude, longitude FROM hotel_inventory
          WHERE provider_code = $1 AND provider_city_code = $2 AND active`,
        [this.#provider, input.cityCode],
      );
      const stats = cityStats(points.rows);
      const checkpointAdvanced = !isSweepAnomaly(verdict);
      await this.#db.query(
        `UPDATE hotel_provider_city
            SET hotel_count      = $3,
                centroid_lat     = $4,
                centroid_lng     = $5,
                last_status_code = 200,
                synced_at        = CASE WHEN $6::boolean THEN now() ELSE synced_at END
          WHERE provider_code = $1 AND provider_city_code = $2`,
        [
          this.#provider,
          input.cityCode,
          stats.hotelCount,
          stats.centroid?.lat ?? null,
          stats.centroid?.lng ?? null,
          checkpointAdvanced,
        ],
      );

      return {
        upserted,
        previouslyActive: before.rows.length,
        missing,
        verdict,
        deactivated,
        hotelCount: stats.hotelCount,
        checkpointAdvanced,
      };
    });
  }

  async recordCityFailure(cityCode: string, statusCode: number): Promise<void> {
    await this.#db.query(
      `UPDATE hotel_provider_city SET last_status_code = $3
        WHERE provider_code = $1 AND provider_city_code = $2`,
      [this.#provider, cityCode, statusCode],
    );
  }

  async deactivateMissing(input: DeactivateMissingInput): Promise<DeactivateMissingResult> {
    return this.#transaction(async () => {
      const active = await this.#db.query<HotelIdRow & { stale: boolean }>(
        `SELECT hotel_id, (last_seen_at IS NULL OR last_seen_at < $2) AS stale
           FROM hotel_inventory
          WHERE provider_code = $1 AND active`,
        [this.#provider, input.seenSince],
      );
      const listed = new Set(input.hotelCodes);
      const unlisted = active.rows.filter((row) => !listed.has(row.hotel_id));
      // La guarda mide la lista contra TODOS los activos: una lista truncada deja fuera hoteles al
      // azar, vistos hace poco o no. Medida sólo contra los que se pueden desactivar, los protegidos
      // por su ciudad diluirían el denominador y una lista cortada a la mitad pasaría.
      const verdict = sweepVerdict({
        previouslyActive: active.rows.length,
        missing: unlisted.length,
        received: listed.size,
        unreadable: input.unreadable,
        maxDrop: input.maxDrop,
      });
      const staleIds = unlisted.filter((row) => row.stale).map((row) => row.hotel_id);

      let deactivated = 0;
      if (verdict === 'swept') {
        for (const chunk of chunks(staleIds, DEACTIVATE_CHUNK)) {
          const res = await this.#db.query(
            `UPDATE hotel_inventory
                SET active = false
              WHERE provider_code = $1
                AND active
                AND hotel_id = ANY($2::text[])
                AND (last_seen_at IS NULL OR last_seen_at < $3)`,
            [this.#provider, chunk, input.seenSince],
          );
          deactivated += res.rowCount ?? 0;
        }
      }
      return {
        previouslyActive: active.rows.length,
        missing: unlisted.length,
        verdict,
        deactivated,
      };
    });
  }

  async listContentCandidates(query: ContentCandidatesQuery): Promise<readonly ContentCandidate[]> {
    // El país es el de la CIUDAD, como en E3: el alcance de la corrida es el de sus ciudades. Sólo
    // cuenta el contenido `details`: el `listing` no tiene imágenes ni horarios y no evita pedir
    // HotelDetails.
    const res = await this.#db.query<ContentCandidateRow>(
      `SELECT h.hotel_id,
              COALESCE(d.searches, 0)::int AS demand,
              COALESCE(array_agg(hc.lang ORDER BY hc.lang) FILTER (WHERE hc.lang IS NOT NULL),
                       '{}'::text[]) AS detail_langs,
              COALESCE(array_agg(hc.fetched_at ORDER BY hc.lang) FILTER (WHERE hc.lang IS NOT NULL),
                       '{}'::timestamptz[]) AS detail_fetched_at
         FROM hotel_inventory h
         JOIN hotel_provider_city c
           ON c.provider_code = h.provider_code
          AND c.provider_city_code = h.provider_city_code
         LEFT JOIN (${demandByCitySql({ provider: '$1', since: '$3', source: '$4' })}) d
           ON d.target_city_code = h.provider_city_code
         LEFT JOIN hotel_content hc
           ON hc.provider_code = h.provider_code
          AND hc.hotel_id = h.hotel_id
          AND hc.source = 'details'
        WHERE h.provider_code = $1
          AND h.active
          AND c.country_code::text = ANY($2::text[])
          AND (NOT $5::boolean OR COALESCE(d.searches, 0) > 0)
        GROUP BY h.hotel_id, d.searches`,
      [
        this.#provider,
        [...query.countries],
        query.demandSince,
        this.#destinationSource,
        query.onlyDemand,
      ],
    );
    return res.rows.map((row) => {
      const detailsFetchedAt: Partial<Record<TboContentLanguage, Date>> = {};
      row.detail_langs.forEach((lang, index) => {
        const fetchedAt = row.detail_fetched_at[index];
        if (fetchedAt !== undefined) detailsFetchedAt[lang] = fetchedAt;
      });
      return { hotelId: row.hotel_id, demand: row.demand, detailsFetchedAt };
    });
  }

  async writeHotelContents(input: HotelContentsWrite): Promise<ContentWriteResult> {
    const contents = uniqueBy(input.contents, (content) =>
      contentKey(content.hotelId, content.lang),
    );
    if (contents.length === 0) return EMPTY_CONTENT_WRITE;
    return this.#transaction(async () => {
      // Un solo escritor por proveedor (el lock consultivo), así que lo leído no cambia antes de
      // escribir. El `WHERE` del upsert repite la regla de todos modos: la base tampoco deja que
      // un `listing` pise un `details`.
      const stored = new Map<string, StoredContentRef>();
      const hotelIds = [...new Set(contents.map((content) => content.hotelId))];
      for (const chunk of chunks(hotelIds, CONTENT_READ_CHUNK)) {
        const res = await this.#db.query<StoredContentRow>(
          `SELECT hotel_id, lang, source, content_hash FROM hotel_content
            WHERE provider_code = $1 AND hotel_id = ANY($2::text[])`,
          [this.#provider, chunk],
        );
        for (const row of res.rows) {
          stored.set(contentKey(row.hotel_id, row.lang), {
            source: row.source,
            contentHash: row.content_hash,
          });
        }
      }

      const counts: Record<ContentWriteCounter, number> = { ...EMPTY_CONTENT_WRITE };
      const toWrite: ContentToWrite[] = [];
      const toTouch: ContentToWrite[] = [];
      for (const content of contents) {
        const hash = contentHash(content);
        const action = contentWriteAction(stored.get(contentKey(content.hotelId, content.lang)), {
          source: content.source,
          contentHash: hash,
        });
        if (action === 'insert' || action === 'rewrite') toWrite.push({ content, hash });
        if (action === 'touch') toTouch.push({ content, hash });
        counts[CONTENT_WRITE_COUNTER[action]] += 1;
      }

      for (const chunk of chunks(toWrite, CONTENT_CHUNK)) {
        await this.#upsertContents(chunk, input.fetchedAt);
      }
      for (const chunk of chunks(toTouch, CONTENT_READ_CHUNK)) {
        // Mismo contenido que el guardado: sólo `fetched_at`, y sólo si la fila sigue siendo esa.
        await this.#db.query(
          `UPDATE hotel_content
              SET fetched_at = $2
            WHERE provider_code = $1
              AND source = 'details'
              AND (hotel_id, lang, content_hash) IN (
                    SELECT * FROM unnest($3::text[], $4::text[], $5::text[]))`,
          [
            this.#provider,
            input.fetchedAt,
            chunk.map((row) => row.content.hotelId),
            chunk.map((row) => row.content.lang),
            chunk.map((row) => row.hash),
          ],
        );
      }
      return counts;
    });
  }

  async listHotelMatchScope(query: HotelMatchScopeQuery): Promise<HotelMatchScope> {
    const countries = [...query.countries];
    // Activos o no: un hotel que TBO dio de baja tiene que perder su equivalencia.
    const scope = await this.#db.query<HotelIdRow>(
      `SELECT h.hotel_id
         FROM hotel_inventory h
         JOIN hotel_provider_city c
           ON c.provider_code = h.provider_code
          AND c.provider_city_code = h.provider_city_code
        WHERE h.provider_code = $1
          AND c.country_code::text = ANY($2::text[])`,
      [this.#provider, countries],
    );
    const pairs = await this.#db.query<PairRow>(HOTEL_PAIRS_SQL, [
      this.#provider,
      countries,
      this.#destinationSource,
      PAIR_GRID_DEG,
      query.maxDistanceM,
    ]);
    return {
      targetHotelIds: scope.rows.map((row) => row.hotel_id),
      pairs: pairs.rows.map((row) => ({
        target: {
          hotelId: row.target_id,
          name: row.target_name,
          stars: row.target_stars,
          location: { lat: row.target_lat, lng: row.target_lng },
        },
        source: {
          hotelId: row.source_id,
          name: row.source_name,
          stars: row.source_stars,
          location: { lat: row.source_lat, lng: row.source_lng },
        },
      })),
    };
  }

  async listHotelMatches(): Promise<readonly HotelMatchRow[]> {
    // Entera: hoy son las equivalencias de dos proveedores, y un grupo puede tener miembros fuera
    // de los países de la corrida que deciden si una fila del destino de la UI quedó huérfana.
    const res = await this.#db.query<MatchRow>(
      `SELECT canonical_hotel_id, provider_code, hotel_id, method, score::float8 AS score, status
         FROM hotel_match`,
    );
    return res.rows.map((row) => ({
      canonicalHotelId: row.canonical_hotel_id,
      providerCode: row.provider_code,
      hotelId: row.hotel_id,
      method: row.method,
      score: row.score,
      status: row.status,
    }));
  }

  async writeHotelMatches(input: HotelMatchWrite): Promise<MatchWriteResult> {
    const allowed = [this.#provider, this.#destinationSource];
    // Un plan con filas de otro proveedor es un bug del plan: que falle antes de abrir nada.
    for (const row of [...input.upserts, ...input.demotions]) {
      if (!allowed.includes(row.providerCode)) {
        throw new Error('E6: equivalencia de un proveedor que no es el de la corrida');
      }
    }
    if (input.upserts.length === 0 && input.demotions.length === 0) {
      return { written: 0, demoted: 0 };
    }
    return this.#transaction(async () => {
      let written = 0;
      for (const chunk of chunks(input.upserts, MATCH_CHUNK)) {
        const values = chunk.flatMap((row) => [
          row.canonicalHotelId,
          row.providerCode,
          row.hotelId,
          row.score,
          row.status,
        ]);
        const at = `$${chunk.length * MATCH_COLUMNS + 1}`;
        const rows = chunk
          .map((_, i) => {
            const p = (col: number): string => `$${i * MATCH_COLUMNS + col + 1}`;
            return `(${p(0)},${p(1)},${p(2)},'heuristic',${p(3)}::numeric,${p(4)},${at})`;
          })
          .join(',');
        const res = await this.#db.query(
          `INSERT INTO hotel_match
             (canonical_hotel_id, provider_code, hotel_id, method, score, status, computed_at)
           VALUES ${rows}
           ON CONFLICT (provider_code, hotel_id) DO UPDATE
              SET canonical_hotel_id = EXCLUDED.canonical_hotel_id,
                  score              = EXCLUDED.score,
                  status             = EXCLUDED.status,
                  computed_at        = EXCLUDED.computed_at
            WHERE hotel_match.method = 'heuristic'`,
          [...values, input.computedAt],
        );
        written += res.rowCount ?? 0;
      }
      let demoted = 0;
      for (const provider of allowed) {
        const ids = input.demotions
          .filter((row) => row.providerCode === provider)
          .map((row) => row.hotelId);
        for (const chunk of chunks(ids, MATCH_CHUNK)) {
          const res = await this.#db.query(
            `UPDATE hotel_match
                SET status = 'rejected', computed_at = $3
              WHERE provider_code = $1
                AND method = 'heuristic'
                AND status <> 'rejected'
                AND hotel_id = ANY($2::text[])`,
            [provider, chunk, input.computedAt],
          );
          demoted += res.rowCount ?? 0;
        }
      }
      return { written, demoted };
    });
  }

  async listDestinationScope(query: DestinationScopeQuery): Promise<DestinationScope> {
    const countries = [...query.countries];
    // Centroide de cada destino como el de `hotel_provider_city`: mediana por eje de los hoteles
    // con coordenadas, y el conteo de todos los activos (`cityStats`).
    const sources = await this.#db.query<SourceCityRow>(
      `SELECT city_id::text AS city_id,
              count(*)::int AS hotel_count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latitude)
                FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS centroid_lat,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY longitude)
                FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS centroid_lng
         FROM hotel_inventory
        WHERE provider_code = $1
          AND active
          AND city_id IS NOT NULL
        GROUP BY city_id`,
      [this.#destinationSource],
    );
    const targets = await this.#db.query<TargetCityRow>(
      `SELECT provider_city_code,
              country_code::text AS country_code,
              hotel_count,
              centroid_lat,
              centroid_lng,
              (synced_at IS NOT NULL OR last_status_code IS NOT NULL) AS attempted
         FROM hotel_provider_city
        WHERE provider_code = $1
          AND country_code::text = ANY($2::text[])`,
      [this.#provider, countries],
    );
    // Sólo equivalencias aceptadas entre hoteles activos: una en revisión no es evidencia.
    const overlaps = await this.#db.query<OverlapRow>(
      `SELECT s.city_id::text AS source_city_id,
              t.provider_city_code AS target_city_code,
              count(DISTINCT s.hotel_id)::int AS matched
         FROM hotel_match mt
         JOIN hotel_match ms
           ON ms.canonical_hotel_id = mt.canonical_hotel_id
          AND ms.provider_code = $2
          AND ms.status = 'accepted'
         JOIN hotel_inventory t
           ON t.provider_code = mt.provider_code
          AND t.hotel_id = mt.hotel_id
          AND t.active
         JOIN hotel_provider_city c
           ON c.provider_code = t.provider_code
          AND c.provider_city_code = t.provider_city_code
         JOIN hotel_inventory s
           ON s.provider_code = ms.provider_code
          AND s.hotel_id = ms.hotel_id
          AND s.active
        WHERE mt.provider_code = $1
          AND mt.status = 'accepted'
          AND c.country_code::text = ANY($3::text[])
          AND s.city_id IS NOT NULL
        GROUP BY s.city_id, t.provider_city_code`,
      [this.#provider, this.#destinationSource, countries],
    );
    const stored = await this.#db.query<DestinationDbRow>(
      `SELECT source_city_id, target_city_code, method, score::float8 AS score, status
         FROM hotel_destination_map
        WHERE source_provider_code = $1
          AND target_provider_code = $2`,
      [this.#destinationSource, this.#provider],
    );
    return {
      sources: sources.rows.map((row) => ({
        cityId: row.city_id,
        hotelCount: row.hotel_count,
        centroid: point(row.centroid_lat, row.centroid_lng),
      })),
      targets: targets.rows.map((row) => ({
        cityCode: row.provider_city_code,
        countryCode: row.country_code,
        hotelCount: row.hotel_count,
        centroid: point(row.centroid_lat, row.centroid_lng),
        attempted: row.attempted,
      })),
      overlaps: overlaps.rows.map((row) => ({
        sourceCityId: row.source_city_id,
        targetCityCode: row.target_city_code,
        matched: row.matched,
      })),
      stored: stored.rows.map((row) => ({
        sourceCityId: row.source_city_id,
        targetCityCode: row.target_city_code,
        method: row.method,
        score: row.score,
        status: row.status,
      })),
    };
  }

  async writeDestinationMap(input: DestinationMapWrite): Promise<MatchWriteResult> {
    if (input.upserts.some((row) => row.method === 'manual')) {
      throw new Error('E6: el recálculo no escribe filas manuales del mapa de destinos');
    }
    if (input.upserts.length === 0 && input.demotions.length === 0) {
      return { written: 0, demoted: 0 };
    }
    return this.#transaction(async () => {
      let written = 0;
      for (const chunk of chunks(input.upserts, DESTINATION_CHUNK)) {
        const values = chunk.flatMap((row) => [
          row.sourceCityId,
          row.targetCityCode,
          row.method,
          row.score,
          row.status,
        ]);
        // $1 y $2 son los proveedores; la fecha va al final.
        const at = `$${chunk.length * DESTINATION_COLUMNS + 3}`;
        const rows = chunk
          .map((_, i) => {
            const p = (col: number): string => `$${i * DESTINATION_COLUMNS + col + 3}`;
            return `($1,${p(0)},$2,${p(1)},${p(2)},${p(3)}::numeric,${p(4)},${at})`;
          })
          .join(',');
        const res = await this.#db.query(
          `INSERT INTO hotel_destination_map
             (source_provider_code, source_city_id, target_provider_code, target_city_code,
              method, score, status, computed_at)
           VALUES ${rows}
           ON CONFLICT (source_provider_code, source_city_id, target_provider_code, target_city_code)
           DO UPDATE
              SET method      = EXCLUDED.method,
                  score       = EXCLUDED.score,
                  status      = EXCLUDED.status,
                  computed_at = EXCLUDED.computed_at
            WHERE hotel_destination_map.method <> 'manual'`,
          [this.#destinationSource, this.#provider, ...values, input.computedAt],
        );
        written += res.rowCount ?? 0;
      }
      let demoted = 0;
      for (const chunk of chunks(input.demotions, DESTINATION_CHUNK)) {
        const res = await this.#db.query(
          `UPDATE hotel_destination_map
              SET status = 'rejected', computed_at = $3
            WHERE source_provider_code = $1
              AND target_provider_code = $2
              AND method <> 'manual'
              AND status <> 'rejected'
              AND (source_city_id, target_city_code) IN (
                    SELECT * FROM unnest($4::text[], $5::text[]))`,
          [
            this.#destinationSource,
            this.#provider,
            input.computedAt,
            chunk.map((row) => row.sourceCityId),
            chunk.map((row) => row.targetCityCode),
          ],
        );
        demoted += res.rowCount ?? 0;
      }
      return { written, demoted };
    });
  }

  async listUnmappedDestinations(
    query: UnmappedDestinationsQuery,
  ): Promise<readonly UnmappedDestination[]> {
    // Búsquedas, no filas: un fan-out escribe una fila por proveedor (mismo criterio que la demanda).
    const res = await this.#db.query<UnmappedRow>(
      `SELECT u.destination_id,
              u.searches,
              EXISTS (SELECT 1 FROM hotel_destination_map a
                       WHERE a.source_provider_code = $2
                         AND a.source_city_id = u.destination_id
                         AND a.target_provider_code = $1
                         AND a.status = 'ambiguous') AS pending_review
         FROM (SELECT s.criteria->>'destinationId' AS destination_id,
                      count(DISTINCT COALESCE(s.search_group_id, s.id))::int AS searches
                 FROM search_logs s
                WHERE s.vertical = 'hotels'
                  AND s.occurred_at >= $3
                  AND s.criteria->>'destinationId' IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM hotel_destination_map m
                                   WHERE m.source_provider_code = $2
                                     AND m.source_city_id = s.criteria->>'destinationId'
                                     AND m.target_provider_code = $1
                                     AND m.status = 'accepted')
                GROUP BY s.criteria->>'destinationId') u
        ORDER BY u.searches DESC, u.destination_id
        LIMIT $4`,
      [this.#provider, this.#destinationSource, query.since, query.limit],
    );
    return res.rows.map((row) => ({
      destinationId: row.destination_id,
      searches: row.searches,
      pendingReview: row.pending_review,
    }));
  }

  async #upsertContents(rows: readonly ContentToWrite[], fetchedAt: Date): Promise<void> {
    const values = rows.flatMap(({ content, hash }) => [
      this.#provider,
      content.hotelId,
      content.lang,
      content.name,
      content.descriptionHtml,
      JSON.stringify(content.sections.map(({ label, text }) => ({ label, text }))),
      JSON.stringify(content.facilities),
      content.attractionsHtml,
      JSON.stringify(content.images),
      content.phone,
      content.websiteUrl,
      content.checkInTime,
      content.checkOutTime,
      content.source,
      hash,
    ]);
    const fetched = `$${rows.length * CONTENT_COLUMNS + 1}`;
    const placeholders = rows
      .map((_, row) => {
        const p = (col: number): string => `$${row * CONTENT_COLUMNS + col + 1}`;
        return (
          `(${p(0)},${p(1)},${p(2)},${p(3)},${p(4)},${p(5)}::jsonb,${p(6)}::jsonb,${p(7)},` +
          `${p(8)}::jsonb,${p(9)},${p(10)},${p(11)}::time,${p(12)}::time,${p(13)},${p(14)},${fetched})`
        );
      })
      .join(',');
    // El texto y los HTML llegan ya saneados por el ACL (RNF-16): aquí no se vuelven a tocar.
    await this.#db.query(
      `INSERT INTO hotel_content
         (provider_code, hotel_id, lang, name, description_html, sections, facilities,
          attractions_html, images, phone, website_url, check_in_time, check_out_time, source,
          content_hash, fetched_at)
       VALUES ${placeholders}
       ON CONFLICT (provider_code, hotel_id, lang) DO UPDATE
          SET name             = EXCLUDED.name,
              description_html = EXCLUDED.description_html,
              sections         = EXCLUDED.sections,
              facilities       = EXCLUDED.facilities,
              attractions_html = EXCLUDED.attractions_html,
              images           = EXCLUDED.images,
              phone            = EXCLUDED.phone,
              website_url      = EXCLUDED.website_url,
              check_in_time    = EXCLUDED.check_in_time,
              check_out_time   = EXCLUDED.check_out_time,
              source           = EXCLUDED.source,
              content_hash     = EXCLUDED.content_hash,
              fetched_at       = EXCLUDED.fetched_at
        WHERE (hotel_content.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               OR hotel_content.source IS DISTINCT FROM EXCLUDED.source)
          AND NOT (hotel_content.source = 'details' AND EXCLUDED.source = 'listing')`,
      [...values, fetchedAt],
    );
  }

  async #upsertHotels(
    cityCode: string,
    hotels: readonly TboCatalogHotel[],
    runStart: Date,
  ): Promise<number> {
    let written = 0;
    for (const chunk of chunks(hotels, HOTEL_CHUNK)) {
      const values = chunk.flatMap((hotel) => [
        this.#provider,
        hotel.hotelId,
        hotel.countryCode,
        hotel.name,
        hotel.stars,
        hotel.location?.lat ?? null,
        hotel.location?.lng ?? null,
        hotel.address,
        hotel.zipcode,
      ]);
      // Ciudad y `last_seen_at` son iguales para toda la ciudad: van una vez, al final.
      const city = `$${chunk.length * HOTEL_COLUMNS + 1}`;
      const seenAt = `$${chunk.length * HOTEL_COLUMNS + 2}`;
      const rows = chunk
        .map((_, row) => {
          const params = Array.from(
            { length: HOTEL_COLUMNS },
            (_unused, col) => `$${row * HOTEL_COLUMNS + col + 1}`,
          );
          return `(${params.join(',')},${city},true,${seenAt},now())`;
        })
        .join(',');
      // La ciudad es la de la REQUEST (el ejemplo no trae `CityId`, 05 §2.5): si un hotel aparece
      // en otra ciudad, el upsert lo mueve. `city_id`, `property_type` y `merged_ids` son de
      // Despegar y quedan NULL.
      const res = await this.#db.query(
        `INSERT INTO hotel_inventory
           (provider_code, hotel_id, country_code, name, stars, latitude, longitude, address,
            zipcode, provider_city_code, active, last_seen_at, synced_at)
         VALUES ${rows}
         ON CONFLICT (provider_code, hotel_id) DO UPDATE
            SET country_code       = EXCLUDED.country_code,
                name               = EXCLUDED.name,
                stars              = EXCLUDED.stars,
                latitude           = EXCLUDED.latitude,
                longitude          = EXCLUDED.longitude,
                address            = EXCLUDED.address,
                zipcode            = EXCLUDED.zipcode,
                provider_city_code = EXCLUDED.provider_city_code,
                active             = true,
                last_seen_at       = EXCLUDED.last_seen_at,
                synced_at          = EXCLUDED.synced_at`,
        [...values, cityCode, runStart],
      );
      written += res.rowCount ?? 0;
    }
    return written;
  }

  /**
   * BEGIN/COMMIT en la misma conexión que tiene el lock. Si algo falla a mitad, ROLLBACK: la ciudad
   * queda exactamente como estaba antes de esta corrida (08 RF-30 CA 1).
   */
  async #transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.#db.query('BEGIN');
    try {
      const result = await work();
      await this.#db.query('COMMIT');
      return result;
    } catch (err) {
      await this.#db.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }
}
