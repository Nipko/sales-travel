/**
 * Airport search — 8800+ IATA airports.
 *
 * The full dataset lives in src/data/airports-full.ts and is loaded
 * via dynamic import(). Next.js automatically code-splits it into a
 * separate chunk served from /_next/static/chunks/ — no public/ files,
 * no fetch, no Docker issues.
 */

export interface Airport {
  code: string;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  flag: string;
  size: number;
  scheduled: boolean;
}

interface RawAirport {
  c: string;
  n: string;
  t: string;
  cc: string;
  cn: string;
  f: string;
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
    flag: '🇨🇴',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MDE',
    name: 'José María Córdova Intl',
    city: 'Medellín',
    country: 'Colombia',
    countryCode: 'CO',
    flag: '🇨🇴',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CTG',
    name: 'Rafael Núñez Intl',
    city: 'Cartagena',
    country: 'Colombia',
    countryCode: 'CO',
    flag: '🇨🇴',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CLO',
    name: 'Alfonso Bonilla Aragón Intl',
    city: 'Cali',
    country: 'Colombia',
    countryCode: 'CO',
    flag: '🇨🇴',
    size: 3,
    scheduled: true,
  },
  {
    code: 'LIM',
    name: 'Jorge Chávez Intl',
    city: 'Lima',
    country: 'Perú',
    countryCode: 'PE',
    flag: '🇵🇪',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CUZ',
    name: 'Alejandro Velasco Astete Intl',
    city: 'Cusco',
    country: 'Perú',
    countryCode: 'PE',
    flag: '🇵🇪',
    size: 2,
    scheduled: true,
  },
  {
    code: 'GRU',
    name: 'Guarulhos Intl',
    city: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    flag: '🇧🇷',
    size: 3,
    scheduled: true,
  },
  {
    code: 'GIG',
    name: 'Galeão Intl',
    city: 'Río de Janeiro',
    country: 'Brasil',
    countryCode: 'BR',
    flag: '🇧🇷',
    size: 3,
    scheduled: true,
  },
  {
    code: 'SCL',
    name: 'Arturo Merino Benítez Intl',
    city: 'Santiago',
    country: 'Chile',
    countryCode: 'CL',
    flag: '🇨🇱',
    size: 3,
    scheduled: true,
  },
  {
    code: 'EZE',
    name: 'Ministro Pistarini Intl',
    city: 'Buenos Aires',
    country: 'Argentina',
    countryCode: 'AR',
    flag: '🇦🇷',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MIA',
    name: 'Miami Intl',
    city: 'Miami',
    country: 'Estados Unidos',
    countryCode: 'US',
    flag: '🇺🇸',
    size: 3,
    scheduled: true,
  },
  {
    code: 'JFK',
    name: 'John F. Kennedy Intl',
    city: 'Nueva York',
    country: 'Estados Unidos',
    countryCode: 'US',
    flag: '🇺🇸',
    size: 3,
    scheduled: true,
  },
  {
    code: 'PTY',
    name: 'Tocumen Intl',
    city: 'Ciudad de Panamá',
    country: 'Panamá',
    countryCode: 'PA',
    flag: '🇵🇦',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MEX',
    name: 'Benito Juárez Intl',
    city: 'Ciudad de México',
    country: 'México',
    countryCode: 'MX',
    flag: '🇲🇽',
    size: 3,
    scheduled: true,
  },
  {
    code: 'CUN',
    name: 'Cancún Intl',
    city: 'Cancún',
    country: 'México',
    countryCode: 'MX',
    flag: '🇲🇽',
    size: 3,
    scheduled: true,
  },
  {
    code: 'MAD',
    name: 'Adolfo Suárez Madrid-Barajas',
    city: 'Madrid',
    country: 'España',
    countryCode: 'ES',
    flag: '🇪🇸',
    size: 3,
    scheduled: true,
  },
  {
    code: 'UIO',
    name: 'Mariscal Sucre Intl',
    city: 'Quito',
    country: 'Ecuador',
    countryCode: 'EC',
    flag: '🇪🇨',
    size: 3,
    scheduled: true,
  },
  {
    code: 'PUJ',
    name: 'Punta Cana Intl',
    city: 'Punta Cana',
    country: 'Rep. Dominicana',
    countryCode: 'DO',
    flag: '🇩🇴',
    size: 3,
    scheduled: true,
  },
  {
    code: 'BAQ',
    name: 'Ernesto Cortissoz Intl',
    city: 'Barranquilla',
    country: 'Colombia',
    countryCode: 'CO',
    flag: '🇨🇴',
    size: 2,
    scheduled: true,
  },
  {
    code: 'SMR',
    name: 'Simón Bolívar Intl',
    city: 'Santa Marta',
    country: 'Colombia',
    countryCode: 'CO',
    flag: '🇨🇴',
    size: 2,
    scheduled: true,
  },
];

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
    flag: raw.f,
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

// ─── Search ─────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function scoreAirport(airport: AirportInternal, query: string): number {
  const code = airport.code.toLowerCase();
  const city = normalize(airport.city);
  const name = normalize(airport.name);
  const country = normalize(airport.country);
  const keywords = airport._keywords;

  if (code === query) return 100;
  if (city === query) return 90;
  if (code.startsWith(query)) return 80;
  if (city.startsWith(query)) return 70;

  if (keywords) {
    const kws = keywords.split(' ');
    for (const kw of kws) {
      if (kw === query) return 65;
      if (kw.startsWith(query)) return 60;
    }
  }

  if (city.includes(query)) return 55;
  if (name.includes(query)) return 45;
  if (keywords?.includes(query)) return 40;
  if (country.startsWith(query)) return 35;
  if (country.includes(query)) return 30;

  const words = query.split(/\s+/);
  if (words.length > 1) {
    const allMatch = words.every(
      (w) => code.includes(w) || city.includes(w) || name.includes(w) || country.includes(w),
    );
    if (allMatch) return 25;
  }

  return 0;
}

export function searchAirports(query: string, limit = 8): Airport[] {
  const q = normalize(query);
  if (!q) return POPULAR.slice(0, limit);

  const dataset: AirportInternal[] = fullDataset ?? POPULAR;
  const scored: { airport: AirportInternal; score: number }[] = [];

  for (let i = 0; i < dataset.length; i++) {
    const a = dataset[i]!;
    const score = scoreAirport(a, q);
    if (score > 0) {
      scored.push({ airport: a, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.airport.size !== a.airport.size) return b.airport.size - a.airport.size;
    return (b.airport.scheduled ? 1 : 0) - (a.airport.scheduled ? 1 : 0);
  });

  return scored.slice(0, limit).map((r) => r.airport);
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
