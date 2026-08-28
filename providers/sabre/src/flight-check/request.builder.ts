import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { z } from 'zod';
import { SABRE_PTC } from '../shop/request.builder';

/** `basePath: /v1/offers` + `/flightCheck` (`flightcheck-api-v1.yml:15-16,23`). */
export const SABRE_FLIGHT_CHECK_PATH = '/v1/offers/flightCheck';

export const SABRE_FLIGHT_CHECK_MAX_JOURNEYS = 10;
export const SABRE_FLIGHT_CHECK_MAX_FLIGHTS_PER_JOURNEY = 10;
export const SABRE_FLIGHT_CHECK_MAX_TRAVELERS = 9;
export const SABRE_FLIGHT_CHECK_MAX_FARE_BASIS_LENGTH = 15;

const LOCAL_ISO =
  /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const BOOKING_CLASS = /^[A-Z]{1,2}$/;
const FLIGHT_NUMBER = /^\d{1,4}$/;

const FlightSchema = z
  .object({
    departureAirportCode: z.string().regex(/^[A-Z]{3}$/),
    departureDate: z.string().date(),
    departureTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    arrivalAirportCode: z.string().regex(/^[A-Z]{3}$/),
    arrivalDate: z.string().date(),
    arrivalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    marketingAirlineCode: z.string().regex(/^(?:[A-Z0-9]{2}|[A-Z]{3})$/),
    marketingFlightNumber: z.number().int().min(1).max(9999),
    segmentDetails: z.object({ bookingClassCode: z.string().regex(BOOKING_CLASS) }).strict(),
  })
  .strict();

const FareBasisPreferenceSchema = z
  .object({
    values: z.array(z.string().min(1).max(SABRE_FLIGHT_CHECK_MAX_FARE_BASIS_LENGTH)).min(1),
    journeyIndices: z.array(z.number().int().nonnegative()).min(1),
  })
  .strict();

/** Forma payload-based de Flight Check, que es el carril ATPCO. */
export const SabreFlightCheckRequestSchema = z
  .object({
    journeys: z
      .array(
        z
          .object({
            flights: z.array(FlightSchema).min(1).max(SABRE_FLIGHT_CHECK_MAX_FLIGHTS_PER_JOURNEY),
          })
          .strict(),
      )
      .min(1)
      .max(SABRE_FLIGHT_CHECK_MAX_JOURNEYS),
    travelers: z
      .array(z.object({ passengerTypeCode: z.string().regex(/^[0-9A-Z]{3}$/) }).strict())
      .min(1)
      .max(SABRE_FLIGHT_CHECK_MAX_TRAVELERS),
    fare: z
      .object({
        currencyCode: z.string().regex(/^[A-Z]{3}$/),
        fareBasisCode: z
          .object({ preferences: z.array(FareBasisPreferenceSchema).min(1) })
          .strict()
          .optional(),
      })
      .strict(),
    processingOptions: z
      .object({ pseudoCityCode: z.string().regex(/^[A-Z0-9]{3,4}$/) })
      .strict()
      .optional(),
  })
  .strict();

export interface SabreFlightCheckFlight {
  readonly departureAirportCode: string;
  readonly departureDate: string;
  readonly departureTime: string;
  readonly arrivalAirportCode: string;
  readonly arrivalDate: string;
  readonly arrivalTime: string;
  readonly marketingAirlineCode: string;
  readonly marketingFlightNumber: number;
  readonly segmentDetails: { readonly bookingClassCode: string };
}

export interface SabreFlightCheckJourney {
  readonly flights: readonly SabreFlightCheckFlight[];
}

export interface SabreFlightCheckTraveler {
  readonly passengerTypeCode: string;
}

export interface SabreFlightCheckFareBasisPreference {
  readonly values: readonly string[];
  readonly journeyIndices: readonly number[];
}

export interface SabreFlightCheckRequest {
  readonly journeys: readonly SabreFlightCheckJourney[];
  readonly travelers: readonly SabreFlightCheckTraveler[];
  readonly fare: {
    readonly currencyCode: string;
    readonly fareBasisCode?: {
      readonly preferences: readonly SabreFlightCheckFareBasisPreference[];
    };
  };
  readonly processingOptions?: { readonly pseudoCityCode: string };
}

export interface SabreFlightCheckBuildOptions {
  /** PCC de la cuenta resuelta. El adapter siempre lo toma de `SabreConfig.homePcc`. */
  readonly pseudoCityCode?: string;
}

/**
 * Request inválido antes de tocar la red.
 *
 * El mensaje sólo contiene rutas/códigos de validación. Nunca repite booking class, fare basis,
 * PCC ni ningún otro valor que haya llegado en la oferta o en la cuenta.
 */
export class SabreFlightCheckRequestError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`request de offers/flightCheck inválido (${issues.join(', ') || '<root>'})`);
    this.name = 'SabreFlightCheckRequestError';
  }
}

/**
 * Construye la variante payload-based de Flight Check para ATPCO.
 *
 * Las horas se parten del ISO local con offset; convertirlas mediante `Date` las movería a UTC y
 * podría cambiar incluso el día. Los fare basis se agrupan por journey usando `segmentRefs`, que
 * son índices sobre los segmentos canónicos aplanados en orden.
 */
export function buildSabreFlightCheckRequest(
  offer: Offer,
  criteria: FlightSearchCriteria,
  options: SabreFlightCheckBuildOptions = {},
): SabreFlightCheckRequest {
  if (offer.provider.source !== undefined && offer.provider.source !== 'ATPCO') {
    throw new SabreFlightCheckRequestError(['provider.source:unsupported_for_atpco']);
  }

  const itineraries = offer.itineraries;
  if (itineraries === undefined || itineraries.length === 0) {
    throw new SabreFlightCheckRequestError(['itineraries:required']);
  }

  const journeys: SabreFlightCheckJourney[] = itineraries.map((itinerary, journeyIndex) => ({
    flights: itinerary.segments.map((segment, flightIndex) => {
      const path = `itineraries.${String(journeyIndex)}.segments.${String(flightIndex)}`;
      const departure = splitLocalIso(segment.departureAt, `${path}.departureAt`);
      const arrival = splitLocalIso(segment.arrivalAt, `${path}.arrivalAt`);
      const bookingClass = readBookingClass(segment.bookingClass, `${path}.bookingClass`);
      const marketingFlightNumber = readFlightNumber(segment.flightNumber, `${path}.flightNumber`);

      return {
        departureAirportCode: segment.origin,
        departureDate: departure.date,
        departureTime: departure.time,
        arrivalAirportCode: segment.destination,
        arrivalDate: arrival.date,
        arrivalTime: arrival.time,
        marketingAirlineCode: segment.carrier,
        marketingFlightNumber,
        segmentDetails: { bookingClassCode: bookingClass },
      };
    }),
  }));

  const travelers = buildTravelers(criteria);
  const fareBasisPreferences = buildFareBasisPreferences(offer);
  const request: SabreFlightCheckRequest = {
    journeys,
    travelers,
    fare: {
      currencyCode: criteria.currency,
      ...(fareBasisPreferences.length === 0
        ? {}
        : { fareBasisCode: { preferences: fareBasisPreferences } }),
    },
    ...(options.pseudoCityCode === undefined
      ? {}
      : { processingOptions: { pseudoCityCode: options.pseudoCityCode } }),
  };

  const parsed = SabreFlightCheckRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SabreFlightCheckRequestError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }
  return parsed.data;
}

function splitLocalIso(value: string, path: string): { date: string; time: string } {
  const match = LOCAL_ISO.exec(value);
  const date = match?.[1];
  const time = match?.[2];
  if (date === undefined || time === undefined) {
    throw new SabreFlightCheckRequestError([`${path}:invalid_iso_with_offset`]);
  }
  return { date, time };
}

function readBookingClass(value: unknown, path: string): string {
  if (typeof value !== 'string' || !BOOKING_CLASS.test(value)) {
    throw new SabreFlightCheckRequestError([`${path}:required_booking_class`]);
  }
  return value;
}

function readFlightNumber(value: string, path: string): number {
  if (!FLIGHT_NUMBER.test(value)) {
    throw new SabreFlightCheckRequestError([`${path}:integer_required`]);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 9999) {
    throw new SabreFlightCheckRequestError([`${path}:out_of_range`]);
  }
  return parsed;
}

function buildTravelers(criteria: FlightSearchCriteria): SabreFlightCheckTraveler[] {
  const travelers: SabreFlightCheckTraveler[] = [];
  appendTravelers(travelers, SABRE_PTC.adults, criteria.paxCount.adults);
  appendTravelers(travelers, SABRE_PTC.children, criteria.paxCount.children);
  appendTravelers(travelers, SABRE_PTC.infants, criteria.paxCount.infants);
  if (travelers.length > SABRE_FLIGHT_CHECK_MAX_TRAVELERS) {
    throw new SabreFlightCheckRequestError(['travelers:too_many']);
  }
  return travelers;
}

function appendTravelers(
  out: SabreFlightCheckTraveler[],
  passengerTypeCode: string,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) out.push({ passengerTypeCode });
}

function buildFareBasisPreferences(offer: Offer): SabreFlightCheckFareBasisPreference[] {
  const itineraries = offer.itineraries ?? [];
  const journeyBySegmentRef = new Map<number, number>();
  let segmentRef = 0;
  for (let journeyIndex = 0; journeyIndex < itineraries.length; journeyIndex += 1) {
    const itinerary = itineraries[journeyIndex];
    if (itinerary === undefined) continue;
    for (let index = 0; index < itinerary.segments.length; index += 1) {
      journeyBySegmentRef.set(segmentRef, journeyIndex);
      segmentRef += 1;
    }
  }

  const valuesByJourney = new Map<number, string[]>();
  const components = offer.fareComponents ?? [];
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex];
    const fareBasisCode = component?.fareBasisCode;
    if (component === undefined || fareBasisCode === undefined) continue;
    if (
      fareBasisCode.length < 1 ||
      fareBasisCode.length > SABRE_FLIGHT_CHECK_MAX_FARE_BASIS_LENGTH
    ) {
      throw new SabreFlightCheckRequestError([
        `fareComponents.${String(componentIndex)}.fareBasisCode:invalid_length`,
      ]);
    }

    const coveredJourneys = new Set<number>();
    for (let refIndex = 0; refIndex < component.segmentRefs.length; refIndex += 1) {
      const ref = component.segmentRefs[refIndex];
      const journeyIndex = ref === undefined ? undefined : journeyBySegmentRef.get(ref);
      if (journeyIndex === undefined) {
        throw new SabreFlightCheckRequestError([
          `fareComponents.${String(componentIndex)}.segmentRefs.${String(refIndex)}:out_of_range`,
        ]);
      }
      coveredJourneys.add(journeyIndex);
    }

    for (const journeyIndex of coveredJourneys) {
      const values = valuesByJourney.get(journeyIndex) ?? [];
      if (!values.includes(fareBasisCode)) values.push(fareBasisCode);
      valuesByJourney.set(journeyIndex, values);
    }
  }

  return [...valuesByJourney.entries()]
    .sort(([left], [right]) => left - right)
    .map(([journeyIndex, values]) => ({ values, journeyIndices: [journeyIndex] }));
}
