/**
 * Dataset embebido de aeropuertos relevantes para el mercado LATAM.
 *
 * De dónde sale esto en la industria:
 * - IATA Codes Database (oficial, ~10k USD/año, exhaustivo)
 * - OpenFlights (open source, gratis, levemente desactualizado)
 * - airportsapi.io / Amadeus Locations API (REST con autocomplete)
 *
 * Para Sprint 0 mantengo una lista curada de los aeropuertos donde efectivamente
 * podríamos vender (hubs LATAM + destinos internacionales típicos desde la
 * región). Cuando crezcamos:
 *   1. Mover a tabla `airports` en Postgres seedeada desde IATA/OpenFlights.
 *   2. Endpoint /api/airports/search con full-text en city/name/code.
 *   3. Aliasing por idioma (Saint-Domingue=Santo Domingo).
 */
export interface Airport {
  code: string; // IATA 3-letter
  name: string;
  city: string;
  country: string; // ISO-3166-1 alpha-2
  countryName: string;
}

export const AIRPORTS: Airport[] = [
  // Colombia
  {
    code: 'BOG',
    name: 'El Dorado Internacional',
    city: 'Bogotá',
    country: 'CO',
    countryName: 'Colombia',
  },
  {
    code: 'MDE',
    name: 'José María Córdova',
    city: 'Medellín',
    country: 'CO',
    countryName: 'Colombia',
  },
  { code: 'CTG', name: 'Rafael Núñez', city: 'Cartagena', country: 'CO', countryName: 'Colombia' },
  {
    code: 'CLO',
    name: 'Alfonso Bonilla Aragón',
    city: 'Cali',
    country: 'CO',
    countryName: 'Colombia',
  },
  {
    code: 'BAQ',
    name: 'Ernesto Cortissoz',
    city: 'Barranquilla',
    country: 'CO',
    countryName: 'Colombia',
  },
  {
    code: 'SMR',
    name: 'Simón Bolívar',
    city: 'Santa Marta',
    country: 'CO',
    countryName: 'Colombia',
  },
  { code: 'PEI', name: 'Matecaña', city: 'Pereira', country: 'CO', countryName: 'Colombia' },
  { code: 'BGA', name: 'Palonegro', city: 'Bucaramanga', country: 'CO', countryName: 'Colombia' },
  {
    code: 'ADZ',
    name: 'Gustavo Rojas Pinilla',
    city: 'San Andrés',
    country: 'CO',
    countryName: 'Colombia',
  },
  { code: 'CUC', name: 'Camilo Daza', city: 'Cúcuta', country: 'CO', countryName: 'Colombia' },

  // Brasil
  {
    code: 'GRU',
    name: 'Guarulhos Internacional',
    city: 'São Paulo',
    country: 'BR',
    countryName: 'Brasil',
  },
  {
    code: 'GIG',
    name: 'Galeão Internacional',
    city: 'Río de Janeiro',
    country: 'BR',
    countryName: 'Brasil',
  },
  {
    code: 'BSB',
    name: 'Juscelino Kubitschek',
    city: 'Brasilia',
    country: 'BR',
    countryName: 'Brasil',
  },
  {
    code: 'CNF',
    name: 'Confins Internacional',
    city: 'Belo Horizonte',
    country: 'BR',
    countryName: 'Brasil',
  },
  {
    code: 'SSA',
    name: 'Deputado Luís Eduardo Magalhães',
    city: 'Salvador',
    country: 'BR',
    countryName: 'Brasil',
  },
  {
    code: 'POA',
    name: 'Salgado Filho',
    city: 'Porto Alegre',
    country: 'BR',
    countryName: 'Brasil',
  },
  {
    code: 'REC',
    name: 'Guararapes Internacional',
    city: 'Recife',
    country: 'BR',
    countryName: 'Brasil',
  },
  { code: 'FOR', name: 'Pinto Martins', city: 'Fortaleza', country: 'BR', countryName: 'Brasil' },
  { code: 'CWB', name: 'Afonso Pena', city: 'Curitiba', country: 'BR', countryName: 'Brasil' },
  { code: 'MAO', name: 'Eduardo Gomes', city: 'Manaos', country: 'BR', countryName: 'Brasil' },
  {
    code: 'IGU',
    name: 'Foz do Iguaçu',
    city: 'Foz do Iguaçu',
    country: 'BR',
    countryName: 'Brasil',
  },

  // Perú
  {
    code: 'LIM',
    name: 'Jorge Chávez Internacional',
    city: 'Lima',
    country: 'PE',
    countryName: 'Perú',
  },
  {
    code: 'CUZ',
    name: 'Alejandro Velasco Astete',
    city: 'Cusco',
    country: 'PE',
    countryName: 'Perú',
  },
  { code: 'AQP', name: 'Rodríguez Ballón', city: 'Arequipa', country: 'PE', countryName: 'Perú' },
  {
    code: 'IQT',
    name: 'Coronel FAP Francisco Secada',
    city: 'Iquitos',
    country: 'PE',
    countryName: 'Perú',
  },
  {
    code: 'TRU',
    name: 'Carlos Martínez de Pinillos',
    city: 'Trujillo',
    country: 'PE',
    countryName: 'Perú',
  },
  {
    code: 'PIU',
    name: 'Capitán FAP Guillermo Concha Iberico',
    city: 'Piura',
    country: 'PE',
    countryName: 'Perú',
  },

  // Chile
  {
    code: 'SCL',
    name: 'Arturo Merino Benítez',
    city: 'Santiago',
    country: 'CL',
    countryName: 'Chile',
  },
  { code: 'IPC', name: 'Mataveri', city: 'Isla de Pascua', country: 'CL', countryName: 'Chile' },
  { code: 'CCP', name: 'Carriel Sur', city: 'Concepción', country: 'CL', countryName: 'Chile' },
  { code: 'PMC', name: 'El Tepual', city: 'Puerto Montt', country: 'CL', countryName: 'Chile' },
  {
    code: 'PUQ',
    name: 'Carlos Ibáñez del Campo',
    city: 'Punta Arenas',
    country: 'CL',
    countryName: 'Chile',
  },
  { code: 'CJC', name: 'El Loa', city: 'Calama', country: 'CL', countryName: 'Chile' },

  // Argentina
  {
    code: 'EZE',
    name: 'Ministro Pistarini',
    city: 'Buenos Aires',
    country: 'AR',
    countryName: 'Argentina',
  },
  {
    code: 'AEP',
    name: 'Aeroparque Jorge Newbery',
    city: 'Buenos Aires',
    country: 'AR',
    countryName: 'Argentina',
  },
  {
    code: 'COR',
    name: 'Ingeniero Ambrosio Taravella',
    city: 'Córdoba',
    country: 'AR',
    countryName: 'Argentina',
  },
  { code: 'MDZ', name: 'El Plumerillo', city: 'Mendoza', country: 'AR', countryName: 'Argentina' },
  {
    code: 'BRC',
    name: 'Teniente Luis Candelaria',
    city: 'Bariloche',
    country: 'AR',
    countryName: 'Argentina',
  },
  {
    code: 'USH',
    name: 'Malvinas Argentinas',
    city: 'Ushuaia',
    country: 'AR',
    countryName: 'Argentina',
  },
  {
    code: 'IGR',
    name: 'Cataratas del Iguazú',
    city: 'Iguazú',
    country: 'AR',
    countryName: 'Argentina',
  },

  // México
  {
    code: 'MEX',
    name: 'Benito Juárez',
    city: 'Ciudad de México',
    country: 'MX',
    countryName: 'México',
  },
  {
    code: 'CUN',
    name: 'Cancún Internacional',
    city: 'Cancún',
    country: 'MX',
    countryName: 'México',
  },
  {
    code: 'GDL',
    name: 'Miguel Hidalgo y Costilla',
    city: 'Guadalajara',
    country: 'MX',
    countryName: 'México',
  },
  {
    code: 'MTY',
    name: 'Mariano Escobedo',
    city: 'Monterrey',
    country: 'MX',
    countryName: 'México',
  },
  {
    code: 'PVR',
    name: 'Lic. Gustavo Díaz Ordaz',
    city: 'Puerto Vallarta',
    country: 'MX',
    countryName: 'México',
  },
  { code: 'SJD', name: 'Los Cabos', city: 'Los Cabos', country: 'MX', countryName: 'México' },

  // Ecuador, Uruguay, Paraguay, Bolivia, Venezuela, Costa Rica, Panamá, RD
  { code: 'UIO', name: 'Mariscal Sucre', city: 'Quito', country: 'EC', countryName: 'Ecuador' },
  {
    code: 'GYE',
    name: 'José Joaquín de Olmedo',
    city: 'Guayaquil',
    country: 'EC',
    countryName: 'Ecuador',
  },
  { code: 'MVD', name: 'Carrasco', city: 'Montevideo', country: 'UY', countryName: 'Uruguay' },
  {
    code: 'ASU',
    name: 'Silvio Pettirossi',
    city: 'Asunción',
    country: 'PY',
    countryName: 'Paraguay',
  },
  { code: 'VVI', name: 'Viru Viru', city: 'Santa Cruz', country: 'BO', countryName: 'Bolivia' },
  { code: 'LPB', name: 'El Alto', city: 'La Paz', country: 'BO', countryName: 'Bolivia' },
  { code: 'CCS', name: 'Simón Bolívar', city: 'Caracas', country: 'VE', countryName: 'Venezuela' },
  {
    code: 'SJO',
    name: 'Juan Santamaría',
    city: 'San José',
    country: 'CR',
    countryName: 'Costa Rica',
  },
  { code: 'PTY', name: 'Tocumen', city: 'Ciudad de Panamá', country: 'PA', countryName: 'Panamá' },
  {
    code: 'SDQ',
    name: 'Las Américas',
    city: 'Santo Domingo',
    country: 'DO',
    countryName: 'República Dominicana',
  },
  {
    code: 'PUJ',
    name: 'Punta Cana',
    city: 'Punta Cana',
    country: 'DO',
    countryName: 'República Dominicana',
  },
  { code: 'HAV', name: 'José Martí', city: 'La Habana', country: 'CU', countryName: 'Cuba' },

  // Estados Unidos (destinos típicos desde LATAM)
  {
    code: 'MIA',
    name: 'Miami International',
    city: 'Miami',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'JFK',
    name: 'John F. Kennedy',
    city: 'Nueva York',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'EWR',
    name: 'Newark Liberty',
    city: 'Nueva York',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'LAX',
    name: 'Los Angeles International',
    city: 'Los Ángeles',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  { code: 'ORD', name: "O'Hare", city: 'Chicago', country: 'US', countryName: 'Estados Unidos' },
  {
    code: 'IAH',
    name: 'George Bush Intercontinental',
    city: 'Houston',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'DFW',
    name: 'Dallas/Fort Worth',
    city: 'Dallas',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'ATL',
    name: 'Hartsfield-Jackson',
    city: 'Atlanta',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'MCO',
    name: 'Orlando International',
    city: 'Orlando',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'LAS',
    name: 'Harry Reid',
    city: 'Las Vegas',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'SFO',
    name: 'San Francisco International',
    city: 'San Francisco',
    country: 'US',
    countryName: 'Estados Unidos',
  },
  {
    code: 'BOS',
    name: 'Logan International',
    city: 'Boston',
    country: 'US',
    countryName: 'Estados Unidos',
  },

  // Europa (hubs típicos)
  {
    code: 'MAD',
    name: 'Adolfo Suárez Madrid-Barajas',
    city: 'Madrid',
    country: 'ES',
    countryName: 'España',
  },
  {
    code: 'BCN',
    name: 'Josep Tarradellas Barcelona-El Prat',
    city: 'Barcelona',
    country: 'ES',
    countryName: 'España',
  },
  { code: 'CDG', name: 'Charles de Gaulle', city: 'París', country: 'FR', countryName: 'Francia' },
  { code: 'ORY', name: 'Orly', city: 'París', country: 'FR', countryName: 'Francia' },
  {
    code: 'FCO',
    name: 'Leonardo da Vinci-Fiumicino',
    city: 'Roma',
    country: 'IT',
    countryName: 'Italia',
  },
  { code: 'LHR', name: 'Heathrow', city: 'Londres', country: 'GB', countryName: 'Reino Unido' },
  { code: 'AMS', name: 'Schiphol', city: 'Ámsterdam', country: 'NL', countryName: 'Países Bajos' },
  {
    code: 'FRA',
    name: 'Frankfurt am Main',
    city: 'Frankfurt',
    country: 'DE',
    countryName: 'Alemania',
  },
  { code: 'LIS', name: 'Humberto Delgado', city: 'Lisboa', country: 'PT', countryName: 'Portugal' },
];

const NORM_CACHE = new Map<string, string>();

function normalize(s: string): string {
  if (NORM_CACHE.has(s)) return NORM_CACHE.get(s)!;
  const n = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  NORM_CACHE.set(s, n);
  return n;
}

/**
 * Búsqueda fuzzy por código IATA, nombre de ciudad, nombre de aeropuerto y país.
 * Pondera mejor los matches por código IATA (más usados por agentes pro).
 */
export function searchAirports(query: string, limit = 8): Airport[] {
  const q = normalize(query.trim());
  if (q.length === 0) return [];

  const scored: Array<{ a: Airport; score: number }> = [];
  for (const a of AIRPORTS) {
    const code = a.code.toLowerCase();
    const city = normalize(a.city);
    const name = normalize(a.name);
    const country = normalize(a.countryName);

    let score = 0;
    if (code === q) score += 1000;
    else if (code.startsWith(q)) score += 500;
    else if (city === q) score += 200;
    else if (city.startsWith(q)) score += 100;
    else if (city.includes(q)) score += 50;
    else if (name.startsWith(q)) score += 40;
    else if (name.includes(q)) score += 20;
    else if (country.startsWith(q)) score += 15;
    else if (country.includes(q)) score += 5;

    if (score > 0) scored.push({ a, score });
  }

  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit).map((x) => x.a);
}

export function findAirport(code: string): Airport | undefined {
  const c = code.toUpperCase();
  return AIRPORTS.find((a) => a.code === c);
}
