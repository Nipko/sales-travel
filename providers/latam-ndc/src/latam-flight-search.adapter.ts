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
  OrderPayRequest,
  OrderPayResult,
  OrderReshopRequest,
  OrderReshopResult,
  OrderRetrieveResult,
  SearchContext,
  ServiceListRequest,
  ServiceListResult,
} from '@sales-travel/domain';
import { buildAirShoppingRequest, currencyToCountry } from './airshopping/request.builder';
import { mapAirShoppingResponse } from './airshopping/response.mapper';
import { LatamTokenService } from './auth/token.service';
import { isMockMode, type LatamNdcConfig } from './config';
import { buildMockOffers } from './fixtures';
import { LatamHttpClient } from './http/latam-http.client';
import { buildOfferPriceRequest } from './offerprice/request.builder';
import { mapOfferPriceResponse } from './offerprice/response.mapper';
import { buildOrderChangePaymentRequest } from './orderchange/request.builder';
import { mapOrderChangePaymentResponse } from './orderchange/response.mapper';
import { buildOrderCreateRequest } from './ordercreate/request.builder';
import { mapOrderCreateResponse } from './ordercreate/response.mapper';
import { buildOrderCancelRequest, buildOrderRetrieveRequest } from './ordermanage/request.builders';
import { mapOrderCancelResponse, mapOrderRetrieveResponse } from './ordermanage/response.mappers';
import { buildOrderReshopRequest } from './orderreshop/request.builder';
import { mapOrderReshopResponse } from './orderreshop/response.mapper';
import { buildServiceListRequest } from './servicelist/request.builder';
import { mapServiceListResponse } from './servicelist/response.mapper';

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
      country: currencyToCountry(criteria.currency),
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
      country: currencyToCountry(criteria.currency),
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
      request.criteria?.currency,
      request.payment,
    );
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/create', xml, {
      trackId: ctx.requestId,
      country: currencyToCountry(request.criteria?.currency),
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

  async cancelBnplOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult> {
    if (isMockMode(this.cfg)) {
      return {
        success: true,
        warnings: ['mock mode: BNPL order cancelled (no real API call)'],
      };
    }

    const xml = buildOrderCancelRequest(orderId, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/cancel/bnpl', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderCancelResponse(raw);
  }

  async payOrder(request: OrderPayRequest, ctx: SearchContext): Promise<OrderPayResult> {
    if (isMockMode(this.cfg)) {
      return {
        success: true,
        orderId: request.orderId,
        status: 'confirmed',
        warnings: ['mock mode: order paid (no real API call)'],
      };
    }

    const xml = buildOrderChangePaymentRequest(
      request.orderId,
      request.payment,
      request.contactInfo,
      request.passengers,
      this.cfg,
    );
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/change/payment', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderChangePaymentResponse(raw);
  }

  async listServices(request: ServiceListRequest, ctx: SearchContext): Promise<ServiceListResult> {
    if (isMockMode(this.cfg)) {
      return {
        services: [],
        warnings: ['mock mode: no services available (no real API call)'],
      };
    }

    const xml = buildServiceListRequest(request, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/services/list', xml, {
      trackId: ctx.requestId,
    });

    return mapServiceListResponse(raw);
  }

  async reshopWithTickets(
    request: OrderReshopRequest,
    ctx: SearchContext,
  ): Promise<OrderReshopResult> {
    if (isMockMode(this.cfg)) {
      return {
        success: true,
        amountDue: { amount: 0, currency: 'COP' },
        isResidualValue: false,
        warnings: ['mock mode: reshop simulated (no real API call)'],
      };
    }

    const xml = buildOrderReshopRequest(request, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/requote', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderReshopResponse(raw);
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
