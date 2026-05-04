import type { Offer } from '@sales-travel/canonical';
import type {
  FlightSearchCriteria,
  FlightSearchPort,
  SearchContext,
} from '@sales-travel/domain/ports';
import { isMockMode, type LatamNdcConfig } from './config';
import { buildMockOffers } from './fixtures';

/**
 * Anti-Corruption Layer LATAM NDC.
 *
 * Hoy: modo mock (fixtures canónicas).
 * Mañana: cuando lleguen las credenciales reales, reemplazar `searchReal()`
 * con el HTTP client contra el endpoint NDC AirShopping de LATAM.
 *
 * El contrato hacia adentro de la app (FlightSearchPort) NO cambia entre
 * modo mock y real — esa es la razón de existir del ACL.
 */
export class LatamNdcFlightSearchAdapter implements FlightSearchPort {
  constructor(private readonly cfg: LatamNdcConfig) {}

  async search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    if (isMockMode(this.cfg)) {
      return Promise.resolve(buildMockOffers(criteria, ctx.tenantId));
    }
    return this.searchReal(criteria, ctx);
  }

  /**
   * TODO(latam-ndc): implementar contra LATAM NDC AirShopping API.
   *
   * Pasos cuando lleguen credenciales:
   *   1. POST {apiUrl}/v1/AirShopping con headers
   *      Authorization: Bearer {apiKey}, X-Agency-Id: {agencyId}.
   *   2. Body en formato NDC IATA OrderViewRS / AirShoppingRQ.
   *   3. Mapear AirShoppingRS.OffersGroup.AirlineOffers[].Offer[] a Offer
   *      canónica (price → Money en minor units, segments → Segment con
   *      ISO8601 con offset, etc.).
   *   4. Parsear errores NDC y mapear a una excepción tipada del dominio.
   *   5. Setear `expiresAt` desde Offer.TimeLimits.OfferExpiration.
   */
  private async searchReal(_criteria: FlightSearchCriteria, _ctx: SearchContext): Promise<Offer[]> {
    throw new Error('LatamNdcFlightSearchAdapter: real mode not implemented yet');
  }
}
