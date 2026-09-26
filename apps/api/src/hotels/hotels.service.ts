import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  HotelOffer,
  HotelRatesQuery,
  HotelRoomOccupancy,
  HotelSearchCriteria,
} from '@sales-travel/canonical';
import type {
  HotelDestinationSuggestion,
  HotelRatesDetailPort,
  HotelSuggestPort,
} from '@sales-travel/domain';
import { CurrencyCodeSchema } from '@sales-travel/validation';
import { sql, type SelectQueryBuilder } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  PricingService,
  applyCascade,
  applyProviderFloor,
  toTenantView,
  type ApplicableRule,
} from '../pricing/pricing.service.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  PLATFORM_ID_SPACE_PROVIDER,
  supportsHotelRatesContext,
  supportsHotelRatesDetail,
  supportsHotelSearchContext,
  supportsHotelSuggest,
  type HotelCatalogOrder,
  type HotelProviderAccountFingerprint,
  type HotelProviderAdapter,
  type HotelProviderRegistration,
  type HotelSearchContextData,
  type HotelSearchPackContext,
  type HotelSearchProfile,
  type ResolvedHotelProvider,
} from '../providers/hotel-provider.types.js';
import { ProviderCallError } from '../providers/provider.types.js';
import {
  CircuitBreakerService,
  type ProviderCircuitOptions,
} from '../search/circuit-breaker.service.js';
import { fanOut, type ProviderRun } from '../search/provider-fanout.js';
import { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  AllHotelProvidersFailedError,
  HotelOperationUnavailableError,
  HotelProviderCapabilityError,
} from './hotel-provider-errors.js';
import {
  SKIP_REASON_TEXT,
  catalogFactsOf,
  errorOutcome,
  gateByCurrency,
  mergeProviderOffers,
  partialOutcome,
  respondedOutcome,
  searchEligibilitySkip,
  skippedOutcome,
  sortOutcomes,
  telemetrySlices,
  unavailableOutcome,
  withCatalogFacts,
  type CanonicalHotelKeyOf,
  type HotelCatalogFacts,
  type HotelProviderOutcome,
  type HotelSearchResponse,
  type ProviderOffers,
} from './hotel-search.aggregate.js';
import { HotelSearchContextStore, isStorablePackContext } from './hotel-search-context.store.js';
import type { HotelAvailabilityInput, HotelDetailInput } from './hotels.schemas.js';

/** Idioma del borde HTTP (el de Despegar, en mayúsculas) → idioma del contrato neutral. */
const NEUTRAL_LANGUAGE = { EN: 'en', ES: 'es', PT: 'pt' } as const;

/** Moneda a la que cae una búsqueda de un tenant sin fila, como antes de este cambio. */
const FALLBACK_CURRENCY = 'USD';

/**
 * Por debajo de esta cantidad de hoteles cotizables, la primera ola se considera insuficiente y
 * se llama a los proveedores de respaldo (`callPolicy: 'fallback'`). Es el mismo pomo que vuelos:
 * gobierna el costo de un proveedor que cobra por consulta sin reescribir el fan-out.
 */
const FALLBACK_MIN_HOTELS = 5;

const CATALOG_EMPTY_MESSAGE =
  'El catálogo de hoteles de ese destino todavía no está sincronizado. Probá con otra ciudad o avisá al administrador.';

/** Qué hoteles se le piden a cada proveedor, o por qué no se le pregunta. */
type CatalogPlan =
  | { readonly hotelIds: readonly string[] }
  | {
      readonly skip: 'catalog-empty' | 'no-destination-map' | 'foreign-hotel-ids';
    };

/** Un proveedor que sabe hacer una operación, con lo que su llamada necesita del breaker. */
interface CapableProvider<TPort> {
  readonly code: string;
  readonly adapter: HotelProviderAdapter & TPort;
  readonly circuit: ProviderCircuitOptions | undefined;
  readonly searchProfile: HotelSearchProfile;
}

interface CallablePlan {
  readonly provider: ResolvedHotelProvider;
  readonly criteria: HotelSearchCriteria;
}

/** Lo que respondió UN proveedor a una búsqueda, ya con su contexto guardado. */
interface ProviderSearchResult {
  readonly offers: HotelOffer[];
  /** Presente si respondió sólo en parte, con el error de lo que faltó (RF-14 CA-3). */
  readonly partial?: { readonly cause: unknown };
}

/** Lo de la estadía que guarda el contexto: lo que el SERVIDOR le mandó al proveedor. */
type SearchedStay = Pick<
  HotelSearchCriteria,
  'checkinDate' | 'checkoutDate' | 'rooms' | 'guestNationality'
>;

/**
 * Lo que va dejando una búsqueda mientras consulta. Vive en el ámbito de la búsqueda y no en el
 * servicio: dos búsquedas concurrentes del mismo tenant se pisarían las medidas.
 */
interface FanOutState {
  readonly outcomes: HotelProviderOutcome[];
  readonly contributed: ProviderOffers[];
  readonly failed: { code: string; reason: string }[];
  /** Proveedores a los que efectivamente se les preguntó. */
  readonly called: Set<string>;
  readonly durations: Map<string, number>;
}

/**
 * Orden `relevance` del catálogo (docs/tbo/02 §4.3): más estrellas primero, sin estrellas al final
 * —`DESC` a secas los pondría PRIMERO, porque Postgres ordena los NULL como el valor más alto— y el
 * id como desempate, para que dos búsquedas iguales pidan los mismos hoteles.
 */
function byRelevance<O>(
  query: SelectQueryBuilder<DB, 'hotel_inventory', O>,
): SelectQueryBuilder<DB, 'hotel_inventory', O> {
  return query.orderBy('stars', sql`desc nulls last`).orderBy('hotel_id');
}

/** El proveedor resuelto, con su adapter ya estrechado al puerto de la operación. */
function capable<TPort>(
  p: ResolvedHotelProvider,
  adapter: HotelProviderAdapter & TPort,
): CapableProvider<TPort> {
  return { code: p.code, adapter, circuit: p.circuit, searchProfile: p.searchProfile };
}

/** Clave de un hotel de un proveedor. El separador no puede aparecer en un código de proveedor. */
function hotelKey(providerCode: string, hotelId: string): string {
  return `${providerCode} ${hotelId}`;
}

/**
 * `tenants.default_currency` → moneda de venta, o `undefined` si no sirve.
 *
 * La columna es `CHAR(3)` y Postgres la devuelve rellena con espacios, sin nada que obligue a
 * mayúsculas. Sin normalizar, un `'cop '` hacía que la puerta de moneda descartara TODAS las
 * tarifas, que sí llegan en mayúsculas. Mismo criterio que `search.controller.ts`.
 */
function tenantCurrency(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = CurrencyCodeSchema.safeParse(raw.trim().toUpperCase());
  return parsed.success ? parsed.data : undefined;
}

/**
 * Precio de venta de cada tarifa: el waterfall de la red y, encima, el piso del proveedor (RF-12).
 * `price.total` (el neto) NO se muta.
 *
 * El piso se aplica aunque el tenant no tenga reglas: sin él, el precio de venta sería el neto y
 * quedaría por debajo del mínimo que el proveedor permite. Una tarifa sin reglas NI piso —todas
 * las de Despegar en un tenant sin markup— sale como la mapeó el ACL, sin `pricing`.
 *
 * El piso llega en la moneda de `price.total`: lo exige el esquema neutral, que valida el ACL.
 */
function withPricing(
  offer: HotelOffer,
  rules: ApplicableRule[],
  sellerTenantId: string,
): HotelOffer {
  return {
    ...offer,
    roompacks: offer.roompacks.map((pack) => {
      const floor = pack.price.minimumSellingPrice;
      if (rules.length === 0 && floor === undefined) return pack;
      const waterfall = applyProviderFloor(
        applyCascade(pack.price.total.amountMinor, rules),
        floor?.amountMinor,
        sellerTenantId,
      );
      return {
        ...pack,
        pricing: toTenantView(waterfall, sellerTenantId, pack.price.total.currency),
      };
    }),
  };
}

/**
 * Búsqueda, sugerencias y detalle de hoteles sobre TODOS los proveedores habilitados para el
 * tenant, por el registry.
 *
 * Hasta este cambio el servicio inyectaba el factory de Despegar y fijaba su código: un segundo
 * proveedor no tenía por dónde entrar. Ahora cada proveedor declara su catálogo, sus topes y su
 * espacio de ids (`searchProfile`), se le llama en paralelo a través de su circuito, y lo que no
 * aporta —porque falló, no se le llamó o cotizó en otra moneda— sale en `providers[]` con el
 * motivo, en vez de desaparecer.
 *
 * Un proveedor cuya reserva depende de lo que dejó su búsqueda (TBO) guarda ese contexto en el
 * servidor antes de que sus tarifas salgan (RF-08): ocupación, nacionalidad, importe y referencia
 * se leen de ahí al reservar, nunca del navegador.
 *
 * Un proveedor con ids propios (TBO) recibe el destino traducido a SUS ciudades por el mapa de
 * destinos (RF-33), y lo que su disponibilidad no trae —nombre, estrellas, dirección, ubicación—
 * sale de su catálogo. El mismo hotel en dos proveedores es una sola tarjeta con las tarifas de
 * ambos, cada una con su proveedor (RF-34, RF-40).
 *
 * Las rutas de reserva que todavía hablan los DTOs de Despegar viven en
 * `DespegarHotelReservationsService`: son el flujo actual de Despegar hasta que la reserva pase a
 * órdenes (PR-4.x).
 */
@Injectable()
export class HotelsService {
  private readonly logger = new Logger(HotelsService.name);

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly db: DatabaseService,
    private readonly pricing: PricingService,
    private readonly telemetry: SearchTelemetryService,
    private readonly breaker: CircuitBreakerService,
    private readonly searchContexts: HotelSearchContextStore,
  ) {}

  // ───────────────────────── Búsqueda ─────────────────────────

  /**
   * Autocompletado de destinos. Lo sirve un proveedor del espacio de ids de la plataforma,
   * porque sus ids son los que después resuelven el catálogo de cada proveedor.
   */
  async suggest(
    tenantId: string,
    q: string,
    locale?: string,
  ): Promise<HotelDestinationSuggestion[]> {
    const { code, adapter, circuit } = await this.platformProviderWith<HotelSuggestPort>(
      tenantId,
      supportsHotelSuggest,
      'sugerencias de destino',
    );
    return this.breaker.execute(
      code,
      () => adapter.suggestDestinations(q, { tenantId }, locale),
      circuit,
    );
  }

  async searchAvailability(
    tenantId: string,
    input: HotelAvailabilityInput,
  ): Promise<HotelSearchResponse> {
    // Qué hoteles se le piden a cada proveedor. Va ANTES de la cuota y de las credenciales: si
    // ningún catálogo tiene el destino, no hay a quién preguntar y no se gasta nada.
    const plans = await this.catalogPlans(input);
    if (![...plans.values()].some((p) => 'hotelIds' in p)) {
      // Lista vacía = el catálogo no está sincronizado, NO que no haya hoteles. Devolver [] en
      // silencio hacía que el vendedor concluyera lo segundo.
      throw new ServiceUnavailableException(CATALOG_EMPTY_MESSAGE);
    }

    // La cuota se comprueba antes de salir a los proveedores, que cobran por consulta. Una
    // búsqueda cuenta UNA vez aunque consulte a varios: todas sus filas comparten grupo.
    await this.telemetry.assertWithinQuota(tenantId);

    const { active, skipped, unavailable } = await this.registry.forTenant(tenantId);
    const defaults = await this.tenantDefaults(tenantId);
    const currency = input.currency ?? defaults.currency;

    const state: FanOutState = {
      outcomes: [
        ...skipped.map((s) => skippedOutcome(s.code, s.reason, SKIP_REASON_TEXT[s.reason])),
        ...unavailable.map(unavailableOutcome),
      ],
      contributed: [],
      failed: [],
      called: new Set(),
      durations: new Map(),
    };
    const { outcomes } = state;
    const callable: CallablePlan[] = [];
    for (const provider of active) {
      // Todo activo está registrado: las dos listas salen del mismo arreglo de factories.
      const plan = plans.get(provider.code) as CatalogPlan;
      if ('skip' in plan) {
        outcomes.push(skippedOutcome(provider.code, plan.skip, SKIP_REASON_TEXT[plan.skip]));
        continue;
      }
      const ineligible = searchEligibilitySkip(provider.code, input, provider.searchProfile);
      if (ineligible !== undefined) {
        outcomes.push(ineligible);
        continue;
      }
      callable.push({
        provider,
        criteria: this.criteriaFor(input, plan.hotelIds, currency, defaults.countryCode),
      });
    }

    const result = await this.telemetry.instrument(
      {
        tenantId,
        vertical: 'hotels',
        providerCodes: callable.map((c) => c.provider.code),
        // Criterio REDUCIDO: nunca ocupación, edades ni nacionalidad del huésped.
        criteria: {
          checkinDate: input.checkinDate,
          checkoutDate: input.checkoutDate,
          destinationId: input.destinationId,
          hotelCount: callable.reduce((n, c) => n + c.criteria.hotelIds.length, 0),
        },
      },
      () => this.runFanOut(tenantId, callable, currency, state),
      (r) => r.hotels.length,
      undefined,
      (r) => telemetrySlices(r.providers, state.called, state.durations),
    );

    const rules = await this.pricing.getApplicableRules(tenantId, 'hotels');
    return { ...result, hotels: result.hotels.map((o) => withPricing(o, rules, tenantId)) };
  }

  /**
   * IDs de hotel del catálogo de UN proveedor para un destino, sólo activos, con el orden y el
   * límite que declara el proveedor.
   *
   * El orden tiene que ser determinista: sin `orderBy`, Postgres puede devolver las filas en
   * cualquier orden entre llamadas y dos búsquedas idénticas consultaban subconjuntos distintos
   * —el vendedor veía "desaparecer" hoteles al repetir la búsqueda—.
   */
  async resolveCityHotelIds(
    providerCode: string,
    cityId: number,
    limit: number,
    order: HotelCatalogOrder = 'hotel_id',
  ): Promise<string[]> {
    const query = this.db.db
      .selectFrom('hotel_inventory')
      .select('hotel_id')
      .where('provider_code', '=', providerCode)
      .where('city_id', '=', cityId)
      .where('active', '=', true);
    const rows = await (order === 'relevance' ? byRelevance(query) : query.orderBy('hotel_id'))
      .limit(limit)
      .execute();
    return rows.map((r) => r.hotel_id);
  }

  /**
   * Ciudades de un proveedor con ids propios para el destino de la plataforma: sólo las filas
   * `accepted` del mapa de destinos (RF-33). Una `ambiguous` espera revisión y no se usa: mezclar
   * ciudades vecinas es peor que no mostrar los hoteles de ese proveedor.
   */
  async resolveDestinationCityCodes(
    providerCode: string,
    destinationId: number,
  ): Promise<string[]> {
    const rows = await this.db.db
      .selectFrom('hotel_destination_map')
      .select('target_city_code')
      .where('source_provider_code', '=', PLATFORM_ID_SPACE_PROVIDER)
      .where('source_city_id', '=', String(destinationId))
      .where('target_provider_code', '=', providerCode)
      .where('status', '=', 'accepted')
      .orderBy('target_city_code')
      .execute();
    return rows.map((r) => r.target_city_code);
  }

  /**
   * Como {@link resolveCityHotelIds}, en las ciudades PROPIAS del proveedor
   * (`provider_city_code`). Un destino puede mapear a más de una ciudad del proveedor (una zona
   * hotelera con código propio): el límite y el orden valen para el conjunto.
   */
  async resolveProviderCityHotelIds(
    providerCode: string,
    cityCodes: readonly string[],
    limit: number,
    order: HotelCatalogOrder = 'hotel_id',
  ): Promise<string[]> {
    const query = this.db.db
      .selectFrom('hotel_inventory')
      .select('hotel_id')
      .where('provider_code', '=', providerCode)
      .where('provider_city_code', 'in', [...cityCodes])
      .where('active', '=', true);
    const rows = await (order === 'relevance' ? byRelevance(query) : query.orderBy('hotel_id'))
      .limit(limit)
      .execute();
    return rows.map((r) => r.hotel_id);
  }

  /**
   * Tarifas de un hotel. Sin `provider`, las da el proveedor del espacio de ids de la plataforma,
   * que es donde viven los ids del listado de hoy.
   */
  async getHotelDetail(tenantId: string, input: HotelDetailInput): Promise<HotelOffer> {
    const operation = 'el detalle de tarifas de un hotel';
    const provider =
      input.provider === undefined
        ? await this.platformProviderWith<HotelRatesDetailPort>(
            tenantId,
            supportsHotelRatesDetail,
            operation,
          )
        : await this.providerWith<HotelRatesDetailPort>(
            tenantId,
            input.provider,
            supportsHotelRatesDetail,
            operation,
          );
    const defaults = await this.tenantDefaults(tenantId);
    const query: HotelRatesQuery = {
      hotelId: input.hotelId,
      roompackId: input.roompackId,
      ...this.stayOf(input, input.currency ?? defaults.currency, defaults.countryCode),
    };

    const rates = await this.ratesFrom(tenantId, provider, query);
    // Nombre, dirección y ubicación del proveedor que VENDE estas tarifas, no del hotel de otro
    // proveedor con el que se lo agrupó en el listado (RF-34).
    const offer = provider.searchProfile.contentFromCatalog
      ? withCatalogFacts(
          rates,
          (await this.catalogFacts(provider.code, [rates.hotelId])).get(rates.hotelId),
        )
      : rates;
    // El detalle es la pantalla desde la que se reserva: sin el waterfall mostraría el neto.
    const rules = await this.pricing.getApplicableRules(tenantId, 'hotels');
    return withPricing(offer, rules, tenantId);
  }

  // ───────────────────────── Fan-out ─────────────────────────

  /**
   * Consulta en dos olas, como vuelos: primero los de `callPolicy` `always` (y los `opt-in` que
   * el tenant activó), en PARALELO; los `fallback` sólo si la primera ola trajo poco.
   */
  private async runFanOut(
    tenantId: string,
    callable: readonly CallablePlan[],
    currency: string,
    state: FanOutState,
  ): Promise<HotelSearchResponse> {
    const fallbacks = callable.filter((c) => c.provider.callPolicy === 'fallback');
    await this.callWave(
      tenantId,
      callable.filter((c) => c.provider.callPolicy !== 'fallback'),
      currency,
      state,
    );

    if (fallbacks.length > 0) {
      // Cuenta lo COTIZABLE, después de la puerta de moneda: una primera ola que sólo trajo
      // tarifas en otra moneda no le ahorra nada al vendedor.
      const cotizables = state.contributed.reduce((n, b) => n + b.offers.length, 0);
      if (cotizables < FALLBACK_MIN_HOTELS) {
        await this.callWave(tenantId, fallbacks, currency, state);
      } else {
        for (const { provider } of fallbacks) {
          state.outcomes.push(
            skippedOutcome(
              provider.code,
              'fallback-not-needed',
              SKIP_REASON_TEXT['fallback-not-needed'],
            ),
          );
        }
      }
    }

    // Con TODOS los proveedores llamados caídos no hay degradación posible: una lista vacía se
    // leería como "no hay hoteles". Es 502 porque el fallo es del sistema de al lado.
    if (state.called.size > 0 && state.failed.length === state.called.size) {
      throw new AllHotelProvidersFailedError(state.failed);
    }

    const profiles = new Map(callable.map((c) => [c.provider.code, c.provider.searchProfile]));
    const contributed = await Promise.all(
      state.contributed.map(async (batch): Promise<ProviderOffers> => {
        if (profiles.get(batch.code)?.contentFromCatalog !== true) return batch;
        return { ...batch, offers: await this.withCatalogContent(batch.code, batch.offers) };
      }),
    );

    return {
      hotels: mergeProviderOffers(contributed, await this.canonicalKeys(contributed)),
      providers: sortOutcomes(state.outcomes),
    };
  }

  private async callWave(
    tenantId: string,
    wave: readonly CallablePlan[],
    currency: string,
    state: FanOutState,
  ): Promise<void> {
    for (const c of wave) state.called.add(c.provider.code);
    const settled = await fanOut(wave.map((c) => this.toRun(tenantId, c, state.durations)));

    // `settled.items` llega en el orden de la ola, que es el estable del registry.
    for (const batch of settled.items) {
      const { outcome, offers } = respondedOutcome(
        batch.code,
        gateByCurrency(batch.offers, currency),
        currency,
      );
      state.outcomes.push(
        batch.partialReason === undefined ? outcome : partialOutcome(outcome, batch.partialReason),
      );
      state.contributed.push({ code: batch.code, offers });
      if (outcome.droppedForCurrency !== undefined) {
        // Sólo códigos y conteos: ni payload del proveedor ni datos del huésped (RNF-07).
        this.logger.warn(
          `hotels.currency_mismatch provider=${batch.code} expected=${currency} dropped=${outcome.droppedForCurrency}`,
        );
      }
    }
    for (const f of settled.failed) {
      state.failed.push(f);
      state.outcomes.push(errorOutcome(f.code, f.reason));
    }
  }

  private toRun(
    tenantId: string,
    { provider, criteria }: CallablePlan,
    durations: Map<string, number>,
  ): ProviderRun<ProviderOffers> {
    // Se humaniza en la rama del proveedor: el agregador no conoce los errores de nadie. El origen
    // de la credencial decide a quién se le pide que la revise.
    const humanize = (err: unknown): string =>
      this.registry.humanizeError(provider.code, err, {
        credentialSource: provider.credentialSource,
      });
    return {
      code: provider.code,
      run: async () => {
        const startedAt = Date.now();
        try {
          const { offers, partial } = await this.searchFrom(tenantId, provider, criteria);
          if (partial === undefined) return [{ code: provider.code, offers }];
          const partialReason = `Parte de sus hoteles no se pudo consultar: ${humanize(partial.cause)}`;
          return [{ code: provider.code, offers, partialReason }];
        } catch (err) {
          throw new ProviderCallError(provider.code, humanize(err), err);
        } finally {
          durations.set(provider.code, Date.now() - startedAt);
        }
      },
    };
  }

  // ───────────────────────── Contenido y equivalencias ─────────────────────────

  /**
   * Completa las ofertas de UN proveedor con su fila de `hotel_inventory`, sólo donde él no
   * informó el dato. Un hotel que el catálogo no tiene sale como llegó.
   */
  private async withCatalogContent(
    providerCode: string,
    offers: readonly HotelOffer[],
  ): Promise<HotelOffer[]> {
    if (offers.length === 0) return [];
    const facts = await this.catalogFacts(
      providerCode,
      offers.map((o) => o.hotelId),
    );
    const filled = offers.map((o) => withCatalogFacts(o, facts.get(o.hotelId)));

    const unnamed = filled.filter((o) => o.name === undefined).length;
    if (unnamed > 0) {
      // Sólo código y conteo: el sync de contenido todavía no cubrió esos hoteles.
      this.logger.warn(
        `hotels.catalog_content.sin_nombre provider=${providerCode} count=${unnamed}`,
      );
    }
    return filled;
  }

  /** Lo que la fila de `hotel_inventory` de cada hotel aporta a su oferta, por `hotel_id`. */
  private async catalogFacts(
    providerCode: string,
    hotelIds: readonly string[],
  ): Promise<Map<string, HotelCatalogFacts>> {
    const rows = await this.db.db
      .selectFrom('hotel_inventory')
      .select(['hotel_id', 'name', 'stars', 'address', 'latitude', 'longitude'])
      .where('provider_code', '=', providerCode)
      .where('hotel_id', 'in', [...hotelIds])
      .execute();
    return new Map(rows.map((r) => [r.hotel_id, catalogFactsOf(r)]));
  }

  /**
   * Equivalencias ACEPTADAS entre los hoteles de esta respuesta (RF-34). Sólo hacen falta si hay
   * hoteles de más de un proveedor: con uno solo no hay nada que agrupar y no se consulta nada.
   *
   * Si la consulta falla, la búsqueda sigue sin agrupar: un hotel repetido en dos tarjetas es ruido
   * visual, y perder las tarifas de todos por eso sería peor (docs/tbo/05 §9.3).
   */
  private async canonicalKeys(
    batches: readonly ProviderOffers[],
  ): Promise<CanonicalHotelKeyOf | undefined> {
    const withHotels = batches.filter((b) => b.offers.length > 0);
    if (withHotels.length < 2) return undefined;
    try {
      const rows = await this.db.db
        .selectFrom('hotel_match')
        .select(['provider_code', 'hotel_id', 'canonical_hotel_id'])
        .where('status', '=', 'accepted')
        .where((eb) =>
          eb.or(
            withHotels.map((b) =>
              eb.and([
                eb('provider_code', '=', b.code),
                eb(
                  'hotel_id',
                  'in',
                  b.offers.map((o) => o.hotelId),
                ),
              ]),
            ),
          ),
        )
        .execute();
      const canonical = new Map(
        rows.map((r) => [hotelKey(r.provider_code, r.hotel_id), r.canonical_hotel_id]),
      );
      return (providerCode, hotelId) => canonical.get(hotelKey(providerCode, hotelId));
    } catch {
      // Sin el error: el mensaje de un driver puede citar los parámetros de la consulta.
      this.logger.warn('hotels.hotel_match.no_disponible: se responde sin agrupar');
      return undefined;
    }
  }

  // ───────────────────────── Contexto de búsqueda (RF-08) ─────────────────────────

  /**
   * La búsqueda a UN proveedor. A través del circuito: un proveedor caído falla al instante en vez
   * de hacer esperar su timeout a cada búsqueda, y el kill-switch (`PROVIDERS_DISABLED`) también
   * pasa por acá. Guardar el contexto va FUERA del circuito: que falle no dice nada del proveedor.
   */
  private async searchFrom(
    tenantId: string,
    { code, adapter, circuit }: ResolvedHotelProvider,
    criteria: HotelSearchCriteria,
  ): Promise<ProviderSearchResult> {
    if (!supportsHotelSearchContext(adapter)) {
      const offers = await this.breaker.execute(
        code,
        () => adapter.searchAvailability(criteria, { tenantId }),
        circuit,
      );
      return { offers };
    }
    // La cuenta se lee ANTES de salir: es la que va a buscar, y la que el Book tiene que repetir.
    const account = adapter.searchAccount;
    const found = await this.breaker.execute(
      code,
      () => adapter.searchAvailabilityWithContext(criteria, { tenantId }),
      circuit,
    );
    const offers = await this.keepSearchContext(
      tenantId,
      code,
      account,
      criteria,
      found,
      found.offers,
    );
    return found.partial === undefined ? { offers } : { offers, partial: found.partial };
  }

  /** El detalle de un hotel. Si es otra búsqueda del proveedor, sus tarifas nuevas dejan contexto. */
  private async ratesFrom(
    tenantId: string,
    { code, adapter, circuit }: CapableProvider<HotelRatesDetailPort>,
    query: HotelRatesQuery,
  ): Promise<HotelOffer> {
    if (!supportsHotelRatesContext(adapter)) {
      return this.breaker.execute(code, () => adapter.getHotelRates(query, { tenantId }), circuit);
    }
    const account = adapter.searchAccount;
    const found = await this.breaker.execute(
      code,
      () => adapter.getHotelRatesWithContext(query, { tenantId }),
      circuit,
    );
    const [offer] = await this.keepSearchContext(tenantId, code, account, query, found, [
      found.offer,
    ]);
    return offer ?? { ...found.offer, roompacks: [] };
  }

  /**
   * Guarda el contexto de la búsqueda y devuelve sólo las tarifas que se pueden reservar.
   *
   * - Cada tarifa sale con `provider.raw = { searchId }` y nada más, lo haya puesto el ACL o no:
   *   `raw` viaja al navegador y no puede llevar PII (RF-08 CA-5).
   * - Una tarifa sin contexto utilizable —el ACL no la informó, la informó en otro hotel, repite
   *   una referencia ya vista o su contexto no cabe en el registro— no se muestra: su PreBook no
   *   tendría qué reenviar. Se cuenta, nunca se descarta callada, y no arrastra a las demás.
   * - La estadía del contexto es la del criterio que armó el servidor, no la que el proveedor
   *   repita: es lo que se le pidió y lo que el Book tiene que sostener.
   * - Si el contexto no se puede guardar, la búsqueda de ESE proveedor falla con motivo.
   */
  private async keepSearchContext(
    tenantId: string,
    providerCode: string,
    account: HotelProviderAccountFingerprint,
    stay: SearchedStay,
    found: HotelSearchContextData,
    offers: readonly HotelOffer[],
  ): Promise<HotelOffer[]> {
    const byRef = new Map(found.packs.map((p) => [p.offerRef, p]));
    const kept = new Map<string, HotelSearchPackContext>();
    let orphans = 0;

    const bookable: HotelOffer[] = [];
    for (const offer of offers) {
      const roompacks = offer.roompacks.flatMap((pack) => {
        const context = byRef.get(pack.provider.offerRef);
        if (
          context === undefined ||
          context.hotelId !== offer.hotelId ||
          kept.has(context.offerRef) ||
          !isStorablePackContext(context)
        ) {
          orphans += 1;
          return [];
        }
        kept.set(context.offerRef, context);
        return [{ ...pack, provider: { ...pack.provider, raw: { searchId: found.searchId } } }];
      });
      // Un hotel que se quedó sin tarifas por esto no se lista; uno que llegó sin ninguna, sí.
      if (roompacks.length > 0 || offer.roompacks.length === 0) {
        bookable.push({ ...offer, roompacks });
      }
    }

    if (orphans > 0) {
      // Sólo código y conteo: ni referencias ni datos del huésped.
      this.logger.warn(
        `hotels.search_context.packs_sin_contexto provider=${providerCode} dropped=${orphans}`,
      );
    }
    if (kept.size > 0) {
      await this.searchContexts.save({
        tenantId,
        providerCode,
        searchId: found.searchId,
        checkinDate: stay.checkinDate,
        checkoutDate: stay.checkoutDate,
        rooms: stay.rooms.map((r) => ({ adults: r.adults, childrenAges: [...r.childrenAges] })),
        guestNationality: stay.guestNationality,
        searchSentAt: found.searchSentAt,
        expiresAt: found.expiresAt,
        account: { accountId: account.accountId, updatedAt: account.updatedAt },
        packs: [...kept.values()],
      });
    }
    return bookable;
  }

  // ───────────────────────── Catálogo ─────────────────────────

  /**
   * Plan de catálogo de CADA proveedor registrado, sin credenciales ni flags.
   *
   * - IDs escritos por el vendedor: son del espacio de la plataforma. Van tal cual a los
   *   proveedores de ese espacio, sin pasar por el catálogo (el catálogo de ese destino puede no
   *   estar sincronizado), y a ningún otro: el mismo número puede ser otro hotel.
   * - Destino: cada proveedor de la plataforma resuelve SU catálogo por `city_id`; uno con
   *   ciudades propias, por las ciudades que el mapa de destinos acepta para ese destino (RF-33).
   *   Sin mapeo aceptado no se le pregunta y queda `skipped` con motivo: no es un fallo suyo, así
   *   que no pasa por el breaker ni cuenta en su tasa de error (docs/tbo/05 §8.4).
   */
  private async catalogPlans(input: HotelAvailabilityInput): Promise<Map<string, CatalogPlan>> {
    const explicit = input.hotelIds ?? [];
    const registered = this.registry.registered();
    const plans = await Promise.all(
      registered.map(
        async (p): Promise<[string, CatalogPlan]> => [
          p.code,
          await this.catalogPlanOf(p, explicit, input.destinationId),
        ],
      ),
    );
    return new Map(plans);
  }

  private async catalogPlanOf(
    { code, searchProfile }: HotelProviderRegistration,
    explicit: readonly string[],
    destinationId: number | undefined,
  ): Promise<CatalogPlan> {
    if (explicit.length > 0) {
      return searchProfile.idSpace === 'platform'
        ? { hotelIds: explicit }
        : { skip: 'foreign-hotel-ids' };
    }
    if (destinationId === undefined) return { skip: 'catalog-empty' };

    let hotelIds: string[];
    if (searchProfile.idSpace === 'provider') {
      const cityCodes = await this.resolveDestinationCityCodes(code, destinationId);
      if (cityCodes.length === 0) return { skip: 'no-destination-map' };
      hotelIds = await this.resolveProviderCityHotelIds(
        code,
        cityCodes,
        searchProfile.maxHotelsPerSearch,
        searchProfile.catalogOrder,
      );
    } else {
      hotelIds = await this.resolveCityHotelIds(
        code,
        destinationId,
        searchProfile.maxHotelsPerSearch,
        searchProfile.catalogOrder,
      );
    }
    return hotelIds.length > 0 ? { hotelIds } : { skip: 'catalog-empty' };
  }

  // ───────────────────────── Criterio ─────────────────────────

  private criteriaFor(
    input: HotelAvailabilityInput,
    hotelIds: readonly string[],
    currency: string,
    tenantCountry: string | undefined,
  ): HotelSearchCriteria {
    return { hotelIds: [...hotelIds], ...this.stayOf(input, currency, tenantCountry) };
  }

  /**
   * Lo común a la búsqueda y al detalle. La moneda es la de VENTA de la búsqueda; el país es el
   * del punto de venta, que no es la nacionalidad del huésped.
   */
  private stayOf(
    input: HotelAvailabilityInput | HotelDetailInput,
    currency: string,
    tenantCountry: string | undefined,
  ): Omit<HotelSearchCriteria, 'hotelIds'> {
    return {
      checkinDate: input.checkinDate,
      checkoutDate: input.checkoutDate,
      rooms: input.rooms.map(
        (r): HotelRoomOccupancy => ({ adults: r.adults, childrenAges: [...r.childrenAges] }),
      ),
      currency,
      guestNationality: input.guestNationality,
      pointOfSaleCountry: input.countryCode ?? tenantCountry,
      language: input.language === undefined ? undefined : NEUTRAL_LANGUAGE[input.language],
      refundableOnly: input.refundableOnly,
    };
  }

  // ───────────────────────── Proveedores por capacidad ─────────────────────────

  /**
   * El primer proveedor ACTIVO del espacio de ids de la plataforma que sabe hacer la operación,
   * en el orden estable del registry. Uno apagado por `opt-in` no cuenta.
   */
  private async platformProviderWith<TPort>(
    tenantId: string,
    supports: (adapter: HotelProviderAdapter) => adapter is HotelProviderAdapter & TPort,
    operation: string,
  ): Promise<CapableProvider<TPort>> {
    const { active } = await this.registry.forTenant(tenantId);
    for (const p of active) {
      if (p.searchProfile.idSpace === 'platform' && supports(p.adapter)) {
        return capable(p, p.adapter);
      }
    }
    throw new HotelOperationUnavailableError(operation);
  }

  /**
   * Un proveedor nombrado por el cliente, que tiene que estar habilitado y saber hacerlo. Es una
   * venta pedida por código y no una tarifa ya emitida: uno apagado por `opt-in` tampoco cuenta.
   */
  private async providerWith<TPort>(
    tenantId: string,
    code: string,
    supports: (adapter: HotelProviderAdapter) => adapter is HotelProviderAdapter & TPort,
    operation: string,
  ): Promise<CapableProvider<TPort>> {
    const p = await this.registry.byCodeForSale(tenantId, code);
    if (!supports(p.adapter)) throw new HotelProviderCapabilityError(code, operation);
    return capable(p, p.adapter);
  }

  // ───────────────────────── Helpers ─────────────────────────

  /** Moneda de venta y país por defecto del tenant, para no obligar a enviarlos en cada búsqueda. */
  private async tenantDefaults(
    tenantId: string,
  ): Promise<{ currency: string; countryCode?: string }> {
    const t = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    const currency = tenantCurrency(t?.default_currency);
    if (currency === undefined && t !== undefined) {
      // Sin el valor: basta con saber QUÉ tenant hay que revisar. La búsqueda sigue en la moneda
      // de siempre y la puerta de moneda explica en `providers[]` lo que no se pueda mostrar.
      this.logger.warn(`hotels.tenant_currency_invalida tenant=${tenantId}`);
    }
    const result: { currency: string; countryCode?: string } = {
      currency: currency ?? FALLBACK_CURRENCY,
    };
    if (t?.country_code) result.countryCode = t.country_code;
    return result;
  }
}
