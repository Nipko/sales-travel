import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  HotelOfferSchema,
  type HotelRatesQuery,
  type HotelSearchCriteria,
} from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { HotelRatesDetailPort, HotelSearchPort } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { TBO_BASE_URLS, parseTboConfig, type TboHotelsConfig } from './config';
import {
  TboApiError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboRequestBuildError,
  TboUnsupportedCurrencyError,
} from './errors';
import { TboInMemoryRateLimiter, type TboRateLimiter } from './http/limiter';
import { TBO_OPERATIONS } from './http/operations';
import type { TboFetch, TboHttpDeps } from './http/tbo-http.client';
import { TBO_OFFER_TTL_MS } from './search/offer-window';
import {
  TBO_SEARCH_BATCHING_LIMITS,
  TboHotelsAdapter,
  type TboHotelsAdapterOptions,
} from './tbo-hotels.adapter';

/**
 * El adapter por su puerta pública (docs/tbo/09 PR-1.5), con `fetch` espiado: lo que se mide es lo
 * que sale al cable y lo que vuelve por los puertos neutrales, no el estado interno.
 */

// Valores con forma reconocible para buscarlos en cualquier salida. No son credenciales.
const USERNAME = 'agencia-demo';
const PASSWORD = 'Pa55w0rd-adapter';
const NATIONALITY = 'AR';
const T0 = Date.parse('2026-09-25T15:00:00.000Z');
const CTX = { tenantId: '00000000-0000-4000-8000-00000000000a' };
const SEARCH_ID = 'srch-00000000-0000-4000-8000-000000000001';
const FIXTURES = join(__dirname, '__fixtures__', 'pdf');

function config(overrides: Record<string, unknown> = {}): TboHotelsConfig {
  return parseTboConfig({
    environment: 'test',
    username: USERNAME,
    password: PASSWORD,
    ...overrides,
  });
}

function criteria(overrides: Partial<HotelSearchCriteria> = {}): HotelSearchCriteria {
  return {
    hotelIds: ['1120548'],
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [{ adults: 1, childrenAges: [] }],
    currency: 'USD',
    guestNationality: NATIONALITY,
    ...overrides,
  };
}

function codes(count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, i) => String(1_000_000 + from + i));
}

// ───────────────────────── Dobles ─────────────────────────

interface SearchBody {
  readonly HotelCodes: string;
  readonly IsDetailedResponse: boolean;
  readonly ResponseTime: number;
  readonly GuestNationality: string;
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: SearchBody;
}

type Responder = (call: FetchCall) => Response | Promise<Response>;

function spyFetch(responder: Responder): { fetch: TboFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: TboFetch = (url, init) => {
    const call = {
      url,
      init,
      body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') as SearchBody,
    };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Un `HotelResult` de un pack, con forma de p. 15. */
function hotel(code: string, extra: Record<string, unknown> = {}, currency = 'USD') {
  return {
    HotelCode: code,
    Currency: currency,
    Rooms: [
      {
        Name: ['Double Room'],
        BookingCode: `${code}!TB!1!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b`,
        TotalFare: '152.88',
        TotalTax: '28.12',
        MealType: 'Room_Only',
        IsRefundable: false,
        ...extra,
      },
    ],
  };
}

const OK_STATUS = { Code: 200, Description: 'Successful' };
const NO_AVAILABILITY = {
  Status: { Code: 201, Description: 'No Available rooms for given criteria' },
};

/** Responde con un hotel por cada código pedido: el eco que hace visible qué lote es cuál. */
const echo: Responder = (call) =>
  json({ Status: OK_STATUS, HotelResult: call.body.HotelCodes.split(',').map((c) => hotel(c)) });

/** Un `fetch` que nunca responde y rechaza cuando se dispara su señal, como el de verdad. */
function hanging(call: FetchCall): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (call.init.signal?.aborted === true) abort();
    else call.init.signal?.addEventListener('abort', abort);
  });
}

interface LogCall {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, calls };
}

interface CounterCall {
  readonly name: string;
  readonly value: number | undefined;
  readonly tags: Record<string, string> | undefined;
}

function spyMetrics(): { metrics: MetricsPort; counters: CounterCall[] } {
  const counters: CounterCall[] = [];
  const metrics: MetricsPort = {
    counter: (name, value, tags) => counters.push({ name, value, tags }),
    gauge: () => undefined,
    histogram: () => undefined,
  };
  return { metrics, counters };
}

/** El limitador real con cupos holgados: su comportamiento se prueba en `limiter.test.ts`. */
function roomyLimiter(): TboInMemoryRateLimiter {
  return new TboInMemoryRateLimiter({
    maxQps: 1_000,
    maxConcurrent: 100,
    background: { qps: 1_000, concurrent: 100 },
  });
}

interface Harness {
  readonly adapter: TboHotelsAdapter;
  readonly calls: FetchCall[];
  readonly logs: LogCall[];
  readonly counters: CounterCall[];
  /** Lo que el cliente pidió de espera a cada intento, en orden. */
  readonly timeouts: number[];
  readonly clock: { now: number };
}

function harness(
  responder: Responder = echo,
  options: TboHotelsAdapterOptions = {},
  deps: TboHttpDeps = {},
): Harness {
  const { fetch, calls } = spyFetch(responder);
  const { logger, calls: logs } = spyLogger();
  const { metrics, counters } = spyMetrics();
  const clock = { now: T0 };
  const timeouts: number[] = [];
  const adapter = new TboHotelsAdapter(
    config(),
    {
      fetch,
      logger,
      metrics,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      random: () => 0,
      uuid: () => SEARCH_ID,
      limiter: roomyLimiter(),
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return AbortSignal.timeout(ms);
      },
      ...deps,
    },
    { ownerTenantId: CTX.tenantId, credentialSource: 'inherited' },
    options,
  );
  return { adapter, calls, logs, counters, timeouts, clock };
}

const BATCHES: TboHotelsAdapterOptions = { searchBatching: { mode: 'batches' } };

function batchCodes(call: FetchCall): string[] {
  return call.body.HotelCodes.split(',');
}

// ───────────────────────── Tests ─────────────────────────

describe('los puertos neutrales', () => {
  it('implementa HotelSearchPort y HotelRatesDetailPort (el typecheck lo fija; esto, en runtime)', () => {
    const { adapter } = harness();
    const search: HotelSearchPort = adapter;
    const detail: HotelRatesDetailPort = adapter;
    expect(typeof search.searchAvailability).toBe('function');
    expect(typeof detail.getHotelRates).toBe('function');
  });
});

describe('construcción', () => {
  it('sin credenciales usables no hay adapter, y no sale ninguna llamada', () => {
    const { fetch, calls } = spyFetch(echo);
    const bare = parseTboConfig({ environment: 'test' });
    expect(() => new TboHotelsAdapter(bare, { fetch })).toThrow(TboCredentialsMissingError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [
      { searchBatching: { mode: 'batches', batchSize: 101 } },
      'options.searchBatching.batchSize:too_big',
    ],
    [
      { searchBatching: { mode: 'batches', maxHotelCodes: 301 } },
      'options.searchBatching.maxHotelCodes:too_big',
    ],
    [
      {
        searchBatching: {
          mode: 'batches',
          concurrency: TBO_SEARCH_BATCHING_LIMITS.maxConcurrency + 1,
        },
      },
      'options.searchBatching.concurrency:too_big',
    ],
    [
      { searchBatching: { mode: 'parallel' } },
      'options.searchBatching.mode:invalid_union_discriminator',
    ],
    [
      { searchBatching: { mode: 'single', batchSize: 50 } },
      'options.searchBatching:unrecognized_keys',
    ],
    [{ responseTimeSeconds: 25 }, 'options.responseTimeSeconds:too_big'],
    [{ responseTimeSeconds: 10.5 }, 'options.responseTimeSeconds:invalid_type'],
    [{ emptyChildrenAges: 'null' }, 'options.emptyChildrenAges:invalid_enum_value'],
    [{ searchConcurrency: 2 }, 'options:unrecognized_keys'],
  ])('opción inválida %j → TboConfigError con ruta:código', (options, issue) => {
    const build = () =>
      new TboHotelsAdapter(config(), {}, {}, options as unknown as TboHotelsAdapterOptions);
    expect(build).toThrow(TboConfigError);
    try {
      build();
    } catch (err) {
      expect((err as TboConfigError).issues).toContain(issue);
    }
  });

  it('un adapter volcado a un log no lleva la cuenta', () => {
    const { adapter } = harness();
    for (const dump of [JSON.stringify(adapter), inspect(adapter, { depth: 10 })]) {
      expect(dump).not.toContain(PASSWORD);
      expect(dump).not.toContain(USERNAME);
    }
    expect(adapter.accountRef).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('búsqueda por HotelSearchPort', () => {
  it('el ejemplo de p. 15: una llamada, ofertas válidas y cada tarifa dice de dónde es (RF-40)', async () => {
    const pdf = JSON.parse(
      readFileSync(join(FIXTURES, 'search-single-room.p15.json'), 'utf8'),
    ) as unknown;
    const { adapter, calls } = harness(() => json(pdf));

    const report = await adapter.searchAvailabilityReport(criteria(), CTX);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TBO_BASE_URLS.test}${TBO_OPERATIONS.search.path}`);
    expect(calls[0]?.body).toMatchObject({
      HotelCodes: '1120548',
      GuestNationality: NATIONALITY,
      IsDetailedResponse: false,
      ResponseTime: 10,
    });
    expect(report.offers).toHaveLength(1);
    for (const offer of report.offers) expect(HotelOfferSchema.safeParse(offer).success).toBe(true);
    const packs = report.offers.flatMap((offer) => offer.roompacks);
    expect(packs).toHaveLength(2);
    for (const pack of packs) {
      expect(pack.provider).toEqual({
        name: 'tbo-hotels',
        offerRef: pack.id,
        raw: { searchId: SEARCH_ID },
      });
      expect(pack.expiresAt).toBe(new Date(T0 + TBO_OFFER_TTL_MS).toISOString());
    }
    expect(report).toMatchObject({
      searchId: SEARCH_ID,
      searchSentAt: T0,
      accountRef: adapter.accountRef,
      partial: false,
      omittedHotelCodes: 0,
    });
    // El literal de TotalFare vuelve para el contexto del servidor (RF-08), no en el pack.
    expect(report.packs).toEqual(
      packs.map((pack) => ({
        hotelCode: '1120548',
        bookingCode: pack.id,
        totalFare: '152.88',
        currency: 'USD',
      })),
    );
    expect(report.batches).toEqual([
      expect.objectContaining({ index: 0, hotelCodeCount: 1, status: 'ok' }),
    ]);
  });

  it('searchAvailability devuelve sólo las ofertas del reporte', async () => {
    const { adapter } = harness();
    const offers = await adapter.searchAvailability(criteria({ hotelIds: ['11', '22'] }), CTX);
    expect(offers.map((offer) => offer.hotelId)).toEqual(['11', '22']);
  });

  it('201 → lista vacía, lote "empty" y nada parcial: sin disponibilidad no es un error', async () => {
    const { adapter } = harness(() => json(NO_AVAILABILITY));
    const report = await adapter.searchAvailabilityReport(criteria(), CTX);
    expect(report.offers).toEqual([]);
    expect(report.partial).toBe(false);
    expect(report.batches.map((b) => b.status)).toEqual(['empty']);
    expect(await adapter.searchAvailability(criteria(), CTX)).toEqual([]);
  });

  it('un criterio que TBO no admite no manda NINGÚN lote, ni siquiera los válidos', async () => {
    const { adapter, calls } = harness(echo, BATCHES);
    await expect(
      adapter.searchAvailability(criteria({ guestNationality: undefined }), CTX),
    ).rejects.toMatchObject({ name: 'TboRequestBuildError', reason: 'NOT_ELIGIBLE' });
    // El código roto está en el segundo lote: el primero tampoco sale.
    const hotelIds = [...codes(100), 'bad,code'];
    await expect(adapter.searchAvailability(criteria({ hotelIds }), CTX)).rejects.toBeInstanceOf(
      TboRequestBuildError,
    );
    await expect(adapter.searchAvailability(criteria({ hotelIds: [] }), CTX)).rejects.toMatchObject(
      {
        reason: 'SCHEMA',
        issues: ['hotelIds:too_small'],
      },
    );
    expect(calls).toHaveLength(0);
  });
});

describe('D-TBO-17: códigos por llamada y lotes', () => {
  it('A (por defecto): 101 códigos → UNA llamada con los 100 primeros y el resto informado', async () => {
    const { adapter, calls, logs, counters } = harness();
    const hotelIds = codes(101);
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds }), CTX);

    expect(calls).toHaveLength(1);
    expect(batchCodes(calls[0]!)).toEqual(hotelIds.slice(0, 100));
    expect(report.omittedHotelCodes).toBe(1);
    expect(report.offers).toHaveLength(100);
    expect(counters).toContainEqual({
      name: 'tbo.search.codes_omitted',
      value: 1,
      tags: { op: 'search' },
    });
    const omitted = logs.find((log) => log.message === 'tbo.search.codes_omitted');
    expect(omitted?.level).toBe('warn');
    expect(omitted?.meta).toMatchObject({ omittedHotelCodeCount: 1, hotelCodeCount: 101 });
  });

  it('A: 100 códigos son una sola llamada y no se omite nada', async () => {
    const { adapter, calls } = harness();
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds: codes(100) }), CTX);
    expect(calls).toHaveLength(1);
    expect(report.omittedHotelCodes).toBe(0);
  });

  it('B: 101 códigos → dos lotes (100 + 1), en orden de relevancia', async () => {
    const { adapter, calls } = harness(echo, BATCHES);
    const hotelIds = codes(101);
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds }), CTX);

    expect(calls.map(batchCodes)).toEqual([hotelIds.slice(0, 100), hotelIds.slice(100)]);
    expect(report.batches.map((b) => [b.index, b.hotelCodeCount, b.status])).toEqual([
      [0, 100, 'ok'],
      [1, 1, 'ok'],
    ]);
    expect(report.offers.map((offer) => offer.hotelId)).toEqual(hotelIds);
    expect(report.partial).toBe(false);
    expect(report.omittedHotelCodes).toBe(0);
    expect(report.diagnostics).toMatchObject({ hotelsReceived: 101, packsMapped: 101 });
    // Una búsqueda, un `searchId`, aunque haya dos lotes.
    const ids = new Set(
      report.offers.flatMap((o) => o.roompacks.map((p) => p.provider.raw?.['searchId'])),
    );
    expect([...ids]).toEqual([SEARCH_ID]);
  });

  it('B: se deduplica ANTES de partir, para no pedir un hotel dos veces', async () => {
    const { adapter, calls } = harness(echo, {
      searchBatching: { mode: 'batches', batchSize: 2 },
    });
    await adapter.searchAvailability(criteria({ hotelIds: ['1', '2', '1', '3', '2'] }), CTX);
    expect(calls.map(batchCodes)).toEqual([['1', '2'], ['3']]);
  });

  it('B: el tope es de 300 códigos; lo que sobra se informa', async () => {
    const { adapter, calls } = harness(echo, BATCHES);
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds: codes(301) }), CTX);
    expect(calls.map((call) => batchCodes(call).length)).toEqual([100, 100, 100]);
    expect(report.omittedHotelCodes).toBe(1);
  });

  it.each([1, 2])('B: nunca hay más de %i lotes en vuelo', async (concurrency) => {
    let inFlight = 0;
    let peak = 0;
    const { adapter, calls } = harness(
      async (call) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return echo(call);
      },
      { searchBatching: { mode: 'batches', batchSize: 1, concurrency } },
    );
    const report = await adapter.searchAvailabilityReport(
      criteria({ hotelIds: ['1', '2', '3'] }),
      CTX,
    );
    expect(calls).toHaveLength(3);
    expect(peak).toBe(concurrency);
    // El orden del resultado es el de relevancia, no el de llegada.
    expect(report.offers.map((offer) => offer.hotelId)).toEqual(['1', '2', '3']);
  });

  it('B: el orden es el de relevancia aunque un lote posterior responda antes', async () => {
    const { adapter } = harness(
      async (call) => {
        // El primer lote es el lento: por orden de llegada saldría último.
        const delay = batchCodes(call).includes('1') ? 30 : 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return echo(call);
      },
      { searchBatching: { mode: 'batches', batchSize: 1, concurrency: 2 } },
    );
    const report = await adapter.searchAvailabilityReport(
      criteria({ hotelIds: ['1', '2', '3'] }),
      CTX,
    );
    expect(report.offers.map((offer) => offer.hotelId)).toEqual(['1', '2', '3']);
    expect(report.packs.map((pack) => pack.hotelCode)).toEqual(['1', '2', '3']);
    expect(report.batches.map((b) => b.index)).toEqual([0, 1, 2]);
  });

  it('cada lote lleva el requestId de SU llamada, distinto del searchId', async () => {
    let issued = 0;
    const { adapter } = harness(
      (call) =>
        batchCodes(call).includes('2')
          ? json({ Status: { Code: 500, Description: 'x' } })
          : echo(call),
      { searchBatching: { mode: 'batches', batchSize: 1 } },
      { uuid: () => `id-${++issued}` },
    );
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds: ['1', '2'] }), CTX);
    const [ok, failed] = report.batches;
    expect(ok?.requestId).toMatch(/^id-\d+$/);
    expect(ok?.requestId).not.toBe(report.searchId);
    expect(failed?.requestId).toBe((failed?.error as TboApiError).requestId);
    expect(failed?.requestId).not.toBe(report.searchId);
    expect(failed?.requestId).not.toBe(ok?.requestId);
  });
});

describe('lote fallido → resultado parcial con motivo (RF-14 CA-3; RNF-13)', () => {
  it('un lote con error deja el resultado parcial, con el error tipado del lote', async () => {
    const { adapter, calls, logs, counters } = harness(
      (call) => {
        if (batchCodes(call).includes('3'))
          return json({ Status: { Code: 500, Description: 'x' } });
        return echo(call);
      },
      { searchBatching: { mode: 'batches', batchSize: 2 } },
    );

    const report = await adapter.searchAvailabilityReport(
      criteria({ hotelIds: ['1', '2', '3'] }),
      CTX,
    );

    expect(report.partial).toBe(true);
    expect(report.offers.map((offer) => offer.hotelId)).toEqual(['1', '2']);
    const failed = report.batches[1];
    expect(failed).toMatchObject({ index: 1, hotelCodeCount: 1, status: 'failed' });
    expect(failed?.error).toBeInstanceOf(TboApiError);
    expect(failed?.error).toMatchObject({ kind: 'UPSTREAM', tboCode: 500 });
    expect(failed?.requestId).toBe((failed?.error as TboApiError).requestId);
    // El adapter no reintenta: las llamadas de más son las del cliente, dentro de su tabla.
    const toFailed = calls.filter((call) => batchCodes(call).includes('3'));
    expect(toFailed.length).toBeLessThanOrEqual(TBO_OPERATIONS.search.maxAttempts);
    expect(counters).toContainEqual({
      name: 'tbo.search.partial',
      value: 1,
      tags: { op: 'search', detailed: 'false' },
    });
    const partial = logs.find((log) => log.message === 'tbo.search.partial');
    expect(partial?.level).toBe('warn');
    expect(partial?.meta).toMatchObject({
      searchId: SEARCH_ID,
      batchCount: 2,
      failedBatchCount: 1,
      issues: ['1:UPSTREAM'],
    });
  });

  it('un lote sin cupo en el limitador queda "not-dispatched" y el resto responde', async () => {
    const real = roomyLimiter();
    let acquired = 0;
    const limiter: TboRateLimiter = {
      acquire: (request) => {
        acquired += 1;
        return acquired === 2
          ? Promise.resolve({ granted: false, reason: 'QUEUE_TIMEOUT' })
          : real.acquire(request);
      },
      reportThrottled: (accountRef) => real.reportThrottled(accountRef),
    };
    const { adapter, calls } = harness(
      echo,
      { searchBatching: { mode: 'batches', batchSize: 1 } },
      {
        limiter,
      },
    );
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds: ['1', '2'] }), CTX);

    expect(calls.map(batchCodes)).toEqual([['1']]);
    expect(report.partial).toBe(true);
    expect(report.batches[1]).toMatchObject({ status: 'not-dispatched' });
    expect(report.batches[1]?.error).toMatchObject({
      name: 'TboDispatchRejectedError',
      reason: 'QUEUE_TIMEOUT',
    });
  });

  it('si no responde ningún lote, TBO falla entero con el error del primero', async () => {
    const { adapter } = harness(
      (call) =>
        json({ Status: { Code: batchCodes(call).includes('1') ? 400 : 401, Description: 'x' } }),
      { searchBatching: { mode: 'batches', batchSize: 1 } },
    );
    const error = await adapter.searchAvailability(criteria({ hotelIds: ['1', '2'] }), CTX).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TboApiError);
    expect(error).toMatchObject({ kind: 'CLIENT_BUG', tboCode: 400 });
  });

  it('lo que no es un error de TBO es un bug nuestro: se propaga, no queda como lote fallido', async () => {
    const real = roomyLimiter();
    let acquired = 0;
    const limiter: TboRateLimiter = {
      acquire: (request) => {
        acquired += 1;
        return acquired === 2
          ? Promise.reject(new TypeError('limitador roto'))
          : real.acquire(request);
      },
      reportThrottled: (accountRef) => real.reportThrottled(accountRef),
    };
    const { adapter } = harness(
      echo,
      { searchBatching: { mode: 'batches', batchSize: 1 } },
      {
        limiter,
      },
    );
    await expect(
      adapter.searchAvailabilityReport(criteria({ hotelIds: ['1', '2'] }), CTX),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('con un solo lote, su error es el de la búsqueda', async () => {
    const { adapter, calls } = harness(() => json({ Status: { Code: 401, Description: 'x' } }));
    await expect(adapter.searchAvailability(criteria(), CTX)).rejects.toMatchObject({
      name: 'TboApiError',
      kind: 'CREDENTIALS_INVALID',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('un único deadline y timeout sin reintento', () => {
  it('el primer lote espera ResponseTime + 3 s: 13 s por defecto y 23 s con 20 s', async () => {
    const byDefault = harness();
    await byDefault.adapter.searchAvailability(criteria(), CTX);
    expect(byDefault.timeouts).toEqual([13_000]);

    const slow = harness(echo, { responseTimeSeconds: 20 });
    await slow.adapter.searchAvailability(criteria(), CTX);
    expect(slow.calls[0]?.body.ResponseTime).toBe(20);
    expect(slow.timeouts).toEqual([23_000]);
  });

  it('un timeout hace UNA llamada: ni el cliente ni el adapter la repiten', async () => {
    const { adapter, calls } = harness(
      hanging,
      {},
      {
        timeoutSignal: () => AbortSignal.abort(new DOMException('t', 'TimeoutError')),
      },
    );
    await expect(adapter.searchAvailability(criteria(), CTX)).rejects.toMatchObject({
      name: 'TboApiError',
      kind: 'TRANSPORT',
      status: 0,
      timedOut: true,
    });
    expect(calls).toHaveLength(1);
  });

  it('un lote que agota su plazo deja el resultado parcial y no se repite', async () => {
    const { adapter, calls } = harness(
      (call) => (batchCodes(call).includes('2') ? hanging(call) : echo(call)),
      { searchBatching: { mode: 'batches', batchSize: 1, concurrency: 2 } },
      { timeoutSignal: (ms) => AbortSignal.timeout(Math.min(ms, 20)) },
    );
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds: ['1', '2'] }), CTX);
    expect(calls).toHaveLength(2);
    expect(report.partial).toBe(true);
    expect(report.offers.map((offer) => offer.hotelId)).toEqual(['1']);
    expect(report.batches[1]?.error).toMatchObject({ kind: 'TRANSPORT', timedOut: true });
  });

  it('el lote que sale tarde pide un ResponseTime que quepa en lo que queda del deadline', async () => {
    const h = harness(
      (call) => {
        // El primer lote consume 5 s del reloj: al segundo le quedan 8 s de los 13.
        if (batchCodes(call).includes('1')) h.clock.now += 5_000;
        return echo(call);
      },
      { searchBatching: { mode: 'batches', batchSize: 1 } },
    );
    const report = await h.adapter.searchAvailabilityReport(
      criteria({ hotelIds: ['1', '2'] }),
      CTX,
    );
    expect(h.calls.map((call) => call.body.ResponseTime)).toEqual([10, 5]);
    expect(h.timeouts).toEqual([13_000, 8_000]);
    expect(report.partial).toBe(false);
    // El vencimiento se cuenta desde que entró la búsqueda, también para el lote que salió tarde.
    expect(report.searchSentAt).toBe(T0);
    const packs = report.offers.flatMap((offer) => offer.roompacks);
    expect(packs).toHaveLength(2);
    for (const pack of packs) {
      expect(pack.expiresAt).toBe(new Date(T0 + TBO_OFFER_TTL_MS).toISOString());
    }
  });

  it('con ResponseTime 5 el primer lote sale aunque el reloj avance mientras se arma', async () => {
    // Un reloj real avanza entre fijar el deadline y despachar: con 5 s el plazo entero es el
    // mínimo, y un milisegundo de más no puede dejar a TBO fuera de TODAS las búsquedas.
    const clock = { now: T0 };
    const h = harness(echo, { responseTimeSeconds: 5 }, { now: () => (clock.now += 1) });
    const report = await h.adapter.searchAvailabilityReport(criteria(), CTX);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.body.ResponseTime).toBe(5);
    expect(report.partial).toBe(false);
    expect(report.batches.map((b) => b.status)).toEqual(['ok']);
  });

  it('el lote al que ya no le alcanza el deadline no sale, y lo dice (DEADLINE)', async () => {
    const h = harness(
      (call) => {
        h.clock.now += 6_000;
        return echo(call);
      },
      { searchBatching: { mode: 'batches', batchSize: 1 } },
    );
    const report = await h.adapter.searchAvailabilityReport(
      criteria({ hotelIds: ['1', '2'] }),
      CTX,
    );
    expect(h.calls).toHaveLength(1);
    expect(report.partial).toBe(true);
    expect(report.batches[1]).toMatchObject({ status: 'not-dispatched', durationMs: 0 });
    const error = report.batches[1]?.error;
    expect(error).toBeInstanceOf(TboDispatchRejectedError);
    expect(error).toMatchObject({ reason: 'DEADLINE', waitedMs: 6_000 });
  });
});

describe('moneda sin dos decimales (D-TBO-15 A; RF-07 CA-4)', () => {
  it('si todo vino en KWD, TBO queda no disponible para la cuenta con motivo, no "sin hoteles"', async () => {
    const { adapter, counters } = harness((call) =>
      json({
        Status: OK_STATUS,
        HotelResult: batchCodes(call).map((code) => hotel(code, {}, 'KWD')),
      }),
    );
    const error = await adapter.searchAvailability(criteria(), CTX).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TboUnsupportedCurrencyError);
    expect((error as TboUnsupportedCurrencyError).currencies).toEqual(['KWD']);
    expect(counters.map((c) => c.name)).toContain('tbo.search.unsupported_currency');
  });

  it('si además hay tarifas legibles, se devuelven y la moneda queda en los diagnósticos', async () => {
    const { adapter } = harness(() =>
      json({ Status: OK_STATUS, HotelResult: [hotel('1'), hotel('2', {}, 'KWD')] }),
    );
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds: ['1', '2'] }), CTX);
    expect(report.offers.map((offer) => offer.hotelId)).toEqual(['1']);
    expect(report.diagnostics.unsupportedCurrencies).toEqual(['KWD']);
  });
});

describe('detalle de un hotel por HotelRatesDetailPort (D-TBO-19 A)', () => {
  function query(overrides: Partial<HotelRatesQuery> = {}): HotelRatesQuery {
    return {
      hotelId: '1120548',
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      rooms: [{ adults: 1, childrenAges: [] }],
      currency: 'USD',
      guestNationality: NATIONALITY,
      ...overrides,
    };
  }

  const detailed = hotel('1120548', {
    IsRefundable: true,
    DayRates: [[{ BasePrice: '76.44' }, { BasePrice: '76.44' }]],
    CancelPolicies: [
      { FromDate: '01-11-2026 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0.0 },
      { FromDate: '08-11-2026 00:00:00', ChargeType: 'Percentage', CancellationCharge: 100.0 },
    ],
  });

  it('manda UN solo código con IsDetailedResponse: true, aunque haya lotes configurados', async () => {
    const { adapter, calls } = harness(
      () => json({ Status: OK_STATUS, HotelResult: [detailed] }),
      BATCHES,
    );
    const offer = await adapter.getHotelRates(query({ roompackId: 'del-listado' }), CTX);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ HotelCodes: '1120548', IsDetailedResponse: true });
    expect(HotelOfferSchema.safeParse(offer).success).toBe(true);
    const [pack] = offer.roompacks;
    expect(pack?.provider.name).toBe('tbo-hotels');
    // Políticas y precio por noche "sujetos a confirmación" hasta el PreBook.
    expect(pack?.cancellation.policySource).toBe('search-indicative');
    expect(pack?.price.nightly).toEqual([
      [
        { amountMinor: 7644, currency: 'USD' },
        { amountMinor: 7644, currency: 'USD' },
      ],
    ]);
  });

  it('el reporte trae el contexto del pack del DETALLE, que es el que se reserva', async () => {
    const { adapter } = harness(() => json({ Status: OK_STATUS, HotelResult: [detailed] }));
    const report = await adapter.getHotelRatesReport(query(), CTX);
    expect(report).toMatchObject({ searchId: SEARCH_ID, searchSentAt: T0, partial: false });
    expect(report.packs).toEqual([
      {
        hotelCode: '1120548',
        bookingCode: report.offer.roompacks[0]?.id,
        totalFare: '152.88',
        currency: 'USD',
      },
    ]);
  });

  it('201 → la oferta del hotel sin tarifas', async () => {
    const { adapter } = harness(() => json(NO_AVAILABILITY));
    expect(await adapter.getHotelRates(query(), CTX)).toEqual({
      hotelId: '1120548',
      roompacks: [],
    });
  });

  it('un hotel que no se pidió no se cuela en el detalle', async () => {
    const { adapter, counters } = harness(() =>
      json({ Status: OK_STATUS, HotelResult: [hotel('999'), detailed] }),
    );
    const report = await adapter.getHotelRatesReport(query(), CTX);
    expect(report.offer.hotelId).toBe('1120548');
    expect(report.packs.map((pack) => pack.hotelCode)).toEqual(['1120548']);
    expect(counters).toContainEqual({
      name: 'tbo.search.detail_foreign_hotel',
      value: 1,
      tags: { op: 'search' },
    });
  });

  it('un error del detalle es el error del Search, sin reintentos propios', async () => {
    const { adapter, calls } = harness(() => json({ Status: { Code: 400, Description: 'x' } }));
    await expect(adapter.getHotelRates(query(), CTX)).rejects.toMatchObject({ kind: 'CLIENT_BUG' });
    expect(calls).toHaveLength(1);
  });
});

describe('lo que llega al log', () => {
  it('ni la cuenta, ni la nacionalidad, ni los códigos de hotel', async () => {
    const { adapter, logs } = harness(
      (call) =>
        batchCodes(call).includes('1000003')
          ? json({ Status: { Code: 500, Description: 'x' } })
          : echo(call),
      { searchBatching: { mode: 'batches', batchSize: 2 } },
    );
    await adapter.searchAvailabilityReport(criteria({ hotelIds: codes(103) }), CTX);
    expect(logs.some((log) => log.message === 'tbo.search.partial')).toBe(true);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(USERNAME);
    expect(dump).not.toContain('GuestNationality');
    expect(dump).not.toContain(`"${NATIONALITY}"`);
    expect(dump).not.toContain('1000003');
  });

  it('un logger y unas métricas que lanzan no le quitan tarifas a nadie', async () => {
    const boom = (): never => {
      throw new Error('observabilidad rota');
    };
    const logger: LoggerPort = { debug: boom, info: boom, warn: boom, error: boom, child: boom };
    const metrics: MetricsPort = { counter: boom, gauge: boom, histogram: boom };
    const { adapter } = harness(echo, {}, { logger, metrics });
    const report = await adapter.searchAvailabilityReport(criteria({ hotelIds: codes(101) }), CTX);
    expect(report.offers).toHaveLength(100);
    expect(report.omittedHotelCodes).toBe(1);
  });
});
