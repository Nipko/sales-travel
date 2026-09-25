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
import { DatabaseService } from '../database/database.service.js';
import {
  PricingService,
  applyCascade,
  toTenantView,
  type ApplicableRule,
} from '../pricing/pricing.service.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  supportsHotelRatesDetail,
  supportsHotelSuggest,
  type HotelCatalogOrder,
  type HotelProviderAdapter,
  type HotelProviderRegistration,
  type ResolvedHotelProvider,
} from '../providers/hotel-provider.types.js';
import { ProviderCallError } from '../providers/provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { fanOut, type ProviderRun } from '../search/provider-fanout.js';
import { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  AllHotelProvidersFailedError,
  HotelOperationUnavailableError,
  HotelProviderCapabilityError,
} from './hotel-provider-errors.js';
import {
  SKIP_REASON_TEXT,
  errorOutcome,
  gateByCurrency,
  mergeProviderOffers,
  occupancyViolation,
  respondedOutcome,
  skippedOutcome,
  sortOutcomes,
  telemetrySlices,
  unavailableOutcome,
  type HotelProviderOutcome,
  type HotelSearchResponse,
  type ProviderOffers,
} from './hotel-search.aggregate.js';
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

interface CallablePlan {
  readonly provider: ResolvedHotelProvider;
  readonly criteria: HotelSearchCriteria;
}

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

/** Waterfall del consolidador sobre cada tarifa. `price.total` (el neto) NO se muta. */
function withRules(offer: HotelOffer, rules: ApplicableRule[], tenantId: string): HotelOffer {
  return {
    ...offer,
    roompacks: offer.roompacks.map((pack) => ({
      ...pack,
      pricing: toTenantView(
        applyCascade(pack.price.total.amountMinor, rules),
        tenantId,
        pack.price.total.currency,
      ),
    })),
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
    const { code, adapter } = await this.platformProviderWith<HotelSuggestPort>(
      tenantId,
      supportsHotelSuggest,
      'sugerencias de destino',
    );
    return this.breaker.execute(code, () => adapter.suggestDestinations(q, { tenantId }, locale));
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
      const excess = occupancyViolation(input.rooms, provider.searchProfile.occupancy);
      if (excess !== undefined) {
        outcomes.push(skippedOutcome(provider.code, 'occupancy-limits', excess));
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
    if (rules.length === 0) return result;
    return { ...result, hotels: result.hotels.map((o) => withRules(o, rules, tenantId)) };
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
    const rows = await this.db.db
      .selectFrom('hotel_inventory')
      .select('hotel_id')
      .where('provider_code', '=', providerCode)
      .where('city_id', '=', cityId)
      .where('active', '=', true)
      .orderBy(order)
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
    const { code, adapter } =
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

    const offer = await this.breaker.execute(code, () =>
      adapter.getHotelRates(query, { tenantId }),
    );
    // El detalle es la pantalla desde la que se reserva: sin el waterfall mostraría el neto.
    const rules = await this.pricing.getApplicableRules(tenantId, 'hotels');
    return rules.length === 0 ? offer : withRules(offer, rules, tenantId);
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

    return {
      // Agrupación por hotel canónico: preparada en `mergeProviderOffers` y apagada hasta que
      // existan las equivalencias entre proveedores (PR-2.6).
      hotels: mergeProviderOffers(state.contributed),
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
      state.outcomes.push(outcome);
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
    return {
      code: provider.code,
      run: async () => {
        const startedAt = Date.now();
        try {
          // A través del circuito: un proveedor caído falla al instante en vez de hacer esperar
          // su timeout a cada búsqueda. El kill-switch (`PROVIDERS_DISABLED`) también pasa por acá.
          const offers = await this.breaker.execute(provider.code, () =>
            provider.adapter.searchAvailability(criteria, { tenantId }),
          );
          return [{ code: provider.code, offers }];
        } catch (err) {
          // Se humaniza en la rama del proveedor: el agregador no conoce los errores de nadie.
          throw new ProviderCallError(
            provider.code,
            this.registry.humanizeError(provider.code, err),
            err,
          );
        } finally {
          durations.set(provider.code, Date.now() - startedAt);
        }
      },
    };
  }

  // ───────────────────────── Catálogo ─────────────────────────

  /**
   * Plan de catálogo de CADA proveedor registrado, sin credenciales ni flags.
   *
   * - IDs escritos por el vendedor: son del espacio de la plataforma. Van tal cual a los
   *   proveedores de ese espacio, sin pasar por el catálogo (el catálogo de ese destino puede no
   *   estar sincronizado), y a ningún otro: el mismo número puede ser otro hotel.
   * - Destino: cada proveedor de la plataforma resuelve SU catálogo; uno con ciudades propias
   *   necesita el mapa de destinos, que se usa desde PR-2.6.
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
    if (searchProfile.idSpace === 'provider') return { skip: 'no-destination-map' };

    const hotelIds = await this.resolveCityHotelIds(
      code,
      destinationId,
      searchProfile.maxHotelsPerSearch,
      searchProfile.catalogOrder,
    );
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
  ): Promise<{ code: string; adapter: HotelProviderAdapter & TPort }> {
    const { active } = await this.registry.forTenant(tenantId);
    for (const p of active) {
      if (p.searchProfile.idSpace === 'platform' && supports(p.adapter)) {
        return { code: p.code, adapter: p.adapter };
      }
    }
    throw new HotelOperationUnavailableError(operation);
  }

  /** Un proveedor nombrado por el cliente, que tiene que estar habilitado y saber hacerlo. */
  private async providerWith<TPort>(
    tenantId: string,
    code: string,
    supports: (adapter: HotelProviderAdapter) => adapter is HotelProviderAdapter & TPort,
    operation: string,
  ): Promise<{ code: string; adapter: HotelProviderAdapter & TPort }> {
    const p = await this.registry.byCode(tenantId, code);
    if (!supports(p.adapter)) throw new HotelProviderCapabilityError(code, operation);
    return { code: p.code, adapter: p.adapter };
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
