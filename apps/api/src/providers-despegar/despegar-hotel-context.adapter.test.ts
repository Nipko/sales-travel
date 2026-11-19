import { DespegarApiError, DespegarHotelsAdapter } from '@sales-travel/despegar-hotels';
import type { HotelBookingRoomGuests, SearchContext } from '@sales-travel/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HotelBookContextRequest,
  HotelPrebookContextRequest,
} from '../providers/hotel-provider.types.js';
import {
  DESPEGAR_DETAIL_CONTEXT_TTL_MS,
  DespegarBookRejectedError,
  DespegarContextHotelProviderAdapter,
  DespegarOfferGoneError,
  compareDespegarRates,
  moneyText,
  newDespegarBookingReference,
} from './despegar-hotel-context.adapter.js';
import {
  DespegarHotelInputError,
  boardFromMealPlan,
  type DespegarNeutralOptions,
} from './despegar-hotel-provider.adapter.js';

/*
 * Despegar en la saga con órdenes: el detalle deja en el servidor lo que el PreBook y el Book
 * reenvían (`providerData`), el PreBook vuelve a pedir el detalle y compara (C1/C2), y el Book sale
 * a cuenta corriente con la factura de la cuenta y nuestra referencia. Todo contra el ACL real con
 * `fetch` simulado: lo que se afirma es el cable.
 */

interface FetchCall {
  url: string;
  method: string | undefined;
  body: unknown;
}

type Reply = { status?: number; body: unknown };

/** El catálogo de regímenes que responde `/meal-plans` (fuera de la secuencia). */
let mealPlans: unknown = [];

function stubSequence(replies: Reply[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      if (url.includes('/content-api/hotels/meal-plans')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(mealPlans)),
        } as Response);
      }
      calls.push({
        url,
        method: init.method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const reply = replies[i++] ?? { body: {} };
      const status = reply.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(reply.body)),
      } as Response);
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  mealPlans = [];
});

const CTX: SearchContext = { tenantId: '11111111-1111-4111-8111-111111111111' };
const ACCOUNT = {
  accountId: '22222222-2222-4222-8222-222222222222',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const INVOICE = {
  fiscalStatus: 'PERSONA_JURIDICA',
  fiscalIdentification: { type: 'NIT', number: '900123456' },
  fiscalName: 'Agencia Uno SAS',
};

function adapter(options: DespegarNeutralOptions = { environment: 'test', invoice: INVOICE }) {
  const acl = new DespegarHotelsAdapter({
    apiKey: 'k',
    baseUrl: 'https://api-dev.despegar.com/v3',
    language: 'ES',
  });
  return new DespegarContextHotelProviderAdapter(acl, options, ACCOUNT);
}

function detalle(total = 120, overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 7,
    hotel_info: { type: 'HOTEL' },
    categorized_notices: {
      primary: { title: 'Importante', notices: ['Piscina cerrada por obras'] },
      secondary: [{ notices: [{ description: 'Check-in desde las 15:00' }] }],
    },
    roompacks: [
      {
        id: 'r1',
        meal_plan: { id: 'BB' },
        rooms: [{ name: 'Doble', reference: 0, room_type_id: 'RT-1', choice_id: 'CH-1' }],
        cancellation_policy: {
          status: 'fully_refundable',
          cancellation_policy_rules: [
            {
              type: 'cancellation',
              penalty: { percentage: 100 },
              anticipation: { from: 0, to: 48 },
            },
          ],
        },
        price_detail: {
          currency: 'USD',
          total,
          charge_at_destination: 5,
          charge_at_destination_detail: [{ code: 'TT', amount: 5 }],
        },
        ...overrides,
      },
      // Sin `room_type_id`: Despegar recomienda descartarlo.
      {
        id: 'r2',
        meal_plan: { id: 'RO' },
        rooms: [{ name: 'Simple', reference: 0, choice_id: 'CH-2' }],
        price_detail: { currency: 'USD', total: 90 },
      },
    ],
  };
}

const RATES_QUERY = {
  hotelId: '7',
  checkinDate: '2026-12-10',
  checkoutDate: '2026-12-12',
  currency: 'USD',
  rooms: [{ adults: 2, childrenAges: [] }],
  pointOfSaleCountry: 'CO',
  language: 'es' as const,
};

const PROVIDER_DATA = {
  roompackId: 'r1',
  hotelId: '7',
  checkinDate: '2026-12-10',
  checkoutDate: '2026-12-12',
  currency: 'USD',
  countryCode: 'CO',
  language: 'ES',
  roomReferences: [0],
};

function prebookRequest(
  overrides: Partial<HotelPrebookContextRequest> = {},
): HotelPrebookContextRequest {
  return {
    searchId: 'dsp-1',
    hotelId: '7',
    offerRef: 'r1',
    searchSentAt: Date.now(),
    rooms: [{ adults: 2, childrenAges: [] }],
    baseline: {
      stage: 'C1',
      totalText: '120.00',
      seen: {
        total: { amountMinor: 12_000, currency: 'USD' },
        refundable: true,
        board: 'BB',
        mealTypeRaw: 'BB',
        atPropertyCharges: [
          {
            description: 'Cargo en destino (TT)',
            descriptionRaw: 'TT',
            amount: { amountMinor: 500, currency: 'USD' },
          },
        ],
      },
    },
    providerData: PROVIDER_DATA,
    ...overrides,
  };
}

const PREBOOK = {
  prebook_id: 'PB-9',
  expiration: '2026-11-18T10:15:00Z',
  status: 'AVAILABLE',
  total: 120,
  currency: 'USD',
  commission: { amount: 12, min_amount: 6, max_amount: 18 },
};

describe('detalle con contexto', () => {
  it('deja en el servidor el choice_id, la estadía y la numeración de cada tarifa reservable', async () => {
    const { calls } = stubSequence([{ body: detalle() }]);
    const antes = Date.now();

    const found = await adapter().getHotelRatesWithContext(RATES_QUERY, CTX);

    expect(calls[0]?.url).toContain('/hotels-api/availability/7');
    expect(found.searchId).toMatch(/^dsp-[0-9a-f]{24}$/);
    expect(found.expiresAt - found.searchSentAt).toBe(DESPEGAR_DETAIL_CONTEXT_TTL_MS);
    expect(found.searchSentAt).toBeGreaterThanOrEqual(antes);
    // `r2` no tiene `room_type_id`: no llega ni al contexto ni a la oferta.
    expect(found.offer.roompacks.map((p) => p.id)).toEqual(['r1']);
    expect(found.packs).toEqual([
      {
        hotelId: '7',
        offerRef: 'r1',
        totalText: '120.00',
        currency: 'USD',
        providerData: PROVIDER_DATA,
      },
    ]);
    // Los avisos del hotel quedan en la oferta: la certificación exige mostrarlos.
    expect(found.offer.notices).toEqual([
      { level: 'primary', title: 'Importante', text: 'Piscina cerrada por obras' },
      { level: 'secondary', text: 'Check-in desde las 15:00' },
    ]);
    expect(found.offer.roompacks[0]?.atPropertyCharges).toEqual([
      {
        description: 'Cargo en destino (TT)',
        descriptionRaw: 'TT',
        amount: { amountMinor: 500, currency: 'USD' },
      },
    ]);
  });

  it('una tarifa con tokens distintos por habitación no deja contexto', async () => {
    stubSequence([
      {
        body: {
          id: 7,
          roompacks: [
            {
              id: 'r3',
              rooms: [
                { name: 'A', reference: 0, room_type_id: 'X', choice_id: 'CH-A' },
                { name: 'B', reference: 1, room_type_id: 'Y', choice_id: 'CH-B' },
              ],
              price_detail: { currency: 'USD', total: 50 },
            },
          ],
        },
      },
    ]);
    const found = await adapter().getHotelRatesWithContext(
      { ...RATES_QUERY, pointOfSaleCountry: undefined, language: undefined },
      CTX,
    );
    expect(found.packs).toEqual([]);
  });

  it('declara la cuenta con la que buscó', () => {
    expect(adapter().searchAccount).toEqual(ACCOUNT);
  });
});

describe('PreBook con contexto', () => {
  it('C1: vuelve a pedir ESA tarifa, abre el prebook con el choice_id fresco y compara', async () => {
    const { calls } = stubSequence([{ body: detalle() }, { body: PREBOOK }]);

    const found = await adapter().prebookWithContext(prebookRequest(), CTX);

    expect(calls[0]?.url).toContain('roompack_id=r1');
    expect(calls[0]?.url).toContain('checkin_date=2026-12-10');
    expect(calls[0]?.url).toContain('country_code=CO');
    expect(calls[1]?.url).toContain('/prebook');
    expect(calls[1]?.body).toEqual({
      choice_id: 'CH-1',
      lang: 'es',
      include: ['EXCHANGE_POLICIES', 'HINTS'],
    });
    expect(found.comparison).toMatchObject({ stage: 'C1', outcome: 'UNCHANGED', price: 'SAME' });
    expect(found.result.prebookRef).toBe('PB-9');
    expect(found.result.expiresAt).toBe('2026-11-18T10:15:00Z');
    expect(found.result.agencyCommission?.maxAmount).toEqual({
      amountMinor: 1800,
      currency: 'USD',
    });
    expect(found.result.roompack.cancellation.policySource).toBe('prebook-final');
    expect(found.result.roompack.provider).toEqual({ name: 'despegar-hotels', offerRef: 'r1' });
    expect(found.result.rateConditions.map((c) => c.text)).toEqual([
      'Importante: Piscina cerrada por obras',
      'Check-in desde las 15:00',
    ]);
    expect(found.rateConditionsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(found.pack).toEqual({
      hotelId: '7',
      offerRef: 'r1',
      totalText: '120.00',
      currency: 'USD',
      providerData: { ...PROVIDER_DATA, prebookId: 'PB-9' },
    });
  });

  it('C1 sin la factura de la cuenta: falla antes del cable, sin contar contra el proveedor', async () => {
    const { calls } = stubSequence([]);
    const err = await adapter({ environment: 'test' })
      .prebookWithContext(prebookRequest(), CTX)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'missing-invoice', failure: { circuit: 'IGNORE' } });
    expect((err as Error).message).toContain('administrador de tu agencia');
    expect((err as Error).message).not.toContain('credentials');
    expect(calls).toEqual([]);
  });

  it('con pago diferido no se exige la factura en el prebook', async () => {
    const { calls } = stubSequence([{ body: detalle() }, { body: PREBOOK }]);
    await adapter({ environment: 'test', paymentType: 'DEFERRED' }).prebookWithContext(
      prebookRequest(),
      CTX,
    );
    expect(calls).toHaveLength(2);
  });

  it('C1: si el prebook sube el precio, la comparación lo dice', async () => {
    stubSequence([{ body: detalle() }, { body: { ...PREBOOK, total: 130 } }]);
    const found = await adapter().prebookWithContext(prebookRequest(), CTX);
    expect(found.comparison).toMatchObject({ outcome: 'INCREASED', price: 'UP' });
    expect(found.result.total).toEqual({ amountMinor: 13_000, currency: 'USD' });
  });

  it('un prebook en la moneda de la cuenta no reemplaza el total del pack: avisa', async () => {
    stubSequence([{ body: detalle() }, { body: { ...PREBOOK, total: 500_000, currency: 'COP' } }]);
    const found = await adapter().prebookWithContext(prebookRequest(), CTX);
    expect(found.result.total).toEqual({ amountMinor: 12_000, currency: 'USD' });
    expect(found.result.warnings).toEqual(['prebook-account-currency-differs']);
  });

  it('una expiración sin zona no se presenta como instante', async () => {
    stubSequence([
      { body: detalle() },
      { body: { ...PREBOOK, expiration: '2026-11-18T10:15:00' } },
    ]);
    const found = await adapter().prebookWithContext(prebookRequest(), CTX);
    expect(found.result).not.toHaveProperty('expiresAt');
  });

  it('si el detalle ya no trae la tarifa, la invalida sin abrir prebook', async () => {
    const { calls } = stubSequence([{ body: { id: 7, roompacks: [] } }]);
    const a = adapter();
    const err = await a.prebookWithContext(prebookRequest(), CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DespegarOfferGoneError);
    expect(a.offerInvalidatedBy(err)).toBe('offer');
    expect(calls).toHaveLength(1);
  });

  it('un 410 o `PRODUCT_GONE` invalidan la tarifa; un 500 no dice nada de ella', () => {
    const a = adapter();
    expect(a.offerInvalidatedBy(new DespegarApiError(410, '{}', '/prebook'))).toBe('offer');
    expect(
      a.offerInvalidatedBy(new DespegarApiError(400, '{"code":"PRODUCT_GONE"}', '/prebook')),
    ).toBe('offer');
    expect(a.offerInvalidatedBy(new DespegarApiError(500, '{}', '/prebook'))).toBeUndefined();
    expect(a.offerInvalidatedBy(new Error('x'))).toBeUndefined();
  });

  it('sin `providerData` no sale nada: la tarifa no es reservable desde aquí', async () => {
    const { calls } = stubSequence([]);
    await expect(
      adapter().prebookWithContext(prebookRequest({ providerData: undefined }), CTX),
    ).rejects.toBeInstanceOf(DespegarHotelInputError);
    expect(calls).toEqual([]);
  });
});

describe('regímenes del catálogo de Despegar', () => {
  it('el detalle toma el régimen y la etiqueta de la descripción oficial', async () => {
    mealPlans = [
      {
        id: 'BB',
        description: { es: 'Desayuno incluido', en: 'Breakfast included' },
        sub_categories: [{ id: 'BRA', description: { es: 'Desayuno americano' } }],
      },
    ];
    stubSequence([{ body: detalle() }]);
    const found = await adapter().getHotelRatesWithContext(RATES_QUERY, CTX);
    expect(found.offer.roompacks[0]).toMatchObject({
      board: 'BB',
      boardLabel: 'Desayuno incluido',
      mealTypeRaw: 'BB',
    });
  });

  it('si el catálogo falla, sigue con el mapeo por palabra', async () => {
    mealPlans = { roto: true };
    stubSequence([{ body: detalle(120, { meal_plan: { id: 'ALL_INCLUSIVE' } }) }]);
    const found = await adapter().getHotelRatesWithContext(RATES_QUERY, CTX);
    expect(found.offer.roompacks[0]).toMatchObject({ board: 'AI' });
    expect(found.offer.roompacks[0]).not.toHaveProperty('boardLabel');
  });

  it.each([
    [{ es: 'Todo incluido' }, 'AI'],
    [{ en: 'Full board' }, 'FB'],
    [{ pt: 'Meia pensão' }, 'HB'],
    [{ es: 'Desayuno continental' }, 'BB'],
    [{ es: 'Solo alojamiento' }, 'RO'],
    [{ es: 'Merienda' }, undefined],
    [{}, undefined],
  ])('%j → %s', (description, board) => {
    expect(boardFromMealPlan({ id: 'X', description, subCategories: [] })).toBe(board);
  });
});

describe('comparación C2', () => {
  const pack = {
    id: 'r1',
    provider: { name: 'despegar-hotels', offerRef: 'r1' },
    board: 'BB' as const,
    rooms: [{ name: 'Doble', reference: 0, bedOptions: [] }],
    cancellation: { refundable: true, status: 'fully_refundable' as const, rules: [] },
    price: { total: { amountMinor: 12_000, currency: 'USD' }, taxesDetail: [] },
  };

  it('cambio de políticas o de avisos es cambio de condiciones', () => {
    const accepted = { totalText: '120.00', roompack: pack, signals: [], rateConditionsHash: 'a' };
    const actual = {
      ...pack,
      cancellation: { refundable: false, status: 'non_refundable' as const, rules: [] },
    };
    const c = compareDespegarRates({ stage: 'C2', accepted }, actual, 'b');
    expect(c.outcome).toBe('CONDITIONS_CHANGED');
    expect(c.changes).toEqual(['REFUNDABLE', 'CANCEL_POLICIES', 'RATE_CONDITIONS']);
  });

  it('igual y con la misma huella: sin cambios; más barato: DECREASED', () => {
    const accepted = { totalText: '120.00', roompack: pack, signals: [], rateConditionsHash: 'a' };
    expect(compareDespegarRates({ stage: 'C2', accepted }, pack, 'a').outcome).toBe('UNCHANGED');
    const barato = {
      ...pack,
      price: { ...pack.price, total: { amountMinor: 11_000, currency: 'USD' } },
    };
    expect(compareDespegarRates({ stage: 'C2', accepted }, barato, 'a').outcome).toBe('DECREASED');
    const otraMoneda = {
      ...pack,
      price: { ...pack.price, total: { amountMinor: 1, currency: 'COP' } },
    };
    expect(compareDespegarRates({ stage: 'C2', accepted }, otraMoneda, 'a')).toMatchObject({
      price: 'NOT_COMPARABLE',
      changes: ['CURRENCY'],
    });
  });

  it('C1: régimen distinto es cambio de condiciones', () => {
    const c = compareDespegarRates(
      {
        stage: 'C1',
        totalText: '120.00',
        seen: {
          total: { amountMinor: 12_000, currency: 'USD' },
          refundable: true,
          board: 'RO',
          atPropertyCharges: [],
        },
      },
      pack,
      'x',
    );
    expect(c.changes).toEqual(['MEAL_TYPE']);
  });
});

describe('huéspedes', () => {
  const guest = (over: Partial<HotelBookingRoomGuests['guests'][number]> = {}) => ({
    paxType: 'ADT' as const,
    title: 'Mrs' as const,
    firstName: 'María José',
    lastName: 'Muñoz',
    ...over,
  });

  it('sale sólo el huésped principal de cada habitación', () => {
    const check = adapter().checkBookingGuests(
      [{ guests: [guest(), guest({ firstName: 'Otro' })] }],
      [{ adults: 2, childrenAges: [] }],
    );
    expect(check).toEqual({
      ok: true,
      rooms: [[{ title: 'Mrs', firstName: 'María José', lastName: 'Muñoz', paxType: 'ADT' }]],
    });
  });

  it('nombra cada problema con su ruta y sin valores', () => {
    const check = adapter().checkBookingGuests(
      [
        { guests: [guest({ firstName: 'Ана', title: undefined })] },
        { guests: [guest({ paxType: 'CHD', lastName: 'G' })] },
        { guests: [] },
      ],
      [
        { adults: 1, childrenAges: [] },
        { adults: 1, childrenAges: [] },
      ],
    );
    expect(check).toEqual({
      ok: false,
      issues: [
        'rooms:count_mismatch',
        'rooms.0.guests.0.title:required',
        'rooms.0.guests.0.firstName:invalid_characters',
        'rooms.1.guests.0.paxType:lead_not_adult',
        'rooms.1.guests.0.lastName:too_short',
        'rooms.2.guests:missing_lead',
      ],
    });
  });

  it('guiones y apóstrofos no se rechazan: salen adaptados a lo que acepta HotelDO (H5)', () => {
    const check = adapter().checkBookingGuests(
      [{ guests: [guest({ firstName: 'Ana-María', lastName: "O'Brien García-López" })] }],
      [{ adults: 1, childrenAges: [] }],
    );
    expect(check).toMatchObject({
      ok: true,
      rooms: [[{ firstName: 'Ana María', lastName: 'OBrien García López' }]],
    });
  });

  it('un nombre que adaptado queda con menos de dos letras es corto', () => {
    const check = adapter().checkBookingGuests(
      [{ guests: [guest({ lastName: "O'-" })] }],
      [{ adults: 1, childrenAges: [] }],
    );
    expect(check).toEqual({ ok: false, issues: ['rooms.0.guests.0.lastName:too_short'] });
  });

  it('la referencia es nueva en cada Book y dice el entorno', () => {
    const a = newDespegarBookingReference('test');
    expect(a).toMatch(/^SDT[A-Z2-9]{18}$/);
    expect(newDespegarBookingReference('live')).toMatch(/^SDL/);
    expect(a).not.toBe(newDespegarBookingReference('test'));
    expect(adapter().newBookingReference()).toMatch(/^SDT/);
    expect(adapter({ invoice: INVOICE }).newBookingReference()).toMatch(/^SDT/);
  });
});

describe('Book con contexto', () => {
  const request: HotelBookContextRequest = {
    offerRef: 'r1',
    totalText: '120.00',
    bookingReference: 'SDTABCDEFGHJKLMNPQRS',
    searchSentAt: Date.now(),
    occupancy: [{ adults: 2, childrenAges: [] }],
    rooms: [
      {
        guests: [
          { paxType: 'ADT', title: 'Mrs', firstName: 'Ana', lastName: 'Gómez' },
          { paxType: 'ADT', title: 'Mr', firstName: 'Luis', lastName: 'Gómez' },
        ],
      },
    ],
    contact: { email: 'ops@agencia.example', phone: { countryCode: '57', number: '3001234567' } },
    providerData: { ...PROVIDER_DATA, prebookId: 'PB-9' },
  };

  it('sale a cuenta corriente con la factura de la cuenta, el prebook y nuestra referencia', async () => {
    const { calls } = stubSequence([
      {
        body: {
          reservationId: 'R-1',
          status: 'SUCCESS',
          products: [{ type: 'HOTEL', plataform_id: 55 }],
        },
      },
    ]);

    const out = await adapter().bookWithContext(request, CTX);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/book$/);
    expect(calls[0]?.body).toMatchObject({
      prebook_id: 'PB-9',
      external_booking_reference: 'SDTABCDEFGHJKLMNPQRS',
      contact_data: { email: 'ops@agencia.example' },
      travelers: [{ traveler_reference_id: '0', first_name: 'Ana', last_name: 'Gómez' }],
      payment: {
        option_type: 'CURRENT_ACCOUNT',
        payment_units: [{ type: 'CURRENT_ACCOUNT' }],
        invoices: [
          {
            fiscal_status: 'PERSONA_JURIDICA',
            fiscal_name: 'Agencia Uno SAS',
            fiscal_identification: { type: 'NIT', number: '900123456' },
          },
        ],
      },
    });
    expect(out).toEqual({
      result: {
        outcome: 'CONFIRMED',
        providerBookingId: 'R-1',
        providerStatus: 'SUCCESS',
        warnings: [],
      },
      reason: 'confirmed',
    });
  });

  it('un PROCESSING por salto de precio queda para verificar leyendo', async () => {
    stubSequence([
      { body: { reservation_id: 'R-2', status: 'PROCESSING', sub_status: 'PRICE_JUMP' } },
    ]);
    const out = await adapter().bookWithContext(request, CTX);
    expect(out.result.outcome).toBe('PENDING');
    expect(out.reason).toBe('price-jump');
  });

  it('PROCESSING sin salto de precio también se verifica leyendo', async () => {
    stubSequence([{ body: { reservation_id: 'R-2', status: 'PROCESSING' } }]);
    expect((await adapter().bookWithContext(request, CTX)).reason).toBe('processing');
  });

  it('un SUCCESS sin localizador es incierto', async () => {
    stubSequence([{ body: { status: 'SUCCESS' } }]);
    const out = await adapter().bookWithContext(request, CTX);
    expect(out.result.outcome).toBe('UNCERTAIN');
    expect(out.reason).toBe('missing-confirmation-number');
  });

  it('un ERROR se lanza: no reservó nada, y si es de saldo es un problema de la cuenta', async () => {
    stubSequence([{ body: { status: 'ERROR', sub_status: 'NOT_ENOUGH_BALANCE' } }]);
    const a = adapter();
    const err = await a.bookWithContext(request, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DespegarBookRejectedError);
    expect(a.bookFailureOf(err)).toEqual({
      outcome: 'FAILED',
      reason: 'provider-rejected',
      dispatched: true,
      providerStatus: 'NOT_ENOUGH_BALANCE',
      errorClass: 'DespegarBookRejectedError',
    });
    expect(a.accountIssueOf(err)).toBe('insufficient-balance');
    expect(a.accountIssueOf(new DespegarBookRejectedError('CHANNEL_REJECTED'))).toBeUndefined();
    expect(a.accountIssueOf(new DespegarBookRejectedError(undefined))).toBeUndefined();
    expect(
      a.accountIssueOf(new DespegarApiError(400, '{"code":"INSUFFICIENT_FUNDS"}', '/book')),
    ).toBe('insufficient-balance');
    expect(a.accountIssueOf(new Error('x'))).toBeUndefined();
  });

  it('sin la factura de la cuenta no sale: falla antes del cable', async () => {
    const { calls } = stubSequence([]);
    const a = adapter({ environment: 'test' });
    const err = await a.bookWithContext(request, CTX).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'missing-invoice' });
    expect(a.bookFailureOf(err)).toMatchObject({ outcome: 'FAILED', dispatched: false });
    expect(calls).toEqual([]);
  });

  it('sin prebook en el contexto no sale', async () => {
    const { calls } = stubSequence([]);
    await expect(
      adapter().bookWithContext({ ...request, providerData: PROVIDER_DATA }, CTX),
    ).rejects.toMatchObject({ reason: 'missing-prebook' });
    expect(calls).toEqual([]);
  });

  it('con pago diferido toma el plan de /payments y no manda facturas', async () => {
    const { calls } = stubSequence([
      {
        body: {
          modalities: [
            {
              modality: 'PAYINADVANCE',
              payment_options: [
                { option_type: 'CURRENT_ACCOUNT' },
                {
                  option_type: 'DEFERRED',
                  group_plans: [{ type: 'DEFERRED', plans: [{ id: 'PL-D' }] }],
                },
              ],
            },
          ],
        },
      },
      { body: { reservationId: 'R-3', status: 'PROCESSING' } },
    ]);
    await adapter({ environment: 'test', paymentType: 'DEFERRED' }).bookWithContext(request, CTX);
    expect(calls[0]?.url).toContain('/payments?prebook_id=PB-9');
    expect((calls[1]?.body as Record<string, unknown>)['payment']).toEqual({
      option_type: 'DEFERRED',
      payment_units: [{ type: 'DEFERRED', plan_id: 'PL-D' }],
    });
  });

  it('diferido sin plan ofrecido, o una cuenta configurada con tarjeta, no reservan', async () => {
    stubSequence([{ body: { modalities: [] } }]);
    await expect(
      adapter({ environment: 'test', paymentType: 'DEFERRED' }).bookWithContext(request, CTX),
    ).rejects.toMatchObject({ reason: 'unsupported-payment' });
    const { calls } = stubSequence([]);
    await expect(
      adapter({ environment: 'test', paymentType: 'ONE_CARD', invoice: INVOICE }).bookWithContext(
        request,
        CTX,
      ),
    ).rejects.toMatchObject({ reason: 'unsupported-payment' });
    expect(calls).toEqual([]);
  });

  it.each([
    [
      new DespegarApiError(400, '{"code":"INVALID_FIELD"}', '/book'),
      'FAILED',
      'provider-rejected',
      'INVALID_FIELD',
    ],
    [new DespegarApiError(409, '{}', '/book'), 'UNCERTAIN', 'provider-error', '409'],
    [new DespegarApiError(500, '{}', '/book'), 'UNCERTAIN', 'provider-error', '500'],
    [new DespegarApiError(0, 'timeout', '/book'), 'UNCERTAIN', 'transport', '0'],
  ])('%s → %s', (err, outcome, reason, providerStatus) => {
    expect(adapter().bookFailureOf(err)).toEqual({
      outcome,
      reason,
      dispatched: true,
      providerStatus,
      errorClass: 'DespegarApiError',
    });
  });

  it('cualquier otro error puede haber reservado: se verifica leyendo', () => {
    expect(adapter().bookFailureOf(new TypeError('x'))).toEqual({
      outcome: 'UNCERTAIN',
      reason: 'unknown-error',
      dispatched: true,
      errorClass: 'TypeError',
    });
    expect(adapter().bookFailureOf('raro')).toEqual({
      outcome: 'UNCERTAIN',
      reason: 'unknown-error',
      dispatched: true,
    });
  });
});

describe('post-venta por nuestra referencia y por fecha', () => {
  it('lee por la referencia que enviamos; un 404 es "no está", no un error', async () => {
    const { calls } = stubSequence([
      {
        body: {
          reservation_id: 'R-1',
          status: 'SUCCESS',
          products: [{ type: 'HOTEL', pnr: 'H-77' }],
        },
      },
      { status: 404, body: { code: 'NOT_FOUND' } },
      { status: 500, body: {} },
    ]);
    const a = adapter();
    expect(await a.getBookingByClientReference('SDTX', CTX)).toEqual({
      found: true,
      bookingReference: 'SDTX',
      providerBookingId: 'R-1',
      status: 'CONFIRMED',
      providerStatus: 'SUCCESS',
      hotelConfirmationNumber: 'H-77',
      warnings: [],
    });
    expect(calls[0]?.url).toContain('/book/SDTX');
    expect(await a.getBookingByClientReference('SDTY', CTX)).toEqual({
      found: false,
      bookingReference: 'SDTY',
      warnings: [],
    });
    await expect(a.getBookingByClientReference('SDTZ', CTX)).rejects.toBeInstanceOf(
      DespegarApiError,
    );
  });

  it('lista las reservas de la cuenta por fecha de compra, dentro de la ventana', async () => {
    const fila = (n: number, fecha: string) => ({
      id: `i-${n}`,
      product: {
        product_id: `p-${n}`,
        product_type: 'HOTEL',
        status: 'ISSUED',
        reservation_id: `R-${n}`,
        external_reservation_id: `SDT${n}`,
        purchase_date_time: `${fecha}T10:00:00`,
        check_in_date_time: '2026-12-10T15:00:00',
        check_out_date_time: '2026-12-12T12:00:00',
        hotel_id: 7,
        sale_price: { currency: 'USD', price: 120 },
      },
    });
    const { calls } = stubSequence([
      {
        body: {
          items: [
            fila(1, '2026-11-02'),
            fila(2, '2026-10-30'),
            { id: 'x' },
            { id: 'v', product: { ...fila(3, '2026-11-03').product, product_type: 'FLIGHT' } },
          ],
        },
      },
    ]);
    const out = await adapter().listBookingsByDate({ from: '2026-11-01', to: '2026-11-30' }, CTX);
    expect(calls[0]?.url).toContain('by_api_key=true');
    expect(calls[0]?.url).toContain('from_purchase_date=2026-11-01');
    // product_type sólo va con product_id: suelto, Despegar responde 400.
    expect(calls[0]?.url).not.toContain('product_type');
    expect(out.bookings).toEqual([
      {
        providerBookingId: 'R-1',
        bookingDate: '2026-11-02',
        bookingReference: 'SDT1',
        status: 'CONFIRMED',
        providerStatus: 'ISSUED',
        providerRecordId: 'p-1',
        checkinDate: '2026-12-10',
        checkoutDate: '2026-12-12',
        hotelId: '7',
        total: { amountMinor: 12_000, currency: 'USD' },
        currency: 'USD',
      },
    ]);
  });

  it('pagina hasta que una página viene incompleta, y corta en un tope', async () => {
    const llena = {
      items: Array.from({ length: 50 }, (_, n) => ({
        id: `i-${n}`,
        product: { product_id: `p-${n}`, status: 'ISSUED' },
      })),
    };
    const { calls } = stubSequence([{ body: llena }, { body: { items: [] } }]);
    const out = await adapter().listBookingsByDate({ from: '2026-11-01', to: '2026-11-30' }, CTX);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('page=1');
    // Sin fecha de compra no entran: no se puede afirmar que sean de la ventana.
    expect(out.bookings).toEqual([]);

    stubSequence(Array.from({ length: 40 }, () => ({ body: llena })));
    await expect(
      adapter().listBookingsByDate({ from: '2026-11-01', to: '2026-11-30' }, CTX),
    ).rejects.toThrow('más reservas');
  });
});

describe('piezas', () => {
  it('moneyText escribe el literal con dos decimales', () => {
    expect(moneyText({ amountMinor: 12_005, currency: 'USD' })).toBe('120.05');
    expect(moneyText({ amountMinor: 7, currency: 'USD' })).toBe('0.07');
    expect(moneyText({ amountMinor: -5, currency: 'USD' })).toBe('0.00');
  });
});
