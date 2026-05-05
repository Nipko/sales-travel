import type { Offer } from '@sales-travel/canonical';
import type {
  FlightSearchCriteria,
  FlightSearchPort,
  OfferPricePort,
  OfferPriceResult,
  OrderCancelResult,
  OrderCreatePort,
  OrderCreateRequest,
  OrderCreateResult,
  OrderManagePort,
  OrderRetrieveResult,
  SearchContext,
} from '@sales-travel/domain';
import { buildAirShoppingRequest } from './airshopping/request.builder';
import { mapAirShoppingResponse } from './airshopping/response.mapper';
import { LatamTokenService } from './auth/token.service';
import { isMockMode, type LatamNdcConfig } from './config';
import { buildMockOffers } from './fixtures';
import { LatamHttpClient } from './http/latam-http.client';
import { buildOfferPriceRequest } from './offerprice/request.builder';
import { mapOfferPriceResponse } from './offerprice/response.mapper';
import { buildOrderCreateRequest } from './ordercreate/request.builder';
import { mapOrderCreateResponse } from './ordercreate/response.mapper';
import { buildOrderCancelRequest, buildOrderRetrieveRequest } from './ordermanage/request.builders';
import { mapOrderCancelResponse, mapOrderRetrieveResponse } from './ordermanage/response.mappers';

/**
 * Anti-Corruption Layer LATAM NDC.
 *
 * Modo: si las credenciales están configuradas → llama al sandbox real.
 * Si faltan o `mock=true` → devuelve fixtures canónicas (útil para CI).
 */
export class LatamNdcFlightSearchAdapter
  implements FlightSearchPort, OfferPricePort, OrderCreatePort, OrderManagePort
{
  private readonly tokens: LatamTokenService;
  private readonly http: LatamHttpClient;

  constructor(private readonly cfg: LatamNdcConfig) {
    this.tokens = new LatamTokenService(cfg);
    this.http = new LatamHttpClient(cfg, this.tokens);
    const mode = isMockMode(cfg) ? 'mock' : 'real';
    const missing = isMockMode(cfg) ? listMissingFields(cfg) : [];
    console.warn(
      `[latam-ndc] adapter initialized in ${mode} mode${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
    );
  }

  async search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    if (isMockMode(this.cfg)) {
      return buildMockOffers(criteria, ctx.tenantId);
    }

    const xml = buildAirShoppingRequest(criteria, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/airshopping', xml, {
      trackId: ctx.requestId,
    });

    const { offers } = mapAirShoppingResponse(raw, criteria, ctx.tenantId);
    return offers;
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    if (isMockMode(this.cfg)) {
      return {
        offer: {
          ...offer,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          fetchedAt: new Date().toISOString(),
        },
        priceChanged: false,
        warnings: ['mock mode: price confirmed (no real API call)'],
      };
    }

    const xml = buildOfferPriceRequest(offer, criteria, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/offerPrice', xml, {
      trackId: ctx.requestId,
    });

    return mapOfferPriceResponse(raw, offer);
  }

  async createOrder(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateResult> {
    if (isMockMode(this.cfg)) {
      return {
        success: true,
        orderId: `MOCK-${Date.now()}`,
        pnr: 'MOCKPNR',
        warnings: ['mock mode: order created (no real API call)'],
      };
    }

    const xml = buildOrderCreateRequest(
      request.offer,
      request.passengers,
      request.contactInfo,
      this.cfg,
    );
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/create', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderCreateResponse(raw);
  }

  async retrieveOrder(orderId: string, ctx: SearchContext): Promise<OrderRetrieveResult> {
    if (isMockMode(this.cfg)) {
      return {
        found: true,
        orderId,
        status: 'confirmed',
        warnings: ['mock mode: order retrieved (no real API call)'],
      };
    }

    const xml = buildOrderRetrieveRequest(orderId, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/retrieve', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderRetrieveResponse(raw);
  }

  async cancelOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult> {
    if (isMockMode(this.cfg)) {
      return {
        success: true,
        warnings: ['mock mode: order cancelled (no real API call)'],
      };
    }

    const xml = buildOrderCancelRequest(orderId, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/cancel', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderCancelResponse(raw);
  }
}

function listMissingFields(cfg: LatamNdcConfig): string[] {
  const missing: string[] = [];
  if (!cfg.apiKey) missing.push('apiKey');
  if (!cfg.apiSecret) missing.push('apiSecret');
  if (!cfg.agencyId) missing.push('agencyId');
  if (!cfg.agencyIata) missing.push('agencyIata');
  if (!cfg.country) missing.push('country');
  return missing;
}
