import { Injectable } from '@nestjs/common';
import type {
  BookRequest,
  BookResult,
  CancelReservationRequest,
  CancelReservationResult,
  GeoSuggestion,
  HotelOffer,
  PaymentModality,
  PaymentOptionsQuery,
  PrebookQuery,
  PrebookResult,
  RecoveryRequest,
  RecoveryResult,
} from '@sales-travel/despegar-hotels';
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { PricingService, applyCascade, toTenantView } from '../pricing/pricing.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { SearchTelemetryService } from '../search/search-telemetry.service.js';
import { DespegarHotelsProviderFactory } from '../providers-despegar/despegar-hotels.factory.js';
import type { HotelAvailabilityInput, HotelDetailInput } from './hotels.schemas.js';

const PROVIDER_CODE = 'despegar-hotels';

@Injectable()
export class HotelsService {
  constructor(
    private readonly factory: DespegarHotelsProviderFactory,
    private readonly db: DatabaseService,
    private readonly pricing: PricingService,
    private readonly activeTenant: ActiveTenantService,
    private readonly telemetry: SearchTelemetryService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  /**
   * Adjunta el pricing waterfall del consolidador a cada roompack.
   *
   * Hasta ahora la vertical de hoteles NO pasaba por el waterfall —cero referencias a
   * PricingService en este módulo— así que toda la red vendía hoteles al costo del
   * proveedor, sin margen para el consolidador ni para la agencia. Vuelos sí lo aplicaba
   * (SearchService.withPricing); esto lo alinea.
   *
   * `price.total` (el neto) NO se muta: `pricing.finalMinor` es el precio de venta.
   */
  private async withPricing(offers: HotelOffer[], tenantId: string): Promise<HotelOffer[]> {
    const rules = await this.pricing.getApplicableRules(tenantId, 'hotels');
    if (rules.length === 0) return offers;

    return offers.map((offer) => ({
      ...offer,
      roompacks: offer.roompacks.map((pack) => {
        return {
          ...pack,
          pricing: toTenantView(
            applyCascade(pack.price.total.amountMinor, rules),
            tenantId,
            pack.price.total.currency,
          ),
        };
      }),
    }));
  }

  // ───────────────────────── Búsqueda ─────────────────────────

  async suggest(tenantId: string, q: string, locale?: string): Promise<GeoSuggestion[]> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.suggest(q, locale);
  }

  async searchAvailability(tenantId: string, input: HotelAvailabilityInput): Promise<HotelOffer[]> {
    // Resolución ciudad→IDs: si no llegan IDs explícitos pero sí un destino, se resuelven del
    // catálogo de inventario. Sin IDs (catálogo aún sin sincronizar) → sin resultados.
    let hotelIds = input.hotelIds ?? [];
    if (hotelIds.length === 0 && input.destinationId != null) {
      hotelIds = await this.resolveCityHotelIds(input.destinationId);
    }
    if (hotelIds.length === 0) return [];

    await this.telemetry.assertWithinQuota(tenantId);
    const adapter = await this.factory.forTenant(tenantId);
    const defaults = await this.tenantDefaults(tenantId);
    const offers = await this.telemetry.instrument(
      {
        tenantId,
        vertical: 'hotels',
        providerCode: PROVIDER_CODE,
        criteria: {
          checkinDate: input.checkinDate,
          checkoutDate: input.checkoutDate,
          destinationId: input.destinationId,
          hotelCount: hotelIds.length,
        },
      },
      () =>
        this.breaker.execute(PROVIDER_CODE, () =>
          adapter.searchAvailability({
            checkinDate: input.checkinDate,
            checkoutDate: input.checkoutDate,
            currency: input.currency ?? defaults.currency,
            hotelIds,
            rooms: input.rooms,
            countryCode: input.countryCode ?? defaults.countryCode,
            language: input.language,
            ttl: input.ttl,
            refundableOnly: input.refundableOnly,
          }),
        ),
      (r) => r.length,
    );
    return this.withPricing(offers, tenantId);
  }

  /** IDs de hotel de una ciudad (city_id) desde el catálogo `hotel_inventory` (cap. por defecto 50). */
  async resolveCityHotelIds(cityId: number, limit = 50): Promise<string[]> {
    const rows = await this.db.db
      .selectFrom('hotel_inventory')
      .select('hotel_id')
      .where('provider_code', '=', PROVIDER_CODE)
      .where('city_id', '=', cityId)
      .limit(limit)
      .execute();
    return rows.map((r) => r.hotel_id);
  }

  async getHotelDetail(tenantId: string, input: HotelDetailInput): Promise<HotelOffer> {
    const adapter = await this.factory.forTenant(tenantId);
    const defaults = await this.tenantDefaults(tenantId);
    const offer = await adapter.getHotelDetail({
      hotelId: input.hotelId,
      checkinDate: input.checkinDate,
      checkoutDate: input.checkoutDate,
      currency: input.currency ?? defaults.currency,
      rooms: input.rooms,
      roompackId: input.roompackId,
      countryCode: input.countryCode ?? defaults.countryCode,
      language: input.language,
      ttl: input.ttl,
      refundableOnly: input.refundableOnly,
    });
    // El detalle es la pantalla desde la que se reserva: sin esto mostraría el neto.
    const [priced] = await this.withPricing([offer], tenantId);
    return priced ?? offer;
  }

  // ───────────────────────── Reserva ─────────────────────────

  async prebook(tenantId: string, q: PrebookQuery): Promise<PrebookResult> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.prebook(q);
  }

  async getPaymentOptions(tenantId: string, q: PaymentOptionsQuery): Promise<PaymentModality[]> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.getPaymentOptions(q);
  }

  async book(tenantId: string, req: BookRequest): Promise<BookResult> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.book(req);
  }

  async getReservation(tenantId: string, reservationId: string): Promise<BookResult> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.getReservation(reservationId);
  }

  async cancelReservation(
    tenantId: string,
    req: CancelReservationRequest,
  ): Promise<CancelReservationResult> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.cancelReservation(req);
  }

  async recoverBooking(tenantId: string, req: RecoveryRequest): Promise<RecoveryResult> {
    const adapter = await this.factory.forTenant(tenantId);
    return adapter.recoverBooking(req);
  }

  // ───────────────────────── Helpers ─────────────────────────

  /** Moneda/país por defecto del tenant (para no obligar al cliente a enviarlos en cada búsqueda). */
  private async tenantDefaults(
    tenantId: string,
  ): Promise<{ currency: string; countryCode?: string }> {
    const t = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    const result: { currency: string; countryCode?: string } = {
      currency: (t?.default_currency ?? 'USD').trim(),
    };
    if (t?.country_code) result.countryCode = t.country_code;
    return result;
  }
}
