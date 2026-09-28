import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { HotelPrebookPort, HotelPrebookRequest } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { parseTboConfig } from './config';
import {
  TboApiError,
  TboOfferExpiredError,
  TboRequestBuildError,
  TboResponseMappingError,
} from './errors';
import { TboInMemoryRateLimiter } from './http/limiter';
import type { TboFetch, TboHttpDeps } from './http/tbo-http.client';
import { TBO_OFFER_TTL_MS } from './search/offer-window';
import { TboHotelsAdapter, type TboPrebookQuery } from './tbo-hotels.adapter';

/**
 * PreBook por la puerta pública del adapter, con `fetch` espiado y reloj falso (docs/tbo/09
 * PR-4.1; 08 RF-09 CA-1, RF-15 CA-1, CA-2 y CA-4, RF-16, RF-17).
 */

const CTX = { tenantId: '00000000-0000-4000-8000-00000000000a' };
const SEARCH_SENT_AT = Date.parse('2026-09-25T15:00:00.000Z');
const MINUTE = 60_000;
const SEARCH_ID = 'srch-00000000-0000-4000-8000-000000000001';
const BOOKING_CODE = '1120548!TB!4!TB!9a47646b-1bba-4746-91d5-969149db1185';
const TWO_ROOMS: HotelRoomOccupancy[] = [
  { adults: 2, childrenAges: [] },
  { adults: 2, childrenAges: [] },
];
const FIXTURES = join(__dirname, '__fixtures__');

function fixture(...path: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, ...path), 'utf8')) as Record<string, unknown>;
}

const MULTI_ROOM = fixture('pdf', 'prebook-limit-multi-room.p28.json');
const POSTMAN = fixture('postman', 'prebook.request.json') as { body: Record<string, unknown> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function status(code: number): Response {
  return json({ Status: { Code: code, Description: 'x' } });
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: string;
}

type Responder = (call: FetchCall, index: number) => Response | Promise<Response>;

function hanging(call: FetchCall): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (call.init.signal?.aborted === true) abort();
    else call.init.signal?.addEventListener('abort', abort);
  });
}

interface Harness {
  readonly adapter: TboHotelsAdapter;
  readonly calls: FetchCall[];
  readonly logs: { level: string; message: string; meta: unknown }[];
  readonly counters: { name: string; tags: Record<string, string> | undefined }[];
  readonly clock: { now: number };
  readonly sleeps: number[];
}

function harness(responder: Responder = () => json(MULTI_ROOM), deps: TboHttpDeps = {}): Harness {
  const calls: FetchCall[] = [];
  const fetch: TboFetch = (url, init) => {
    const call = { url, init, body: typeof init.body === 'string' ? init.body : '' };
    calls.push(call);
    return Promise.resolve(responder(call, calls.length - 1));
  };
  const logs: Harness['logs'] = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  const counters: Harness['counters'] = [];
  const metrics: MetricsPort = {
    counter: (name, _value, tags) => counters.push({ name, tags }),
    gauge: () => undefined,
    histogram: () => undefined,
  };
  const clock = { now: SEARCH_SENT_AT + 5 * MINUTE };
  const sleeps: number[] = [];
  const adapter = new TboHotelsAdapter(
    parseTboConfig({ environment: 'test', username: 'agencia-demo', password: 'Pa55w0rd-pb' }),
    {
      fetch,
      logger,
      metrics,
      now: () => clock.now,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0,
      limiter: new TboInMemoryRateLimiter({
        maxQps: 1_000,
        maxConcurrent: 100,
        background: { qps: 1_000, concurrent: 100 },
      }),
      ...deps,
    },
    { ownerTenantId: CTX.tenantId, credentialSource: 'inherited' },
  );
  return { adapter, calls, logs, counters, clock, sleeps };
}

function query(overrides: Partial<TboPrebookQuery> = {}): TboPrebookQuery {
  return {
    hotelCode: '1120548',
    bookingCode: BOOKING_CODE,
    searchId: SEARCH_ID,
    searchSentAt: SEARCH_SENT_AT,
    rooms: TWO_ROOMS,
    ...overrides,
  };
}

function portRequest(overrides: Partial<HotelPrebookRequest> = {}): HotelPrebookRequest {
  return {
    offer: { name: 'tbo-hotels', offerRef: BOOKING_CODE, raw: { searchId: SEARCH_ID } },
    searchSentAt: new Date(SEARCH_SENT_AT).toISOString(),
    providerOptions: { hotelCode: '1120548', rooms: TWO_ROOMS },
    ...overrides,
  };
}

describe('el camino feliz', () => {
  it('implementa HotelPrebookPort', () => {
    const port: HotelPrebookPort = harness().adapter;
    expect(typeof port.prebook).toBe('function');
  });

  it('RF-15 CA-1: UNA llamada a /PreBook con el body exacto de Postman', async () => {
    const { adapter, calls } = harness();
    // La respuesta es la de p. 28, con otro BookingCode: se lee igual y lo informa (CA-2).
    await adapter.prebookReport(query({ bookingCode: String(POSTMAN.body['BookingCode']) }), CTX);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith('/PreBook')).toBe(true);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body).toBe(JSON.stringify(POSTMAN.body));
  });

  it('el reporte trae lo que el Book reenvía, la marca de solo paquete y la huella de C2', async () => {
    const { adapter, calls } = harness();
    const report = await adapter.prebookReport(query(), CTX);
    expect(calls).toHaveLength(1);
    expect(report.pack).toEqual({
      hotelCode: '1120548',
      bookingCode: BOOKING_CODE,
      totalFare: '305.75',
      currency: 'USD',
    });
    expect(report.result.signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
    expect(report.result.roompack?.cancellation.policySource).toBe('prebook-final');
    expect(report.rateConditionsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.attempts).toBe(1);
    expect(report.accountRef).toBe(harness().adapter.accountRef);
    expect(report.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('por el puerto neutral: offerRef, searchId del raw y hotel y ocupación en providerOptions', async () => {
    const { adapter, calls } = harness();
    const result = await adapter.prebook(portRequest(), CTX);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      BookingCode: BOOKING_CODE,
      PaymentMode: 'Limit',
    });
    expect(result.total).toEqual({ amountMinor: 30575, currency: 'USD' });
    expect(result.expiresAt).toBe(new Date(SEARCH_SENT_AT + TBO_OFFER_TTL_MS).toISOString());
    expect(result.rateConditions).toHaveLength(13);
  });
});

describe('RF-09: la ventana de 30 minutos se decide sin llamar a TBO', () => {
  it('CA-1: PreBook en el minuto 27:01 → TboOfferExpiredError y CERO llamadas', async () => {
    const { adapter, calls, clock, counters } = harness();
    clock.now = SEARCH_SENT_AT + 27 * MINUTE + 1_000;
    await expect(adapter.prebookReport(query(), CTX)).rejects.toBeInstanceOf(TboOfferExpiredError);
    await expect(adapter.prebook(portRequest(), CTX)).rejects.toBeInstanceOf(TboOfferExpiredError);
    expect(calls).toHaveLength(0);
    expect(counters.map((c) => c.name)).toContain('tbo.prebook.expired_locally');
  });

  it('justo en el vencimiento ya no sale; un segundo antes, sí', async () => {
    const expired = harness();
    expired.clock.now = SEARCH_SENT_AT + TBO_OFFER_TTL_MS;
    await expect(expired.adapter.prebookReport(query(), CTX)).rejects.toMatchObject({
      name: 'TboOfferExpiredError',
      expiresAt: new Date(SEARCH_SENT_AT + TBO_OFFER_TTL_MS).toISOString(),
    });
    expect(expired.calls).toHaveLength(0);

    const alive = harness();
    alive.clock.now = SEARCH_SENT_AT + TBO_OFFER_TTL_MS - 1_000;
    await alive.adapter.prebookReport(query(), CTX);
    expect(alive.calls).toHaveLength(1);
  });

  it('un searchSentAt en el futuro estiraría la ventana: se rechaza sin llamar', async () => {
    const { adapter, calls, clock } = harness();
    clock.now = SEARCH_SENT_AT;
    await expect(
      adapter.prebookReport(query({ searchSentAt: SEARCH_SENT_AT + 10 * MINUTE }), CTX),
    ).rejects.toMatchObject({
      name: 'TboRequestBuildError',
      issues: ['query.searchSentAt:in_the_future'],
    });
    expect(calls).toHaveLength(0);
  });

  it('un 315 de TBO llega como OFFER_EXPIRED, para que el servidor invalide el contexto', async () => {
    const { adapter, calls } = harness(() => status(315));
    await expect(adapter.prebookReport(query(), CTX)).rejects.toMatchObject({
      name: 'TboApiError',
      kind: 'OFFER_EXPIRED',
      tboCode: 315,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('RF-15 CA-4: desenlaces de TBO y reintentos (08 §9 C-24)', () => {
  it.each<[number, string]>([
    [201, 'NO_AVAILABILITY'],
    [207, 'RATE_UNAVAILABLE'],
    [300, 'INSUFFICIENT_BALANCE'],
    [402, 'ACCOUNT_BLOCKED'],
    [400, 'CLIENT_BUG'],
    [401, 'CREDENTIALS_INVALID'],
  ])('%i → TboApiError %s, en UNA llamada', async (code, kind) => {
    const { adapter, calls } = harness(() => status(code));
    const error = await adapter.prebookReport(query(), CTX).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboApiError);
    expect(error).toMatchObject({ kind, tboCode: code, path: '/PreBook' });
    expect(calls).toHaveLength(1);
  });

  it.each<[string, Responder]>([
    ['un 500', () => status(500)],
    ['un 429', () => status(429)],
    ['una conexión rechazada', () => Promise.reject(new TypeError('fetch failed: ECONNREFUSED'))],
  ])('%s rápido admite UN reintento dentro de los 23 s', async (_label, first) => {
    const { adapter, calls } = harness((call, index) =>
      index === 0 ? first(call, index) : json(MULTI_ROOM),
    );
    const report = await adapter.prebookReport(query(), CTX);
    expect(calls).toHaveLength(2);
    expect(report.attempts).toBe(2);
  });

  it('dos fallos rápidos seguidos: dos llamadas y el error del segundo, nunca una tercera', async () => {
    const { adapter, calls } = harness(() => status(500));
    await expect(adapter.prebookReport(query(), CTX)).rejects.toMatchObject({ kind: 'UPSTREAM' });
    expect(calls).toHaveLength(2);
  });

  it('un timeout NO se reintenta: dos intentos de 23 s serían demasiada espera', async () => {
    const { adapter, calls } = harness(hanging, {
      timeoutSignal: () => AbortSignal.abort(new DOMException('t', 'TimeoutError')),
    });
    await expect(adapter.prebookReport(query(), CTX)).rejects.toMatchObject({
      name: 'TboApiError',
      kind: 'TRANSPORT',
      timedOut: true,
    });
    expect(calls).toHaveLength(1);
  });

  it('el PreBook espera 23 s (p. 8)', async () => {
    const waits: number[] = [];
    const { adapter } = harness(undefined, {
      timeoutSignal: (ms) => {
        waits.push(ms);
        return AbortSignal.timeout(ms);
      },
    });
    await adapter.prebookReport(query(), CTX);
    expect(waits).toEqual([23_000]);
  });

  it('una respuesta 200 con dos HotelResult es ilegible, con el requestId de la llamada', async () => {
    const hotels = (MULTI_ROOM['HotelResult'] as unknown[]) ?? [];
    const { adapter } = harness(() => json({ ...MULTI_ROOM, HotelResult: [hotels[0], hotels[0]] }));
    const error = await adapter.prebookReport(query(), CTX).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboResponseMappingError);
    expect((error as TboResponseMappingError).issues).toEqual(['HotelResult:too_big']);
    expect((error as TboResponseMappingError).requestId).toBeDefined();
  });

  it('la señal del vendedor aborta la espera (lectura interactiva)', async () => {
    const controller = new AbortController();
    const { adapter, calls } = harness((call) => {
      controller.abort();
      return hanging(call);
    });
    await expect(
      adapter.prebookReport(query({ signal: controller.signal }), CTX),
    ).rejects.toMatchObject({ name: 'TboApiError', kind: 'TRANSPORT' });
    expect(calls).toHaveLength(1);
  });
});

describe('RF-15 CA-2: otro BookingCode en la respuesta', () => {
  it('el reporte trae el de PreBook para el Book y la alerta queda en métricas y log', async () => {
    const changed = '1120548!TB!4!TB!11111111-1111-4111-8111-111111111111';
    const hotels = MULTI_ROOM['HotelResult'] as [
      Record<string, unknown> & { Rooms: [Record<string, unknown>] },
    ];
    const [first] = hotels;
    const { adapter, counters, logs } = harness(() =>
      json({
        ...MULTI_ROOM,
        HotelResult: [{ ...first, Rooms: [{ ...first.Rooms[0], BookingCode: changed }] }],
      }),
    );
    const report = await adapter.prebookReport(query(), CTX);
    expect(report.pack.bookingCode).toBe(changed);
    expect(report.result.warnings).toEqual(['BOOKING_CODE_CHANGED']);
    expect(counters.map((c) => c.name)).toContain('tbo.prebook.booking_code_changed');
    expect(logs.some((log) => log.message === 'tbo.prebook.booking_code_changed')).toBe(true);
  });
});

describe('D1 por la puerta pública: el cable sólo lleva BookingCode y "Limit"', () => {
  it('un modo o una tarjeta colados en providerOptions o en la consulta no llegan a TBO', async () => {
    const { adapter, calls } = harness();
    const card = { CardNumber: '4111111111111111', CvvNumber: '123' };
    await adapter.prebook(
      portRequest({
        providerOptions: {
          hotelCode: '1120548',
          rooms: TWO_ROOMS,
          PaymentMode: 'NewCard',
          PaymentInfo: card,
        },
      }),
      CTX,
    );
    await adapter.prebookReport(
      { ...query(), PaymentMode: 'SavedCard', PaymentInfo: card } as unknown as TboPrebookQuery,
      CTX,
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(JSON.parse(call.body)).toEqual({ BookingCode: BOOKING_CODE, PaymentMode: 'Limit' });
      expect(call.body).not.toMatch(/Card|Cvv|PaymentInfo|4111/);
    }
  });
});

describe('RateConditions por la puerta pública (RF-16, RF-17)', () => {
  const PACKAGE_ONLY =
    'Please note that this a special rate which should be sold only with an airline ticket as part of a package.';

  function withConditions(conditions: string[]): Record<string, unknown> {
    const [first] = MULTI_ROOM['HotelResult'] as [Record<string, unknown>];
    return { ...MULTI_ROOM, HotelResult: [{ ...first, RateConditions: conditions }] };
  }

  it('RF-16 CA-1: `&amp;lt;script&amp;gt;` llega al reporte como el TEXTO `&lt;script&gt;`, con el original', async () => {
    const hostile = 'Note: &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;';
    const { adapter } = harness(() => json(withConditions([hostile])));
    const report = await adapter.prebookReport(query(), CTX);
    expect(report.result.rateConditions).toEqual([
      { category: 'other', text: 'Note: &lt;script&gt;alert(1)&lt;/script&gt;', raw: hostile },
    ]);
  });

  it('RF-17: cada detección y cada "package" que no la disparó se cuentan en métricas', async () => {
    const { adapter, counters } = harness(() =>
      json(withConditions([PACKAGE_ONLY, 'Honeymoon package available on request.'])),
    );
    const report = await adapter.prebookReport(query(), CTX);
    expect(report.result.signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
    expect(report.diagnostics.packageMentionsWithoutSignal).toBe(1);
    expect(counters).toContainEqual({
      name: 'tbo.prebook.rate_signal',
      tags: { op: 'prebook', signal: 'PACKAGE_WITH_FLIGHT_ONLY' },
    });
    expect(counters.filter((c) => c.name === 'tbo.prebook.package_text_without_signal')).toEqual([
      { name: 'tbo.prebook.package_text_without_signal', tags: { op: 'prebook' } },
    ]);
  });
});

describe('el puerto neutral exige lo que PreBook necesita', () => {
  it.each<[string, Partial<HotelPrebookRequest>, string]>([
    ['sin searchSentAt', { searchSentAt: undefined }, 'searchSentAt:missing'],
    ['searchSentAt ilegible', { searchSentAt: 'ayer' }, 'searchSentAt:invalid'],
    [
      'tarifa de otro proveedor',
      { offer: { name: 'despegar-hotels', offerRef: 'x', raw: { searchId: SEARCH_ID } } },
      'offer.name:not_tbo_hotels',
    ],
    [
      'sin searchId',
      { offer: { name: 'tbo-hotels', offerRef: BOOKING_CODE } },
      'offer.raw.searchId:missing',
    ],
    [
      'sin hotel',
      { providerOptions: { rooms: TWO_ROOMS } },
      'providerOptions.hotelCode:invalid_type',
    ],
    [
      'sin ocupación',
      { providerOptions: { hotelCode: '1120548' } },
      'providerOptions.rooms:invalid_type',
    ],
  ])('%s → TboRequestBuildError y ninguna llamada', async (_label, override, issue) => {
    const { adapter, calls } = harness();
    const request = { ...portRequest(), ...override };
    const error = await adapter.prebook(request, CTX).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboRequestBuildError);
    expect((error as TboRequestBuildError).issues).toContain(issue);
    expect(calls).toHaveLength(0);
  });

  it.each<[string, Partial<TboPrebookQuery>, string]>([
    ['BookingCode vacío', { bookingCode: '' }, 'query.bookingCode:too_small'],
    ['instante no entero', { searchSentAt: Number.NaN }, 'query.searchSentAt:invalid_type'],
    ['ocupación vacía', { rooms: [] }, 'query.rooms:too_small'],
  ])('la consulta del reporte se valida en el borde: %s', async (_label, override, issue) => {
    const { adapter, calls } = harness();
    await expect(adapter.prebookReport(query(override), CTX)).rejects.toMatchObject({
      name: 'TboRequestBuildError',
      issues: [issue],
    });
    expect(calls).toHaveLength(0);
  });
});

describe('lo que llega al log (RNF-05)', () => {
  it('ni la cuenta, ni el BookingCode, ni el texto de las condiciones', async () => {
    const { adapter, logs } = harness((_call, index) =>
      index === 0 ? status(500) : json(MULTI_ROOM),
    );
    await adapter.prebookReport(query(), CTX);
    const dump = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      'agencia-demo',
      'Pa55w0rd-pb',
      // El header Basic es reversible: su base64 es la credencial entera.
      Buffer.from('agencia-demo:Pa55w0rd-pb').toString('base64'),
      BOOKING_CODE,
      'Tourism Dirham',
      'airline ticket',
      'Non-Smoking',
    ]) {
      expect(dump).not.toContain(secret);
    }
  });
});
