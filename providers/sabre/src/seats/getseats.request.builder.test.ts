import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { SABRE_RAW_KEYS } from '../price/request.builder';
import {
  SABRE_GETSEATS_BASE_PATH,
  SABRE_GETSEATS_NDC_OFFER_PATH,
  SABRE_GETSEATS_PAYLOAD_PATH,
  SabreGetSeatsNdcOfferRequestSchema,
  SabreGetSeatsPayloadRequestSchema,
  SabreGetSeatsRequestError,
  buildSabreGetSeatsRequest,
  type SabreGetSeatsPayloadRequest,
  type SabreGetSeatsRequestPlan,
} from './getseats.request.builder';

type Json = Record<string, unknown>;

const TENANT_ID = '11111111-2222-4333-8444-555555555555';

/** Sube hasta la raíz del monorepo: vitest puede arrancar desde la raíz o desde el paquete. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

const EVIDENCE = join(findRepoRoot(), 'docs', 'sabre', 'evidence', 'specs');

function criteria(adults = 1, children = 0, infants = 0): FlightSearchCriteria {
  return {
    origin: 'SCL',
    destination: 'LIM',
    departureDate: '2026-03-02',
    paxCount: { adults, children, infants },
    currency: 'USD',
  };
}

/**
 * La oferta que corresponde al request del ejemplo oficial de payload
 * (`help/get-seats-agency-3.0/get-seats-v3-get-seats-payload.txt:9-96`): LA640 SCL-LIM y LA477
 * SCL-EZE, clase Y, marca EOU, fare basis YOWLGN3/YOWLGN4.
 */
function latamOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT_ID,
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'cached', source: 'ATPCO' },
    total: { amountMinor: 77700, currency: 'USD' },
    baseFare: { amountMinor: 70000, currency: 'USD' },
    taxes: { amountMinor: 7700, currency: 'USD' },
    itineraries: [
      {
        totalDurationMinutes: 230,
        stops: 0,
        segments: [
          {
            carrier: 'LA',
            flightNumber: '640',
            origin: 'SCL',
            destination: 'LIM',
            departureAt: '2026-03-02T13:40:00-03:00',
            arrivalAt: '2026-03-02T15:30:00-05:00',
            durationMinutes: 230,
            cabin: 'economy',
            bookingClass: 'Y',
            operatingCarrier: 'LA',
            operatingFlightNumber: '640',
          },
        ],
      },
      {
        totalDurationMinutes: 123,
        stops: 0,
        segments: [
          {
            carrier: 'LA',
            flightNumber: '477',
            origin: 'SCL',
            destination: 'EZE',
            departureAt: '2026-03-04T16:01:00-03:00',
            arrivalAt: '2026-03-04T18:04:00-03:00',
            durationMinutes: 123,
            cabin: 'economy',
            bookingClass: 'Y',
            operatingCarrier: 'LA',
            operatingFlightNumber: '477',
          },
        ],
      },
    ],
    fareComponents: [
      { fareBasisCode: 'YOWLGN3', brand: { code: 'EOU', name: 'LIGHT' }, segmentRefs: [0] },
      { fareBasisCode: 'YOWLGN4', brand: { code: 'EOU', name: 'LIGHT' }, segmentRefs: [1] },
    ],
    fetchedAt: '2026-02-20T12:00:00.000Z',
    expiresAt: '2026-02-20T12:20:00.000Z',
    ...overrides,
  };
}

function payload(plan: SabreGetSeatsRequestPlan): SabreGetSeatsPayloadRequest {
  if (plan.mode !== 'payload') throw new Error(`se esperaba payload, llegó ${plan.mode}`);
  return plan.body;
}

function buildError(run: () => unknown): SabreGetSeatsRequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof SabreGetSeatsRequestError) return error;
    throw error;
  }
  throw new Error('el builder no lanzó');
}

function omit<T extends object>(value: T, keys: readonly string[]): Json {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** El request del ejemplo oficial, leído de la evidencia congelada y no copiado a mano. */
function officialPayloadRequest(): Json {
  const text = readFileSync(
    join(EVIDENCE, 'help', 'get-seats-agency-3.0', 'get-seats-v3-get-seats-payload.txt'),
    'utf8',
  );
  const start = text.indexOf('{', text.indexOf('\nRequest'));
  const end = text.indexOf('\nResponse');
  return JSON.parse(text.slice(start, end)) as Json;
}

// ---------------------------------------------------------------------------------------------
// El contrato congelado, leído del `.yml`
// ---------------------------------------------------------------------------------------------

const SPEC = readFileSync(join(EVIDENCE, 'get-seats-agency-3.0.yml'), 'utf8').split(/\r?\n/);

interface SchemaShape {
  readonly properties: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

/**
 * Propiedades y obligatorios de un schema de `get-seats-agency-3.0.yml`, siguiendo los `allOf`
 * con `$ref`. Sin parser de YAML: los bloques son de indentación fija y `spec-manifest.test.ts` ya
 * vigila que el `.yml` no cambie por debajo.
 */
function schemaShape(name: string): SchemaShape {
  const start = SPEC.findIndex((line) => line === `    ${name}:`);
  if (start < 0) throw new Error(`el contrato no declara ${name}`);
  const block: string[] = [];
  for (const line of SPEC.slice(start + 1)) {
    if (/^ {4}\S/.test(line)) break;
    block.push(line);
  }

  const properties = new Set<string>();
  const required = new Set<string>();
  block.forEach((line, index) => {
    const props = /^(\s+)properties:\s*$/.exec(line);
    if (props?.[1] !== undefined) {
      const indent = props[1].length + 2;
      for (const next of block.slice(index + 1)) {
        if (next.trim() === '') continue;
        const lead = next.length - next.trimStart().length;
        if (lead < indent) break;
        const key = lead === indent ? /^\s+([A-Za-z]+):\s*$/.exec(next)?.[1] : undefined;
        if (key !== undefined) properties.add(key);
      }
    }
    if (/^\s+required:\s*$/.test(line)) {
      for (const next of block.slice(index + 1)) {
        const item = /^\s+- ([A-Za-z]+)\s*$/.exec(next)?.[1];
        if (item === undefined) break;
        required.add(item);
      }
    }
    const ref = /^\s+- \$ref: ['"]#\/components\/schemas\/([A-Za-z]+)['"]\s*$/.exec(line)?.[1];
    if (ref !== undefined) {
      const inner = schemaShape(ref);
      inner.properties.forEach((key) => properties.add(key));
      inner.required.forEach((key) => required.add(key));
    }
  });
  if (properties.size === 0) throw new Error(`${name} sin propiedades: el lector se rompió`);
  return { properties, required };
}

function expectWithinContract(value: object, schema: string): void {
  const shape = schemaShape(schema);
  const keys = Object.keys(value);
  expect(
    keys.filter((key) => !shape.properties.has(key)),
    `${schema}: claves que el contrato no declara`,
  ).toEqual([]);
  expect(
    [...shape.required].filter((key) => !keys.includes(key)),
    `${schema}: obligatorios que faltan`,
  ).toEqual([]);
}

describe('rutas del contrato', () => {
  it('basePath /v3/offers y las dos operaciones de agencia que usamos', () => {
    const basePathAt = SPEC.findIndex((line) => line === '      basePath:');
    expect(SPEC[basePathAt + 1]?.trim()).toBe(`default: ${SABRE_GETSEATS_BASE_PATH}`);
    for (const path of [SABRE_GETSEATS_PAYLOAD_PATH, SABRE_GETSEATS_NDC_OFFER_PATH]) {
      const operation = path.slice(SABRE_GETSEATS_BASE_PATH.length);
      expect(SPEC).toContain(`  ${operation}:`);
    }
  });

  it('el lector del contrato distingue: los obligatorios del payload son los tres del .yml', () => {
    expect([...schemaShape('SeatAvailabilityByPayloadRq').required].sort()).toEqual([
      'passengers',
      'returnSeatMapsOnlyForSegmentRefs',
      'segments',
    ]);
    // `SegmentPayloadRq` es `allOf` y sus obligatorios viven en `SegmentBase`.
    expect(schemaShape('SegmentPayloadRq').required).toContain('bookingClassCode');
  });
});

// ---------------------------------------------------------------------------------------------
// ATPCO / LCC — byReservationPayload
// ---------------------------------------------------------------------------------------------

describe('payload ATPCO', () => {
  it('va a byReservationPayload con ids técnicos e índices que casan con la oferta', () => {
    const plan = buildSabreGetSeatsRequest(latamOffer(), criteria(2));
    expect(plan.mode).toBe('payload');
    expect(plan.path).toBe(SABRE_GETSEATS_PAYLOAD_PATH);
    expect([...plan.segmentIndexById]).toEqual([
      ['segment_1', 0],
      ['segment_2', 1],
    ]);
    expect([...plan.passengerIndexById]).toEqual([
      ['passenger_1', 0],
      ['passenger_2', 1],
    ]);
  });

  it('coincide campo a campo con el request oficial, salvo lo que no tenemos o no debe viajar', () => {
    const official = officialPayloadRequest();
    const body = payload(buildSabreGetSeatsRequest(latamOffer(), criteria(2)));

    expect(body.returnSeatMapsOnlyForSegmentRefs).toEqual(
      official['returnSeatMapsOnlyForSegmentRefs'],
    );
    // La clase operada no existe en el canónico.
    expect(body.segments).toEqual(
      (official['segments'] as Json[]).map((segment) =>
        omit(segment, ['operatingBookingClassCode']),
      ),
    );
    // Nombres: un mapa antes de reservar no necesita saber quién viaja. `isAccompaniedByInfant:
    // false` es el default del contrato y se omite.
    expect(body.passengers).toEqual(
      (official['passengers'] as Json[]).map((passenger) =>
        omit(passenger, ['givenName', 'surname', 'isAccompaniedByInfant']),
      ),
    );
    // Transportista que gobierna, importe y detalle de la tarifa no viven en `FareComponent`.
    expect(body.fareComponents).toEqual(
      (official['fareComponents'] as Json[]).map((component) =>
        omit(component, ['governingCarrier', 'totalPrice', 'fareDetail']),
      ),
    );
    // La moneda no está en el ejemplo: la mandamos para que el precio del asiento venga en la de
    // la oferta y no en la que Sabre decida.
    expect(body.currencyCode).toBe('USD');
  });

  it('cada objeto del cuerpo usa sólo claves del contrato y lleva sus obligatorios', () => {
    const body = payload(buildSabreGetSeatsRequest(latamOffer(), criteria(2, 1, 1)));
    expectWithinContract(body, 'SeatAvailabilityByPayloadRq');
    body.segments.forEach((segment) => expectWithinContract(segment, 'SegmentPayloadRq'));
    body.passengers.forEach((passenger) => {
      expectWithinContract(passenger, 'PassengerPayloadRq');
      passenger.fareSegmentAssociation?.forEach((association) =>
        expectWithinContract(association, 'FareSegmentAssociation'),
      );
    });
    body.fareComponents?.forEach((component) => expectWithinContract(component, 'FareComponent'));
  });

  it('adultos, luego niños; el infante en brazos viaja como isAccompaniedByInfant', () => {
    const plan = buildSabreGetSeatsRequest(latamOffer(), criteria(2, 1, 1));
    const body = payload(plan);
    expect(
      body.passengers.map((passenger) => ({
        id: passenger.id,
        type: passenger.passengerType,
        infant: passenger.isAccompaniedByInfant ?? false,
        fares: passenger.fareSegmentAssociation?.length ?? 0,
      })),
    ).toEqual([
      { id: 'passenger_1', type: 'ADT', infant: true, fares: 2 },
      { id: 'passenger_2', type: 'ADT', infant: false, fares: 2 },
      // El fare basis de la oferta es el del adulto: el niño no se asocia a él.
      { id: 'passenger_3', type: 'CNN', infant: false, fares: 0 },
    ]);
    expect([...plan.passengerIndexById.values()]).toEqual([0, 1, 2]);
  });

  it('un componente de tarifa que cubre dos segmentos se asocia a los dos', () => {
    const body = payload(
      buildSabreGetSeatsRequest(
        latamOffer({ fareComponents: [{ fareBasisCode: 'YRT', segmentRefs: [0, 1] }] }),
        criteria(),
      ),
    );
    expect(body.fareComponents).toEqual([{ fareComponentId: 'fareComponent1', fareBasis: 'YRT' }]);
    expect(body.passengers[0]?.fareSegmentAssociation).toEqual([
      { segmentRef: 'segment_1', fareComponentRef: 'fareComponent1' },
      { segmentRef: 'segment_2', fareComponentRef: 'fareComponent1' },
    ]);
  });

  it.each([
    ['sin fare basis', [{ segmentRefs: [0] }]],
    ['fare basis en blanco', [{ fareBasisCode: '  ', segmentRefs: [0] }]],
    ['segmento fuera de la oferta', [{ fareBasisCode: 'Y1', segmentRefs: [2] }]],
    ['segmento repetido dentro del componente', [{ fareBasisCode: 'Y1', segmentRefs: [0, 0] }]],
    // D1: texto libre que viajaría tal cual. Ninguna tarifa real lleva nueve dígitos seguidos.
    ['fare basis con forma de PAN', [{ fareBasisCode: 'Y4111111111111111', segmentRefs: [0] }]],
    [
      'marca con forma de PAN',
      [{ fareBasisCode: 'Y1', brand: { code: '4111111111111111' }, segmentRefs: [0] }],
    ],
  ])('%s: el componente no viaja', (_caso, fareComponents) => {
    const body = payload(buildSabreGetSeatsRequest(latamOffer({ fareComponents }), criteria()));
    expect(body.fareComponents).toBeUndefined();
    expect(body.passengers[0]?.fareSegmentAssociation).toBeUndefined();
  });

  it('un segundo componente sobre un segmento ya asociado se descarta: gana el primero', () => {
    const body = payload(
      buildSabreGetSeatsRequest(
        latamOffer({
          fareComponents: [
            { fareBasisCode: 'Y1', segmentRefs: [0] },
            { fareBasisCode: 'Y2', segmentRefs: [0, 1] },
          ],
        }),
        criteria(),
      ),
    );
    expect(body.fareComponents?.map((component) => component.fareBasis)).toEqual(['Y1']);
  });

  it('sin fareComponents en la oferta el request sigue siendo válido', () => {
    const body = payload(
      buildSabreGetSeatsRequest(latamOffer({ fareComponents: undefined }), criteria()),
    );
    expect(body.fareComponents).toBeUndefined();
    expect(body.passengers).toEqual([{ id: 'passenger_1', passengerType: 'ADT' }]);
  });

  it('el equipo viaja si cumple el patrón del contrato y se omite si no', () => {
    const withAircraft = (aircraft: string) =>
      latamOffer({
        itineraries: latamOffer().itineraries?.map((itinerary) => ({
          ...itinerary,
          segments: itinerary.segments.map((segment) => ({ ...segment, aircraft })),
        })),
      });
    expect(payload(buildSabreGetSeatsRequest(withAircraft('7M8'), criteria())).segments[0]).toEqual(
      expect.objectContaining({ aircraftCode: '7M8' }),
    );
    expect(
      payload(buildSabreGetSeatsRequest(withAircraft('B738'), criteria())).segments[0],
    ).not.toHaveProperty('aircraftCode');
  });

  it('sin operador declarado no se inventa uno', () => {
    const offer = latamOffer();
    const segment = offer.itineraries![0]!.segments[0]!;
    delete segment.operatingCarrier;
    delete segment.operatingFlightNumber;
    const sent = payload(buildSabreGetSeatsRequest(offer, criteria())).segments[0];
    expect(sent).not.toHaveProperty('operatingAirlineCode');
    expect(sent).not.toHaveProperty('operatingFlightNumber');
  });

  it.each([
    ['sin carril declarado (default ATPCO del shop)', undefined],
    ['LCC', 'LCC'],
  ])('%s también va por payload', (_caso, source) => {
    const offer = latamOffer();
    const provider = { name: offer.provider.name, offerRef: offer.provider.offerRef };
    const plan = buildSabreGetSeatsRequest(
      { ...offer, provider: source === undefined ? provider : { ...provider, source } },
      criteria(),
    );
    expect(plan.path).toBe(SABRE_GETSEATS_PAYLOAD_PATH);
  });
});

describe('ofertas que no se pueden consultar no salen al cable', () => {
  function withSegment(patch: Json): Offer {
    const offer = latamOffer();
    Object.assign(offer.itineraries![0]!.segments[0]!, patch);
    return offer;
  }

  it.each<[string, () => Offer, FlightSearchCriteria, string]>([
    [
      'otro proveedor',
      () => latamOffer({ provider: { name: 'latam', offerRef: 'x' } }),
      criteria(),
      'provider.name:not_sabre',
    ],
    [
      'carril desconocido',
      () => latamOffer({ provider: { name: 'sabre', offerRef: 'x', source: 'CHARTER' } }),
      criteria(),
      'provider.source:unsupported',
    ],
    ['sin itinerario', () => latamOffer({ itineraries: [] }), criteria(), 'itineraries:required'],
    [
      'número de vuelo con sufijo operativo',
      () => withSegment({ flightNumber: '640A' }),
      criteria(),
      'segments.0.flightNumber:integer_required',
    ],
    [
      'número de vuelo cero',
      () => withSegment({ flightNumber: '0' }),
      criteria(),
      'segments.0.flightNumber:out_of_range',
    ],
    [
      'número operado con sufijo',
      () => withSegment({ operatingFlightNumber: '1X' }),
      criteria(),
      'segments.0.operatingFlightNumber:integer_required',
    ],
    [
      'hora sin offset',
      () => withSegment({ departureAt: '2026-03-02T13:40:00' }),
      criteria(),
      'segments.0.departureAt:invalid_iso_with_offset',
    ],
    [
      'clase fuera del patrón',
      () => withSegment({ bookingClass: 'y' }),
      criteria(),
      'segments.0.bookingClassCode:invalid_string',
    ],
    ['más de 9 pasajeros con asiento', () => latamOffer(), criteria(5, 5), 'passengers:too_many'],
    [
      'más infantes que adultos',
      () => latamOffer(),
      criteria(1, 0, 2),
      'passengers:more_infants_than_adults',
    ],
  ])('%s', (_caso, offer, paxCount, issue) => {
    const error = buildError(() => buildSabreGetSeatsRequest(offer(), paxCount));
    expect(error.issues).toContain(issue);
    // Rutas y códigos, nunca valores de la oferta.
    for (const value of ['640A', 'YOWLGN3', 'CHARTER', '13:40']) {
      expect(error.message).not.toContain(value);
    }
  });
});

describe('el esquema del cuerpo es cerrado', () => {
  const valid = (): Json => ({
    returnSeatMapsOnlyForSegmentRefs: ['segment_1'],
    segments: [
      {
        id: 'segment_1',
        bookingAirlineCode: 'LA',
        bookingFlightNumber: 640,
        departureAirportCode: 'SCL',
        arrivalAirportCode: 'LIM',
        departureDate: '2026-03-02',
        bookingClassCode: 'Y',
        departureTime: '13:40',
        arrivalDate: '2026-03-02',
        arrivalTime: '15:30',
      },
    ],
    passengers: [{ id: 'passenger_1', passengerType: 'ADT' }],
    currencyCode: 'USD',
  });

  it('acepta el cuerpo mínimo', () => {
    expect(SabreGetSeatsPayloadRequestSchema.safeParse(valid()).success).toBe(true);
  });

  it.each([
    ['nombre del pasajero', { givenName: 'ANA' }],
    ['apellido del pasajero', { surname: 'ROJAS' }],
    ['viajero frecuente', { loyaltyProgramAccounts: [{ accountNumber: '123456' }] }],
  ])('rechaza %s aunque el contrato lo admita', (_caso, extra) => {
    const body = valid();
    Object.assign((body['passengers'] as Json[])[0]!, extra);
    expect(SabreGetSeatsPayloadRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rechaza cualquier clave de tarjeta o forma de pago (D1)', () => {
    expect(
      SabreGetSeatsPayloadRequestSchema.safeParse({ ...valid(), cardNumber: '4111111111111111' })
        .success,
    ).toBe(false);
    expect(
      SabreGetSeatsNdcOfferRequestSchema.safeParse({ offerId: 'abc', formOfPayment: {} }).success,
    ).toBe(false);
  });

  it('el request NDC no lleva pasajeros', () => {
    expect(
      SabreGetSeatsNdcOfferRequestSchema.safeParse({
        offerId: 'abc',
        passengers: [{ id: 'Passenger1', givenName: 'ANA' }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// NDC — byNdcOfferId
// ---------------------------------------------------------------------------------------------

describe('NDC por offerId', () => {
  const PRICE_OFFER_ID = 'ih5d79946bb5sp4lsmlj89kj27-1';

  function binding(pricePassengerId: string, requestedTravelerIndex: number, paxType: string) {
    return {
      pricePassengerId,
      requestedTravelerIndex,
      paxType,
      requestedPtc: paxType === 'CHD' ? 'CNN' : paxType,
      pricedPtc: paxType === 'CHD' ? 'CNN' : paxType,
    };
  }

  function ndcOffer(raw: Json): Offer {
    return latamOffer({
      provider: {
        name: 'sabre',
        offerRef: 'priced',
        source: 'NDC',
        raw: raw as NonNullable<Offer['provider']['raw']>,
      },
    });
  }

  const priced = (bindings: unknown[]): Json => ({
    [SABRE_RAW_KEYS.priceOfferId]: PRICE_OFFER_ID,
    [SABRE_RAW_KEYS.pricePassengerBindings]: bindings,
  });

  it('manda sólo el offerId de Offer Price y enlaza pasajeros por el binding', () => {
    const plan = buildSabreGetSeatsRequest(
      ndcOffer(
        priced([
          binding('Passenger1', 0, 'ADT'),
          binding('Passenger2', 1, 'CHD'),
          binding('Passenger3', 2, 'INF'),
        ]),
      ),
      criteria(1, 1, 1),
    );
    expect(plan.mode).toBe('ndc-offer');
    expect(plan.path).toBe(SABRE_GETSEATS_NDC_OFFER_PATH);
    expect(plan.body).toEqual({ offerId: PRICE_OFFER_ID });
    expectWithinContract(plan.body, 'SeatAvailabilityByNdcOfferIdRq');
    // El infante en brazos no tiene asiento: no recibe precio de asiento.
    expect([...plan.passengerIndexById]).toEqual([
      ['Passenger1', 0],
      ['Passenger2', 1],
    ]);
    expect(plan.segmentIndexById.size).toBe(0);
  });

  it('sin offerId de Offer Price no hay mapa vendible: falla en vez de usar el del shop', () => {
    const error = buildError(() =>
      buildSabreGetSeatsRequest(
        ndcOffer({ [SABRE_RAW_KEYS.shopOfferItemIds]: ['abc-1-1'] }),
        criteria(),
      ),
    );
    expect(error.issues).toEqual(['provider.raw.priceOfferId:required']);
  });

  it('un offerId fuera del patrón IdType del contrato no sale', () => {
    const raw = priced([binding('Passenger1', 0, 'ADT')]);
    raw[SABRE_RAW_KEYS.priceOfferId] = '1-empieza-por-digito';
    const error = buildError(() => buildSabreGetSeatsRequest(ndcOffer(raw), criteria()));
    expect(error.issues).toEqual(['offerId:invalid_string']);
    expect(error.message).not.toContain('empieza');
  });

  it.each<[string, unknown, FlightSearchCriteria, string]>([
    ['sin binding', undefined, criteria(), 'provider.raw.pricePassengerBindings:required'],
    ['binding vacío', [], criteria(), 'provider.raw.pricePassengerBindings:required'],
    [
      'binding que no cubre a todos',
      [binding('Passenger1', 0, 'ADT')],
      criteria(2),
      'provider.raw.pricePassengerBindings:passenger_count_mismatch',
    ],
    [
      'entrada mal formada',
      [{ pricePassengerId: 'Passenger1' }],
      criteria(),
      'provider.raw.pricePassengerBindings.0:invalid',
    ],
    [
      'tipo que no corresponde al índice',
      [binding('Passenger1', 0, 'CHD')],
      criteria(),
      'provider.raw.pricePassengerBindings.0:ambiguous',
    ],
    [
      'índice repetido',
      [binding('Passenger1', 0, 'ADT'), binding('Passenger2', 0, 'ADT')],
      criteria(2),
      'provider.raw.pricePassengerBindings.1:ambiguous',
    ],
    [
      'id repetido',
      [binding('Passenger1', 0, 'ADT'), binding('Passenger1', 1, 'ADT')],
      criteria(2),
      'provider.raw.pricePassengerBindings.1:ambiguous',
    ],
    [
      'índice fuera de rango',
      [binding('Passenger1', 3, 'INF')],
      criteria(),
      'provider.raw.pricePassengerBindings.0:ambiguous',
    ],
  ])('%s: no se adivina de quién es cada precio', (_caso, bindings, paxCount, issue) => {
    const raw: Json = { [SABRE_RAW_KEYS.priceOfferId]: PRICE_OFFER_ID };
    if (bindings !== undefined) raw[SABRE_RAW_KEYS.pricePassengerBindings] = bindings;
    const error = buildError(() => buildSabreGetSeatsRequest(ndcOffer(raw), paxCount));
    expect(error.issues).toEqual([issue]);
  });
});
