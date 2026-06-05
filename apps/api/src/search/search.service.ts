import { Injectable } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, OfferPriceResult } from '@sales-travel/domain';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';
import { PricingService, applyCascade } from '../pricing/pricing.service.js';

@Injectable()
export class SearchService {
  constructor(
    private readonly latam: LatamNdcProviderFactory,
    private readonly pricing: PricingService,
  ) {}

  async searchFlights(criteria: FlightSearchCriteria, tenantId: string): Promise<Offer[]> {
    const adapter = await this.latam.forTenant(tenantId);
    const offers = await adapter.search(criteria, { tenantId });
    return this.withPricing(offers, tenantId, 'flights');
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<OfferPriceResult> {
    const adapter = await this.latam.forTenant(tenantId);
    return adapter.priceOffer(offer, criteria, { tenantId });
  }

  /**
   * Adjunta el pricing waterfall del consolidador a cada oferta. `total` (neto del
   * proveedor) NO se muta; `pricing.finalMinor` es el precio de venta. Sin reglas
   * aplicables, devuelve las ofertas sin tocar (precio = neto).
   */
  private async withPricing(offers: Offer[], tenantId: string, vertical: string): Promise<Offer[]> {
    const rules = await this.pricing.getApplicableRules(tenantId, vertical);
    if (rules.length === 0) return offers;
    return offers.map((o) => {
      const w = applyCascade(o.total.amountMinor, rules);
      return {
        ...o,
        pricing: {
          netMinor: w.netMinor,
          finalMinor: w.finalMinor,
          totalMarkupMinor: w.totalMarkupMinor,
          currency: o.total.currency,
          breakdown: w.breakdown,
        },
      };
    });
  }
}
