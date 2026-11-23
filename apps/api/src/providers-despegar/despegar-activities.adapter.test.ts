import { ActivityOfferSchema } from '@sales-travel/canonical';
import {
  buildDistribution,
  DespegarActivitiesAdapter,
  DespegarActivitiesInputError,
  hourLabel,
  mapAvailability,
  mapDiscovery,
  mapModalities,
  mapShopping,
  type DespegarActivitiesConfig,
} from '@sales-travel/despegar-activities';
import {
  DespegarApiError,
  DespegarCancelNotAllowedError,
  type DespegarExchange,
} from '@sales-travel/despegar-hotels';
import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_UN_ORL_FAMILY,
  BOOK_SUCCESS,
  CANCEL_ALLOWED,
  CANCEL_DISALLOWED,
  CANCEL_DONE,
  CANCEL_QUOTE,
  DISCOVERY_ORL,
  ERROR_FORBIDDEN,
  ERROR_NO_AVAILABILITY,
  MODALITIES_UN_ORL,
  PAYMENTS_CURRENT_ACCOUNT,
  PREBOOK_ACTIVITY,
  RESERVATIONS_TICKET,
  SHOPPING_DY_ORL,
  SUGGESTIONS_ACTIVITIES,
} from './__fixtures__/despegar-activities.fixtures.js';

const CFG: DespegarActivitiesConfig = {
  apiKey: 'test-key-never-logged',
  baseUrl: 'https://api-dev.despegar.com/v3',
  site: 'br',
  language: 'es',
};

const FAMILY = { adults: 2, childrenAges: [7, 1] };

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Un fetch falso que responde por ruta y guarda lo que se envió. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const key = `${method} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      return Promise.resolve(new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body), { status: route.status ?? 200 }),
    );
  }) as typeof fetch;
  return { fn, calls };
}

function adapter(routes: Record<string, { status?: number; body: unknown }>) {
  const f = fakeFetch(routes);
  const exchanges: DespegarExchange[] = [];
  const a = new DespegarActivitiesAdapter(CFG, {
    fetch: f.fn,
    onExchange: (e) => exchanges.push(e),
  });
  return { a, calls: f.calls, exchanges };
}

describe('buildDistribution / hourLabel', () => {
  it('adultos y edades de menores separados por guiones; el bebé va como edad', () => {
    expect(buildDistribution({ adults: 2, childrenAges: [7, 1] })).toBe('2-7-1');
    expect(buildDistribution({ adults: 2, childrenAges: [] })).toBe('2');
    expect(buildDistribution({ adults: 0, childrenAges: [] })).toBe('1');
  });

  it('normaliza la hora de un tour a HH:mm', () => {
    expect(hourLabel(930)).toBe('09:30');
    expect(hourLabel(9)).toBe('09:00');
    expect(hourLabel('9:30')).toBe('09:30');
    expect(hourLabel('1430')).toBe('14:30');
    expect(hourLabel(2575)).toBeUndefined();
    expect(hourLabel(null)).toBeUndefined();
  });
});

describe('mappers de búsqueda', () => {
  it('discovery: aplana los grupos, deduplica y clasifica ticket/tour', () => {
    expect(mapDiscovery(DISCOVERY_ORL)).toEqual([
      { id: 'UN_ORL', category: 'ticket', name: 'Universal Orlando Resort' },
      { id: 'DY_ORL', category: 'ticket', name: 'Walt Disney World' },
      { id: 'TOUR_KSC_123', category: 'tour', name: 'Kennedy Space Center con traslado' },
    ]);
  });

  it('discovery: acepta la forma de la guía (`available_tickets`) y un array plano', () => {
    expect(
      mapDiscovery({ available_tickets: [{ tracking_id: 'X', type: 'TOUR', name: 'X' }] }),
    ).toHaveLength(1);
    expect(mapDiscovery([{ tracking_id: 'Y', type: 'TICKET', name: 'Y' }])).toEqual([
      { id: 'Y', category: 'ticket', name: 'Y' },
    ]);
    expect(mapDiscovery(null)).toEqual([]);
  });

  it('modalities: ficha, rangos de edad, adicionales, horarios y sólo imágenes https', () => {
    const d = mapModalities(MODALITIES_UN_ORL, 'UN_ORL');
    expect(d.category).toBe('ticket');
    expect(d.duration).toEqual({ unit: 'day', value: 1 });
    expect(d.images).toEqual([
      'https://media.despegar.com/un_orl/1.jpg',
      'https://media.despegar.com/un_orl/2.jpg',
    ]);
    expect(d.inclusions).toEqual(['Entrada a un parque', 'Estacionamiento']);
    expect(d.modalities.map((m) => m.id)).toEqual(['ORL_1P1D_EPIC', 'TOUR_MORNING']);
    const [ticket, tour] = d.modalities;
    expect(ticket?.ageRanges.child).toEqual({ minAge: 3, maxAge: 9 });
    expect(ticket?.referencePrices).toEqual([
      { amountMinor: 13900, currency: 'USD' },
      { amountMinor: 76550, currency: 'BRL' },
    ]);
    expect(ticket?.additionals[0]).toMatchObject({
      id: 'EXPRESS',
      prices: [{ amountMinor: 8900 }],
    });
    expect(tour?.availableDates[0]?.hours).toEqual(['09:30', '11:00']);
    expect(tour?.maxCapacity).toBeUndefined();
  });

  it('availability: precio por moneda, tramos de cancelación, validez y participantes', () => {
    const o = mapAvailability(AVAILABILITY_UN_ORL_FAMILY, {
      activityId: 'UN_ORL',
      modalityId: 'ORL_1P1D_EPIC',
      date: '2026-12-10',
      requested: FAMILY,
    });
    expect(o).toBeDefined();
    expect(ActivityOfferSchema.parse(o)).toBeTruthy();
    expect(o?.choiceId).toBe(AVAILABILITY_UN_ORL_FAMILY.choice_id);
    expect(o?.prices.map((p) => [p.currency, p.gross.amountMinor, p.net.amountMinor])).toEqual([
      ['USD', 41700, 38000],
      ['BRL', 229650, 209290],
    ]);
    expect(o?.prices[0]?.agencyCommission).toEqual({ amountMinor: 4170, currency: 'USD' });
    expect(o?.participants).toEqual({ adults: 2, childrenAges: [7, 1] });
    expect(o?.ageLimits).toEqual({ adultMaxAge: 120, childMaxAge: 9, infantMaxAge: 2 });
    expect(o?.cancellation.refundable).toBe(true);
    expect(o?.cancellation.tiers.map((t) => t.percentage)).toEqual([0, 50, 100]);
    expect(o?.cancellation.tiers[2]?.to).toBeUndefined();
    expect(o?.cancellation.tiers[1]?.penalties).toContainEqual({
      amountMinor: 114825,
      currency: 'BRL',
    });
    expect(o?.ticketValidity).toEqual({
      useDate: '2026-12-10',
      expirationDate: '2026-12-10T23:59:59Z',
    });
    expect(o?.startAt).toBe('2026-12-10T09:00:00-05:00');
    expect(o?.highlights).toHaveLength(2);
  });

  it('availability sin choice_id o sin precios no es una tarifa', () => {
    const ctx = { activityId: 'X', modalityId: 'M', date: '2026-12-10', requested: FAMILY };
    expect(mapAvailability({ ...AVAILABILITY_UN_ORL_FAMILY, choice_id: '' }, ctx)).toBeUndefined();
    expect(
      mapAvailability({ ...AVAILABILITY_UN_ORL_FAMILY, price_details: [] }, ctx),
    ).toBeUndefined();
  });

  it('sin política de cancelación, la tarifa no es reembolsable', () => {
    const o = mapAvailability(
      { ...AVAILABILITY_UN_ORL_FAMILY, cancellation_policy: undefined },
      { activityId: 'X', modalityId: 'M', date: '2026-12-10', requested: FAMILY },
    );
    expect(o?.cancellation).toEqual({ refundable: false, tiers: [], conditions: [] });
  });

  it('shopping: una tarifa por día y modalidad, sin las que no tienen precio', () => {
    const [park] = mapShopping(SHOPPING_DY_ORL, { adults: 2, childrenAges: [5, 9] });
    expect(park?.id).toBe('DY_ORL');
    expect(park?.offers.map((o) => [o.date, o.modalityId, o.category])).toEqual([
      ['2026-12-10', '1-DAY-MK', 'ticket'],
      ['2026-12-11', '1-DAY-MK', 'ticket'],
    ]);
    expect(park?.offers[0]?.modalityName).toBe('Magic Kingdom 1 día');
    expect(park?.offers[1]?.cancellation.refundable).toBe(false);
  });
});

describe('DespegarActivitiesAdapter (HTTP)', () => {
  it('discovery va a /v3/activities-api con x-apikey, site e idioma', async () => {
    const { a, calls, exchanges } = adapter({
      'GET /v3/activities-api/discovery': { body: DISCOVERY_ORL },
    });
    const items = await a.discover({ destination: 'orl' });
    expect(items).toHaveLength(3);
    const call = calls[0];
    expect(call?.headers['x-apikey']).toBe(CFG.apiKey);
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      destination: 'ORL',
      site: 'br',
      language: 'es',
    });
    expect(exchanges[0]).toMatchObject({ operation: 'activitiesDiscovery', outcome: 'SUCCESS' });
  });

  it('modalities pide el idioma en MAYÚSCULAS y el rango sólo con las dos fechas', async () => {
    const { a, calls } = adapter({
      'GET /v3/activities-api/modalities': { body: MODALITIES_UN_ORL },
    });
    await a.getModalities({ id: 'UN_ORL', from: '2026-12-01' });
    expect(calls[0]?.url.searchParams.get('language')).toBe('ES');
    expect(calls[0]?.url.searchParams.has('from')).toBe(false);
    await a.getModalities({ id: 'UN_ORL', from: '2026-12-01', to: '2026-12-31' });
    expect(calls[1]?.url.searchParams.get('to')).toBe('2026-12-31');
  });

  it('availability: una fecha, distribución por edades y horario como HH:mm', async () => {
    const { a, calls } = adapter({
      'GET /v3/activities-api/availability': { body: AVAILABILITY_UN_ORL_FAMILY },
    });
    const offer = await a.getAvailability({
      id: 'UN_ORL',
      modality: 'ORL_1P1D_EPIC',
      date: '2026-12-10',
      participants: FAMILY,
      schedule: '09:30',
    });
    expect(offer?.choiceId).toBeTruthy();
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      id: 'UN_ORL',
      modality: 'ORL_1P1D_EPIC',
      date: '2026-12-10',
      site: 'br',
      language: 'es',
      distribution: '2-7-1',
      schedule: '09:30',
    });
  });

  it('shopping: sólo parques de Orlando y la ventana se corta a 7 días', async () => {
    const { a, calls } = adapter({ 'GET /v3/activities-api/shopping': { body: SHOPPING_DY_ORL } });
    await expect(
      a.shopping({ park: 'XX_ORL', from: '2026-12-10', participants: FAMILY }),
    ).rejects.toBeInstanceOf(DespegarActivitiesInputError);
    expect(calls).toHaveLength(0);
    await a.shopping({
      park: 'dy_orl',
      from: '2026-12-10',
      to: '2026-12-30',
      participants: FAMILY,
    });
    expect(calls[0]?.url.searchParams.get('id')).toBe('DY_ORL');
    expect(calls[0]?.url.searchParams.get('site')).toBe('BR');
    expect(calls[0]?.url.searchParams.get('to')).toBe('2026-12-16');
  });

  it('sugerencias van a /v3/suggestions/activities', async () => {
    const { a, calls } = adapter({
      'GET /v3/suggestions/activities': { body: SUGGESTIONS_ACTIVITIES },
    });
    const s = await a.suggest('univ', 'es_AR');
    expect(s).toEqual([
      {
        id: 'POI_649980',
        label: 'Universal Studios, Orlando, Florida',
        type: 'POI',
        cityGid: 'CI_ORL',
      },
    ]);
    expect(calls[0]?.url.searchParams.get('locale')).toBe('es_AR');
  });

  it('prebook pide EXCHANGE_POLICIES y HINTS y mapea políticas de cualquier clave', async () => {
    const { a, calls } = adapter({ 'POST /v3/prebook': { body: PREBOOK_ACTIVITY } });
    const p = await a.prebook('choice-1');
    expect(calls[0]?.body).toEqual({
      choice_id: 'choice-1',
      lang: 'es',
      include: ['EXCHANGE_POLICIES', 'HINTS'],
    });
    expect(p.prebookId).toBe('prebook-act-1');
    expect(p.total).toEqual({ amountMinor: 41700, currency: 'USD' });
    expect(p.exchangePolicies[0]?.conditions[0]?.answers[0]?.answer).toBe('No se admiten cambios.');
    expect(p.exchangePolicies[0]?.disclaimers.map((d) => d.description)).toEqual([
      'Presentar documento en la entrada.',
      'Los horarios pueden cambiar.',
    ]);
    expect(p.hints[0]?.requirements).toContain('form.travelers.validations: BIRTH_DATE_REQUIRED');
  });

  it('book a cuenta corriente con todos los participantes; titular en la referencia 0', async () => {
    const { a, calls } = adapter({
      'POST /v3/book': { body: BOOK_SUCCESS },
      'GET /v3/payments': { body: PAYMENTS_CURRENT_ACCOUNT },
    });
    const options = await a.getPaymentOptions('prebook-act-1');
    expect(options[0]?.options.map((o) => o.optionType)).toContain('CURRENT_ACCOUNT');
    const result = await a.book({
      prebookId: 'prebook-act-1',
      externalBookingReference: 'ST-ACT-1',
      contact: { email: 'agencia@example.com' },
      travelers: [
        { firstName: 'José', lastName: 'Peña', birthDate: '1990-01-01', nationality: 'br' },
        { firstName: 'Ana', lastName: 'Peña', birthDate: '2019-05-01' },
        { firstName: 'Iñaki', lastName: 'Peña', birthDate: '2025-06-01' },
      ],
    });
    expect(result).toMatchObject({
      reservationId: '815222296950',
      status: 'SUCCESS',
      products: [{ type: 'TICKET', platformId: '24315872051', pnr: '77812' }],
    });
    const body = calls[1]?.body as Record<string, unknown>;
    expect(body['payment']).toEqual({
      option_type: 'CURRENT_ACCOUNT',
      payment_units: [{ type: 'CURRENT_ACCOUNT' }],
      invoices: [],
    });
    const travelers = body['travelers'] as Record<string, unknown>[];
    expect(travelers.map((t) => t['traveler_reference_id'])).toEqual(['0', '1', '2']);
    // Los caracteres ISO-8859-1 viajan tal cual.
    expect(travelers[2]?.['first_name']).toBe('Iñaki');
    expect(travelers[0]?.['nationality']).toBe('BR');
  });

  it('cancelación en tres pasos sobre el product_id de /reservations', async () => {
    const { a, calls } = adapter({
      'GET /v3/reservations': { body: RESERVATIONS_TICKET },
      'GET /v3/reservations/99001/cancels/allowance': { body: CANCEL_ALLOWED },
      'POST /v3/reservations/cancels/quote': { body: CANCEL_QUOTE },
      'POST /v3/reservations/99001/cancels': { body: CANCEL_DONE },
    });
    const r = await a.cancelReservation('815222296950');
    expect(r).toMatchObject({
      success: true,
      flowId: 'CAN-123',
      quote: { resolution: 'AUTOMATIC' },
    });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /v3/reservations',
      'GET /v3/reservations/99001/cancels/allowance',
      'POST /v3/reservations/cancels/quote',
      'POST /v3/reservations/99001/cancels',
    ]);
    expect(calls[2]?.body).toEqual({ transaction_id: '55001', quote_type: 'BY_POLICIES' });
    expect(calls[3]?.body).toEqual({ reason: 'OTHER' });
  });

  it('si Despegar no permite cancelar, no cotiza ni cancela', async () => {
    const { a, calls } = adapter({
      'GET /v3/reservations': { body: RESERVATIONS_TICKET },
      'GET /v3/reservations/99001/cancels/allowance': { body: CANCEL_DISALLOWED },
    });
    await expect(a.cancelReservation('815222296950')).rejects.toBeInstanceOf(
      DespegarCancelNotAllowedError,
    );
    expect(calls).toHaveLength(2);
  });

  it('la reserva trae el voucher de HotelDO absoluto y sólo productos de actividades', async () => {
    const { a } = adapter({ 'GET /v3/reservations': { body: RESERVATIONS_TICKET } });
    const r = await a.findReservation('815222296950');
    expect(r).toMatchObject({
      productId: '99001',
      productType: 'TICKET',
      status: 'ISSUED',
      voucherUrl: 'https://api-dev.despegar.com/v3/vouchers/815222296950.pdf',
      salePrice: { amountMinor: 41700, currency: 'USD' },
    });
    expect(r?.passengers).toHaveLength(3);
  });

  it('un error de Despegar trae el code pero NO el cuerpo en el mensaje', async () => {
    const { a, exchanges } = adapter({
      'GET /v3/activities-api/availability': { status: 503, body: ERROR_NO_AVAILABILITY },
    });
    const err = await a
      .getAvailability({ id: 'X', modality: 'M', date: '2026-12-10', participants: FAMILY })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DespegarApiError);
    const apiErr = err as DespegarApiError;
    expect(apiErr.status).toBe(503);
    expect(apiErr.providerCode).toBe('ACTIVITY_PROVIDER_ERROR');
    expect(apiErr.message).not.toContain('Error with activity provider');
    expect(apiErr.message).not.toContain(CFG.apiKey);
    expect(exchanges[0]).toMatchObject({ outcome: 'PROVIDER_ERROR', status: 503 });
  });

  it('el 403 de hoy (sin permiso de actividades) es un rechazo sin la clave en el mensaje', async () => {
    const { a } = adapter({
      'GET /v3/activities-api/discovery': { status: 403, body: ERROR_FORBIDDEN },
    });
    const err = (await a
      .discover({ destination: 'ORL' })
      .catch((e: unknown) => e)) as DespegarApiError;
    expect(err.status).toBe(403);
    expect(err.message).not.toContain(CFG.apiKey);
  });
});
