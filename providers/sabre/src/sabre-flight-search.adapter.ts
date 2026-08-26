import type { CachePort, LoggerPort } from '@sales-travel/core';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, FlightSearchPort, SearchContext } from '@sales-travel/domain';
import { SabreTokenService, type SabreFetch, type SabreTokenProvider } from './auth/token.service';
import {
  isMockMode,
  missingSabreCredentials,
  sabreConversationIdPrefix,
  type SabreConfig,
} from './config';
import { buildMockOffers, type SabreMockDeps } from './fixtures';
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
 * Dos modos, igual que `LatamNdcFlightSearchAdapter`:
 *
 * - **real** — `POST /v5/offers/shop` y `groupedItineraryResponse` → `Offer[]` canónico.
 * - **mock** — fixtures sintéticas de `fixtures.ts`, sin red. Es lo que permite que CI y dev
 *   corran sin credenciales de Sabre.
 *
 * Ver `docs/sabre/11-plan-implementacion.md` §6.
 */
export class SabreFlightSearchAdapter implements FlightSearchPort {
  private readonly tokens: SabreTokenProvider;
  private readonly http: SabreHttpClient;

  /**
   * El adapter está devolviendo fixtures en vez de consultar a Sabre.
   *
   * Se expone porque el fallback a mock es **silencioso por diseño** —basta con que falte `epr`,
   * `password` u `homePcc` (`isMockMode`)— y las ofertas sintéticas tienen la misma forma
   * canónica que las reales. Sin este getter, un tenant mal configurado cotiza PRECIOS
   * INVENTADOS con aspecto de reales, que un vendedor le pasa a un cliente sin enterarse. Quien
   * componga el fan-out tiene que leerlo y marcar la fuente como degradada.
   */
  get isMock(): boolean {
    return isMockMode(this.cfg);
  }

  /** Nombres —nunca valores— de las credenciales que faltan. Para el panel BYOC y los logs. */
  get missingCredentials(): readonly string[] {
    return missingSabreCredentials(this.cfg);
  }

  constructor(
    private readonly cfg: SabreConfig,
    private readonly deps: SabreFlightSearchDeps = {},
  ) {
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

    if (this.isMock) {
      // Nivel `warn` y no `info`: correr en mock sin saberlo es la avería, no una nota de arranque.
      this.log('warn', 'sabre.adapter.modo_mock', { missing: this.missingCredentials });
    }
  }

  async search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    if (this.isMock) {
      this.log('warn', 'sabre.adapter.busqueda_mock', {
        tenantId: ctx.tenantId,
        missing: this.missingCredentials,
      });
      return buildMockOffers(criteria, ctx.tenantId, this.mockDeps());
    }

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
      fetchedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
    });

    this.logMapping(mapped, result, ctx);
    return mapped.offers;
  }

  /**
   * `deps.uuid` NO se reenvía a propósito: es el generador del `Conversation-ID` del cliente HTTP
   * —un valor fijo en tests— y `Offer.id` exige un UUID distinto por oferta. Compartirlos daría
   * tres ofertas con el mismo id, o directamente un id que no pasa `OfferSchema`.
   */
  private mockDeps(): SabreMockDeps {
    return {
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
    };
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
