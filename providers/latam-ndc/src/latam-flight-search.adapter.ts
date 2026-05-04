import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, FlightSearchPort, SearchContext } from '@sales-travel/domain';
import { buildAirShoppingRequest } from './airshopping/request.builder';
import { mapAirShoppingResponse } from './airshopping/response.mapper';
import { LatamTokenService } from './auth/token.service';
import { isMockMode, type LatamNdcConfig } from './config';
import { buildMockOffers } from './fixtures';
import { LatamHttpClient } from './http/latam-http.client';

/**
 * Anti-Corruption Layer LATAM NDC.
 *
 * Modo: si las credenciales están configuradas → llama al sandbox real.
 * Si faltan o `mock=true` → devuelve fixtures canónicas (útil para CI).
 */
export class LatamNdcFlightSearchAdapter implements FlightSearchPort {
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
