import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, OfferPriceResult } from '@sales-travel/domain';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';
import { PricingService, applyCascade, toTenantView } from '../pricing/pricing.service.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { SearchTelemetryService } from './search-telemetry.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';
import { fanOut } from './provider-fanout.js';

/** Único proveedor de vuelos por ahora; el fan-out multi-proveedor va aparte. */
const FLIGHTS_PROVIDER = 'latam-ndc';

/** Ventana de conveniencia. Corta a proposito: las tarifas cambian. */
const SEARCH_CACHE_TTL_SECONDS = 90;

/** Clave por tenant + criterio. Incluye el tenant porque el markup aplicado difiere. */
function flightsCacheKey(tenantId: string, c: FlightSearchCriteria): string {
  const digest = createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 24);
  return `search:flights:${tenantId}:${digest}`;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly latam: LatamNdcProviderFactory,
    private readonly pricing: PricingService,
    private readonly telemetry: SearchTelemetryService,
    private readonly breaker: CircuitBreakerService,
    private readonly cache: MemoryCacheAdapter,
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

    // Caché por criterio: reordenar o volver atrás en el navegador no debe volver a
    // golpear al proveedor, que cobra por consulta y tarda segundos. TTL corto porque
    // las tarifas cambian; es una ventana de conveniencia, no un almacén.
    const cacheKey = flightsCacheKey(tenantId, criteria);
    const cached = await this.cache.get<{ offers: Offer[]; simulated: boolean }>(cacheKey);
    if (cached) return cached;

    const result = await this.telemetry.instrument(
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

        // Fan-out: hoy hay un solo proveedor de vuelos, pero pasa por la misma ruta que
        // usarán los demás. Sumar Amadeus o Sabre es agregar una entrada a este arreglo,
        // no reescribir el servicio — y desde ya se obtiene degradación parcial.
        const { items, failed } = await fanOut([
          {
            code: FLIGHTS_PROVIDER,
            // A través del circuito: si el proveedor está caído, falla al instante en
            // vez de esperar el timeout completo en cada búsqueda.
            run: () =>
              this.breaker.execute(FLIGHTS_PROVIDER, () => adapter.search(criteria, { tenantId })),
          },
        ]);

        // Con TODOS los proveedores caídos no hay degradación posible: se propaga el
        // error en vez de devolver una lista vacía, que el vendedor leería como
        // "no hay vuelos" y le diría eso a su cliente.
        if (items.length === 0 && failed.length > 0) {
          throw new Error(failed.map((f) => `${f.code}: ${f.reason}`).join('; '));
        }

        return {
          offers: await this.withPricing(items, tenantId, 'flights'),
          simulated: adapter.isMock,
        };
      },
      (r) => r.offers.length,
      (r) => r.simulated,
    );

    // Un resultado simulado no se cachea: el tenant puede estar cargando sus
    // credenciales en este mismo momento y quedaría viendo precios falsos hasta el TTL.
    if (!result.simulated) {
      await this.cache.set(cacheKey, result, SEARCH_CACHE_TTL_SECONDS);
    }
    return result;
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
