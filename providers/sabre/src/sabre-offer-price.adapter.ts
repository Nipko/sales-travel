import type { LoggerPort } from '@sales-travel/core';
import type { Offer } from '@sales-travel/canonical';
import type {
  FlightSearchCriteria,
  OfferPricePort,
  OfferPriceResult,
  SearchContext,
} from '@sales-travel/domain';
import type { SabreConfig } from './config';
import { sabreConversationIdPrefix } from './config';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';
import {
  SABRE_PRICE_PATH,
  buildSabrePriceRequest,
  readSabreOfferItemIds,
  type SabreOfferItemGranularity,
  type SabreOfferItemOrigin,
  type SabrePriceFormOfPaymentInput,
  type SabrePriceRequest,
} from './price/request.builder';
import {
  mapSabrePriceResponse,
  type SabrePriceChange,
  type SabrePriceHandles,
  type SabrePriceProviderMessage,
  type SabrePriceWarning,
} from './price/response.mapper';

/**
 * Adapter de `POST /v1/offers/price` — el eslabón que faltaba entre el shop y `createBooking`
 * (docs/sabre/03, RF-07).
 *
 * Antes de este fichero, `buildSabrePriceRequest` y `mapSabrePriceResponse` existían y **nadie
 * los llamaba**: el paquete tenía el contrato de revalidación escrito y ningún camino que lo
 * ejecutara. Ésta es la cadena completa, en un solo sitio:
 *
 *   `readSabreOfferItemIds(offer)` → `buildSabrePriceRequest` → `SabreHttpClient.postJson` →
 *   `mapSabrePriceResponse(raw, { basis, formOfPaymentDeclared })`
 *
 * Dos datos del contexto **no son opcionales de hecho** aunque el tipo del mapper los declare
 * como tales, y por eso los pone este adapter y no el llamador:
 *
 *  - `basis` — sin la oferta de búsqueda no hay comparación de precio (todo sale `unknown`) ni
 *    itinerario en la oferta revalidada, porque los horarios de la respuesta de price vienen sin
 *    offset de zona y no se pueden reconstruir.
 *  - `formOfPaymentDeclared` — decide `priceSubjectToFormOfPayment`, que es lo que le dice al
 *    vendedor «este total puede subir al cobrar». Se deriva del request que ACABAMOS de mandar,
 *    no de lo que el llamador crea recordar.
 */

/**
 * ¿Puede este tenant tarificar con BIN de tarjeta?
 *
 * Existe como **puerto** y no como booleano de función por D1. Un parámetro que compila cuando
 * se le pasa `true` es un interruptor que alguien pone a `true` para salir del paso; un puerto
 * obliga a que la respuesta venga de fuera —flag de Unleash, `provider_accounts.config`— y a que
 * la decisión sea POR TENANT, que es lo que D1 pide.
 *
 * El default del paquete es {@link DENY_CARD_BIN_PRICING}: nace apagado.
 */
export interface SabreCardBinPricingPolicy {
  isAllowedForTenant(tenantId: string): Promise<boolean>;
}

/** El default. No lee nada y contesta que no: la postura PCI SAQ-A no se decide por omisión. */
export const DENY_CARD_BIN_PRICING: SabreCardBinPricingPolicy = {
  isAllowedForTenant: () => Promise.resolve(false),
};

/**
 * Sabre respondió con la forma del contrato pero sin ninguna oferta representable.
 *
 * No es lo mismo que un rechazo (`SabrePriceRejectedError`, que lleva los mensajes del
 * proveedor) ni que una respuesta fuera de contrato (`SabrePriceMappingError`): aquí el
 * proveedor contestó bien y lo que devolvió no se puede vender. `droppedOffers` dice cuántas se
 * descartaron; cero significa que la respuesta venía vacía.
 */
export class SabreOfferPriceEmptyError extends Error {
  constructor(readonly droppedOffers: number) {
    super(
      droppedOffers > 0
        ? `offers/price devolvió ${String(droppedOffers)} oferta(s) que no se pueden representar en el modelo canónico`
        : 'offers/price no devolvió ninguna oferta para revalidar',
    );
    this.name = 'SabreOfferPriceEmptyError';
  }
}

/** Se pidió tarificar con datos de tarjeta y el tenant no lo tiene permitido (D1). */
export class SabreCardBinPricingDeniedError extends Error {
  constructor() {
    super(
      'la tarificación con BIN/tipo de tarjeta está desactivada para este tenant: ' +
        'D1 fija que se reserva sin PAN y se cobra por hosted checkout del PSP',
    );
    this.name = 'SabreCardBinPricingDeniedError';
  }
}

export interface SabreOfferPriceDeps {
  readonly logger?: LoggerPort;
  readonly now?: () => number;
  /** Apagado por defecto y por tenant (D1). Ver {@link SabreCardBinPricingPolicy}. */
  readonly cardBinPricing?: SabreCardBinPricingPolicy;
}

export interface SabreOfferPriceOptions {
  /**
   * Nivel del `offerItemId` que se manda. `passenger` es el que exigen forma de pago y asientos;
   * `fare` es el caso normal. Ver {@link SabreOfferItemGranularity}.
   */
  readonly granularity?: SabreOfferItemGranularity;
  /**
   * Forma de pago con la que tarificar. Un `subCode` sin datos de tarjeta (`CA`, `CK`) no pasa
   * por la política; uno con `binNumber`/`cardType` sí, y se rechaza si el tenant no lo permite.
   */
  readonly formOfPayment?: SabrePriceFormOfPaymentInput;
  /** `payloadAttributes.trxID`. Correlación con nuestro trace id. */
  readonly trxId?: string;
}

/**
 * Lo que la cotización revalidada entrega arriba.
 *
 * Es MÁS que `OfferPriceResult` a propósito: `priceChange.deltaMinor`,
 * `priceSubjectToFormOfPayment` y `origin` son datos que tienen que llegar a la pantalla del
 * vendedor y al `domain_event` de la cotización. Aplanarlos a `{ offer, priceChanged, warnings }`
 * —que es todo lo que el puerto del dominio admite— los mataría en el log.
 */
export interface SabrePricedQuote {
  readonly offer: Offer;
  readonly handles: SabrePriceHandles;
  readonly priceChange: SabrePriceChange;
  readonly priceChanged: boolean;
  /** `true` si se tarificó SIN forma de pago: el total puede subir al cobrar. */
  readonly priceSubjectToFormOfPayment: boolean;
  /**
   * De qué paso salieron los ids que se mandaron. `'price'` es una **recuperación de oferta
   * vencida** (la oferta ya había pasado por price); `'shop-fare'` / `'shop-passenger'` son una
   * cotización normal desde la búsqueda.
   */
  readonly origin: SabreOfferItemOrigin;
  readonly warnings: readonly SabrePriceWarning[];
  readonly providerMessages: readonly SabrePriceProviderMessage[];
  readonly droppedOffers: number;
  readonly conversationId: string;
}

export class SabreOfferPriceAdapter implements OfferPricePort {
  private readonly cardBinPricing: SabreCardBinPricingPolicy;

  constructor(
    private readonly cfg: SabreConfig,
    private readonly http: SabreHttpClient,
    private readonly deps: SabreOfferPriceDeps = {},
  ) {
    this.cardBinPricing = deps.cardBinPricing ?? DENY_CARD_BIN_PRICING;
  }

  /**
   * El puerto del dominio. Devuelve lo poco que `OfferPriceResult` admite; quien necesite el
   * delta, el origen o el aviso de forma de pago llama a {@link priceQuote}.
   *
   * `criteria` no se usa: en Sabre la revalidación se direcciona por los `offerItemId` que la
   * propia oferta transporta, no por los criterios de búsqueda. Se acepta porque lo exige la
   * firma del puerto.
   */
  async priceOffer(
    offer: Offer,
    _criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    const quote = await this.priceQuote(offer, ctx);
    return {
      offer: quote.offer,
      priceChanged: quote.priceChanged,
      warnings: [
        ...quote.warnings.map((w) => w.code),
        // No es un aviso de mapeo: es información comercial que el vendedor tiene que ver.
        ...(quote.priceSubjectToFormOfPayment ? ['price-subject-to-form-of-payment'] : []),
      ],
    };
  }

  /** La cotización completa: identificadores, cambio de precio y procedencia de los ids. */
  async priceQuote(
    offer: Offer,
    ctx: SearchContext,
    options: SabreOfferPriceOptions = {},
  ): Promise<SabrePricedQuote> {
    const formOfPayment = await this.resolveFormOfPayment(ctx.tenantId, options.formOfPayment);
    const { offerItemIds, origin } = readSabreOfferItemIds(offer, options.granularity ?? 'fare');

    const request: SabrePriceRequest = buildSabrePriceRequest(
      {
        query: [{ offerItemIds: [...offerItemIds] }],
        ...(formOfPayment === undefined ? {} : { formOfPayment }),
      },
      {
        ...(options.trxId === undefined ? {} : { trxId: options.trxId }),
        // Se pasa el veredicto de la política, no una constante: si llegó hasta aquí con datos de
        // tarjeta es porque el tenant lo tiene permitido, y el builder vuelve a comprobarlo.
        allowCardBinPricing: hasCardData(formOfPayment),
      },
    );

    // Una revalidación no crea reserva ni mueve dinero: el peor caso de un reintento es una
    // cotización huérfana que caduca sola. `/v1/offers/price` NO está en
    // `SABRE_NON_IDEMPOTENT_PATHS`, así que la marca surte efecto.
    const result: SabreResult<unknown> = await this.http.postJson<unknown>(
      SABRE_PRICE_PATH,
      request,
      {
        idempotent: true,
        ...(ctx.requestId === undefined
          ? {}
          : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
      },
    );

    const fetchedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
    const mapped = mapSabrePriceResponse(result.data, {
      tenantId: ctx.tenantId,
      fetchedAt,
      // La oferta de búsqueda es la referencia del cambio de precio Y la fuente del itinerario.
      basis: offer,
      formOfPaymentDeclared: formOfPayment !== undefined,
    });

    const first = mapped.priced[0];
    if (first === undefined) throw new SabreOfferPriceEmptyError(mapped.droppedOffers);

    this.log('debug', 'sabre.price.ok', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      origin,
      source: first.handles.source,
      priceChanged: mapped.priceChanged,
      priceChangeKind: first.priceChange.kind,
      ...(first.priceChange.deltaMinor === undefined
        ? {}
        : { deltaMinor: first.priceChange.deltaMinor }),
      priceSubjectToFormOfPayment: mapped.priceSubjectToFormOfPayment,
      droppedOffers: mapped.droppedOffers,
      warnings: countPriceWarnings(mapped.warnings),
    });

    return {
      offer: first.offer,
      handles: first.handles,
      priceChange: first.priceChange,
      priceChanged: mapped.priceChanged,
      priceSubjectToFormOfPayment: mapped.priceSubjectToFormOfPayment,
      origin,
      warnings: mapped.warnings,
      providerMessages: mapped.providerMessages,
      droppedOffers: mapped.droppedOffers,
      conversationId: result.conversationId,
    };
  }

  /**
   * Aplica D1 antes de construir nada.
   *
   * Una forma de pago sin datos de tarjeta pasa siempre. Una CON datos de tarjeta sólo pasa si la
   * política dice que sí para ESE tenant; si dice que no, se lanza en vez de degradar en silencio
   * a «tarifico sin forma de pago»: el precio saldría distinto del que el vendedor pidió y nadie
   * se enteraría de por qué.
   */
  private async resolveFormOfPayment(
    tenantId: string,
    declared: SabrePriceFormOfPaymentInput | undefined,
  ): Promise<SabrePriceFormOfPaymentInput | undefined> {
    if (declared === undefined) return undefined;
    if (!hasCardData(declared)) return declared;
    if (await this.cardBinPricing.isAllowedForTenant(tenantId)) return declared;
    throw new SabreCardBinPricingDeniedError();
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

/** `binNumber` o `cardType` presentes = la llamada tarifica con datos de tarjeta. */
function hasCardData(fop: SabrePriceFormOfPaymentInput | undefined): boolean {
  if (fop === undefined) return false;
  return fop.binNumber !== undefined || fop.cardType !== undefined;
}

/**
 * Avisos agregados por código. Se cuentan y no se listan por la misma razón que en el shop: una
 * respuesta con varias ofertas repite el mismo aviso una vez por oferta y llenar el log de copias
 * no añade nada al número.
 */
export function countPriceWarnings(warnings: readonly SabrePriceWarning[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const warning of warnings) {
    counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  }
  return counts;
}
