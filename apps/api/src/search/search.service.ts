import { Injectable } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, OfferPriceResult } from '@sales-travel/domain';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';
import { PricingService, applyCascade, toTenantView } from '../pricing/pricing.service.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { SearchTelemetryService } from './search-telemetry.service.js';

/** Único proveedor de vuelos por ahora; el fan-out multi-proveedor va aparte. */
const FLIGHTS_PROVIDER = 'latam-ndc';

@Injectable()
export class SearchService {
  constructor(
    private readonly latam: LatamNdcProviderFactory,
    private readonly pricing: PricingService,
    private readonly telemetry: SearchTelemetryService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  /**
   * `simulated` avisa que el adaptador devolvió fixtures en vez de consultar a LATAM.
   * Un tenant al que le falte una credencial cae en modo mock EN SILENCIO y cotiza
   * precios inventados con aspecto de reales; sin esta señal, un vendedor podría
   * pasárselos a un cliente sin enterarse.
   */
  async searchFlights(
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<{ offers: Offer[]; simulated: boolean }> {
    // La cuota se comprueba ANTES de salir al proveedor: los proveedores cobran por
    // consulta, así que no tiene sentido gastar la llamada para después rechazarla.
    await this.telemetry.assertWithinQuota(tenantId);

    return this.telemetry.instrument(
      {
        tenantId,
        vertical: 'flights',
        providerCode: FLIGHTS_PROVIDER,
        // Criterio reducido: ruta, fechas y pax. Nunca datos del pasajero.
        criteria: {
          origin: criteria.origin,
          destination: criteria.destination,
          departureDate: criteria.departureDate,
          returnDate: criteria.returnDate,
          cabin: criteria.cabin,
        },
      },
      async () => {
        const adapter = await this.latam.forTenant(tenantId);
        // A través del circuito: si LATAM está caído, falla al instante en vez de
        // esperar el timeout completo en cada búsqueda.
        const offers = await this.breaker.execute(FLIGHTS_PROVIDER, () =>
          adapter.search(criteria, { tenantId }),
        );
        return {
          offers: await this.withPricing(offers, tenantId, 'flights'),
          simulated: adapter.isMock,
        };
      },
      (r) => r.offers.length,
      (r) => r.simulated,
    );
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<OfferPriceResult> {
    const adapter = await this.latam.forTenant(tenantId);
    const result = await adapter.priceOffer(offer, criteria, { tenantId });

    // La revalidación de precio devolvía la oferta del proveedor SIN pasar por el
    // waterfall, así que el último paso antes de reservar descartaba el markup y la
    // agencia terminaba vendiendo al costo. Es el mismo tratamiento que la búsqueda.
    const [priced] = await this.withPricing([result.offer], tenantId, 'flights');
    return { ...result, offer: priced ?? result.offer };
  }

  /**
   * Adjunta el pricing waterfall del consolidador a cada oferta. `total` (neto del
   * proveedor) NO se muta; `pricing.finalMinor` es el precio de venta. Sin reglas
   * aplicables, devuelve las ofertas sin tocar (precio = neto).
   */
  private async withPricing(offers: Offer[], tenantId: string, vertical: string): Promise<Offer[]> {
    const rules = await this.pricing.getApplicableRules(tenantId, vertical);
    if (rules.length === 0) return offers;
    return offers.map((o) => ({
      ...o,
      // Vista acotada al tenant: sin netMinor ni breakdown, que revelarían el margen
      // del consolidador a la agencia que está mirando los resultados.
      pricing: toTenantView(applyCascade(o.total.amountMinor, rules), tenantId, o.total.currency),
    }));
  }
}
