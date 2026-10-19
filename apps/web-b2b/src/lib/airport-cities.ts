import { getAirportByCode, normalizeSearchText, type Airport } from './airports';

/**
 * Qué nombra el código elegido: una ciudad entera o un aeropuerto concreto.
 *
 * El código solo no alcanza: MDE es a la vez Medellín (MDE + EOH) y su aeropuerto principal.
 * El valor viaja hasta el proveedor (Sabre lo manda como `LocationType` C o A).
 */
export type LocationKind = 'city' | 'airport';

export interface CityAirport {
  readonly code: string;
  /** Nombre corto, como se dice al vender. El municipio va cuando no es la ciudad. */
  readonly name: string;
}

/**
 * Una ciudad tal como la buscan los sitios de venta de vuelos.
 *
 * Con varios aeropuertos, `code` es el código de ciudad o metropolitano de IATA y la ciudad se
 * puede elegir entera. Con uno solo, la entrada sólo existe por los `aliases`: el aeropuerto
 * está en otro municipio y nadie lo encuentra por él (Rionegro → Medellín, Palmira → Cali).
 */
export interface CityArea {
  readonly code: string;
  readonly city: string;
  readonly country: string;
  readonly countryCode: string;
  /** En el orden en que se ofrecen: primero el que usa todo el mundo. */
  readonly airports: readonly CityAirport[];
  /** Otros nombres por los que se busca: el municipio del aeropuerto, el nombre en otro idioma. */
  readonly aliases: readonly string[];
}

export const CITY_AREAS: readonly CityArea[] = [
  {
    code: 'MDE',
    city: 'Medellín',
    country: 'Colombia',
    countryCode: 'CO',
    airports: [
      { code: 'MDE', name: 'José María Córdova · Rionegro' },
      { code: 'EOH', name: 'Enrique Olaya Herrera' },
    ],
    aliases: ['rionegro', 'rio negro', 'jose maria cordova', 'olaya herrera'],
  },
  {
    code: 'CLO',
    city: 'Cali',
    country: 'Colombia',
    countryCode: 'CO',
    airports: [{ code: 'CLO', name: 'Alfonso Bonilla Aragón · Palmira' }],
    aliases: ['palmira'],
  },
  {
    code: 'BAQ',
    city: 'Barranquilla',
    country: 'Colombia',
    countryCode: 'CO',
    airports: [{ code: 'BAQ', name: 'Ernesto Cortissoz · Soledad' }],
    aliases: ['soledad'],
  },
  {
    code: 'BGA',
    city: 'Bucaramanga',
    country: 'Colombia',
    countryCode: 'CO',
    airports: [{ code: 'BGA', name: 'Palonegro · Lebrija' }],
    aliases: ['lebrija', 'palonegro'],
  },
  {
    code: 'LIM',
    city: 'Lima',
    country: 'Perú',
    countryCode: 'PE',
    airports: [{ code: 'LIM', name: 'Jorge Chávez · Callao' }],
    aliases: ['callao'],
  },
  {
    code: 'UIO',
    city: 'Quito',
    country: 'Ecuador',
    countryCode: 'EC',
    airports: [{ code: 'UIO', name: 'Mariscal Sucre · Tababela' }],
    aliases: ['tababela'],
  },
  {
    code: 'SAO',
    city: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    airports: [
      { code: 'GRU', name: 'Guarulhos' },
      { code: 'CGH', name: 'Congonhas' },
      { code: 'VCP', name: 'Viracopos · Campinas' },
    ],
    aliases: ['sao paulo', 'sampa', 'guarulhos', 'congonhas', 'campinas', 'viracopos'],
  },
  {
    code: 'RIO',
    city: 'Río de Janeiro',
    country: 'Brasil',
    countryCode: 'BR',
    airports: [
      { code: 'GIG', name: 'Galeão' },
      { code: 'SDU', name: 'Santos Dumont' },
    ],
    aliases: ['rio de janeiro', 'galeao', 'santos dumont'],
  },
  {
    code: 'BHZ',
    city: 'Belo Horizonte',
    country: 'Brasil',
    countryCode: 'BR',
    airports: [
      { code: 'CNF', name: 'Confins' },
      { code: 'PLU', name: 'Pampulha' },
    ],
    aliases: ['confins', 'pampulha'],
  },
  {
    code: 'BUE',
    city: 'Buenos Aires',
    country: 'Argentina',
    countryCode: 'AR',
    airports: [
      { code: 'EZE', name: 'Ezeiza' },
      { code: 'AEP', name: 'Aeroparque Jorge Newbery' },
    ],
    aliases: ['ezeiza', 'aeroparque'],
  },
  {
    code: 'MEX',
    city: 'Ciudad de México',
    country: 'México',
    countryCode: 'MX',
    airports: [
      { code: 'MEX', name: 'Benito Juárez' },
      { code: 'NLU', name: 'Felipe Ángeles (AIFA)' },
    ],
    aliases: ['mexico', 'cdmx', 'df', 'aifa', 'santa lucia'],
  },
  {
    code: 'NYC',
    city: 'Nueva York',
    country: 'Estados Unidos',
    countryCode: 'US',
    airports: [
      { code: 'JFK', name: 'John F. Kennedy' },
      { code: 'EWR', name: 'Newark Liberty' },
      { code: 'LGA', name: 'LaGuardia' },
    ],
    aliases: ['new york', 'newark', 'manhattan'],
  },
  {
    code: 'WAS',
    city: 'Washington',
    country: 'Estados Unidos',
    countryCode: 'US',
    airports: [
      { code: 'IAD', name: 'Dulles' },
      { code: 'DCA', name: 'Ronald Reagan' },
      { code: 'BWI', name: 'Baltimore/Washington' },
    ],
    aliases: ['baltimore', 'dulles'],
  },
  {
    code: 'CHI',
    city: 'Chicago',
    country: 'Estados Unidos',
    countryCode: 'US',
    airports: [
      { code: 'ORD', name: "O'Hare" },
      { code: 'MDW', name: 'Midway' },
    ],
    aliases: ['ohare', 'midway'],
  },
  {
    code: 'HOU',
    city: 'Houston',
    country: 'Estados Unidos',
    countryCode: 'US',
    airports: [
      { code: 'IAH', name: 'George Bush Intercontinental' },
      { code: 'HOU', name: 'William P. Hobby' },
    ],
    aliases: [],
  },
  {
    code: 'DFW',
    city: 'Dallas',
    country: 'Estados Unidos',
    countryCode: 'US',
    airports: [
      { code: 'DFW', name: 'Dallas/Fort Worth' },
      { code: 'DAL', name: 'Love Field' },
    ],
    aliases: ['fort worth'],
  },
  {
    code: 'YTO',
    city: 'Toronto',
    country: 'Canadá',
    countryCode: 'CA',
    airports: [
      { code: 'YYZ', name: 'Pearson' },
      { code: 'YTZ', name: 'Billy Bishop' },
    ],
    aliases: [],
  },
  {
    code: 'LON',
    city: 'Londres',
    country: 'Reino Unido',
    countryCode: 'GB',
    airports: [
      { code: 'LHR', name: 'Heathrow' },
      { code: 'LGW', name: 'Gatwick' },
      { code: 'STN', name: 'Stansted' },
      { code: 'LTN', name: 'Luton' },
      { code: 'LCY', name: 'London City' },
      { code: 'SEN', name: 'Southend' },
    ],
    aliases: ['london', 'heathrow', 'gatwick'],
  },
  {
    code: 'PAR',
    city: 'París',
    country: 'Francia',
    countryCode: 'FR',
    airports: [
      { code: 'CDG', name: 'Charles de Gaulle' },
      { code: 'ORY', name: 'Orly' },
      { code: 'BVA', name: 'Beauvais' },
    ],
    aliases: ['charles de gaulle', 'orly'],
  },
  {
    code: 'MIL',
    city: 'Milán',
    country: 'Italia',
    countryCode: 'IT',
    airports: [
      { code: 'MXP', name: 'Malpensa' },
      { code: 'LIN', name: 'Linate' },
      { code: 'BGY', name: 'Bérgamo' },
    ],
    aliases: ['milano', 'malpensa', 'bergamo'],
  },
  {
    code: 'ROM',
    city: 'Roma',
    country: 'Italia',
    countryCode: 'IT',
    airports: [
      { code: 'FCO', name: 'Fiumicino' },
      { code: 'CIA', name: 'Ciampino' },
    ],
    aliases: ['rome', 'fiumicino'],
  },
  {
    code: 'TYO',
    city: 'Tokio',
    country: 'Japón',
    countryCode: 'JP',
    airports: [
      { code: 'HND', name: 'Haneda' },
      { code: 'NRT', name: 'Narita' },
    ],
    aliases: ['tokyo'],
  },
  {
    code: 'SEL',
    city: 'Seúl',
    country: 'Corea del Sur',
    countryCode: 'KR',
    airports: [
      { code: 'ICN', name: 'Incheon' },
      { code: 'GMP', name: 'Gimpo' },
    ],
    aliases: ['seoul', 'incheon'],
  },
  {
    code: 'BJS',
    city: 'Pekín',
    country: 'China',
    countryCode: 'CN',
    airports: [
      { code: 'PEK', name: 'Capital' },
      { code: 'PKX', name: 'Daxing' },
    ],
    aliases: ['beijing'],
  },
  {
    code: 'OSA',
    city: 'Osaka',
    country: 'Japón',
    countryCode: 'JP',
    airports: [
      { code: 'KIX', name: 'Kansai' },
      { code: 'ITM', name: 'Itami' },
    ],
    aliases: ['kansai'],
  },
];

const AREA_BY_AIRPORT: ReadonlyMap<string, CityArea> = new Map(
  CITY_AREAS.flatMap((area) => area.airports.map((a) => [a.code, area] as const)),
);
const AREA_BY_CODE: ReadonlyMap<string, CityArea> = new Map(
  CITY_AREAS.map((area) => [area.code, area] as const),
);

export function isMultiAirport(area: CityArea): boolean {
  return area.airports.length > 1;
}

/** La ciudad a la que sirve un aeropuerto, si la conocemos. */
export function areaOfAirport(code: string): CityArea | undefined {
  return AREA_BY_AIRPORT.get(code.toUpperCase());
}

/** La ciudad que se puede elegir entera con este código (sólo las de varios aeropuertos). */
export function cityByCode(code: string): CityArea | undefined {
  const area = AREA_BY_CODE.get(code.toUpperCase());
  return area && isMultiAirport(area) ? area : undefined;
}

/** Una fila del desplegable. */
export type LocationOption =
  | { readonly kind: 'city'; readonly area: CityArea }
  | {
      readonly kind: 'airport';
      readonly airport: Airport;
      /** Va debajo de su ciudad, sangrado: la fila no repite la ciudad. */
      readonly nested: boolean;
    };

export function optionCode(option: LocationOption): string {
  return option.kind === 'city' ? option.area.code : option.airport.code;
}

/** Identificador único de la fila: MDE es a la vez la ciudad y el aeropuerto. */
export function optionKey(option: LocationOption): string {
  return `${option.kind}-${optionCode(option)}`;
}

/**
 * ¿La búsqueda nombra esta ciudad? Por código de ciudad, por nombre o por alias, sin tildes.
 *
 * Con menos de tres letras el nombre no cuenta: «pa» no es París, es el comienzo de veinte
 * ciudades, y para eso ya está el ranking de aeropuertos.
 */
export function areaMatches(area: CityArea, query: string): boolean {
  const q = normalizeSearchText(query);
  if (q.length === 3 && area.code.toLowerCase() === q) return true;
  if (q.length < 3) return false;
  const city = normalizeSearchText(area.city);
  if (city.startsWith(q) || city.split(' ').some((w) => w.startsWith(q))) return true;
  // Los alias piden una letra más: con «rio», Río de Janeiro; con «rion», ya es Rionegro.
  return q.length >= 4 && area.aliases.some((alias) => normalizeSearchText(alias).startsWith(q));
}

/**
 * El aeropuerto como se muestra dentro de su ciudad: nombre corto y la ciudad a la que sirve,
 * no el municipio donde está la pista. Lo que sabemos del dataset (país, tamaño) se conserva.
 */
function airportInArea(area: CityArea, entry: CityAirport, known?: Airport): Airport {
  const base = known ?? getAirportByCode(entry.code);
  return {
    code: entry.code,
    name: entry.name,
    city: area.city,
    country: area.country,
    countryCode: area.countryCode,
    size: base?.size ?? 0,
    scheduled: base?.scheduled ?? null,
  };
}

/**
 * Agrupa una lista de aeropuertos ya ordenada por relevancia como lo hacen los sitios de venta
 * de vuelos: cada ciudad con varios aeropuertos aparece una vez, con la fila «todos los
 * aeropuertos» y debajo sus aeropuertos, en el orden de la tabla (el que todos usan primero).
 *
 * Las ciudades que la búsqueda nombra pero cuyos aeropuertos no vinieron en la lista —«rionegro»,
 * que ningún catálogo asocia a MDE— van primero: la tabla curada sabe más que el catálogo.
 *
 * `maxRows` corta por filas pero nunca parte una ciudad a la mitad.
 */
export function groupByCity(
  ranked: readonly Airport[],
  query: string,
  maxRows = 10,
): LocationOption[] {
  const known = new Map(ranked.map((a) => [a.code, a] as const));
  const named = CITY_AREAS.filter((area) => areaMatches(area, query));
  const inList = new Set(ranked.map((a) => areaOfAirport(a.code)).filter(Boolean));
  const first = named.filter((area) => !inList.has(area));

  const emitted = new Set<string>();
  const out: LocationOption[] = [];

  function emitArea(area: CityArea) {
    if (emitted.has(`area-${area.code}`)) return;
    emitted.add(`area-${area.code}`);
    const multi = isMultiAirport(area);
    if (multi) out.push({ kind: 'city', area });
    for (const entry of area.airports) {
      emitted.add(entry.code);
      out.push({
        kind: 'airport',
        airport: airportInArea(area, entry, known.get(entry.code)),
        nested: multi,
      });
    }
  }

  for (const area of first) {
    if (out.length >= maxRows) break;
    emitArea(area);
  }
  for (const airport of ranked) {
    if (out.length >= maxRows) break;
    if (emitted.has(airport.code)) continue;
    const area = areaOfAirport(airport.code);
    if (area) {
      emitArea(area);
    } else {
      emitted.add(airport.code);
      out.push({ kind: 'airport', airport, nested: false });
    }
  }
  return out;
}

/** El texto que queda en el campo al elegir. La ciudad entera lo dice, para no confundirla. */
export function optionLabel(option: LocationOption): string {
  if (option.kind === 'city') return `${option.area.city} (${option.area.code} · todos)`;
  return `${option.airport.city} (${option.airport.code})`;
}

/** Texto visible de un código ya elegido (al remontar el campo, p. ej. tras intercambiar). */
export function labelForCode(code: string, kind: LocationKind | undefined): string {
  if (!code) return '';
  const city = kind === 'city' ? cityByCode(code) : undefined;
  if (city) return optionLabel({ kind: 'city', area: city });
  const area = areaOfAirport(code);
  const airport = getAirportByCode(code);
  const cityName = area?.city ?? airport?.city;
  return cityName ? `${cityName} (${code.toUpperCase()})` : code;
}

/** Frase única para lectores de pantalla. */
export function describeOption(option: LocationOption): string {
  if (option.kind === 'city') {
    const { area } = option;
    const codes = area.airports.map((a) => a.code).join(', ');
    return `${area.city}, ${area.country} — todos los aeropuertos (${area.code}: ${codes})`;
  }
  const { airport } = option;
  const tail = [airport.name, airport.country].filter((p) => p.length > 0).join(', ');
  return `${airport.city} (${airport.code})${tail ? ` — ${tail}` : ''}`;
}

/** La clave con que se guarda una elección en «Recientes». */
export function recentKey(option: LocationOption): string {
  return option.kind === 'city' ? `city:${option.area.code}` : option.airport.code;
}

/** Recientes y populares, con la ciudad a la que sirve cada aeropuerto y no su municipio. */
export function optionsFromCodes(codes: readonly string[]): LocationOption[] {
  const out: LocationOption[] = [];
  for (const raw of codes) {
    if (raw.startsWith('city:')) {
      const area = cityByCode(raw.slice('city:'.length));
      if (area) out.push({ kind: 'city', area });
      continue;
    }
    const airport = getAirportByCode(raw);
    if (!airport) continue;
    const area = areaOfAirport(airport.code);
    const entry = area?.airports.find((a) => a.code === airport.code);
    out.push({
      kind: 'airport',
      airport: area && entry ? airportInArea(area, entry, airport) : airport,
      nested: false,
    });
  }
  return out;
}
