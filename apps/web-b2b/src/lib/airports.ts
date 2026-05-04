/**
 * Cliente del catálogo de aeropuertos.
 *
 * Llama a /api/airports (Route Handler local) que internamente proxy-ea al
 * servicio NestJS por la red docker interna. Esto evita CORS y mantiene el
 * patrón "el browser solo habla con Next.js".
 */

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
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', String(limit));

  const res = await fetch(`/api/airports?${params.toString()}`, {
    signal,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`airports search failed: ${res.status}`);
  const body = (await res.json()) as AirportsResponse;
  return body.items;
}
