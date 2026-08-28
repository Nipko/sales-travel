import type { LoggerPort } from '@sales-travel/core';
import type { Offer } from '@sales-travel/canonical';
import type {
  FlightSearchCriteria,
  OfferPricePort,
  OfferPriceResult,
  SearchContext,
} from '@sales-travel/domain';
import { sabreConversationIdPrefix, type SabreConfig } from './config';
import type { SabreIssue } from './errors';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';
import {
  SABRE_FLIGHT_CHECK_PATH,
  SabreFlightCheckRequestError,
  buildSabreFlightCheckRequest,
} from './flight-check/request.builder';
import {
  mapSabreFlightCheckResponse,
  type SabreFlightCheckHandles,
  type SabreFlightCheckMappedOffer,
  type SabreFlightCheckPriceChange,
  type SabreFlightCheckProviderIssue,
  type SabreFlightCheckValidationResult,
  type SabreFlightCheckWarning,
} from './flight-check/response.mapper';

/**
 * Adapter payload-based de `POST /v1/offers/flightCheck` para ofertas ATPCO.
 *
 * Flight Check convierte el itinerario cacheado en una oferta reservable y entrega un `offerId`
 * con sus `offerItemIds`. El mapper los guarda bajo `bookingOfferId` / `bookingOfferItemIds`: son
 * identificadores de Booking Management, no identificadores NDC.
 *
 * Este cambio no toca `sabre-order-create.adapter.ts` por aislamiento de alcance. Para consumir la
 * cadena nueva, `productOf` debe leer primero ese par completo y emitir `flightOffer`; sólo si no
 * existe debe caer a los ids de `/offers/price` o al `flightDetails` histórico. La rama parcial
 * (sólo uno de los dos ids) tiene que seguir fallando fuerte. Hasta hacer ese cableado, el resultado
 * queda correctamente revalidado y transporta los handles, pero create seguirá reconstruyendo
 * `flightDetails` para ATPCO.
 */

export interface SabreFlightCheckDeps {
  readonly logger?: LoggerPort;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface SabreFlightCheckedQuote {
  readonly offer: Offer;
  readonly handles: SabreFlightCheckHandles;
  readonly priceChange: SabreFlightCheckPriceChange;
  readonly priceChanged: boolean;
  /** Upsells `Same cabin`; nunca sustituyen silenciosamente a `offer`. */
  readonly alternatives: readonly SabreFlightCheckMappedOffer[];
  readonly validationResults: readonly SabreFlightCheckValidationResult[];
  readonly warnings: readonly SabreFlightCheckWarning[];
  readonly providerWarnings: readonly SabreFlightCheckProviderIssue[];
  /** Clasificación segura del sobre hecha por `SabreHttpClient`. */
  readonly httpWarnings: readonly SabreIssue[];
  readonly conversationId: string;
}

export class SabreFlightCheckNoMatchedOfferError extends Error {
  constructor(
    readonly validationResults: readonly SabreFlightCheckValidationResult[],
    readonly alternativeCount: number,
    readonly warnings: readonly SabreFlightCheckWarning[],
  ) {
    super(
      `offers/flightCheck no devolvió una oferta materializada con validación Matched ` +
        `(${String(alternativeCount)} alternativa(s))`,
    );
    this.name = 'SabreFlightCheckNoMatchedOfferError';
  }
}

/** Evita usar una cuenta/ctx de un tenant con una Offer que pertenece a otro. */
export class SabreFlightCheckTenantMismatchError extends Error {
  constructor() {
    super('la oferta y el contexto de Flight Check pertenecen a tenants distintos');
    this.name = 'SabreFlightCheckTenantMismatchError';
  }
}

export class SabreFlightCheckAdapter implements OfferPricePort {
  constructor(
    private readonly cfg: SabreConfig,
    private readonly http: SabreHttpClient,
    private readonly deps: SabreFlightCheckDeps = {},
  ) {}

  async priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    const quote = await this.checkOffer(offer, criteria, ctx);
    return {
      offer: quote.offer,
      priceChanged: quote.priceChanged,
      warnings: [...new Set(quote.warnings.map((warning) => warning.code))],
    };
  }

  /** Resultado completo, incluidos handles de booking y upsells de la misma cabina. */
  async checkOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<SabreFlightCheckedQuote> {
    if (offer.tenantId !== ctx.tenantId) throw new SabreFlightCheckTenantMismatchError();
    if (this.cfg.homePcc === undefined || this.cfg.homePcc.length === 0) {
      throw new SabreFlightCheckRequestError([
        'processingOptions.pseudoCityCode:required_for_atpco',
      ]);
    }

    // El builder corre ANTES del cliente: bookingClass faltante o inválida jamás sale al cable.
    const request = buildSabreFlightCheckRequest(offer, criteria, {
      pseudoCityCode: this.cfg.homePcc,
    });
    const result: SabreResult<unknown> = await this.http.postJson<unknown>(
      SABRE_FLIGHT_CHECK_PATH,
      request,
      {
        idempotent: true,
        ...(ctx.requestId === undefined
          ? {}
          : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
      },
    );

    const mapped = mapSabreFlightCheckResponse(result.data, {
      basis: offer,
      fetchedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
      ...(this.deps.uuid === undefined ? {} : { uuid: this.deps.uuid }),
    });
    if (mapped.matched === null || mapped.priceChange === null) {
      this.log('warn', 'sabre.flight_check.no_matched_offer', {
        tenantId: ctx.tenantId,
        conversationId: result.conversationId,
        durationMs: result.durationMs,
        alternatives: mapped.alternatives.length,
        validations: countValidations(mapped.validationResults),
        warnings: countFlightCheckWarnings(mapped.warnings),
      });
      throw new SabreFlightCheckNoMatchedOfferError(
        mapped.validationResults,
        mapped.alternatives.length,
        mapped.warnings,
      );
    }

    const priceChanged = mapped.priceChange.kind !== 'unchanged';
    this.log('debug', 'sabre.flight_check.ok', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      priceChanged,
      priceChangeKind: mapped.priceChange.kind,
      alternatives: mapped.alternatives.length,
      fareComponents: mapped.matched.offer.fareComponents?.length ?? 0,
      validations: countValidations(mapped.validationResults),
      warnings: countFlightCheckWarnings(mapped.warnings),
    });

    return {
      offer: mapped.matched.offer,
      handles: mapped.matched.handles,
      priceChange: mapped.priceChange,
      priceChanged,
      alternatives: mapped.alternatives,
      validationResults: mapped.validationResults,
      warnings: mapped.warnings,
      providerWarnings: mapped.providerWarnings,
      httpWarnings: result.warnings,
      conversationId: result.conversationId,
    };
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

export function countFlightCheckWarnings(
  warnings: readonly SabreFlightCheckWarning[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const warning of warnings) counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  return counts;
}

function countValidations(
  results: readonly SabreFlightCheckValidationResult[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.validation] = (counts[result.validation] ?? 0) + 1;
  }
  return counts;
}
