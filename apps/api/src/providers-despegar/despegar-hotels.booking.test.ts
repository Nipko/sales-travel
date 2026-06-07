import {
  buildBookBody,
  buildCancelBody,
  buildPaymentOptionsQuery,
  buildPrebookBody,
  buildRecoveryBody,
  DespegarHotelsAdapter,
  mapBookResult,
  mapCancelResult,
  mapPaymentOptions,
  mapPrebook,
  mapRecoveryResult,
  type BookRequest,
} from '@sales-travel/despegar-hotels';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ───────────────────────── Builders & mappers puros ─────────────────────────

describe('prebook', () => {
  it('buildPrebookBody envía choice_id y omite include vacío', () => {
    expect(buildPrebookBody({ choiceId: 'CH' })).toEqual({ choice_id: 'CH' });
    expect(buildPrebookBody({ choiceId: 'CH', lang: 'es', include: [] })).toEqual({
      choice_id: 'CH',
      lang: 'es',
    });
    expect(buildPrebookBody({ choiceId: 'CH', include: ['HINTS'] })).toEqual({
      choice_id: 'CH',
      include: ['HINTS'],
    });
  });

  it('mapPrebook convierte montos y comisión a Money', () => {
    const out = mapPrebook({
      prebook_id: 'pb-1',
      expiration: '2026-07-01T10:00:00Z',
      status: 'PREBOOKED',
      flow: 'STANDARD',
      total: 200.5,
      currency: 'USD',
      commission: { amount: 20.05, max_amount: 25, min_amount: 15 },
    });
    expect(out).toEqual({
      prebookId: 'pb-1',
      status: 'PREBOOKED',
      expiration: '2026-07-01T10:00:00Z',
      flow: 'STANDARD',
      total: { amountMinor: 20050, currency: 'USD' },
      commission: {
        amount: { amountMinor: 2005, currency: 'USD' },
        maxAmount: { amountMinor: 2500, currency: 'USD' },
        minAmount: { amountMinor: 1500, currency: 'USD' },
      },
    });
  });
});

describe('payments', () => {
  it('buildPaymentOptionsQuery mapea a snake_case', () => {
    expect(
      buildPaymentOptionsQuery({ prebookId: 'pb-1', inputPoints: 100, includeHints: true }),
    ).toEqual({ prebook_id: 'pb-1', input_points: 100, include_hints: true });
  });

  it('mapPaymentOptions normaliza modalidad, totales y plan_id', () => {
    const out = mapPaymentOptions({
      modalities: [
        {
          modality: 'PAYINADVANCE',
          price_information: {
            currency: 'USD',
            total: {
              base: 170,
              taxes: 30,
              total: 200,
              tax_breakdown: [{ code: 'VAT', amount: 30 }],
            },
          },
          payment_options: [{ option_type: 'ONE_CARD', group_plans: 'plan-9' }],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      modality: 'PAYINADVANCE',
      total: { amountMinor: 20000, currency: 'USD' },
      base: { amountMinor: 17000, currency: 'USD' },
      taxes: { amountMinor: 3000, currency: 'USD' },
      taxBreakdown: [{ code: 'VAT', amount: { amountMinor: 3000, currency: 'USD' } }],
      options: [{ optionType: 'ONE_CARD', planId: 'plan-9' }],
    });
  });
});

describe('book', () => {
  const req: BookRequest = {
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

  it('buildBookBody normaliza a snake_case y aplica modality por defecto', () => {
    const body = buildBookBody(req);
    expect(body['prebook_id']).toBe('pb-1');
    expect(body['external_booking_reference']).toBe('ISO-1234');
    expect(body['modality']).toBe('PAYINADVANCE');

    const contact = body['contact_data'] as {
      email: string;
      phones: { country_code: string; type: string }[];
    };
    expect(contact.email).toBe('ana@example.com');
    expect(contact.phones[0]).toMatchObject({ country_code: '57', type: 'MOBILE' });

    const travelers = body['travelers'] as {
      traveler_reference_id: string;
      first_name: string;
      identification: { type: string; issue_country: string };
    }[];
    expect(travelers[0]?.traveler_reference_id).toBe('1');
    expect(travelers[0]?.first_name).toBe('Ana');
    expect(travelers[0]?.identification).toMatchObject({ type: 'PASSPORT', issue_country: 'CO' });

    const payment = body['payment'] as {
      option_type: string;
      payment_units: { type: string; plan_id: string; secure_token: string }[];
    };
    expect(payment.option_type).toBe('ONE_CARD');
    expect(payment.payment_units[0]).toMatchObject({
      type: 'ONE_CARD',
      plan_id: 'plan-9',
      secure_token: 'tok_secure',
    });
  });

  it('mapBookResult: SUCCESS con productos', () => {
    const out = mapBookResult({
      reservationId: 'r-1',
      status: 'SUCCESS',
      products: [{ type: 'HOTEL', platform_id: 123, pnr: 'ABC' }],
    });
    expect(out).toEqual({
      reservationId: 'r-1',
      status: 'SUCCESS',
      products: [{ type: 'HOTEL', platformId: '123', pnr: 'ABC' }],
    });
  });

  it('mapBookResult: ERROR con sub_status y message como arreglo', () => {
    const out = mapBookResult({
      reservationId: 'r-2',
      status: 'ERROR',
      sub_status: 'PRICE_JUMP',
      message: ['precio cambió'],
      products: [],
    });
    expect(out.status).toBe('ERROR');
    expect(out.subStatus).toBe('PRICE_JUMP');
    expect(out.message).toBe('precio cambió');
  });

  it('mapBookResult: getreservation usa reservation_id (snake)', () => {
    const out = mapBookResult({ reservation_id: 'r-3', status: 'PROCESSING', products: [] });
    expect(out.reservationId).toBe('r-3');
    expect(out.status).toBe('PROCESSING');
  });

  it('mapBookResult: status desconocido cae a ERROR', () => {
    expect(mapBookResult({ reservationId: 'r', status: 'WAT' }).status).toBe('ERROR');
  });
});

describe('cancel', () => {
  it('buildCancelBody usa OTHER por defecto', () => {
    expect(buildCancelBody()).toEqual({ reason: 'OTHER' });
    expect(buildCancelBody('HOTEL_PROBLEM')).toEqual({ reason: 'HOTEL_PROBLEM' });
  });

  it('mapCancelResult marca éxito y conserva ids', () => {
    expect(mapCancelResult({ flow_id: 'f-1', product_id: 'p-1', product_type: 'HOTEL' })).toEqual({
      success: true,
      flowId: 'f-1',
      productId: 'p-1',
      productType: 'HOTEL',
    });
  });
});

describe('recovery', () => {
  it('buildRecoveryBody arma price_jump_confirmations', () => {
    expect(
      buildRecoveryBody({
        reservationId: 'r-1',
        messageType: 'PRICE_JUMP',
        confirmations: [{ flavorId: 'H0', confirm: true }],
      }),
    ).toEqual({
      message_type: 'PRICE_JUMP',
      price_jump_confirmations: [{ flavor_id: 'H0', confirm: true }],
    });
  });

  it('mapRecoveryResult pasa el item', () => {
    expect(mapRecoveryResult({ item: { foo: 'bar' } })).toEqual({ item: { foo: 'bar' } });
    expect(mapRecoveryResult({})).toEqual({});
  });
});

// ───────────────────────── Adapter end-to-end (fetch stub) ─────────────────────────

interface FetchCall {
  url: string;
  method?: string;
  body: unknown;
  headers: Record<string, string>;
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
        headers: init.headers as Record<string, string>,
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
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DespegarHotelsAdapter — reserva', () => {
  it('prebook() hace POST /prebook con choice_id y lang por defecto del cfg', async () => {
    const { calls } = stubFetch({
      prebook_id: 'pb-1',
      status: 'PREBOOKED',
      total: 100,
      currency: 'USD',
    });
    const out = await new DespegarHotelsAdapter(cfg).prebook({ choiceId: 'CH-1' });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/prebook');
    expect(calls[0]?.headers['x-apikey']).toBe('secret-key');
    expect(calls[0]?.body).toEqual({ choice_id: 'CH-1', lang: 'es' });
    expect(out.prebookId).toBe('pb-1');
    expect(out.total).toEqual({ amountMinor: 10000, currency: 'USD' });
  });

  it('getPaymentOptions() hace GET /payments?prebook_id', async () => {
    const { calls } = stubFetch({ modalities: [] });
    await new DespegarHotelsAdapter(cfg).getPaymentOptions({ prebookId: 'pb-1' });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/payments?prebook_id=pb-1');
  });

  it('book() hace POST /book; con testCase agrega test_case=pricejump', async () => {
    const { calls } = stubFetch({ reservationId: 'r-1', status: 'SUCCESS', products: [] });
    const adapter = new DespegarHotelsAdapter(cfg);
    const req: BookRequest = {
      prebookId: 'pb-1',
      externalBookingReference: 'ISO-1',
      contact: { email: 'a@b.com' },
      travelers: [{ referenceId: '1', firstName: 'A', lastName: 'B' }],
      payment: { optionType: 'ONE_CARD', units: [{ planId: 'p', secureToken: 't' }] },
      testCase: 'pricejump',
    };
    const out = await adapter.book(req);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/book?test_case=pricejump');
    expect((calls[0]?.body as Record<string, unknown>)['prebook_id']).toBe('pb-1');
    expect(out.status).toBe('SUCCESS');
  });

  it('getReservation() hace GET /book/{id}', async () => {
    const { calls } = stubFetch({ reservation_id: 'r-9', status: 'PROCESSING', products: [] });
    const out = await new DespegarHotelsAdapter(cfg).getReservation('r-9');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/book/r-9');
    expect(out.reservationId).toBe('r-9');
  });

  it('cancelReservation() hace POST /reservations/{id}/cancels con reason', async () => {
    const { calls } = stubFetch({ flow_id: 'f-1', product_id: 'p-1', product_type: 'HOTEL' });
    const out = await new DespegarHotelsAdapter(cfg).cancelReservation({
      reservationId: 'r-1',
      reason: 'HOTEL_PROBLEM',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/reservations/r-1/cancels');
    expect(calls[0]?.body).toEqual({ reason: 'HOTEL_PROBLEM' });
    expect(out.success).toBe(true);
  });

  it('recoverBooking() hace PATCH /book/{id}/recovery', async () => {
    const { calls } = stubFetch({ item: { ok: true } });
    await new DespegarHotelsAdapter(cfg).recoverBooking({
      reservationId: 'r-1',
      messageType: 'PRICE_JUMP',
      confirmations: [{ flavorId: 'H0', confirm: true }],
      testCase: 'pricejump',
    });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/book/r-1/recovery?test_case=pricejump');
    expect((calls[0]?.body as Record<string, unknown>)['message_type']).toBe('PRICE_JUMP');
  });
});
