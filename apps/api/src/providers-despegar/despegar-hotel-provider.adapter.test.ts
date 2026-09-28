import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HotelOfferSchema,
  type HotelOffer,
  type HotelSearchCriteria,
  type ProviderRef,
} from '@sales-travel/canonical';
import {
  DespegarApiError,
  DespegarHotelsAdapter,
  type BookRequest,
  type HotelOffer as DespegarHotelOffer,
} from '@sales-travel/despegar-hotels';
import type { HotelBookRequest, SearchContext } from '@sales-travel/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  supportsHotelBookingByClientReference,
  supportsHotelBookingsByDate,
  supportsHotelPaymentOptions,
  supportsHotelPriceJumpRecovery,
  supportsHotelRatesDetail,
  supportsHotelSuggest,
} from '../providers/hotel-provider.types.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import {
  DESPEGAR_HOTELS_PROVIDER_CODE,
  DespegarHotelInputError,
  DespegarHotelProviderAdapter,
} from './despegar-hotel-provider.adapter.js';
import { DespegarHotelsProviderFactory } from './despegar-hotels.factory.js';

/**
 * El envoltorio neutral de Despegar contra el ACL concreto, con el mismo `fetch` falso.
 *
 * La vara es la del plan: lo que sale por el envoltorio es lo que sale por el ACL, y lo único
 * que se suma es de qué proveedor es cada tarifa. Por eso cada caso llama a los dos con el pedido
 * equivalente y compara el cable (URL, método y cuerpo) y el resultado, en vez de afirmar campos
 * sueltos: un mapeo que cambie un precio o una habitación rompe aquí antes que en producción.
 */

interface FetchCall {
  url: string;
  method: string | undefined;
  body: unknown;
}

function stubFetch(json: unknown, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(json)),
      } as Response);
    }),
  );
  return { calls };
}

const cfg = {
  apiKey: 'secret-key',
  baseUrl: 'https://api-dev.despegar.com/v3',
  language: 'ES' as const,
  countryCode: 'CO',
  locale: 'es-CO',
};

const CTX: SearchContext = { tenantId: '11111111-1111-4111-8111-111111111111' };

function pareja(): { acl: DespegarHotelsAdapter; neutral: DespegarHotelProviderAdapter } {
  const acl = new DespegarHotelsAdapter(cfg);
  return { acl, neutral: new DespegarHotelProviderAdapter(acl) };
}

/** La respuesta grabada de disponibilidad de la red de seguridad de la vertical (PR-0.1). */
function respuestaDisponibilidad(): unknown {
  const ruta = join(
    __dirname,
    '..',
    'hotels',
    '__fixtures__',
    'despegar-availability.response.json',
  );
  return JSON.parse(readFileSync(ruta, 'utf8')) as unknown;
}

/** Lo que el envoltorio promete: el ACL tal cual, más `provider` en cada pack. */
function atribuido(offers: DespegarHotelOffer[]): HotelOffer[] {
  return offers.map((o) => ({
    ...o,
    roompacks: o.roompacks.map((p) => ({
      ...p,
      provider: { name: DESPEGAR_HOTELS_PROVIDER_CODE, offerRef: p.id },
    })),
  }));
}

const DETALLE = {
  id: 7,
  hotel_info: { type: 'HOTEL' },
  roompacks: [
    {
      id: 'r1',
      meal_plan: { id: 'BREAKFAST' },
      rooms: [{ name: 'Std', reference: 1, choice_id: 'CH-1' }],
      cancellation_policy: { status: 'fully_refundable' },
      price_detail: { currency: 'USD', total: 120 },
    },
  ],
};

const OFERTA_DESPEGAR: ProviderRef = {
  name: DESPEGAR_HOTELS_PROVIDER_CODE,
  offerRef: 'r1',
  raw: { choiceId: 'CH-1', roomReferences: [1] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DespegarHotelProviderAdapter — búsqueda', () => {
  const pedidoDespegar = {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    currency: 'USD',
    hotelIds: ['101', '205', '350', '999'],
    rooms: [
      { adults: 2, childrenAges: [7] },
      { adults: 1, childrenAges: [] },
    ],
    countryCode: 'PE',
    language: 'PT' as const,
    refundableOnly: true,
  };
  const criterio: HotelSearchCriteria = {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    currency: 'USD',
    hotelIds: ['101', '205', '350', '999'],
    rooms: [
      { adults: 2, childrenAges: [7] },
      { adults: 1, childrenAges: [] },
    ],
    pointOfSaleCountry: 'PE',
    language: 'pt',
    refundableOnly: true,
  };

  it('devuelve lo mismo que el ACL y sólo suma de dónde es cada tarifa', async () => {
    const { calls } = stubFetch(respuestaDisponibilidad());
    const { acl, neutral } = pareja();

    const concreto = await acl.searchAvailability(pedidoDespegar);
    const envuelto = await neutral.searchAvailability(criterio, CTX);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(concreto.length).toBeGreaterThan(0);
    expect(envuelto).toEqual(atribuido(concreto));
  });

  it('cada tarifa valida contra el contrato neutral y dice que es de Despegar (RF-40)', async () => {
    stubFetch(respuestaDisponibilidad());
    const hoteles = await pareja().neutral.searchAvailability(criterio, CTX);

    for (const hotel of hoteles) {
      expect(HotelOfferSchema.safeParse(hotel).success).toBe(true);
      for (const pack of hotel.roompacks) {
        expect(pack.provider).toEqual({ name: 'despegar-hotels', offerRef: pack.id });
      }
    }
  });

  it('sin país ni idioma cae a los de la cuenta, como hoy', async () => {
    const { calls } = stubFetch({ items: [] });
    const { acl, neutral } = pareja();
    const { countryCode: _c, language: _l, ...sinPos } = pedidoDespegar;
    const { pointOfSaleCountry: _p, language: _i, ...criterioSinPos } = criterio;

    await acl.searchAvailability(sinPos);
    await neutral.searchAvailability(criterioSinPos, CTX);

    expect(calls[1]?.url).toBe(calls[0]?.url);
    expect(calls[1]?.url).toContain('country_code=CO');
    expect(calls[1]?.url).toContain('language=ES');
  });

  it('la nacionalidad del huésped no viaja: Despegar no la recibe y no es el punto de venta', async () => {
    const { calls } = stubFetch({ items: [] });
    const { neutral } = pareja();

    await neutral.searchAvailability(criterio, CTX);
    await neutral.searchAvailability({ ...criterio, guestNationality: 'AR' }, CTX);

    expect(calls[1]?.url).toBe(calls[0]?.url);
  });

  it('sin disponibilidad es una lista vacía, no un error', async () => {
    stubFetch({});
    await expect(pareja().neutral.searchAvailability(criterio, CTX)).resolves.toEqual([]);
  });

  it('un error de Despegar sale tal cual, para que lo traduzca su filtro', async () => {
    stubFetch({ message: 'bad request' }, 400);
    await expect(pareja().neutral.searchAvailability(criterio, CTX)).rejects.toBeInstanceOf(
      DespegarApiError,
    );
  });
});

describe('DespegarHotelProviderAdapter — tarifas de un hotel', () => {
  const consulta = {
    hotelId: '7',
    checkinDate: '2026-07-01',
    checkoutDate: '2026-07-03',
    currency: 'USD',
    rooms: [{ adults: 2, childrenAges: [] }],
  };

  it('pide lo mismo que el ACL y deja en la tarifa lo que hace falta para reservarla', async () => {
    const { calls } = stubFetch(DETALLE);
    const { acl, neutral } = pareja();

    const concreto = await acl.getHotelDetail({ ...consulta, roompackId: 'r1' });
    const envuelto = await neutral.getHotelRates({ ...consulta, roompackId: 'r1' }, CTX);

    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]?.url).toContain('roompack_id=r1');
    const [pack] = envuelto.roompacks;
    expect(pack?.provider).toEqual(OFERTA_DESPEGAR);
    // El token sigue también en la habitación, como lo ve hoy quien usa el detalle.
    expect(envuelto).toEqual({
      ...concreto,
      roompacks: concreto.roompacks.map((p) => ({ ...p, provider: OFERTA_DESPEGAR })),
    });
    expect(HotelOfferSchema.safeParse(envuelto).success).toBe(true);
  });

  it('con tokens distintos por habitación no elige uno: la tarifa queda sin token de pack', async () => {
    stubFetch({
      ...DETALLE,
      roompacks: [
        {
          ...DETALLE.roompacks[0],
          rooms: [
            { name: 'Doble', reference: 1, choice_id: 'CH-A' },
            { name: 'Simple', reference: 2, choice_id: 'CH-B' },
          ],
        },
      ],
    });

    const { roompacks } = await pareja().neutral.getHotelRates(consulta, CTX);

    expect(roompacks[0]?.provider).toEqual({ name: 'despegar-hotels', offerRef: 'r1' });
    expect(roompacks[0]?.rooms.map((r) => r.choiceId)).toEqual(['CH-A', 'CH-B']);
  });

  it('un pack de dos habitaciones con el mismo token lleva la numeración de las dos', async () => {
    stubFetch({
      ...DETALLE,
      roompacks: [
        {
          ...DETALLE.roompacks[0],
          rooms: [
            { name: 'Doble', reference: 1, choice_id: 'CH-X' },
            { name: 'Simple', reference: 2, choice_id: 'CH-X' },
          ],
        },
      ],
    });

    const { roompacks } = await pareja().neutral.getHotelRates(consulta, CTX);

    expect(roompacks[0]?.provider.raw).toEqual({ choiceId: 'CH-X', roomReferences: [1, 2] });
  });

  it('un pack sin token (o con alguna habitación sin él) no inventa uno', async () => {
    stubFetch({
      ...DETALLE,
      roompacks: [
        { ...DETALLE.roompacks[0], rooms: [{ name: 'Std', reference: 1 }] },
        {
          ...DETALLE.roompacks[0],
          id: 'r2',
          rooms: [
            { name: 'Doble', reference: 1, choice_id: 'CH-X' },
            { name: 'Simple', reference: 2 },
          ],
        },
      ],
    });

    const { roompacks } = await pareja().neutral.getHotelRates(consulta, CTX);

    expect(roompacks.map((p) => p.provider.raw)).toEqual([undefined, undefined]);
  });
});

describe('DespegarHotelProviderAdapter — sugerencias y medios de pago', () => {
  it('las sugerencias son las del ACL, con su locale', async () => {
    const { calls } = stubFetch({
      items: [
        {
          id: 1,
          target: { gid: 'CITY_1', type: 1, parents: { city: 'Bogotá', country: 'Colombia' } },
          display: 'Bogotá',
        },
      ],
    });
    const { acl, neutral } = pareja();

    const concreto = await acl.suggest('bogo', 'pt-BR');
    const envuelto = await neutral.suggestDestinations('bogo', CTX, 'pt-BR');

    expect(calls[1]).toEqual(calls[0]);
    expect(envuelto).toEqual(concreto);
  });

  it('los medios de pago son los del ACL, pedidos por la referencia del prebook', async () => {
    const { calls } = stubFetch({
      modalities: [
        {
          modality: 'PAYINADVANCE',
          price_information: { currency: 'USD', total: { total: 200, tax_breakdown: [] } },
          payment_options: [{ option_type: 'ONE_CARD', group_plans: 'plan-9' }],
        },
      ],
    });
    const { acl, neutral } = pareja();

    const concreto = await acl.getPaymentOptions({ prebookId: 'pb-1', includeHints: true });
    const envuelto = await neutral.getPaymentOptions(
      { prebookRef: 'pb-1', includeHints: true },
      CTX,
    );

    expect(calls[1]).toEqual(calls[0]);
    expect(envuelto).toEqual(concreto);
  });
});

describe('DespegarHotelProviderAdapter — prebook', () => {
  const respuesta = {
    prebook_id: 'pb-1',
    expiration: '2026-07-01T10:00:00Z',
    status: 'PREBOOKED',
    flow: 'STANDARD',
    total: 200.5,
    currency: 'USD',
    commission: { amount: 20.05, max_amount: 25, min_amount: 15 },
  };

  it('manda al cable lo mismo que el ACL con el token que dejó el detalle', async () => {
    const { calls } = stubFetch(respuesta);
    const { acl, neutral } = pareja();

    const concreto = await acl.prebook({ choiceId: 'CH-1', lang: 'pt', include: ['HINTS'] });
    const envuelto = await neutral.prebook(
      { offer: OFERTA_DESPEGAR, language: 'pt', providerOptions: { include: ['HINTS'] } },
      CTX,
    );

    expect(calls[1]).toEqual(calls[0]);
    expect(envuelto).toEqual({
      prebookRef: concreto.prebookId,
      total: concreto.total,
      expiresAt: concreto.expiration,
      agencyCommission: concreto.commission,
      providerStatus: concreto.status,
      rateConditions: [],
      signals: [],
      warnings: [],
    });
  });

  it('la tarifa que devolvió el detalle sirve tal cual para revalidar', async () => {
    stubFetch(DETALLE);
    const { neutral } = pareja();
    const hotel = await neutral.getHotelRates(
      {
        hotelId: '7',
        checkinDate: '2026-07-01',
        checkoutDate: '2026-07-03',
        currency: 'USD',
        rooms: [{ adults: 2, childrenAges: [] }],
      },
      CTX,
    );
    const offer = hotel.roompacks[0]?.provider;
    if (offer === undefined) throw new Error('el detalle no trajo tarifas');

    const { calls } = stubFetch(respuesta);
    await neutral.prebook({ offer }, CTX);

    expect(calls[0]?.body).toEqual({ choice_id: 'CH-1', lang: 'es' });
  });

  it('un vencimiento sin zona no se presenta como vencimiento: se avisa', async () => {
    stubFetch({ ...respuesta, expiration: '2026-07-01T10:00:00' });

    const r = await pareja().neutral.prebook({ offer: OFERTA_DESPEGAR }, CTX);

    expect(r.expiresAt).toBeUndefined();
    expect(r.warnings).toEqual(['prebook-expiration-without-zone']);
  });

  it('sin vencimiento, ni vencimiento ni aviso', async () => {
    const { expiration: _e, commission: _c, ...sinVencimiento } = respuesta;
    stubFetch(sinVencimiento);

    const r = await pareja().neutral.prebook({ offer: OFERTA_DESPEGAR }, CTX);

    expect(r).not.toHaveProperty('expiresAt');
    expect(r).not.toHaveProperty('agencyCommission');
    expect(r.warnings).toEqual([]);
  });

  it('una tarifa de otro proveedor nunca llega a Despegar', async () => {
    const { calls } = stubFetch(respuesta);

    await expect(
      pareja().neutral.prebook({ offer: { ...OFERTA_DESPEGAR, name: 'stub-hotels' } }, CTX),
    ).rejects.toMatchObject({ name: 'DespegarHotelInputError', reason: 'foreign-offer' });
    expect(calls).toEqual([]);
  });

  it('sin token de reserva falla con motivo y sin llamar', async () => {
    const { calls } = stubFetch(respuesta);

    const error = await pareja()
      .neutral.prebook({ offer: { name: 'despegar-hotels', offerRef: 'r1' } }, CTX)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DespegarHotelInputError);
    expect(error).toMatchObject({ reason: 'missing-choice' });
    expect(calls).toEqual([]);
  });

  it('una opción desconocida se rechaza nombrando el campo, nunca el valor', async () => {
    const { calls } = stubFetch(respuesta);

    const error = await pareja()
      .neutral.prebook(
        { offer: OFERTA_DESPEGAR, providerOptions: { incluir: 'dato-del-viajero' } },
        CTX,
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ reason: 'invalid-options' });
    expect((error as Error).message).toContain('incluir');
    expect((error as Error).message).not.toContain('dato-del-viajero');
    expect(calls).toEqual([]);
  });
});

describe('DespegarHotelProviderAdapter — book', () => {
  /** El pedido de `despegar-hotels.booking.test.ts`, tal cual. */
  const pedidoDespegar: BookRequest = {
    prebookId: 'pb-1',
    externalBookingReference: 'ISO-1234',
    contact: {
      email: 'ana@example.com',
      phones: [{ countryCode: '57', areaCode: '1', number: '5551234', type: 'MOBILE' }],
    },
    travelers: [
      {
        referenceId: '1',
        firstName: 'Ana',
        lastName: 'Gómez',
        gender: 'FEMALE',
        nationality: 'CO',
        birthDate: '1990-05-01',
        identification: { type: 'PASSPORT', number: 'X123', issueCountry: 'CO' },
      },
    ],
    payment: {
      optionType: 'ONE_CARD',
      units: [{ planId: 'plan-9', secureToken: 'tok_secure' }],
    },
  };

  /** El mismo pedido en el contrato neutral. */
  const pedidoNeutral: HotelBookRequest = {
    offer: OFERTA_DESPEGAR,
    prebookRef: 'pb-1',
    bookingReference: 'ISO-1234',
    rooms: [
      {
        guests: [
          {
            paxType: 'ADT',
            firstName: 'Ana',
            lastName: 'Gómez',
            gender: 'F',
            nationality: 'CO',
            birthDate: '1990-05-01',
            document: { type: 'PASSPORT', number: 'X123', issuingCountry: 'CO' },
          },
        ],
      },
    ],
    contact: {
      email: 'ana@example.com',
      phone: { countryCode: '57', areaCode: '1', number: '5551234' },
    },
    payment: {
      kind: 'hosted-token',
      optionType: 'ONE_CARD',
      units: [{ planId: 'plan-9', secureToken: 'tok_secure' }],
    },
    providerOptions: { phoneType: 'MOBILE' },
  };

  it('manda al cable exactamente lo que manda el ACL', async () => {
    const { calls } = stubFetch({ reservationId: 'r-1', status: 'SUCCESS', products: [] });
    const { acl, neutral } = pareja();

    await acl.book(pedidoDespegar);
    const r = await neutral.book(pedidoNeutral, CTX);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(r).toEqual({
      outcome: 'CONFIRMED',
      providerBookingId: 'r-1',
      providerStatus: 'SUCCESS',
      warnings: [],
    });
  });

  it('las opciones de Despegar llegan al cable igual que por la ruta de hoy', async () => {
    const { calls } = stubFetch({ reservationId: 'r-1', status: 'SUCCESS', products: [] });
    const { acl, neutral } = pareja();

    await acl.book({
      ...pedidoDespegar,
      modality: 'PAYATHOTEL',
      disableSyncResult: true,
      testCase: 'pricejump',
      context: { clientIp: '203.0.113.9', userAgent: 'vitest' },
    });
    await neutral.book(
      {
        ...pedidoNeutral,
        client: { ip: '203.0.113.9', userAgent: 'vitest' },
        providerOptions: {
          phoneType: 'MOBILE',
          modality: 'PAYATHOTEL',
          disableSyncResult: true,
          testCase: 'pricejump',
        },
      },
      CTX,
    );

    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]?.url).toContain('/book?test_case=pricejump');
  });

  it('documento nacional, titular de la tarjeta tokenizada y factura fiscal se traducen igual', async () => {
    const { calls } = stubFetch({ reservationId: 'r-1', status: 'SUCCESS', products: [] });
    const { acl, neutral } = pareja();
    const factura = {
      reference: 1,
      fiscalName: 'Agencia Uno SAS',
      fiscalStatus: 'RESPONSABLE_IVA',
      fiscalAddress: { street: 'Calle 1', number: '2-3', cityId: '11001', zipCode: '110111' },
    };

    await acl.book({
      ...pedidoDespegar,
      contact: { email: 'ana@example.com', phones: [{ countryCode: '57', number: '5551234' }] },
      travelers: [
        {
          referenceId: '1',
          firstName: 'Ana',
          lastName: 'Gómez',
          identification: { type: 'LOCAL', number: '1020' },
        },
      ],
      payment: {
        optionType: 'ONE_CARD',
        units: [
          {
            planId: 'plan-9',
            secureToken: 'tok_secure',
            type: 'ONE_CARD',
            invoiceReference: 1,
            cardHolderIdentification: { type: 'LOCAL', number: '1020' },
          },
        ],
        invoices: [
          {
            ...factura,
            fiscalIdentification: { type: 'NIT', number: '900-1', issueCountry: 'CO' },
          },
        ],
      },
    });
    await neutral.book(
      {
        ...pedidoNeutral,
        rooms: [
          {
            guests: [
              {
                paxType: 'ADT',
                firstName: 'Ana',
                lastName: 'Gómez',
                document: { type: 'NATIONAL_ID', number: '1020' },
              },
              // El acompañante no tiene lugar en el Book de Despegar: no se manda.
              { paxType: 'CHD', firstName: 'Leo', lastName: 'Gómez', age: 7 },
            ],
          },
        ],
        contact: { email: 'ana@example.com', phone: { countryCode: '57', number: '5551234' } },
        payment: {
          kind: 'hosted-token',
          optionType: 'ONE_CARD',
          units: [
            {
              planId: 'plan-9',
              secureToken: 'tok_secure',
              type: 'ONE_CARD',
              invoiceReference: 1,
              cardHolderDocument: { type: 'NATIONAL_ID', number: '1020' },
            },
          ],
          invoices: [
            { ...factura, fiscalId: { type: 'NIT', number: '900-1', issuingCountry: 'CO' } },
          ],
        },
        providerOptions: {},
      },
      CTX,
    );

    expect(calls[1]).toEqual(calls[0]);
  });

  it('cada huésped principal va con la numeración de SU habitación, no con la posición', async () => {
    const { calls } = stubFetch({ reservationId: 'r-1', status: 'SUCCESS', products: [] });
    const huesped = (nombre: string): HotelBookRequest['rooms'][number] => ({
      guests: [{ paxType: 'ADT', firstName: nombre, lastName: 'Pérez' }],
    });

    await pareja().neutral.book(
      {
        ...pedidoNeutral,
        offer: { ...OFERTA_DESPEGAR, raw: { choiceId: 'CH-1', roomReferences: [3, 5] } },
        rooms: [huesped('Uno'), huesped('Dos')],
      },
      CTX,
    );

    const cuerpo = calls[0]?.body as {
      travelers: { traveler_reference_id: string; first_name: string }[];
    };
    expect(cuerpo.travelers.map((t) => [t.traveler_reference_id, t.first_name])).toEqual([
      ['3', 'Uno'],
      ['5', 'Dos'],
    ]);
  });

  it.each([
    [{ reservationId: 'r-2', status: 'PROCESSING', products: [] }, 'PENDING'],
    [{ reservationId: 'r-3', status: 'ERROR', sub_status: 'UNAVAILABLE', products: [] }, 'FAILED'],
    [{ status: 'SUCCESS', products: [] }, 'UNCERTAIN'],
    [{ status: 'PROCESSING', products: [] }, 'UNCERTAIN'],
    [{ status: 'ERROR', products: [] }, 'FAILED'],
  ])('%j → %s', async (respuesta, outcome) => {
    stubFetch(respuesta);
    const r = await pareja().neutral.book(pedidoNeutral, CTX);
    expect(r.outcome).toBe(outcome);
  });

  it('el estado y el sub-estado viajan como código; el texto libre del proveedor no', async () => {
    stubFetch({
      reservationId: 'r-3',
      status: 'ERROR',
      sub_status: 'PRICE_JUMP',
      message: ['texto libre de Despegar'],
    });

    const r = await pareja().neutral.book(pedidoNeutral, CTX);

    expect(r).toEqual({
      outcome: 'FAILED',
      providerBookingId: 'r-3',
      providerStatus: 'ERROR',
      providerSubStatus: 'PRICE_JUMP',
      warnings: [],
    });
  });

  it.each<[string, HotelBookRequest, string]>([
    [
      'una tarifa de otro proveedor',
      { ...pedidoNeutral, offer: { ...OFERTA_DESPEGAR, name: 'stub-hotels' } },
      'foreign-offer',
    ],
    ['sin prebook', { ...pedidoNeutral, prebookRef: undefined }, 'missing-prebook'],
    [
      'sin la numeración de habitaciones',
      { ...pedidoNeutral, offer: { name: 'despegar-hotels', offerRef: 'r1' } },
      'room-references',
    ],
    [
      'con huéspedes para otra cantidad de habitaciones',
      { ...pedidoNeutral, rooms: [...pedidoNeutral.rooms, ...pedidoNeutral.rooms] },
      'room-references',
    ],
    [
      'una habitación sin huésped',
      { ...pedidoNeutral, rooms: [{ guests: [] }] },
      'room-without-guest',
    ],
    [
      'con cargo al crédito de la cuenta',
      { ...pedidoNeutral, payment: { kind: 'agency-credit' } },
      'unsupported-payment',
    ],
    [
      'con una opción mal escrita',
      { ...pedidoNeutral, providerOptions: { testcase: 'pricejump' } },
      'invalid-options',
    ],
  ])('%s: falla con motivo y NO llega a Despegar', async (_caso, pedido, reason) => {
    const { calls } = stubFetch({ reservationId: 'r-1', status: 'SUCCESS', products: [] });

    await expect(pareja().neutral.book(pedido, CTX)).rejects.toMatchObject({
      name: 'DespegarHotelInputError',
      reason,
    });
    expect(calls).toEqual([]);
  });
});

describe('DespegarHotelProviderAdapter — post-venta', () => {
  it('la lectura pide lo mismo que el ACL y traduce el estado', async () => {
    const { calls } = stubFetch({ reservation_id: 'r-9', status: 'SUCCESS', products: [] });
    const { acl, neutral } = pareja();

    await acl.getReservation('r-9');
    const vista = await neutral.getBooking('r-9', CTX);

    expect(calls[1]).toEqual(calls[0]);
    expect(vista).toEqual({
      found: true,
      providerBookingId: 'r-9',
      status: 'CONFIRMED',
      providerStatus: 'SUCCESS',
      warnings: [],
    });
  });

  it.each([
    ['PROCESSING', 'PENDING'],
    ['ERROR', 'FAILED'],
  ])('una reserva en %s se lee como %s, con su sub-estado', async (status, esperado) => {
    stubFetch({ status, sub_status: 'PRICE_JUMP' });

    const vista = await pareja().neutral.getBooking('r-9', CTX);

    expect(vista.status).toBe(esperado);
    expect(vista.providerSubStatus).toBe('PRICE_JUMP');
    expect(vista).not.toHaveProperty('providerBookingId');
  });

  it('la cancelación manda lo mismo que el ACL y no inventa importes', async () => {
    const { calls } = stubFetch({ flow_id: 'f-1', product_id: 'p-1', product_type: 'HOTEL' });
    const { acl, neutral } = pareja();

    await acl.cancelReservation({ reservationId: 'r-1', reason: 'HOTEL_PROBLEM' });
    const r = await neutral.cancelBooking(
      { providerBookingId: 'r-1', providerOptions: { reason: 'HOTEL_PROBLEM' } },
      CTX,
    );
    await neutral.cancelBooking({ providerBookingId: 'r-1' }, CTX);

    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]?.body).toEqual({ reason: 'OTHER' });
    expect(r).toEqual({ success: true, warnings: [] });
  });

  it('un motivo de cancelación fuera del vocabulario de Despegar no sale', async () => {
    const { calls } = stubFetch({});

    await expect(
      pareja().neutral.cancelBooking(
        { providerBookingId: 'r-1', providerOptions: { reason: 'ME_ARREPENTI' } },
        CTX,
      ),
    ).rejects.toMatchObject({ reason: 'invalid-options' });
    expect(calls).toEqual([]);
  });

  it('el salto de precio manda lo mismo que el ACL y devuelve su detalle', async () => {
    const { calls } = stubFetch({ item: { ok: true, amount: 10 } });
    const { acl, neutral } = pareja();

    const concreto = await acl.recoverBooking({
      reservationId: 'r-1',
      messageType: 'PRICE_JUMP',
      confirmations: [{ flavorId: 'H0', confirm: true }],
      testCase: 'pricejump',
    });
    const envuelto = await neutral.confirmPriceJump(
      {
        providerBookingId: 'r-1',
        messageType: 'PRICE_JUMP',
        confirmations: [{ productRef: 'H0', accept: true }],
        providerOptions: { testCase: 'pricejump' },
      },
      CTX,
    );

    expect(calls[1]).toEqual(calls[0]);
    expect(envuelto).toEqual({ providerDetail: concreto.item });
  });

  it('sin detalle del proveedor, el salto de precio devuelve vacío', async () => {
    stubFetch({});

    const r = await pareja().neutral.confirmPriceJump(
      { providerBookingId: 'r-1', messageType: 'PRICE_JUMP', confirmations: [] },
      CTX,
    );

    expect(r).toEqual({});
  });
});

describe('DespegarHotelProviderAdapter — capacidades', () => {
  it('implementa los puertos opcionales que Despegar tiene y ninguno que su factory niegue', async () => {
    const cuenta: ResolvedProviderAccount = {
      id: 'acc-1',
      ownerTenantId: 'owner-1',
      providerCode: 'despegar-hotels',
      label: 'default',
      config: {},
      credentials: { apiKey: 'k' },
      inherited: false,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const factory = new DespegarHotelsProviderFactory({
      resolve: () => Promise.resolve(cuenta),
    } as unknown as ProviderCredentialsService);
    const { adapter } = await factory.resolveForTenant('t1');

    expect(supportsHotelSuggest(adapter)).toBe(true);
    expect(supportsHotelRatesDetail(adapter)).toBe(true);
    expect(supportsHotelPaymentOptions(adapter)).toBe(true);
    expect(supportsHotelPriceJumpRecovery(adapter)).toBe(true);
    // Capacidad declarada y método presente tienen que decir lo mismo: si no, el saga confiaría
    // en una verificación que el adapter no puede hacer.
    expect(supportsHotelBookingByClientReference(adapter)).toBe(
      factory.capabilities.retrieveByClientReference,
    );
    expect(supportsHotelBookingsByDate(adapter)).toBe(factory.capabilities.reconcileByDate);
  });
});
