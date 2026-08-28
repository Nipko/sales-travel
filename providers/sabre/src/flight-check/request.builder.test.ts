import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  SABRE_FLIGHT_CHECK_MAX_TRAVELERS,
  SABRE_FLIGHT_CHECK_PATH,
  SabreFlightCheckRequestError,
  buildSabreFlightCheckRequest,
} from './request.builder';

const CRITERIA: FlightSearchCriteria = {
  origin: 'BOG',
  destination: 'LIM',
  departureDate: '2026-09-11',
  returnDate: '2026-09-18',
  paxCount: { adults: 2, children: 1, infants: 1 },
  currency: 'USD',
};

function offer(): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: '11111111-2222-4333-8444-555555555555',
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'cached-atpco', source: 'ATPCO' },
    total: { amountMinor: 45000, currency: 'USD' },
    baseFare: { amountMinor: 38000, currency: 'USD' },
    taxes: { amountMinor: 7000, currency: 'USD' },
    itineraries: [
      {
        totalDurationMinutes: 180,
        stops: 1,
        segments: [
          {
            carrier: 'AV',
            flightNumber: '84',
            origin: 'BOG',
            destination: 'UIO',
            departureAt: '2026-09-11T23:45:00-05:00',
            arrivalAt: '2026-09-12T01:15:00-05:00',
            durationMinutes: 90,
            cabin: 'economy',
            bookingClass: 'M',
          },
          {
            carrier: 'AV',
            flightNumber: '7390',
            origin: 'UIO',
            destination: 'LIM',
            departureAt: '2026-09-12T02:00:00-05:00',
            arrivalAt: '2026-09-12T04:30:00-05:00',
            durationMinutes: 150,
            cabin: 'economy',
            bookingClass: 'M',
          },
        ],
      },
      {
        totalDurationMinutes: 190,
        stops: 0,
        segments: [
          {
            carrier: 'LA',
            flightNumber: '2384',
            origin: 'LIM',
            destination: 'BOG',
            departureAt: '2026-09-18T08:05:30-05:00',
            arrivalAt: '2026-09-18T11:15:30-05:00',
            durationMinutes: 190,
            cabin: 'economy',
            bookingClass: 'Q',
          },
        ],
      },
    ],
    fareComponents: [
      {
        fareBasisCode: 'MLOWCO',
        bookingClasses: ['M'],
        segmentRefs: [0, 1],
        origin: 'BOG',
        destination: 'LIM',
      },
      {
        fareBasisCode: 'QFLEX',
        bookingClasses: ['Q'],
        segmentRefs: [2],
        origin: 'LIM',
        destination: 'BOG',
      },
    ],
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:20:00.000Z',
    expiresAtSource: 'platform-policy',
  };
}

describe('buildSabreFlightCheckRequest', () => {
  it('usa la ruta Flight Check exacta del contrato', () => {
    expect(SABRE_FLIGHT_CHECK_PATH).toBe('/v1/offers/flightCheck');
  });

  it('construye journeys/flights exactos sin convertir la hora local a UTC', () => {
    const request = buildSabreFlightCheckRequest(offer(), CRITERIA, {
      pseudoCityCode: 'ZZZZ',
    });

    expect(request.journeys).toEqual([
      {
        flights: [
          {
            departureAirportCode: 'BOG',
            departureDate: '2026-09-11',
            departureTime: '23:45',
            arrivalAirportCode: 'UIO',
            arrivalDate: '2026-09-12',
            arrivalTime: '01:15',
            marketingAirlineCode: 'AV',
            marketingFlightNumber: 84,
            segmentDetails: { bookingClassCode: 'M' },
          },
          {
            departureAirportCode: 'UIO',
            departureDate: '2026-09-12',
            departureTime: '02:00',
            arrivalAirportCode: 'LIM',
            arrivalDate: '2026-09-12',
            arrivalTime: '04:30',
            marketingAirlineCode: 'AV',
            marketingFlightNumber: 7390,
            segmentDetails: { bookingClassCode: 'M' },
          },
        ],
      },
      {
        flights: [
          {
            departureAirportCode: 'LIM',
            departureDate: '2026-09-18',
            departureTime: '08:05',
            arrivalAirportCode: 'BOG',
            arrivalDate: '2026-09-18',
            arrivalTime: '11:15',
            marketingAirlineCode: 'LA',
            marketingFlightNumber: 2384,
            segmentDetails: { bookingClassCode: 'Q' },
          },
        ],
      },
    ]);
    expect(request.processingOptions).toEqual({ pseudoCityCode: 'ZZZZ' });
  });

  it('expande cada pasajero y usa CNN —no CHD— para menores', () => {
    const request = buildSabreFlightCheckRequest(offer(), CRITERIA);
    expect(request.travelers).toEqual([
      { passengerTypeCode: 'ADT' },
      { passengerTypeCode: 'ADT' },
      { passengerTypeCode: 'CNN' },
      { passengerTypeCode: 'INF' },
    ]);
  });

  it('agrupa fare basis por journey a partir de segmentRefs globales', () => {
    const input = offer();
    input.fareComponents = [
      ...(input.fareComponents ?? []),
      { fareBasisCode: 'MSECOND', segmentRefs: [1] },
      { fareBasisCode: 'MLOWCO', segmentRefs: [0] },
    ];
    const request = buildSabreFlightCheckRequest(input, CRITERIA);
    expect(request.fare).toEqual({
      currencyCode: 'USD',
      fareBasisCode: {
        preferences: [
          { values: ['MLOWCO', 'MSECOND'], journeyIndices: [0] },
          { values: ['QFLEX'], journeyIndices: [1] },
        ],
      },
    });
  });

  it('omite sólo el calificador fareBasis cuando la oferta no lo conoce', () => {
    const input = offer();
    input.fareComponents = [{ segmentRefs: [0, 1, 2] }];
    expect(buildSabreFlightCheckRequest(input, CRITERIA).fare).toEqual({ currencyCode: 'USD' });
  });

  it('falla fuerte y sin repetir valores si falta bookingClass', () => {
    const input = offer();
    const segment = input.itineraries?.[0]?.segments[0];
    if (segment === undefined) throw new Error('fixture sin segmento');
    (segment as unknown as { bookingClass?: string }).bookingClass = undefined;

    let thrown: unknown;
    try {
      buildSabreFlightCheckRequest(input, CRITERIA);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabreFlightCheckRequestError);
    expect(String(thrown)).toContain('itineraries.0.segments.0.bookingClass');
    expect(String(thrown)).not.toContain('cached-atpco');
  });

  it('falla igual antes de normalizar una bookingClass inválida', () => {
    const input = offer();
    const segment = input.itineraries?.[1]?.segments[0];
    if (segment === undefined) throw new Error('fixture sin segmento');
    (segment as unknown as { bookingClass: string }).bookingClass = 'economy-secret';
    expect(() => buildSabreFlightCheckRequest(input, CRITERIA)).toThrowError(
      SabreFlightCheckRequestError,
    );
    try {
      buildSabreFlightCheckRequest(input, CRITERIA);
    } catch (error) {
      expect(String(error)).not.toContain('economy-secret');
    }
  });

  it('rechaza número de vuelo con sufijo porque Flight Check exige entero', () => {
    const input = offer();
    const segment = input.itineraries?.[0]?.segments[0];
    if (segment === undefined) throw new Error('fixture sin segmento');
    segment.flightNumber = '84A';
    expect(() => buildSabreFlightCheckRequest(input, CRITERIA)).toThrowError(
      /flightNumber:integer_required/,
    );
  });

  it('rechaza fare basis que excede los 15 caracteres del contrato sin publicarlo', () => {
    const input = offer();
    const secret = 'FARE-BASIS-MUY-LARGO';
    input.fareComponents = [{ fareBasisCode: secret, segmentRefs: [0] }];
    let message = '';
    try {
      buildSabreFlightCheckRequest(input, CRITERIA);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('fareComponents.0.fareBasisCode');
    expect(message).not.toContain(secret);
  });

  it('rechaza segmentRefs fuera del itinerario en vez de enviar el fare basis al journey errado', () => {
    const input = offer();
    input.fareComponents = [{ fareBasisCode: 'SAFEFARE', segmentRefs: [99] }];
    expect(() => buildSabreFlightCheckRequest(input, CRITERIA)).toThrowError(
      /segmentRefs.0:out_of_range/,
    );
  });

  it('rechaza una oferta sin itinerario', () => {
    const input = offer();
    input.itineraries = undefined;
    expect(() => buildSabreFlightCheckRequest(input, CRITERIA)).toThrowError(
      /itineraries:required/,
    );
  });

  it('respeta el máximo agregado de 9 viajeros aunque cada conteo aislado sea válido', () => {
    const criteria: FlightSearchCriteria = {
      ...CRITERIA,
      paxCount: { adults: 5, children: SABRE_FLIGHT_CHECK_MAX_TRAVELERS - 4, infants: 0 },
    };
    expect(() => buildSabreFlightCheckRequest(offer(), criteria)).toThrowError(
      /travelers:too_many/,
    );
  });

  it('no usa payload-based Flight Check para una oferta marcada NDC', () => {
    const input = offer();
    input.provider.source = 'NDC';
    expect(() => buildSabreFlightCheckRequest(input, CRITERIA)).toThrowError(
      /provider.source:unsupported_for_atpco/,
    );
  });

  it('valida el PCC por forma y nunca repite el valor inválido', () => {
    const pcc = 'PCC-SECRET';
    let message = '';
    try {
      buildSabreFlightCheckRequest(offer(), CRITERIA, { pseudoCityCode: pcc });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('processingOptions.pseudoCityCode');
    expect(message).not.toContain(pcc);
  });
});
