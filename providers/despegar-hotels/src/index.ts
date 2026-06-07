import { buildAvailabilityQuery, buildDetailQuery } from './availability/request.builder';
import { mapAvailability } from './availability/response.mapper';
import { buildBookBody } from './booking/book.builder';
import { mapBookResult } from './booking/book.mapper';
import { buildCancelBody, mapCancelResult } from './booking/cancel.mapper';
import { buildPaymentOptionsQuery, mapPaymentOptions } from './booking/payments.mapper';
import { buildPrebookBody } from './booking/prebook.builder';
import { mapPrebook } from './booking/prebook.mapper';
import { buildRecoveryBody, mapRecoveryResult } from './booking/recovery.mapper';
import type {
  BookRequest,
  BookResult,
  CancelReservationRequest,
  CancelReservationResult,
  PaymentModality,
  PaymentOptionsQuery,
  PrebookQuery,
  PrebookResult,
  RecoveryRequest,
  RecoveryResult,
} from './booking/types';
import type { DespegarHotelsConfig } from './config';
import { mapHotelDetail } from './detail/response.mapper';
import { DespegarHttpClient } from './http/despegar-http.client';
import { mapSuggestions } from './suggestions/response.mapper';
import type { AvailabilityQuery, GeoSuggestion, HotelDetailQuery, HotelOffer } from './types';

export * from './config';
export * from './types';
export * from './booking/types';
export { DespegarApiError } from './http/despegar-http.client';
export {
  buildAvailabilityQuery,
  buildDetailQuery,
  buildDistribution,
} from './availability/request.builder';
export { mapAvailability, mapMealPlan } from './availability/response.mapper';
export { mapHotelDetail } from './detail/response.mapper';
export { mapSuggestions } from './suggestions/response.mapper';
export { buildPrebookBody } from './booking/prebook.builder';
export { mapPrebook } from './booking/prebook.mapper';
export { buildPaymentOptionsQuery, mapPaymentOptions } from './booking/payments.mapper';
export { buildBookBody } from './booking/book.builder';
export { mapBookResult } from './booking/book.mapper';
export { buildCancelBody, mapCancelResult } from './booking/cancel.mapper';
export { buildRecoveryBody, mapRecoveryResult } from './booking/recovery.mapper';

/**
 * Adapter Despegar Hotels v3 (Anti-Corruption Layer). Expone los flujos en tipos normalizados:
 *   búsqueda  → suggest / searchAvailability / getHotelDetail
 *   reserva   → prebook → getPaymentOptions → book → getReservation / cancelReservation / recoverBooking
 * Los DTOs de Despegar se convierten a canónico aquí; nunca se filtran al dominio.
 */
export class DespegarHotelsAdapter {
  private readonly http: DespegarHttpClient;

  constructor(private readonly cfg: DespegarHotelsConfig) {
    this.http = new DespegarHttpClient(cfg);
  }

  // ───────────────────────── Búsqueda ─────────────────────────

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

  // ───────────────────────── Reserva ─────────────────────────

  /** Revalida la tarifa del `choice_id` y abre el prebook (con su expiración). 410 → producto vencido. */
  async prebook(q: PrebookQuery): Promise<PrebookResult> {
    const raw = await this.http.post<Parameters<typeof mapPrebook>[0]>(
      '/prebook',
      buildPrebookBody({ ...q, lang: q.lang ?? this.defaultLang() }),
    );
    return mapPrebook(raw);
  }

  /** Cotiza el prebook y devuelve modalidades/medios de pago (incluye el plan_id para el book). */
  async getPaymentOptions(q: PaymentOptionsQuery): Promise<PaymentModality[]> {
    const raw = await this.http.get<Parameters<typeof mapPaymentOptions>[0]>(
      '/payments',
      buildPaymentOptionsQuery(q),
    );
    return mapPaymentOptions(raw);
  }

  /** Confirma y emite la reserva. El status puede llegar como SUCCESS/PROCESSING/ERROR con HTTP 200. */
  async book(req: BookRequest): Promise<BookResult> {
    const raw = await this.http.post<Parameters<typeof mapBookResult>[0]>(
      '/book',
      buildBookBody(req),
      req.testCase ? { test_case: req.testCase } : {},
    );
    return mapBookResult(raw);
  }

  /** Estado de una reserva por id (o por external_booking_reference). */
  async getReservation(reservationId: string): Promise<BookResult> {
    const raw = await this.http.get<Parameters<typeof mapBookResult>[0]>(
      `/book/${encodeURIComponent(reservationId)}`,
    );
    return mapBookResult(raw);
  }

  /** Cancela una reserva (irreversible). */
  async cancelReservation(req: CancelReservationRequest): Promise<CancelReservationResult> {
    const raw = await this.http.post<Parameters<typeof mapCancelResult>[0]>(
      `/reservations/${encodeURIComponent(req.reservationId)}/cancels`,
      buildCancelBody(req.reason),
    );
    return mapCancelResult(raw);
  }

  /** Confirma/rechaza un price-jump cuando el book quedó en PROCESSING. */
  async recoverBooking(req: RecoveryRequest): Promise<RecoveryResult> {
    const raw = await this.http.patch<Parameters<typeof mapRecoveryResult>[0]>(
      `/book/${encodeURIComponent(req.reservationId)}/recovery`,
      buildRecoveryBody(req),
      req.testCase ? { test_case: req.testCase } : {},
    );
    return mapRecoveryResult(raw);
  }

  private defaultLang(): 'es' | 'en' | 'pt' | undefined {
    return this.cfg.language ? (this.cfg.language.toLowerCase() as 'es' | 'en' | 'pt') : undefined;
  }
}
