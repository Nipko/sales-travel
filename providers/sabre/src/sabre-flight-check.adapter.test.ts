import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import type { SabreConfig } from './config';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import {
  SABRE_FLIGHT_CHECK_PATH,
  SabreFlightCheckRequestError,
} from './flight-check/request.builder';
import { SABRE_FLIGHT_CHECK_RAW_KEYS } from './flight-check/response.mapper';
import {
  SabreFlightCheckAdapter,
  SabreFlightCheckNoMatchedOfferError,
  SabreFlightCheckTenantMismatchError,
} from './sabre-flight-check.adapter';

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-08-27T12:00:01.000Z');

const CRITERIA: FlightSearchCriteria = {
  origin: 'BOG',
  destination: 'LIM',
  departureDate: '2026-09-11',
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: 'USD',
};

const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'request-42' };

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: 'https://api.cert.platform.sabre.com',
    epr: '500001',
    password: 'not-used-by-this-mock',
    homePcc: 'ZZZZ',
    conversationIdPrefix: 'sales-travel',
    ...overrides,
  };
}

function searchOffer(): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT_ID,
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'cached', source: 'ATPCO' },
    total: { amountMinor: 9000, currency: 'USD' },
    baseFare: { amountMinor: 7000, currency: 'USD' },
    taxes: { amountMinor: 2000, currency: 'USD' },
    itineraries: [
      {
        totalDurationMinutes: 190,
        stops: 0,
        segments: [
          {
            carrier: 'AV',
            flightNumber: '84',
            origin: 'BOG',
            destination: 'LIM',
            departureAt: '2026-09-11T08:00:00-05:00',
            arrivalAt: '2026-09-11T11:10:00-05:00',
            durationMinutes: 190,
            cabin: 'economy',
            bookingClass: 'M',
          },
        ],
      },
    ],
    fareComponents: [
      {
        fareBasisCode: 'MLOWCO',
        bookingClasses: ['M'],
        segmentRefs: [0],
        cabin: 'economy',
      },
    ],
    fetchedAt: '2026-08-27T11:00:00.000Z',
    expiresAt: '2026-08-27T11:20:00.000Z',
    expiresAtSource: 'platform-policy',
  };
}

function checkedResponse() {
  return {
    timestamp: '2026-08-27T12:00:00.000Z',
    flights: [
      {
        id: 'bf74c8ee-393a-45c8-8f15-a27fa6395050',
        departureAirportCode: 'BOG',
        departureDate: '2026-09-11',
        departureTime: '08:00',
        arrivalAirportCode: 'LIM',
        arrivalDate: '2026-09-11',
        arrivalTime: '11:10',
        marketingAirlineCode: 'AV',
        marketingFlightNumber: 84,
      },
    ],
    journeys: [
      {
        flightRefs: ['bf74c8ee-393a-45c8-8f15-a27fa6395050'],
        requestedJourneyIndex: 0,
      },
    ],
    offers: [
      {
        type: 'FlightOffer',
        id: 'bookable-offer',
        validUntil: '2026-08-27T12:20:00.000Z',
        totalPrice: { amount: '100.00', currencyCode: 'USD' },
        items: [
          {
            type: 'FlightOfferItem',
            id: 'bookable-offer-1-1',
            isMandatory: true,
            fares: [
              {
                travelers: [{ passengerTypeCode: 'ADT' }],
                fareTotal: {
                  equivalentFare: '80.00',
                  taxAmount: '20.00',
                  amount: '100.00',
                  currencyCode: 'USD',
                },
                fareComponents: [
                  {
                    fareBasisCode: 'MLOWCO',
                    segmentDetails: [
                      {
                        flightRef: 'bf74c8ee-393a-45c8-8f15-a27fa6395050',
                        bookingClassCode: 'M',
                        cabinName: 'Economy',
                      },
                    ],
                    brand: { code: 'LIGHT', name: 'LIGHT', programId: 101 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    offerValidationResults: [
      { bookingClassCodeValidation: 'Matched' as const, offerRef: 'bookable-offer' },
    ],
  };
}

function result(data: unknown): SabreResult<unknown> {
  return {
    data,
    status: 200,
    conversationId: 'sales-travel-request-42',
    durationMs: 37,
    warnings: [],
    partialUnauthorized: [],
    partialOutcome: [],
  };
}

function harness(data: unknown, cfg = config()) {
  const postJson = vi.fn().mockResolvedValue(result(data));
  const http = { postJson } as unknown as SabreHttpClient;
  const adapter = new SabreFlightCheckAdapter(cfg, http, {
    now: () => NOW,
    uuid: () => '00000000-0000-4000-8000-000000000099',
  });
  return { adapter, postJson };
}

describe('SabreFlightCheckAdapter', () => {
  it('envía payload ATPCO al endpoint correcto como operación idempotente', async () => {
    const { adapter, postJson } = harness(checkedResponse());
    await adapter.checkOffer(searchOffer(), CRITERIA, CTX);

    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith(
      SABRE_FLIGHT_CHECK_PATH,
      {
        journeys: [
          {
            flights: [
              {
                departureAirportCode: 'BOG',
                departureDate: '2026-09-11',
                departureTime: '08:00',
                arrivalAirportCode: 'LIM',
                arrivalDate: '2026-09-11',
                arrivalTime: '11:10',
                marketingAirlineCode: 'AV',
                marketingFlightNumber: 84,
                segmentDetails: { bookingClassCode: 'M' },
              },
            ],
          },
        ],
        travelers: [{ passengerTypeCode: 'ADT' }],
        fare: {
          currencyCode: 'USD',
          fareBasisCode: {
            preferences: [{ values: ['MLOWCO'], journeyIndices: [0] }],
          },
        },
        processingOptions: { pseudoCityCode: 'ZZZZ' },
      },
      { idempotent: true, conversationId: 'sales-travel-request-42' },
    );
  });

  it('devuelve total, handles de booking, familia y delta revalidados', async () => {
    const quote = await harness(checkedResponse()).adapter.checkOffer(searchOffer(), CRITERIA, CTX);
    expect(quote.offer.total).toEqual({ amountMinor: 10000, currency: 'USD' });
    expect(quote.handles).toMatchObject({
      offerId: 'bookable-offer',
      offerItemIds: ['bookable-offer-1-1'],
      validation: 'Matched',
    });
    expect(quote.offer.fareComponents?.[0]).toMatchObject({
      brand: { code: 'LIGHT', name: 'LIGHT', programId: 101 },
      fareBasisCode: 'MLOWCO',
      bookingClasses: ['M'],
      segmentRefs: [0],
    });
    expect(quote.offer.provider.raw).toMatchObject({
      [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferId]: 'bookable-offer',
      [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferItemIds]: ['bookable-offer-1-1'],
    });
    expect(quote.priceChanged).toBe(true);
    expect(quote.priceChange.deltaMinor).toBe(1000);
    expect(quote.conversationId).toBe('sales-travel-request-42');
  });

  it('implementa OfferPricePort sin perder la advertencia de cambio de precio', async () => {
    const priced = await harness(checkedResponse()).adapter.priceOffer(
      searchOffer(),
      CRITERIA,
      CTX,
    );
    expect(priced.priceChanged).toBe(true);
    expect(priced.offer.provider.offerRef).toBe('bookable-offer');
    expect(priced.warnings).toContain('price-changed');
  });

  it('falla antes de tocar la red si bookingClass falta', async () => {
    const input = searchOffer();
    const segment = input.itineraries?.[0]?.segments[0];
    if (segment === undefined) throw new Error('fixture sin segmento');
    (segment as unknown as { bookingClass?: string }).bookingClass = undefined;
    const { adapter, postJson } = harness(checkedResponse());

    await expect(adapter.checkOffer(input, CRITERIA, CTX)).rejects.toBeInstanceOf(
      SabreFlightCheckRequestError,
    );
    expect(postJson).not.toHaveBeenCalled();
  });

  it('falla antes de la red si la cuenta no aporta homePcc', async () => {
    const { adapter, postJson } = harness(checkedResponse(), config({ homePcc: undefined }));
    await expect(adapter.checkOffer(searchOffer(), CRITERIA, CTX)).rejects.toThrowError(
      /pseudoCityCode:required_for_atpco/,
    );
    expect(postJson).not.toHaveBeenCalled();
  });

  it('falla antes de la red si Offer y contexto pertenecen a tenants diferentes', async () => {
    const { adapter, postJson } = harness(checkedResponse());
    await expect(
      adapter.checkOffer(searchOffer(), CRITERIA, {
        ...CTX,
        tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      }),
    ).rejects.toBeInstanceOf(SabreFlightCheckTenantMismatchError);
    expect(postJson).not.toHaveBeenCalled();
  });

  it('no promueve una alternativa Same cabin si no existe Matched', async () => {
    const raw = checkedResponse();
    const validations = raw as unknown as {
      offerValidationResults: Array<{
        bookingClassCodeValidation: 'Matched' | 'Same cabin';
        offerRef: string;
      }>;
    };
    validations.offerValidationResults = [
      { bookingClassCodeValidation: 'Same cabin', offerRef: 'bookable-offer' },
    ];
    const { adapter } = harness(raw);
    let thrown: unknown;
    try {
      await adapter.checkOffer(searchOffer(), CRITERIA, CTX);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabreFlightCheckNoMatchedOfferError);
    expect((thrown as SabreFlightCheckNoMatchedOfferError).alternativeCount).toBe(1);
  });

  it('propaga el fallo del cliente HTTP sin convertirlo en una oferta vacía', async () => {
    const providerError = new Error('provider failed safely');
    const postJson = vi.fn().mockRejectedValue(providerError);
    const adapter = new SabreFlightCheckAdapter(config(), {
      postJson,
    } as unknown as SabreHttpClient);
    await expect(adapter.checkOffer(searchOffer(), CRITERIA, CTX)).rejects.toBe(providerError);
  });

  it('sin requestId deja que SabreHttpClient genere Conversation-ID', async () => {
    const { adapter, postJson } = harness(checkedResponse());
    await adapter.checkOffer(searchOffer(), CRITERIA, { tenantId: TENANT_ID });
    expect(postJson.mock.calls[0]?.[2]).toEqual({ idempotent: true });
  });
});
