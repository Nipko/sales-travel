import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type {
  HotelBookPort,
  HotelBookRequest,
  HotelBookingByClientReferencePort,
  HotelBookingReadPort,
} from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { classifyTboBookOutcome } from './booking/classify-book-outcome';
import { parseTboConfig } from './config';
import {
  TboApiError,
  TboOfferExpiredError,
  TboRequestBuildError,
  TboResponseMappingError,
} from './errors';
import { TboInMemoryRateLimiter, type TboLimiterRequest } from './http/limiter';
import type { TboFetch, TboHttpDeps } from './http/tbo-http.client';
import { TBO_OFFER_TTL_MS } from './search/offer-window';
import { TboHotelsAdapter, type TboBookQuery } from './tbo-hotels.adapter';

/**
 * Book y BookingDetail por la puerta pública del adapter, con `fetch` espiado, reloj falso y un
 * limitador que anota el cupo de cada llamada (docs/tbo/09 PR-4.2; 08 RF-09, RF-18 a RF-21, RF-24;
 * BK-07).
 */

const CTX = { tenantId: '00000000-0000-4000-8000-00000000000a' };
const SEARCH_SENT_AT = Date.parse('2026-09-25T15:00:00.000Z');
const MINUTE = 60_000;
const REFERENCE = 'STT7K2M9QX4D8R1VZ6AB';
const BOOKING_CODE = '1120548!TB!4!TB!8bd7a82e-439a-4b2d-869d-09de4456e482';
const FIXTURES = join(__dirname, '__fixtures__', 'pdf');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

const BOOK_812 = fixture('book-request-limit-multi-room.p35.json');
const RESPONSE_821 = fixture('book-response.p41.json');
const DETAIL_1021 = fixture('booking-detail.p49.json');
const DETAIL_REQUESTS = fixture('booking-detail-request.p44.json');

/** 8.2.1 con NUESTRA referencia: lo que TBO devolvería al Book que mandamos. */
const CONFIRMED = { ...RESPONSE_821, ClientReferenceId: REFERENCE };

const TWO_ROOMS: HotelRoomOccupancy[] = [
  { adults: 1, childrenAges: [] },
  { adults: 1, childrenAges: [] },
];

/** Datos personales de la entrada y la credencial de la cuenta: nada de esto puede aparecer en un log. */
const PII =
  /TestGuest|reservas@agencia|573001234567|3001234567|Shubham|Gupta|Kunal|Agrawal|Pa55w0rd|agencia-demo/;

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
  readonly lanes: TboLimiterRequest['lane'][];
  readonly timeouts: number[];
  readonly clock: { now: number };
}

function harness(
  responder: Responder = () => json(CONFIRMED),
  deps: TboHttpDeps = {},
  environment: 'test' | 'live' = 'test',
): Harness {
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
  const lanes: Harness['lanes'] = [];
  const inner = new TboInMemoryRateLimiter({
    maxQps: 1_000,
    maxConcurrent: 100,
    background: { qps: 1_000, concurrent: 100 },
  });
  const timeouts: number[] = [];
  const clock = { now: SEARCH_SENT_AT + 10 * MINUTE };
  const adapter = new TboHotelsAdapter(
    parseTboConfig({
      environment,
      ...(environment === 'live' ? { baseUrl: 'https://live.tbo.example/HotelAPI' } : {}),
      username: 'agencia-demo',
      password: 'Pa55w0rd-bk',
    }),
    {
      fetch,
      logger,
      metrics,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      random: () => 0,
      limiter: {
        acquire: (request) => {
          lanes.push(request.lane);
          return inner.acquire(request);
        },
        reportThrottled: (accountRef) => inner.reportThrottled(accountRef),
      },
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return AbortSignal.timeout(ms);
      },
      ...deps,
    },
    { ownerTenantId: CTX.tenantId, credentialSource: 'inherited' },
  );
  return { adapter, calls, logs, counters, lanes, timeouts, clock };
}

function query(overrides: Partial<TboBookQuery> = {}): TboBookQuery {
  return {
    bookingCode: BOOKING_CODE,
    totalFare: '360.13',
    bookingReferenceId: REFERENCE,
    searchSentAt: SEARCH_SENT_AT,
    occupancy: TWO_ROOMS,
    rooms: [
      { guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'TestGuest', lastName: 'One' }] },
      { guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'TestGuest', lastName: 'second' }] },
    ],
    contact: {
      email: 'reservas@agencia.example',
      phone: { countryCode: '+57', number: '300 123 4567' },
    },
    ...overrides,
  };
}

function portRequest(overrides: Partial<HotelBookRequest> = {}): HotelBookRequest {
  const q = query();
  return {
    offer: { name: 'tbo-hotels', offerRef: BOOKING_CODE, raw: { searchId: 'srch-1' } },
    bookingReference: REFERENCE,
    rooms: [...q.rooms],
    contact: q.contact,
    payment: { kind: 'agency-credit' },
    providerOptions: {
      totalFare: '360.13',
      searchSentAt: new Date(SEARCH_SENT_AT).toISOString(),
      rooms: TWO_ROOMS,
    },
    ...overrides,
  };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('no lanzó');
}

// ───────────────────────── Book ─────────────────────────

describe('Book: camino feliz', () => {
  it('manda el cuerpo de 8.1.2 con nuestras referencias y devuelve CONFIRMED', async () => {
    const h = harness();
    const report = await h.adapter.bookReport(query(), CTX);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe('http://api.tbotechnology.in/TBOHolidays_HotelAPI/Book');
    expect(h.calls[0]?.init.method).toBe('POST');
    const sent = JSON.parse(h.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({
      ...BOOK_812,
      ClientReferenceId: REFERENCE,
      BookingReferenceId: REFERENCE,
      PaymentMode: 'Limit',
    });

    expect(report.result).toEqual({
      outcome: 'CONFIRMED',
      providerBookingId: 'FL1IMA',
      bookingReference: REFERENCE,
      providerStatus: '200',
      warnings: [],
    });
    expect(report.classification).toMatchObject({ outcome: 'CONFIRMED', reason: 'confirmed' });
    expect(report).toMatchObject({
      bookingReferenceId: REFERENCE,
      attempts: 1,
      accountRef: h.adapter.accountRef,
    });
    expect(report.requestId).toEqual(expect.any(String));
  });

  it('sale por el cupo de dinero y con el timeout de 120 s (p. 8)', async () => {
    const h = harness();
    await h.adapter.bookReport(query(), CTX);
    expect(h.lanes).toEqual(['money']);
    expect(h.timeouts).toEqual([120_000]);
  });

  it('por el puerto neutral', async () => {
    const h = harness();
    const port: HotelBookPort = h.adapter;
    await expect(port.book(portRequest(), CTX)).resolves.toMatchObject({
      outcome: 'CONFIRMED',
      providerBookingId: 'FL1IMA',
    });
    expect(JSON.parse(h.calls[0]?.body ?? '{}')).toMatchObject({ TotalFare: 360.13 });
  });

  it('una línea de log con referencias y desenlace, sin datos personales', async () => {
    const h = harness();
    await h.adapter.bookReport(query(), CTX);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'tbo.book.outcome',
        meta: expect.objectContaining({
          bookingReferenceId: REFERENCE,
          confirmationNumber: 'FL1IMA',
          outcome: 'CONFIRMED',
          reason: 'confirmed',
        }) as unknown,
      }),
    );
    expect(JSON.stringify(h.logs)).not.toMatch(PII);
  });
});

describe('Book: 200 sin prueba de reserva → UNCERTAIN (RF-03 CA-2)', () => {
  it('sin ConfirmationNumber', async () => {
    const h = harness(() => json({ Status: { Code: 200 }, ClientReferenceId: REFERENCE }));
    const report = await h.adapter.bookReport(query(), CTX);
    expect(report.result).toEqual({
      outcome: 'UNCERTAIN',
      bookingReference: REFERENCE,
      providerStatus: '200',
      warnings: ['missing-confirmation-number'],
    });
    expect(report.classification.verifyByReference).toBe(true);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'tbo.book.outcome' }),
    );
  });

  it('con otro ClientReferenceId (8.2.1 tal cual): el localizador no se adopta', async () => {
    const h = harness(() => json(RESPONSE_821));
    const report = await h.adapter.bookReport(query(), CTX);
    expect(report.result.outcome).toBe('UNCERTAIN');
    expect(report.result.providerBookingId).toBeUndefined();
    expect(report.reply).toEqual({
      confirmationNumber: 'FL1IMA',
      clientReferenceId: '1625733337375-78767296',
    });
  });
});

describe('Book: cero reintentos (BK-07; money-paths)', () => {
  it.each([
    ['405 en el cuerpo', () => status(405), 'UNCERTAIN', 'booking-failed'],
    ['500 en el cuerpo', () => status(500), 'UNCERTAIN', 'provider-error'],
    ['429 en el cuerpo', () => status(429), 'UNCERTAIN', 'throttled'],
    ['HTTP 503 HTML', () => new Response('<html>', { status: 503 }), 'UNCERTAIN', 'http-error'],
    ['2xx no JSON', () => new Response('ok', { status: 200 }), 'UNCERTAIN', 'malformed-response'],
    ['red', () => Promise.reject(new TypeError('fetch failed')), 'UNCERTAIN', 'transport'],
    ['207 en el cuerpo', () => status(207), 'FAILED', 'rate-unavailable'],
    ['300 en el cuerpo', () => status(300), 'FAILED', 'insufficient-balance'],
  ] as const)(
    '%s: una sola llamada, lanza, y la saga lo clasifica',
    async (_name, respond, outcome, reason) => {
      const h = harness(respond);
      const error = await rejection(() => h.adapter.bookReport(query(), CTX));
      expect(error).toBeInstanceOf(TboApiError);
      expect(h.calls).toHaveLength(1);
      expect(
        classifyTboBookOutcome({ kind: 'threw', error }, { clientReferenceId: REFERENCE }),
      ).toMatchObject({ outcome, reason });
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          message: 'tbo.book.outcome',
          meta: expect.objectContaining({
            outcome,
            reason,
            bookingReferenceId: REFERENCE,
          }) as unknown,
        }),
      );
    },
  );

  it('timeout: una llamada, incierto, y el log lo dice como error', async () => {
    const h = harness(hanging, { timeoutSignal: () => AbortSignal.timeout(5) });
    const error = await rejection(() => h.adapter.bookReport(query(), CTX));
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).timedOut).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'tbo.book.outcome',
        meta: expect.objectContaining({ reason: 'timeout' }) as unknown,
      }),
    );
  });

  it('un 200 ilegible: lanza error de mapeo, incierto', async () => {
    const h = harness(() => json({ Status: { Code: 200 }, ConfirmationNumber: { x: 1 } }));
    const error = await rejection(() => h.adapter.bookReport(query(), CTX));
    expect(error).toBeInstanceOf(TboResponseMappingError);
    expect(
      classifyTboBookOutcome({ kind: 'threw', error }, { clientReferenceId: REFERENCE }).reason,
    ).toBe('unreadable-response');
    expect(h.calls).toHaveLength(1);
  });
});

describe('Book: nada sale si no se puede mandar bien', () => {
  it('pasado searchSentAt + 27 min: TboOfferExpiredError sin tocar TBO (RF-09)', async () => {
    const h = harness();
    h.clock.now = SEARCH_SENT_AT + TBO_OFFER_TTL_MS;
    await expect(h.adapter.bookReport(query(), CTX)).rejects.toBeInstanceOf(TboOfferExpiredError);
    expect(h.calls).toHaveLength(0);
    h.clock.now = SEARCH_SENT_AT + TBO_OFFER_TTL_MS - 1;
    await h.adapter.bookReport(query(), CTX);
    expect(h.calls).toHaveLength(1);
  });

  it('un searchSentAt en el futuro estiraría la ventana: se rechaza', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.bookReport(query({ searchSentAt: h.clock.now + MINUTE }), CTX),
    );
    expect((error as TboRequestBuildError).issues).toEqual(['query.searchSentAt:in_the_future']);
    expect(h.calls).toHaveLength(0);
  });

  it('una referencia de producción no sale por la cuenta de test', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.bookReport(query({ bookingReferenceId: 'STP7K2M9QX4D8R1VZ6AB' }), CTX),
    );
    expect((error as TboRequestBuildError).issues).toEqual([
      'bookingReferenceId:environment_mismatch',
    ]);
    expect(h.calls).toHaveLength(0);
  });

  it('y una de test no sale por la de producción', async () => {
    const h = harness(undefined, {}, 'live');
    await expect(h.adapter.bookReport(query(), CTX)).rejects.toBeInstanceOf(TboRequestBuildError);
    expect(h.calls).toHaveLength(0);
  });

  it('huéspedes que no cuadran con la ocupación', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.bookReport(query({ occupancy: [{ adults: 2, childrenAges: [] }] }), CTX),
    );
    expect((error as TboRequestBuildError).issues).toContain('rooms:count_mismatch');
    expect(h.calls).toHaveLength(0);
  });

  it('un TotalFare que no se puede mandar exacto', async () => {
    const h = harness();
    await expect(
      h.adapter.bookReport(query({ totalFare: '12345678.123456789' }), CTX),
    ).rejects.toBeInstanceOf(TboRequestBuildError);
    expect(h.calls).toHaveLength(0);
  });

  it('por el puerto: un token de checkout alojado no se carga al crédito de la cuenta', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.book(
        portRequest({
          payment: { kind: 'hosted-token', optionType: 'CARD', units: [] },
        }),
        CTX,
      ),
    );
    expect(error).toBeInstanceOf(TboRequestBuildError);
    expect((error as TboRequestBuildError).reason).toBe('PAYMENT_MODE');
    expect(h.calls).toHaveLength(0);
  });

  it('por el puerto: una oferta de otro proveedor o sin opciones de TBO', async () => {
    const h = harness();
    const other = await rejection(() =>
      h.adapter.book(
        portRequest({ offer: { name: 'despegar-hotels', offerRef: BOOKING_CODE } }),
        CTX,
      ),
    );
    expect((other as TboRequestBuildError).issues).toContain('offer.name:not_tbo_hotels');
    const bare = await rejection(() => h.adapter.book(portRequest({ providerOptions: {} }), CTX));
    expect((bare as TboRequestBuildError).issues).toEqual(
      expect.arrayContaining(['providerOptions.totalFare:invalid_type']),
    );
    expect(h.calls).toHaveLength(0);
  });
});

// ───────────────────────── BookingDetail ─────────────────────────

describe('BookingDetail por ConfirmationNumber', () => {
  it('manda 10.1.1 y lee 10.2.1', async () => {
    const h = harness(() => json(DETAIL_1021));
    const port: HotelBookingReadPort = h.adapter;
    const view = await port.getBooking('YOSUR8', CTX);
    expect(JSON.parse(h.calls[0]?.body ?? '{}')).toEqual(DETAIL_REQUESTS['byConfirmationNumber']);
    expect(h.calls[0]?.url).toMatch(/\/BookingDetail$/);
    expect(view).toEqual({
      found: true,
      providerBookingId: 'YOSUR8',
      status: 'CONFIRMED',
      providerStatus: 'Confirmed',
      voucherIssued: true,
      warnings: [],
    });
    expect(h.lanes).toEqual(['background']);
  });

  it('el reporte trae el resumen y ningún huésped (RF-24 CA-3)', async () => {
    const h = harness(() => json(DETAIL_1021));
    const report = await h.adapter.bookingDetailReport(
      { confirmationNumber: 'YOSUR8', purpose: 'interactive' },
      CTX,
    );
    expect(report.found).toBe(true);
    if (!report.found) return;
    expect(report.detail.invoiceNumber).toBe('MW34325');
    expect(report.attempts).toBe(1);
    expect(h.lanes).toEqual(['sales']);
    expect(JSON.stringify(report)).not.toMatch(PII);
    expect(JSON.stringify(h.logs)).not.toMatch(PII);
  });

  it('es una lectura: un 500 se reintenta (3 en fondo, 2 si espera el vendedor)', async () => {
    const background = harness(() => status(500));
    await expect(background.adapter.getBooking('YOSUR8', CTX)).rejects.toBeInstanceOf(TboApiError);
    expect(background.calls).toHaveLength(3);

    const interactive = harness(() => status(500));
    await expect(
      interactive.adapter.bookingDetailReport(
        { confirmationNumber: 'YOSUR8', purpose: 'interactive' },
        CTX,
      ),
    ).rejects.toBeInstanceOf(TboApiError);
    expect(interactive.calls).toHaveLength(2);
  });

  it('un 500 y después la reserva: el reintento la encuentra', async () => {
    const h = harness((_call, index) => (index === 0 ? status(500) : json(DETAIL_1021)));
    const view = await h.adapter.getBooking('YOSUR8', CTX);
    expect(view.found).toBe(true);
    expect(h.calls).toHaveLength(2);
  });
});

describe('BookingDetail por nuestra referencia (recuperación, p. 42)', () => {
  it('manda la forma de 10.1.2 con la referencia y sale por el cupo de dinero', async () => {
    const h = harness(() => json(DETAIL_1021));
    const port: HotelBookingByClientReferencePort = h.adapter;
    const view = await port.getBookingByClientReference(REFERENCE, CTX);
    expect(JSON.parse(h.calls[0]?.body ?? '{}')).toEqual({
      BookingReferenceId: REFERENCE,
      PaymentMode: 'Limit',
    });
    expect(view).toMatchObject({
      found: true,
      providerBookingId: 'YOSUR8',
      bookingReference: REFERENCE,
      status: 'CONFIRMED',
    });
    expect(h.lanes).toEqual(['money']);
  });

  it.each([
    [201, 'NO_AVAILABILITY'],
    [400, 'CLIENT_BUG'],
    [999, 'UNKNOWN_CODE'],
  ] as const)(
    'un %i es "no la encontró", provisorio hasta la sonda PR-05: no se lanza',
    async (code, kind) => {
      const h = harness(() => status(code));
      const report = await h.adapter.bookingDetailReport({ bookingReferenceId: REFERENCE }, CTX);
      expect(report).toMatchObject({
        found: false,
        tboCode: code,
        failureKind: kind,
        view: {
          found: false,
          bookingReference: REFERENCE,
          providerStatus: String(code),
          warnings: ['NOT_FOUND_SHAPE_UNCONFIRMED'],
        },
      });
      expect(h.calls).toHaveLength(1);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: 'tbo.booking_detail.not_found',
          meta: expect.objectContaining({
            tboCode: code,
            bookingReferenceId: REFERENCE,
          }) as unknown,
        }),
      );
    },
  );

  it.each([
    ['401 (cuenta)', () => status(401), 1],
    ['402 (cuenta bloqueada)', () => status(402), 1],
    ['500', () => status(500), 3],
    ['429', () => status(429), 3],
    ['red', () => Promise.reject(new TypeError('fetch failed')), 3],
    ['HTTP 404 sin envelope', () => new Response('', { status: 404 }), 1],
  ] as const)('%s no dice nada de la reserva: se lanza', async (_name, respond, calls) => {
    const h = harness(respond);
    await expect(h.adapter.getBookingByClientReference(REFERENCE, CTX)).rejects.toBeInstanceOf(
      TboApiError,
    );
    expect(h.calls).toHaveLength(calls);
  });

  it('una referencia que no es nuestra o de otro entorno no sale', async () => {
    const h = harness();
    await expect(h.adapter.getBookingByClientReference('AVw12118', CTX)).rejects.toBeInstanceOf(
      TboRequestBuildError,
    );
    await expect(
      h.adapter.getBookingByClientReference('STP7K2M9QX4D8R1VZ6AB', CTX),
    ).rejects.toBeInstanceOf(TboRequestBuildError);
    expect(h.calls).toHaveLength(0);
  });

  it('los dos identificadores juntos no salen: no se elige uno por quien llama', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.bookingDetailReport(
        { confirmationNumber: 'YOSUR8', bookingReferenceId: REFERENCE } as never,
        CTX,
      ),
    );
    expect((error as TboRequestBuildError).issues).toEqual(['<root>:both_identifiers']);
    expect(h.calls).toHaveLength(0);
  });
});
