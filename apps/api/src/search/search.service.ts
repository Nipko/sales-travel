import { Inject, Injectable } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import {
  FLIGHT_SEARCH_PORT,
  OFFER_PRICE_PORT,
  type FlightSearchCriteria,
  type FlightSearchPort,
  type OfferPricePort,
  type OfferPriceResult,
} from '@sales-travel/domain';

@Injectable()
export class SearchService {
  constructor(
    @Inject(FLIGHT_SEARCH_PORT) private readonly flightSearch: FlightSearchPort,
    @Inject(OFFER_PRICE_PORT) private readonly offerPrice: OfferPricePort,
  ) {}

  async searchFlights(criteria: FlightSearchCriteria, tenantId: string): Promise<Offer[]> {
    return this.flightSearch.search(criteria, { tenantId });
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<OfferPriceResult> {
    return this.offerPrice.priceOffer(offer, criteria, { tenantId });
  }
}
