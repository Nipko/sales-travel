import type { Offer } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import {
  SABRE_FLIGHT_CHECK_RAW_KEYS,
  SabreFlightCheckMappingError,
  SabreFlightCheckRejectedError,
  mapSabreFlightCheckResponse,
} from './response.mapper';

const OUT_REF = 'bf74c8ee-393a-45c8-8f15-a27fa6395050';
const BACK_REF = 'cf74c8ee-393a-45c8-8f15-a27fa6395051';

function basis(): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: '11111111-2222-4333-8444-555555555555',
    products: ['flight'],
    provider: {
      name: 'sabre',
      offerRef: 'cached-atpco',
      source: 'ATPCO',
      raw: { searchTrace: 'opaque-safe-value' },
    },
    total: { amountMinor: 45000, currency: 'USD' },
    baseFare: { amountMinor: 38000, currency: 'USD' },
    taxes: { amountMinor: 7000, currency: 'USD' },
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
      {
        totalDurationMinutes: 190,
        stops: 0,
        segments: [
          {
            carrier: 'LA',
            flightNumber: '2384',
            origin: 'LIM',
            destination: 'BOG',
            departureAt: '2026-09-18T09:00:00-05:00',
            arrivalAt: '2026-09-18T12:10:00-05:00',
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
        segmentRefs: [0],
        origin: 'BOG',
        destination: 'LIM',
        cabin: 'economy',
        brand: { code: 'OLDLIGHT', name: 'OLD LIGHT' },
      },
      {
        fareBasisCode: 'QFLEX',
        bookingClasses: ['Q'],
        segmentRefs: [1],
        origin: 'LIM',
        destination: 'BOG',
        cabin: 'economy',
        brand: { code: 'OLDFLEX', name: 'OLD FLEX' },
      },
    ],
    fareFamily: { name: 'OLD', cabin: 'economy' },
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:20:00.000Z',
    expiresAtSource: 'platform-policy',
  };
}

function fareComponent(
  flightRef: string,
  bookingClassCode: string,
  fareBasisCode: string,
  code: string,
  name: string,
) {
  return {
    fareBasisCode,
    segmentDetails: [{ flightRef, bookingClassCode, cabinName: 'Economy' }],
    brand: { code, name, programId: code === 'LIGHT' ? 101 : 202 },
  };
}

function flightOffer(
  id: string,
  itemId: string,
  total = '500.00',
  outboundBrand: readonly [string, string] = ['LIGHT', 'LIGHT'],
  inboundBrand: readonly [string, string] = ['FLEX', 'FLEX'],
) {
  return {
    type: 'FlightOffer',
    id,
    createdAt: '2026-08-27T12:00:00.000Z',
    validUntil: '2026-08-27T12:20:00.000Z',
    source: { provider: 'Sabre', distributionModel: 'ATPCO' },
    totalPrice: { amount: total, currencyCode: 'USD' },
    items: [
      {
        type: 'FlightOfferItem',
        id: itemId,
        isMandatory: true,
        fares: [
          {
            travelers: [{ passengerTypeCode: 'ADT', requestedTravelerIndex: 0 }],
            fareTotal: {
              equivalentFare: '400.00',
              taxAmount: '100.00',
              amount: '500.00',
              currencyCode: 'USD',
            },
            fareComponents: [
              fareComponent(OUT_REF, 'M', 'MLOWCO', outboundBrand[0], outboundBrand[1]),
              fareComponent(BACK_REF, 'Q', 'QFLEX', inboundBrand[0], inboundBrand[1]),
            ],
          },
        ],
      },
    ],
  };
}

interface ResponseFixture {
  timestamp: string;
  warnings: Array<{
    category: string;
    type: string;
    description?: string;
    fieldPath?: string;
    fieldValue?: string;
  }>;
  flights: Array<Record<string, string | number>>;
  journeys: Array<{ flightRefs: string[]; requestedJourneyIndex: number }>;
  offers: Array<ReturnType<typeof flightOffer>>;
  offerValidationResults: Array<{
    bookingClassCodeValidation: 'Matched' | 'Same cabin' | 'None' | 'Unknown';
    offerRef?: string;
  }>;
}

function response(): ResponseFixture {
  return {
    timestamp: '2026-08-27T12:00:00.000Z',
    warnings: [
      {
        category: 'NDC_WARNING',
        type: 'EXTERNAL_PROVIDER_WARNING',
        description: 'texto libre secreto que no debe cruzar',
        fieldPath: 'fare.currencyCode',
        fieldValue: 'SECRET-VALUE',
      },
    ],
    flights: [
      {
        id: OUT_REF,
        departureAirportCode: 'BOG',
        departureDate: '2026-09-11',
        departureTime: '08:00',
        arrivalAirportCode: 'LIM',
        arrivalDate: '2026-09-11',
        arrivalTime: '11:10',
        marketingAirlineCode: 'AV',
        marketingFlightNumber: 84,
      },
      {
        id: BACK_REF,
        departureAirportCode: 'LIM',
        departureDate: '2026-09-18',
        departureTime: '09:00',
        arrivalAirportCode: 'BOG',
        arrivalDate: '2026-09-18',
        arrivalTime: '12:10',
        marketingAirlineCode: 'LA',
        marketingFlightNumber: 2384,
      },
    ],
    journeys: [
      { flightRefs: [OUT_REF], requestedJourneyIndex: 0 },
      { flightRefs: [BACK_REF], requestedJourneyIndex: 1 },
    ],
    offers: [
      flightOffer('same-cabin-offer', 'same-cabin-offer-1-1', '525.00'),
      flightOffer('matched-offer', 'matched-offer-1-1'),
    ],
    // La alternativa va primero a propósito: el orden de `offers`/validaciones no puede decidir.
    offerValidationResults: [
      { bookingClassCodeValidation: 'Same cabin' as const, offerRef: 'same-cabin-offer' },
      { bookingClassCodeValidation: 'Matched' as const, offerRef: 'matched-offer' },
    ],
  };
}

function map(raw: unknown, original = basis()) {
  let sequence = 1;
  return mapSabreFlightCheckResponse(raw, {
    basis: original,
    fetchedAt: '2026-08-27T12:00:01.000Z',
    uuid: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
  });
}

describe('mapSabreFlightCheckResponse — selección y handles', () => {
  it('elige por validación Matched aunque Same cabin y su offer aparezcan primero', () => {
    const mapped = map(response());
    expect(mapped.matched?.handles).toEqual({
      offerId: 'matched-offer',
      offerItemIds: ['matched-offer-1-1'],
      validation: 'Matched',
      validUntil: '2026-08-27T12:20:00.000Z',
    });
    expect(mapped.matched?.offer.total).toEqual({ amountMinor: 50000, currency: 'USD' });
    expect(mapped.alternatives).toHaveLength(1);
    expect(mapped.alternatives[0]?.handles.validation).toBe('Same cabin');
    expect(mapped.alternatives[0]?.handles.offerId).toBe('same-cabin-offer');
    expect(mapped.warnings.map((warning) => warning.code)).toContain('same-cabin-alternative');
  });

  it('publica handles content-neutral en provider.raw y conserva el raw previo', () => {
    const mapped = map(response());
    expect(mapped.matched?.offer.provider.raw).toMatchObject({
      searchTrace: 'opaque-safe-value',
      [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferId]: 'matched-offer',
      [SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferItemIds]: ['matched-offer-1-1'],
      [SABRE_FLIGHT_CHECK_RAW_KEYS.validation]: 'Matched',
      [SABRE_FLIGHT_CHECK_RAW_KEYS.validUntil]: '2026-08-27T12:20:00.000Z',
    });
    expect(mapped.matched?.offer.provider.raw).not.toHaveProperty('ndcOfferId');
  });

  it('excluye items opcionales de handles, componentes y precio reservable', () => {
    const raw = response();
    const matched = raw.offers[1];
    const mandatory = matched?.items[0];
    if (matched === undefined || mandatory === undefined) throw new Error('fixture incompleto');
    matched.items.push({
      ...structuredClone(mandatory),
      id: 'optional-ancillary-like-item',
      isMandatory: false,
    });

    const mapped = map(raw);
    expect(mapped.matched?.handles.offerItemIds).toEqual(['matched-offer-1-1']);
    expect(
      mapped.matched?.offer.provider.raw?.[SABRE_FLIGHT_CHECK_RAW_KEYS.bookingOfferItemIds],
    ).toEqual(['matched-offer-1-1']);
    expect(mapped.matched?.offer.fareComponents).toHaveLength(2);
    expect(mapped.matched?.offer.baseFare).toEqual({ amountMinor: 40000, currency: 'USD' });
  });

  it('falla cerrado ante un item obligatorio cuyo subtipo no puede distinguir', () => {
    const raw = response();
    raw.offers[1]!.items[0]!.type = 'AncillaryOfferItem';

    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.warnings).toContainEqual({
      code: 'offer-invalid',
      path: 'offers[1].items[0].type',
      detail: 'mandatory-item-type-unsupported',
    });
  });

  it('arrastra exactamente el itinerario original, no el reconstruido sin offset', () => {
    const original = basis();
    const itineraries = original.itineraries;
    const mapped = map(response(), original);
    expect(mapped.matched?.offer.itineraries).toBe(itineraries);
    expect(mapped.matched?.offer.itineraries).toEqual(original.itineraries);
  });

  it('mapea una familia distinta por componente/trayecto', () => {
    const mapped = map(response());
    expect(mapped.matched?.offer.fareComponents).toEqual([
      {
        brand: { code: 'LIGHT', name: 'LIGHT', programId: 101 },
        fareBasisCode: 'MLOWCO',
        bookingClasses: ['M'],
        segmentRefs: [0],
        origin: 'BOG',
        destination: 'LIM',
        cabin: 'economy',
      },
      {
        brand: { code: 'FLEX', name: 'FLEX', programId: 202 },
        fareBasisCode: 'QFLEX',
        bookingClasses: ['Q'],
        segmentRefs: [1],
        origin: 'LIM',
        destination: 'BOG',
        cabin: 'economy',
      },
    ]);
    expect(mapped.matched?.offer.fareFamily).toBeUndefined();
  });

  it('sólo deriva fareFamily global cuando todos los componentes coinciden', () => {
    const raw = response();
    raw.offers[1] = flightOffer(
      'matched-offer',
      'matched-offer-1-1',
      '500.00',
      ['FLEX', 'FLEX'],
      ['FLEX', 'FLEX'],
    );
    const mapped = map(raw);
    expect(mapped.matched?.offer.fareFamily).toEqual({ name: 'FLEX', cabin: 'economy' });
  });

  it('deduplica componentes repetidos por fare/pax sin perder la asociación', () => {
    const raw = response();
    const components = raw.offers[1]?.items[0]?.fares[0]?.fareComponents;
    const first = components?.[0];
    if (components === undefined || first === undefined) throw new Error('fixture incompleto');
    components.push({ ...first, segmentDetails: [...first.segmentDetails] });
    expect(map(raw).matched?.offer.fareComponents).toHaveLength(2);
  });

  it('deduplica el mismo producto entre ADT/CHD aunque cambie el total por PTC', () => {
    const raw = response();
    const fares = raw.offers[1]?.items[0]?.fares;
    const adult = fares?.[0];
    if (fares === undefined || adult === undefined) throw new Error('fixture incompleto');
    fares.push({
      ...structuredClone(adult),
      travelers: [{ passengerTypeCode: 'CNN', requestedTravelerIndex: 1 }],
      fareTotal: {
        equivalentFare: '300.00',
        taxAmount: '75.00',
        amount: '375.00',
        currencyCode: 'USD',
      },
      fareComponents: [...structuredClone(adult.fareComponents)].reverse(),
    });

    expect(map(raw).matched?.offer.fareComponents).toHaveLength(2);
  });

  it('calcula total/base/impuestos y el delta contra la oferta de búsqueda', () => {
    const mapped = map(response());
    expect(mapped.matched?.offer.baseFare).toEqual({ amountMinor: 40000, currency: 'USD' });
    expect(mapped.matched?.offer.taxes).toEqual({ amountMinor: 10000, currency: 'USD' });
    expect(mapped.priceChange).toEqual({
      kind: 'increased',
      previousTotalMinor: 45000,
      checkedTotalMinor: 50000,
      previousCurrency: 'USD',
      checkedCurrency: 'USD',
      deltaMinor: 5000,
    });
    expect(mapped.warnings.map((warning) => warning.code)).toContain('price-changed');
  });
});

describe('mapSabreFlightCheckResponse — asociación defensiva de componentes', () => {
  it('puede asociar flightRef por identidad cuando journeys no viene', () => {
    const raw = response();
    delete (raw as { journeys?: unknown }).journeys;
    expect(
      map(raw).matched?.offer.fareComponents?.map((component) => component.segmentRefs),
    ).toEqual([[0], [1]]);
  });

  it('un flightRef irresoluble no se rellena desde fare basis previo: falla cerrado', () => {
    const raw = response();
    const component = raw.offers[1]?.items[0]?.fares[0]?.fareComponents[0];
    if (component === undefined) throw new Error('fixture incompleto');
    const detail = component.segmentDetails[0];
    if (detail === undefined) throw new Error('fixture sin detalle');
    component.segmentDetails[0] = { ...detail, flightRef: 'unknown-ref' };
    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.warnings.map((warning) => warning.code)).toContain('fare-component-unmapped');
  });

  it('si la respuesta omite un trayecto no publica handles nuevos con identidad vieja', () => {
    const raw = response();
    const components = raw.offers[1]?.items[0]?.fares[0]?.fareComponents;
    if (components === undefined) throw new Error('fixture incompleto');
    components.splice(1, 1);
    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.warnings.map((warning) => warning.code)).toContain('fare-components-incomplete');
    expect(JSON.stringify(mapped)).not.toContain('OLDFLEX');
  });

  it('sin RBD o cabina confirmados tampoco conserva los valores de búsqueda', () => {
    for (const field of ['bookingClassCode', 'cabinName'] as const) {
      const raw = response();
      const detail = raw.offers[1]?.items[0]?.fares[0]?.fareComponents[0]?.segmentDetails[0];
      if (detail === undefined) throw new Error('fixture incompleto');
      delete detail[field];
      const mapped = map(raw);
      expect(mapped.matched).toBeNull();
      expect(mapped.warnings.map((warning) => warning.code)).toContain('fare-component-unmapped');
    }
  });

  it('si el desglose nuevo no cuadra mantiene impuestos previos, deriva base y avisa', () => {
    const raw = response();
    const fareTotal = raw.offers[1]?.items[0]?.fares[0]?.fareTotal;
    if (fareTotal === undefined) throw new Error('fixture incompleto');
    delete (fareTotal as { equivalentFare?: string }).equivalentFare;
    const mapped = map(raw);
    expect(mapped.matched?.offer.taxes.amountMinor).toBe(7000);
    expect(mapped.matched?.offer.baseFare.amountMinor).toBe(43000);
    expect(mapped.warnings.map((warning) => warning.code)).toContain('price-breakdown-unavailable');
  });

  it('mapea cambio de moneda sin fabricar un delta entre monedas', () => {
    const raw = response();
    const matched = raw.offers[1];
    const fareTotal = matched?.items[0]?.fares[0]?.fareTotal;
    if (matched === undefined || fareTotal === undefined) throw new Error('fixture incompleto');
    matched.totalPrice.currencyCode = 'EUR';
    fareTotal.currencyCode = 'EUR';
    const mapped = map(raw);
    expect(mapped.priceChange?.kind).toBe('currency-changed');
    expect(mapped.priceChange?.deltaMinor).toBeUndefined();
    expect(mapped.matched?.offer.total.currency).toBe('EUR');
  });
});

describe('mapSabreFlightCheckResponse — estados de validación', () => {
  it('no sustituye con Same cabin si el Matched declarado no está materializado', () => {
    const raw = response();
    raw.offers = [raw.offers[0]!];
    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.alternatives[0]?.handles.offerId).toBe('same-cabin-offer');
    expect(mapped.warnings.map((warning) => warning.code)).toContain('matched-offer-missing');
    expect(mapped.warnings.map((warning) => warning.code)).toContain('validation-offer-missing');
  });

  it('con sólo Same cabin devuelve alternativa y ningún principal', () => {
    const raw = response();
    raw.offers = [raw.offers[0]!];
    raw.offerValidationResults = [raw.offerValidationResults[0]!];
    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.alternatives).toHaveLength(1);
  });

  it('infiere Matched sin offerRef sólo cuando hay exactamente una oferta', () => {
    const raw = response();
    raw.offers = [raw.offers[1]!];
    raw.offerValidationResults = [{ bookingClassCodeValidation: 'Matched' }];
    expect(map(raw).matched?.handles.offerId).toBe('matched-offer');
  });

  it('no adivina un Matched sin offerRef entre dos ofertas', () => {
    const raw = response();
    raw.offerValidationResults = [{ bookingClassCodeValidation: 'Matched' }];
    expect(map(raw).matched).toBeNull();
  });

  it('si Sabre declara dos Matched elige el primero de forma explícita y avisa', () => {
    const raw = response();
    raw.offerValidationResults = [
      { bookingClassCodeValidation: 'Matched', offerRef: 'matched-offer' },
      { bookingClassCodeValidation: 'Matched', offerRef: 'same-cabin-offer' },
    ];
    const mapped = map(raw);
    expect(mapped.matched?.handles.offerId).toBe('matched-offer');
    expect(mapped.warnings.map((warning) => warning.code)).toContain('multiple-matched-offers');
  });

  it('None y Unknown quedan como avisos y nunca como éxito', () => {
    const raw = response();
    raw.offers = [];
    raw.offerValidationResults = [
      { bookingClassCodeValidation: 'None' },
      { bookingClassCodeValidation: 'Unknown' },
    ];
    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['availability-not-matched', 'validation-unknown']),
    );
  });
});

describe('mapSabreFlightCheckResponse — warnings, errores y forma', () => {
  it('conserva sólo slots estructurados del warning y descarta description/fieldValue', () => {
    const mapped = map(response());
    expect(mapped.providerWarnings).toEqual([
      {
        category: 'NDC_WARNING',
        type: 'EXTERNAL_PROVIDER_WARNING',
        fieldPath: 'fare.currencyCode',
      },
    ]);
    const serialized = JSON.stringify(mapped.providerWarnings);
    expect(serialized).not.toContain('texto libre secreto');
    expect(serialized).not.toContain('SECRET-VALUE');
  });

  it('redacta category/type no publicables en vez de transportarlos', () => {
    const raw = response();
    raw.warnings = [
      {
        category: 'pasaporte 123456789',
        type: 'texto con espacios',
        description: 'otro secreto',
        fieldPath: 'path con espacios',
        fieldValue: 'SECRET',
      },
    ];
    expect(map(raw).providerWarnings).toEqual([{ category: 'UNPUBLISHED', type: 'UNPUBLISHED' }]);
  });

  it('mapea errors[] a error tipado sin description ni fieldValue', () => {
    const secret = 'PASSPORT-SECRET-123';
    const raw = {
      timestamp: '2026-08-27T12:00:00.000Z',
      errors: [
        {
          category: 'BAD_REQUEST',
          type: 'REQUIRED_FIELD_MISSING',
          description: secret,
          fieldPath: 'journeys[0].flights[0].segmentDetails.bookingClassCode',
          fieldValue: secret,
        },
      ],
    };
    let thrown: unknown;
    try {
      map(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabreFlightCheckRejectedError);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect((thrown as SabreFlightCheckRejectedError).providerIssues).toEqual([
      {
        category: 'BAD_REQUEST',
        type: 'REQUIRED_FIELD_MISSING',
        fieldPath: 'journeys[0].flights[0].segmentDetails.bookingClassCode',
      },
    ]);
  });

  it('falla con error de forma que sólo lista ruta/código de Zod', () => {
    const raw = response() as unknown as { offers: Array<{ totalPrice: { amount: unknown } }> };
    raw.offers[1]!.totalPrice.amount = { secret: 'NEVER-LOG-ME' };
    let thrown: unknown;
    try {
      map(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabreFlightCheckMappingError);
    expect(String(thrown)).toContain('offers.1.totalPrice.amount');
    expect(String(thrown)).not.toContain('NEVER-LOG-ME');
  });

  it('descarta la oferta con total ilegible y no devuelve un precio aproximado', () => {
    const raw = response();
    raw.offers[1]!.totalPrice.amount = '500.001';
    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.warnings.map((warning) => warning.code)).toContain('offer-invalid');
  });

  it('rechaza como fuera de contrato una oferta con items vacío', () => {
    const raw = response();
    raw.offers[1]!.items = [];
    expect(() => map(raw)).toThrowError(SabreFlightCheckMappingError);
  });

  it('una oferta que ya llegó vencida no puede regresar como reservable', () => {
    const raw = response();
    raw.offers[1]!.validUntil = '2026-08-27T11:59:59.000Z';
    const mapped = map(raw);
    expect(mapped.matched).toBeNull();
    expect(mapped.warnings.map((warning) => warning.code)).toContain('offer-already-expired');
  });

  it('avisa si los handles exceden los límites de createBooking', () => {
    const raw = response();
    const matched = raw.offers[1]!;
    const longId = 'x'.repeat(50);
    matched.id = longId;
    matched.items = Array.from({ length: 10 }, (_, index) => ({
      ...matched.items[0]!,
      id: `item-${String(index)}`,
    }));
    raw.offerValidationResults[1] = {
      bookingClassCodeValidation: 'Matched',
      offerRef: longId,
    };
    const codes = map(raw).warnings.map((warning) => warning.code);
    expect(codes).toContain('offer-id-over-booking-limit');
    expect(codes).toContain('offer-items-over-booking-limit');
  });
});
