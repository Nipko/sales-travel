import type { CarSearchResult, CarSearchValues } from '../../autos/actions';
import type { SearchResult } from '../../cotizaciones/actions';
import type { HotelSearchResult } from '../../hoteles/actions';

/**
 * Las tres búsquedas del paquete, cada una por `POST /api/packages/search` para que salgan a la
 * vez (las acciones del servidor se despachan de a una). Un fallo de red se devuelve como
 * resultado con error: un carril caído no tumba a los otros.
 */

async function post<T>(body: unknown, fallback: T): Promise<T> {
  try {
    const res = await fetch('/api/packages/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 200) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ...fallback, error: data?.error ?? 'No pudimos completar la búsqueda.' };
    }
    return (await res.json()) as T;
  } catch {
    return { ...fallback, error: 'Sin conexión con el servidor. Reintenta en un momento.' };
  }
}

export function searchFlights(form: Record<string, string>): Promise<SearchResult> {
  return post<SearchResult>(
    { vertical: 'flights', form },
    { ok: false, offers: [], providers: [], showProviderInResults: false },
  );
}

export function searchHotels(form: Record<string, string>): Promise<HotelSearchResult> {
  return post<HotelSearchResult>(
    { vertical: 'hotels', form },
    { ok: false, hotels: [], providers: [], showProviderInResults: false },
  );
}

export function searchCars(values: CarSearchValues): Promise<CarSearchResult> {
  return post<CarSearchResult>({ vertical: 'cars', values }, { ok: false, cars: [] });
}
