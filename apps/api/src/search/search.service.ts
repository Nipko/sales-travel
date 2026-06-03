import { Injectable } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, OfferPriceResult } from '@sales-travel/domain';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';

@Injectable()
export class SearchService {
  constructor(private readonly latam: LatamNdcProviderFactory) {}

  async searchFlights(criteria: FlightSearchCriteria, tenantId: string): Promise<Offer[]> {
    const adapter = await this.latam.forTenant(tenantId);
    return adapter.search(criteria, { tenantId });
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<OfferPriceResult> {
    const adapter = await this.latam.forTenant(tenantId);
    return adapter.priceOffer(offer, criteria, { tenantId });
  }
}
