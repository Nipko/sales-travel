/**
 * Airport search — 8800+ IATA airports.
 *
 * The full dataset lives in src/data/airports-full.json and is loaded
 * via dynamic import(). Next.js automatically code-splits it into a
 * separate chunk served from /_next/static/chunks/ — no public/ files,
 * no fetch, no Docker issues.
 */

export interface Airport {
  code: string;
  name: string;
  city: string;
  country: string;
  /** ISO-3166-1 alpha-2. Cadena vacía cuando el origen no lo trae. */
  countryCode: string;
  /**
   * Escala del dataset: 3 = aeropuerto mayor, 2 = medio, 1 = pista menor.
   * 0 significa SIN DATO (las filas del endpoint `/api/airports` no traen la columna),
   * no "diminuto": el ranking le da bonus cero en vez de castigarlo.
   */
  size: number;
  /**
   * Con vuelos regulares programados. `null` = NO LO SABEMOS (las filas del endpoint no
   * traen la columna). La diferencia con `false` es de negocio: `false` significa que este
   * aeropuerto no se puede vender, y el ranking lo usa para degradarlo; `null` no degrada
   * nada, porque no sabemos nada.
   */
  scheduled: boolean | null;
}

interface RawAirport {
  c: string;
  n: string;
  t: string;
  cc: string;
  cn: string;
  la: number;
  lo: number;
  s: number;
  sc: boolean;
  k?: string;
}

interface AirportInternal extends Airport {
  _keywords?: string;
}

// ─── Inline popular airports (always available, zero latency) ───

const POPULAR: AirportInternal[] = [
  {
    code: 'BOG',
    name: 'El Dorado Intl',
    city: 'Bogotá',
    country: 'Colombia',
    countryCode: 'CO',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MDE',
    name: 'José María Córdova Intl',
    city: 'Medellín',
    country: 'Colombia',
    countryCode: 'CO',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CTG',
    name: 'Rafael Núñez Intl',
    city: 'Cartagena',
    country: 'Colombia',
    countryCode: 'CO',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CLO',
    name: 'Alfonso Bonilla Aragón Intl',
    city: 'Cali',
    country: 'Colombia',
    countryCode: 'CO',
    size: 3,
    scheduled: true,
  },
  {
    code: 'LIM',
    name: 'Jorge Chávez Intl',
    city: 'Lima',
    country: 'Perú',
    countryCode: 'PE',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CUZ',
    name: 'Alejandro Velasco Astete Intl',
    city: 'Cusco',
    country: 'Perú',
    countryCode: 'PE',
    size: 2,
    scheduled: true,
  },
  {
    code: 'GRU',
    name: 'Guarulhos Intl',
    city: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    size: 3,
    scheduled: true,
  },
  {
    code: 'GIG',
    name: 'Galeão Intl',
    city: 'Río de Janeiro',
    country: 'Brasil',
    countryCode: 'BR',
    size: 3,
    scheduled: true,
  },
  {
    code: 'SCL',
    name: 'Arturo Merino Benítez Intl',
    city: 'Santiago',
    country: 'Chile',
    countryCode: 'CL',
    size: 3,
    scheduled: true,
  },
  {
    code: 'EZE',
    name: 'Ministro Pistarini Intl',
    city: 'Buenos Aires',
    country: 'Argentina',
    countryCode: 'AR',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MIA',
    name: 'Miami Intl',
    city: 'Miami',
    country: 'Estados Unidos',
    countryCode: 'US',
    size: 3,
    scheduled: true,
  },
  {
    code: 'JFK',
    name: 'John F. Kennedy Intl',
    city: 'Nueva York',
    country: 'Estados Unidos',
    countryCode: 'US',
    size: 3,
    scheduled: true,
  },
  {
    code: 'PTY',
    name: 'Tocumen Intl',
    city: 'Ciudad de Panamá',
    country: 'Panamá',
    countryCode: 'PA',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MEX',
    name: 'Benito Juárez Intl',
    city: 'Ciudad de México',
    country: 'México',
    countryCode: 'MX',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CUN',
    name: 'Cancún Intl',
    city: 'Cancún',
    country: 'México',
    countryCode: 'MX',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MAD',
    name: 'Adolfo Suárez Madrid-Barajas',
    city: 'Madrid',
    country: 'España',
    countryCode: 'ES',
    size: 3,
    scheduled: true,
  },
  {
    code: 'UIO',
    name: 'Mariscal Sucre Intl',
    city: 'Quito',
    country: 'Ecuador',
    countryCode: 'EC',
    size: 3,
    scheduled: true,
  },
  {
    code: 'PUJ',
    name: 'Punta Cana Intl',
    city: 'Punta Cana',
    country: 'Rep. Dominicana',
    countryCode: 'DO',
    size: 3,
    scheduled: true,
  },
  {
    code: 'BAQ',
    name: 'Ernesto Cortissoz Intl',
    city: 'Barranquilla',
    country: 'Colombia',
    countryCode: 'CO',
    size: 2,
    scheduled: true,
  },
  {
    code: 'SMR',
    name: 'Simón Bolívar Intl',
    city: 'Santa Marta',
    country: 'Colombia',
    countryCode: 'CO',
    size: 2,
    scheduled: true,
  },
];

/** Índice de la lista curada de arriba, para el bonus de relevancia. */
const CURATED_CODES: ReadonlySet<string> = new Set(POPULAR.map((a) => a.code));

// ─── Full dataset (dynamic import — Next.js bundles as chunk) ───

let fullDataset: AirportInternal[] | null = null;
let loadPromise: Promise<AirportInternal[]> | null = null;

function mapRaw(raw: RawAirport): AirportInternal {
  return {
    code: raw.c,
    name: raw.n,
    city: raw.t,
    country: raw.cn,
    countryCode: raw.cc,
    size: raw.s,
    scheduled: raw.sc,
    _keywords: raw.k,
  };
}

export function loadFullDataset(): Promise<AirportInternal[]> {
  if (fullDataset) return Promise.resolve(fullDataset);
  if (loadPromise) return loadPromise;

  loadPromise = import('../data/airports-full.json')
    .then((mod) => {
      fullDataset = (mod.default as RawAirport[]).map(mapRaw);
      return fullDataset;
    })
    .catch(() => {
      loadPromise = null;
      return POPULAR;
    });

  return loadPromise;
}

export function isDatasetLoaded(): boolean {
  return fullDataset !== null;
}

// ─── Normalización de filas ajenas ──────────────────────────────

interface ServerAirportRow {
  code?: unknown;
  name?: unknown;
  city?: unknown;
  country?: unknown;
  countryName?: unknown;
  countryCode?: unknown;
  size?: unknown;
  scheduled?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Convierte una fila del endpoint `/api/airports` al modelo que pinta el combobox.
 *
 * El endpoint devuelve `{ code, name, city, countryCode, countryName }` —sin `country`,
 * sin `size` y sin `scheduled`—, y el cliente lo casteaba a `Airport` sin mirar. Resultado
 * en pantalla: la línea del país salía vacía y quedaba un separador «·» colgando. Aquí se
 * mapea `countryName → country` y se deja `size: 0` / `scheduled: null`, que el ranking
 * lee como "sin señal de importancia" y no como "aeropuerto diminuto ni cerrado".
 *
 * Devuelve `null` si falta el código IATA: sin él la fila no es seleccionable.
 */
export function normalizeAirport(raw: unknown): Airport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as ServerAirportRow;
  const code = asString(row.code).toUpperCase();
  if (!code) return null;

  const city = asString(row.city);
  const name = asString(row.name);
  return {
    code,
    name: name || city,
    city: city || name || code,
    country: asString(row.country) || asString(row.countryName),
    countryCode: asString(row.countryCode).toUpperCase(),
    size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : 0,
    scheduled: typeof row.scheduled === 'boolean' ? row.scheduled : null,
  };
}

// ─── Relevancia de negocio ──────────────────────────────────────

/**
 * Mercado inicial de la plataforma (CLAUDE.md): Colombia, Perú y Brasil.
 *
 * Esto NO está personalizado por tenant: el combobox no recibe hoy el país de la agencia
 * (vive en la config del tenant, que no llega hasta este componente). Es un sesgo fijo a
 * LATAM, no un perfil del vendedor. `RankOptions.homeMarkets` existe para el día en que
 * la página sí pase el país del tenant; mientras nadie lo pase, manda este default.
 */
export const DEFAULT_HOME_MARKETS: readonly string[] = ['CO', 'PE', 'BR'];

/** LATAM ampliada + las puertas de entrada que una agencia LATAM vende a diario. */
const REGIONAL_MARKETS: ReadonlySet<string> = new Set([
  'CO',
  'PE',
  'BR',
  'MX',
  'AR',
  'CL',
  'EC',
  'BO',
  'PY',
  'UY',
  'VE',
  'PA',
  'CR',
  'GT',
  'SV',
  'HN',
  'NI',
  'DO',
  'CU',
  'PR',
  'US',
  'ES',
  'PT',
]);

// Tramos de "cómo hizo match" el aeropuerto con lo que el usuario escribió.
const MATCH_CODE_EXACT = 1000;
/**
 * Mismo IATA exacto, pero de un aeropuerto SIN vuelos regulares.
 *
 * Queda por debajo de lo que puede alcanzar un hub del mercado (500 + 255 = 755) y muy por
 * encima de cualquier coincidencia parcial, así que sigue apareciendo arriba pero deja de
 * tapar lo vendible: teclear "nei" ofrece Neiva antes que Terney (Rusia, una pista sin
 * vuelos que casualmente se llama NEI), y "car" ofrece Cartagena antes que Caribou.
 */
const MATCH_CODE_EXACT_DORMANT = 620;
const MATCH_CODE_PREFIX = 560;
const MATCH_CITY_PREFIX = 500;
const MATCH_ALIAS_EXACT = 400;
const MATCH_ALIAS_PREFIX = 340;
const MATCH_CITY_CONTAINS = 300;
const MATCH_NAME_CONTAINS = 240;
const MATCH_ALIAS_CONTAINS = 200;
const MATCH_COUNTRY_PREFIX = 160;
const MATCH_COUNTRY_CONTAINS = 120;
const MATCH_ALL_WORDS = 80;

/**
 * Un match exacto de ciudad vale según CUÁNTO escribió el usuario.
 *
 * Este es el bug que reportó el founder: "Bo" (Sierra Leona) ganaba a Bogotá porque
 * `city === query` puntuaba fijo y altísimo. Con dos letras, la "exactitud" no es señal:
 * hay ciudades de dos y tres letras en todo el mundo. Con seis, sí lo es.
 */
const EXACT_CITY_MAX_BONUS = 200;
const EXACT_CITY_FULL_LEN = 6;

// Bonus de relevancia: qué tan vendible es este aeropuerto para una agencia LATAM.
const MARKET_HOME = 110;
const MARKET_REGIONAL = 55;
const SIZE_STEP = 30;
/**
 * Mayor que un escalón de `size` a propósito: un aeropuerto mediano al que sí se vuela le
 * gana a uno grande al que no. Lo que no tiene vuelos regulares no se puede cotizar,
 * por mucha pista que tenga.
 */
const SCHEDULED_BONUS = 40;
/** Estar en la lista curada de arriba desempata los `size: 3` que el dataset no distingue. */
const CURATED_BONUS = 45;

export interface RankOptions {
  /** ISO-3166-1 alpha-2 de los mercados del vendedor. Sin esto, `DEFAULT_HOME_MARKETS`. */
  homeMarkets?: readonly string[];
}

// ─── Search ─────────────────────────────────────────────────────

function normalize(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      // Rango de marcas diacríticas combinantes, escapado: escrito literal son caracteres
      // invisibles que cualquier reencode del fichero puede romper sin que se note.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function exactCityBonus(query: string): number {
  const weight = Math.min(query.length, EXACT_CITY_FULL_LEN) / EXACT_CITY_FULL_LEN;
  return Math.round(weight * EXACT_CITY_MAX_BONUS);
}

function matchScore(airport: AirportInternal, query: string): number {
  const code = airport.code.toLowerCase();
  const city = normalize(airport.city);
  const name = normalize(airport.name);
  const country = normalize(airport.country);
  const keywords = airport._keywords;

  // El IATA exacto es una instrucción, no una pista: el vendedor dictó tres letras que
  // identifican un aeropuerto y sólo uno. Queda por encima de cualquier bonus posible
  // (1000 vs. 700 + 255 como máximo), para que teclear un código sea siempre predecible.
  //
  // La excepción es el aeropuerto que SABEMOS que no tiene vuelos regulares: ahí no hay
  // nada que cotizar, así que esas tres letras no pueden ser lo que quiso decir quien está
  // armando una venta. `scheduled === null` —fila del endpoint, sin el dato— no cuenta
  // como excepción: no castigamos lo que no sabemos.
  if (code === query) {
    return airport.scheduled === false ? MATCH_CODE_EXACT_DORMANT : MATCH_CODE_EXACT;
  }

  let best = 0;
  if (city === query) best = MATCH_CITY_PREFIX + exactCityBonus(query);
  if (code.startsWith(query)) best = Math.max(best, MATCH_CODE_PREFIX);
  if (city.startsWith(query)) best = Math.max(best, MATCH_CITY_PREFIX);
  if (best > 0) return best;

  if (keywords) {
    for (const kw of keywords.split(' ')) {
      if (kw === query) return MATCH_ALIAS_EXACT;
      if (kw.startsWith(query)) return MATCH_ALIAS_PREFIX;
    }
  }

  if (city.includes(query)) return MATCH_CITY_CONTAINS;
  if (name.includes(query)) return MATCH_NAME_CONTAINS;
  if (keywords?.includes(query)) return MATCH_ALIAS_CONTAINS;
  if (country.startsWith(query)) return MATCH_COUNTRY_PREFIX;
  if (country.includes(query)) return MATCH_COUNTRY_CONTAINS;

  const words = query.split(' ');
  if (words.length > 1) {
    const allMatch = words.every(
      (w) => code.includes(w) || city.includes(w) || name.includes(w) || country.includes(w),
    );
    if (allMatch) return MATCH_ALL_WORDS;
  }

  return 0;
}

/**
 * Cuánto le sirve este aeropuerto a quien está vendiendo, independiente de la búsqueda.
 *
 * Máximo 255 puntos, elegido a propósito: alcanza para que un hub del mercado suba un
 * tramo de match (BOG por prefijo de ciudad le gana a "Bo" por ciudad exacta) y no alcanza
 * para saltar dos (nada le gana a un código IATA exacto de un aeropuerto que sí opera).
 */
function relevanceBonus(airport: Airport, homeMarkets: ReadonlySet<string>): number {
  const cc = airport.countryCode.toUpperCase();
  let bonus = 0;
  if (homeMarkets.has(cc)) bonus += MARKET_HOME;
  else if (REGIONAL_MARKETS.has(cc)) bonus += MARKET_REGIONAL;
  // `size` 0 (sin dato) no resta: sólo deja de sumar.
  bonus += Math.max(0, Math.min(airport.size, 3) - 1) * SIZE_STEP;
  if (airport.scheduled) bonus += SCHEDULED_BONUS;
  if (CURATED_CODES.has(airport.code)) bonus += CURATED_BONUS;
  return bonus;
}

function homeMarketSet(options?: RankOptions): ReadonlySet<string> {
  const markets = options?.homeMarkets ?? DEFAULT_HOME_MARKETS;
  return new Set(markets.map((m) => m.toUpperCase()));
}

/**
 * Sólo dos criterios: el puntaje y, si empata, el código.
 *
 * `size` y `scheduled` NO se repiten aquí aunque antes desempataran: ya están dentro del
 * puntaje, con un peso que se puede leer y discutir. Duplicarlos como desempate escondía
 * el orden real en dos sitios —así es como "Bordeaux antes que Bogotá" pasó inadvertido— y
 * hacía que ajustar un peso no cambiara nada. El desempate por código no aporta criterio;
 * sólo garantiza que dos búsquedas iguales devuelvan lo mismo, venga la lista del dataset
 * local o del endpoint en otro orden.
 */
function compareScored(a: { airport: Airport; score: number }, b: typeof a): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.airport.code < b.airport.code ? -1 : a.airport.code > b.airport.code ? 1 : 0;
}

function rankInternal<T extends AirportInternal>(
  dataset: readonly T[],
  query: string,
  limit: number,
  options?: RankOptions,
): T[] {
  const q = normalize(query);
  const homeMarkets = homeMarketSet(options);
  const scored: { airport: T; score: number }[] = [];

  for (const airport of dataset) {
    const base = matchScore(airport, q);
    if (base > 0) {
      scored.push({ airport, score: base + relevanceBonus(airport, homeMarkets) });
    }
  }

  scored.sort(compareScored);
  return scored.slice(0, limit).map((r) => r.airport);
}

export function searchAirports(query: string, limit = 8, options?: RankOptions): Airport[] {
  const q = normalize(query);
  if (!q) return POPULAR.slice(0, limit);
  return rankInternal(fullDataset ?? POPULAR, q, limit, options);
}

/**
 * Reordena una lista ya obtenida (p. ej. la del endpoint) con el mismo criterio de negocio.
 *
 * El servidor ordena por código alfabético y por similitud trigram, sin idea de mercado:
 * para "bo" devuelve BOD (Bordeaux) antes que BOG. Reordenar aquí no rescata lo que el
 * servidor ya recortó fuera del `limit`, sólo lo que sí vino.
 */
export function rankAirports(
  items: readonly Airport[],
  query: string,
  options?: RankOptions,
): Airport[] {
  const q = normalize(query);
  if (!q) return [...items];
  return rankInternal(items, q, items.length, options);
}

/**
 * Frase única para lectores de pantalla, en el orden en que se busca un aeropuerto:
 * ciudad, código, aeropuerto, país. Sin ella, el lector recita los tres trozos sueltos de
 * la fila —incluido el código ISO de dos letras, que suena a ruido— sin decir qué es cada
 * uno. Omite lo que venga vacío en vez de leer separadores huérfanos.
 */
export function describeAirport(airport: Airport): string {
  const head = `${airport.city} (${airport.code})`;
  const tail = [airport.name, airport.country].filter((part) => part.length > 0).join(', ');
  return tail ? `${head} — ${tail}` : head;
}

export function getPopularAirports(limit = 8): Airport[] {
  return POPULAR.slice(0, limit);
}

// ─── Recent airports (localStorage) ─────────────────────────────

const RECENT_KEY = 'st:recent-airports';
const MAX_RECENT = 5;

export function getRecentAirports(): Airport[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const codes = JSON.parse(raw) as string[];
    return codes
      .slice(0, MAX_RECENT)
      .map((c) => getAirportByCode(c))
      .filter((a): a is Airport => !!a);
  } catch {
    return [];
  }
}

export function saveRecentAirport(code: string): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const codes: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const next = [code, ...codes.filter((c) => c !== code)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable
  }
}

export function getAirportByCode(code: string): Airport | undefined {
  const upper = code.toUpperCase();
  if (fullDataset) {
    return fullDataset.find((a) => a.code === upper);
  }
  return POPULAR.find((a) => a.code === upper);
}
