import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, OfferPriceResult } from '@sales-travel/domain';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  AllFlightProvidersFailedError,
  ProviderCallError,
  SIMULATED_RESIDUE,
  type FlightProviderAdapter,
  type ProviderOutcome,
  type ResolvedProvider,
  type SkippedProvider,
  type UnavailableProvider,
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
  /**
   * RESIDUO DE TRANSICIÓN: siempre `false`.
   *
   * Significaba "todas las tarifas de esta lista son inventadas", y era verdad porque un
   * proveedor sin credenciales devolvía fixtures. Esa rama ya no existe en ningún adapter, así
   * que el campo no tiene nada que señalar. Se CONSERVA —en vez de retirarse del contrato—
   * porque `apps/web-b2b/src/app/(app)/cotizaciones/` lo lee hoy y ese fichero está siendo
   * reescrito por otra tanda: quitarlo ahora rompería la pantalla en el peor sitio posible.
   *
   * Retirar junto con `providers[].simulated` y `status: 'simulated'` cuando la UI deje de
   * leerlos — plazo: al cerrar esa reescritura, y como muy tarde 2026-10-31.
   */
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
 * Separa las ofertas que la agencia puede cotizar de las que volvieron en otra moneda.
 *
 * ## Por qué existe esta puerta y por qué está acá
 *
 * En producción convivían en la MISMA lista `BRL 1.286` y `$ 859.100`. No es cosmético:
 *
 * 1. `1.286` se lee como más barato que `859.100` y son ~1,1 millones de pesos. El vendedor
 *    cotiza la equivocada.
 * 2. El orden por precio compara números de monedas distintas, así que no ordena nada.
 * 3. `dedupeFlightOffers` se rinde explícitamente con más de una moneda en el conjunto: el
 *    mismo vuelo aparece dos veces porque nadie resolvió la moneda aguas arriba.
 *
 * Cada ACL pide la moneda del tenant a su proveedor (Sabre por
 * `PriceRequestInformation.CurrencyCode`, LATAM por el `CountryCode` del POS) y el de Sabre ya
 * descarta lo que no encaje. Esta puerta es la SEGUNDA mitad, y es imprescindible por dos
 * motivos: un proveedor puede ignorar lo que se le pide, y este es el único punto que ve las
 * ofertas de TODOS los proveedores juntas —que es exactamente donde se produce la mezcla—.
 *
 * ## Descartar, no convertir ni marcar
 *
 * Convertir exigiría una tasa que no tenemos ni del proveedor ni contratada, y una tasa
 * inventada convierte un precio real en uno que nadie puede cobrar. Marcar tampoco alcanza: la
 * fila marcada sigue en la lista, sigue rompiendo el orden por precio de todas las demás y sigue
 * bloqueando el dedupe. Lo que se descarta NO se calla: ver {@link SearchService.aplicarDescartesDeMoneda}
 * —un proveedor que se queda sin nada cotizable sale en `providers[]` con su motivo, y un
 * descarte parcial queda en el log.
 */
function splitByCurrency(
  offers: readonly Offer[],
  currency: string,
): { kept: Offer[]; rejected: Offer[] } {
  const kept: Offer[] = [];
  const rejected: Offer[] = [];
  for (const offer of offers) {
    if (offer.total.currency === currency) kept.push(offer);
    else rejected.push(offer);
  }
  return { kept, rejected };
}

/**
 * Motivo para el vendedor, con el vocabulario del panel ("Mi Red → Credenciales") y sin texto
 * libre del proveedor: sólo códigos de moneda, que no son PII y son el dato accionable.
 */
function currencyMismatchReason(rejected: readonly Offer[], expected: string): string {
  const devueltas = [...new Set(rejected.map((o) => o.total.currency))].sort().join(', ');
  return `devolvió tarifas en ${devueltas} y esta agencia vende en ${expected}: no son cotizables. Revisá el punto de venta del proveedor en Mi Red → Credenciales.`;
}

/**
 * Parte por proveedor → filas de telemetría.
 *
 * Los `skipped` y los `unavailable` NO generan fila: a esos proveedores no se les preguntó
 * nada, y anotarlos como `empty` diría que respondieron sin vuelos, que es lo contrario de lo
 * que pasó. Además `search_logs.outcome` no conoce esos valores.
 */
function telemetrySlices(
  outcomes: readonly ProviderOutcome[],
  durations: ReadonlyMap<string, number>,
): ProviderSearchSlice[] {
  return outcomes.flatMap((o): ProviderSearchSlice[] => {
    // `'simulated'` está en la lista por una razón distinta a las otras dos: no se emite nunca
    // —el API ya no puede fabricar tarifas— y se nombra aquí para que el mapeo al vocabulario
    // de `search_logs.outcome` no necesite un cast que se comería un valor nuevo sin avisar.
    if (o.status === 'skipped' || o.status === 'unavailable' || o.status === 'simulated') {
      return [];
    }
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
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly registry: FlightProviderRegistry,
    private readonly pricing: PricingService,
    private readonly telemetry: SearchTelemetryService,
    private readonly breaker: CircuitBreakerService,
    private readonly cache: MemoryCacheAdapter,
  ) {}

  /**
   * Búsqueda de vuelos con fan-out por proveedor.
   *
   * Ningún proveedor puede fabricar ofertas: sin credenciales usables no se construye su adapter
   * y queda AUSENTE. Lo que antes se avisaba con `simulated` ahora se dice de la única forma
   * accionable: el proveedor aparece en `providers[]` con `status: 'unavailable'` y el motivo,
   * para que la pantalla explique por qué la lista es más corta en vez de dejar al vendedor
   * leyéndola como "no hay vuelos".
   */
  async searchFlights(
    criteria: FlightSearchCriteria,
    tenantId: string,
  ): Promise<FlightSearchResponse> {
    // La cuota se comprueba ANTES de salir al proveedor: los proveedores cobran por
    // consulta, así que no tiene sentido gastar la llamada para después rechazarla.
    await this.telemetry.assertWithinQuota(tenantId);

    const { active, skipped, unavailable } = await this.registry.forTenant(tenantId);

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
      () => this.runFanOut(criteria, tenantId, active, skipped, unavailable, durations),
      (r) => r.offers.length,
      // Sin `simulatedOf`: ninguna búsqueda puede ser simulada, así que no hay nada que
      // decirle a la telemetría. Pasar `() => false` sería escribir la misma nada dos veces.
      undefined,
      (r) => telemetrySlices(r.providers, durations),
    );

    // Un resultado DEGRADADO no se cachea: congelaría 90 s la ausencia de un proveedor que
    // quizá ya volvió. Y un proveedor AUSENTE cuenta como degradación aunque no haya fallado
    // ninguna llamada: el tenant puede estar cargando sus credenciales en este mismo momento, y
    // cachear la ausencia le dejaría la pantalla sin ese proveedor minuto y medio después de
    // haberlas guardado.
    const degradado = result.providers.some(
      (p) => p.status === 'error' || p.status === 'unavailable',
    );
    if (!degradado) {
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
    unavailable: UnavailableProvider[],
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

    // Puerta de moneda. Va ANTES del corte de "todos fallaron" para que ese corte cuente los
    // descartes: si lo único que volvió está en una moneda que la agencia no vende, lo que sale
    // es el 502 con el motivo y no una lista vacía, que el vendedor leería como "no hay vuelos".
    // Ver {@link splitByCurrency}.
    const { kept, rejected } = splitByCurrency(items, criteria.currency);
    if (rejected.length > 0) {
      this.aplicarDescartesDeMoneda(active, kept, rejected, criteria.currency, counts, failures);
    }

    // Con TODOS los proveedores llamados caídos no hay degradación posible: se propaga el
    // error en vez de devolver una lista vacía, que el vendedor leería como "no hay vuelos"
    // y le diría eso a su cliente. Es 502 porque el fallo es del sistema de al lado.
    if (kept.length === 0 && failures.size > 0) {
      throw new AllFlightProvidersFailedError(
        [...failures].map(([code, reason]) => ({ code, reason })),
      );
    }

    return {
      // El dedupe va ANTES de `withPricing` (RF-06 CA-4): la cascada de markup se calcula sobre
      // las ofertas que sobreviven, no sobre las que se van a tirar. `dedupeFlightOffers` lo
      // exige de forma explícita y falla si se invierte el orden.
      //
      // Y va DESPUÉS de la puerta de moneda, que es lo que lo hace servir para algo:
      // `dedupeFlightOffers` no deduplica nada mientras haya más de una moneda en el conjunto.
      offers: await this.withPricing(dedupeFlightOffers(kept), tenantId, 'flights'),
      // Residuo: ninguna oferta de esta lista puede ser inventada, así que no hay nada que
      // señalar. Ver `FlightSearchResponse.simulated` para el plazo de retirada.
      simulated: SIMULATED_RESIDUE,
      providers: this.outcomes(active, counts, failures, noLlamados, unavailable),
    };
  }

  /**
   * Anota, proveedor por proveedor, qué se descartó por moneda.
   *
   * Un descarte silencioso sería el mismo fallo que la mezcla, sólo que más difícil de ver: el
   * vendedor no puede distinguir "este proveedor no tiene vuelos" de "este proveedor los tiene y
   * te los estamos escondiendo". Por eso:
   *
   * - `counts` pasa a contar lo COTIZABLE, no lo que llegó del cable: es lo que se muestra y lo
   *   que se mide en telemetría.
   * - Si al proveedor no le queda NADA, entra en `failures`. No es `empty` —`empty` afirma que no
   *   había vuelos, y sí los había— y no es un estado nuevo porque `ProviderOutcome.status` es un
   *   contrato que la pantalla ya lee. El motivo dice qué moneda mandó y dónde se arregla.
   * - Si le queda algo, el proveedor sigue sirviendo y el descarte va al log: no se puede tumbar
   *   producto vendible por culpa de una tarifa hermana descuadrada.
   */
  private aplicarDescartesDeMoneda(
    active: readonly ResolvedProvider<FlightProviderAdapter>[],
    kept: readonly Offer[],
    rejected: readonly Offer[],
    expected: string,
    counts: Map<string, number>,
    failures: Map<string, string>,
  ): void {
    for (const provider of active) {
      const descartadas = rejected.filter((o) => o.provider.name === provider.code);
      if (descartadas.length === 0) continue;

      const cotizables = kept.filter((o) => o.provider.name === provider.code).length;
      counts.set(provider.code, cotizables);

      if (cotizables === 0) {
        failures.set(provider.code, currencyMismatchReason(descartadas, expected));
        continue;
      }

      // Sólo códigos y conteos: ni payload del proveedor ni datos del pasajero (RNF-07).
      this.logger.warn(
        `search.currency_mismatch provider=${provider.code} expected=${expected} dropped=${descartadas.length} kept=${cotizables}`,
      );
    }
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

  /**
   * Parte por proveedor, en el mismo orden estable que devuelve el registry.
   *
   * Incluye a los AUSENTES. Es la mitad que faltaba: sin fila, un proveedor sin credenciales
   * desaparecía del sobre y la pantalla no tenía con qué explicar por qué había menos ofertas.
   */
  private outcomes(
    active: ResolvedProvider<FlightProviderAdapter>[],
    counts: Map<string, number>,
    failures: Map<string, string>,
    noLlamados: SkippedProvider[],
    ausentes: UnavailableProvider[],
  ): ProviderOutcome[] {
    const deActivos = active.map((p): ProviderOutcome => {
      const reason = failures.get(p.code);
      if (reason !== undefined) {
        return { code: p.code, status: 'error', count: 0, simulated: SIMULATED_RESIDUE, reason };
      }

      const salteado = noLlamados.find((s) => s.code === p.code);
      if (salteado) {
        return {
          code: p.code,
          status: 'skipped',
          count: 0,
          simulated: SIMULATED_RESIDUE,
          skipReason: salteado.reason,
        };
      }

      const count = counts.get(p.code) ?? 0;
      return {
        code: p.code,
        status: count > 0 ? 'ok' : 'empty',
        count,
        simulated: SIMULATED_RESIDUE,
      };
    });

    const soloSalteados = noLlamados
      .filter((s) => !active.some((p) => p.code === s.code))
      .map(
        (s): ProviderOutcome => ({
          code: s.code,
          status: 'skipped',
          count: 0,
          simulated: SIMULATED_RESIDUE,
          skipReason: s.reason,
        }),
      );

    const deAusentes = ausentes.map(
      (a): ProviderOutcome => ({
        code: a.code,
        status: 'unavailable',
        count: 0,
        simulated: SIMULATED_RESIDUE,
        unavailableReason: a.reason,
        ...(a.detail === undefined ? {} : { reason: a.detail }),
      }),
    );

    return [...deActivos, ...soloSalteados, ...deAusentes].sort((a, b) =>
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
