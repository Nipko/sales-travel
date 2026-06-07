import { buildAvailabilityQuery, buildDetailQuery } from './availability/request.builder';
import { mapAvailability } from './availability/response.mapper';
import type { DespegarHotelsConfig } from './config';
import { mapHotelDetail } from './detail/response.mapper';
import { DespegarHttpClient } from './http/despegar-http.client';
import { mapSuggestions } from './suggestions/response.mapper';
import type { AvailabilityQuery, GeoSuggestion, HotelDetailQuery, HotelOffer } from './types';

export * from './config';
export * from './types';
export { DespegarApiError } from './http/despegar-http.client';
export {
  buildAvailabilityQuery,
  buildDetailQuery,
  buildDistribution,
} from './availability/request.builder';
export { mapAvailability, mapMealPlan } from './availability/response.mapper';
export { mapHotelDetail } from './detail/response.mapper';
export { mapSuggestions } from './suggestions/response.mapper';

/**
 * Adapter Despegar Hotels v3 (Anti-Corruption Layer). Expone el flujo de búsqueda en tipos
 * normalizados (suggestions → availability → detail). El flujo de reserva (prebook/payments/book)
 * se suma en el siguiente incremento.
 */
export class DespegarHotelsAdapter {
  private readonly http: DespegarHttpClient;

  constructor(private readonly cfg: DespegarHotelsConfig) {
    this.http = new DespegarHttpClient(cfg);
  }

  /** Autocomplete de destinos/hoteles por texto. */
  async suggest(hint: string, locale?: string): Promise<GeoSuggestion[]> {
    const raw = await this.http.get<Parameters<typeof mapSuggestions>[0]>('/suggestions/hotels', {
      hint,
      locale: locale ?? this.cfg.locale,
      weak: true,
    });
    return mapSuggestions(raw);
  }

  /** Disponibilidad de una lista de hoteles (hasta 100; 50 recomendado). */
  async searchAvailability(q: AvailabilityQuery): Promise<HotelOffer[]> {
    const raw = await this.http.get<Parameters<typeof mapAvailability>[0]>(
      '/hotels-api/availability',
      buildAvailabilityQuery({
        ...q,
        language: q.language ?? this.cfg.language,
        countryCode: q.countryCode ?? this.cfg.countryCode,
      }),
    );
    return mapAvailability(raw);
  }

  /** Detalle de un hotel: roompacks con `choice_id` para iniciar la reserva. */
  async getHotelDetail(q: HotelDetailQuery): Promise<HotelOffer> {
    const raw = await this.http.get<Parameters<typeof mapHotelDetail>[0]>(
      `/hotels-api/availability/${encodeURIComponent(q.hotelId)}`,
      buildDetailQuery({
        ...q,
        language: q.language ?? this.cfg.language,
        countryCode: q.countryCode ?? this.cfg.countryCode,
      }),
    );
    return mapHotelDetail(raw);
  }
}
