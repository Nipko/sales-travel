import type { CachePort, LoggerPort } from '@sales-travel/core';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, FlightSearchPort, SearchContext } from '@sales-travel/domain';
import { SabreTokenService, type SabreFetch, type SabreTokenProvider } from './auth/token.service';
import { missingSabreCredentials, sabreConversationIdPrefix, type SabreConfig } from './config';
import { SabreConfigError } from './errors';
import { SabreHttpClient, type SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';
import {
  SABRE_SHOP_PATH,
  buildSabreShopRequest,
  type SabreShopOptions,
} from './shop/request.builder';
import {
  mapSabreShopResponse,
  type SabreMapWarning,
  type SabreMapWarningCode,
  type SabreShopMapResult,
} from './shop/response.mapper';

export interface SabreFlightSearchDeps {
  fetch?: SabreFetch;
  cache?: CachePort;
  logger?: LoggerPort;
  now?: () => number;
  uuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  /** `ownerTenantId` de la `provider_account` resuelta: entra en la clave de caché del ATK. */
  cacheNamespace?: string;
  /** Opciones de BFM (tier, `MaximumNumberOfPCCs`). Se validan dentro del builder. */
  shopOptions?: SabreShopOptions;
  /** Sustituye al `SabreTokenService` por defecto. Sólo para tests. */
  tokens?: SabreTokenProvider;
}

/**
 * Anti-Corruption Layer de Sabre para búsqueda de vuelos (RF-03, RF-04).
 *
 * Un único modo: `POST /v5/offers/shop` y `groupedItineraryResponse` → `Offer[]` canónico.
 *
 * El modo mock —fixtures sintéticas con la misma forma canónica que una tarifa real— ya no
 * existe: sin `epr`, `password` u `homePcc` esta clase NO se construye, así que ninguna
 * instancia puede devolver una oferta que Sabre no haya cotizado.
 *
 * Ver `docs/sabre/11-plan-implementacion.md` §6.
 */
export class SabreFlightSearchAdapter implements FlightSearchPort {
  private readonly tokens: SabreTokenProvider;
  private readonly http: SabreHttpClient;

  /**
   * Nombres —nunca valores— de las credenciales que faltan. Para el panel BYOC y los logs.
   *
   * En una instancia viva sale siempre vacío —el constructor rechaza lo contrario—; se conserva
   * porque el factory de `apps/api` lo lee al construir para decir QUÉ falta.
   */
  get missingCredentials(): readonly string[] {
    return missingSabreCredentials(this.cfg);
  }

  constructor(
    private readonly cfg: SabreConfig,
    private readonly deps: SabreFlightSearchDeps = {},
  ) {
    // Rechaza la construcción sin credenciales usables. Está aquí —y no sólo en el factory de
    // `apps/api`— porque es la barrera que un llamador nuevo no puede saltarse por olvido:
    // mientras la comprobación viva únicamente en quien construye, cada sitio de construcción
    // nuevo la vuelve a arriesgar. El mensaje nombra los campos, nunca sus valores (RNF-07).
    const missing = missingSabreCredentials(cfg);
    if (missing.length > 0) {
      throw new SabreConfigError(
        `no se puede construir el adapter de Sabre sin credenciales usables (faltan: ${missing.join(', ')})`,
      );
    }

    this.tokens =
      deps.tokens ??
      new SabreTokenService(cfg, {
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.cache === undefined ? {} : { cache: deps.cache }),
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.jitter === undefined ? {} : { jitter: deps.jitter }),
        ...(deps.cacheNamespace === undefined ? {} : { cacheNamespace: deps.cacheNamespace }),
      });
    this.http = new SabreHttpClient(cfg, this.tokens, {
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.jitter === undefined ? {} : { jitter: deps.jitter }),
      ...(deps.uuid === undefined ? {} : { uuid: deps.uuid }),
    });
  }

  async search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    const body = buildSabreShopRequest(criteria, this.cfg, this.deps.shopOptions ?? {});

    // Una búsqueda no mueve dinero ni crea estado: es de las pocas llamadas de Sabre que SÍ se
    // puede reintentar. El cliente HTTP ignora esta marca en los paths de `SABRE_NON_IDEMPOTENT_PATHS`.
    const result: SabreResult<unknown> = await this.http.postJson<unknown>(SABRE_SHOP_PATH, body, {
      idempotent: true,
      ...(ctx.requestId === undefined
        ? {}
        : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
    });

    const mapped = mapSabreShopResponse(result.data, {
      tenantId: ctx.tenantId,
      // La MISMA moneda que se pidió en `PriceRequestInformation.CurrencyCode`. Pedirla no
      // obliga a Sabre a respetarla, así que el mapper vuelve a compararla y descarta lo que
      // no encaje: el ACL no deja salir una tarifa que la agencia no puede cotizar.
      currency: criteria.currency,
      fetchedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
    });

    this.logMapping(mapped, result, ctx);
    return mapped.offers;
  }

  /**
   * Lo que se sube a la superficie de un mapeo. Nunca el payload ni texto del proveedor: sólo
   * códigos propios y conteos (RNF-07). Un `groupedItineraryResponse` arrastra nombres de
   * pasajero en algunas variantes; loguearlo entero sería filtrar PII.
   */
  private logMapping(
    mapped: SabreShopMapResult,
    result: SabreResult<unknown>,
    ctx: SearchContext,
  ): void {
    const meta = {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      offers: mapped.offers.length,
      ...(mapped.statistics === undefined ? {} : { statistics: mapped.statistics }),
    };

    if (mapped.warnings.length > 0) {
      this.log('warn', 'sabre.shop.warnings', {
        ...meta,
        warnings: countWarningsByCode(mapped.warnings),
      });
    }

    // Degradación declarada por Sabre: la respuesta llegó, pero incompleta. Callarla convierte
    // "te devolví menos de lo que había" en "no hay vuelos" en la pantalla del vendedor (RNF-13).
    if (mapped.degraded || result.partialUnauthorized.length > 0) {
      this.log('warn', 'sabre.shop.degradado', {
        ...meta,
        partialUnauthorized: result.partialUnauthorized.length,
      });
      return;
    }

    if (mapped.warnings.length === 0) this.log('debug', 'sabre.shop.ok', meta);
  }

  /**
   * La meta de este adapter la compone el LLAMADOR, no este paquete: `ctx.tenantId` y el
   * `ctx.requestId` que acaba dentro del `conversationId` cruzan el port desde el fan-out. Son
   * datos de fuera y por eso pasan por la misma pasada que el resto (RNF-07). El reenvío no lleva
   * política: vive en `redaction.ts`.
   */
  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

/**
 * Warnings agregados por código. Se cuentan en vez de listarse porque una respuesta de BFM trae
 * cientos de itinerarios: un `leg-ref-unresolved` por cada uno llenaría el log sin decir nada más
 * que el número.
 */
export function countWarningsByCode(
  warnings: readonly SabreMapWarning[],
): Partial<Record<SabreMapWarningCode, number>> {
  const counts: Partial<Record<SabreMapWarningCode, number>> = {};
  for (const warning of warnings) {
    counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  }
  return counts;
}
