import type { Offer, Segment } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { z } from 'zod';
import { SABRE_RAW_KEYS } from '../price/request.builder';
import { sabrePassengerGroups } from '../shop/request.builder';
import { SABRE_PROVIDER_NAME } from '../shop/response.mapper';

/**
 * Get Seats **v3, carril de agencia** (`get-seats-agency-3.0.yml`), y no el v1 que usa la
 * colección de Postman: son dos APIs con contratos incompatibles (docs/sabre/03 §4.1). El modo se
 * elige por RUTA, no con un `requestType` dentro del cuerpo, y el PCC ya no viaja en el cuerpo:
 * Sabre lo lee de la sesión ATK.
 *
 * `basePath: /v3/offers` (`get-seats-agency-3.0.yml:25-26`).
 */
export const SABRE_GETSEATS_BASE_PATH = '/v3/offers';

/** ATPCO y LCC: el itinerario viaja entero en el cuerpo (`:70-87`). */
export const SABRE_GETSEATS_PAYLOAD_PATH = `${SABRE_GETSEATS_BASE_PATH}/getseats/byReservationPayload`;

/** NDC: la aerolínea pinta el mapa de una oferta que ya conoce (`:49-68`). */
export const SABRE_GETSEATS_NDC_OFFER_PATH = `${SABRE_GETSEATS_BASE_PATH}/getseats/byNdcOfferId`;

/**
 * El contrato de Get Seats no pone tope; se usa el de 9 pasajeros por reserva que ya aplican el shop
 * y Flight Check (`SABRE_FLIGHT_CHECK_MAX_TRAVELERS`), para no consultar un mapa que no se podría
 * reservar.
 */
export const SABRE_GETSEATS_MAX_SEATED_PASSENGERS = 9;

/** `IdType` (`:1161-1166`). Vale para ids de segmento, pasajero, componente y oferta. */
export const SABRE_GETSEATS_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_\-.]*$/;

/**
 * Prefijos de los ids técnicos del modo payload. Son los del ejemplo oficial
 * (`help/get-seats-agency-3.0/get-seats-v3-get-seats-payload.txt:9-96`): no llevan dato del
 * pasajero ni de la reserva, sólo la posición, y vuelven en la respuesta tal cual.
 */
export const SABRE_GETSEATS_SEGMENT_ID_PREFIX = 'segment_';
export const SABRE_GETSEATS_PASSENGER_ID_PREFIX = 'passenger_';
export const SABRE_GETSEATS_FARE_COMPONENT_ID_PREFIX = 'fareComponent';

const AIRPORT = /^[A-Z]{3}$/;
const AIRLINE = /^(?:[A-Z0-9]{2}|[A-Z]{3})$/;
const BOOKING_CLASS = /^[A-Z]$/;
const AIRCRAFT = /^[0-9A-Z]{3}$/;
const TIME = /^[0-9]{2}:[0-9]{2}$/;
const FLIGHT_NUMBER = /^\d{1,4}$/;
const LOCAL_ISO =
  /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `fareBasis` y `brandCode` son texto sin patrón en el contrato (`:650-681`): son los únicos
 * campos del cuerpo por los que una tirada con forma de PAN llegaría al cable (D1). Ninguna tarifa
 * ni marca real lleva nueve dígitos seguidos, así que el componente que los traiga se omite.
 */
const PAN_LIKE_DIGIT_RUN = /[0-9]{9,}/;

const IdSchema = z.string().regex(SABRE_GETSEATS_ID_PATTERN);
const FlightNumberSchema = z.number().int().min(1).max(9999);

/** `SegmentPayloadRq` (`:505-519`) = `SegmentBase` (`:429-483`) + `aircraftCode`. */
const SegmentPayloadSchema = z
  .object({
    id: IdSchema,
    bookingAirlineCode: z.string().regex(AIRLINE),
    bookingFlightNumber: FlightNumberSchema,
    departureAirportCode: z.string().regex(AIRPORT),
    arrivalAirportCode: z.string().regex(AIRPORT),
    departureDate: z.string().date(),
    bookingClassCode: z.string().regex(BOOKING_CLASS),
    departureTime: z.string().regex(TIME),
    arrivalDate: z.string().date(),
    arrivalTime: z.string().regex(TIME),
    operatingAirlineCode: z.string().regex(AIRLINE).optional(),
    operatingFlightNumber: FlightNumberSchema.optional(),
    aircraftCode: z.string().regex(AIRCRAFT).optional(),
  })
  .strict();

/**
 * `PassengerPayloadRq` (`:574-608`, con `PassengerBase` en `:544-567`), recortado a propósito:
 * **sin `givenName`, `surname` ni `loyaltyProgramAccounts`**. El contrato los admite (opcionales)
 * y el ejemplo oficial los manda, pero un mapa de asientos antes de reservar no necesita saber quién
 * viaja, y `.strict()` hace que un nombre que alguien añada por error se rechace aquí y no salga
 * al cable.
 */
const PassengerPayloadSchema = z
  .object({
    id: IdSchema,
    passengerType: z.string().regex(/^[0-9A-Z]{3}$/),
    fareSegmentAssociation: z
      .array(z.object({ segmentRef: IdSchema, fareComponentRef: IdSchema }).strict())
      .min(1)
      .optional(),
    isAccompaniedByInfant: z.boolean().optional(),
  })
  .strict();

/** `FareComponent` (`:650-681`). Sólo lo que el canónico conserva: fare basis y marca. */
const FareComponentSchema = z
  .object({
    fareComponentId: IdSchema,
    fareBasis: z.string().min(1).max(128),
    brandCode: z.string().min(1).max(80).optional(),
  })
  .strict();

/** `SeatAvailabilityByPayloadRq` (`:132-181`). */
export const SabreGetSeatsPayloadRequestSchema = z
  .object({
    returnSeatMapsOnlyForSegmentRefs: z.array(IdSchema).min(1),
    segments: z.array(SegmentPayloadSchema).min(1),
    passengers: z.array(PassengerPayloadSchema).min(1).max(SABRE_GETSEATS_MAX_SEATED_PASSENGERS),
    fareComponents: z.array(FareComponentSchema).min(1).optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

/**
 * `SeatAvailabilityByNdcOfferIdRq` (`:105-119`), sin `passengers`: Sabre ya conoce los pasajeros
 * de la oferta tarificada, y mandarlos sólo serviría para llevar nombres al cable.
 */
export const SabreGetSeatsNdcOfferRequestSchema = z.object({ offerId: IdSchema }).strict();

export type SabreGetSeatsPayloadRequest = z.infer<typeof SabreGetSeatsPayloadRequestSchema>;
export type SabreGetSeatsNdcOfferRequest = z.infer<typeof SabreGetSeatsNdcOfferRequestSchema>;

export type SabreGetSeatsMode = 'payload' | 'ndc-offer';

/**
 * Lo que el adapter manda y lo que el mapper necesita para leer la respuesta.
 *
 * Los índices viajan junto al cuerpo porque nacen al armarlo: el `segment_2` del request es el
 * segmento 1 de la oferta, y `passenger_3` es el pasajero 2 de la búsqueda. Reconstruirlos después
 * a partir de la respuesta sería adivinar.
 */
export type SabreGetSeatsRequestPlan =
  | {
      readonly mode: 'payload';
      readonly path: typeof SABRE_GETSEATS_PAYLOAD_PATH;
      readonly body: SabreGetSeatsPayloadRequest;
      /** id de segmento del request → índice sobre los segmentos aplanados de la oferta. */
      readonly segmentIndexById: ReadonlyMap<string, number>;
      /** id de pasajero del request → `requestedTravelerIndex`. */
      readonly passengerIndexById: ReadonlyMap<string, number>;
    }
  | {
      readonly mode: 'ndc-offer';
      readonly path: typeof SABRE_GETSEATS_NDC_OFFER_PATH;
      readonly body: SabreGetSeatsNdcOfferRequest;
      /** Vacío: los segmentos NDC llevan ids de la aerolínea y se casan por vuelo. */
      readonly segmentIndexById: ReadonlyMap<string, number>;
      /** id emitido por Offer Price → `requestedTravelerIndex`. Sin infantes. */
      readonly passengerIndexById: ReadonlyMap<string, number>;
    };

/**
 * Request inválido antes de tocar la red. Es bug nuestro o una oferta que no se puede consultar:
 * no cuenta para el circuit breaker ni se reintenta.
 *
 * El mensaje sólo lleva rutas y códigos. Nunca repite un id de oferta, una clase ni un fare basis.
 */
export class SabreGetSeatsRequestError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`request de getseats inválido (${issues.join(', ') || '<root>'})`);
    this.name = 'SabreGetSeatsRequestError';
  }
}

/**
 * Elige el modo por el carril de la oferta y arma el cuerpo.
 *
 * - `NDC` → `byNdcOfferId` con el `offerId` de Offer Price. El de la búsqueda no sirve: Sabre
 *   pinta ese mapa como sólo-lectura porque el precio del vuelo todavía no está garantizado
 *   (`help/get-seats-agency-3.0/3.0-index.txt`, «GetSeats with request type OfferID»).
 * - `ATPCO`, `LCC` o sin carril declarado (el default del shop es ATPCO) → `byReservationPayload`
 *   con los segmentos y los pasajeros de la oferta.
 */
export function buildSabreGetSeatsRequest(
  offer: Offer,
  criteria: FlightSearchCriteria,
): SabreGetSeatsRequestPlan {
  if (offer.provider.name !== SABRE_PROVIDER_NAME) {
    throw new SabreGetSeatsRequestError(['provider.name:not_sabre']);
  }
  const source = offer.provider.source;
  if (source === 'NDC') return buildNdcOfferPlan(offer, criteria);
  if (source === undefined || source === 'ATPCO' || source === 'LCC') {
    return buildPayloadPlan(offer, criteria);
  }
  throw new SabreGetSeatsRequestError(['provider.source:unsupported']);
}

// ---------------------------------------------------------------------------
// ATPCO / LCC — byReservationPayload
// ---------------------------------------------------------------------------

function buildPayloadPlan(offer: Offer, criteria: FlightSearchCriteria): SabreGetSeatsRequestPlan {
  const flat = flattenSegments(offer);
  const segmentIndexById = new Map<string, number>();
  const segments = flat.map((segment, index) => {
    const id = `${SABRE_GETSEATS_SEGMENT_ID_PREFIX}${String(index + 1)}`;
    segmentIndexById.set(id, index);
    return payloadSegment(segment, id, `segments.${String(index)}`);
  });

  const fareComponents = buildFareComponents(offer, flat.length);
  const { adults, children, infants } = criteria.paxCount;
  const groups = sabrePassengerGroups(criteria.paxCount);
  const lapInfants = groups
    .filter((group) => group.kind === 'lap-infant')
    .reduce((total, group) => total + group.quantity, 0);
  // El infante con asiento (`INS`) OCUPA uno: cuenta como pasajero sentado.
  if (adults + children + (infants - lapInfants) > SABRE_GETSEATS_MAX_SEATED_PASSENGERS) {
    throw new SabreGetSeatsRequestError(['passengers:too_many']);
  }
  if (infants > adults) {
    throw new SabreGetSeatsRequestError(['passengers:more_infants_than_adults']);
  }

  // Orden y numeración de `requestedTravelerIndex`: adultos, luego niños. Los infantes en brazos
  // no ocupan asiento, así que no son pasajeros de este request: viajan como
  // `isAccompaniedByInfant` en los primeros adultos, que es lo que hace que Sabre descarte los
  // asientos donde no puede ir un infante.
  const passengerIndexById = new Map<string, number>();
  const passengers: SabreGetSeatsPayloadRequest['passengers'] = [];
  const add = (passengerType: string, withInfant: boolean, fares: boolean): void => {
    const index = passengers.length;
    const id = `${SABRE_GETSEATS_PASSENGER_ID_PREFIX}${String(index + 1)}`;
    passengerIndexById.set(id, index);
    passengers.push({
      id,
      passengerType,
      ...(fares && fareComponents.associations.length > 0
        ? { fareSegmentAssociation: [...fareComponents.associations] }
        : {}),
      ...(withInfant ? { isAccompaniedByInfant: true } : {}),
    });
  };
  // Los componentes de la oferta describen la tarifa del PRIMER pasajero con tarifa, que es un
  // adulto (`resolveFareComponents` del shop). El fare basis de un niño suele llevar su propio
  // descuento: asociarle el del adulto sería mentirle a Sabre sobre su tarifa, así que el niño
  // viaja sin asociación y Sabre lo resuelve por su PTC.
  // Los códigos son los de la búsqueda (`C08`, `INS`): ver `sabrePassengerGroups`.
  for (const group of groups) {
    if (group.kind === 'lap-infant') continue;
    for (let i = 0; i < group.quantity; i += 1) {
      if (group.kind === 'adult') add(group.code, i < lapInfants, true);
      else add(group.code, false, false);
    }
  }

  const body = parseOrThrow(SabreGetSeatsPayloadRequestSchema, {
    returnSeatMapsOnlyForSegmentRefs: [...segmentIndexById.keys()],
    segments,
    passengers,
    ...(fareComponents.components.length > 0
      ? { fareComponents: [...fareComponents.components] }
      : {}),
    currencyCode: offer.total.currency,
  });

  return {
    mode: 'payload',
    path: SABRE_GETSEATS_PAYLOAD_PATH,
    body,
    segmentIndexById,
    passengerIndexById,
  };
}

function flattenSegments(offer: Offer): readonly Segment[] {
  const itineraries = offer.itineraries ?? [];
  const flat = itineraries.flatMap((itinerary) => itinerary.segments);
  if (flat.length === 0) throw new SabreGetSeatsRequestError(['itineraries:required']);
  return flat;
}

function payloadSegment(
  segment: Segment,
  id: string,
  path: string,
): SabreGetSeatsPayloadRequest['segments'][number] {
  const departure = splitLocalIso(segment.departureAt, `${path}.departureAt`);
  const arrival = splitLocalIso(segment.arrivalAt, `${path}.arrivalAt`);
  const operatingFlightNumber =
    segment.operatingFlightNumber === undefined
      ? undefined
      : readFlightNumber(segment.operatingFlightNumber, `${path}.operatingFlightNumber`);
  return {
    id,
    bookingAirlineCode: segment.carrier,
    bookingFlightNumber: readFlightNumber(segment.flightNumber, `${path}.flightNumber`),
    departureAirportCode: segment.origin,
    arrivalAirportCode: segment.destination,
    departureDate: departure.date,
    bookingClassCode: segment.bookingClass,
    departureTime: departure.time,
    arrivalDate: arrival.date,
    arrivalTime: arrival.time,
    ...(segment.operatingCarrier === undefined
      ? {}
      : { operatingAirlineCode: segment.operatingCarrier }),
    ...(operatingFlightNumber === undefined ? {} : { operatingFlightNumber }),
    // El equipo ayuda a Sabre a elegir el mapa del avión correcto. Es opcional en el contrato,
    // así que uno que no cumpla su patrón se omite en vez de tumbar la consulta.
    ...(segment.aircraft !== undefined && AIRCRAFT.test(segment.aircraft)
      ? { aircraftCode: segment.aircraft }
      : {}),
  };
}

type PayloadFareComponent = NonNullable<SabreGetSeatsPayloadRequest['fareComponents']>[number];
type PayloadFareAssociation = NonNullable<
  SabreGetSeatsPayloadRequest['passengers'][number]['fareSegmentAssociation']
>[number];

interface PayloadFares {
  readonly components: readonly PayloadFareComponent[];
  readonly associations: readonly PayloadFareAssociation[];
}

/**
 * `fareComponents` es opcional en el contrato, pero sin él Sabre no sabe la marca ni el fare
 * basis, que deciden qué asientos salen sin cargo. Se mandan los componentes con fare basis
 * (`FareComponent.fareBasis` es obligatorio) y se asocia cada uno a sus segmentos.
 *
 * Un componente sin fare basis, con un `segmentRef` fuera de la oferta o que repite un segmento ya
 * asociado se omite entero: asociar una tarifa al segmento equivocado le hace a Sabre cotizar
 * asientos de otra tarifa. También el que trae una tirada con forma de PAN en el fare basis o en
 * la marca: es texto libre que viajaría tal cual.
 */
function buildFareComponents(offer: Offer, segmentCount: number): PayloadFares {
  const components: PayloadFareComponent[] = [];
  const bySegment = new Map<number, string>();

  for (const component of offer.fareComponents ?? []) {
    const fareBasis = component.fareBasisCode?.trim();
    if (fareBasis === undefined || fareBasis.length === 0) continue;
    const brandCode = component.brand?.code?.trim();
    if (PAN_LIKE_DIGIT_RUN.test(fareBasis) || PAN_LIKE_DIGIT_RUN.test(brandCode ?? '')) continue;
    const refs = component.segmentRefs;
    const unique = new Set(refs);
    if (
      unique.size !== refs.length ||
      refs.some((ref) => ref >= segmentCount || bySegment.has(ref))
    ) {
      continue;
    }

    const fareComponentId = `${SABRE_GETSEATS_FARE_COMPONENT_ID_PREFIX}${String(components.length + 1)}`;
    components.push({
      fareComponentId,
      fareBasis,
      ...(brandCode === undefined || brandCode.length === 0 ? {} : { brandCode }),
    });
    for (const ref of refs) bySegment.set(ref, fareComponentId);
  }

  const associations = [...bySegment.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ref, fareComponentRef]) => ({
      segmentRef: `${SABRE_GETSEATS_SEGMENT_ID_PREFIX}${String(ref + 1)}`,
      fareComponentRef,
    }));
  return { components, associations };
}

/**
 * Fecha y hora LOCALES del aeropuerto, partidas del texto ISO. Pasar por `Date` las movería a
 * UTC y podría cambiar incluso el día.
 */
function splitLocalIso(value: string, path: string): { date: string; time: string } {
  const match = LOCAL_ISO.exec(value);
  const date = match?.[1];
  const time = match?.[2];
  if (date === undefined || time === undefined) {
    throw new SabreGetSeatsRequestError([`${path}:invalid_iso_with_offset`]);
  }
  return { date, time };
}

/**
 * `CarrierFlightNumber` es un entero 1..9999. Un sufijo operativo (`123A`) no cabe y no se
 * recorta: el vuelo `123` es otro vuelo.
 */
function readFlightNumber(value: string, path: string): number {
  if (!FLIGHT_NUMBER.test(value)) {
    throw new SabreGetSeatsRequestError([`${path}:integer_required`]);
  }
  const parsed = Number(value);
  if (parsed < 1) throw new SabreGetSeatsRequestError([`${path}:out_of_range`]);
  return parsed;
}

// ---------------------------------------------------------------------------
// NDC — byNdcOfferId
// ---------------------------------------------------------------------------

function buildNdcOfferPlan(offer: Offer, criteria: FlightSearchCriteria): SabreGetSeatsRequestPlan {
  const raw = offer.provider.raw ?? {};
  const offerId = raw[SABRE_RAW_KEYS.priceOfferId];
  if (typeof offerId !== 'string' || offerId.length === 0) {
    throw new SabreGetSeatsRequestError([`provider.raw.${SABRE_RAW_KEYS.priceOfferId}:required`]);
  }
  const body = parseOrThrow(SabreGetSeatsNdcOfferRequestSchema, { offerId });
  return {
    mode: 'ndc-offer',
    path: SABRE_GETSEATS_NDC_OFFER_PATH,
    body,
    segmentIndexById: new Map(),
    passengerIndexById: readNdcPassengerIndex(raw, criteria),
  };
}

/**
 * Los `offerItems` del mapa NDC nombran a los pasajeros con el id que emitió Offer Price. El
 * vínculo con `requestedTravelerIndex` sólo existe en `pricePassengerBindings`; sin él no hay
 * forma honesta de saber de quién es cada precio, y no se adivina por orden (es el mismo fallo
 * cerrado de la reserva NDC en `sabre-order-create.adapter.ts`).
 */
function readNdcPassengerIndex(
  raw: Readonly<Record<string, unknown>>,
  criteria: FlightSearchCriteria,
): ReadonlyMap<string, number> {
  const key = SABRE_RAW_KEYS.pricePassengerBindings;
  const value = raw[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new SabreGetSeatsRequestError([`provider.raw.${key}:required`]);
  }
  const { adults, children, infants } = criteria.paxCount;
  if (value.length !== adults + children + infants) {
    throw new SabreGetSeatsRequestError([`provider.raw.${key}:passenger_count_mismatch`]);
  }

  const expected = (index: number): 'ADT' | 'CHD' | 'INF' =>
    index < adults ? 'ADT' : index < adults + children ? 'CHD' : 'INF';
  const out = new Map<string, number>();
  const indices = new Set<number>();
  value.forEach((entry: unknown, position) => {
    const path = `provider.raw.${key}.${String(position)}`;
    const binding = NdcBindingSchema.safeParse(entry);
    if (!binding.success) throw new SabreGetSeatsRequestError([`${path}:invalid`]);
    const { pricePassengerId, requestedTravelerIndex, paxType } = binding.data;
    if (
      expected(requestedTravelerIndex) !== paxType ||
      requestedTravelerIndex >= value.length ||
      indices.has(requestedTravelerIndex) ||
      out.has(pricePassengerId)
    ) {
      throw new SabreGetSeatsRequestError([`${path}:ambiguous`]);
    }
    indices.add(requestedTravelerIndex);
    // El infante en brazos no tiene asiento: un precio de asiento a su nombre no se ofrece.
    if (paxType !== 'INF') out.set(pricePassengerId, requestedTravelerIndex);
  });
  return out;
}

const NdcBindingSchema = z.object({
  pricePassengerId: z.string().min(1).max(100),
  requestedTravelerIndex: z.number().int().nonnegative(),
  paxType: z.enum(['ADT', 'CHD', 'INF']),
});

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SabreGetSeatsRequestError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }
  return parsed.data;
}
