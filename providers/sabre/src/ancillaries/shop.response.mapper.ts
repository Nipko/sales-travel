import { createHash } from 'node:crypto';
import {
  AncillaryCatalogSchema,
  type AncillaryCatalog,
  type AncillaryCategory,
  type AncillaryCharge,
  type AncillaryNotSellableReason,
  type AncillaryOffer,
  type AncillarySegment,
  type AncillaryWeight,
  type Money,
  type PaxType,
} from '@sales-travel/canonical';
import { z } from 'zod';
import { sabreAncillaryZodIssues } from './shop.request.builder';

/**
 * `AncillaryShopResponse` (`stateless-ancillaries-api-1.0.yml:259-301`) → `AncillaryCatalog`.
 *
 * La respuesta es un grafo de referencias y el mapper lo resuelve entero antes de prometer nada:
 *
 *   offers[].items[] ──details.ancillaryReferenceId──▶ ancillaries[]   (qué servicio)
 *                    ──segmentReferenceIds / itineraryPart / itinerary──▶ segments[] (qué tramos)
 *                    ──passengerReferenceIds──▶ passengers[]          (para quién)
 *                    ──price.unitPrices[]──▶ precio por pasajero
 *
 * Tres reglas que no se negocian:
 *
 * 1. **Sin `price` = incluido; `price` ilegible = no informado.** El contrato dice que un servicio
 *    sin cargo «no tiene desglose de precio» (`:604-610`). Un precio que sí viene y no se puede leer
 *    —sin moneda, negativo, con tercer decimal, ambiguo entre pasajeros— es otra cosa: no se vende.
 * 2. **Los pasajeros se cruzan por posición y tipo, nunca por nombre.** La reserva los lista por
 *    `nameNumber`, en el orden en que se mandaron al reservar. Si el número o el tipo no casa con
 *    la orden, se lanza: cobrarle a otro pasajero es peor que no mostrar nada.
 * 3. **Por código, nunca por descripción.** Categoría, venta y exclusiones salen de códigos ATPCO
 *    (`groupCode`, `reasonForIssuanceCode`, `bookingMethod`), no de `commercialName`.
 *
 * La respuesta trae nombres de pasajero (`givenName`, `surname`) y números de viajero frecuente.
 * Zod descarta todo lo no declarado, así que no pasan de esta línea.
 */

// ---------------------------------------------------------------------------
// Vocabulario del contrato
// ---------------------------------------------------------------------------

const AIRPORT = /^[A-Z]{3}$/;
const AIRLINE = /^[A-Z0-9]{2}$/;
/** `DateTime` (`:1193-1197`): hora local, sin zona. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
/** `SegmentReference` (`:1188-1192`). */
const SEGMENT_ID = /^[A-Z0-9-]{5,6}$/;
/** `PassengerReference` (`:1222-1226`), que el contrato sólo ancla por el principio. */
const PASSENGER_ID = /^[A-Z0-9-]{5,12}$/;
/** `Itinerary.id` (`:908-911`) e `ItineraryPartReference` (`:1183-1187`). */
const ITINERARY_ID = /^[A-Z0-9-]{3,5}$/;
const ITINERARY_PART_ID = /^[A-Z0-9-]{4,5}$/;
/** `Passenger.nameNumber` (`:1033-1037`): `01.01`. */
const NAME_NUMBER = /^(\d{1,3})\.(\d{1,2})$/;
/** Código ATPCO de tipo de pasajero. El contrato dice `^[A-Z]{3}$`; `C05` (niño de 5) es real. */
const PTC = /^[A-Z0-9]{3}$/;
/** `bookingFlightNumber` no tiene patrón; los ejemplos son `0824`, `133` y hasta `1B33`. */
const RAW_FLIGHT_NUMBER = /^[0-9A-Z]{1,5}$/;
const CANONICAL_FLIGHT_NUMBER = /^\d{1,4}[A-Z]?$/;
const BOOKING_CLASS = /^[A-Z]{1,2}$/;
/** `brandCode` sólo ancla dos caracteres por el principio (`:984-988`). */
const BRAND = /^[A-Za-z0-9]{2,12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(\d{1,12})(?:\.(\d{1,3}))?$/;

/**
 * Ids opacos de Sabre sin patrón en el contrato (oferta, ítem, ancillary). Se aceptan con forma
 * de id y sin una tirada de 13 dígitos o más, que es la ventana de un PAN (D1): un UUID nunca la
 * tiene, porque sus bloques más largos son de 12.
 */
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PAN_WINDOW_DIGIT_RUN = /[0-9]{13,}/;
/**
 * Texto libre que se muestra o se devuelve en el alta (`commercialName`, `groupName`, `bagType`).
 * Ningún nombre comercial real lleva nueve dígitos seguidos; el que los traiga se omite (D1).
 */
const PAN_LIKE_DIGIT_RUN = /[0-9]{9,}/;

const SEGMENT_STATUS_NAMES = [
  'Confirmed',
  'Waitlisted',
  'OnRequest',
  'Pending',
  'Cancelled',
  'InfantWithNoSeat',
  'PriorityWaitlist',
  'Quote',
  'SpaceAvailable',
  'Unconfirmed',
  'PendingQuote',
  'NoSeat',
  'Standby',
  'Unknown',
] as const;

const REASON_FOR_ISSUANCE = [
  'AirTransportation',
  'GroundTransportNonAirServices',
  'Baggage',
  'FinancialImpact',
  'AirportServices',
  'Merchandise',
  'InFlightServices',
  'IndividualAirlineUse',
  'Other',
  'Unknown',
] as const;

const EMD_TYPES = [
  'Standalone',
  'FlightCouponAssociated',
  'StandaloneTicketAssociated',
  'OtherThanEmd',
  'ETicket',
  'Unknown',
] as const;

const BOOKING_METHODS = [
  'SpecialServiceRequest',
  'AuxiliarySegment',
  'ContactAirline',
  'NoBookingRequired',
  'PerServiceRecord',
  'AnyAllowed',
  'Unknown',
] as const;

const SERVICE_TYPES = [
  'FlightRelated',
  'Charges',
  'BaggageAllowance',
  'CarryOnBaggageAllowance',
  'Embargoes',
  'Prepaid',
  'Disclosure',
  'PreRegisteredBaggage',
  'Unknown',
] as const;

const SPECIAL_SERVICE_TYPES = [
  'Structured',
  'NotAllowed',
  'Optional',
  'Required',
  'Unknown',
] as const;

/** `SectorPortionIndicatorEnum` (`:1901-1908`). */
const SECTOR_PORTION = ['Sector', 'Portion', 'Journey'] as const;

/** Grupo ATPCO de la asignación de asiento: se elige en el mapa (SAB-15/16), no aquí. */
const GROUP_SEAT = 'SA';

const CATEGORY_BY_GROUP: Readonly<Record<string, AncillaryCategory>> = {
  BG: 'BAGGAGE',
  ML: 'MEAL',
  LG: 'LOUNGE',
  PT: 'PET',
};

/** PADIS 4183 (`:379-394`): `C` = equipaje, `D` = impacto financiero (cargos). */
const RFIC_BAGGAGE = 'C';
const RFIC_FINANCIAL_IMPACT = 'D';

/** Versión del formato de `serviceOfferItemId`. Cambiar las claves obliga a subirla. */
export const SABRE_ANCILLARY_OFFER_REF_VERSION = 'SA1';

/**
 * Las formas que se aceptan al LEER y las que se exigen al REENVIAR en el alta son las mismas, y
 * por eso viven en un solo sitio: dos copias de un patrón acaban dejando pasar al cable algo que
 * la lectura ya había descartado.
 */
export const SABRE_ANCILLARY_WIRE_PATTERNS = Object.freeze({
  airport: AIRPORT,
  airline: AIRLINE,
  dateTime: DATE_TIME,
  segmentId: SEGMENT_ID,
  passengerId: PASSENGER_ID,
  itineraryId: ITINERARY_ID,
  itineraryPartId: ITINERARY_PART_ID,
  nameNumber: NAME_NUMBER,
  ptc: PTC,
  rawFlightNumber: RAW_FLIGHT_NUMBER,
  bookingClass: BOOKING_CLASS,
  brand: BRAND,
  currency: CURRENCY,
  amount: AMOUNT,
  opaqueId: OPAQUE_ID,
  panWindowDigitRun: PAN_WINDOW_DIGIT_RUN,
  panLikeDigitRun: PAN_LIKE_DIGIT_RUN,
});

export const SABRE_ANCILLARY_ENUMS = Object.freeze({
  segmentStatusNames: SEGMENT_STATUS_NAMES,
  reasonForIssuance: REASON_FOR_ISSUANCE,
  emdTypes: EMD_TYPES,
  bookingMethods: BOOKING_METHODS,
  serviceTypes: SERVICE_TYPES,
  specialServiceTypes: SPECIAL_SERVICE_TYPES,
  sectorPortion: SECTOR_PORTION,
});

// ---------------------------------------------------------------------------
// Esquemas de lectura
// ---------------------------------------------------------------------------

/** Campo opcional que sólo se reenvía: con mala forma se omite, no tumba la respuesta. */
function optionalToken(pattern: RegExp, guard: RegExp | undefined = undefined) {
  return z
    .string()
    .regex(pattern)
    .refine((value) => guard === undefined || !guard.test(value))
    .optional()
    .catch(undefined);
}

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !PAN_LIKE_DIGIT_RUN.test(value))
    .optional()
    .catch(undefined);
}

const OpaqueIdSchema = z
  .string()
  .regex(OPAQUE_ID)
  .refine((value) => !PAN_WINDOW_DIGIT_RUN.test(value));

/**
 * `Segment` (`:939-1022`). Lo que el catálogo necesita para ubicar el vuelo es obligatorio y su
 * forma rota rechaza la respuesta; lo demás sólo se devuelve en el alta, y si viene con mala forma
 * se omite en vez de reenviarse.
 */
const SegmentSchema = z.object({
  id: z.string().regex(SEGMENT_ID),
  departureDateTime: z.string().regex(DATE_TIME),
  departureAirportCode: z.string().regex(AIRPORT),
  arrivalAirportCode: z.string().regex(AIRPORT),
  bookingAirlineCode: z.string().regex(AIRLINE),
  bookingFlightNumber: z.string().regex(RAW_FLIGHT_NUMBER),
  arrivalDateTime: optionalToken(DATE_TIME),
  operatingAirlineCode: optionalToken(AIRLINE),
  isElectronicTicket: z.boolean().optional().catch(undefined),
  brandCode: optionalToken(BRAND, PAN_LIKE_DIGIT_RUN),
  bookingClassCode: optionalToken(BOOKING_CLASS),
  operatingFlightNumber: optionalToken(RAW_FLIGHT_NUMBER),
  operatingBookingClassCode: optionalToken(BOOKING_CLASS),
  sequence: z.number().int().positive().optional().catch(undefined),
  statusCode: optionalToken(/^[A-Z]{2}$/),
  statusName: z.enum(SEGMENT_STATUS_NAMES).optional().catch(undefined),
  isInboundConnection: z.boolean().optional().catch(undefined),
  isOutboundConnection: z.boolean().optional().catch(undefined),
});

/** `Passenger` (`:1023-1069`) sin nombres, SSR ni viajero frecuente. */
const PassengerSchema = z.object({
  id: z.string().regex(PASSENGER_ID),
  nameNumber: z.string().regex(NAME_NUMBER),
  typeCode: optionalToken(PTC),
});

const ItinerarySchema = z.object({
  id: z.string().regex(ITINERARY_ID),
  itineraryPartReferenceIds: z.array(z.string().regex(ITINERARY_PART_ID)).min(1).max(8),
});

const ItineraryPartSchema = z.object({
  id: z.string().regex(ITINERARY_PART_ID),
  segmentReferenceIds: z.array(z.string().regex(SEGMENT_ID)).min(1).max(16),
});

const OfferSchema = z.object({
  id: OpaqueIdSchema.optional(),
  items: z.array(z.unknown()).min(1),
});

/** `AmountCurrency` (`:1547-1561`): el importe es texto (`'100.00'`); la ayuda lo manda como número. */
const AmountCurrencySchema = z.object({
  amount: z.union([z.string(), z.number()]),
  currencyCode: z.string(),
});

/** `UnitPrice` (`:1467-1488`). Sólo `total.amount` decide el precio. */
const UnitPriceSchema = z.object({
  total: z.object({ amount: AmountCurrencySchema }),
  totalBreakdown: z
    .object({ base: z.object({ amount: AmountCurrencySchema }).optional() })
    .optional()
    .catch(undefined),
  passengerReferenceIds: z.array(z.string().regex(PASSENGER_ID)).min(1).max(9).optional(),
});

const OfferPriceSchema = z.object({ unitPrices: z.array(UnitPriceSchema).min(1) });

/** `OfferItem` (`:1253-1303`) con `details` de `AncillaryOfferItem` (`:1856-1876`). */
const OfferItemSchema = z.object({
  id: OpaqueIdSchema,
  itineraryReferenceId: z.string().regex(ITINERARY_ID).optional(),
  itineraryPartReferenceIds: z.array(z.string().regex(ITINERARY_PART_ID)).max(8).optional(),
  segmentReferenceIds: z.array(z.string().regex(SEGMENT_ID)).max(16).optional(),
  passengerReferenceIds: z.array(z.string().regex(PASSENGER_ID)).max(9).optional(),
  details: z.object({
    type: z.literal('AncillaryOfferItem'),
    ancillaryReferenceId: OpaqueIdSchema,
    quantity: z.number().int().optional(),
    isAvailable: z.boolean().optional().catch(undefined),
    sectorPortionIndicator: z.enum(SECTOR_PORTION).optional().catch(undefined),
  }),
  price: z.unknown().optional(),
});

const ItemKindSchema = z.object({ details: z.object({ type: z.string() }) });

/** `OfferItemTypeEnum` (`:1460-1466`) menos el nuestro. Otro valor no se repite en el aviso. */
const OTHER_ITEM_TYPES: ReadonlySet<string> = new Set(['AirOfferItem', 'SeatOfferItem']);

/** `Ancillary` (`:349-451`). */
const AncillarySchema = z.object({
  id: OpaqueIdSchema,
  groupCode: optionalToken(/^[0-9A-Z]{2}$/),
  groupName: optionalText(80),
  subCode: z.string().regex(/^[0-9A-Z]{3}$/),
  ssimCode: optionalToken(/^[0-9A-Z]{1,5}$/),
  reasonForIssuanceCode: optionalToken(/^[A-I]$/),
  reasonForIssuance: z.enum(REASON_FOR_ISSUANCE).optional().catch(undefined),
  commercialName: optionalText(160),
  airlineCode: z.string().regex(AIRLINE),
  specialService: z
    .object({
      code: z
        .string()
        .regex(/^[A-Z0-9]{1,20}$/)
        .refine((value) => !PAN_LIKE_DIGIT_RUN.test(value)),
      type: z.enum(SPECIAL_SERVICE_TYPES).optional().catch(undefined),
      requiredProperties: z.unknown().optional(),
    })
    .optional(),
  vendorCode: optionalToken(/^[0-9A-Z]{1,5}$/),
  emdType: z
    .object({
      code: optionalToken(/^[0-9A-Z]{1,3}$/),
      value: z.enum(EMD_TYPES),
      isConsumedAtIssuance: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  bookingMethod: z
    .object({ code: optionalToken(/^[0-9A-Z]{1,3}$/), value: z.enum(BOOKING_METHODS) })
    .optional(),
  serviceTypeCode: optionalToken(/^[0-9A-Z]$/),
  serviceType: z.enum(SERVICE_TYPES).optional().catch(undefined),
  isDisplayOnly: z.boolean().optional(),
  weights: z
    .array(z.object({ value: z.number().int().positive(), unit: z.enum(['Kilogram', 'Pound']) }))
    .min(1)
    .optional()
    .catch(undefined),
  bagType: optionalText(40),
  ancillaryRule: z
    .object({
      isRefundable: z.boolean().optional().catch(undefined),
      freeOfChargeRules: z
        .array(z.enum(['BookingRequired', 'EmdRequired']))
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  bundledAncillaryRefs: z.array(z.string()).optional(),
});

/** `AncillaryShopResponse`. Ofertas y definiciones se validan una a una: una rota no tumba el resto. */
export const SabreAncillaryShopResponseSchema = z.object({
  itinerary: ItinerarySchema.optional().catch(undefined),
  itineraryParts: z.array(z.unknown()).optional(),
  segments: z.array(SegmentSchema).min(1).max(16).optional(),
  passengers: z.array(PassengerSchema).min(1).max(9).optional(),
  offers: z.array(z.unknown()).optional(),
  ancillaries: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
  warnings: z.array(z.unknown()).optional(),
});

export type SabreAncillaryShopSegment = z.infer<typeof SegmentSchema>;
export type SabreAncillaryShopPassenger = z.infer<typeof PassengerSchema>;
export type SabreAncillaryShopItinerary = z.infer<typeof ItinerarySchema>;
export type SabreAncillaryShopItineraryPart = z.infer<typeof ItineraryPartSchema>;
export type SabreAncillaryShopOfferItem = z.infer<typeof OfferItemSchema>;
export type SabreAncillaryShopUnitPrice = z.infer<typeof UnitPriceSchema>;
export type SabreAncillaryShopAncillary = z.infer<typeof AncillarySchema>;

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export type SabreAncillaryShopWarningCode =
  /** Sabre devolvió `warnings[]` en la raíz. Su texto puede llevar datos: sólo se cuenta. */
  | 'provider-warning'
  /** Ninguna oferta llegó al catálogo. */
  | 'catalog-empty'
  /** Sabre no informó el tipo de algún pasajero: el cruce con la orden quedó sólo por posición. */
  | 'passenger-type-unverified'
  /** Los segmentos no traen `sequence` completo y único: se ordenan como vienen. */
  | 'segment-order-unverified'
  | 'offer-invalid'
  | 'offer-item-invalid'
  /** El ítem es de vuelo o de asiento, no de ancillary. */
  | 'offer-item-not-ancillary'
  | 'offer-item-ancillary-missing'
  /** Asignación de asiento: se vende por el mapa de asientos, con número de asiento. */
  | 'seat-ancillary-skipped'
  | 'offer-item-segment-unresolved'
  | 'offer-item-passenger-unknown'
  | 'offer-item-passenger-unresolved'
  | 'offer-item-quantity-invalid'
  /** Dos ítems describen la misma compra al mismo precio: se queda el primero. */
  | 'offer-item-duplicate'
  | 'ancillary-invalid'
  | 'ancillary-duplicate'
  | 'itinerary-part-invalid'
  /** Precio presente e ilegible para algún pasajero: queda «no informado» y no se vende. */
  | 'ancillary-price-undetermined'
  /** Sin precio y sin regla de cargo cero declarada: se toma como incluido, y se avisa. */
  | 'included-without-free-of-charge-rule';

export interface SabreAncillaryShopWarning {
  readonly code: SabreAncillaryShopWarningCode;
  /** Ruta dentro de la respuesta. Nunca un valor. */
  readonly path: string;
  readonly detail?: string;
}

export interface SabreAncillaryShopMapContext {
  /** El PNR consultado. Entra en la identidad de cada oferta: no se puede reutilizar en otro. */
  readonly pnrLocator: string;
  /** Pasajeros de la orden, en el orden en que se reservaron. */
  readonly passengers: readonly { readonly paxType: PaxType }[];
}

/** Lo que el alta necesita reenviar (modo recurso), ya validado y sin nombres. */
export interface SabreAncillaryShopSnapshot {
  readonly pnrLocator: string;
  readonly itinerary: SabreAncillaryShopItinerary | undefined;
  readonly itineraryParts: readonly SabreAncillaryShopItineraryPart[];
  readonly segments: readonly SabreAncillaryShopSegment[];
  readonly passengers: readonly SabreAncillaryShopPassenger[];
}

/** Una oferta del catálogo atada al ítem de Sabre del que sale. */
export interface SabreAncillaryOfferBinding {
  readonly offer: AncillaryOffer;
  readonly semanticKey: string;
  readonly offerId: string | undefined;
  readonly item: SabreAncillaryShopOfferItem;
  readonly ancillary: SabreAncillaryShopAncillary;
  /**
   * El `unitPrice` de Sabre del que sale el precio de cada pasajero, ya validado. Un pasajero sin
   * entrada no tiene precio que reenviar: su servicio es incluido (o no informado, y entonces la
   * oferta no se vende).
   */
  readonly unitPriceByIndex: ReadonlyMap<number, SabreAncillaryShopUnitPrice>;
  /** `passengerIndex` → `Passenger.id` de Sabre. */
  readonly passengerRefByIndex: ReadonlyMap<number, string>;
}

export interface SabreAncillaryShopMapResult {
  readonly catalog: AncillaryCatalog;
  readonly warnings: readonly SabreAncillaryShopWarning[];
  readonly snapshot: SabreAncillaryShopSnapshot;
  /** `serviceOfferItemId` → su ítem. */
  readonly bindings: ReadonlyMap<string, SabreAncillaryOfferBinding>;
  /**
   * Resumen de la identidad SIN precio de cada oferta presente (la parte central de
   * `serviceOfferItemId`). Distingue «cambió el precio» de «ya no se ofrece».
   */
  readonly semanticDigests: ReadonlySet<string>;
}

/** Respuesta fuera de contrato. Rutas y códigos de Zod, nunca valores. */
export class SabreAncillaryMappingError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`respuesta de ancillares fuera de contrato (${issues.join(', ') || '<root>'})`);
    this.name = 'SabreAncillaryMappingError';
  }
}

/** Respuesta con `errors[]`. Sólo se conserva cuántos: su texto puede llevar datos. */
export class SabreAncillaryRejectedError extends Error {
  constructor(readonly errorCount: number) {
    super(`Sabre devolvió ${String(errorCount)} error(es) de ancillares`);
    this.name = 'SabreAncillaryRejectedError';
  }
}

/**
 * Los pasajeros de la reserva no casan con los de la orden. Se lanza en vez de cruzarlos por
 * aproximación: un servicio cobrado a otro pasajero no se arregla después.
 */
export class SabreAncillaryPassengerMismatchError extends Error {
  constructor(
    readonly reason: 'count' | 'type',
    readonly detail: {
      readonly expectedCount?: number;
      readonly receivedCount?: number;
      /** Índice (en la orden) del primer pasajero cuyo tipo no casa. */
      readonly position?: number;
    },
  ) {
    super(
      reason === 'count'
        ? `la reserva tiene ${String(detail.receivedCount)} pasajero(s) y la orden ${String(detail.expectedCount)}`
        : `el tipo del pasajero ${String(detail.position)} de la reserva no coincide con la orden`,
    );
    this.name = 'SabreAncillaryPassengerMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export function mapSabreAncillaryShopResponse(
  raw: unknown,
  ctx: SabreAncillaryShopMapContext,
): SabreAncillaryShopMapResult {
  const parsed = SabreAncillaryShopResponseSchema.safeParse(raw);
  if (!parsed.success) throw new SabreAncillaryMappingError(sabreAncillaryZodIssues(parsed.error));
  const envelope = parsed.data;
  if ((envelope.errors?.length ?? 0) > 0) {
    throw new SabreAncillaryRejectedError(envelope.errors?.length ?? 0);
  }
  if (envelope.segments === undefined) throw new SabreAncillaryMappingError(['segments:required']);
  if (envelope.passengers === undefined) {
    throw new SabreAncillaryMappingError(['passengers:required']);
  }

  const warnings: SabreAncillaryShopWarning[] = [];
  if ((envelope.warnings?.length ?? 0) > 0) {
    warnings.push({ code: 'provider-warning', path: 'warnings' });
  }

  const segments = orderSegments(envelope.segments, warnings);
  const segmentIndexById = new Map(segments.map((segment, index) => [segment.id, index]));
  const catalogSegments = segments.map(toCatalogSegment);

  const passengerIndexById = bindPassengers(envelope.passengers, ctx.passengers, warnings);
  const nameNumberById = new Map(envelope.passengers.map((pax) => [pax.id, pax.nameNumber]));

  const itineraryParts = readItineraryParts(envelope.itineraryParts, warnings);
  const ancillaries = readAncillaries(envelope.ancillaries, warnings);

  const resolver: ReferenceResolver = {
    segmentIndexById,
    itinerary: envelope.itinerary,
    partById: new Map(itineraryParts.map((part) => [part.id, part])),
  };

  const offers: AncillaryOffer[] = [];
  const bindings = new Map<string, SabreAncillaryOfferBinding>();
  const semanticDigests = new Set<string>();

  (envelope.offers ?? []).forEach((rawOffer, offerIndex) => {
    const offerPath = `offers.${String(offerIndex)}`;
    const offer = OfferSchema.safeParse(rawOffer);
    if (!offer.success) {
      warnings.push({ code: 'offer-invalid', path: offerPath });
      return;
    }
    offer.data.items.forEach((rawItem, itemIndex) => {
      const binding = mapOfferItem(rawItem, {
        path: `${offerPath}.items.${String(itemIndex)}`,
        offerId: offer.data.id,
        ctx,
        ancillaries,
        resolver,
        passengerIndexById,
        nameNumberById,
        segments,
        warnings,
      });
      if (binding === undefined) return;
      if (bindings.has(binding.offer.serviceOfferItemId)) {
        warnings.push({
          code: 'offer-item-duplicate',
          path: `${offerPath}.items.${String(itemIndex)}`,
        });
        return;
      }
      bindings.set(binding.offer.serviceOfferItemId, binding);
      semanticDigests.add(digest(binding.semanticKey));
      offers.push(binding.offer);
    });
  });

  if (offers.length === 0) warnings.push({ code: 'catalog-empty', path: 'offers' });

  const candidate: AncillaryCatalog = {
    segments: catalogSegments,
    offers,
    warnings: [...new Set(warnings.map((warning) => warning.code))],
  };
  const checked = AncillaryCatalogSchema.safeParse(candidate);
  if (!checked.success) {
    throw new SabreAncillaryMappingError(
      checked.error.issues.map(
        (issue) => `canonical.${issue.path.join('.') || '<root>'}:${issue.code}`,
      ),
    );
  }

  return {
    catalog: checked.data,
    warnings,
    snapshot: {
      pnrLocator: ctx.pnrLocator,
      itinerary: envelope.itinerary,
      itineraryParts,
      segments,
      passengers: envelope.passengers,
    },
    bindings,
    semanticDigests,
  };
}

// ---------------------------------------------------------------------------
// Segmentos y pasajeros
// ---------------------------------------------------------------------------

/**
 * Orden de vuelo: por `sequence` (el número de segmento del PNR) cuando todos lo traen y no se
 * repite; si no, como vienen, y se avisa. Un id repetido rompe todas las referencias: se rechaza.
 */
function orderSegments(
  segments: readonly SabreAncillaryShopSegment[],
  warnings: SabreAncillaryShopWarning[],
): SabreAncillaryShopSegment[] {
  if (new Set(segments.map((segment) => segment.id)).size !== segments.length) {
    throw new SabreAncillaryMappingError(['segments.id:duplicate']);
  }
  const sequences = segments.map((segment) => segment.sequence);
  const complete = sequences.every((sequence) => sequence !== undefined);
  if (complete && new Set(sequences).size === sequences.length) {
    return [...segments].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }
  if (segments.length > 1) warnings.push({ code: 'segment-order-unverified', path: 'segments' });
  return [...segments];
}

function toCatalogSegment(segment: SabreAncillaryShopSegment, index: number): AncillarySegment {
  const flightNumber = segment.bookingFlightNumber.replace(/^0+(?=\d)/, '');
  if (!CANONICAL_FLIGHT_NUMBER.test(flightNumber)) {
    throw new SabreAncillaryMappingError([`segments.${String(index)}.bookingFlightNumber:invalid`]);
  }
  return {
    origin: segment.departureAirportCode,
    destination: segment.arrivalAirportCode,
    departureAt: segment.departureDateTime,
    carrier: segment.bookingAirlineCode,
    flightNumber,
  };
}

/**
 * `Passenger.id` de Sabre → índice de la orden, por `nameNumber` y tipo.
 *
 * La reserva numera los nombres en el orden en que se mandaron (`01.01`, `02.01`, …), que es el de
 * la orden. Se exige el mismo número de pasajeros y, si Sabre informa el tipo, el mismo tipo en la
 * misma posición. Dos adultos no se distinguen así; sí un adulto de un niño o de un infante, que
 * es donde cambia lo que se puede comprar.
 */
function bindPassengers(
  passengers: readonly SabreAncillaryShopPassenger[],
  expected: readonly { readonly paxType: PaxType }[],
  warnings: SabreAncillaryShopWarning[],
): Map<string, number> {
  if (
    new Set(passengers.map((pax) => pax.id)).size !== passengers.length ||
    new Set(passengers.map((pax) => pax.nameNumber)).size !== passengers.length
  ) {
    throw new SabreAncillaryMappingError(['passengers:duplicate']);
  }
  if (passengers.length !== expected.length) {
    throw new SabreAncillaryPassengerMismatchError('count', {
      expectedCount: expected.length,
      receivedCount: passengers.length,
    });
  }

  const ordered = [...passengers].sort(
    (a, b) => nameNumberRank(a.nameNumber) - nameNumberRank(b.nameNumber),
  );
  const byId = new Map<string, number>();
  let unverified = false;
  ordered.forEach((pax, index) => {
    const paxType = expected[index]?.paxType;
    if (pax.typeCode === undefined) {
      unverified = true;
    } else if (paxType === undefined || !ptcMatches(paxType, pax.typeCode)) {
      throw new SabreAncillaryPassengerMismatchError('type', { position: index });
    }
    byId.set(pax.id, index);
  });
  if (unverified) warnings.push({ code: 'passenger-type-unverified', path: 'passengers' });
  return byId;
}

function nameNumberRank(nameNumber: string): number {
  const match = NAME_NUMBER.exec(nameNumber);
  return Number(match?.[1] ?? 0) * 100 + Number(match?.[2] ?? 0);
}

function ptcMatches(paxType: PaxType, ptc: string): boolean {
  if (paxType === 'ADT') return ptc === 'ADT';
  if (paxType === 'CHD') return ptc === 'CNN' || ptc === 'CHD' || /^C\d{2}$/.test(ptc);
  return ptc === 'INF' || ptc === 'INS';
}

// ---------------------------------------------------------------------------
// Definiciones e itinerario
// ---------------------------------------------------------------------------

function readItineraryParts(
  raw: readonly unknown[] | undefined,
  warnings: SabreAncillaryShopWarning[],
): SabreAncillaryShopItineraryPart[] {
  const parts: SabreAncillaryShopItineraryPart[] = [];
  (raw ?? []).forEach((entry, index) => {
    const part = ItineraryPartSchema.safeParse(entry);
    if (part.success) parts.push(part.data);
    else warnings.push({ code: 'itinerary-part-invalid', path: `itineraryParts.${String(index)}` });
  });
  return parts;
}

function readAncillaries(
  raw: readonly unknown[] | undefined,
  warnings: SabreAncillaryShopWarning[],
): Map<string, SabreAncillaryShopAncillary> {
  const byId = new Map<string, SabreAncillaryShopAncillary>();
  (raw ?? []).forEach((entry, index) => {
    const path = `ancillaries.${String(index)}`;
    const ancillary = AncillarySchema.safeParse(entry);
    if (!ancillary.success) {
      warnings.push({ code: 'ancillary-invalid', path });
      return;
    }
    if (byId.has(ancillary.data.id)) {
      warnings.push({ code: 'ancillary-duplicate', path });
      return;
    }
    byId.set(ancillary.data.id, ancillary.data);
  });
  return byId;
}

// ---------------------------------------------------------------------------
// Ítems
// ---------------------------------------------------------------------------

interface ReferenceResolver {
  readonly segmentIndexById: ReadonlyMap<string, number>;
  readonly itinerary: SabreAncillaryShopItinerary | undefined;
  readonly partById: ReadonlyMap<string, SabreAncillaryShopItineraryPart>;
}

interface ItemContext {
  readonly path: string;
  readonly offerId: string | undefined;
  readonly ctx: SabreAncillaryShopMapContext;
  readonly ancillaries: ReadonlyMap<string, SabreAncillaryShopAncillary>;
  readonly resolver: ReferenceResolver;
  readonly passengerIndexById: ReadonlyMap<string, number>;
  readonly nameNumberById: ReadonlyMap<string, string>;
  readonly segments: readonly SabreAncillaryShopSegment[];
  readonly warnings: SabreAncillaryShopWarning[];
}

function mapOfferItem(raw: unknown, ic: ItemContext): SabreAncillaryOfferBinding | undefined {
  const warn = (code: SabreAncillaryShopWarningCode, detail?: string): undefined => {
    ic.warnings.push({ code, path: ic.path, ...(detail === undefined ? {} : { detail }) });
    return undefined;
  };

  const kind = ItemKindSchema.safeParse(raw);
  if (kind.success && kind.data.details.type !== 'AncillaryOfferItem') {
    const type = kind.data.details.type;
    return warn('offer-item-not-ancillary', OTHER_ITEM_TYPES.has(type) ? type : 'otro');
  }
  const parsed = OfferItemSchema.safeParse(raw);
  if (!parsed.success) return warn('offer-item-invalid');
  const item = parsed.data;

  const ancillary = ic.ancillaries.get(item.details.ancillaryReferenceId);
  if (ancillary === undefined) return warn('offer-item-ancillary-missing');
  if (ancillary.groupCode === GROUP_SEAT) return warn('seat-ancillary-skipped');

  const segmentRefs = resolveSegments(item, ic.resolver);
  if (segmentRefs === undefined) return warn('offer-item-segment-unresolved');

  const quantity = item.details.quantity ?? 1;
  if (quantity < 1) return warn('offer-item-quantity-invalid');

  if (item.passengerReferenceIds === undefined || item.passengerReferenceIds.length === 0) {
    return warn('offer-item-passenger-unresolved');
  }
  const passengerRefByIndex = new Map<number, string>();
  for (const ref of new Set(item.passengerReferenceIds)) {
    const index = ic.passengerIndexById.get(ref);
    if (index === undefined) {
      warn('offer-item-passenger-unknown');
      continue;
    }
    passengerRefByIndex.set(index, ref);
  }
  if (passengerRefByIndex.size === 0) return warn('offer-item-passenger-unresolved');

  const unitPrices = readUnitPrices(item.price);
  const unitPriceByIndex = new Map<number, SabreAncillaryShopUnitPrice>();
  const passengers = [...passengerRefByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([passengerIndex, ref]) => {
      const priced = chargeFor(unitPrices, ref, (detail) =>
        warn('ancillary-price-undetermined', detail),
      );
      if (priced.unitPrice !== undefined) unitPriceByIndex.set(passengerIndex, priced.unitPrice);
      return { passengerIndex, charge: priced.charge };
    });
  if (unitPrices === undefined && (ancillary.ancillaryRule?.freeOfChargeRules ?? []).length === 0) {
    warn('included-without-free-of-charge-rule');
  }

  const notSellableReason = notSellableReasonOf(item, ancillary, passengers);
  const semanticKey = semanticKeyOf(item, ancillary, segmentRefs, passengerRefByIndex, ic);
  const pricedKey = pricedKeyOf(semanticKey, passengers);
  const serviceOfferItemId = `${SABRE_ANCILLARY_OFFER_REF_VERSION}.${digest(semanticKey)}.${digest(pricedKey)}`;

  const offer: AncillaryOffer = {
    serviceOfferItemId,
    category: categoryOf(ancillary),
    name: ancillary.commercialName ?? ancillary.groupName ?? ancillary.subCode,
    serviceCode: ancillary.subCode,
    airlineCode: ancillary.airlineCode,
    segmentRefs,
    passengers,
    quantity,
    weights: weightsOf(ancillary),
    ...(ancillary.ancillaryRule?.isRefundable === undefined
      ? {}
      : { refundable: ancillary.ancillaryRule.isRefundable }),
    sellable: notSellableReason === undefined,
    ...(notSellableReason === undefined ? {} : { notSellableReason }),
  };

  return {
    offer,
    semanticKey,
    offerId: ic.offerId,
    item,
    ancillary,
    unitPriceByIndex,
    passengerRefByIndex,
  };
}

/**
 * Tramos de un ítem: por segmentos; si no, por partes del itinerario; si no, por el itinerario
 * entero. Una referencia que no existe invalida el ítem: venderlo para «algunos tramos» no es lo
 * que la aerolínea ofreció.
 */
function resolveSegments(
  item: SabreAncillaryShopOfferItem,
  resolver: ReferenceResolver,
): number[] | undefined {
  let segmentIds: readonly string[] | undefined;
  if (item.segmentReferenceIds !== undefined && item.segmentReferenceIds.length > 0) {
    segmentIds = item.segmentReferenceIds;
  } else if (
    item.itineraryPartReferenceIds !== undefined &&
    item.itineraryPartReferenceIds.length > 0
  ) {
    segmentIds = segmentsOfParts(item.itineraryPartReferenceIds, resolver);
  } else if (
    item.itineraryReferenceId !== undefined &&
    resolver.itinerary?.id === item.itineraryReferenceId
  ) {
    segmentIds = segmentsOfParts(resolver.itinerary.itineraryPartReferenceIds, resolver);
  }
  if (segmentIds === undefined || segmentIds.length === 0) return undefined;

  const indexes: number[] = [];
  for (const id of segmentIds) {
    const index = resolver.segmentIndexById.get(id);
    if (index === undefined) return undefined;
    if (!indexes.includes(index)) indexes.push(index);
  }
  return indexes.sort((a, b) => a - b);
}

function segmentsOfParts(
  partIds: readonly string[],
  resolver: ReferenceResolver,
): string[] | undefined {
  const ids: string[] = [];
  for (const partId of partIds) {
    const part = resolver.partById.get(partId);
    if (part === undefined) return undefined;
    ids.push(...part.segmentReferenceIds);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Precio
// ---------------------------------------------------------------------------

/**
 * `undefined` = el ítem no trae `price` (incluido). `null` = trae `price` y no se puede leer.
 * Son dos respuestas distintas a propósito: sólo la primera se puede vender como sin cargo.
 */
function readUnitPrices(price: unknown): SabreAncillaryShopUnitPrice[] | null | undefined {
  if (price === undefined) return undefined;
  const parsed = OfferPriceSchema.safeParse(price);
  return parsed.success ? parsed.data.unitPrices : null;
}

/**
 * El precio de UN pasajero: el `unitPrice` que lo nombra, o el único que no nombra a nadie (el
 * contrato dice que entonces aplica a todos, `:1482-1488`). Ninguno o más de uno es «no informado».
 */
function chargeFor(
  unitPrices: readonly SabreAncillaryShopUnitPrice[] | null | undefined,
  passengerRef: string,
  undetermined: (detail: string) => void,
): { readonly charge: AncillaryCharge; readonly unitPrice?: SabreAncillaryShopUnitPrice } {
  if (unitPrices === undefined) return { charge: { type: 'INCLUDED' } };
  const notInformed = (detail: string): { readonly charge: AncillaryCharge } => {
    undetermined(detail);
    return { charge: { type: 'NOT_INFORMED' } };
  };
  if (unitPrices === null) return notInformed('precio ilegible');

  const explicit = unitPrices.filter((unit) => unit.passengerReferenceIds?.includes(passengerRef));
  const general = unitPrices.filter((unit) => unit.passengerReferenceIds === undefined);
  const candidates = explicit.length > 0 ? explicit : general;
  const unitPrice = candidates[0];
  if (unitPrice === undefined) return notInformed('sin precio para el pasajero');
  if (candidates.length > 1) return notInformed('precio ambiguo para el pasajero');

  const price = moneyOf(unitPrice.total.amount);
  if (price === undefined) return notInformed('importe no representable');
  return { charge: { type: 'PRICED', price }, unitPrice };
}

/** El precio de un `AmountCurrency`, o `undefined` si no es dinero que se pueda cobrar. */
export function sabreAncillaryMoneyOf(
  value: { readonly amount: string | number; readonly currencyCode: string } | undefined,
): Money | undefined {
  return moneyOf(value);
}

function moneyOf(
  value: { readonly amount: string | number; readonly currencyCode: string } | undefined,
): Money | undefined {
  if (value === undefined) return undefined;
  const currency = value.currencyCode.trim().toUpperCase();
  if (!CURRENCY.test(currency)) return undefined;
  const minor = amountToMinor(value.amount);
  return minor === null ? undefined : { amountMinor: minor, currency };
}

/**
 * Importe → unidades menores con aritmética de enteros sobre el TEXTO (`19.99 * 100` en coma
 * flotante da `1998.9999999999998`). Un tercer decimal distinto de cero no se redondea y un
 * negativo no es un precio: los dos quedan «no informado».
 */
function amountToMinor(amount: number | string): number | null {
  const text = typeof amount === 'number' ? String(amount) : amount.trim();
  const match = AMOUNT.exec(text);
  const units = match?.[1];
  if (match === null || units === undefined) return null;
  const fraction = (match[2] ?? '').padEnd(3, '0');
  if (fraction.charAt(2) !== '0') return null;
  return Number(units) * 100 + Number(fraction.slice(0, 2));
}

// ---------------------------------------------------------------------------
// Venta, categoría e identidad
// ---------------------------------------------------------------------------

/**
 * Primer motivo que aplica, en orden de lo más definitivo a lo más circunstancial.
 *
 * `details.isAvailable: true` es «el servicio EXISTE y está disponible para consumir»
 * (`AncillaryOfferItem`, `:1870-1873`): el pasajero ya lo tiene. No es «hay cupo»: el único ítem que
 * Sabre agrega en su propia ayuda (el `/add` de `help/…/1.0-index.txt`) lleva `isAvailable: false`.
 * Venderlo otra vez es cobrar dos veces lo mismo, así que no se vende; si CERT (SAB-21) muestra lo
 * contrario, se ve en seguida —el catálogo sale sin nada vendible—, y el cobro doble no se vería.
 */
function notSellableReasonOf(
  item: SabreAncillaryShopOfferItem,
  ancillary: SabreAncillaryShopAncillary,
  passengers: readonly { readonly charge: AncillaryCharge }[],
): AncillaryNotSellableReason | undefined {
  if (ancillary.isDisplayOnly === true) return 'DISPLAY_ONLY';
  if (ancillary.bookingMethod?.value === 'ContactAirline') return 'CONTACT_AIRLINE';
  if (ancillary.bookingMethod?.value === 'NoBookingRequired') return 'NO_BOOKING_REQUIRED';
  if (item.details.isAvailable === true) return 'NO_BOOKING_REQUIRED';
  if ((ancillary.bundledAncillaryRefs?.length ?? 0) > 0) return 'UNSUPPORTED';
  if (requiresDetails(ancillary)) return 'REQUIRES_DETAILS';
  if (passengers.some((entry) => entry.charge.type === 'NOT_INFORMED')) {
    return 'PRICE_NOT_INFORMED';
  }
  return undefined;
}

/**
 * El SSR exige texto (`Required`) o datos estructurados (`Structured`), o el servicio declara
 * propiedades obligatorias (`RequiredProperties`, `:477-531`). Esta versión no las recoge, así que
 * agregarlo fallaría. Un bloque de propiedades que no se entiende cuenta como obligatorio.
 */
function requiresDetails(ancillary: SabreAncillaryShopAncillary): boolean {
  const special = ancillary.specialService;
  if (special === undefined) return false;
  if (special.type === 'Required' || special.type === 'Structured') return true;
  if (special.requiredProperties === undefined) return false;
  const parsed = z
    .object({
      propertyDefinitions: z.array(z.object({ isOptional: z.boolean().optional() })).min(1),
    })
    .safeParse(special.requiredProperties);
  if (!parsed.success) return true;
  return parsed.data.propertyDefinitions.some((definition) => definition.isOptional !== true);
}

function categoryOf(ancillary: SabreAncillaryShopAncillary): AncillaryCategory {
  const byGroup =
    ancillary.groupCode === undefined ? undefined : CATEGORY_BY_GROUP[ancillary.groupCode];
  if (byGroup !== undefined) return byGroup;
  if (ancillary.reasonForIssuanceCode === RFIC_FINANCIAL_IMPACT) return 'FEE';
  if (ancillary.reasonForIssuanceCode === RFIC_BAGGAGE) return 'BAGGAGE';
  return 'OTHER';
}

function weightsOf(ancillary: SabreAncillaryShopAncillary): AncillaryWeight[] {
  return (ancillary.weights ?? []).map((weight) => ({
    value: weight.value,
    unit: weight.unit === 'Kilogram' ? 'KG' : 'LB',
  }));
}

/**
 * Identidad de la compra SIN el precio: qué servicio, en qué vuelos, para qué nombres del PNR y
 * cuántas unidades. No usa los ids de Sabre (la oferta y sus ítems se regeneran en cada consulta)
 * sino lo que describen, así que la misma compra da la misma clave en el alta que en el catálogo.
 */
function semanticKeyOf(
  item: SabreAncillaryShopOfferItem,
  ancillary: SabreAncillaryShopAncillary,
  segmentRefs: readonly number[],
  passengerRefByIndex: ReadonlyMap<number, string>,
  ic: ItemContext,
): string {
  const flights = segmentRefs.map((index) => {
    const segment = ic.segments[index];
    return segment === undefined
      ? ''
      : [
          segment.bookingAirlineCode,
          segment.bookingFlightNumber.replace(/^0+(?=\d)/, ''),
          segment.departureAirportCode,
          segment.arrivalAirportCode,
          segment.departureDateTime,
        ].join('|');
  });
  const nameNumbers = [...passengerRefByIndex.values()]
    .map((ref) => ic.nameNumberById.get(ref) ?? '')
    .sort();
  return JSON.stringify([
    SABRE_ANCILLARY_OFFER_REF_VERSION,
    ic.ctx.pnrLocator,
    ancillary.airlineCode,
    ancillary.groupCode ?? '',
    ancillary.subCode,
    ancillary.serviceTypeCode ?? '',
    ancillary.reasonForIssuanceCode ?? '',
    ancillary.vendorCode ?? '',
    ancillary.ssimCode ?? '',
    ancillary.specialService?.code ?? '',
    ancillary.bagType ?? '',
    weightsOf(ancillary)
      .map((weight) => `${String(weight.value)}${weight.unit}`)
      .sort(),
    flights,
    nameNumbers,
    item.details.quantity ?? 1,
    item.details.sectorPortionIndicator ?? '',
  ]);
}

function pricedKeyOf(
  semanticKey: string,
  passengers: readonly { readonly passengerIndex: number; readonly charge: AncillaryCharge }[],
): string {
  return JSON.stringify([
    semanticKey,
    passengers.map((entry) =>
      entry.charge.type === 'PRICED'
        ? [
            entry.passengerIndex,
            'PRICED',
            entry.charge.price.amountMinor,
            entry.charge.price.currency,
          ]
        : [entry.passengerIndex, entry.charge.type],
    ),
  ]);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** Separa un `serviceOfferItemId` en su identidad sin precio y con precio. */
export function parseSabreAncillaryOfferRef(
  ref: string,
): { readonly semantic: string; readonly priced: string } | undefined {
  const match = /^SA1\.([0-9a-f]{24})\.([0-9a-f]{24})$/.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { semantic: match[1], priced: match[2] };
}
