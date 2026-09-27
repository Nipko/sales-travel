import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { HotelCancelPort } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { parseTboConfig } from './config';
import {
  TboApiError,
  TboCancelMappingError,
  TboCancelOutcomeUnknownError,
  TboDispatchRejectedError,
  TboRequestBuildError,
  TboResponseMappingError,
} from './errors';
import {
  TboInMemoryRateLimiter,
  type TboLimiterRequest,
  type TboRateLimiter,
} from './http/limiter';
import type { TboFetch, TboHttpDeps } from './http/tbo-http.client';
import { TboHotelsAdapter } from './tbo-hotels.adapter';

/**
 * Cancel y BookingDetailsbasedondate por la puerta pública del adapter, con `fetch` espiado, un
 * limitador que anota el cupo de cada llamada y la política de cancelaciones REAL de `apps/api`
 * (docs/tbo/09 PR-5.1; 04 §4.4 y §5; 08 RF-25 CA-1 a CA-4, RF-28 y §9 C-05).
 */

const CTX = { tenantId: '00000000-0000-4000-8000-00000000000a' };
const FIXTURES = join(__dirname, '__fixtures__', 'pdf');

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

const CANCEL_REQUEST_911 = fixture('cancel-request.p41.json');
const CANCEL_RESPONSE_921 = fixture('cancel-response.p42.json');
const DETAIL_1021 = fixture<{ Status: unknown; BookingDetail: Record<string, unknown> }>(
  'booking-detail.p49.json',
);
const BY_DATE_1521 = fixture('booking-by-date.p64.json');

/** El localizador de 9.1.1: la lectura de p. 49 se reescribe para hablar de ESA reserva. */
const LOCATOR = 'FL1IMA';

/** Datos personales de 10.2.1, `TripName` de 15.2.1 y la credencial: nunca en un log ni un reporte. */
const PII = /Shubham|Gupta|Kunal|Agrawal|Sharma|One_20Nov|Pa55w0rd|agencia-demo/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function status(code: number): Response {
  return json({ Status: { Code: code, Description: 'x' } });
}

/** BookingDetail de p. 49 con el estado pedido, para el localizador de 9.1.1. */
function detail(bookingStatus: string): Response {
  return json({
    ...DETAIL_1021,
    BookingDetail: {
      ...DETAIL_1021.BookingDetail,
      ConfirmationNumber: LOCATOR,
      BookingStatus: bookingStatus,
    },
  });
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: string;
}

type Responder = (call: FetchCall) => Response | Promise<Response>;

function hanging(call: FetchCall): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (call.init.signal?.aborted === true) abort();
    else call.init.signal?.addEventListener('abort', abort);
  });
}

/** Qué responde TBO a cada fase: la lectura previa, el Cancel y la lectura posterior. */
interface Script {
  readonly before?: Responder;
  readonly cancel?: Responder;
  readonly after?: Responder;
  readonly byDate?: Responder;
}

const isCancel = (call: FetchCall): boolean => call.url.endsWith('/Cancel');
const isDetail = (call: FetchCall): boolean => call.url.endsWith('/BookingDetail');

interface Harness {
  readonly adapter: TboHotelsAdapter;
  readonly calls: FetchCall[];
  readonly logs: { level: string; message: string; meta: unknown }[];
  readonly lanes: TboLimiterRequest['lane'][];
  readonly timeouts: number[];
  cancelCalls(): number;
  detailCalls(): number;
}

function harness(script: Script = {}, deps: TboHttpDeps = {}): Harness {
  const calls: FetchCall[] = [];
  const fetch: TboFetch = (url, init) => {
    const call = { url, init, body: typeof init.body === 'string' ? init.body : '' };
    const cancelled = calls.some(isCancel);
    calls.push(call);
    const respond = isCancel(call)
      ? (script.cancel ?? (() => json(CANCEL_RESPONSE_921)))
      : isDetail(call)
        ? cancelled
          ? (script.after ?? (() => detail('Cancelled')))
          : (script.before ?? (() => detail('Confirmed')))
        : (script.byDate ?? (() => json(BY_DATE_1521)));
    return Promise.resolve(respond(call));
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
  const metrics: MetricsPort = {
    counter: () => undefined,
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
  const adapter = new TboHotelsAdapter(
    parseTboConfig({ environment: 'test', username: 'agencia-demo', password: 'Pa55w0rd-cx' }),
    {
      fetch,
      logger,
      metrics,
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
  return {
    adapter,
    calls,
    logs,
    lanes,
    timeouts,
    cancelCalls: () => calls.filter(isCancel).length,
    detailCalls: () => calls.filter(isDetail).length,
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

// ───────────────────────── La política de cancelaciones de apps/api ─────────────────────────

interface CancelPolicy {
  readonly outcome: string;
  readonly retryable: boolean;
  readonly reconciliationRequired: boolean;
  readonly reason: string;
}

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

/**
 * El clasificador que decide de verdad, no una copia: `turbo.json` del paquete lo declara como
 * input de `test`, así que un cambio allí vuelve a correr este archivo.
 */
async function classify(error: unknown): Promise<CancelPolicy> {
  const file = join(repoRoot(), 'apps', 'api', 'src', 'orders', 'cancel-retry-policy.ts');
  const policyModule = (await import(file)) as {
    classifyCancelThrownFailure: (error: unknown) => CancelPolicy;
  };
  return policyModule.classifyCancelThrownFailure(error);
}

// ───────────────────────── Cancel ─────────────────────────

describe('Cancel: la secuencia de 04 §4.4', () => {
  it('lectura previa, 9.1.1 tal cual y lectura posterior; aceptada y cancelada', async () => {
    const h = harness();
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);

    expect(h.calls.map((call) => call.url.split('/').pop())).toEqual([
      'BookingDetail',
      'Cancel',
      'BookingDetail',
    ]);
    expect(h.calls[1]?.url).toBe('http://api.tbotechnology.in/TBOHolidays_HotelAPI/Cancel');
    expect(h.calls[1]?.init.method).toBe('POST');
    expect(JSON.parse(h.calls[1]?.body ?? '{}')).toEqual(CANCEL_REQUEST_911);
    for (const read of [h.calls[0], h.calls[2]]) {
      expect(JSON.parse(read?.body ?? '{}')).toEqual({
        ConfirmationNumber: LOCATOR,
        PaymentMode: 'Limit',
      });
    }

    expect(report).toMatchObject({
      result: {
        success: true,
        bookingStatus: 'CANCELLED',
        providerStatus: 'Cancelled',
        warnings: [],
      },
      confirmationNumber: LOCATOR,
      sent: true,
      cancelCode: 200,
      before: { state: 'read', view: { status: 'CONFIRMED' } },
      after: { state: 'read', view: { status: 'CANCELLED' } },
      accountRef: h.adapter.accountRef,
    });
    expect(report.cancelRequestId).toEqual(expect.any(String));
    expect(report.result).not.toHaveProperty('refundAmount');
  });

  it('Cancel por el cupo de dinero con 60 s; las lecturas, de fondo con 30 s', async () => {
    const h = harness();
    await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(h.lanes).toEqual(['background', 'money', 'background']);
    expect(h.timeouts).toEqual([30_000, 60_000, 30_000]);
  });

  it('por el puerto neutral, con refundAmount vacío (04 §4.5)', async () => {
    const h = harness();
    const port: HotelCancelPort = h.adapter;
    await expect(port.cancelBooking({ providerBookingId: LOCATOR }, CTX)).resolves.toEqual({
      success: true,
      bookingStatus: 'CANCELLED',
      providerStatus: 'Cancelled',
      warnings: [],
    });
  });

  it('una línea de log con el desenlace y ningún dato personal ni credencial', async () => {
    const h = harness();
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'tbo.cancel.outcome',
        meta: expect.objectContaining({
          confirmationNumber: LOCATOR,
          outcome: 'ACCEPTED',
          tboCode: 200,
          providerStatus: 'Cancelled',
        }) as unknown,
      }),
    );
    expect(JSON.stringify(h.logs)).not.toMatch(PII);
    expect(JSON.stringify(report)).not.toMatch(PII);
  });
});

describe('Cancel: la lectura previa decide si se manda', () => {
  it.each(['Cancelled', 'CancelledAndRefundAwaited'])(
    'ya cancelada (%s) → éxito idempotente SIN enviar',
    async (raw) => {
      const h = harness({ before: () => detail(raw) });
      const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
      expect(h.cancelCalls()).toBe(0);
      expect(h.calls).toHaveLength(1);
      expect(report).toMatchObject({
        sent: false,
        skipReason: 'ALREADY_CANCELLED',
        result: { success: true, bookingStatus: 'CANCELLED', warnings: ['ALREADY_CANCELLED'] },
      });
      expect(report).not.toHaveProperty('after');
      expect(report).not.toHaveProperty('cancelCode');
    },
  );

  it.each(['CancellationInProgress', 'CancelPending', 'CxlRequestSentToHotel'])(
    'en curso (%s) → no se envía',
    async (raw) => {
      const h = harness({ before: () => detail(raw) });
      const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
      expect(h.cancelCalls()).toBe(0);
      expect(report).toMatchObject({
        sent: false,
        skipReason: 'ALREADY_IN_PROGRESS',
        result: {
          success: true,
          bookingStatus: 'CANCELLATION_IN_PROGRESS',
          providerStatus: raw,
          warnings: ['CANCELLATION_ALREADY_IN_PROGRESS'],
        },
      });
    },
  );

  it('un estado fuera del enum → no se envía y se rechaza con motivo', async () => {
    const h = harness({ before: () => detail('Frozen') });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(h.cancelCalls()).toBe(0);
    expect(report.result).toEqual({
      success: false,
      error: 'TBO_BOOKING_STATUS_UNKNOWN',
      bookingStatus: 'UNKNOWN',
      providerStatus: 'Frozen',
      warnings: ['BOOKING_STATUS_UNKNOWN'],
    });
  });

  it('TBO no la encuentra → no se envía nada', async () => {
    const h = harness({ before: () => status(201) });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(h.cancelCalls()).toBe(0);
    expect(report).toMatchObject({
      sent: false,
      skipReason: 'NOT_FOUND',
      result: { success: false, error: 'TBO_BOOKING_NOT_FOUND' },
    });
  });

  it('RF-25 CA-4: si la lectura previa falla, no sale el Cancel y el fallo es previo y reintentable', async () => {
    const h = harness({ before: () => status(500) });
    const error = await rejection(() =>
      h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX),
    );
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).path).toBe('/BookingDetail');
    expect(h.cancelCalls()).toBe(0);
    expect(await classify(error)).toEqual({
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      reason: 'pre-write-transient',
    });
  });

  it('un localizador sin forma no toca TBO', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.cancelReport({ confirmationNumber: 'FL1 IMA' }, CTX),
    );
    expect(error).toBeInstanceOf(TboRequestBuildError);
    expect((error as TboRequestBuildError).path).toBe('/Cancel');
    expect(h.calls).toHaveLength(0);
    expect((await classify(error)).outcome).toBe('FAILED');
  });
});

describe('Cancel: 200 y 479 no lanzan; la lectura posterior decide (C-05)', () => {
  it('RF-25 CA-1: 479 con lectura Confirmed → success false, sin lanzar y con un solo Cancel', async () => {
    const h = harness({ cancel: () => status(479), after: () => detail('Confirmed') });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(report).toMatchObject({
      sent: true,
      cancelCode: 479,
      result: {
        success: false,
        error: 'TBO_CANCEL_FAIL',
        bookingStatus: 'CONFIRMED',
        providerStatus: 'Confirmed',
        warnings: [],
      },
    });
    expect(h.cancelCalls()).toBe(1);
    expect(h.detailCalls()).toBe(2);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'tbo.cancel.outcome',
        meta: expect.objectContaining({ outcome: 'REJECTED', tboCode: 479 }) as unknown,
      }),
    );
  });

  it('479 con lectura Cancelled → éxito idempotente', async () => {
    const h = harness({ cancel: () => status(479), after: () => detail('Cancelled') });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(report.result).toMatchObject({
      success: true,
      bookingStatus: 'CANCELLED',
      warnings: ['ALREADY_CANCELLED'],
    });
  });

  it('RF-25 CA-2: 200 con lectura CancellationInProgress → aceptada, no final', async () => {
    const h = harness({ after: () => detail('CancellationInProgress') });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(report.result).toEqual({
      success: true,
      bookingStatus: 'CANCELLATION_IN_PROGRESS',
      providerStatus: 'CancellationInProgress',
      warnings: [],
    });
  });

  it('una lectura posterior fallida NO vuelve UNVERIFIED un 200: no lanza, un solo Cancel', async () => {
    const h = harness({ after: () => status(500) });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(report.result).toEqual({ success: true, warnings: ['POST_CANCEL_READ_FAILED'] });
    expect(report.after).toMatchObject({
      state: 'failed',
      errorClass: 'TboApiError',
      kind: 'UPSTREAM',
    });
    expect(report.cancelCode).toBe(200);
    expect(h.cancelCalls()).toBe(1);
    // HARD-1: la lectura posterior hace UN intento. Lo que no alcance a decir lo lee
    // `verify-cancellation`; reintentarla aquí sólo alarga la cancelación síncrona.
    expect(h.detailCalls()).toBe(1 + 1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'tbo.cancel.outcome',
        meta: expect.objectContaining({
          outcome: 'ACCEPTED',
          warnings: ['POST_CANCEL_READ_FAILED'],
        }) as unknown,
      }),
    );
  });

  it('ni siquiera con una lectura posterior ilegible o de otra reserva', async () => {
    const other = json({
      ...DETAIL_1021,
      BookingDetail: { ...DETAIL_1021.BookingDetail, ConfirmationNumber: 'YOSUR8' },
    });
    const h = harness({ after: () => other });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(report.result).toEqual({ success: true, warnings: ['POST_CANCEL_READ_FAILED'] });
    expect(report.after).toMatchObject({ state: 'failed', errorClass: 'TboResponseMappingError' });
  });

  it('200 con lectura que sigue Confirmed → aceptada, a verificar', async () => {
    const h = harness({ after: () => detail('Confirmed') });
    const report = await h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX);
    expect(report.result).toMatchObject({
      success: true,
      bookingStatus: 'CONFIRMED',
      warnings: ['BOOKING_STILL_CONFIRMED'],
    });
  });
});

describe('Cancel: lo que no dice si se aplicó se lanza con path /Cancel, y un solo intento', () => {
  it('RF-25 CA-3: timeout → UNVERIFIED y cero segundos Cancel', async () => {
    const h = harness(
      { cancel: hanging },
      { timeoutSignal: (ms) => AbortSignal.timeout(ms === 60_000 ? 5 : ms) },
    );
    const error = await rejection(() =>
      h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX),
    );
    expect(error).toBeInstanceOf(TboCancelOutcomeUnknownError);
    expect(error).toBeInstanceOf(TboApiError);
    expect(error).toMatchObject({ path: '/Cancel', status: 0, timedOut: true, kind: 'TRANSPORT' });
    expect(h.cancelCalls()).toBe(1);
    // Sin lectura posterior: la verificación la hace `verify-cancellation`, que sólo lee.
    expect(h.detailCalls()).toBe(1);
    expect(await classify(error)).toEqual({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'write-unverified',
    });
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'tbo.cancel.outcome',
        meta: expect.objectContaining({
          outcome: 'THREW',
          errorClass: 'TboCancelOutcomeUnknownError',
          kind: 'TRANSPORT',
        }) as unknown,
      }),
    );
  });

  it.each([
    ['500 en el cuerpo', () => status(500), 'UPSTREAM'],
    ['429 en el cuerpo', () => status(429), 'THROTTLED'],
    ['HTTP 503 HTML', () => new Response('<html>', { status: 503 }), 'UPSTREAM'],
    ['red', () => Promise.reject(new TypeError('fetch failed')), 'TRANSPORT'],
  ] as const)('%s → UNVERIFIED, un solo Cancel', async (_name, respond, kind) => {
    const h = harness({ cancel: respond });
    const error = await rejection(() =>
      h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX),
    );
    expect(error).toBeInstanceOf(TboCancelOutcomeUnknownError);
    expect(error).toMatchObject({ path: '/Cancel', kind });
    expect(h.cancelCalls()).toBe(1);
    expect((await classify(error)).outcome).toBe('UNVERIFIED');
  });

  it.each([
    ['un Status.Code desconocido (pendiente e)', () => status(418), ['Status.Code:unknown_code']],
    [
      'un 200 sin ConfirmationNumber',
      () => json({ Status: { Code: 200, Description: 'Cancelled' } }),
      ['ConfirmationNumber:invalid_type'],
    ],
    [
      'un 200 que nombra otra reserva',
      () => json({ ...CANCEL_RESPONSE_921, ConfirmationNumber: 'YOSUR8' }),
      ['ConfirmationNumber:not_the_requested_booking'],
    ],
    ['un 2xx que no es JSON', () => new Response('ok', { status: 200 }), undefined],
  ] as const)(
    '%s → TboCancelMappingError o ilegible, UNVERIFIED',
    async (_name, respond, issues) => {
      const h = harness({ cancel: respond });
      const error = await rejection(() =>
        h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX),
      );
      expect(h.cancelCalls()).toBe(1);
      expect(h.detailCalls()).toBe(1);
      if (issues !== undefined) {
        expect(error).toBeInstanceOf(TboCancelMappingError);
        expect(error).toMatchObject({ name: 'TboCancelMappingError', path: '/Cancel', issues });
      }
      expect(await classify(error)).toMatchObject({
        outcome: 'UNVERIFIED',
        reconciliationRequired: true,
      });
    },
  );

  it.each([
    [201, 'NO_AVAILABILITY'],
    [207, 'RATE_UNAVAILABLE'],
    [300, 'INSUFFICIENT_BALANCE'],
    [315, 'OFFER_EXPIRED'],
    [405, 'BOOKING_FAILED'],
    [401, 'CREDENTIALS_INVALID'],
    [402, 'ACCOUNT_BLOCKED'],
    [400, 'CLIENT_BUG'],
  ] as const)(
    'HARD-1: %i en /Cancel no prueba que TBO no canceló → UNVERIFIED, sin reenviar',
    async (code, kind) => {
      const h = harness({ cancel: () => status(code) });
      const error = await rejection(() =>
        h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX),
      );
      expect(error).toBeInstanceOf(TboCancelOutcomeUnknownError);
      expect(error).toMatchObject({ path: '/Cancel', kind, tboCode: code });
      expect(h.cancelCalls()).toBe(1);
      // La relectura es de `verify-cancellation`, que sólo lee: aquí no hay lectura posterior.
      expect(h.detailCalls()).toBe(1);
      expect(await classify(error)).toEqual({
        outcome: 'UNVERIFIED',
        retryable: false,
        reconciliationRequired: true,
        reason: 'write-unverified',
      });
    },
  );

  it('HARD-1: un HTTP 4xx de transporte en /Cancel tampoco se cierra como fallido', async () => {
    const h = harness({ cancel: () => new Response('forbidden', { status: 403 }) });
    const error = await rejection(() =>
      h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX),
    );
    expect(error).toBeInstanceOf(TboCancelOutcomeUnknownError);
    expect(error).toMatchObject({ path: '/Cancel', status: 403 });
    expect((await classify(error)).outcome).toBe('UNVERIFIED');
  });

  it('un Cancel que el limitador no despachó no salió: FAILED y sin conciliar', async () => {
    const inner = new TboInMemoryRateLimiter({
      maxQps: 1_000,
      maxConcurrent: 100,
      background: { qps: 1_000, concurrent: 100 },
    });
    const limiter: TboRateLimiter = {
      acquire: (request) =>
        request.lane === 'money'
          ? Promise.resolve({ granted: false, reason: 'QUEUE_TIMEOUT' })
          : inner.acquire(request),
      reportThrottled: (accountRef) => inner.reportThrottled(accountRef),
    };
    const h = harness({}, { limiter });
    const error = await rejection(() =>
      h.adapter.cancelReport({ confirmationNumber: LOCATOR }, CTX),
    );
    expect(error).toBeInstanceOf(TboDispatchRejectedError);
    expect(h.cancelCalls()).toBe(0);
    expect(await classify(error)).toMatchObject({
      outcome: 'FAILED',
      reconciliationRequired: false,
    });
  });
});

// ───────────────────────── BookingDetailsbasedondate ─────────────────────────

describe('BookingDetailsbasedondate: una ventana', () => {
  const WINDOW = { fromDate: '2023-11-09', toDate: '2023-11-10' };

  it('manda FromDate/ToDate por el cupo de fondo, con 60 s, y lee 15.2.1', async () => {
    const h = harness();
    const report = await h.adapter.listBookingsByDateReport(WINDOW, CTX);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(
      'http://api.tbotechnology.in/TBOHolidays_HotelAPI/BookingDetailsbasedondate',
    );
    expect(JSON.parse(h.calls[0]?.body ?? '{}')).toEqual({
      FromDate: '2023-11-09',
      ToDate: '2023-11-10',
    });
    expect(h.lanes).toEqual(['background']);
    expect(h.timeouts).toEqual([60_000]);
    expect(report).toMatchObject({
      window: WINDOW,
      accountRef: h.adapter.accountRef,
      attempts: 1,
    });
    expect(report.bookings.map((b) => [b.confirmationNumber, b.status])).toEqual([
      ['GOF05R', 'CONFIRMED'],
      ['7L4F4E', 'CONFIRMED'],
    ]);
    expect(JSON.stringify(report)).not.toMatch(PII);
    expect(JSON.stringify(h.logs)).not.toMatch(/ATravels|Sharma|583\.89/);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'tbo.bookings_by_date.read',
        meta: expect.objectContaining({ ...WINDOW, bookingCount: 2 }) as unknown,
      }),
    );
  });

  it('no pasa por HotelBookingsByDatePort: ese nombre es de otro contrato ({ from, to } → resúmenes)', () => {
    // `apps/api` detecta los puertos opcionales por el nombre del método: con el mismo nombre, un
    // llamador le pasaría `{ from, to }` y leería un arreglo donde hay un reporte.
    expect('listBookingsByDate' in harness().adapter).toBe(false);
  });

  it('una ventana de más de 60 días no sale', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.listBookingsByDateReport({ fromDate: '2026-01-01', toDate: '2026-03-02' }, CTX),
    );
    expect(error).toBeInstanceOf(TboRequestBuildError);
    expect((error as TboRequestBuildError).issues).toEqual(['toDate:window_too_long']);
    expect(h.calls).toHaveLength(0);
  });

  it('una fila fuera de la ventana invalida la lectura entera (RF-28 CA)', async () => {
    const h = harness();
    const error = await rejection(() =>
      h.adapter.listBookingsByDateReport({ fromDate: '2023-11-10', toDate: '2023-11-10' }, CTX),
    );
    expect(error).toBeInstanceOf(TboResponseMappingError);
    expect((error as TboResponseMappingError).issues).toEqual([
      'BookingDetail.1.BookingDate:outside_window',
    ]);
  });

  it('un 201 no es "no hay reservas": se lanza (PV-26)', async () => {
    const h = harness({ byDate: () => status(201) });
    const error = await rejection(() => h.adapter.listBookingsByDateReport(WINDOW, CTX));
    expect(error).toMatchObject({ kind: 'NO_AVAILABILITY', tboCode: 201 });
    expect(h.calls).toHaveLength(1);
  });

  it('un 200 sin reservas sí lo es', async () => {
    const h = harness({ byDate: () => json({ Status: { Code: 200 }, BookingDetail: [] }) });
    const report = await h.adapter.listBookingsByDateReport(WINDOW, CTX);
    expect(report.bookings).toEqual([]);
  });

  it('es una lectura: un 500 se reintenta hasta 3 veces', async () => {
    const h = harness({ byDate: () => status(500) });
    await expect(h.adapter.listBookingsByDateReport(WINDOW, CTX)).rejects.toBeInstanceOf(
      TboApiError,
    );
    expect(h.calls).toHaveLength(3);
  });
});
