import {
  OfferSchema,
  type FareBreakdownEntry,
  type Money,
  type Offer,
  type ProviderRawValue,
} from '@sales-travel/canonical';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SABRE_PROVIDER_NAME, canonicalPaxType } from '../shop/response.mapper';
import { SABRE_RAW_KEYS } from './request.builder';

/**
 * Mapper de `OfferPriceResponseV1` (`POST /v1/offers/price`) al modelo canónico — RF-07.
 *
 * Verificado campo a campo contra `docs/sabre/evidence/specs/offer-price-ndc-v1.yml` y contra sus
 * tres ejemplos de respuesta oficiales, extraídos sin tocar a `src/__fixtures__/price-*.json`. El
 * mapa completo está en docs/sabre/03 §2.5.
 *
 * ## Este mapper falla fuerte donde el del shop degrada, y es a propósito
 *
 * `shop/response.mapper.ts` descarta la oferta mala y sigue: entre 200 resultados de una búsqueda,
 * tumbar la lista entera por una tarifa ilegible sería peor que perderla. Aquí es al revés. Una
 * respuesta de price es **una** oferta, es la que se le va a cobrar al cliente, y su número es el
 * que entra en el contrato de venta. Una respuesta que no encaja con el contrato **lanza**
 * ({@link SabrePriceMappingError}); un `messages[].type === 'ERROR'` **lanza**
 * ({@link SabrePriceRejectedError}). No hay precio "aproximado".
 *
 * ## El contenedor de errores se llama `messages`, no `errors`
 *
 * `OfferPriceResponseV1` **no declara ningún campo `errors`** (`:106-143`): el contenedor es
 * `messages[]` con `type` ∈ `ERROR|WARNING|INFO` (`:869-907`). Otros productos de Sabre —`getseats`
 * v3, por ejemplo— sí declaran `errors[]`/`warnings[]`, con otro schema. Un parser que busque
 * `errors` aquí **no va a ver nunca un error de Sabre** (docs/sabre/03 §2.5).
 *
 * Del `Message` se conservan `type`, `code`, `service` y `system`. **`message` y
 * `additionalDescription` no se leen**: son texto libre del proveedor y este objeto acaba en logs
 * (RNF-07), igual que en el mapper del shop.
 *
 * ## La cadena de identificadores efímeros y su TTL
 *
 * Shop devuelve unos ids, price devuelve OTROS, y `createBooking` consume los de price
 * (docs/sabre/03 §3.1). El puente es {@link SabrePriceHandles}, que además se copia a
 * `Offer.provider.raw` bajo las llaves de `SABRE_RAW_KEYS` para que la oferta viaje por Redis y
 * por HTTP sin perderlos.
 *
 * El TTL **no se inventa y no se calcula**: `ttl` (segundos) y `offerExpirationDateTime` son los
 * dos obligatorios por contrato (`:383-408`), valen 1.200 s (20 min) en los tres ejemplos
 * oficiales, y `expiresAt` sale del segundo — por eso `expiresAtSource` es `'provider'`, a
 * diferencia del carril ATPCO del shop, donde es política nuestra.
 *
 * **Cuando vence**: Sabre dice literalmente qué hacer. `createBooking` responde
 * `UNABLE_TO_CREATE_ORDER_EXPIRED_OFFER` / `BAD_REQUEST` / _"Invalid or Expired Offer. Use
 * offers/price to reprice the offer."_
 * (`help/booking-management-api-v1/help-documentation-create-booking-error-list.txt:690-694`). La
 * recuperación es **un salto, no dos**: se vuelve a llamar a price con los mismos `offerItemId`
 * —`readSabreOfferItemIds` ya da precedencia a los de price para eso— y no hace falta re-shopear.
 * Si la oferta ya llega vencida al mapper, se emite `offer-already-expired`, que es un aviso, no
 * una excepción: el número sigue siendo el que Sabre acaba de devolver, y quien decide si lo
 * muestra o repite la llamada es el caso de uso.
 */

/** Vocabulario cerrado de `Offer.source` (`offer-price-ndc-v1.yml:1809-1813`). */
export const SABRE_PRICE_SOURCES = ['ATPCO', 'LCC', 'NDC'] as const;
export type SabrePriceSource = (typeof SABRE_PRICE_SOURCES)[number];

/**
 * Cotas que impone **`createBooking`**, no este endpoint: `flightOffer.offerId` es `maxLength: 49`
 * y `selectedOfferItems` es `maxItems: 9` (`booking-management-v1.yml:4959-4974`).
 *
 * Se comprueban aquí, en el paso de precio, porque es donde todavía se puede avisar sin haber
 * prometido nada. Descubrir que la oferta no cabe en el request de reserva **en el momento de
 * reservar** es descubrirlo con el cliente delante.
 */
export const SABRE_BOOKING_OFFER_ID_MAX_LENGTH = 49;
export const SABRE_BOOKING_SELECTED_OFFER_ITEMS_MAX = 9;

/** Tolerancia del invariante `base + impuestos = total`: un céntimo. */
const MONEY_TOLERANCE_MINOR = 1;

/** ISO 8601 con offset explícito, que es lo que `OfferSchema.expiresAt` exige. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Fecha "de aspecto razonable" para los campos `…Text`, que el contrato define como texto libre
 * _"por si el proveedor externo devuelve datos que no cumplen el formato"_ (`:412-417`). Se acepta
 * lo que parece una fecha y se descarta lo demás: es texto del proveedor, y lo que se enseña al
 * vendedor no puede ser una cadena arbitraria de 4 KB.
 */
const DATE_LIKE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

/** `SignedCurrencyType.amount`: string, hasta 3 decimales, con signo (`:1185-1208`). */
const SIGNED_AMOUNT = /^(-?)(\d+)(?:\.(\d{1,3}))?$/;

// ---------------------------------------------------------------------------
// Zod en el borde
// ---------------------------------------------------------------------------

/**
 * `amount` es un **string** con hasta **3** decimales y `curCode` se llama así aquí y `code` en
 * `/v1/orders/view` (docs/sabre/03 §2.5). Los dos son obligatorios dentro del objeto: un
 * `totalTaxAmount: {}` —que existe en las respuestas reales guardadas— tiene que romper el parse,
 * no colarse como impuesto 0.
 */
const CurrencyAmountSchema = z.object({
  amount: z.string(),
  curCode: z.string(),
  taxable: z.boolean().optional(),
});

const TaxBreakdownSchema = z.object({
  amount: CurrencyAmountSchema,
  taxCode: z.string(),
  nation: z.string().optional(),
});

const TaxesSchema = z.object({
  total: CurrencyAmountSchema,
  breakdown: z.array(TaxBreakdownSchema).optional(),
});

const PriceSchema = z.object({
  totalAmount: CurrencyAmountSchema.optional(),
  baseAmount: CurrencyAmountSchema.optional(),
  taxes: TaxesSchema.optional(),
});

const PassengerOfferSchema = z.object({
  id: z.string(),
  ptc: z.string(),
  requestedPtc: z.string(),
  price: PriceSchema.optional(),
});

const AirOfferItemSchema = z.object({
  type: z.literal('Air'),
  id: z.string(),
  mandatoryInd: z.boolean().optional(),
  passengers: z.array(PassengerOfferSchema),
  price: PriceSchema.optional(),
});

/**
 * `ServiceOfferItem` es un **ancillary dentro de la respuesta de price** (`:556-598`). Existe, y
 * por eso el mapper ramifica por `type` en vez de asumir que todo item es un vuelo: un item de
 * servicio no tiene `passengers[]` sino `passengerRefs[]`, y leerlo como aéreo daría `undefined`.
 */
const ServiceOfferItemSchema = z.object({
  type: z.literal('Service'),
  id: z.string(),
  mandatoryInd: z.boolean().optional(),
  passengerRefs: z.array(z.string()),
  segmentRefs: z.array(z.string()),
  price: PriceSchema,
});

/**
 * Un `type` que no conocemos no tumba la respuesta, pero tampoco se cuenta: se avisa.
 *
 * El `refine` que excluye `Air` y `Service` **no es cosmético**. Sin él, esta rama es la red que
 * recoge cualquier item aéreo malformado —uno sin `passengers`, por ejemplo—, y ese item
 * desaparecería del `offerItemIds` que consume `createBooking`: se reservaría una oferta a la que
 * le falta un tramo, con un 200 por respuesta. Con el `refine`, ese item no encaja en ninguna rama
 * y la respuesta entera se rechaza, que es la conducta correcta cuando el precio es el que se va a
 * cobrar.
 */
const UnknownOfferItemSchema = z.object({
  type: z.string().refine((value) => value !== 'Air' && value !== 'Service', {
    message: 'un offerItem Air/Service malformado no puede degradarse a item desconocido',
  }),
  id: z.string().optional(),
});

const OfferItemSchema = z.union([
  AirOfferItemSchema,
  ServiceOfferItemSchema,
  UnknownOfferItemSchema,
]);

const ObFeeSchema = z.object({
  serviceCode: z.string().optional(),
  subCode: z.string().optional(),
  airline: z.string().optional(),
  isRefundable: z.boolean().optional(),
  surcharge: z.object({ amount: CurrencyAmountSchema.optional() }).optional(),
});

const PricedOfferSchema = z.object({
  id: z.string(),
  ttl: z.number().int(),
  source: z.string(),
  offerExpirationDateTime: z.string(),
  paymentTimeLimitDateTime: z.string().optional(),
  paymentTimeLimitText: z.string().optional(),
  purchaseTimeLimitDateTime: z.string().optional(),
  priceGuaranteeTimeLimitDateTime: z.string().optional(),
  priceGuaranteeTimeLimitText: z.string().optional(),
  offerItems: z.array(OfferItemSchema),
  totalPrice: z.object({
    totalAmount: CurrencyAmountSchema,
    baseAmount: CurrencyAmountSchema.optional(),
    equivAmount: CurrencyAmountSchema.optional(),
    totalTaxes: CurrencyAmountSchema.optional(),
    taxBreakdown: z.array(TaxBreakdownSchema).optional(),
    wasTicketValueUsed: z.boolean().optional(),
  }),
  obFees: z.array(ObFeeSchema).optional(),
});

const MessageSchema = z.object({
  type: z.string(),
  service: z.string().optional(),
  code: z.number().int().optional(),
  system: z.string().optional(),
});

/**
 * Sobre de la respuesta. `anyOf: [required: response, required: messages]` (`:109-113`): toda
 * respuesta trae una cosa o la otra, y el parser puede confiar en eso.
 */
export const SabrePriceResponseSchema = z.object({
  version: z.string(),
  id: z.string().optional(),
  messages: z.array(MessageSchema).optional(),
  response: z.object({ offers: z.array(PricedOfferSchema) }).optional(),
});

type SabrePricedOfferNode = z.infer<typeof PricedOfferSchema>;
type SabreOfferItemNode = z.infer<typeof OfferItemSchema>;
type SabreAirOfferItemNode = z.infer<typeof AirOfferItemSchema>;
type SabreServiceOfferItemNode = z.infer<typeof ServiceOfferItemSchema>;
type SabrePriceNode = z.infer<typeof PriceSchema>;
type SabreCurrencyAmount = z.infer<typeof CurrencyAmountSchema>;

/**
 * Guardas de la unión. La rama desconocida declara `type: string`, así que TypeScript no puede
 * discriminar por igualdad: sin estas dos funciones, `item.type === 'Air'` compila pero no estrecha
 * y `item.passengers` no existe para el compilador. Son la traducción del `refine` de arriba: en
 * tiempo de ejecución `type === 'Air'` sólo puede venir de {@link AirOfferItemSchema}.
 */
function isAirOfferItem(item: SabreOfferItemNode): item is SabreAirOfferItemNode {
  return item.type === 'Air';
}

function isServiceOfferItem(item: SabreOfferItemNode): item is SabreServiceOfferItemNode {
  return item.type === 'Service';
}

// ---------------------------------------------------------------------------
// Contrato de salida
// ---------------------------------------------------------------------------

export type SabrePriceWarningCode =
  /** Sabre devolvió un `WARNING`/`INFO`. Sin texto libre: sólo type/code/service/system. */
  | 'provider-message'
  /** No se mandó forma de pago: el precio puede subir al pagar (docs/sabre/03 §2.4). */
  | 'price-subject-to-form-of-payment'
  /** El precio revalidado no coincide con el de la búsqueda. */
  | 'price-changed'
  /** Hay `obFees[]` y el contrato NO dice si están dentro de `totalPrice.totalAmount`. */
  | 'ob-fees-relation-unverified'
  | 'offer-base-fare-derived'
  | 'offer-taxes-derived'
  /** Importe negativo (reemisión con valor residual): `MoneySchema` no admite negativos. */
  | 'negative-amount-unsupported'
  /** Tercer decimal distinto de 0: no cabe en unidades menores de 2 dígitos sin perder dinero. */
  | 'amount-precision-unsupported'
  | 'amount-unparseable'
  | 'currency-mismatch'
  /** La aerolínea tarificó un PTC distinto del pedido (`ptc` ≠ `requestedPtc`). */
  | 'ptc-repriced'
  | 'pax-type-unmapped'
  | 'pax-price-missing'
  /** La oferta trae ancillaries (`type: "Service"`) que el modelo canónico todavía no coloca. */
  | 'service-offer-item-not-mapped'
  | 'offer-item-type-unknown'
  | 'offer-already-expired'
  | 'expiration-datetime-unparseable'
  | 'time-limit-text-discarded'
  /** El `offerId` no cabe en `createBooking.flightOffer.offerId` (49 chars). */
  | 'offer-id-over-booking-limit'
  /** Más de 9 `offerItems`: no caben en `flightOffer.selectedOfferItems`. */
  | 'selected-offer-items-over-booking-limit'
  | 'offer-invalid';

/** Un problema de mapeo. Sin texto libre del proveedor y sin PII: esto se loguea. */
export interface SabrePriceWarning {
  readonly code: SabrePriceWarningCode;
  /** Ruta dentro de la respuesta, con índices. Ej. `response.offers[0].offerItems[1]`. */
  readonly path: string;
  /** Dato acotado y no sensible (un PTC, un delta en unidades menores, un código de mensaje). */
  readonly detail?: string;
}

/** `Message` sin su texto libre. */
export interface SabrePriceProviderMessage {
  readonly type: string;
  readonly code?: number;
  readonly service?: string;
  readonly system?: string;
}

/**
 * Los identificadores y relojes que la oferta revalidada entrega al paso de reserva (RF-07 CA-1).
 * Se publican como estructura tipada además de copiarse a `provider.raw`, para que `createBooking`
 * no tenga que hurgar en un `Record<string, unknown>`.
 */
export interface SabrePriceHandles {
  readonly offerId: string;
  readonly offerItemIds: readonly string[];
  readonly passengerIds: readonly string[];
  readonly source: SabrePriceSource;
  readonly ttlSeconds: number;
  readonly offerExpirationDateTime: string;
  readonly paymentTimeLimitDateTime?: string;
  readonly paymentTimeLimitText?: string;
  readonly purchaseTimeLimitDateTime?: string;
  readonly priceGuaranteeTimeLimitDateTime?: string;
  readonly priceGuaranteeTimeLimitText?: string;
}

export type SabrePriceChangeKind =
  | 'unchanged'
  | 'increased'
  | 'decreased'
  | 'currency-changed'
  /** No había oferta de referencia: no se puede afirmar que el precio no cambió. */
  | 'unknown';

/**
 * El precio confirmado frente al de la búsqueda.
 *
 * No es un detalle a tragarse: si el revalidado difiere del que el vendedor tiene en pantalla, es
 * un cambio de precio y hay que enseñarlo. Por eso `unknown` es un valor explícito y no `null`:
 * "no lo sé" y "no cambió" son cosas distintas y sólo una de las dos se le puede decir al cliente.
 */
export interface SabrePriceChange {
  readonly kind: SabrePriceChangeKind;
  readonly pricedTotalMinor: number;
  readonly currency: string;
  readonly previousTotalMinor?: number;
  readonly previousCurrency?: string;
  /** `priced - previous` en unidades menores. Positivo = subió. Ausente si no hay comparación. */
  readonly deltaMinor?: number;
}

export interface SabrePricedOffer {
  readonly offer: Offer;
  readonly handles: SabrePriceHandles;
  readonly priceChange: SabrePriceChange;
}

export interface SabrePriceMapResult {
  readonly priced: readonly SabrePricedOffer[];
  readonly warnings: readonly SabrePriceWarning[];
  readonly providerMessages: readonly SabrePriceProviderMessage[];
  /** `true` si alguna oferta cambió de precio respecto de la búsqueda. */
  readonly priceChanged: boolean;
  /**
   * `true` cuando la llamada fue **sin** forma de pago: el total puede subir al cobrar, y el
   * vendedor tiene que poder decírselo al cliente antes de prometer el importe.
   */
  readonly priceSubjectToFormOfPayment: boolean;
  /**
   * Ofertas que Sabre devolvió y que **no** se pudieron representar (importe negativo, precisión,
   * validación canónica). No es lo mismo que "no hay ofertas": el llamador tiene que distinguirlo.
   */
  readonly droppedOffers: number;
}

export interface SabrePriceMapContext {
  /** Tenant dueño de la cotización. UUID: `OfferSchema.tenantId` lo exige. */
  readonly tenantId: string;
  /** ISO 8601 con offset. Default: ahora. Se inyecta para que los tests sean deterministas. */
  readonly fetchedAt?: string;
  /**
   * La oferta que se mandó a revalidar. Es la referencia para el cambio de precio y **la fuente
   * del itinerario**: ver {@link mapSabrePriceResponse} sobre por qué los segmentos no se
   * reconstruyen desde la respuesta de price.
   */
  readonly basis?: Offer;
  /** `true` si el request llevó `params.formOfPayment`. Default `false`. */
  readonly formOfPaymentDeclared?: boolean;
}

/**
 * La respuesta no encaja con el contrato de Offer Price. El mensaje lleva **rutas y códigos de
 * issue de Zod, nunca valores**: por la respuesta pasan nombres de pasajero y números de socio.
 */
export class SabrePriceMappingError extends Error {
  constructor(readonly issuePaths: readonly string[]) {
    super(`respuesta de offers/price fuera de contrato (${issuePaths.join(', ') || '<root>'})`);
    this.name = 'SabrePriceMappingError';
  }
}

/**
 * Sabre rechazó la revalidación: hay `messages[].type === 'ERROR'`, o no hay `response`.
 * Lleva los mensajes ya despojados de texto libre.
 */
export class SabrePriceRejectedError extends Error {
  constructor(readonly providerMessages: readonly SabrePriceProviderMessage[]) {
    const summary = providerMessages
      .map((m) => `${m.type}/${m.service ?? '?'}/${String(m.code ?? 0)}`)
      .join(', ');
    super(`offers/price rechazó la revalidación (${summary || 'sin mensajes'})`);
    this.name = 'SabrePriceRejectedError';
  }
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

/**
 * ## Por qué el itinerario se arrastra de `ctx.basis` y no se reconstruye
 *
 * La respuesta de price **sí** trae segmentos, dentro de
 * `offerItems[].passengers[].fareComponents[].segments[]` — pero sus horas vienen **sin offset de
 * zona**: los tres ejemplos oficiales dan `"2024-02-11T06:00:00"` (`:2342-2352`), y
 * `SegmentSchema.departureAt` exige ISO 8601 **con** offset. Inventar el offset es inventar la
 * hora de salida, y de ahí a un cliente en el aeropuerto a la hora equivocada hay un paso.
 *
 * Como el itinerario **no cambia** en una revalidación de precio —cambia el precio—, el canónico
 * correcto es el que ya trae la oferta de búsqueda, donde los horarios sí venían con zona. Sin
 * `basis` la oferta revalidada sale sin `itineraries` (el campo es opcional en `OfferSchema`) en
 * vez de con un itinerario a medio inventar.
 */
export function mapSabrePriceResponse(
  raw: unknown,
  ctx: SabrePriceMapContext,
): SabrePriceMapResult {
  const parsed = SabrePriceResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabrePriceMappingError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }

  const body = parsed.data;
  const providerMessages: SabrePriceProviderMessage[] = (body.messages ?? []).map(toMessage);
  const errors = providerMessages.filter((m) => m.type.toUpperCase() === 'ERROR');
  if (errors.length > 0) throw new SabrePriceRejectedError(errors);
  if (body.response === undefined) throw new SabrePriceRejectedError(providerMessages);

  const warnings: SabrePriceWarning[] = [];
  for (let i = 0; i < providerMessages.length; i += 1) {
    const message = providerMessages[i];
    if (message === undefined) continue;
    warnings.push({
      code: 'provider-message',
      path: `messages[${String(i)}]`,
      detail: `${message.type}/${message.service ?? '?'}/${String(message.code ?? 0)}`,
    });
  }

  const fetchedAt = ctx.fetchedAt ?? new Date().toISOString();
  const formOfPaymentDeclared = ctx.formOfPaymentDeclared === true;
  if (!formOfPaymentDeclared) {
    // No es un fallo: es el modo por defecto que fija D1, y el aviso es lo que permite decirle al
    // vendedor "precio sujeto a la forma de pago" en vez de prometer un total que puede subir.
    warnings.push({ code: 'price-subject-to-form-of-payment', path: 'params.formOfPayment' });
  }

  const priced: SabrePricedOffer[] = [];
  let dropped = 0;
  const offers = body.response.offers;
  for (let i = 0; i < offers.length; i += 1) {
    const node = offers[i];
    if (node === undefined) continue;
    const mapped = mapOffer(node, `response.offers[${String(i)}]`, ctx, fetchedAt, warnings);
    if (mapped === null) dropped += 1;
    else priced.push(mapped);
  }

  return {
    priced,
    warnings,
    providerMessages,
    priceChanged: priced.some((entry) => isChanged(entry.priceChange.kind)),
    priceSubjectToFormOfPayment: !formOfPaymentDeclared,
    droppedOffers: dropped,
  };
}

function isChanged(kind: SabrePriceChangeKind): boolean {
  return kind === 'increased' || kind === 'decreased' || kind === 'currency-changed';
}

function toMessage(message: z.infer<typeof MessageSchema>): SabrePriceProviderMessage {
  const out: SabrePriceProviderMessage = { type: message.type };
  return {
    ...out,
    ...(message.code === undefined ? {} : { code: message.code }),
    ...(message.service === undefined ? {} : { service: message.service }),
    ...(message.system === undefined ? {} : { system: message.system }),
  };
}

// ---------------------------------------------------------------------------
// Una `offers[]` = una Offer canónica
// ---------------------------------------------------------------------------

function mapOffer(
  node: SabrePricedOfferNode,
  path: string,
  ctx: SabrePriceMapContext,
  fetchedAt: string,
  warnings: SabrePriceWarning[],
): SabrePricedOffer | null {
  const currency = normalizeCurrency(node.totalPrice.totalAmount.curCode);
  if (currency === null) {
    warnings.push({ code: 'offer-invalid', path, detail: 'curCode inválido' });
    return null;
  }

  const total = readAmountMinor(node.totalPrice.totalAmount, currency, `${path}.totalPrice.totalAmount`, warnings); // prettier-ignore
  if (total === null) return null;
  if (total < 0) {
    // Reemisión con valor residual: el contrato lo dice explícitamente y el ejemplo oficial
    // `UnusedTicketResponse` devuelve `-220.30` (`:4448-4478`). `MoneySchema.amountMinor` es
    // `nonnegative`, así que un reembolso neto NO se puede representar en el canónico de hoy.
    // Se descarta la oferta con aviso en vez de publicar su valor absoluto, que sería cobrarle al
    // cliente lo que había que devolverle.
    warnings.push({ code: 'negative-amount-unsupported', path: `${path}.totalPrice`, detail: 'total' }); // prettier-ignore
    return null;
  }

  const taxes = resolveTaxes(node, currency, path, warnings);
  const baseFare = resolveBaseFare(node, total, taxes, currency, path, warnings);
  if (baseFare === null) return null;

  const fareBreakdown = buildFareBreakdown(node, currency, path, warnings);
  const handles = buildHandles(node, path, warnings);
  if (handles === null) return null;

  checkBookingLimits(handles, path, warnings);
  const expiry = resolveExpiry(node, fetchedAt, path, warnings);
  if (isPast(expiry.expiresAt, fetchedAt)) {
    warnings.push({ code: 'offer-already-expired', path, detail: expiry.expiresAt });
  }
  if (node.obFees !== undefined && node.obFees.length > 0) {
    // `ObFee` es hermano de `totalPrice`, no un sumando declarado suyo: el contrato NO dice si el
    // fee está dentro del total o se añade (docs/sabre/03 §2.4, medición pendiente en CERT). Por
    // eso NO se rellena `Offer.fees`: publicar un fee como incluido cuando podría ser aditivo
    // falsea el precio en la dirección que le cuesta dinero a la agencia.
    warnings.push({
      code: 'ob-fees-relation-unverified',
      path: `${path}.obFees`,
      detail: String(node.obFees.length),
    });
  }

  const basis = ctx.basis;
  const candidate = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    products: basis?.products ?? ['flight'],
    provider: {
      name: SABRE_PROVIDER_NAME,
      offerRef: node.id.slice(0, 255),
      source: handles.source,
      raw: buildProviderRaw(node, handles, basis),
    },
    total: { amountMinor: total, currency } satisfies Money,
    baseFare,
    taxes,
    ...(fareBreakdown.length === 0 ? {} : { fareBreakdown }),
    // Arrastre desde la oferta de búsqueda: ver la cabecera de `mapSabrePriceResponse`.
    ...(basis?.itineraries === undefined ? {} : { itineraries: basis.itineraries }),
    ...(basis?.fareFamily === undefined ? {} : { fareFamily: basis.fareFamily }),
    ...(basis?.baggage === undefined ? {} : { baggage: basis.baggage }),
    ...(basis?.policies === undefined ? {} : { policies: basis.policies }),
    fetchedAt,
    expiresAt: expiry.expiresAt,
    expiresAtSource: 'provider' as const,
  };

  const validated = OfferSchema.safeParse(candidate);
  if (!validated.success) {
    warnings.push({
      code: 'offer-invalid',
      path,
      detail: validated.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
        .join(','),
    });
    return null;
  }

  const priceChange = compareWithBasis(total, currency, basis);
  if (isChanged(priceChange.kind)) {
    warnings.push({
      code: 'price-changed',
      path: `${path}.totalPrice`,
      detail:
        priceChange.kind === 'currency-changed'
          ? `${priceChange.previousCurrency ?? '?'}->${currency}`
          : `${priceChange.kind}:${String(priceChange.deltaMinor ?? 0)}`,
    });
  }

  return { offer: validated.data, handles, priceChange };
}

// ---------------------------------------------------------------------------
// Precio
// ---------------------------------------------------------------------------

/**
 * Impuestos, en tres saltos y sin inventar ceros.
 *
 * `totalPrice.totalTaxes` es opcional y **no viene en los ejemplos oficiales de ida y de multipax**:
 * ahí el desglose vive un nivel más abajo, en `offerItems[].passengers[].price.taxes.total`. El
 * último recurso —0— va con aviso, porque "no sé cuántos impuestos hay" y "no hay impuestos" son
 * cosas distintas y sólo una es cierta.
 */
function resolveTaxes(
  node: SabrePricedOfferNode,
  currency: string,
  path: string,
  warnings: SabrePriceWarning[],
): Money {
  const declared = node.totalPrice.totalTaxes;
  if (declared !== undefined) {
    const minor = readAmountMinor(declared, currency, `${path}.totalPrice.totalTaxes`, warnings);
    if (minor !== null && minor >= 0) return { amountMinor: minor, currency };
  }

  let sum = 0;
  let found = false;
  for (const item of node.offerItems) {
    if (!isAirOfferItem(item)) continue;
    for (const passenger of item.passengers) {
      const taxTotal = passenger.price?.taxes?.total;
      if (taxTotal === undefined) continue;
      const minor = readAmountMinor(taxTotal, currency, `${path}.offerItems`, warnings);
      if (minor === null || minor < 0) continue;
      sum += minor;
      found = true;
    }
  }
  if (found) return { amountMinor: sum, currency };

  warnings.push({
    code: 'offer-taxes-derived',
    path: `${path}.totalPrice`,
    detail: 'sin desglose',
  });
  return { amountMinor: 0, currency };
}

/**
 * La base se declara (`totalPrice.baseAmount`) o se deriva (`total - impuestos`).
 *
 * Cuando la declarada no cuadra con el total por más de un céntimo se usa la derivada y se avisa:
 * el invariante `base + impuestos = total` tiene que cumplirse siempre, porque es el que se enseña
 * desglosado en la cotización. `equivAmount` **no** se usa como base: el contrato lo define como
 * _"la base expresada en la moneda solicitada"_ (`:493-496`), o sea otra moneda, y sumarlo con
 * impuestos en la moneda del total es exactamente el error que ya costó una ronda en el shop.
 */
function resolveBaseFare(
  node: SabrePricedOfferNode,
  totalMinor: number,
  taxes: Money,
  currency: string,
  path: string,
  warnings: SabrePriceWarning[],
): Money | null {
  const derived = totalMinor - taxes.amountMinor;
  if (derived < 0) {
    warnings.push({ code: 'offer-invalid', path, detail: 'impuestos mayores que el total' });
    return null;
  }

  const declared = node.totalPrice.baseAmount;
  if (declared === undefined) return { amountMinor: derived, currency };

  if (normalizeCurrency(declared.curCode) !== currency) {
    warnings.push({ code: 'currency-mismatch', path: `${path}.totalPrice.baseAmount` });
    return { amountMinor: derived, currency };
  }

  const declaredMinor = readAmountMinor(declared, currency, `${path}.totalPrice.baseAmount`, warnings); // prettier-ignore
  if (declaredMinor === null || declaredMinor < 0) {
    return { amountMinor: derived, currency };
  }

  const gap = Math.abs(declaredMinor + taxes.amountMinor - totalMinor);
  if (gap === 0) return { amountMinor: declaredMinor, currency };
  if (gap > MONEY_TOLERANCE_MINOR) {
    warnings.push({
      code: 'offer-base-fare-derived',
      path: `${path}.totalPrice.baseAmount`,
      detail: `gap=${String(gap)}`,
    });
  }
  return { amountMinor: derived, currency };
}

/**
 * Desglose por tipo de pasajero.
 *
 * En multi-PTC hay **un `offerItem` por tipo de pasajero** y dentro `passengers[]` lista los pax de
 * ese tipo (docs/sabre/03 §2.5, confirmado por los scripts de WF-18 de la colección). El ejemplo
 * oficial de multipax tiene 1 item con 2 adultos a 118,90 y un total de item de 237,80: el
 * agrupado suma, no promedia.
 *
 * La clave incluye los importes: dos grupos del mismo PTC a precios distintos siguen siendo dos
 * entradas, porque fundirlos obligaría a promediar, que es inventar dinero.
 */
function buildFareBreakdown(
  node: SabrePricedOfferNode,
  currency: string,
  path: string,
  warnings: SabrePriceWarning[],
): FareBreakdownEntry[] {
  const grouped = new Map<string, { entry: FareBreakdownEntry; count: number }>();

  for (let i = 0; i < node.offerItems.length; i += 1) {
    const item = node.offerItems[i];
    if (item === undefined) continue;
    const itemPath = `${path}.offerItems[${String(i)}]`;
    if (isServiceOfferItem(item)) {
      // Los ancillaries de la respuesta de price existen y no se pierden en silencio: no hay
      // sitio para ellos en `Offer` todavía (RF-14), y su importe no entra en el desglose por pax.
      warnings.push({ code: 'service-offer-item-not-mapped', path: itemPath, detail: item.id });
      continue;
    }
    if (!isAirOfferItem(item)) {
      warnings.push({ code: 'offer-item-type-unknown', path: itemPath, detail: item.type });
      continue;
    }

    for (let p = 0; p < item.passengers.length; p += 1) {
      const passenger = item.passengers[p];
      if (passenger === undefined) continue;
      const paxPath = `${itemPath}.passengers[${String(p)}]`;

      if (passenger.ptc !== passenger.requestedPtc) {
        // Pedimos CNN y la aerolínea tarificó ADT: es un cambio de precio silencioso y el
        // vendedor tiene que verlo (`:599-663`).
        warnings.push({
          code: 'ptc-repriced',
          path: paxPath,
          detail: `${passenger.requestedPtc}->${passenger.ptc}`,
        });
      }

      const paxType = canonicalPaxType(passenger.ptc);
      if (paxType === null) {
        warnings.push({ code: 'pax-type-unmapped', path: paxPath, detail: passenger.ptc });
        continue;
      }

      const amounts = readPaxAmounts(passenger.price, currency, paxPath, warnings);
      if (amounts === null) continue;

      const key = `${paxType}|${String(amounts.base)}|${String(amounts.taxes)}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, {
          count: 1,
          entry: {
            paxType,
            paxCount: 1,
            basePerPax: { amountMinor: amounts.base, currency },
            taxesPerPax: { amountMinor: amounts.taxes, currency },
          },
        });
        continue;
      }
      existing.count += 1;
      grouped.set(key, { count: existing.count, entry: { ...existing.entry, paxCount: existing.count } }); // prettier-ignore
    }
  }

  return [...grouped.values()].map((value) => value.entry);
}

function readPaxAmounts(
  price: SabrePriceNode | undefined,
  currency: string,
  path: string,
  warnings: SabrePriceWarning[],
): { base: number; taxes: number } | null {
  if (price === undefined) {
    warnings.push({ code: 'pax-price-missing', path });
    return null;
  }

  const taxTotal = price.taxes?.total;
  const taxes = taxTotal === undefined ? 0 : readAmountMinor(taxTotal, currency, path, warnings);
  if (taxes === null || taxes < 0) {
    warnings.push({ code: 'pax-price-missing', path, detail: 'impuestos' });
    return null;
  }

  if (price.baseAmount !== undefined) {
    const base = readAmountMinor(price.baseAmount, currency, path, warnings);
    if (base !== null && base >= 0) return { base, taxes };
  }
  if (price.totalAmount !== undefined) {
    const paxTotal = readAmountMinor(price.totalAmount, currency, path, warnings);
    if (paxTotal !== null && paxTotal - taxes >= 0) return { base: paxTotal - taxes, taxes };
  }

  warnings.push({ code: 'pax-price-missing', path, detail: 'base' });
  return null;
}

/**
 * `amount` es un string con hasta **3** decimales (`:1185-1208`), y `Money` son unidades menores
 * enteras de **2**. Se parsea con aritmética de enteros sobre el texto: `parseFloat` sobre
 * `"402.535"` y un `* 100` arrastran el error de coma flotante justo en el campo que se cobra.
 *
 * Un tercer decimal distinto de 0 **no se redondea**: se rechaza la oferta. Redondear medio
 * céntimo por pasajero es una decisión de dinero, y no la toma un mapper en silencio.
 */
function readAmountMinor(
  value: SabreCurrencyAmount,
  expectedCurrency: string,
  path: string,
  warnings: SabrePriceWarning[],
): number | null {
  if (normalizeCurrency(value.curCode) !== expectedCurrency) {
    warnings.push({ code: 'currency-mismatch', path, detail: value.curCode });
    return null;
  }

  const match = SIGNED_AMOUNT.exec(value.amount);
  const units = match?.[2];
  if (match === null || units === undefined) {
    warnings.push({ code: 'amount-unparseable', path });
    return null;
  }
  const fraction = (match[3] ?? '').padEnd(3, '0');
  if (fraction.charAt(2) !== '0') {
    warnings.push({ code: 'amount-precision-unsupported', path, detail: '3 decimales' });
    return null;
  }

  const minor = Number(units) * 100 + Number(fraction.slice(0, 2));
  if (!Number.isSafeInteger(minor)) {
    warnings.push({ code: 'amount-unparseable', path, detail: 'fuera de rango' });
    return null;
  }
  return match[1] === '-' ? -minor : minor;
}

function compareWithBasis(
  totalMinor: number,
  currency: string,
  basis: Offer | undefined,
): SabrePriceChange {
  if (basis === undefined) {
    return { kind: 'unknown', pricedTotalMinor: totalMinor, currency };
  }
  if (basis.total.currency !== currency) {
    return {
      kind: 'currency-changed',
      pricedTotalMinor: totalMinor,
      currency,
      previousTotalMinor: basis.total.amountMinor,
      previousCurrency: basis.total.currency,
    };
  }
  const delta = totalMinor - basis.total.amountMinor;
  return {
    kind: delta === 0 ? 'unchanged' : delta > 0 ? 'increased' : 'decreased',
    pricedTotalMinor: totalMinor,
    currency,
    previousTotalMinor: basis.total.amountMinor,
    previousCurrency: basis.total.currency,
    deltaMinor: delta,
  };
}

// ---------------------------------------------------------------------------
// Identificadores, relojes y `provider.raw`
// ---------------------------------------------------------------------------

function buildHandles(
  node: SabrePricedOfferNode,
  path: string,
  warnings: SabrePriceWarning[],
): SabrePriceHandles | null {
  const source = normalizeSource(node.source);
  if (source === null) {
    warnings.push({ code: 'offer-invalid', path, detail: `source=${node.source}` });
    return null;
  }

  const offerItemIds: string[] = [];
  const passengerIds: string[] = [];
  for (const item of node.offerItems) {
    if (isAirOfferItem(item)) {
      offerItemIds.push(item.id);
      for (const passenger of item.passengers) {
        if (!passengerIds.includes(passenger.id)) passengerIds.push(passenger.id);
      }
      continue;
    }
    // El ancillary tarificado también es un `offerItem` reservable: `selectedOfferItems[]` los
    // acepta igual, y dejarlo fuera vendería el vuelo sin el servicio que el cliente ya vio.
    if (isServiceOfferItem(item)) offerItemIds.push(item.id);
  }

  if (offerItemIds.length === 0) {
    warnings.push({ code: 'offer-invalid', path, detail: 'sin offerItems reservables' });
    return null;
  }

  return {
    offerId: node.id,
    offerItemIds,
    passengerIds,
    source,
    ttlSeconds: node.ttl,
    offerExpirationDateTime: node.offerExpirationDateTime,
    ...(node.paymentTimeLimitDateTime === undefined
      ? {}
      : { paymentTimeLimitDateTime: node.paymentTimeLimitDateTime }),
    ...readTimeLimitText(node.paymentTimeLimitText, 'paymentTimeLimitText', path, warnings),
    ...(node.purchaseTimeLimitDateTime === undefined
      ? {}
      : { purchaseTimeLimitDateTime: node.purchaseTimeLimitDateTime }),
    ...(node.priceGuaranteeTimeLimitDateTime === undefined
      ? {}
      : { priceGuaranteeTimeLimitDateTime: node.priceGuaranteeTimeLimitDateTime }),
    ...readTimeLimitText(
      node.priceGuaranteeTimeLimitText,
      'priceGuaranteeTimeLimitText',
      path,
      warnings,
    ),
  };
}

/**
 * Los campos `…Text` existen porque hay proveedores que devuelven fechas fuera de formato
 * (`:412-417`), y RF-07 CA-4 exige aceptarlos. Aceptarlos no es copiarlos a ciegas: lo que no se
 * parece a una fecha se descarta con aviso, porque de ahí sale una etiqueta que se le enseña al
 * vendedor.
 */
function readTimeLimitText(
  value: string | undefined,
  field: 'paymentTimeLimitText' | 'priceGuaranteeTimeLimitText',
  path: string,
  warnings: SabrePriceWarning[],
): Record<string, string> {
  if (value === undefined) return {};
  if (!DATE_LIKE_TEXT.test(value)) {
    warnings.push({ code: 'time-limit-text-discarded', path: `${path}.${field}` });
    return {};
  }
  return { [field]: value };
}

/**
 * Las dos cotas de `createBooking`, comprobadas en el paso de precio. Son avisos y no errores: la
 * oferta es válida y su precio es real; lo que no se puede es reservarla tal cual, y eso hay que
 * saberlo antes de prometerla.
 */
function checkBookingLimits(
  handles: SabrePriceHandles,
  path: string,
  warnings: SabrePriceWarning[],
): void {
  if (handles.offerId.length > SABRE_BOOKING_OFFER_ID_MAX_LENGTH) {
    warnings.push({
      code: 'offer-id-over-booking-limit',
      path: `${path}.id`,
      detail: String(handles.offerId.length),
    });
  }
  if (handles.offerItemIds.length > SABRE_BOOKING_SELECTED_OFFER_ITEMS_MAX) {
    warnings.push({
      code: 'selected-offer-items-over-booking-limit',
      path: `${path}.offerItems`,
      detail: String(handles.offerItemIds.length),
    });
  }
}

export interface SabrePriceExpiry {
  readonly expiresAt: string;
  /** De dónde salió: el campo fechado, o `fetchedAt + ttl`. Los dos son dato del proveedor. */
  readonly from: 'offerExpirationDateTime' | 'ttl';
}

/**
 * `expiresAt` sale de `offerExpirationDateTime`, que es obligatorio por contrato: **se persiste, no
 * se calcula** (docs/sabre/03 §3.3). El respaldo es `fetchedAt + ttl`, que también es dato del
 * proveedor (`ttl` es igualmente obligatorio), por lo que `expiresAtSource` sigue siendo
 * `'provider'` en los dos casos — a diferencia del carril ATPCO del shop, donde el TTL es política
 * nuestra y hay que decirlo.
 */
export function resolveSabrePriceExpiry(
  node: { readonly offerExpirationDateTime: string; readonly ttl: number },
  fetchedAt: string,
): SabrePriceExpiry | null {
  const declared = node.offerExpirationDateTime;
  if (ISO_WITH_OFFSET.test(declared) && !Number.isNaN(Date.parse(declared))) {
    return { expiresAt: new Date(declared).toISOString(), from: 'offerExpirationDateTime' };
  }
  const base = Date.parse(fetchedAt);
  if (Number.isNaN(base) || !Number.isSafeInteger(node.ttl) || node.ttl <= 0) return null;
  return { expiresAt: new Date(base + node.ttl * 1000).toISOString(), from: 'ttl' };
}

function resolveExpiry(
  node: SabrePricedOfferNode,
  fetchedAt: string,
  path: string,
  warnings: SabrePriceWarning[],
): SabrePriceExpiry {
  const resolved = resolveSabrePriceExpiry(node, fetchedAt);
  if (resolved !== null && resolved.from === 'offerExpirationDateTime') return resolved;
  warnings.push({
    code: 'expiration-datetime-unparseable',
    path: `${path}.offerExpirationDateTime`,
  });
  // Sin fecha legible y sin TTL utilizable no queda nada del proveedor: se usa `fetchedAt`, que
  // vence la oferta de inmediato. Es lo conservador — una oferta que se cree viva sin respaldo es
  // la que se manda a `createBooking` y vuelve con `UNABLE_TO_CREATE_ORDER_EXPIRED_OFFER`.
  return resolved ?? { expiresAt: fetchedAt, from: 'ttl' };
}

function isPast(expiresAt: string, fetchedAt: string): boolean {
  const at = Date.parse(expiresAt);
  const now = Date.parse(fetchedAt);
  if (Number.isNaN(at) || Number.isNaN(now)) return false;
  return at <= now;
}

/**
 * Lo que viaja dentro de `Offer.provider.raw`.
 *
 * Reglas del canónico (`packages/canonical/src/offer.ts`): esto acaba en Redis y en el navegador,
 * así que **no lleva secretos, PAN ni PII**. En concreto **no se copia nada de `obFees[]` que
 * identifique una tarjeta** —`binNumber`, `cardCode`, `cardType`— ni la `description` de la
 * aerolínea, que es texto libre. Del fee sólo viajan el código, la aerolínea y el importe, que es
 * lo que hace falta para medir en CERT si el fee está dentro del total o se suma.
 */
function buildProviderRaw(
  node: SabrePricedOfferNode,
  handles: SabrePriceHandles,
  basis: Offer | undefined,
): Record<string, ProviderRawValue> {
  const raw: Record<string, ProviderRawValue> = {
    [SABRE_RAW_KEYS.priceOfferId]: handles.offerId,
    [SABRE_RAW_KEYS.priceOfferItemIds]: [...handles.offerItemIds],
    [SABRE_RAW_KEYS.pricePassengerIds]: [...handles.passengerIds],
    source: handles.source,
    ttlSeconds: handles.ttlSeconds,
    offerExpirationDateTime: handles.offerExpirationDateTime,
    paymentTimeLimitDateTime: handles.paymentTimeLimitDateTime ?? null,
    paymentTimeLimitText: handles.paymentTimeLimitText ?? null,
    purchaseTimeLimitDateTime: handles.purchaseTimeLimitDateTime ?? null,
    priceGuaranteeTimeLimitDateTime: handles.priceGuaranteeTimeLimitDateTime ?? null,
    priceGuaranteeTimeLimitText: handles.priceGuaranteeTimeLimitText ?? null,
    wasTicketValueUsed: node.totalPrice.wasTicketValueUsed ?? null,
  };

  // Trazabilidad de la cadena: los ids del shop se conservan para poder conciliar la orden con la
  // búsqueda que la originó (`orders/view` devuelve el `offerItemId`, docs/sabre/03 §3.5).
  const previous = basis?.provider.raw;
  if (previous !== undefined) {
    const shopFare = previous[SABRE_RAW_KEYS.shopOfferItemIds];
    const shopPax = previous[SABRE_RAW_KEYS.shopPassengerOfferItemIds];
    if (shopFare !== undefined) raw[SABRE_RAW_KEYS.shopOfferItemIds] = shopFare;
    if (shopPax !== undefined) raw[SABRE_RAW_KEYS.shopPassengerOfferItemIds] = shopPax;
  }

  const obFees = node.obFees ?? [];
  if (obFees.length > 0) {
    raw['obFees'] = obFees.map((fee) => ({
      serviceCode: fee.serviceCode ?? null,
      subCode: fee.subCode ?? null,
      airline: fee.airline ?? null,
      isRefundable: fee.isRefundable ?? null,
      amount: fee.surcharge?.amount?.amount ?? null,
      curCode: fee.surcharge?.amount?.curCode ?? null,
    }));
    // `null` y no `false`: el contrato no declara la relación entre `obFees[]` y
    // `totalPrice.totalAmount`, y "no lo sabemos" no es "no está incluido" (docs/sabre/03 §2.4).
    raw['obFeesIncludedInTotal'] = null;
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function normalizeCurrency(value: string): string | null {
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

function normalizeSource(value: string): SabrePriceSource | null {
  const upper = value.trim().toUpperCase();
  return (SABRE_PRICE_SOURCES as readonly string[]).includes(upper)
    ? (upper as SabrePriceSource)
    : null;
}
