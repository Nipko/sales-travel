import { AIRPORTS, type Airport } from '../data/airports';

export type { Airport };

const POPULAR_CODES = [
  'BOG', 'MDE', 'CTG', 'CLO',
  'LIM', 'CUZ',
  'GRU', 'GIG',
  'SCL', 'EZE',
  'MIA', 'JFK', 'PTY', 'CUN',
  'MAD', 'MEX', 'PUJ', 'UIO',
];

const POPULAR: Airport[] = AIRPORTS.filter((a) => POPULAR_CODES.includes(a.code));

const RECENT_KEY = 'st:recent-airports';
const MAX_RECENT = 5;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function scoreAirport(airport: Airport, q: string): number {
  const query = normalize(q);
  if (!query) return 0;

  const code = airport.code.toLowerCase();
  const city = normalize(airport.city);
  const name = normalize(airport.name);
  const country = normalize(airport.country);
  const keywords = (airport.keywords ?? []).map(normalize);

  if (code === query) return 100;
  if (city === query) return 90;

  if (code.startsWith(query)) return 80;
  if (city.startsWith(query)) return 70;

  for (const kw of keywords) {
    if (kw === query) return 75;
    if (kw.startsWith(query)) return 65;
  }

  if (city.includes(query)) return 55;
  if (name.includes(query)) return 45;
  if (country.includes(query)) return 35;

  for (const kw of keywords) {
    if (kw.includes(query)) return 40;
  }

  const words = query.split(/\s+/);
  if (words.length > 1) {
    const allMatch = words.every(
      (w) =>
        code.includes(w) ||
        city.includes(w) ||
        name.includes(w) ||
        country.includes(w) ||
        keywords.some((kw) => kw.includes(w)),
    );
    if (allMatch) return 30;
  }

  return 0;
}

export function searchAirports(query: string, limit = 8): Airport[] {
  const q = query.trim();
  if (!q) return POPULAR.slice(0, limit);

  const scored = AIRPORTS.map((a) => ({ airport: a, score: scoreAirport(a, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.airport.popular ? 0 : 1) - (b.airport.popular ? 0 : 1);
    });

  return scored.slice(0, limit).map((r) => r.airport);
}

export function getPopularAirports(limit = 8): Airport[] {
  return POPULAR.slice(0, limit);
}

export function getRecentAirports(): Airport[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const codes = JSON.parse(raw) as string[];
    return codes
      .slice(0, MAX_RECENT)
      .map((c) => AIRPORTS.find((a) => a.code === c))
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
  return AIRPORTS.find((a) => a.code === code.toUpperCase());
}
