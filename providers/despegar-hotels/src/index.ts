import { buildAvailabilityQuery, buildDetailQuery } from './availability/request.builder';
import { mapAvailability } from './availability/response.mapper';
import {
  buildCancelQuoteBody,
  buildCommissionUpdateBody,
  buildReservationsQuery,
  mapCancelAllowance,
  mapCancelQuote,
  mapCommissionUpdate,
  mapPriceJump,
  mapReservations,
  mapSpecialRequestCatalog,
  mapSpecialRequestResult,
} from './booking/aftersale.mapper';
import { buildBookBody } from './booking/book.builder';
import { mapBookResult } from './booking/book.mapper';
import { buildCancelBody, mapCancelResult } from './booking/cancel.mapper';
import { buildPaymentOptionsQuery, mapPaymentOptions } from './booking/payments.mapper';
import { buildPrebookBody } from './booking/prebook.builder';
import { mapPrebook } from './booking/prebook.mapper';
import { buildRecoveryBody, mapRecoveryResult } from './booking/recovery.mapper';
import type {
  AftersaleReservation,
  BookRequest,
  BookResult,
  CancelAllowance,
  CancelQuote,
  CancelReason,
  CancelReservationRequest,
  CancelReservationResult,
  CommissionUpdateRequest,
  CommissionUpdateResult,
  PaymentModality,
  PaymentOptionsQuery,
  PrebookQuery,
  PrebookResult,
  PriceJumpInfo,
  RecoveryRequest,
  RecoveryResult,
  ReservationsQuery,
  SpecialRequestCatalogItem,
  SpecialRequestInput,
  SpecialRequestResult,
} from './booking/types';
import { despegarLocale, type DespegarHotelsConfig } from './config';
import {
  mapAmenities,
  mapCatalog,
  mapHotelContent,
  mapMealPlans,
  type AmenityEntry,
  type CatalogEntry,
  type DespegarHotelContent,
  type MealPlanEntry,
} from './content/content.mapper';
import { mapHotelDetail } from './detail/response.mapper';
import { DespegarCancelNotAllowedError, DespegarReservationNotFoundError } from './errors';
import { DespegarHttpClient, type DespegarHttpDeps } from './http/despegar-http.client';
import { mapSuggestions } from './suggestions/response.mapper';
import type { AvailabilityQuery, GeoSuggestion, HotelDetailQuery, HotelOffer } from './types';

export * from './config';
export * from './types';
export * from './booking/types';
export * from './errors';
export { DESPEGAR_REDACTED, redactDespegarPayload } from './redaction';

/** Código del proveedor en el registry y en la bóveda de payloads. */
export const DESPEGAR_HOTELS_PROVIDER_CODE = 'despegar-hotels';
export {
  DespegarApiError,
  type DespegarExchange,
  type DespegarHttpDeps,
} from './http/despegar-http.client';
export {
  buildAvailabilityQuery,
  buildDetailQuery,
  buildDistribution,
} from './availability/request.builder';
export {
  isBookableRoompack,
  mapAvailability,
  mapMealPlan,
  mapNotices,
} from './availability/response.mapper';
export { mapHotelDetail } from './detail/response.mapper';
export { mapSuggestions } from './suggestions/response.mapper';
export { buildPrebookBody } from './booking/prebook.builder';
export { mapPrebook } from './booking/prebook.mapper';
export { buildPaymentOptionsQuery, mapPaymentOptions } from './booking/payments.mapper';
export { buildBookBody } from './booking/book.builder';
export { mapBookResult } from './booking/book.mapper';
export { buildCancelBody, mapCancelResult } from './booking/cancel.mapper';
export { buildRecoveryBody, mapRecoveryResult } from './booking/recovery.mapper';
export {
  buildCancelQuoteBody,
  buildCommissionUpdateBody,
  buildReservationsQuery,
  mapCancelAllowance,
  mapCancelQuote,
  mapCommissionUpdate,
  mapPriceJump,
  mapReservations,
  mapSpecialRequestCatalog,
  mapSpecialRequestResult,
} from './booking/aftersale.mapper';
export {
  mapAmenities,
  mapCatalog,
  mapHotelContent,
  mapMealPlans,
  type AmenityEntry,
  type CatalogEntry,
  type ContentLanguage,
  type DespegarHotelContent,
  type LocalizedText,
  type MealPlanEntry,
} from './content/content.mapper';

/** Lo que un paso de la cancelación vio, para que quien llama decida y lo muestre. */
export interface CancelPreview {
  reservation: AftersaleReservation;
  allowance: CancelAllowance;
  /** Ausente si la habilitación no fue `ALLOWED`: sin permiso no se cotiza. */
  quote?: CancelQuote;
}

/**
 * Adapter Despegar Hotels v3 (Anti-Corruption Layer). Expone los flujos en tipos normalizados:
 *   búsqueda   → suggest / searchAvailability / getHotelDetail
 *   reserva    → prebook → [updateCommission] → getPaymentOptions → book → [getPriceJump → recoverBooking]
 *   post-venta → getReservation / findReservations / previewCancellation → cancelReservation
 *   contenido  → getHotelsContent / getMealPlans / getFeeTypes / getAmenities
 * Los DTOs de Despegar se convierten a canónico aquí; nunca se filtran al dominio.
 */
export class DespegarHotelsAdapter {
  private readonly http: DespegarHttpClient;

  constructor(
    private readonly cfg: DespegarHotelsConfig,
    deps: DespegarHttpDeps = {},
  ) {
    this.http = new DespegarHttpClient(cfg, deps);
  }

  // ───────────────────────── Búsqueda ─────────────────────────

  /**
   * Autocomplete de CIUDADES. `/suggestions/hotels` devuelve hoteles, y la búsqueda resuelve el
   * destino a los hoteles de una ciudad del inventario: se usa `/suggestions` con el perfil de
   * hoteles, que agrupa ciudades, aeropuertos, zonas…, y el mapper deja sólo las ciudades.
   */
  async suggest(hint: string, locale?: string): Promise<GeoSuggestion[]> {
    const raw = await this.http.get<Parameters<typeof mapSuggestions>[0]>(
      '/suggestions',
      { hint, locale: despegarLocale(locale, this.cfg), profile: 'sbox-hotels' },
      'suggestions',
    );
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
      'availability',
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
      'detail',
    );
    return mapHotelDetail(raw);
  }

  // ───────────────────────── Reserva ─────────────────────────

  /** Revalida la tarifa del `choice_id` y abre el prebook (vale 15 min). 410 → producto vencido. */
  async prebook(q: PrebookQuery): Promise<PrebookResult> {
    const raw = await this.http.post<Parameters<typeof mapPrebook>[0]>(
      '/prebook',
      buildPrebookBody({ ...q, lang: q.lang ?? this.defaultLang() }),
      {},
      'prebook',
    );
    return mapPrebook(raw);
  }

  /** Fija la comisión del prebook entre su mínimo y su máximo. Va ANTES de `/payments`. */
  async updateCommission(req: CommissionUpdateRequest): Promise<CommissionUpdateResult> {
    const raw = await this.http.put<Parameters<typeof mapCommissionUpdate>[0]>(
      '/commissions/update',
      buildCommissionUpdateBody(req),
      {},
      'commissionUpdate',
    );
    return mapCommissionUpdate(raw);
  }

  /** Cotiza el prebook y devuelve modalidades/medios de pago (incluye el plan_id para el book). */
  async getPaymentOptions(q: PaymentOptionsQuery): Promise<PaymentModality[]> {
    const raw = await this.http.get<Parameters<typeof mapPaymentOptions>[0]>(
      '/payments',
      buildPaymentOptionsQuery(q),
      'payments',
    );
    return mapPaymentOptions(raw);
  }

  /** Confirma y emite la reserva. El status puede llegar como SUCCESS/PROCESSING/ERROR con HTTP 200. */
  async book(req: BookRequest): Promise<BookResult> {
    const raw = await this.http.post<Parameters<typeof mapBookResult>[0]>(
      '/book',
      buildBookBody(req),
      req.testCase ? { test_case: req.testCase } : {},
      'book',
    );
    return mapBookResult(raw);
  }

  /** Estado de una reserva por id (o por `external_booking_reference`). */
  async getReservation(reservationId: string): Promise<BookResult> {
    const raw = await this.http.get<Parameters<typeof mapBookResult>[0]>(
      `/book/${encodeURIComponent(reservationId)}`,
      {},
      'bookStatus',
    );
    return mapBookResult(raw);
  }

  /** Lee el salto de precio (o la espera de selección de pago) de un Book en PROCESSING. */
  async getPriceJump(reservationId: string, testCase?: 'pricejump'): Promise<PriceJumpInfo> {
    const raw = await this.http.get<Parameters<typeof mapPriceJump>[0]>(
      `/book/${encodeURIComponent(reservationId)}/recovery`,
      testCase ? { test_case: testCase } : {},
      'recoveryRead',
    );
    return mapPriceJump(raw, reservationId);
  }

  /** Confirma/rechaza un price-jump cuando el book quedó en PROCESSING. Responde 204. */
  async recoverBooking(req: RecoveryRequest): Promise<RecoveryResult> {
    const raw = await this.http.patch<Parameters<typeof mapRecoveryResult>[0]>(
      `/book/${encodeURIComponent(req.reservationId)}/recovery`,
      buildRecoveryBody(req),
      req.testCase ? { test_case: req.testCase } : {},
      'recovery',
    );
    return mapRecoveryResult(raw);
  }

  // ───────────────────────── Post-venta ─────────────────────────

  /** `/reservations`: el producto (con `product_id` y `transaction_id`) de una o varias reservas. */
  async findReservations(q: ReservationsQuery): Promise<AftersaleReservation[]> {
    const raw = await this.http.get<Parameters<typeof mapReservations>[0]>(
      '/reservations',
      buildReservationsQuery(q),
      'reservations',
    );
    return mapReservations(raw);
  }

  /** El producto de hotel de UNA reserva del Book, o `undefined` si `/reservations` no lo trae. */
  async findHotelReservation(reservationId: string): Promise<AftersaleReservation | undefined> {
    const items = await this.findReservations({ reservationId, productType: 'HOTEL' });
    return items.find((i) => i.productType === '' || i.productType === 'HOTEL') ?? items[0];
  }

  /** Paso 1: ¿se puede cancelar? Devuelve sólo características, nunca importes. */
  async getCancelAllowance(productId: string): Promise<CancelAllowance> {
    const raw = await this.http.get<Parameters<typeof mapCancelAllowance>[0]>(
      `/reservations/${encodeURIComponent(productId)}/cancels/allowance`,
      {},
      'cancelAllowance',
    );
    return mapCancelAllowance(raw, productId);
  }

  /** Paso 2: cuánto se reembolsa y cuánto se penaliza. */
  async quoteCancellation(transactionId: string, productId: string): Promise<CancelQuote> {
    const raw = await this.http.post<Parameters<typeof mapCancelQuote>[0]>(
      '/reservations/cancels/quote',
      buildCancelQuoteBody(transactionId),
      {},
      'cancelQuote',
    );
    return mapCancelQuote(raw, productId);
  }

  /**
   * Pasos 1 y 2 sin cancelar: lo que el vendedor tiene que ver antes de confirmar. Si la
   * habilitación no es `ALLOWED`, no cotiza.
   */
  async previewCancellation(reservationId: string): Promise<CancelPreview> {
    const reservation = await this.findHotelReservation(reservationId);
    if (reservation === undefined) throw new DespegarReservationNotFoundError();
    const allowance = await this.getCancelAllowance(reservation.productId);
    if (allowance.allowance !== 'ALLOWED' || reservation.transactionId === undefined) {
      return { reservation, allowance };
    }
    const quote = await this.quoteCancellation(reservation.transactionId, reservation.productId);
    return { reservation, allowance, quote };
  }

  /**
   * Cancela una reserva (irreversible) en los tres pasos que exige Despegar: habilitación,
   * cotización y cancelación, sobre el `product_id` que da `/reservations`. Si el paso 1 no
   * permite cancelar, lanza {@link DespegarCancelNotAllowedError} sin tocar nada.
   */
  async cancelReservation(req: CancelReservationRequest): Promise<CancelReservationResult> {
    const preview = await this.previewCancellation(req.reservationId);
    if (preview.allowance.allowance !== 'ALLOWED') {
      throw new DespegarCancelNotAllowedError(preview.allowance);
    }
    const result = await this.cancelProduct(preview.reservation.productId, req.reason);
    return preview.quote === undefined ? result : { ...result, quote: preview.quote };
  }

  /** Paso 3 solo, sobre un `product_id`. Sólo después de los pasos 1 y 2. */
  async cancelProduct(productId: string, reason?: CancelReason): Promise<CancelReservationResult> {
    const raw = await this.http.post<Parameters<typeof mapCancelResult>[0]>(
      `/reservations/${encodeURIComponent(productId)}/cancels`,
      buildCancelBody(reason),
      {},
      'cancel',
    );
    return mapCancelResult(raw);
  }

  /** Pedidos especiales que admite el hotel de una reserva (cuna, late check-in…). */
  async getSpecialRequestsCatalog(productId: string): Promise<SpecialRequestCatalogItem[]> {
    const raw = await this.http.get<Parameters<typeof mapSpecialRequestCatalog>[0]>(
      '/special-requests/catalog',
      { product_type: 'HOTEL', product_id: productId },
      'specialRequestsCatalog',
    );
    return mapSpecialRequestCatalog(raw);
  }

  async createSpecialRequest(req: SpecialRequestInput): Promise<SpecialRequestResult> {
    const raw = await this.http.post<Parameters<typeof mapSpecialRequestResult>[0]>(
      `/reservations/${encodeURIComponent(req.productId)}/specials-requests`,
      { product_type: 'HOTEL', code: req.code, value: req.value },
      {},
      'specialRequest',
    );
    return mapSpecialRequestResult(raw);
  }

  // ───────────────────────── Contenido ─────────────────────────

  /** Ficha de hasta 100 hoteles por llamada. */
  async getHotelsContent(
    ids: readonly string[],
    language: 'EN' | 'ES' | 'PT' = this.cfg.language ?? 'ES',
  ): Promise<DespegarHotelContent[]> {
    const raw = await this.http.get<unknown>(
      '/content-api/hotels',
      { ids: ids.slice(0, 100).join(','), language },
      'hotelsContent',
    );
    return mapHotelContent(raw);
  }

  async getMealPlans(): Promise<MealPlanEntry[]> {
    return mapMealPlans(
      await this.http.get<unknown>('/content-api/hotels/meal-plans', {}, 'mealPlans'),
    );
  }

  async getFeeTypes(): Promise<CatalogEntry[]> {
    return mapCatalog(
      await this.http.get<unknown>('/content-api/hotels/fee-types', {}, 'feeTypes'),
    );
  }

  async getAmenities(): Promise<AmenityEntry[]> {
    return mapAmenities(
      await this.http.get<unknown>('/content-api/hotels/amenities', {}, 'amenities'),
    );
  }

  private defaultLang(): 'es' | 'en' | 'pt' | undefined {
    return this.cfg.language ? (this.cfg.language.toLowerCase() as 'es' | 'en' | 'pt') : undefined;
  }
}
