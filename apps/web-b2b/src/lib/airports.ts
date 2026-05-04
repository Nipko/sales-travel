/**
 * Cliente del catálogo de aeropuertos.
 *
 * Los datos viven en Postgres (tabla `airports`), sincronizados diariamente
 * desde OpenFlights por el cron de GitHub Actions `sync-airports.yml`.
 * Este módulo solo expone los tipos y la función de fetch al endpoint
 * `GET /api/airports?q=...`.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export interface Airport {
  code: string;
  name: string;
  city: string;
  countryCode: string | null;
  countryName: string;
}

interface AirportsResponse {
  items: Airport[];
}

export async function searchAirports(
  query: string,
  limit = 8,
  signal?: AbortSignal,
): Promise<Airport[]> {
  const url = new URL(`${API_BASE}/api/airports`);
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`airports search failed: ${res.status}`);
  const body = (await res.json()) as AirportsResponse;
  return body.items;
}
