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
import { AIRSHOPPING_PATH, mapAirShoppingResponse } from './airshopping/response.mapper';
import { LatamTokenService } from './auth/token.service';
import { missingLatamCredentials, type LatamNdcConfig } from './config';
import { LatamBusinessError, LatamCredentialsMissingError } from './errors';
import { LatamHttpClient } from './http/latam-http.client';
import { buildOfferPriceRequest } from './offerprice/request.builder';
import { OFFERPRICE_PATH, mapOfferPriceResponse } from './offerprice/response.mapper';
import { buildOrderChangePaymentRequest } from './orderchange/request.builder';
import { mapOrderChangePaymentResponse } from './orderchange/response.mapper';
import { buildOrderCreateRequest } from './ordercreate/request.builder';
import { mapOrderCreateResponse } from './ordercreate/response.mapper';
import { buildOrderCancelRequest, buildOrderRetrieveRequest } from './ordermanage/request.builders';
import {
  ORDER_RETRIEVE_PATH,
  mapOrderCancelResponse,
  mapOrderRetrieveResponse,
} from './ordermanage/response.mappers';
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
    const country = currencyToCountry(criteria.currency);
    const xml = buildAirShoppingRequest(criteria, this.cfg);

    // 914 «retrieveTaggedOffer method failed» es transitorio: LATAM pide reintentar 1 o 2 veces
    // (`[portal:/ndc/status]`).
    for (let attempt = 1; ; attempt++) {
      const { data, trackId } = await this.http.postNdc<unknown>(AIRSHOPPING_PATH, xml, {
        country,
      });
      try {
        const { offers, warnings } = mapAirShoppingResponse(data, criteria, ctx.tenantId, trackId);
        if (warnings.length > 0) {
          console.warn(
            `[latam-ndc] AirShopping track=${trackId} warnings: ${JSON.stringify(warnings)}`,
          );
        }
        return offers;
      } catch (err) {
        if (err instanceof LatamBusinessError && err.hasCode('914') && attempt < 3) continue;
        if (err instanceof LatamBusinessError) {
          console.warn(`[latam-ndc] AirShopping track=${trackId} error: ${err.body}`);
        }
        throw err;
      }
    }
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    _ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    const xml = buildOfferPriceRequest(offer, criteria, this.cfg);
    const { data, trackId } = await this.http.postNdc<unknown>(OFFERPRICE_PATH, xml, {
      country: currencyToCountry(criteria.currency),
    });
    return mapOfferPriceResponse(data, offer, trackId);
  }

  async createOrder(request: OrderCreateRequest, _ctx: SearchContext): Promise<OrderCreateResult> {
    const xml = buildOrderCreateRequest(
      request.offer,
      request.passengers,
      request.contactInfo,
      this.cfg,
      request.criteria?.currency,
      request.payment,
    );
    const { data, trackId } = await this.http.postNdc<unknown>('/ndc/v192/order/create', xml, {
      country: currencyToCountry(request.criteria?.currency),
    });
    const result = mapOrderCreateResponse(data);
    if (result.outcome === 'FAILED') {
      console.warn(
        `[latam-ndc] OrderCreate track=${trackId} failed: ${result.issues.map((i) => i.type).join(',')}`,
      );
    }
    return result;
  }

  async retrieveForDisplay(orderId: string, _ctx: SearchContext): Promise<OrderView> {
    const xml = buildOrderRetrieveRequest(orderId, this.cfg);
    const { data, trackId } = await this.http.postNdc<unknown>(ORDER_RETRIEVE_PATH, xml);
    return mapOrderRetrieveResponse(data, trackId);
  }

  async cancelOrder(orderId: string, _ctx: SearchContext): Promise<OrderCancelResult> {
    const xml = buildOrderCancelRequest(orderId, this.cfg);
    const { data } = await this.http.postNdc<unknown>('/ndc/v192/order/cancel', xml);
    return mapOrderCancelResponse(data);
  }

  async cancelBnplOrder(orderId: string, _ctx: SearchContext): Promise<OrderCancelResult> {
    const xml = buildOrderCancelRequest(orderId, this.cfg);
    const { data } = await this.http.postNdc<unknown>('/ndc/v192/order/cancel/bnpl', xml);
    return mapOrderCancelResponse(data);
  }

  async payOrder(request: OrderPayRequest, _ctx: SearchContext): Promise<OrderPayResult> {
    const xml = buildOrderChangePaymentRequest(
      request.orderId,
      request.payment,
      request.contactInfo,
      request.passengers,
      this.cfg,
    );
    const { data } = await this.http.postNdc<unknown>('/ndc/v192/order/change/payment', xml);
    return mapOrderChangePaymentResponse(data);
  }

  async listServices(request: ServiceListRequest, _ctx: SearchContext): Promise<ServiceListResult> {
    const xml = buildServiceListRequest(request, this.cfg);
    const { data } = await this.http.postNdc<unknown>('/ndc/v192/services/list', xml);
    return mapServiceListResponse(data);
  }

  async reshopWithTickets(
    request: OrderReshopRequest,
    _ctx: SearchContext,
  ): Promise<OrderReshopResult> {
    const xml = buildOrderReshopRequest(request, this.cfg);
    const { data } = await this.http.postNdc<unknown>('/ndc/v192/order/requote', xml);
    return mapOrderReshopResponse(data);
  }
}
