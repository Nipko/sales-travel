/**
 * Catálogo de aeropuertos para autocomplete del buscador.
 *
 * Fuente: OpenFlights airports.dat (ODbL — https://openflights.org/data.html).
 * El dataset oficial está en `airports.generated.ts` y se regenera con
 * `node tools/gen-airports/generate.mjs`.
 *
 * Filtro aplicado:
 * - Todos los aeropuertos con IATA válido en países LATAM + Caribe.
 * - Hubs internacionales relevantes (US, EU, Asia, Medio Oriente, Canadá).
 *
 * Cuando el dataset crezca o necesites más control, mover a tabla `airports`
 * en Postgres seedeada con la misma fuente, expuesta vía
 * `GET /api/airports/search?q=...`.
 */

import { AIRPORTS_GENERATED } from './airports.generated';

export interface Airport {
  code: string; // IATA 3-letter
  name: string;
  city: string;
  country: string; // ISO-3166-1 alpha-2 (puede ser '' si OpenFlights no lo tenía)
  countryName: string;
}

export const AIRPORTS: Airport[] = AIRPORTS_GENERATED;

/**
 * Aeropuertos destacados — los más usados desde el mercado LATAM. Se muestran
 * primero cuando el input está vacío (sugerencias rápidas).
 */
export const FEATURED_AIRPORTS: Airport[] = [
  'BOG', 'MDE', 'CTG', 'CLO',
  'GRU', 'GIG', 'BSB',
  'LIM', 'CUZ',
  'SCL',
  'EZE', 'AEP',
  'MEX', 'CUN', 'GDL',
  'UIO', 'GYE',
  'PTY', 'SJO',
  'MIA', 'JFK', 'LAX', 'MCO',
  'MAD', 'BCN', 'CDG', 'LIS',
]
  .map((code) => AIRPORTS.find((a) => a.code === code))
  .filter((a): a is Airport => Boolean(a));

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
 * Búsqueda fuzzy ponderada: IATA exacto > IATA prefix > city exact > city
 * prefix > city includes > name > country.
 */
export function searchAirports(query: string, limit = 8): Airport[] {
  const q = normalize(query.trim());
  if (q.length === 0) return FEATURED_AIRPORTS.slice(0, limit);

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
