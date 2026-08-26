import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, OfferPriceResult } from '@sales-travel/domain';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  AllFlightProvidersFailedError,
  ProviderCallError,
  type FlightProviderAdapter,
  type ProviderOutcome,
  type ResolvedProvider,
  type SkippedProvider,
} from '../providers/provider.types.js';
import { PricingService, applyCascade, toTenantView } from '../pricing/pricing.service.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { SearchTelemetryService, type ProviderSearchSlice } from './search-telemetry.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';
import { dedupeFlightOffers } from './offer-dedupe.js';
import { fanOut, type ProviderRun } from './provider-fanout.js';

/** Ventana de conveniencia. Corta a proposito: las tarifas cambian. */
const SEARCH_CACHE_TTL_SECONDS = 90;

/**
 * Por debajo de esta cantidad de ofertas, la primera ola se considera insuficiente y se
 * llama a los proveedores marcados como `fallback`. Es el pomo con el que se controla el
 * coste de un proveedor que cobra por consulta: subirlo lo llama más, bajarlo menos.
 */
const FALLBACK_MIN_OFFERS = 5;

/**
 * Respuesta del endpoint de búsqueda de vuelos.
 *
 * `offers` y `simulated` conservan forma Y semántica: `apps/web-b2b` las lee hoy y cambiarles
 * el significado por debajo sería justo la regresión silenciosa que este refactor existe para
 * evitar. `providers` se AÑADE, y es donde vive el detalle por proveedor.
 */
export interface FlightSearchResponse {
  offers: Offer[];
  /** Semántica VIEJA, intacta: todas las tarifas de esta lista son inventadas. */
  simulated: boolean;
  providers: ProviderOutcome[];
}

/**
 * Clave por tenant + proveedores + criterio.
 *
 * El tenant va porque el markup aplicado difiere. Los codes van porque el resultado "sin el
 * proveedor B" no puede servirse cuando B volvió, y van EN CLARO (fuera del hash) para poder
 * barrer por patrón al rotar credenciales.
 */
function flightsCacheKey(tenantId: string, c: FlightSearchCriteria, codes: string[]): string {
  const digest = createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 24);
  return `search:flights:${tenantId}:${[...codes].sort().join('+')}:${digest}`;
}

/**
 * Parte por proveedor → filas de telemetría.
 *
 * Los `skipped` NO generan fila: a ese proveedor no se le preguntó nada, y anotarlo como
 * `empty` diría que respondió sin vuelos, que es lo contrario de lo que pasó.
 */
function telemetrySlices(
  outcomes: readonly ProviderOutcome[],
  durations: ReadonlyMap<string, number>,
): ProviderSearchSlice[] {
  return outcomes.flatMap((o): ProviderSearchSlice[] => {
    if (o.status === 'skipped') return [];
    return [
      {
        providerCode: o.code,
        durationMs: durations.get(o.code) ?? 0,
        resultCount: o.count,
        outcome: o.status,
        // Código estable y agrupable, no el motivo humanizado: `error_code` existe para
        // contar fallos por tipo, y meterle texto libre del proveedor lo haría inagrupable.
        // El motivo legible ya viaja en la respuesta y en el log del fan-out.
        ...(o.status === 'error' ? { errorCode: 'ProviderCallError' } : {}),
      },
    ];
  });
}

@Injectable()
export class SearchService {
  constructor(
    private readonly registry: FlightProviderRegistry,
    private readonly pricing: PricingService,
    private readonly telemetry: SearchTelemetryService,
    private readonly breaker: CircuitBreakerService,
    private readonly cache: MemoryCacheAdapter,
  ) {}

  /**
   * `simulated` avisa que algún adaptador devolvió fixtures en vez de consultar al proveedor.
   * Un tenant al que le falte una credencial cae en modo mock EN SILENCIO y cotiza precios
   * inventados con aspecto de reales; sin esta señal, un vendedor podría pasárselos a un
   * cliente sin enterarse.
   */
  async searchFlights(
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<FlightSearchResponse> {
    // La cuota se comprueba ANTES de salir al proveedor: los proveedores cobran por
    // consulta, así que no tiene sentido gastar la llamada para después rechazarla.
    await this.telemetry.assertWithinQuota(tenantId);

    const { active, skipped } = await this.registry.forTenant(tenantId);

    // Caché por criterio: reordenar o volver atrás en el navegador no debe volver a
    // golpear al proveedor, que cobra por consulta y tarda segundos. TTL corto porque
    // las tarifas cambian; es una ventana de conveniencia, no un almacén.
    const cacheKey = flightsCacheKey(
      tenantId,
      criteria,
      active.map((p) => p.code),
    );
    const cached = await this.cache.get<FlightSearchResponse>(cacheKey);
    if (cached) return cached;

    // Latencia POR PROVEEDOR. Vive acá, en el ámbito de esta búsqueda, y no en un campo del
    // servicio: dos búsquedas concurrentes del mismo tenant se pisarían las medidas.
    const durations = new Map<string, number>();

    const result = await this.telemetry.instrument(
      {
        tenantId,
        vertical: 'flights',
        // Una fila por PROVEEDOR, todas del mismo `search_group_id`: la cuota sigue contando
        // una búsqueda (0035) y la latencia y el resultado quedan atribuidos a quien los
        // produjo, que es lo que dice si un proveedor está degradado o no aporta nada.
        providerCodes: active.map((p) => p.code),
        // Criterio reducido: ruta, fechas y pax. Nunca datos del pasajero.
        criteria: {
          origin: criteria.origin,
          destination: criteria.destination,
          departureDate: criteria.departureDate,
          returnDate: criteria.returnDate,
          cabin: criteria.cabin,
        },
      },
      () => this.runFanOut(criteria, tenantId, active, skipped, durations),
      (r) => r.offers.length,
      (r) => r.simulated,
      (r) => telemetrySlices(r.providers, durations),
    );

    // Un resultado simulado no se cachea: el tenant puede estar cargando sus credenciales en
    // este mismo momento y quedaría viendo precios falsos hasta el TTL. Un resultado
    // DEGRADADO tampoco: congelaría 90 s la ausencia de un proveedor que quizá ya volvió.
    const simulado = result.providers.some((p) => p.simulated);
    const degradado = result.providers.some((p) => p.status === 'error');
    if (!simulado && !degradado) {
      await this.cache.set(cacheKey, result, SEARCH_CACHE_TTL_SECONDS);
    }
    return result;
  }

  /**
   * Consulta a los proveedores en dos olas y arma el parte de daños.
   *
   * Ola 1: los de `callPolicy` `always` (y los `opt-in` que el tenant activó), en PARALELO.
   * Ola 2: los `fallback`, sólo si la primera ola trajo poco. Un proveedor que cobra por
   * consulta no puede quedar atado a que alguien reescriba el fan-out el día que se sepa
   * cuánto cobra.
   */
  private async runFanOut(
    criteria: FlightSearchCriteria,
    tenantId: string,
    active: ResolvedProvider<FlightProviderAdapter>[],
    skipped: SkippedProvider[],
    durations: Map<string, number>,
  ): Promise<FlightSearchResponse> {
    const counts = new Map<string, number>();
    const failures = new Map<string, string>();
    const noLlamados: SkippedProvider[] = [...skipped];

    const olaUno = active.filter((p) => p.callPolicy !== 'fallback');
    const olaDos = active.filter((p) => p.callPolicy === 'fallback');

    const items: Offer[] = [];
    const primera = await fanOut(
      olaUno.map((p) => this.toRun(p, criteria, tenantId, counts, durations)),
    );
    items.push(...primera.items);
    for (const f of primera.failed) failures.set(f.code, f.reason);

    if (olaDos.length > 0) {
      if (items.length < FALLBACK_MIN_OFFERS) {
        const segunda = await fanOut(
          olaDos.map((p) => this.toRun(p, criteria, tenantId, counts, durations)),
        );
        items.push(...segunda.items);
        for (const f of segunda.failed) failures.set(f.code, f.reason);
      } else {
        for (const p of olaDos) noLlamados.push({ code: p.code, reason: 'fallback-not-needed' });
      }
    }

    // Con TODOS los proveedores llamados caídos no hay degradación posible: se propaga el
    // error en vez de devolver una lista vacía, que el vendedor leería como "no hay vuelos"
    // y le diría eso a su cliente. Es 502 porque el fallo es del sistema de al lado.
    if (items.length === 0 && failures.size > 0) {
      throw new AllFlightProvidersFailedError(
        [...failures].map(([code, reason]) => ({ code, reason })),
      );
    }

    const llamados = active.filter((p) => !noLlamados.some((s) => s.code === p.code));

    return {
      // El dedupe va ANTES de `withPricing` (RF-06 CA-4): la cascada de markup se calcula sobre
      // las ofertas que sobreviven, no sobre las que se van a tirar. `dedupeFlightOffers` lo
      // exige de forma explícita y falla si se invierte el orden.
      offers: await this.withPricing(dedupeFlightOffers(items), tenantId, 'flights'),
      // Semántica VIEJA de `simulated`: todo lo que hay acá dentro es falso. La nueva —hay
      // AL MENOS UNA tarifa falsa— viaja por proveedor en `providers[].simulated`.
      simulated: llamados.length > 0 && llamados.every((p) => p.simulated),
      providers: this.outcomes(active, counts, failures, noLlamados),
    };
  }

  private toRun(
    provider: ResolvedProvider<FlightProviderAdapter>,
    criteria: FlightSearchCriteria,
    tenantId: string,
    counts: Map<string, number>,
    durations: Map<string, number>,
  ): ProviderRun<Offer> {
    return {
      code: provider.code,
      run: async () => {
        // Se mide acá y no alrededor del fan-out entero: el fan-out es paralelo, así que su
        // duración total es la del más lento y no dice nada de los demás.
        const startedAt = Date.now();
        try {
          // A través del circuito: si el proveedor está caído, falla al instante en vez de
          // esperar el timeout completo en cada búsqueda.
          const offers = await this.breaker.execute(provider.code, () =>
            provider.adapter.search(criteria, { tenantId }),
          );
          counts.set(provider.code, offers.length);
          return offers;
        } catch (err) {
          // El motivo se humaniza en la rama del proveedor: así el agregador no necesita
          // conocer los tipos de error de ninguno.
          throw new ProviderCallError(
            provider.code,
            this.registry.humanizeError(provider.code, err),
            err,
          );
        } finally {
          // También en el camino de error: cuánto tardó en fallar es justo el dato que
          // distingue un rechazo inmediato de un timeout.
          durations.set(provider.code, Date.now() - startedAt);
        }
      },
    };
  }

  /** Parte por proveedor, en el mismo orden estable que devuelve el registry. */
  private outcomes(
    active: ResolvedProvider<FlightProviderAdapter>[],
    counts: Map<string, number>,
    failures: Map<string, string>,
    noLlamados: SkippedProvider[],
  ): ProviderOutcome[] {
    const deActivos = active.map((p): ProviderOutcome => {
      const reason = failures.get(p.code);
      if (reason !== undefined) {
        return { code: p.code, status: 'error', count: 0, simulated: p.simulated, reason };
      }

      const salteado = noLlamados.find((s) => s.code === p.code);
      if (salteado) {
        return {
          code: p.code,
          status: 'skipped',
          count: 0,
          simulated: p.simulated,
          skipReason: salteado.reason,
        };
      }

      const count = counts.get(p.code) ?? 0;
      return {
        code: p.code,
        status: p.simulated ? 'simulated' : count > 0 ? 'ok' : 'empty',
        count,
        simulated: p.simulated,
      };
    });

    const soloSalteados = noLlamados
      .filter((s) => !active.some((p) => p.code === s.code))
      .map(
        (s): ProviderOutcome => ({
          code: s.code,
          status: 'skipped',
          count: 0,
          simulated: false,
          skipReason: s.reason,
        }),
      );

    return [...deActivos, ...soloSalteados].sort((a, b) =>
      a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );
  }

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<OfferPriceResult> {
    // Enruta por el proveedor QUE EMITIÓ la oferta. Antes iba siempre al único proveedor
    // inyectado: con dos, revalidar una oferta ajena habría devuelto precios de otro vuelo.
    const provider = await this.registry.byCode(tenantId, offer.provider.name);
    const result = await provider.adapter.priceOffer(offer, criteria, { tenantId });

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
