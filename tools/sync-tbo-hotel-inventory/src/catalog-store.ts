import type { TboCatalogHotel, TboCity, TboHotelContent } from '@sales-travel/tbo-hotels';
import type { CityCandidate, SweepVerdict } from './catalog-rules.js';
import type { ContentCandidate } from './content-rules.js';
import type {
  CityOverlap,
  DestinationRef,
  DestinationRow,
  HotelMatchRow,
  HotelPair,
  HotelRef,
  SourceCity,
  TargetCity,
} from './match-rules.js';

/**
 * Lo que el sync necesita de la base, sin SQL. Lo implementa `writer.ts` sobre Postgres; los tests
 * de las etapas usan un doble en memoria con las mismas reglas (`catalog-rules.ts`).
 *
 * **No hay ninguna operación de borrado, a propósito** (05 §6.5; 08 RF-30): las bajas del catálogo
 * TBO son lógicas (`active = false`), así una corrida cortada nunca deja el catálogo vacío y un
 * hotel dado de baja conserva su fila para las reservas y los vouchers ya emitidos.
 */
export interface CatalogStore {
  /** `pg_try_advisory_lock` con la clave del proveedor: dos corridas nunca escriben a la vez (05 §6.4). */
  tryLock(): Promise<boolean>;
  unlock(): Promise<void>;

  /** Ciudades guardadas por país: un país sin ninguna necesita E2 aunque esta corrida no la incluya. */
  countCitiesByCountry(countries: readonly string[]): Promise<ReadonlyMap<string, number>>;

  /** E2: upsert de `hotel_provider_city` (código, nombre, `name_norm`, país). No toca el checkpoint. */
  upsertCities(countryCode: string, cities: readonly TboCity[]): Promise<number>;

  /** Candidatas de E3 de esos países, con su demanda reciente. El orden lo decide `selectDueCities`. */
  listCityCandidates(query: CityCandidatesQuery): Promise<readonly CityCandidate[]>;

  /** E3 de una ciudad, en UNA transacción corta: upsert, guarda, barrido y centroide. */
  writeCityHotels(input: CityHotelsWrite): Promise<CityWriteResult>;

  /** Una ciudad que no se pudo leer: sólo `last_status_code`; `synced_at` no avanza y se reintenta. */
  recordCityFailure(cityCode: string, statusCode: number): Promise<void>;

  /** E5: baja lógica de los hoteles activos que `hotelcodelist` ya no trae, con la misma guarda. */
  deactivateMissing(input: DeactivateMissingInput): Promise<DeactivateMissingResult>;

  /** E4: hoteles activos de esos países con su demanda y lo que ya tienen de HotelDetails. */
  listContentCandidates(query: ContentCandidatesQuery): Promise<readonly ContentCandidate[]>;

  /**
   * E3 (`listing`) y E4 (`details`): `hotel_content` en UNA transacción corta, decidiendo cada fila
   * con `contentWriteAction`. Nunca pisa `details` con `listing`, y una fila igual no se reescribe.
   * `hotel_room_content` no se escribe: el detalle por habitación sigue apagado (N10; Q-65).
   */
  writeHotelContents(input: HotelContentsWrite): Promise<ContentWriteResult>;

  /**
   * E6: pares de hoteles cercanos (≤ `maxDistanceM`) entre el proveedor, en los países de la
   * corrida, y el destino de la UI (Despegar), ambos activos y con coordenadas; y todos los hoteles
   * del proveedor en esos países, activos o no, que son el alcance de las bajas.
   */
  listHotelMatchScope(query: HotelMatchScopeQuery): Promise<HotelMatchScope>;

  /** E6: todo `hotel_match`, para no pisar lo manual y ver cada grupo entero. */
  listHotelMatches(): Promise<readonly HotelMatchRow[]>;

  /**
   * E6: en UNA transacción, upsert de filas `heuristic` y paso a `rejected` de las que ya no
   * valen. Una fila `manual` o `giata` no se toca, aunque el plan la nombre: la base lo impide.
   */
  writeHotelMatches(input: HotelMatchWrite): Promise<MatchWriteResult>;

  /**
   * E6: destinos de la UI con su centroide, ciudades del proveedor de los países de la corrida,
   * equivalencias aceptadas entre ambos y las filas guardadas del mapa.
   */
  listDestinationScope(query: DestinationScopeQuery): Promise<DestinationScope>;

  /** E6: igual que `writeHotelMatches`, sobre `hotel_destination_map`; lo `manual` no se toca. */
  writeDestinationMap(input: DestinationMapWrite): Promise<MatchWriteResult>;

  /**
   * Destinos buscados hace poco que no tienen ninguna ciudad del proveedor `accepted`, de más a
   * menos buscados: lo que conviene revisar a mano primero (05 §8.4).
   */
  listUnmappedDestinations(
    query: UnmappedDestinationsQuery,
  ): Promise<readonly UnmappedDestination[]>;
}

export interface HotelMatchScopeQuery {
  readonly countries: readonly string[];
  readonly maxDistanceM: number;
}

export interface HotelMatchScope {
  readonly pairs: readonly HotelPair[];
  readonly targetHotelIds: readonly string[];
}

export interface HotelMatchWrite {
  readonly upserts: readonly HotelMatchRow[];
  readonly demotions: readonly HotelRef[];
  readonly computedAt: Date;
}

export interface MatchWriteResult {
  readonly written: number;
  readonly demoted: number;
}

export interface DestinationScopeQuery {
  readonly countries: readonly string[];
}

export interface DestinationScope {
  readonly sources: readonly SourceCity[];
  readonly targets: readonly TargetCity[];
  readonly overlaps: readonly CityOverlap[];
  readonly stored: readonly DestinationRow[];
}

export interface DestinationMapWrite {
  readonly upserts: readonly DestinationRow[];
  readonly demotions: readonly DestinationRef[];
  readonly computedAt: Date;
}

export interface UnmappedDestinationsQuery {
  /** Búsquedas desde este instante. */
  readonly since: Date;
  readonly limit: number;
}

export interface UnmappedDestination {
  /** El `destinationId` de la búsqueda: un id de ciudad de Despegar, no un dato personal. */
  readonly destinationId: string;
  readonly searches: number;
  /** Tiene filas `ambiguous` esperando revisión. */
  readonly pendingReview: boolean;
}

export interface ContentCandidatesQuery {
  readonly countries: readonly string[];
  /** Sólo hoteles de estas ciudades (`TBO_SYNC_CITIES`); sin la lista, los de todo `countries`. */
  readonly cities?: readonly string[];
  readonly demandSince: Date;
  /** `true` con `TBO_SYNC_CONTENT_SCOPE=demand`: sólo hoteles de ciudades con demanda. */
  readonly onlyDemand: boolean;
}

export interface HotelContentsWrite {
  readonly contents: readonly TboHotelContent[];
  /** `fetched_at` de lo que se escribe o se confirma igual. */
  readonly fetchedAt: Date;
}

/** Cuántas filas tomaron cada camino de `contentWriteAction`. */
export interface ContentWriteResult {
  readonly inserted: number;
  readonly rewritten: number;
  readonly touched: number;
  readonly unchanged: number;
  readonly protected: number;
}

export interface CityCandidatesQuery {
  readonly countries: readonly string[];
  /** Sólo estas ciudades (`TBO_SYNC_CITIES`); sin la lista, todas las de `countries`. */
  readonly cities?: readonly string[];
  /** Búsquedas desde este instante cuentan como demanda. */
  readonly demandSince: Date;
}

export interface CityHotelsWrite {
  readonly cityCode: string;
  readonly hotels: readonly TboCatalogHotel[];
  /** Hoteles que el ACL descartó por ilegibles en esta respuesta (`ITEM_SCHEMA`). */
  readonly unreadable: number;
  /** Inicio de la corrida: `last_seen_at` de lo visto y frontera del barrido. */
  readonly runStart: Date;
  readonly maxDrop: number;
}

export interface CityWriteResult {
  readonly upserted: number;
  readonly previouslyActive: number;
  readonly missing: number;
  readonly verdict: SweepVerdict;
  readonly deactivated: number;
  readonly hotelCount: number;
  /** `false` en una anomalía: la ciudad queda pendiente para la próxima corrida. */
  readonly checkpointAdvanced: boolean;
}

export interface DeactivateMissingInput {
  /** Todos los códigos que TBO lista hoy. */
  readonly hotelCodes: readonly string[];
  readonly unreadable: number;
  /**
   * Un hotel con `last_seen_at` desde este instante lo respalda la lista de su ciudad, que es la más
   * específica (Q-61 e), y la lista global no lo da de baja.
   */
  readonly seenSince: Date;
  readonly maxDrop: number;
}

export interface DeactivateMissingResult {
  readonly previouslyActive: number;
  /** Activos que la lista global no trae, protegidos o no: la base de la guarda. */
  readonly missing: number;
  readonly verdict: SweepVerdict;
  readonly deactivated: number;
}
