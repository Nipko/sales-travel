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
  OrderView,
  SearchContext,
  ServiceListRequest,
  ServiceListResult,
} from '@sales-travel/domain';
import { buildAirShoppingRequest, currencyToCountry } from './airshopping/request.builder';
import { mapAirShoppingResponse } from './airshopping/response.mapper';
import { LatamTokenService } from './auth/token.service';
import { missingLatamCredentials, type LatamNdcConfig } from './config';
import { LatamCredentialsMissingError } from './errors';
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
 * Un único modo: llama a LATAM. Ya no existe la rama de fixtures que devolvía tres ofertas
 * inventadas cuando faltaba una credencial — tenían la misma forma canónica que una tarifa
 * real y llegaban a la pantalla del vendedor sin distinguirse. Sin credenciales usables esta
 * clase NO se construye (ver el constructor), así que ninguna instancia puede fabricar una
 * oferta.
 */
export class LatamNdcFlightSearchAdapter
  implements FlightSearchPort, OfferPricePort, OrderCreatePort, OrderManagePort
{
  private readonly tokens: LatamTokenService;
  private readonly http: LatamHttpClient;

  /**
   * Rechaza la construcción sin credenciales usables.
   *
   * Está aquí —y no sólo en el factory de `apps/api`— porque es la barrera que un sitio de
   * construcción NUEVO hereda sin tener que acordarse de nada. La del factory sigue siendo la
   * que produce una ausencia explicada; ésta sólo garantiza que el objeto no llegue a existir.
   */
  constructor(private readonly cfg: LatamNdcConfig) {
    const missing = missingLatamCredentials(cfg);
    if (missing.length > 0) throw new LatamCredentialsMissingError(missing);

    this.tokens = new LatamTokenService(cfg);
    this.http = new LatamHttpClient(cfg, this.tokens);
    // Sólo hay un modo, pero la línea se conserva: es la marca de arranque con la que se
    // verifica en producción que el adapter quedó en pie para el tenant.
    console.warn('[latam-ndc] adapter initialized');
  }
  async search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    const derivedCountry = currencyToCountry(criteria.currency);
    if (derivedCountry && this.cfg.country && derivedCountry !== this.cfg.country) {
      console.warn(
        `[LatamNdcFlightSearchAdapter] POS mismatch warning: requested currency '${criteria.currency}' maps to country '${derivedCountry}', but agency default is '${this.cfg.country}'. Sandbox keys may fail if they don't support '${derivedCountry}' Point of Sale.`,
      );
    }

    const xml = buildAirShoppingRequest(criteria, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/airshopping', xml, {
      trackId: ctx.requestId,
      country: derivedCountry,
    });

    const { offers, warnings } = mapAirShoppingResponse(raw, criteria, ctx.tenantId);
    if (warnings && warnings.length > 0) {
      console.warn(
        `[LatamNdcFlightSearchAdapter] AirShopping warnings/errors:`,
        JSON.stringify(warnings),
      );
    }
    return offers;
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    const derivedCountry = currencyToCountry(criteria.currency);
    if (derivedCountry && this.cfg.country && derivedCountry !== this.cfg.country) {
      console.warn(
        `[LatamNdcFlightSearchAdapter] POS mismatch warning in OfferPrice: requested currency '${criteria.currency}' maps to country '${derivedCountry}', but agency default is '${this.cfg.country}'.`,
      );
    }

    const xml = buildOfferPriceRequest(offer, criteria, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/offerPrice', xml, {
      trackId: ctx.requestId,
      country: derivedCountry,
    });

    const result = mapOfferPriceResponse(raw, offer);
    if (result.warnings && result.warnings.length > 0) {
      console.warn(
        `[LatamNdcFlightSearchAdapter] OfferPrice warnings/errors:`,
        JSON.stringify(result.warnings),
      );
    }
    return result;
  }

  async createOrder(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateResult> {
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

  async retrieveForDisplay(orderId: string, ctx: SearchContext): Promise<OrderView> {
    const xml = buildOrderRetrieveRequest(orderId, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/retrieve', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderRetrieveResponse(raw);
  }

  async cancelOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult> {
    const xml = buildOrderCancelRequest(orderId, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/cancel', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderCancelResponse(raw);
  }

  async cancelBnplOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult> {
    const xml = buildOrderCancelRequest(orderId, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/cancel/bnpl', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderCancelResponse(raw);
  }

  async payOrder(request: OrderPayRequest, ctx: SearchContext): Promise<OrderPayResult> {
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
    const xml = buildOrderReshopRequest(request, this.cfg);
    const raw = await this.http.postNdc<unknown>('/ndc/v192/order/requote', xml, {
      trackId: ctx.requestId,
    });

    return mapOrderReshopResponse(raw);
  }
}
