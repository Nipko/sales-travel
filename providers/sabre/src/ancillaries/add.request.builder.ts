import { z } from 'zod';
import {
  SABRE_ANCILLARIES_BASE_PATH,
  SabreAncillaryPnrSchema,
  SabreAncillaryRequestError,
  sabreAncillaryZodIssues,
} from './shop.request.builder';
import {
  SABRE_ANCILLARY_ENUMS as E,
  SABRE_ANCILLARY_WIRE_PATTERNS as P,
  sabreAncillaryMoneyOf,
  type SabreAncillaryOfferBinding,
  type SabreAncillaryShopSnapshot,
  type SabreAncillaryShopUnitPrice,
} from './shop.response.mapper';

/**
 * `POST /v1/dc/ancillaries/add` (`stateless-ancillaries-api-1.0.yml:47-65`).
 *
 * **Escribe en el PNR** (`isCommitEnabled`, default `true`, `:177-181`) y por eso está en
 * `SABRE_NON_IDEMPOTENT_PATHS`: un timeout no dice si el servicio quedó agregado, y reintentar lo
 * cobraría dos veces.
 *
 * Va en MODO RECURSO, que es el que documenta la ayuda (`help/stateless-ancillaries-api-1.0/
 * 1.0-index.txt`, «Adding ancillary using resource mode»): itinerario, segmentos, pasajeros, la
 * oferta con los ítems elegidos y las definiciones de los servicios. **Todo sale de la consulta que
 * el adapter acaba de hacer**, nunca de lo que mande el llamador: el llamador sólo elige ítems y
 * pasajeros. Así un precio no se puede «traer» de fuera.
 *
 * Lo que NO viaja, a propósito:
 *  - `priceOverrideType` (`:1298-1300`): sin él Sabre cobra el precio del sistema. Mandarlo es la
 *    puerta del «override the amount» que anuncia `:52`, y esta plataforma no reescribe precios.
 *  - Nombres, SSR y viajero frecuente de los pasajeros: `id` + `nameNumber` identifican al pasajero
 *    del PNR.
 *  - `clientContext`: el PCC sale del token.
 *  - `ancillaryRule`, `requiredProperties`, `bundledAncillaryRefs`: los servicios que los exigen no
 *    se venden desde aquí (`AncillaryNotSellableReason`).
 */
export const SABRE_ANCILLARIES_ADD_PATH = `${SABRE_ANCILLARIES_BASE_PATH}/add`;

/** `offers` tiene `maxItems: 2` (`:206-212`). */
export const SABRE_ANCILLARY_ADD_MAX_OFFERS = 2;

const token = (pattern: RegExp) => z.string().regex(pattern);

const OpaqueIdSchema = token(P.opaqueId).refine((value) => !P.panWindowDigitRun.test(value));

/** Texto libre de Sabre que se devuelve tal cual, salvo que traiga una tirada con forma de PAN. */
const TextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !P.panLikeDigitRun.test(value));

const AmountCurrencySchema = z
  .object({
    amount: z.union([token(P.amount), z.number().nonnegative().finite()]),
    currencyCode: token(P.currency),
  })
  .strict();

const UnitPriceSchema = z
  .object({
    total: z.object({ amount: AmountCurrencySchema }).strict(),
    totalBreakdown: z
      .object({ base: z.object({ amount: AmountCurrencySchema }).strict() })
      .strict()
      .optional(),
    passengerReferenceIds: z.array(token(P.passengerId)).min(1).max(9).optional(),
  })
  .strict();

const OfferItemSchema = z
  .object({
    id: OpaqueIdSchema,
    itineraryReferenceId: token(P.itineraryId).optional(),
    itineraryPartReferenceIds: z.array(token(P.itineraryPartId)).min(1).max(8).optional(),
    segmentReferenceIds: z.array(token(P.segmentId)).min(1).max(16).optional(),
    passengerReferenceIds: z.array(token(P.passengerId)).min(1).max(9),
    details: z
      .object({
        type: z.literal('AncillaryOfferItem'),
        ancillaryReferenceId: OpaqueIdSchema,
        quantity: z.number().int().positive().optional(),
        isAvailable: z.boolean().optional(),
        sectorPortionIndicator: z.enum(E.sectorPortion).optional(),
      })
      .strict(),
    price: z
      .object({ unitPrices: z.array(UnitPriceSchema).min(1).max(9) })
      .strict()
      .optional(),
  })
  .strict();

const SegmentSchema = z
  .object({
    id: token(P.segmentId),
    departureDateTime: token(P.dateTime),
    arrivalDateTime: token(P.dateTime).optional(),
    departureAirportCode: token(P.airport),
    arrivalAirportCode: token(P.airport),
    operatingAirlineCode: token(P.airline).optional(),
    bookingAirlineCode: token(P.airline),
    isElectronicTicket: z.boolean().optional(),
    bookingFlightNumber: token(P.rawFlightNumber),
    brandCode: token(P.brand)
      .refine((value) => !P.panLikeDigitRun.test(value))
      .optional(),
    bookingClassCode: token(P.bookingClass).optional(),
    operatingFlightNumber: token(P.rawFlightNumber).optional(),
    operatingBookingClassCode: token(P.bookingClass).optional(),
    sequence: z.number().int().positive().optional(),
    statusCode: token(/^[A-Z]{2}$/).optional(),
    statusName: z.enum(E.segmentStatusNames).optional(),
    isInboundConnection: z.boolean().optional(),
    isOutboundConnection: z.boolean().optional(),
  })
  .strict();

const PassengerSchema = z
  .object({
    id: token(P.passengerId),
    nameNumber: token(P.nameNumber),
    typeCode: token(P.ptc).optional(),
  })
  .strict();

const ItinerarySchema = z
  .object({
    id: token(P.itineraryId),
    itineraryPartReferenceIds: z.array(token(P.itineraryPartId)).min(1).max(8),
  })
  .strict();

const ItineraryPartSchema = z
  .object({
    id: token(P.itineraryPartId),
    segmentReferenceIds: z.array(token(P.segmentId)).min(1).max(16),
  })
  .strict();

const AncillarySchema = z
  .object({
    id: OpaqueIdSchema,
    groupCode: token(/^[0-9A-Z]{2}$/).optional(),
    groupName: TextSchema(80).optional(),
    subCode: token(/^[0-9A-Z]{3}$/),
    ssimCode: token(/^[0-9A-Z]{1,5}$/).optional(),
    reasonForIssuanceCode: token(/^[A-I]$/).optional(),
    reasonForIssuance: z.enum(E.reasonForIssuance).optional(),
    commercialName: TextSchema(160).optional(),
    airlineCode: token(P.airline),
    specialService: z
      .object({
        code: token(/^[A-Z0-9]{1,20}$/).refine((value) => !P.panLikeDigitRun.test(value)),
        type: z.enum(E.specialServiceTypes).optional(),
      })
      .strict()
      .optional(),
    vendorCode: token(/^[0-9A-Z]{1,5}$/).optional(),
    emdType: z
      .object({
        code: token(/^[0-9A-Z]{1,3}$/).optional(),
        value: z.enum(E.emdTypes),
        isConsumedAtIssuance: z.boolean().optional(),
      })
      .strict()
      .optional(),
    bookingMethod: z
      .object({ code: token(/^[0-9A-Z]{1,3}$/).optional(), value: z.enum(E.bookingMethods) })
      .strict()
      .optional(),
    serviceTypeCode: token(/^[0-9A-Z]$/).optional(),
    serviceType: z.enum(E.serviceTypes).optional(),
    /** Sólo se agrega lo vendible, así que si viaja es `false`. */
    isDisplayOnly: z.literal(false).optional(),
    weights: z
      .array(
        z
          .object({ value: z.number().int().positive(), unit: z.enum(['Kilogram', 'Pound']) })
          .strict(),
      )
      .min(1)
      .optional(),
    bagType: TextSchema(40).optional(),
  })
  .strict();

/** `AncillaryAddRequest` (`:165-218`), recortado a lo que sale de la consulta. */
export const SabreAncillaryAddRequestSchema = z
  .object({
    pnrLocator: SabreAncillaryPnrSchema,
    isCommitEnabled: z.literal(true),
    itinerary: ItinerarySchema.optional(),
    itineraryParts: z.array(ItineraryPartSchema).min(1).max(8).optional(),
    segments: z.array(SegmentSchema).min(1).max(16),
    passengers: z.array(PassengerSchema).min(1).max(9),
    offers: z
      .array(
        z
          .object({ id: OpaqueIdSchema.optional(), items: z.array(OfferItemSchema).min(1) })
          .strict(),
      )
      .min(1)
      .max(SABRE_ANCILLARY_ADD_MAX_OFFERS),
    ancillaries: z.array(AncillarySchema).min(1),
  })
  .strict();
export type SabreAncillaryAddRequest = z.infer<typeof SabreAncillaryAddRequestSchema>;

/** Un ítem de la consulta y para qué pasajeros (índices de la orden) se agrega. */
export interface SabreAncillaryAddLineInput {
  readonly binding: SabreAncillaryOfferBinding;
  readonly passengerIndexes: readonly number[];
}

export interface SabreAncillaryAddInput {
  readonly snapshot: SabreAncillaryShopSnapshot;
  readonly lines: readonly SabreAncillaryAddLineInput[];
}

/** Una línea mandada: el servicio de Sabre al que la respuesta se refiere (`ancillaryId`). */
export interface SabreAncillarySentLine {
  readonly serviceOfferItemId: string;
  readonly passengerIndex: number;
  readonly ancillaryId: string;
}

export interface SabreAncillaryAddPlan {
  readonly path: typeof SABRE_ANCILLARIES_ADD_PATH;
  readonly body: SabreAncillaryAddRequest;
  readonly sent: readonly SabreAncillarySentLine[];
}

export function buildSabreAncillaryAddRequest(
  input: SabreAncillaryAddInput,
): SabreAncillaryAddPlan {
  if (input.lines.length === 0) throw new SabreAncillaryRequestError('add', ['lines:too_small']);

  const sent: SabreAncillarySentLine[] = [];
  const itemsByOffer = new Map<string, { id: string | undefined; items: unknown[] }>();
  const ancillaries = new Map<string, unknown>();
  const seenItems = new Set<string>();

  input.lines.forEach((line, lineIndex) => {
    const { binding } = line;
    const at = `lines.${String(lineIndex)}`;
    if (!binding.offer.sellable)
      throw new SabreAncillaryRequestError('add', [`${at}:not_sellable`]);
    if (seenItems.has(binding.offer.serviceOfferItemId)) {
      throw new SabreAncillaryRequestError('add', [`${at}:duplicate`]);
    }
    seenItems.add(binding.offer.serviceOfferItemId);

    const indexes = [...new Set(line.passengerIndexes)].sort((a, b) => a - b);
    if (indexes.length === 0 || indexes.length !== line.passengerIndexes.length) {
      throw new SabreAncillaryRequestError('add', [`${at}.passengerIndexes:invalid`]);
    }
    const refs: string[] = [];
    for (const index of indexes) {
      const ref = binding.passengerRefByIndex.get(index);
      if (ref === undefined) {
        throw new SabreAncillaryRequestError('add', [`${at}.passengerIndexes:not_eligible`]);
      }
      refs.push(ref);
      sent.push({
        serviceOfferItemId: binding.offer.serviceOfferItemId,
        passengerIndex: index,
        ancillaryId: binding.ancillary.id,
      });
    }

    const key = binding.offerId ?? '';
    const group = itemsByOffer.get(key) ?? { id: binding.offerId, items: [] };
    group.items.push(itemOf(binding, indexes, refs));
    itemsByOffer.set(key, group);
    ancillaries.set(binding.ancillary.id, ancillaryOf(binding));
  });

  const { snapshot } = input;
  const candidate = {
    pnrLocator: snapshot.pnrLocator,
    isCommitEnabled: true,
    ...(snapshot.itinerary === undefined ? {} : { itinerary: snapshot.itinerary }),
    ...(snapshot.itineraryParts.length === 0 ? {} : { itineraryParts: snapshot.itineraryParts }),
    segments: snapshot.segments.map(withoutUndefined),
    passengers: snapshot.passengers.map(withoutUndefined),
    offers: [...itemsByOffer.values()].map((group) => ({
      ...(group.id === undefined ? {} : { id: group.id }),
      items: group.items,
    })),
    ancillaries: [...ancillaries.values()],
  };

  const parsed = SabreAncillaryAddRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SabreAncillaryRequestError('add', sabreAncillaryZodIssues(parsed.error));
  }
  return { path: SABRE_ANCILLARIES_ADD_PATH, body: parsed.data, sent };
}

function itemOf(
  binding: SabreAncillaryOfferBinding,
  indexes: readonly number[],
  refs: readonly string[],
): unknown {
  const { item } = binding;
  const unitPrices = unitPricesOf(binding, indexes, refs);
  return {
    id: item.id,
    ...(item.itineraryReferenceId === undefined
      ? {}
      : { itineraryReferenceId: item.itineraryReferenceId }),
    ...(item.itineraryPartReferenceIds === undefined || item.itineraryPartReferenceIds.length === 0
      ? {}
      : { itineraryPartReferenceIds: item.itineraryPartReferenceIds }),
    ...(item.segmentReferenceIds === undefined || item.segmentReferenceIds.length === 0
      ? {}
      : { segmentReferenceIds: item.segmentReferenceIds }),
    passengerReferenceIds: refs,
    details: withoutUndefined({
      type: item.details.type,
      ancillaryReferenceId: item.details.ancillaryReferenceId,
      quantity: item.details.quantity,
      isAvailable: item.details.isAvailable,
      sectorPortionIndicator: item.details.sectorPortionIndicator,
    }),
    ...(unitPrices.length === 0 ? {} : { price: { unitPrices } }),
  };
}

/**
 * Los `unitPrice` de los pasajeros elegidos, cada uno una vez, tal como los dio la consulta. Un
 * `unitPrice` que nombraba a más pasajeros se recorta a los elegidos: no se manda precio de quien
 * no compra. Un servicio incluido no lleva precio que devolver.
 */
function unitPricesOf(
  binding: SabreAncillaryOfferBinding,
  indexes: readonly number[],
  refs: readonly string[],
): unknown[] {
  const chosen = new Set(refs);
  const units: SabreAncillaryShopUnitPrice[] = [];
  for (const index of indexes) {
    const unit = binding.unitPriceByIndex.get(index);
    if (unit !== undefined && !units.includes(unit)) units.push(unit);
  }
  return units.map((unit) => {
    const total = sabreAncillaryMoneyOf(unit.total.amount);
    const base = unit.totalBreakdown?.base?.amount;
    const named = unit.passengerReferenceIds?.filter((ref) => chosen.has(ref));
    return {
      total: { amount: unit.total.amount },
      ...(base === undefined || total === undefined || sabreAncillaryMoneyOf(base) === undefined
        ? {}
        : { totalBreakdown: { base: { amount: base } } }),
      ...(named === undefined ? {} : { passengerReferenceIds: named }),
    };
  });
}

function ancillaryOf(binding: SabreAncillaryOfferBinding): unknown {
  const a = binding.ancillary;
  return withoutUndefined({
    id: a.id,
    groupCode: a.groupCode,
    groupName: a.groupName,
    subCode: a.subCode,
    ssimCode: a.ssimCode,
    reasonForIssuanceCode: a.reasonForIssuanceCode,
    reasonForIssuance: a.reasonForIssuance,
    commercialName: a.commercialName,
    airlineCode: a.airlineCode,
    specialService:
      a.specialService === undefined
        ? undefined
        : withoutUndefined({ code: a.specialService.code, type: a.specialService.type }),
    vendorCode: a.vendorCode,
    emdType: a.emdType === undefined ? undefined : withoutUndefined({ ...a.emdType }),
    bookingMethod:
      a.bookingMethod === undefined ? undefined : withoutUndefined({ ...a.bookingMethod }),
    serviceTypeCode: a.serviceTypeCode,
    serviceType: a.serviceType,
    isDisplayOnly: a.isDisplayOnly,
    weights: a.weights,
    bagType: a.bagType,
  });
}

/** Quita las claves `undefined`: `.strict()` las aceptaría, pero no tienen por qué ir al cable. */
function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
