import { z } from 'zod';
import type { SabreConfig } from '../config';
import {
  SABRE_FORMS_OF_PAYMENT_MAX_ITEMS,
  sabreIndexAtMost,
  sabreIndexIn,
  type SabreIndex,
} from '../indices';
import {
  describeMissingAirlineRequirements,
  findMissingAirlineRequirements,
  hasBlockingAirlineRequirements,
  type MissingAirlineRequirement,
} from './airline-requirements';

/**
 * Constructor de `CreateBookingRequest` para `POST /v1/trip/orders/createBooking` (RF-08).
 *
 * Es el fichero que **crea reservas**: lo que sale de aquí compromete inventario y, un paso
 * después, dinero. Cada campo está verificado contra
 * `docs/sabre/evidence/specs/booking-management-v1.yml` (Booking Management v1.33) con su línea, y
 * la tabla campo por campo vive en `docs/sabre/04-create-booking.md` §3.
 *
 * ## Las tres decisiones que gobiernan este archivo
 *
 * **1. Sin PAN, por tipo, no por disciplina (D1).** `SabreFormOfPayment` es una unión discriminada
 * en la que **ninguna variante declara `cardNumber`, `cardSecurityCode`, `cardTypeCode`,
 * `expiryDate`, `cardHolder`, `authentications` ni `virtualCard`**: los declara como `?: never`,
 * así que asignarles un valor **no compila** —da igual si viene de un literal o de una variable de
 * un tipo más ancho—. `PAYMENTCARD` no está en la unión: no es que se filtre en tiempo de
 * ejecución, es que **no se puede nombrar**. El día que el founder encienda el flag SAQ-D, el tipo
 * de tarjeta será otro y vivirá en otro archivo; este builder seguirá sin poder emitirlo.
 * Además el body se construye por **lista blanca** —campo a campo, nunca copiando el objeto de
 * entrada—, y los schemas de forma de pago son `.strict()`: una clave de más es un error ruidoso,
 * no un descarte silencioso. Ver `docs/sabre/04` §7.6 y `CLAUDE.md` (PCI SAQ-A).
 *
 * **2. `errorHandlingPolicy` SIEMPRE explícito.** El contrato lo declara opcional con default
 * `HALT_ON_ERROR` (`:698-702`, enum en `:8918-8940`), pero el éxito parcial **es un modo que el
 * cliente elige antes de llamar**, no una anomalía a detectar después. Lo mandamos siempre, y la
 * política aplicada vuelve en el plan para que el `domain_event` la registre (RNF-08).
 *
 * **3. `asynchronousUpdateWaitTime` SIEMPRE explícito y nunca 0.** El default del contrato es `0`
 * (`:714-722`) y con `0` **la respuesta puede llegar antes de que la reserva esté completa**: una
 * reserva que crees creada y no lo está. Aquí el mínimo es 1 ms y el default 3.000 ms.
 *
 * ## Lo que este archivo NO hace
 *
 * No toca la red (eso es `SabreHttpClient.postJson`), no decide reintentos —`createBooking` está en
 * `SABRE_NON_IDEMPOTENT_PATHS`, cero reintentos siempre— y no mapea la respuesta (eso es
 * `create.response.mapper.ts`). Tampoco construye hotel, coche, perfiles, ancillaries, remarks ni
 * notificaciones: RF-08 es el carril aéreo, y cada bloque que se añada sin caso de uso es
 * superficie que nadie prueba.
 *
 * ## PII
 *
 * El body lleva nombres, fechas de nacimiento, pasaportes, correos y teléfonos. **Ningún mensaje de
 * error de este archivo contiene un valor del payload**: los errores de forma nombran la ruta del
 * campo y el código de la incidencia de Zod, y los de requisito por aerolínea vienen ya sin valores
 * de `describeMissingAirlineRequirements`. Fijado con tests que buscan cada valor del payload
 * dentro del mensaje.
 */

/** Ruta de la operación: `basePath: /v1/trip/orders` (`:15`) + `/createBooking` (`:190-192`). */
export const SABRE_CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';

// ---------------------------------------------------------------------------------------------
// Enums del contrato. Se copian completos y en el orden del spec: media lista es peor que ninguna.
// ---------------------------------------------------------------------------------------------

/** `CreateErrorPolicyEnum` — `booking-management-v1.yml:8918-8940`, 8 valores, default el primero. */
export const SABRE_CREATE_ERROR_POLICIES = [
  'HALT_ON_ERROR',
  'DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR',
  'DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR',
  'DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR',
  'DO_NOT_HALT_ON_SEAT_BOOKING_ERROR',
  'HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR',
  'DO_NOT_HALT_ON_CAR_BOOKING_ERROR',
  'DO_NOT_HALT_ON_IDENTITY_DOCUMENT_WARNING',
] as const;

export type SabreCreateErrorPolicy = (typeof SABRE_CREATE_ERROR_POLICIES)[number];

/** El default del contrato (`:8920`) y el nuestro: un vuelo a medias no es vendible. */
export const SABRE_DEFAULT_ERROR_POLICY: SabreCreateErrorPolicy = 'HALT_ON_ERROR';

/**
 * Dominios de producto en los que el llamador acepta seguir adelante pese a un fallo. Es el
 * vocabulario de la tolerancia a fallo parcial (docs/sabre/04 §5.4); la traducción al enum de Sabre
 * vive en {@link SABRE_ERROR_POLICY_BY_TOLERANCE} y **sólo** ahí.
 *
 * La lista es exactamente la de los dominios cuyo bloque **este builder sabe construir**: sólo se
 * puede tolerar el fallo de algo que se llegó a pedir.
 *
 *  - `SEAT` — `flights[].seats[]` (ATPCO) y `flightOffer.seatOffers[]` (NDC).
 *  - `ANCILLARY` — los `selectedOfferItems[]` de NDC pueden ser ancillaries: `offers/price`
 *    devuelve `offerItems[]` como un `oneOf` y `ServiceOfferItem` (`type: "Service"`) es un
 *    ancillary dentro de esa respuesta (docs/sabre/03 §2.5, `offer-price-ndc-v1.yml:556-598`).
 *  - `PRICING` — `flightDetails.flightPricing[]`.
 *  - `IDENTITY_DOC_WARNING` — `travelers[].identityDocuments[]`.
 *
 * `HOTEL` y `CAR` estaban aquí y **se han quitado**: ver
 * {@link SABRE_UNBUILDABLE_PARTIAL_FAILURE_DOMAINS}.
 */
export const SABRE_PARTIAL_FAILURE_DOMAINS = [
  'PRICING',
  'ANCILLARY',
  'SEAT',
  'IDENTITY_DOC_WARNING',
] as const;

export type SabrePartialFailureDomain = (typeof SABRE_PARTIAL_FAILURE_DOMAINS)[number];

/**
 * Los dominios del enum del contrato que **este builder no puede provocar**, y por eso no se
 * ofrecen.
 *
 * `buildProduct` emite `flightOffer` o `flightDetails` y nada más —RF-08 es el carril aéreo, y la
 * cabecera de este archivo ya dice que hotel y coche no se construyen aquí—. Un
 * `DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR` en un body sin bloque `hotel` viaja al cable declarando
 * tolerancia a un fallo que no puede ocurrir: aceptado y sin efecto, que es la peor clase de
 * opción porque parece que hace algo.
 *
 * La constante existe por la misma razón que {@link SABRE_FULFILL_ONLY_FORM_OF_PAYMENT_TYPES}: para
 * que nadie los vuelva a añadir «porque están en el enum del contrato». Vuelven el día que el
 * builder construya `hotel`/`car`, no antes. Hay un test que fija la ausencia.
 */
export const SABRE_UNBUILDABLE_PARTIAL_FAILURE_DOMAINS = ['HOTEL', 'CAR'] as const;

/**
 * Tolerancia de dominio → política del contrato.
 *
 * ⚠️ `PRICING` mapea a `DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR`, que **deja el PNR sin price quote**:
 * el billete puede acabar emitiéndose a otra tarifa (docs/sabre/04 §5.1). No se activa por
 * comodidad; se activa con una razón escrita, y queda en el `domain_event`.
 */
export const SABRE_ERROR_POLICY_BY_TOLERANCE = {
  PRICING: 'DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR',
  ANCILLARY: 'DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR',
  SEAT: 'DO_NOT_HALT_ON_SEAT_BOOKING_ERROR',
  IDENTITY_DOC_WARNING: 'DO_NOT_HALT_ON_IDENTITY_DOCUMENT_WARNING',
} as const satisfies Record<SabrePartialFailureDomain, SabreCreateErrorPolicy>;

/** `TitleEnum` — `:9398-9420`. Enum CERRADO de 18 valores; `Congressman` es legítimo. */
export const SABRE_TITLES = [
  'Mr',
  'Mrs',
  'Ms',
  'Dr',
  'Miss',
  'Mstr',
  'Mlle',
  'Sir',
  'Father',
  'Sister',
  'Brother',
  'Reverend',
  'Lt',
  'Capt',
  'Congressman',
  'Duke',
  'Duchess',
  'Prof',
] as const;

export type SabreTitle = (typeof SABRE_TITLES)[number];

/** `GenderEnum` — `:9001-9012`. Seis valores: los dos de infante los exige Secure Flight. */
export const SABRE_GENDERS = [
  'FEMALE',
  'MALE',
  'INFANT_FEMALE',
  'INFANT_MALE',
  'UNDISCLOSED',
  'UNDEFINED',
] as const;

export type SabreGender = (typeof SABRE_GENDERS)[number];

/** `DocumentTypeEnum` — `:8979-8998`. 17 valores. */
export const SABRE_DOCUMENT_TYPES = [
  'PASSPORT',
  'VISA',
  'SECURE_FLIGHT_PASSENGER_DATA',
  'RESIDENCE_ADDRESS',
  'DESTINATION_ADDRESS',
  'KNOWN_TRAVELER_NUMBER',
  'REDRESS_NUMBER',
  'ALIEN_RESIDENT',
  'PERMANENT_RESIDENT',
  'FACILITATION_DOCUMENT',
  'NATIONAL_ID_CARD',
  'NEXUS_CARD',
  'MILITARY',
  'NATURALIZATION_CERTIFICATE',
  'REFUGEE_REENTRY_PERMIT',
  'BORDER_CROSSING_CARD',
  'FISCAL_ID',
] as const;

export type SabreDocumentType = (typeof SABRE_DOCUMENT_TYPES)[number];

/**
 * `DocumentSubTypeEnum` — `:9320-9330`. Tres valores, y el contrato los ata a países concretos:
 * `RUC` (Ecuador), `CUIT/CUIL` (Argentina), `NIT` (**Bolivia**).
 *
 * ⚠️ **RF-21 (ID fiscal CO/PE/BR) NO queda cubierto por este enum.** No hay `CPF` ni `CNPJ`
 * brasileños; el `NIT` documentado es boliviano, no colombiano; y el `RUC` documentado es
 * ecuatoriano, aunque Perú también use esa sigla. Es un **hueco de contrato, no de código**: hay
 * que resolverlo contra CERT antes de prometer facturación fiscal por Sabre (docs/sabre/04
 * §3.4.2.1). El valor lleva **barra**, `CUIT/CUIL`, no `CUIT-CUIL` como escribe docs/sabre/04 §4.
 */
export const SABRE_DOCUMENT_SUBTYPES = ['RUC', 'CUIT/CUIL', 'NIT'] as const;

export type SabreDocumentSubType = (typeof SABRE_DOCUMENT_SUBTYPES)[number];

/** `ProgramTypeEnum` — `:8968-8978`, default `FREQUENT_FLYER`. */
export const SABRE_PROGRAM_TYPES = [
  'FREQUENT_FLYER',
  'FREQUENT_RENTER',
  'LOYALTY_ID',
  'CORPORATE_LOYALTY_ID',
] as const;

export type SabreProgramType = (typeof SABRE_PROGRAM_TYPES)[number];

/** `TicketingPolicyEnum` — `:8977-8986` (4 valores, no 2). */
export const SABRE_TICKETING_POLICIES = [
  'TODAY',
  'ALREADY_TICKETED',
  'FUTURE_TICKETING',
  'TICKETING_TIME_LIMIT',
] as const;

export type SabreTicketingPolicy = (typeof SABRE_TICKETING_POLICIES)[number];

/** `FlightToBookSourceEnum` — `:8858-8866`, default `ATPCO`. */
export const SABRE_FLIGHT_SOURCES = ['ATPCO', 'LCC'] as const;

export type SabreFlightSource = (typeof SABRE_FLIGHT_SOURCES)[number];

/**
 * `HaltOnFlightStatusCodeEnum` — `:8777-8790`, 8 valores.
 *
 * ⚠️ Mandar la lista **sustituye** el default, no lo amplía: si no se manda nada, Sabre aborta ante
 * `NO`, `UC`, `US`, `UN`, `UU`, `LL`, `HL` (`:5004-5010`). Mandar `['NN']` significa "aborta con
 * _need_ pero **acepta** `UC`", que es lo contrario de lo que suena (docs/sabre/04 §5.2).
 */
export const SABRE_HALT_ON_FLIGHT_STATUS_CODES = [
  'NO',
  'NN',
  'UC',
  'US',
  'UN',
  'UU',
  'LL',
  'HL',
] as const;

export type SabreHaltOnFlightStatusCode = (typeof SABRE_HALT_ON_FLIGHT_STATUS_CODES)[number];

/** `ComparisonTypeEnum` — `:8757-8768`. Freno de precio de `priceComparisons[]`. */
export const SABRE_PRICE_COMPARISON_TYPES = [
  'INCREASE_BY_AMOUNT',
  'INCREASE_BY_PERCENT',
  'DECREASE_BY_AMOUNT',
  'DECREASE_BY_PERCENT',
] as const;

export type SabrePriceComparisonType = (typeof SABRE_PRICE_COMPARISON_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Formas de pago: el carril sin PAN, y sólo ése
// ---------------------------------------------------------------------------------------------

/**
 * Los valores de `FormOfPaymentTypeEnum` (`:8792-8813`) que **no llevan ni un dato de tarjeta** y
 * que este builder puede emitir.
 *
 * Fuera quedan, a propósito:
 *   - `PAYMENTCARD`: D1 lo prohíbe salvo detrás de un flag apagado por defecto y por tenant.
 *   - `VIRTUAL_CARD`, `AGENCY_NAME`, `AGENCY_IATA`, `CORPORATE`, `COMPANY_NAME`: el propio enum
 *     dice que son «used for **hotel** bookings» (`:8795-8797`), y ninguno existe en
 *     `FulfillFormOfPaymentTypeEnum` (`:8659-8674`) — es decir, **con ellos no se puede emitir el
 *     billete**. Ver docs/sabre/04 §7.7.
 *   - `VOUCHER`: «used for vehicle booking» (`:8798`).
 */
export const SABRE_PANLESS_FORM_OF_PAYMENT_TYPES = [
  'CASH',
  'CHECK',
  'MISCELLANEOUS',
  'INSTALLMENTS',
  'DOCKET',
  'GOVERNMENT_TRAVEL_REQUEST',
  'INVOICE',
] as const;

export type SabrePanlessFormOfPaymentType = (typeof SABRE_PANLESS_FORM_OF_PAYMENT_TYPES)[number];

/**
 * `ON_ACCOUNT` — el «facturar a la agencia» del modelo consolidador— **no existe en
 * `createBooking`**.
 *
 * Está en `FulfillFormOfPaymentTypeEnum` (`:8674`) y **no** en `FormOfPaymentTypeEnum`
 * (`:8792-8813`). D1 lo nombra junto a `CASH` e `INVOICE`; en el paso de RESERVA sólo dos de los
 * tres son legales, y el tercero llega en la emisión. La constante existe para que nadie lo añada
 * a la lista de arriba "porque estaba en la decisión", y hay un test que fija la ausencia.
 */
export const SABRE_FULFILL_ONLY_FORM_OF_PAYMENT_TYPES = ['ON_ACCOUNT'] as const;

/**
 * El tipo de tarjeta, nombrado UNA vez y sólo para poder afirmar que no lo emitimos. No es
 * miembro de {@link SabreFormOfPayment} y ninguna función de este archivo lo produce.
 */
export const SABRE_CARD_FORM_OF_PAYMENT_TYPE = 'PAYMENTCARD';

/**
 * La barrera de compilación de D1.
 *
 * Los siete campos de tarjeta de `BasicFormOfPayment` (`:5305-5356`) y `GenericFormOfPayment`
 * (`:5398-5490`) se declaran aquí como `?: never`. Consecuencia: `{ type: 'CASH', cardNumber: x }`
 * **no compila** para ningún `x` que no sea `undefined`, ni como literal ni asignando desde una
 * variable de un tipo más ancho. Borrar estas líneas no "simplifica el tipo": desarma la defensa.
 */
interface SabreFormOfPaymentPanFree {
  readonly cardNumber?: never;
  readonly cardSecurityCode?: never;
  readonly cardTypeCode?: never;
  readonly expiryDate?: never;
  readonly cardHolder?: never;
  readonly authentications?: never;
  readonly virtualCard?: never;
}

/** «Esta venta se liquida fuera del canal Sabre» — docs/sabre/04 §7.6. Sin campos propios. */
export interface SabreCashFormOfPayment extends SabreFormOfPaymentPanFree {
  readonly type: 'CASH';
}

export interface SabreCheckFormOfPayment extends SabreFormOfPaymentPanFree {
  readonly type: 'CHECK';
}

/** «Must be activated on the agency level; requires a specific payment credit code» (`:8794`). */
export interface SabreMiscellaneousFormOfPayment extends SabreFormOfPaymentPanFree {
  readonly type: 'MISCELLANEOUS';
  /** `:5336`, 2–18 caracteres. */
  readonly miscellaneousCreditCode: string;
  /** `:5329`, 1–96 meses. */
  readonly extendedPayment?: number;
}

/** «BSP Brazil customers only» — el _parcelado_ (`:8794`). Relevante para BR. */
export interface SabreInstallmentsFormOfPayment extends SabreFormOfPaymentPanFree {
  readonly type: 'INSTALLMENTS';
  /** `:5343`, 1–96. */
  readonly numberOfInstallments: number;
  /** `:5350`. */
  readonly airlinePlanCode?: string;
  /** `:5353`, `^[0-9]+$`. */
  readonly installmentAmount?: string;
  /** `:5443`, `^[0-9]+(\.[0-9]{1,3})?$`. */
  readonly netBalance?: string;
}

export interface SabreDocketFormOfPayment extends SabreFormOfPaymentPanFree {
  readonly type: 'DOCKET';
  /** `:5448`, `^D$|^AGT\*V$`. */
  readonly docketPrefix?: string;
  /** `:5453`, `^[0-9]{6}$`. */
  readonly docketNumber?: string;
  readonly docketIssuingAgentInitials?: string;
  readonly docketDescription?: string;
}

export interface SabreGovernmentTravelRequestFormOfPayment extends SabreFormOfPaymentPanFree {
  readonly type: 'GOVERNMENT_TRAVEL_REQUEST';
  /** `:5467`. */
  readonly governmentTravelRequestDescription?: string;
}

export interface SabreInvoiceFormOfPayment extends SabreFormOfPaymentPanFree {
  readonly type: 'INVOICE';
  /** `:5472`. */
  readonly invoiceDescription?: string;
  /** `:5487`: antepone `INV/` a la descripción. */
  readonly addInvoiceDescriptionPrefix?: boolean;
}

/**
 * Forma de pago del cable. **No tiene variante de tarjeta y no puede tenerla** (D1).
 *
 * `Payment.billingAddress` (`:5704`) tampoco existe en {@link SabrePayment}: es la dirección de
 * facturación de una tarjeta, y sin tarjeta no hay nada que facturar por esa vía.
 */
export type SabreFormOfPayment =
  | SabreCashFormOfPayment
  | SabreCheckFormOfPayment
  | SabreMiscellaneousFormOfPayment
  | SabreInstallmentsFormOfPayment
  | SabreDocketFormOfPayment
  | SabreGovernmentTravelRequestFormOfPayment
  | SabreInvoiceFormOfPayment;

/**
 * El default del ACL en el carril aéreo (docs/sabre/04 §7.6): un `createBooking` real de
 * consolidador con `{"type":"CASH"}` y cero datos de tarjeta está VERIFICADO en la colección
 * (`createBooking - Air with pricing Complex`, payload de Wakanow).
 */
export const SABRE_DEFAULT_FORM_OF_PAYMENT: SabreCashFormOfPayment = Object.freeze({
  type: 'CASH',
});

// ---------------------------------------------------------------------------------------------
// Espera asíncrona
// ---------------------------------------------------------------------------------------------

/** `:717` — el contrato admite 0. Se documenta para no volver a "corregir" el mínimo de abajo. */
export const SABRE_ASYNC_UPDATE_WAIT_MS_CONTRACT_MIN = 0;

/** Máximo del contrato (`:718`). */
export const SABRE_ASYNC_UPDATE_WAIT_MS_MAX = 10_000;

/**
 * Nuestro mínimo es 1, no 0: con `0` la respuesta puede llegar **antes de que la reserva esté
 * completa** (`:719-722`, «Mainly used for the redisplay operation of NDC bookings»). Una reserva
 * que crees creada y no lo está es el peor estado posible de este endpoint.
 */
export const SABRE_ASYNC_UPDATE_WAIT_MS_MIN = 1;

/** El `example` del propio contrato (`:719`) y el valor medio de los 28 usos de la colección. */
export const SABRE_ASYNC_UPDATE_WAIT_MS_DEFAULT = 3_000;

// ---------------------------------------------------------------------------------------------
// Topes del contrato
// ---------------------------------------------------------------------------------------------

/** `:4970` — techo duro de offer items por orden NDC. Un grupo grande obliga a partir la reserva. */
export const SABRE_SELECTED_OFFER_ITEMS_MAX = 9;
/** `:4990` — 16 segmentos por PNR. */
export const SABRE_FLIGHTS_MAX = 16;
/** `:4998` — 10 instrucciones de pricing (el gancho del pricing waterfall). */
export const SABRE_FLIGHT_PRICING_MAX = 10;
/** `:5765` — dos umbrales de comparación de precio como mucho. */
export const SABRE_PRICE_COMPARISONS_MAX = 2;
/** `:723-725` — `profiles` no se construye aquí, pero el tope se documenta con los demás. */
export const SABRE_PROFILES_MAX = 13;

// ---------------------------------------------------------------------------------------------
// Patrones del contrato
// ---------------------------------------------------------------------------------------------

const PCC = /^[A-Z0-9]{3,4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
const AIRLINE_CODE = /^[A-Z0-9]{2}$/;
const AIRPORT_CODE = /^[A-Z]{3}$/;
const BOOKING_CLASS = /^[A-Za-z ]+$/;
const FLIGHT_STATUS_CODE = /^[A-Za-z ]+$/;
const CONFIRMATION_ID = /^[A-Z0-9]{5,}$/;
/** `:6165` — sin espacios al inicio/fin ni dobles. El nombre SÍ admite dígitos. */
const GIVEN_NAME = /^[^\s]+(\s[^\s]+)*$/;
/** `:6170` — ⚠️ el apellido **no admite dígitos**. */
const SURNAME = /^[^\d\s]+( [^\d\s]+)*$/;
/** `:6192` — no es un enum: `ADT`, `CNN`, `INF`, `INS`, `INY`, `SRC`… todos encajan. */
const PASSENGER_CODE = /^[A-Z][A-Z0-9]{2}$/;
/**
 * `:6197`, el MAN number. NO es el sufijo `-1.1`.
 *
 * Los escapes `\-` y `\/` de éste y de {@link RETENTION_LABEL} son **redundantes en JavaScript** y
 * se conservan igualmente: son los patrones del contrato copiados byte a byte, y quien audite esta
 * línea contra `booking-management-v1.yml` tiene que poder compararlas sin traducir nada.
 */
// eslint-disable-next-line no-useless-escape -- patrón literal del contrato, ver arriba
const NAME_REFERENCE_CODE = /^[a-zA-Z0-9 ,.*\-]{0,29}$/;
/** `:5559` — ⚠️ sin guiones ni espacios; muchos documentos LATAM los llevan y hay que normalizar. */
const DOCUMENT_NUMBER = /^[a-zA-Z0-9]+$/;
/** `:5583`, `:5594`, `:5604`, `:5655` — ISO-2 o ISO-3. */
const COUNTRY_CODE = /^[A-Z]{2,3}$/;
const PHONE = /^[0-9+-]+$/;
/** `:7017` — `H` home, `B` business, `C` cell, `M` mobile. */
const PHONE_LABEL = /^[A-Z]{1}$/;
/** `:4750` — DK number: 6, 7 o 10 caracteres. */
const AGENCY_CUSTOMER_NUMBER = /^[0-9A-Z]{6}([1-9A-Z*]{1}|[0-9A-Z]{4})?$/;
/** `:787` — sin acentos ni ñ. Patrón literal del contrato: ver {@link NAME_REFERENCE_CODE}. */
// eslint-disable-next-line no-useless-escape -- patrón literal del contrato
const RETENTION_LABEL = /^[a-zA-Z0-9 ,.*?\-\/]{0,215}$/;
/**
 * Tirada de dígitos con forma de PAN. Se corta en 9 —igual que la del builder de precio— para dejar
 * margen sobre el BIN de 8, que es lo más largo que un dato de tarjeta puede medir legítimamente en
 * este ACL. El `pattern` de `cardNumber` del contrato empieza en 12 (`:5314`).
 *
 * No se comparte con `price/request.builder.ts` a propósito: **no es una regla global del paquete**
 * sino una decisión por campo, y hoy se aplica a UNO —ver {@link assertRetentionLabelNoPan}—. Un
 * teléfono (`^[0-9+-]+$`), un `documentNumber` o un `confirmationId` llevan tiradas largas
 * legítimas y no se tocan; el resto del texto libre del body (`agency.address.*`,
 * `futureTicketingPolicy.comment`, `invoiceDescription`, `receivedFrom`) sigue admitiéndolas y está
 * inventariado en `pan-egress.guard.test.ts`, no cerrado aquí.
 */
const PAN_LIKE_DIGIT_RUN = /[0-9]{9,}/;
/** `:5293` — ⚠️ no admite columna de letra doble. */
const SEAT_NUMBER = /^[0-9]+[A-Z]$/;
/** `:5688`, `:5789` — importe con hasta 3 decimales. */
const AMOUNT = /^[0-9]+(\.[0-9]{1,3})?$/;
/** `:7689`, `:5796` — porcentaje con hasta 2 decimales. */
const PERCENT = /^[0-9]{1,2}(\.[0-9]{1,2})?$/;
/** `:5314` / `:5319` — los dos patrones de tarjeta, aquí sólo para el guard anti-PAN del test. */
const MISC_CREDIT_CODE_MIN = 2;
const MISC_CREDIT_CODE_MAX = 18;

/**
 * Un error del builder: el body no se llegó a construir, o se construyó y no debe mandarse.
 *
 * No es un fallo del proveedor —no cuenta para el circuit breaker ni se reintenta—: es un dato
 * nuestro que Sabre rechazaría. Vive local a este archivo porque `errors.ts` es la casa de la
 * clasificación de fallos **del proveedor**, y mezclar las dos cosas fue lo que en su día hizo que
 * un bug propio se contara como caída de Sabre.
 */
export class SabreCreateBookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabreCreateBookingError';
  }
}

// ---------------------------------------------------------------------------------------------
// El cable: `CreateBookingRequest` (`:694-802`)
// ---------------------------------------------------------------------------------------------

export interface SabreBookSeatOffer {
  /** `:5280`, 2–49. Obligatorio **de facto**: sin él, `SEATS_OFFER_ID_MISSING`. */
  readonly seatOfferId?: string;
  /** `:5293`. */
  readonly number?: string;
  /** `:5298`, **required**, 1-based. Sólo lo produce `indices.ts`. */
  readonly travelerIndex: SabreIndex;
}

/** `FlightOffer` — `:4952-4981`. `offerId` y `selectedOfferItems` son **required** (`:4956-4957`). */
export interface SabreFlightOffer {
  readonly offerId: string;
  readonly selectedOfferItems: readonly string[];
  readonly seatOffers?: readonly SabreBookSeatOffer[];
}

/** `BookGenericSeat` — `:5287-5303`. `areaPreferences` no se emite (ver {@link SabreSeatInput}). */
export interface SabreBookSeat {
  readonly number: string;
  readonly travelerIndex: SabreIndex;
}

/** `FlightToBook` — `:5161-5256`. Ocho campos required (`:5164-5172`). */
export interface SabreFlightToBook {
  /** ⚠️ `:5174` — **entero**, 1..9999. Los 20 requests de la colección que lo mandan entre comillas violan el contrato. */
  readonly flightNumber: number;
  readonly airlineCode: string;
  readonly fromAirportCode: string;
  readonly toAirportCode: string;
  readonly departureDate: string;
  readonly departureTime: string;
  readonly bookingClass: string;
  readonly flightStatusCode: string;
  readonly isMarriageGroup?: boolean;
  /** Sólo pasivas (`:5221`): «you made a booking directly with the airline». */
  readonly confirmationId?: string;
  readonly arrivalDate?: string;
  readonly arrivalTime?: string;
  readonly source?: SabreFlightSource;
  readonly seats?: readonly SabreBookSeat[];
}

/** `PaymentMethod` — `:5730-5757`. Son ÍNDICES dentro de `payment.formsOfPayment[]`, no objetos. */
export interface SabrePaymentMethod {
  readonly primaryFormOfPayment: SabreIndex;
  readonly secondaryFormOfPayment?: SabreIndex;
  readonly amountOnSecondFormOfPayment?: string;
}

/** `PriceComparison` — `:5775-5800`. `amount` y `percent` son mutuamente excluyentes. */
export interface SabrePriceComparison {
  readonly desiredAmount: string;
  readonly comparisonType: SabrePriceComparisonType;
  readonly amount?: string;
  readonly percent?: string;
}

/**
 * Subconjunto de `PricingQualifiers` (`:5802-6027`) que este builder emite.
 *
 * `PricingQualifiers` es un `allOf` que hereda `TicketingQualifiers` (`:7678`), así que
 * `commissionPercentage` (`:7687`) y `validatingAirlineCode` (`:7724`) **sí son alcanzables desde
 * `createBooking`** — es el gancho del pricing waterfall del modelo consolidador. Lo que NO existe
 * es ponerlos sueltos al nivel de `flightPricing[]`: `PricingDetails` sólo declara
 * `priceComparisons` y `qualifiers` (`:5759-5773`), y todo lo demás se ignora en silencio.
 */
export interface SabrePricingQualifiers {
  readonly flightIndices?: readonly SabreIndex[];
  readonly validatingAirlineCode?: string;
  readonly commissionPercentage?: string;
  readonly commissionAmount?: string;
  readonly payment?: SabrePaymentMethod;
}

/** `PricingDetails` — `:5759-5773`. `{}` significa «cotiza con defaults». */
export interface SabrePricingDetails {
  readonly priceComparisons?: readonly SabrePriceComparison[];
  readonly qualifiers?: SabrePricingQualifiers;
}

/** `FlightDetails` — `:4983-5018`. */
export interface SabreFlightDetails {
  readonly flights: readonly SabreFlightToBook[];
  readonly flightPricing?: readonly SabrePricingDetails[];
  readonly haltOnFlightStatusCodes?: readonly SabreHaltOnFlightStatusCode[];
  /** ⚠️ `:5011-5018`: «may result in a price increase». Nunca sin `priceComparisons`. */
  readonly retryBookingUnconfirmedFlights?: boolean;
}

/** `BookIdentityDocument` — `:5553-5657`. Único required: `documentType`. */
export interface SabreBookIdentityDocument {
  readonly documentNumber?: string;
  readonly documentType: SabreDocumentType;
  readonly documentSubType?: SabreDocumentSubType;
  readonly expiryDate?: string;
  /** `:5583` — «Not applicable to the `VISA` document type». */
  readonly issuingCountryCode?: string;
  /** `:5589` — ⚠️ «For NDC bookings, only two-letter codes are allowed». */
  readonly residenceCountryCode?: string;
  /** `:5594` — sólo `VISA`. */
  readonly placeOfIssue?: string;
  /** `:5599`, máx. 35. */
  readonly placeOfBirth?: string;
  /** `:5604` — sólo `VISA`. Requisito de aerolínea (`MANDATORY_DATA_MISSING`). */
  readonly hostCountryCode?: string;
  readonly issueDate?: string;
  readonly givenName?: string;
  /** ⚠️ `:5620` — «NDC not supported». */
  readonly middleName?: string;
  readonly surname?: string;
  readonly birthDate?: string;
  readonly gender?: SabreGender;
  readonly isPrimaryDocumentHolder?: boolean;
  /** `:5646`, 1-based. Restringe el documento a tramos concretos. */
  readonly flightIndices?: readonly SabreIndex[];
  /** `:5655` — requisito BA. */
  readonly citizenshipCountryCode?: string;
}

/** `LoyaltyProgram` — `:4470-4500`. Único required: `programNumber`. */
export interface SabreLoyaltyProgram {
  readonly supplierCode?: string;
  readonly programType?: SabreProgramType;
  readonly programNumber: string;
  /** ⚠️ `:4491` — **entero**. Los ejemplos con `"1"` violan el contrato. */
  readonly tierLevel?: number;
  readonly receiverCode?: string;
}

/** `Phone` — `:7006-7022`. `number` required. */
export interface SabrePhone {
  readonly number: string;
  readonly label?: string;
}

/** `BookTraveler` — `:6152-6266`. **Ningún** campo es `required` en el esquema. */
export interface SabreBookTraveler {
  /** `:6156` — «Price traveler's id as returned from Offer Price». Obligatorio de facto en NDC. */
  readonly id?: string;
  readonly title?: SabreTitle;
  readonly givenName?: string;
  readonly surname?: string;
  readonly birthDate?: string;
  /** `:6179` — «Applies to NDC content only». */
  readonly gender?: SabreGender;
  /** `:6182` — sólo hotel; obligatorio para menores en habitación. */
  readonly age?: number;
  readonly passengerCode?: string;
  readonly nameReferenceCode?: string;
  readonly identityDocuments?: readonly SabreBookIdentityDocument[];
  readonly loyaltyPrograms?: readonly SabreLoyaltyProgram[];
  /** `:6213` — requisito Hawaiian. Sólo NDC. */
  readonly useNotificationContactType?: boolean;
  readonly emails?: readonly string[];
  readonly phones?: readonly SabrePhone[];
  /** `:6242`, 1-based: cobrar cada pasajero a una forma de pago distinta. */
  readonly formOfPaymentIndices?: readonly SabreIndex[];
  /** `:6251`, 1-based. **Sólo en el objeto del ADULTO**; sin él Sabre empareja secuencialmente. */
  readonly infantTravelerIndex?: SabreIndex;
}

/** `BookContactInformation` — `:1578-1600`. ⚠️ `phones` es `string[]` PLANO, no objetos. */
export interface SabreBookContactInformation {
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
}

/** `GenericAddress` — bloque de dirección de la agencia (`:1620`+). */
export interface SabreGenericAddress {
  readonly street?: string;
  readonly city?: string;
  readonly stateProvince?: string;
  readonly postalCode?: string;
  readonly countryCode?: string;
}

/** `AgencyContacts` — `:1644-1667`. `includePhoneLabel` tiene `default: false`. */
export interface SabreAgencyContacts {
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  readonly includePhoneLabel?: boolean;
}

/** `FutureTicketingPolicy` — `:4767-4800`. El gancho consolidador: reservar aquí, emitir allí. */
export interface SabreFutureTicketingPolicy {
  readonly ticketingPcc?: string;
  readonly queueNumber?: string;
  readonly ticketingDate?: string;
  readonly ticketingTime?: string;
  readonly comment?: string;
}

/** `TicketingTimeLimitPolicy` — `:4890-4910`. */
export interface SabreTicketingTimeLimitPolicy {
  readonly airlineCode?: string;
  readonly ticketingDate?: string;
  readonly ticketingTime?: string;
}

/** `Agency` — `:4733-4755` (`GenericAgency` + 4 campos). */
export interface SabreAgency {
  readonly address?: SabreGenericAddress;
  readonly contactInfo?: SabreAgencyContacts;
  readonly ticketingPolicy?: SabreTicketingPolicy;
  readonly futureTicketingPolicy?: SabreFutureTicketingPolicy;
  readonly ticketingTimeLimitPolicy?: SabreTicketingTimeLimitPolicy;
  readonly agencyCustomerNumber?: string;
}

/** `Payment` — `:5700-5716`. Sin `billingAddress`: es dirección de facturación de tarjeta (D1). */
export interface SabrePayment {
  readonly formsOfPayment: readonly SabreFormOfPayment[];
}

/**
 * El body completo. `errorHandlingPolicy` y `asynchronousUpdateWaitTime` son **no opcionales**
 * aquí aunque el contrato los declare opcionales: es la forma de que el compilador impida
 * construir un body sin ellos.
 */
export interface SabreCreateBookingBody {
  readonly errorHandlingPolicy: readonly SabreCreateErrorPolicy[];
  readonly asynchronousUpdateWaitTime: number;
  /** ⚠️ `:708`: «The API **does not revert context** after completing the booking». */
  readonly targetPcc?: string;
  readonly receivedFrom?: string;
  readonly agency?: SabreAgency;
  readonly flightOffer?: SabreFlightOffer;
  readonly flightDetails?: SabreFlightDetails;
  readonly travelers?: readonly SabreBookTraveler[];
  readonly contactInfo?: SabreBookContactInformation;
  readonly payment?: SabrePayment;
  /** ⚠️ `:781-785` — `YYYY-MM-DD`, **no** ISO-8601 con hora. */
  readonly retentionEndDate?: string;
  readonly retentionLabel?: string;
}

// ---------------------------------------------------------------------------------------------
// La entrada: vocabulario nuestro, 0-based, sin un solo campo capaz de contener un PAN
// ---------------------------------------------------------------------------------------------

const dateSchema = z.string().regex(ISO_DATE);
const timeSchema = z.string().regex(HH_MM);
const countrySchema = z.string().regex(COUNTRY_CODE);
/** Posición dentro de uno de NUESTROS arrays. 0-based hacia adentro, siempre (docs/sabre/04 §8.4). */
const positionSchema = z.number().int().min(0);

const SeatInputSchema = z
  .object({
    number: z.string().regex(SEAT_NUMBER).optional(),
    seatOfferId: z.string().min(2).max(49).optional(),
    /** 0-based en `travelers`. La conversión a 1-based la hace `indices.ts`. */
    travelerPosition: positionSchema,
  })
  .strict();

/**
 * Un asiento pedido.
 *
 * `areaPreferences` (`:5262-5271`) **no se soporta**: no está ejercitado por la colección, es
 * mutuamente excluyente con `number`, y su error `INVALID_COMBINATION` añade una regla más sobre
 * `changeOfGaugeSeats`. Se añade cuando haya un caso de uso y un fixture, no antes.
 */
export type SabreSeatInput = z.infer<typeof SeatInputSchema>;

const IdentityDocumentInputSchema = z
  .object({
    documentNumber: z.string().regex(DOCUMENT_NUMBER).optional(),
    documentType: z.enum(SABRE_DOCUMENT_TYPES),
    documentSubType: z.enum(SABRE_DOCUMENT_SUBTYPES).optional(),
    expiryDate: dateSchema.optional(),
    issuingCountryCode: countrySchema.optional(),
    residenceCountryCode: countrySchema.optional(),
    placeOfIssue: countrySchema.optional(),
    placeOfBirth: z.string().max(35).optional(),
    hostCountryCode: countrySchema.optional(),
    issueDate: dateSchema.optional(),
    givenName: z.string().min(1).optional(),
    middleName: z.string().min(1).optional(),
    surname: z.string().min(1).optional(),
    birthDate: dateSchema.optional(),
    gender: z.enum(SABRE_GENDERS).optional(),
    isPrimaryDocumentHolder: z.boolean().optional(),
    /** 0-based en la lista de vuelos de la reserva. */
    flightPositions: z.array(positionSchema).min(1).optional(),
    citizenshipCountryCode: countrySchema.optional(),
  })
  .strict();

export type SabreIdentityDocumentInput = z.infer<typeof IdentityDocumentInputSchema>;

const LoyaltyProgramInputSchema = z
  .object({
    supplierCode: z.string().regex(AIRLINE_CODE).optional(),
    programType: z.enum(SABRE_PROGRAM_TYPES).optional(),
    programNumber: z.string().min(1),
    tierLevel: z.number().int().optional(),
    receiverCode: z.string().regex(AIRLINE_CODE).optional(),
  })
  .strict();

const TravelerInputSchema = z
  .object({
    providerTravelerId: z.string().min(1).optional(),
    title: z.enum(SABRE_TITLES).optional(),
    givenName: z.string().regex(GIVEN_NAME).optional(),
    surname: z.string().regex(SURNAME).optional(),
    birthDate: dateSchema.optional(),
    gender: z.enum(SABRE_GENDERS).optional(),
    age: z.number().int().min(1).max(120).optional(),
    passengerCode: z.string().regex(PASSENGER_CODE).optional(),
    nameReferenceCode: z.string().regex(NAME_REFERENCE_CODE).optional(),
    identityDocuments: z.array(IdentityDocumentInputSchema).optional(),
    loyaltyPrograms: z.array(LoyaltyProgramInputSchema).optional(),
    useNotificationContactType: z.boolean().optional(),
    emails: z.array(z.string().email()).optional(),
    phones: z
      .array(
        z
          .object({
            number: z.string().regex(PHONE),
            label: z.string().regex(PHONE_LABEL).optional(),
          })
          .strict(),
      )
      .optional(),
    /** 0-based en `formsOfPayment`. */
    formOfPaymentPositions: z.array(positionSchema).min(1).optional(),
    /** 0-based en `travelers`: el infante que viaja con ESTE adulto. */
    linkedInfantPosition: positionSchema.optional(),
  })
  .strict();

export type SabreTravelerInput = z.infer<typeof TravelerInputSchema>;

const PricingInputSchema = z
  .object({
    /** 0-based en la lista de vuelos. */
    flightPositions: z.array(positionSchema).min(1).optional(),
    validatingAirlineCode: z.string().regex(AIRLINE_CODE).optional(),
    commissionPercentage: z.string().regex(PERCENT).optional(),
    commissionAmount: z.string().regex(AMOUNT).optional(),
    /** 0-based en `formsOfPayment`. */
    primaryFormOfPaymentPosition: positionSchema.optional(),
    secondaryFormOfPaymentPosition: positionSchema.optional(),
    amountOnSecondFormOfPayment: z.string().regex(AMOUNT).optional(),
    priceComparisons: z
      .array(
        z
          .object({
            desiredAmount: z.string().regex(AMOUNT),
            comparisonType: z.enum(SABRE_PRICE_COMPARISON_TYPES),
            amount: z.string().regex(AMOUNT).optional(),
            percent: z.string().regex(PERCENT).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(SABRE_PRICE_COMPARISONS_MAX)
      .optional(),
  })
  .strict();

export type SabrePricingInput = z.infer<typeof PricingInputSchema>;

const FlightInputSchema = z
  .object({
    flightNumber: z.number().int().min(1).max(9999),
    airlineCode: z.string().regex(AIRLINE_CODE),
    fromAirportCode: z.string().regex(AIRPORT_CODE),
    toAirportCode: z.string().regex(AIRPORT_CODE),
    departureDate: dateSchema,
    departureTime: timeSchema,
    bookingClass: z.string().regex(BOOKING_CLASS),
    flightStatusCode: z.string().regex(FLIGHT_STATUS_CODE),
    isMarriageGroup: z.boolean().optional(),
    confirmationId: z.string().regex(CONFIRMATION_ID).optional(),
    arrivalDate: dateSchema.optional(),
    arrivalTime: timeSchema.optional(),
    source: z.enum(SABRE_FLIGHT_SOURCES).optional(),
    seats: z.array(SeatInputSchema).min(1).optional(),
  })
  .strict();

export type SabreFlightInput = z.infer<typeof FlightInputSchema>;

const FormOfPaymentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CASH') }).strict(),
  z.object({ type: z.literal('CHECK') }).strict(),
  z
    .object({
      type: z.literal('MISCELLANEOUS'),
      miscellaneousCreditCode: z.string().min(MISC_CREDIT_CODE_MIN).max(MISC_CREDIT_CODE_MAX),
      extendedPayment: z.number().int().min(1).max(96).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('INSTALLMENTS'),
      numberOfInstallments: z.number().int().min(1).max(96),
      airlinePlanCode: z.string().min(1).optional(),
      installmentAmount: z
        .string()
        .regex(/^[0-9]+$/)
        .optional(),
      netBalance: z.string().regex(AMOUNT).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('DOCKET'),
      docketPrefix: z
        .string()
        .regex(/^D$|^AGT\*V$/)
        .optional(),
      docketNumber: z
        .string()
        .regex(/^[0-9]{6}$/)
        .optional(),
      docketIssuingAgentInitials: z.string().min(1).optional(),
      docketDescription: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('GOVERNMENT_TRAVEL_REQUEST'),
      governmentTravelRequestDescription: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('INVOICE'),
      invoiceDescription: z.string().min(1).optional(),
      addInvoiceDescriptionPrefix: z.boolean().optional(),
    })
    .strict(),
]);

const NdcProductSchema = z
  .object({
    kind: z.literal('ndc'),
    /** `:4959`, 2–49. De `/v1/offers/price` → `response.offers[0].id`. */
    offerId: z.string().min(2).max(49),
    /** `:4966`. Un `offerItem` por tipo de pasajero: un ADT+CNN manda **dos**. */
    selectedOfferItems: z.array(z.string().min(1)).min(1).max(SABRE_SELECTED_OFFER_ITEMS_MAX),
    seatOffers: z.array(SeatInputSchema).min(1).optional(),
    /**
     * Cuántos tramos tiene la oferta. En NDC el itinerario vive DENTRO de la oferta y no se
     * re-declara, así que sin este dato no hay array contra el que validar un `flightPositions`.
     * Sólo hace falta si algún documento restringe su validez a tramos concretos.
     */
    segmentCount: z.number().int().min(1).max(SABRE_FLIGHTS_MAX).optional(),
  })
  .strict();

const AtpcoProductSchema = z
  .object({
    kind: z.literal('atpco'),
    flights: z.array(FlightInputSchema).min(1).max(SABRE_FLIGHTS_MAX),
    /** `[{}]` = «cotiza con defaults»; omitirlo = «reserva sin cotizar». */
    pricing: z.array(PricingInputSchema).min(1).max(SABRE_FLIGHT_PRICING_MAX).optional(),
    haltOnFlightStatusCodes: z.array(z.enum(SABRE_HALT_ON_FLIGHT_STATUS_CODES)).min(1).optional(),
    retryBookingUnconfirmedFlights: z.boolean().optional(),
  })
  .strict();

/**
 * `flightOffer` (NDC) y `flightDetails` (ATPCO/LCC) son **mutuamente excluyentes**: cero de los 176
 * requests de la colección llevan los dos.
 *
 * ⚠️ El contrato **no declara** esa exclusión (`CreateBookingRequest` no tiene `oneOf`/`not`,
 * `:736-741`) — la enuncia la documentación oficial en prosa. Es decir: **la validación de forma no
 * la hace Swagger, la hace el backend**. Aquí la hace el TIPO: una unión discriminada por `kind` no
 * permite construir un input con los dos bloques.
 */
const ProductSchema = z.discriminatedUnion('kind', [NdcProductSchema, AtpcoProductSchema]);

export type SabreBookingProductInput = z.infer<typeof ProductSchema>;

const AgencyInputSchema = z
  .object({
    address: z
      .object({
        street: z.string().min(1).optional(),
        city: z.string().min(1).optional(),
        stateProvince: z.string().min(1).optional(),
        postalCode: z.string().min(1).optional(),
        countryCode: countrySchema.optional(),
      })
      .strict()
      .optional(),
    contactInfo: z
      .object({
        emails: z.array(z.string().email()).min(1).optional(),
        phones: z.array(z.string().regex(PHONE)).min(1).optional(),
        includePhoneLabel: z.boolean().optional(),
      })
      .strict()
      .optional(),
    ticketingPolicy: z.enum(SABRE_TICKETING_POLICIES).optional(),
    futureTicketingPolicy: z
      .object({
        ticketingPcc: z.string().regex(PCC).optional(),
        queueNumber: z.string().min(1).optional(),
        ticketingDate: dateSchema.optional(),
        ticketingTime: timeSchema.optional(),
        comment: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    ticketingTimeLimitPolicy: z
      .object({
        airlineCode: z.string().regex(AIRLINE_CODE).optional(),
        ticketingDate: dateSchema.optional(),
        ticketingTime: timeSchema.optional(),
      })
      .strict()
      .optional(),
    agencyCustomerNumber: z.string().regex(AGENCY_CUSTOMER_NUMBER).optional(),
  })
  .strict();

export type SabreAgencyInput = z.infer<typeof AgencyInputSchema>;

/**
 * La entrada del builder.
 *
 * Todos los índices que entran son **posiciones 0-based** de nuestros arrays; ninguna posición
 * 1-based cruza esta frontera en ninguno de los dos sentidos (docs/sabre/04 §8.4).
 */
export const SabreCreateBookingInputSchema = z
  .object({
    product: ProductSchema,
    travelers: z.array(TravelerInputSchema).min(1),
    contactInfo: z
      .object({
        /**
         * ⚠️ Orden con significado (`:754-758`): «add **agency** contact number as a first item
         * followed by the main contact number for the **traveler**». Lo respeta quien llama.
         */
        emails: z.array(z.string().email()).min(1).optional(),
        phones: z.array(z.string().regex(PHONE)).min(1).optional(),
      })
      .strict()
      .optional(),
    agency: AgencyInputSchema.optional(),
    /**
     * Formas de pago. Si se omite, se manda {@link SABRE_DEFAULT_FORM_OF_PAYMENT} (`CASH`), que es
     * el default del ACL en aéreo. Para el caso «reservar sin declarar forma de pago» —82 de 176
     * requests de la colección— está {@link SabreCreateBookingOptions.omitPayment}.
     */
    formsOfPayment: z
      .array(FormOfPaymentSchema)
      .min(1)
      .max(SABRE_FORMS_OF_PAYMENT_MAX_ITEMS)
      .optional(),
    /** BYOC: reservar bajo el PCC de la sub-agencia. Explícito siempre; nunca heredado en silencio. */
    targetPcc: z.string().regex(PCC).optional(),
    /** `:709`, auditoría del PNR. Default del contrato: `'Create Booking'`. */
    receivedFrom: z.string().min(1).optional(),
    /** ⚠️ `YYYY-MM-DD` (`:781`). */
    retentionEndDate: dateSchema.optional(),
    retentionLabel: z.string().regex(RETENTION_LABEL).optional(),
    /**
     * Códigos IATA que la reserva toca, para los requisitos por aerolínea. En ATPCO se deducen de
     * los propios vuelos; en NDC el itinerario no viaja en el body y **hay que decirlos**.
     */
    carriers: z.array(z.string().min(2).max(3)).optional(),
    /** Contexto de venta que el body no puede revelar: hoy sólo si la tarifa es corporativa. */
    corporateFare: z.boolean().optional(),
  })
  .strict();

export type SabreCreateBookingInput = z.input<typeof SabreCreateBookingInputSchema>;

export const SabreCreateBookingOptionsSchema = z
  .object({
    /**
     * Dominios de producto cuyo fallo NO debe tumbar la reserva. Vacío = `HALT_ON_ERROR`.
     * Lo que se elija aquí viaja al `domain_event` a través de {@link SabreCreateBookingPlan}.
     */
    partialFailureTolerance: z.array(z.enum(SABRE_PARTIAL_FAILURE_DOMAINS)).default([]),
    /** `HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR` (sólo ATPCO). Es una política MÁS estricta. */
    haltOnInvalidConnectingTime: z.boolean().default(false),
    asynchronousUpdateWaitTimeMs: z
      .number()
      .int()
      .min(SABRE_ASYNC_UPDATE_WAIT_MS_MIN)
      .max(SABRE_ASYNC_UPDATE_WAIT_MS_MAX)
      .default(SABRE_ASYNC_UPDATE_WAIT_MS_DEFAULT),
    /** Reservar sin bloque `payment`, el caso mayoritario de la colección (docs/sabre/04 §7.4d). */
    omitPayment: z.boolean().default(false),
  })
  .strict();

export type SabreCreateBookingOptions = z.input<typeof SabreCreateBookingOptionsSchema>;

/**
 * Lo que hay que mandar y lo que hay que registrar al mandarlo.
 *
 * No es sólo el body: la política de error aplicada y la espera asíncrona son **decisiones** que el
 * `domain_event` tiene que poder citar cuando alguien pregunte, tres semanas después, por qué esa
 * reserva quedó a medias (RNF-08).
 */
export interface SabreCreateBookingPlan {
  readonly path: typeof SABRE_CREATE_BOOKING_PATH;
  readonly body: SabreCreateBookingBody;
  readonly errorHandlingPolicy: readonly SabreCreateErrorPolicy[];
  readonly asynchronousUpdateWaitTimeMs: number;
  /** Aerolíneas evaluadas contra la tabla de requisitos. Normalizadas a mayúsculas. */
  readonly carriers: readonly string[];
  /**
   * Requisitos por aerolínea que faltan y **no** bloquean (severidad `advisory`). Los `blocking`
   * no llegan aquí: hacen fallar la construcción. Sólo nombres de campo e índices, nunca valores.
   */
  readonly advisories: readonly MissingAirlineRequirement[];
}

// ---------------------------------------------------------------------------------------------
// Construcción
// ---------------------------------------------------------------------------------------------

/**
 * `SabreCreateBookingInput` → body de `createBooking`.
 *
 * Falla ruidosamente —y **antes de tocar la red**— si la entrada no cumple el contrato o si falta
 * un requisito bloqueante de aerolínea. Que Sabre lo rechace también es cierto, pero un rechazo del
 * proveedor puede llegar con un PNR a medias; éste no llega con nada.
 */
export function buildSabreCreateBookingRequest(
  input: SabreCreateBookingInput,
  cfg: SabreConfig,
  options: SabreCreateBookingOptions = {},
): SabreCreateBookingPlan {
  const parsed = parseOrThrow(SabreCreateBookingInputSchema, input, 'la reserva');
  const opts = parseOrThrow(SabreCreateBookingOptionsSchema, options, 'las opciones de reserva');

  assertRetentionLabelNoPan(parsed.retentionLabel);

  if (opts.omitPayment && parsed.formsOfPayment !== undefined) {
    throw new SabreCreateBookingError(
      'omitPayment y formsOfPayment son contradictorios: o se manda el bloque de pago o no',
    );
  }

  const formsOfPayment: readonly SabreFormOfPayment[] = opts.omitPayment
    ? []
    : parsed.formsOfPayment === undefined
      ? [SABRE_DEFAULT_FORM_OF_PAYMENT]
      : parsed.formsOfPayment.map(buildFormOfPayment);

  // Los "huecos" de vuelo contra los que se validan los `flightPositions`. En ATPCO son los vuelos
  // reales; en NDC el itinerario va dentro de la oferta y sólo se conoce su longitud si el llamador
  // la declara. Sin ninguna de las dos, un `flightPositions` no se puede comprobar y se rechaza.
  const flightSlots: readonly unknown[] =
    parsed.product.kind === 'atpco'
      ? parsed.product.flights
      : new Array<null>(parsed.product.segmentCount ?? 0).fill(null);

  const travelers = parsed.travelers.map((traveler) =>
    buildTraveler(traveler, parsed.travelers, flightSlots, formsOfPayment),
  );

  const errorHandlingPolicy = resolveErrorHandlingPolicy(
    opts.partialFailureTolerance,
    opts.haltOnInvalidConnectingTime,
  );

  const body: SabreCreateBookingBody = {
    // Los dos campos que nunca se omiten van primero, para que se vean en cualquier diff del body.
    errorHandlingPolicy,
    asynchronousUpdateWaitTime: opts.asynchronousUpdateWaitTimeMs,
    ...(parsed.targetPcc === undefined ? {} : { targetPcc: parsed.targetPcc }),
    ...(parsed.receivedFrom === undefined ? {} : { receivedFrom: parsed.receivedFrom }),
    ...(parsed.agency === undefined ? {} : { agency: buildAgency(parsed.agency) }),
    ...buildProduct(parsed.product, parsed.travelers, formsOfPayment),
    travelers,
    ...(parsed.contactInfo === undefined
      ? {}
      : { contactInfo: buildContactInfo(parsed.contactInfo) }),
    ...(formsOfPayment.length === 0 ? {} : { payment: { formsOfPayment } }),
    ...(parsed.retentionEndDate === undefined ? {} : { retentionEndDate: parsed.retentionEndDate }),
    ...(parsed.retentionLabel === undefined ? {} : { retentionLabel: parsed.retentionLabel }),
  };

  assertTargetPccIsAddressable(body.targetPcc, cfg);

  const carriers = resolveCarriers(parsed);
  const missing = findMissingAirlineRequirements(carriers, body, {
    ...(parsed.corporateFare === undefined ? {} : { corporateFare: parsed.corporateFare }),
  });

  if (hasBlockingAirlineRequirements(missing)) {
    const blocking = missing.filter((item) => item.severity === 'blocking');
    throw new SabreCreateBookingError(
      `la reserva no cumple requisitos de aerolínea y Sabre la rechazaría: ` +
        describeMissingAirlineRequirements(blocking).join('; '),
    );
  }

  return {
    path: SABRE_CREATE_BOOKING_PATH,
    body,
    errorHandlingPolicy,
    asynchronousUpdateWaitTimeMs: opts.asynchronousUpdateWaitTimeMs,
    carriers,
    advisories: missing,
  };
}

/**
 * Tolerancias → `errorHandlingPolicy[]`.
 *
 * `HALT_ON_ERROR` **no se combina** con ningún `DO_NOT_HALT_ON_*`: pedir las dos cosas es pedirle al
 * proveedor que pare y que siga. Sin tolerancias, la política es exactamente `['HALT_ON_ERROR']`.
 * El orden es el del enum del contrato para que dos llamadas equivalentes produzcan el mismo array
 * y el `domain_event` sea comparable.
 */
export function resolveErrorHandlingPolicy(
  tolerance: readonly SabrePartialFailureDomain[],
  haltOnInvalidConnectingTime: boolean,
): readonly SabreCreateErrorPolicy[] {
  const selected = new Set<SabreCreateErrorPolicy>(
    tolerance.map((domain) => SABRE_ERROR_POLICY_BY_TOLERANCE[domain]),
  );
  if (haltOnInvalidConnectingTime) selected.add('HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR');
  if (selected.size === 0) return [SABRE_DEFAULT_ERROR_POLICY];
  return SABRE_CREATE_ERROR_POLICIES.filter((policy) => selected.has(policy));
}

/**
 * El hueco que el patrón del contrato deja abierto en `retentionLabel`, cerrado.
 *
 * `^[a-zA-Z0-9 ,.*?\-/]{0,215}$` (`:787`) admite un PAN de 16 dígitos sin inmutarse, y el campo es
 * **una etiqueta**: «The label associated with the retention date», ejemplo oficial
 * `'RETENTION DATE'`. Acaba escrito en el PNR, que es lo que ve la aerolínea y cualquiera que
 * recupere la reserva — el sitio clásico donde aparecen números de tarjeta que nadie quiso poner
 * ahí. Con D1 decidida no hay ninguna razón para que una etiqueta de retención lleve nueve dígitos
 * seguidos, así que se rechaza en voz alta en vez de dejarlo pasar «porque el patrón lo admite».
 *
 * El mensaje **no lleva el valor**: nombra el campo y la regla, como todos los de este archivo.
 *
 * ⚠️ Esto NO promete que un PAN no pueda llegar a Sabre por este body: `phones`, `documentNumber`,
 * `confirmationId` o `programNumber` admiten tiradas largas porque las necesitan, y ahí la defensa
 * es la barrera de tipo y la redacción, no la forma. Lo que cierra es este campo y sólo éste; el
 * inventario completo vive en `pan-egress.guard.test.ts`.
 */
function assertRetentionLabelNoPan(retentionLabel: string | undefined): void {
  if (retentionLabel === undefined) return;
  if (!PAN_LIKE_DIGIT_RUN.test(retentionLabel)) return;
  throw new SabreCreateBookingError(
    'retentionLabel contiene una tirada de 9 o más dígitos seguidos: es una etiqueta que se ' +
      'escribe en el PNR y ninguna etiqueta legítima la necesita, mientras que D1 prohíbe lo ' +
      'único que sí tiene esa forma',
  );
}

/**
 * `targetPcc` cambia el contexto del PCC y **el API no lo revierte** (`:708`). El carril de grupo
 * viaja en cabecera (`X-Sabre-Group` / `X-Sabre-Current-City`, 28 de 176 requests de la colección,
 * docs/sabre/04 §1). El contrato no declara la dependencia entre el campo y la cabecera; que sea
 * obligatoria lo afirma `config.ts` sobre `SabreConfig.sabreGroup` / `sabreCurrentCity`.
 *
 * ⚠️ **Lo que esta comprobación garantiza y lo que no.** Garantiza que la config del tenant trae el
 * grupo. Que la cabecera SALGA AL CABLE es de `SabreHttpClient.buildHeaders`, que desde la ronda
 * del cableado emite `X-Sabre-Group` / `X-Sabre-Current-City` cuando la config las declara —fijado
 * por un test que mira lo que llega a `fetch`, no la función privada—. Son dos mitades de la misma
 * regla y viven en dos ficheros: éste impide construir el body sin grupo, aquél lo pone en la
 * petición. Ninguna de las dos sobra.
 */
function assertTargetPccIsAddressable(targetPcc: string | undefined, cfg: SabreConfig): void {
  if (targetPcc === undefined) return;
  if (cfg.sabreGroup !== undefined || cfg.sabreCurrentCity !== undefined) return;
  throw new SabreCreateBookingError(
    'targetPcc exige sabreGroup o sabreCurrentCity en la config: sin el grupo, la llamada actúa ' +
      'sobre el PCC propio y deja el contexto cambiado sin revertirlo',
  );
}

/** Aerolíneas que la tabla de requisitos tiene que evaluar. En ATPCO salen de los propios vuelos. */
function resolveCarriers(parsed: z.infer<typeof SabreCreateBookingInputSchema>): readonly string[] {
  const declared = parsed.carriers ?? [];
  const fromFlights =
    parsed.product.kind === 'atpco' ? parsed.product.flights.map((f) => f.airlineCode) : [];
  return [
    ...new Set([...declared, ...fromFlights].map((code) => code.trim().toUpperCase())),
  ].filter((code) => code.length > 0);
}

function buildProduct(
  product: z.infer<typeof ProductSchema>,
  travelers: readonly unknown[],
  formsOfPayment: readonly SabreFormOfPayment[],
): { flightOffer: SabreFlightOffer } | { flightDetails: SabreFlightDetails } {
  if (product.kind === 'ndc') {
    const offer: SabreFlightOffer = {
      offerId: product.offerId,
      selectedOfferItems: [...product.selectedOfferItems],
      ...(product.seatOffers === undefined
        ? {}
        : { seatOffers: product.seatOffers.map((seat) => buildSeatOffer(seat, travelers)) }),
    };
    return { flightOffer: offer };
  }

  const details: SabreFlightDetails = {
    flights: product.flights.map((flight) => buildFlight(flight, travelers)),
    ...(product.pricing === undefined
      ? {}
      : {
          flightPricing: product.pricing.map((pricing) =>
            buildPricing(pricing, product.flights, formsOfPayment),
          ),
        }),
    ...(product.haltOnFlightStatusCodes === undefined
      ? {}
      : { haltOnFlightStatusCodes: [...product.haltOnFlightStatusCodes] }),
    ...(product.retryBookingUnconfirmedFlights === undefined
      ? {}
      : { retryBookingUnconfirmedFlights: product.retryBookingUnconfirmedFlights }),
  };
  return { flightDetails: details };
}

function buildSeatOffer(seat: SabreSeatInput, travelers: readonly unknown[]): SabreBookSeatOffer {
  return {
    ...(seat.seatOfferId === undefined ? {} : { seatOfferId: seat.seatOfferId }),
    ...(seat.number === undefined ? {} : { number: seat.number }),
    travelerIndex: sabreIndexIn(travelers, seat.travelerPosition),
  };
}

function buildFlight(flight: SabreFlightInput, travelers: readonly unknown[]): SabreFlightToBook {
  return {
    flightNumber: flight.flightNumber,
    airlineCode: flight.airlineCode,
    fromAirportCode: flight.fromAirportCode,
    toAirportCode: flight.toAirportCode,
    departureDate: flight.departureDate,
    departureTime: flight.departureTime,
    bookingClass: flight.bookingClass,
    flightStatusCode: flight.flightStatusCode,
    ...(flight.isMarriageGroup === undefined ? {} : { isMarriageGroup: flight.isMarriageGroup }),
    ...(flight.confirmationId === undefined ? {} : { confirmationId: flight.confirmationId }),
    ...(flight.arrivalDate === undefined ? {} : { arrivalDate: flight.arrivalDate }),
    ...(flight.arrivalTime === undefined ? {} : { arrivalTime: flight.arrivalTime }),
    ...(flight.source === undefined ? {} : { source: flight.source }),
    ...(flight.seats === undefined
      ? {}
      : { seats: flight.seats.map((seat) => buildAtpcoSeat(seat, travelers)) }),
  };
}

/**
 * `flights[].seats[]` es `BookSeat` (`:5257`), que **no** lleva `seatOfferId`: ése es del carril
 * NDC (`BookSeatOffer`, `:5273`). Mandarlo aquí sería un campo que el contrato no declara y que
 * Sabre ignora en silencio, así que se rechaza en voz alta.
 */
function buildAtpcoSeat(seat: SabreSeatInput, travelers: readonly unknown[]): SabreBookSeat {
  if (seat.seatOfferId !== undefined) {
    throw new SabreCreateBookingError(
      'seatOfferId sólo existe en el carril NDC (flightOffer.seatOffers): en ATPCO el asiento se ' +
        'pide por número dentro de flights[].seats[]',
    );
  }
  if (seat.number === undefined) {
    throw new SabreCreateBookingError(
      'un asiento ATPCO sin número no pide nada: falta seats[].number',
    );
  }
  return { number: seat.number, travelerIndex: sabreIndexIn(travelers, seat.travelerPosition) };
}

function buildPricing(
  pricing: SabrePricingInput,
  flights: readonly unknown[],
  formsOfPayment: readonly SabreFormOfPayment[],
): SabrePricingDetails {
  const qualifiers: SabrePricingQualifiers = {
    ...(pricing.flightPositions === undefined
      ? {}
      : { flightIndices: pricing.flightPositions.map((pos) => sabreIndexIn(flights, pos)) }),
    ...(pricing.validatingAirlineCode === undefined
      ? {}
      : { validatingAirlineCode: pricing.validatingAirlineCode }),
    ...(pricing.commissionPercentage === undefined
      ? {}
      : { commissionPercentage: pricing.commissionPercentage }),
    ...(pricing.commissionAmount === undefined
      ? {}
      : { commissionAmount: pricing.commissionAmount }),
    ...buildPricingPayment(pricing, formsOfPayment),
  };

  // `commissionAmount` y `commissionPercentage` son mutuamente excluyentes (`:7686`). El contrato
  // no lo expresa en el esquema —lo dice la descripción—, así que lo comprueba el ACL.
  if (qualifiers.commissionAmount !== undefined && qualifiers.commissionPercentage !== undefined) {
    throw new SabreCreateBookingError(
      'commissionAmount y commissionPercentage no se pueden combinar (booking-management-v1.yml:7686)',
    );
  }

  const comparisons = pricing.priceComparisons?.map(buildPriceComparison);

  return {
    ...(comparisons === undefined ? {} : { priceComparisons: comparisons }),
    ...(Object.keys(qualifiers).length === 0 ? {} : { qualifiers }),
  };
}

function buildPricingPayment(
  pricing: SabrePricingInput,
  formsOfPayment: readonly SabreFormOfPayment[],
): { payment: SabrePaymentMethod } | Record<string, never> {
  if (pricing.primaryFormOfPaymentPosition === undefined) {
    if (pricing.secondaryFormOfPaymentPosition !== undefined) {
      throw new SabreCreateBookingError(
        'secondaryFormOfPaymentPosition sin primaryFormOfPaymentPosition: `primaryFormOfPayment` ' +
          'es el único campo required de PaymentMethod (booking-management-v1.yml:5735)',
      );
    }
    return {};
  }

  const primary = boundedFormOfPaymentIndex(
    formsOfPayment,
    pricing.primaryFormOfPaymentPosition,
    'primaryFormOfPayment',
  );
  const secondary =
    pricing.secondaryFormOfPaymentPosition === undefined
      ? undefined
      : boundedFormOfPaymentIndex(
          formsOfPayment,
          pricing.secondaryFormOfPaymentPosition,
          'secondaryFormOfPayment',
        );

  return {
    payment: {
      primaryFormOfPayment: primary,
      ...(secondary === undefined ? {} : { secondaryFormOfPayment: secondary }),
      ...(pricing.amountOnSecondFormOfPayment === undefined
        ? {}
        : { amountOnSecondFormOfPayment: pricing.amountOnSecondFormOfPayment }),
    },
  };
}

/**
 * El índice va acotado dos veces: contra la longitud real del array (`sabreIndexIn`) y contra el
 * tope declarado del array (`SABRE_FORMS_OF_PAYMENT_MAX_ITEMS`, `:5711`).
 *
 * ⚠️ `primaryFormOfPayment` declara `maximum: 11` (`:5742`), un índice que no puede existir en un
 * array de 10. Se adopta el tope del array; el 11 está documentado en `indices.ts` como
 * `SABRE_FORM_OF_PAYMENT_INDEX_DECLARED_MAX`. El error oficial `WRONG_FORM_OF_PAYMENT_INDEX`
 * («Specified index is out of form of payment list bounds») es la prueba de que se castiga.
 */
function boundedFormOfPaymentIndex(
  formsOfPayment: readonly SabreFormOfPayment[],
  position: number,
  field: string,
): SabreIndex {
  if (formsOfPayment.length === 0) {
    throw new SabreCreateBookingError(
      `${field} apunta a payment.formsOfPayment[], que no se está mandando`,
    );
  }
  return sabreIndexAtMost(
    sabreIndexIn(formsOfPayment, position),
    SABRE_FORMS_OF_PAYMENT_MAX_ITEMS,
    field,
  );
}

function buildPriceComparison(
  comparison: NonNullable<SabrePricingInput['priceComparisons']>[number],
): SabrePriceComparison {
  if (comparison.amount !== undefined && comparison.percent !== undefined) {
    throw new SabreCreateBookingError(
      'priceComparisons[].amount y .percent son mutuamente excluyentes ' +
        '(booking-management-v1.yml:5791 y :5796)',
    );
  }
  return {
    desiredAmount: comparison.desiredAmount,
    comparisonType: comparison.comparisonType,
    ...(comparison.amount === undefined ? {} : { amount: comparison.amount }),
    ...(comparison.percent === undefined ? {} : { percent: comparison.percent }),
  };
}

function buildTraveler(
  traveler: SabreTravelerInput,
  allTravelers: readonly unknown[],
  flightSlots: readonly unknown[],
  formsOfPayment: readonly SabreFormOfPayment[],
): SabreBookTraveler {
  return {
    ...(traveler.providerTravelerId === undefined ? {} : { id: traveler.providerTravelerId }),
    ...(traveler.title === undefined ? {} : { title: traveler.title }),
    ...(traveler.givenName === undefined ? {} : { givenName: traveler.givenName }),
    ...(traveler.surname === undefined ? {} : { surname: traveler.surname }),
    ...(traveler.birthDate === undefined ? {} : { birthDate: traveler.birthDate }),
    ...(traveler.gender === undefined ? {} : { gender: traveler.gender }),
    ...(traveler.age === undefined ? {} : { age: traveler.age }),
    ...(traveler.passengerCode === undefined ? {} : { passengerCode: traveler.passengerCode }),
    ...(traveler.nameReferenceCode === undefined
      ? {}
      : { nameReferenceCode: traveler.nameReferenceCode }),
    ...(traveler.identityDocuments === undefined
      ? {}
      : {
          identityDocuments: traveler.identityDocuments.map((document) =>
            buildIdentityDocument(document, flightSlots),
          ),
        }),
    ...(traveler.loyaltyPrograms === undefined
      ? {}
      : { loyaltyPrograms: traveler.loyaltyPrograms.map(buildLoyaltyProgram) }),
    ...(traveler.useNotificationContactType === undefined
      ? {}
      : { useNotificationContactType: traveler.useNotificationContactType }),
    ...(traveler.emails === undefined ? {} : { emails: [...traveler.emails] }),
    ...(traveler.phones === undefined
      ? {}
      : {
          phones: traveler.phones.map((phone) => ({
            number: phone.number,
            ...(phone.label === undefined ? {} : { label: phone.label }),
          })),
        }),
    ...(traveler.formOfPaymentPositions === undefined
      ? {}
      : {
          formOfPaymentIndices: traveler.formOfPaymentPositions.map((pos) =>
            boundedFormOfPaymentIndex(formsOfPayment, pos, 'formOfPaymentIndices'),
          ),
        }),
    ...(traveler.linkedInfantPosition === undefined
      ? {}
      : { infantTravelerIndex: sabreIndexIn(allTravelers, traveler.linkedInfantPosition) }),
  };
}

function buildIdentityDocument(
  document: SabreIdentityDocumentInput,
  flightSlots: readonly unknown[],
): SabreBookIdentityDocument {
  if (document.flightPositions !== undefined && flightSlots.length === 0) {
    throw new SabreCreateBookingError(
      'identityDocuments[].flightPositions necesita saber cuántos tramos tiene la reserva: en NDC ' +
        'el itinerario viaja dentro de la oferta, así que hay que declarar product.segmentCount',
    );
  }
  return {
    ...(document.documentNumber === undefined ? {} : { documentNumber: document.documentNumber }),
    documentType: document.documentType,
    ...(document.documentSubType === undefined
      ? {}
      : { documentSubType: document.documentSubType }),
    ...(document.expiryDate === undefined ? {} : { expiryDate: document.expiryDate }),
    ...(document.issuingCountryCode === undefined
      ? {}
      : { issuingCountryCode: document.issuingCountryCode }),
    ...(document.residenceCountryCode === undefined
      ? {}
      : { residenceCountryCode: document.residenceCountryCode }),
    ...(document.placeOfIssue === undefined ? {} : { placeOfIssue: document.placeOfIssue }),
    ...(document.placeOfBirth === undefined ? {} : { placeOfBirth: document.placeOfBirth }),
    ...(document.hostCountryCode === undefined
      ? {}
      : { hostCountryCode: document.hostCountryCode }),
    ...(document.issueDate === undefined ? {} : { issueDate: document.issueDate }),
    ...(document.givenName === undefined ? {} : { givenName: document.givenName }),
    ...(document.middleName === undefined ? {} : { middleName: document.middleName }),
    ...(document.surname === undefined ? {} : { surname: document.surname }),
    ...(document.birthDate === undefined ? {} : { birthDate: document.birthDate }),
    ...(document.gender === undefined ? {} : { gender: document.gender }),
    ...(document.isPrimaryDocumentHolder === undefined
      ? {}
      : { isPrimaryDocumentHolder: document.isPrimaryDocumentHolder }),
    ...(document.flightPositions === undefined
      ? {}
      : { flightIndices: document.flightPositions.map((pos) => sabreIndexIn(flightSlots, pos)) }),
    ...(document.citizenshipCountryCode === undefined
      ? {}
      : { citizenshipCountryCode: document.citizenshipCountryCode }),
  };
}

function buildLoyaltyProgram(
  program: z.infer<typeof LoyaltyProgramInputSchema>,
): SabreLoyaltyProgram {
  return {
    ...(program.supplierCode === undefined ? {} : { supplierCode: program.supplierCode }),
    ...(program.programType === undefined ? {} : { programType: program.programType }),
    programNumber: program.programNumber,
    ...(program.tierLevel === undefined ? {} : { tierLevel: program.tierLevel }),
    ...(program.receiverCode === undefined ? {} : { receiverCode: program.receiverCode }),
  };
}

function buildContactInfo(
  contact: NonNullable<z.infer<typeof SabreCreateBookingInputSchema>['contactInfo']>,
): SabreBookContactInformation {
  return {
    ...(contact.emails === undefined ? {} : { emails: [...contact.emails] }),
    ...(contact.phones === undefined ? {} : { phones: [...contact.phones] }),
  };
}

function buildAgency(agency: SabreAgencyInput): SabreAgency {
  return {
    ...(agency.address === undefined ? {} : { address: { ...agency.address } }),
    ...(agency.contactInfo === undefined
      ? {}
      : {
          contactInfo: {
            ...(agency.contactInfo.emails === undefined
              ? {}
              : { emails: [...agency.contactInfo.emails] }),
            ...(agency.contactInfo.phones === undefined
              ? {}
              : { phones: [...agency.contactInfo.phones] }),
            ...(agency.contactInfo.includePhoneLabel === undefined
              ? {}
              : { includePhoneLabel: agency.contactInfo.includePhoneLabel }),
          },
        }),
    ...(agency.ticketingPolicy === undefined ? {} : { ticketingPolicy: agency.ticketingPolicy }),
    ...(agency.futureTicketingPolicy === undefined
      ? {}
      : { futureTicketingPolicy: { ...agency.futureTicketingPolicy } }),
    ...(agency.ticketingTimeLimitPolicy === undefined
      ? {}
      : { ticketingTimeLimitPolicy: { ...agency.ticketingTimeLimitPolicy } }),
    ...(agency.agencyCustomerNumber === undefined
      ? {}
      : { agencyCustomerNumber: agency.agencyCustomerNumber }),
  };
}

/**
 * Lista blanca campo a campo: el objeto de entrada **no se copia**, se reconstruye. Aunque un
 * llamador en JavaScript puro colara una clave de tarjeta —el schema `.strict()` ya la rechaza—,
 * no habría por dónde entrase al body.
 */
function buildFormOfPayment(form: z.infer<typeof FormOfPaymentSchema>): SabreFormOfPayment {
  switch (form.type) {
    case 'CASH':
      return { type: 'CASH' };
    case 'CHECK':
      return { type: 'CHECK' };
    case 'MISCELLANEOUS':
      return {
        type: 'MISCELLANEOUS',
        miscellaneousCreditCode: form.miscellaneousCreditCode,
        ...(form.extendedPayment === undefined ? {} : { extendedPayment: form.extendedPayment }),
      };
    case 'INSTALLMENTS':
      return {
        type: 'INSTALLMENTS',
        numberOfInstallments: form.numberOfInstallments,
        ...(form.airlinePlanCode === undefined ? {} : { airlinePlanCode: form.airlinePlanCode }),
        ...(form.installmentAmount === undefined
          ? {}
          : { installmentAmount: form.installmentAmount }),
        ...(form.netBalance === undefined ? {} : { netBalance: form.netBalance }),
      };
    case 'DOCKET':
      return {
        type: 'DOCKET',
        ...(form.docketPrefix === undefined ? {} : { docketPrefix: form.docketPrefix }),
        ...(form.docketNumber === undefined ? {} : { docketNumber: form.docketNumber }),
        ...(form.docketIssuingAgentInitials === undefined
          ? {}
          : { docketIssuingAgentInitials: form.docketIssuingAgentInitials }),
        ...(form.docketDescription === undefined
          ? {}
          : { docketDescription: form.docketDescription }),
      };
    case 'GOVERNMENT_TRAVEL_REQUEST':
      return {
        type: 'GOVERNMENT_TRAVEL_REQUEST',
        ...(form.governmentTravelRequestDescription === undefined
          ? {}
          : { governmentTravelRequestDescription: form.governmentTravelRequestDescription }),
      };
    case 'INVOICE':
      return {
        type: 'INVOICE',
        ...(form.invoiceDescription === undefined
          ? {}
          : { invoiceDescription: form.invoiceDescription }),
        ...(form.addInvoiceDescriptionPrefix === undefined
          ? {}
          : { addInvoiceDescriptionPrefix: form.addInvoiceDescriptionPrefix }),
      };
  }
}

/**
 * Zod en el borde, y el mensaje **sin valores**: sólo ruta del campo y código de la incidencia.
 *
 * `issue.message` de Zod puede citar el dato ("Invalid email: juan@…"), y este payload lleva
 * pasaportes y fechas de nacimiento. Un error de validación acaba en un log estructurado y en la
 * pantalla del agente; el que lea la línea tiene que saber QUÉ campo falla, no qué valor traía.
 */
function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  // El cast no es decorativo: con `T extends z.ZodTypeAny`, `parsed.data` es `any`, y devolverlo
  // sin más apagaría el tipado en cada llamada al builder.
  if (parsed.success) return parsed.data as z.infer<T>;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
    .join(', ');
  throw new SabreCreateBookingError(`${what} no cumple el contrato de Sabre (${detail})`);
}
