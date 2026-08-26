import type { Offer } from '@sales-travel/canonical';
import { z } from 'zod';
import { SABRE_PROVIDER_NAME } from '../shop/response.mapper';

/**
 * Constructor de `OfferPriceRequestV1` para `POST /v1/offers/price` — revalidación de precio NDC
 * (RF-07).
 *
 * Todo lo que este archivo afirma sobre el API está verificado contra
 * `docs/sabre/evidence/specs/offer-price-ndc-v1.yml`; el mapa de campos completo está en
 * docs/sabre/03 §2.2. Los nombres de propiedad son los del contrato y no se camelizan ni se
 * renombran: son la representación del cable.
 *
 * ## Tres hechos del contrato que ordenan el diseño de este builder
 *
 * 1. **El único campo obligatorio es `query`** (`:74-79`), y el ejemplo que el propio Sabre
 *    publica como caso más común es `{"query":[{"offerItemId":["…"]}]}` a secas (`:2059-2078`).
 *    Todo lo demás se omite salvo que quien llama lo pida.
 * 2. **No hay ni un campo de punto de venta, PCC o agencia en todo el request**: el contexto viaja
 *    en el token (`security: oauth2_authentication`, `:67-68`). Por eso este builder —a diferencia
 *    de `shop/request.builder.ts`— no recibe `SabreConfig`. Si algún día aparece un PCC aquí, es
 *    que el contrato cambió y `spec-manifest.test.ts` lo habrá dicho antes.
 * 3. **`params` es `additionalProperties: false`** (`:269`). Se construye cerrado, campo a campo;
 *    nada se reenvía "tal cual viene".
 *
 * ## Forma de pago: por qué por defecto NO se manda (D1)
 *
 * El precio depende del BIN —la aerolínea cobra fees por forma de pago y los desglosa en
 * `offers[].obFees[]`— pero `params.formOfPayment` **no es obligatorio**, y la doc oficial dice
 * qué pasa si falta: el servicio _"crea mensajes de advertencia … informando de una posible subida
 * de precio si no se proporcionó la forma de pago"_
 * (VERIFICADO-SPEC: `help/offer-price-ndc-v1/v1-index.txt:36`).
 *
 * Con D1 ya decidida —no se manda PAN ni CVV, se cobra por hosted checkout del PSP— el camino por
 * defecto es cotizar **sin** forma de pago y decirle al vendedor que el precio está sujeto a ella.
 * El BIN (6-8 dígitos) no es PAN y no rompe SAQ-A por sí solo, así que se admite, pero **sólo tras
 * un interruptor explícito** ({@link SabrePriceBuildOptions.allowCardBinPricing}, apagado por
 * defecto y cableado por tenant), porque un dato de tarjeta que nadie pidió es superficie que
 * alguien acaba logueando. El impacto de no mandarlo lo publica el mapper como
 * `priceSubjectToFormOfPayment`.
 *
 * Sin tarjeta hay dos subcódigos que sí son seguros y que el contrato nombra: `CA` (efectivo) y
 * `CK` (cheque) (`:283-290`). Ésos no necesitan interruptor.
 *
 * ## Lo que este builder NO manda nunca, y por qué
 *
 * - **`passengers[].personName`** (`:224-226`): es PII y el contrato lo declara opcional. Tarificar
 *   no necesita el nombre; mandarlo lo mete en el cuerpo de una llamada que se reintenta y se
 *   audita. Si el CERT demuestra que una tarifa de socio frecuente exige el nombre, se reabre con
 *   evidencia, no por comodidad.
 * - **`frequentFlyer[].signInID`** (`:1026-1030`): es un identificador de acceso a la cuenta del
 *   pasajero. Del bloque de socio frecuente sólo viajan los dos campos obligatorios, `airline` y
 *   `accountNumber` (`:990-1000`).
 * - **`diags`** (`:100-104`): son diagnósticos de depuración interna y la respuesta los devuelve en
 *   `diagnostics[]` con cabeceras y payloads de sistemas internos de Sabre. No se piden desde
 *   producción.
 */

/** Ruta del servicio (`offer-price-ndc-v1.yml:15` `basePath: /v1/offers`, operación `:19`). */
export const SABRE_PRICE_PATH = '/v1/offers/price';

/** `passengers` admite como máximo 9 (`:91-96`). */
export const SABRE_PRICE_MAX_PASSENGERS = 9;

/** `params.formOfPayment` es un array de **uno** (`:247-252`). No hay split payment aquí. */
export const SABRE_PRICE_MAX_FORMS_OF_PAYMENT = 1;

/** `OfferItemId` del request (`:186-190`). Ojo: 30 chars de prefijo, no ilimitado. */
export const SABRE_PRICE_OFFER_ITEM_ID_PATTERN = /^[a-zA-Z0-9]{1,30}(?:-[0-9]{1,10}){2}$/;

/** `query[].passengerId` y `Passenger.id` (`:191-200`, `:214-218`). */
export const SABRE_PRICE_PASSENGER_ID_PATTERN = /^[\w-]{1,200}$/;

/** PTC IATA de tres caracteres (`:219-223`). */
export const SABRE_PRICE_PTC_PATTERN = /^[A-Z][0-9A-Z]{2}$/;

/** `binNumber`: **6 a 8** dígitos, no 6 (`:296-300`). Con BIN de 8 dígitos, capturar 6 pierde fee. */
export const SABRE_PRICE_BIN_PATTERN = /^[0-9]{6,8}$/;

/** `subCode` (`:283-290`). `CA` = efectivo, `CK` = cheque; el resto son subcódigos IATA de tarjeta. */
export const SABRE_PRICE_FOP_SUBCODE_PATTERN = /^(?:[A-Z0-9]{3}|CA|CK)$/;

/** Subcódigos que no llevan ningún dato de tarjeta: los únicos que no necesitan interruptor. */
export const SABRE_PRICE_CASH_SUBCODE = 'CA';
export const SABRE_PRICE_CHECK_SUBCODE = 'CK';
export const SABRE_PRICE_CARDLESS_SUBCODES: readonly string[] = Object.freeze([
  SABRE_PRICE_CASH_SUBCODE,
  SABRE_PRICE_CHECK_SUBCODE,
]);

/** `cardType`: dos letras (`:291-295`). */
export const SABRE_PRICE_CARD_TYPE_PATTERN = /^[A-Z]{2}$/;

/** `params.formOfPayment[].id` y su referencia desde `query[].formOfPayment` (`:277-282`, `:201-206`). */
export const SABRE_PRICE_FOP_ID_PATTERN = /^\S{1,64}$/;

/** `unusedTicketNumber`: 13 dígitos sin dígito de control, o 14 con él (`:233-240`). */
export const SABRE_PRICE_UNUSED_TICKET_PATTERN = /^[0-9]{13,14}$/;

/** `params.accountCode` — tarifa corporativa (`:253-257`). */
export const SABRE_PRICE_ACCOUNT_CODE_PATTERN = /^[\w-]{1,30}$/;

/** `payloadAttributes.trxID` (`:152-157`). */
export const SABRE_PRICE_TRX_ID_PATTERN = /^\S{1,100}$/;

/** `CarrierCode` (`:1777-1782`). */
export const SABRE_PRICE_CARRIER_PATTERN = /^(?:[A-Z0-9]{2}|[A-Z]{3})$/;

/** `FrequentFlyer.accountNumber` (`:995-1000`). */
export const SABRE_PRICE_FF_ACCOUNT_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

/**
 * Longitud a partir de la cual una tirada de dígitos deja de ser un identificador y empieza a
 * parecerse a un PAN. El patrón de `cardNumber` de `createBooking` empieza en 12
 * (`booking-management-v1.yml:5314-5318`); se corta en 9 para dejar margen sobre el BIN de 8, que
 * es lo más largo que este endpoint admite legítimamente como dato de tarjeta.
 */
const PAN_LIKE_DIGIT_RUN = /[0-9]{9,}/;

// ---------------------------------------------------------------------------
// Llaves de `Offer.provider.raw` — el contrato de la cadena de identificadores
// ---------------------------------------------------------------------------

/**
 * Llaves con las que los ACL de Sabre transportan los identificadores efímeros dentro de
 * `Offer.provider.raw`.
 *
 * Viven en el **builder** y no en el mapper porque el builder es quien las LEE, y quien lee es
 * quien se rompe si el nombre cambia. `price/response.mapper.ts` las importa de aquí para
 * escribirlas: una sola definición, no dos que se parecen.
 *
 * La cadena es: BFM `fare.offerItemId` → `query[].offerItemId[]` → `offers[].offerItems[].id` →
 * `createBooking.flightOffer.selectedOfferItems[]` (docs/sabre/03 §3.1).
 */
export const SABRE_RAW_KEYS = {
  /** `pricingInformation.fare.offerItemId` del shop — nivel tarifa, 46 de 59 requests de la colección. */
  shopOfferItemIds: 'offerItemIds',
  /** `fare.passengerInfoList[].passengerInfo.offerItemId` — nivel pasajero, el que usan FOP y asientos. */
  shopPassengerOfferItemIds: 'passengerOfferItemIds',
  /** `response.offers[].id` de price: lo que consume `createBooking.flightOffer.offerId`. */
  priceOfferId: 'priceOfferId',
  /** `response.offers[].offerItems[].id`: lo que consume `flightOffer.selectedOfferItems[]`. */
  priceOfferItemIds: 'priceOfferItemIds',
  /** `offerItems[].passengers[].id`: lo que referencia `travelers[].id` en `createBooking`. */
  pricePassengerIds: 'pricePassengerIds',
} as const;

/**
 * Granularidad del `offerItemId` que se manda a price.
 *
 * `fare` es el nivel por defecto (46 de 59 requests de la colección). `passenger` es el nivel que
 * usan **todos** los flujos de forma de pago y **todos** los de asientos (13 de 59), porque es el
 * único que permite precio distinto por pasajero: `ObFee.paxRefs[]`/`offerItemRefs[]` existen para
 * atribuir el fee a ese nivel (`offer-price-ndc-v1.yml:1396-1404`). Ver docs/sabre/03 §3.2.
 */
export type SabreOfferItemGranularity = 'fare' | 'passenger';

/** De qué paso de la cadena salieron los ids que se van a mandar. Va al log estructurado. */
export type SabreOfferItemOrigin = 'price' | 'shop-passenger' | 'shop-fare';

export interface SabreOfferItemIds {
  readonly offerItemIds: readonly string[];
  readonly origin: SabreOfferItemOrigin;
}

/**
 * Entrada fuera de contrato detectada **antes** de salir al cable. No es fallo del proveedor: es
 * bug nuestro, así que no cuenta para el circuit breaker ni se reintenta.
 *
 * El mensaje nombra el campo y, como mucho, una longitud. **Nunca el valor**: por aquí pasan BIN,
 * número de billete y número de socio frecuente.
 */
export class SabrePriceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabrePriceRequestError';
  }
}

// ---------------------------------------------------------------------------
// Entrada del builder — Zod en el borde (CLAUDE.md)
// ---------------------------------------------------------------------------

const OfferItemIdSchema = z.string().regex(SABRE_PRICE_OFFER_ITEM_ID_PATTERN);
const PassengerIdSchema = z.string().regex(SABRE_PRICE_PASSENGER_ID_PATTERN);

const FrequentFlyerInputSchema = z.object({
  airline: z.string().regex(SABRE_PRICE_CARRIER_PATTERN),
  accountNumber: z.string().regex(SABRE_PRICE_FF_ACCOUNT_PATTERN),
});

const PassengerInputSchema = z.object({
  id: PassengerIdSchema,
  type: z.string().regex(SABRE_PRICE_PTC_PATTERN).optional(),
  frequentFlyer: z.array(FrequentFlyerInputSchema).min(1).optional(),
  unusedTicketNumber: z.string().regex(SABRE_PRICE_UNUSED_TICKET_PATTERN).optional(),
});

const FormOfPaymentInputSchema = z.object({
  subCode: z.string().regex(SABRE_PRICE_FOP_SUBCODE_PATTERN),
  cardType: z.string().regex(SABRE_PRICE_CARD_TYPE_PATTERN).optional(),
  binNumber: z.string().regex(SABRE_PRICE_BIN_PATTERN).optional(),
  id: z.string().regex(SABRE_PRICE_FOP_ID_PATTERN).optional(),
});

const QueryInputSchema = z.object({
  offerItemIds: z.array(OfferItemIdSchema).min(1),
  passengerIds: z.array(PassengerIdSchema).min(1).optional(),
  formOfPaymentRef: z.string().regex(SABRE_PRICE_FOP_ID_PATTERN).optional(),
});

/**
 * `customQualifiers` es `additionalProperties: true` (`:258-264`): el único agujero abierto de un
 * `params` por lo demás cerrado. Se acota a valores de texto corto **sin tiradas largas de
 * dígitos**, porque un objeto libre que viaja al proveedor es exactamente por donde se cuela un
 * PAN "temporalmente, para probar".
 */
const CustomQualifierValueSchema = z.union([
  z.string().max(64),
  z.array(z.string().max(64)).min(1).max(20),
]);

const PriceInputSchema = z.object({
  query: z.array(QueryInputSchema).min(1),
  passengers: z.array(PassengerInputSchema).min(1).max(SABRE_PRICE_MAX_PASSENGERS).optional(),
  accountCode: z.string().regex(SABRE_PRICE_ACCOUNT_CODE_PATTERN).optional(),
  allowBundles: z.boolean().optional(),
  customQualifiers: z.record(CustomQualifierValueSchema).optional(),
  formOfPayment: FormOfPaymentInputSchema.optional(),
});

export type SabrePriceInput = z.input<typeof PriceInputSchema>;
export type SabrePriceQueryInput = z.input<typeof QueryInputSchema>;
export type SabrePricePassengerInput = z.input<typeof PassengerInputSchema>;
export type SabrePriceFormOfPaymentInput = z.input<typeof FormOfPaymentInputSchema>;

export interface SabrePriceBuildOptions {
  /**
   * `payloadAttributes.trxID` (`:152-157`). Correlación con nuestro trace id. Se omite si no se
   * pasa: el contrato no lo exige y un id inventado no correla con nada.
   */
  readonly trxId?: string;
  /**
   * Interruptor de tarificación con BIN de tarjeta (D1). **Apagado por defecto y por tenant.**
   * Con él apagado, un `formOfPayment` con `binNumber` o `cardType` es un error duro, no un aviso:
   * un dato de tarjeta que se cuela "sólo esta vez" es el que acaba en un log.
   */
  readonly allowCardBinPricing?: boolean;
}

// ---------------------------------------------------------------------------
// Forma del cable
// ---------------------------------------------------------------------------

export interface SabrePriceWireQuery {
  offerItemId: string[];
  passengerId?: string[];
  formOfPayment?: string;
}

export interface SabrePriceWireFrequentFlyer {
  airline: string;
  accountNumber: string;
}

export interface SabrePriceWirePassenger {
  id: string;
  type?: string;
  frequentFlyer?: SabrePriceWireFrequentFlyer[];
  unusedTicketNumber?: string;
}

export interface SabrePriceWireFormOfPayment {
  subCode: string;
  id?: string;
  cardType?: string;
  binNumber?: string;
}

export interface SabrePriceWireParams {
  formOfPayment?: SabrePriceWireFormOfPayment[];
  accountCode?: string;
  customQualifiers?: Record<string, string | string[]>;
  allowBundles?: boolean;
}

export interface SabrePriceRequest {
  payloadAttributes?: { trxID: string };
  query: SabrePriceWireQuery[];
  passengers?: SabrePriceWirePassenger[];
  params?: SabrePriceWireParams;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildSabrePriceRequest(
  input: SabrePriceInput,
  options: SabrePriceBuildOptions = {},
): SabrePriceRequest {
  const parsed = parseInput(input);
  const request: SabrePriceRequest = { query: parsed.query.map(buildQuery) };

  const trxId = options.trxId;
  if (trxId !== undefined) {
    if (!SABRE_PRICE_TRX_ID_PATTERN.test(trxId)) {
      throw new SabrePriceRequestError(
        `trxId fuera de contrato: hasta 100 caracteres sin espacios, y llegaron ${String(trxId.length)}`,
      );
    }
    assertNoPanLikeDigits(trxId, 'trxId');
    request.payloadAttributes = { trxID: trxId };
  }

  if (parsed.passengers !== undefined) {
    request.passengers = parsed.passengers.map(buildPassenger);
  }

  const params = buildParams(parsed, options);
  if (params !== null) request.params = params;

  return request;
}

function parseInput(input: SabrePriceInput): z.infer<typeof PriceInputSchema> {
  const parsed = PriceInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  // Rutas y códigos de issue, jamás valores: por este esquema pasan BIN y número de billete.
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
    .join(', ');
  throw new SabrePriceRequestError(`entrada de offers/price inválida (${detail})`);
}

function buildQuery(query: z.infer<typeof QueryInputSchema>): SabrePriceWireQuery {
  const wire: SabrePriceWireQuery = { offerItemId: [...query.offerItemIds] };
  if (query.passengerIds !== undefined) wire.passengerId = [...query.passengerIds];
  if (query.formOfPaymentRef !== undefined) wire.formOfPayment = query.formOfPaymentRef;
  return wire;
}

function buildPassenger(passenger: z.infer<typeof PassengerInputSchema>): SabrePriceWirePassenger {
  const wire: SabrePriceWirePassenger = { id: passenger.id };
  if (passenger.type !== undefined) wire.type = passenger.type;
  if (passenger.frequentFlyer !== undefined) {
    // Sólo los dos campos obligatorios del bloque. `signInID` y el resto son enriquecimiento de
    // respuesta y credenciales del pasajero: no tienen nada que hacer en un request de precio.
    wire.frequentFlyer = passenger.frequentFlyer.map((ff) => ({
      airline: ff.airline,
      accountNumber: ff.accountNumber,
    }));
  }
  if (passenger.unusedTicketNumber !== undefined) {
    wire.unusedTicketNumber = passenger.unusedTicketNumber;
  }
  return wire;
}

/**
 * `params` se omite entero si no hay nada que poner: el ejemplo oficial más común no lo lleva
 * (`:2059-2078`) y un objeto vacío es ruido que alguien acabará rellenando "porque estaba".
 */
function buildParams(
  parsed: z.infer<typeof PriceInputSchema>,
  options: SabrePriceBuildOptions,
): SabrePriceWireParams | null {
  const params: SabrePriceWireParams = {};
  let present = false;

  if (parsed.formOfPayment !== undefined) {
    params.formOfPayment = [buildFormOfPayment(parsed.formOfPayment, options)];
    present = true;
  }
  if (parsed.accountCode !== undefined) {
    assertNoPanLikeDigits(parsed.accountCode, 'accountCode');
    params.accountCode = parsed.accountCode;
    present = true;
  }
  if (parsed.customQualifiers !== undefined) {
    params.customQualifiers = buildCustomQualifiers(parsed.customQualifiers);
    present = true;
  }
  if (parsed.allowBundles !== undefined) {
    params.allowBundles = parsed.allowBundles;
    present = true;
  }

  return present ? params : null;
}

/**
 * La compuerta de D1 en una sola función.
 *
 * `CA`/`CK` no llevan dato de tarjeta y pasan siempre. Cualquier subcódigo de tarjeta —o un
 * `cardType`, o un `binNumber`— exige `allowCardBinPricing`. Y el BIN se vuelve a comprobar contra
 * el patrón exacto **aquí**, no sólo en el esquema: es la última función por la que pasa antes de
 * serializarse, y es donde hay que poder demostrar que un PAN no cabe.
 */
function buildFormOfPayment(
  fop: z.infer<typeof FormOfPaymentInputSchema>,
  options: SabrePriceBuildOptions,
): SabrePriceWireFormOfPayment {
  const carriesCardData =
    fop.binNumber !== undefined ||
    fop.cardType !== undefined ||
    !SABRE_PRICE_CARDLESS_SUBCODES.includes(fop.subCode);

  if (carriesCardData && options.allowCardBinPricing !== true) {
    throw new SabrePriceRequestError(
      'tarificar con datos de tarjeta exige allowCardBinPricing (D1): sin el interruptor sólo se ' +
        `admiten los subcódigos sin tarjeta ${SABRE_PRICE_CARDLESS_SUBCODES.join('/')}`,
    );
  }

  const wire: SabrePriceWireFormOfPayment = { subCode: fop.subCode };
  if (fop.id !== undefined) wire.id = fop.id;
  if (fop.cardType !== undefined) wire.cardType = fop.cardType;
  if (fop.binNumber !== undefined) {
    if (!SABRE_PRICE_BIN_PATTERN.test(fop.binNumber)) {
      throw new SabrePriceRequestError(
        `binNumber fuera de contrato: 6 a 8 dígitos, y llegaron ${String(fop.binNumber.length)} caracteres`,
      );
    }
    wire.binNumber = fop.binNumber;
  }
  return wire;
}

function buildCustomQualifiers(
  qualifiers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(qualifiers)) {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) assertNoPanLikeDigits(entry, `customQualifiers.${key}`);
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/**
 * El guardia anti-PAN. **No es una regla global del request**: se aplica exactamente a los tres
 * campos de texto que rellena quien llama —`trxId`, `params.accountCode` y los valores de
 * `params.customQualifiers`—, que son los únicos por los que un humano puede meter lo que quiera.
 *
 * Los demás campos se defienden con su patrón exacto de contrato: `binNumber` con 6-8 dígitos,
 * `offerItemId` y `passengerId` con la forma que emite el propio Sabre. Y **no** se aplica a
 * `unusedTicketNumber`: un número de billete son legítimamente 13-14 dígitos (`:233-240`) y no hay
 * forma de distinguirlo de un PAN por su forma —el dígito de control del billete es mod-7, no
 * Luhn—, así que ahí la defensa es el patrón del contrato y la regla de no loguearlo nunca.
 * Rechazar por sospecha bloquearía una de cada diez reemisiones legítimas.
 */
function assertNoPanLikeDigits(value: string, field: string): void {
  if (PAN_LIKE_DIGIT_RUN.test(value)) {
    throw new SabrePriceRequestError(
      `${field} contiene una tirada de 9 o más dígitos seguidos; en un request de precio no hay ` +
        'ningún campo que la necesite y sí uno que la prohíbe (D1)',
    );
  }
}

// ---------------------------------------------------------------------------
// Lectura de la cadena de identificadores desde el `Offer` canónico
// ---------------------------------------------------------------------------

/**
 * Saca de una `Offer` los `offerItemId` con los que revalidarla.
 *
 * **Nunca inventa un id.** Es la lección explícita de docs/sabre/03 §3.6: el ACL de LATAM tiene un
 * fallback que fabrica `` `${ref}-ITEM1` `` cuando no encuentra los ids, y eso no arregla nada —
 * enmascara el bug hasta que el proveedor devuelve un error de oferta desconocida en el paso de
 * reserva, con el cliente delante. Aquí la ausencia lanza.
 *
 * Precedencia: si la oferta YA pasó por price (`priceOfferItemIds`), esos son los ids vigentes y
 * son los que se re-mandan — es exactamente lo que Sabre indica hacer cuando una oferta vence
 * (_"Use offers/price to reprice the offer"_,
 * `help/booking-management-api-v1/help-documentation-create-booking-error-list.txt:690-694`).
 * Si no, se usan los del shop, al nivel que pida {@link SabreOfferItemGranularity}.
 */
export function readSabreOfferItemIds(
  offer: Offer,
  granularity: SabreOfferItemGranularity = 'fare',
): SabreOfferItemIds {
  if (offer.provider.name !== SABRE_PROVIDER_NAME) {
    throw new SabrePriceRequestError(
      `la oferta es del proveedor "${offer.provider.name}" y offers/price sólo revalida ofertas de ` +
        `"${SABRE_PROVIDER_NAME}"`,
    );
  }

  const raw = offer.provider.raw ?? {};
  const priced = readIdList(raw, SABRE_RAW_KEYS.priceOfferItemIds);
  if (priced !== null) return { offerItemIds: priced, origin: 'price' };

  if (granularity === 'passenger') {
    const perPassenger = readIdList(raw, SABRE_RAW_KEYS.shopPassengerOfferItemIds);
    if (perPassenger !== null) return { offerItemIds: perPassenger, origin: 'shop-passenger' };
    throw new SabrePriceRequestError(
      `la oferta no transporta ${SABRE_RAW_KEYS.shopPassengerOfferItemIds} en provider.raw: el ` +
        'nivel por pasajero no se puede derivar del nivel tarifa, hay que guardarlo en el shop',
    );
  }

  const perFare = readIdList(raw, SABRE_RAW_KEYS.shopOfferItemIds);
  if (perFare !== null) return { offerItemIds: perFare, origin: 'shop-fare' };

  throw new SabrePriceRequestError(
    `la oferta no transporta ${SABRE_RAW_KEYS.shopOfferItemIds} ni ` +
      `${SABRE_RAW_KEYS.priceOfferItemIds} en provider.raw: sin id reservable no hay nada que ` +
      'revalidar (el contenido ATPCO no pasa por offers/price)',
  );
}

/**
 * Lista de ids del `raw`, validada contra el patrón del contrato. Una lista presente pero con un
 * elemento inválido **lanza** en vez de filtrarlo: mandar 2 de 3 items tarifica media oferta y
 * devuelve un precio que no es el de nada que se pueda vender.
 */
function readIdList(raw: Readonly<Record<string, unknown>>, key: string): readonly string[] | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new SabrePriceRequestError(`provider.raw.${key} tiene que ser un array no vacío`);
  }
  const ids: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry: unknown = value[i];
    if (typeof entry !== 'string' || !SABRE_PRICE_OFFER_ITEM_ID_PATTERN.test(entry)) {
      throw new SabrePriceRequestError(
        `provider.raw.${key}[${String(i)}] no cumple el patrón de offerItemId del contrato`,
      );
    }
    ids.push(entry);
  }
  return ids;
}

/*
 * Aquí vivía `buildSabrePriceRequestForOffer(offer, options)`, un atajo de un paso que hacía
 * `readSabreOfferItemIds` + `buildSabrePriceRequest`. Se borró en la ronda 13 y NO se debe
 * reintroducir; el motivo, para que nadie lo escriba otra vez pensando que ahorra dos líneas:
 *
 *  1. **Ningún fichero de producción lo llamaba, y el único que podría, no puede.** El camino real
 *     es `SabreOfferPriceAdapter.priceQuote`, que tiene que meter `formOfPayment` en el request
 *     —lo resuelve antes contra la política del tenant— y el atajo construía siempre
 *     `{ query: [{ offerItemId }] }` a secas. Para el flujo que existe producía un request
 *     DISTINTO e incompleto: dos formas de armar la misma llamada, con una de ellas equivocada.
 *  2. **Publicaba el interruptor de D1 como booleano suelto.** Heredaba `SabrePriceBuildOptions`,
 *     así que exponía `allowCardBinPricing` en la superficie del paquete sin pasar por
 *     `SabreCardBinPricingPolicy` —que existe precisamente porque «un parámetro que compila
 *     cuando se le pasa `true` es un interruptor que alguien pone a `true` para salir del paso»—
 *     y encima inerte, porque sin `formOfPayment` no había dato de tarjeta que autorizar.
 *  3. **No entregaba nada exclusivo.** El `origin` que devolvía para el `domain_event` lo da
 *     `readSabreOfferItemIds`, y el adapter ya lo loguea y lo publica en `SabrePricedQuote.origin`.
 *
 * Quien necesite «de una oferta a una cotización» llama al adapter, que es la puerta pública del
 * caso de uso; quien necesite sólo el request llama a las dos funciones de arriba, como el adapter.
 */
