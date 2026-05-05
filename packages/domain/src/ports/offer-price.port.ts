import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from './flight-search.port';

export interface OfferPriceResult {
  offer: Offer;
  priceChanged: boolean;
  warnings: string[];
}

export interface OfferPricePort {
  priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult>;
}

export const OFFER_PRICE_PORT = 'OFFER_PRICE_PORT';
