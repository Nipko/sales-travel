import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import type { SearchContext, TicketingPort } from '@sales-travel/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_CHECK_FLIGHT_TICKETS_PATH } from './booking/cancel.request.builder';
import { SABRE_GET_BOOKING_PATH } from './booking/get.request.builder';
import { sabreBodyDigest } from './canonical-json';
import { SABRE_DEFAULT_REQUEST_TIMEOUT_MS, SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import {
  SABRE_FULFILL_TIMEOUT_MS,
  SabreTicketingAdapter,
  SabreTicketingNotSentError,
  type SabreTicketingAdapterSettings,
} from './sabre-ticketing.adapter';
import { SABRE_FULFILL_PATH, SabreFulfillBuildError } from './ticketing/fulfill.request.builder';

/**
 * LA EMISIÓN POR LA PUERTA PÚBLICA.
 *
 * El adapter corre sobre un `SabreHttpClient` real con un `fetch` interceptado: por ahí pasan la
 * clasificación del sobre, la política de reintentos (`SABRE_NON_IDEMPOTENT_PATHS`), el timeout y
 * la redacción del log. Se mide el cuerpo SERIALIZADO que sale, la secuencia de rutas y lo que
 * vuelve por el puerto.
 *
 * El `fetch` falso sólo contesta lo que el test preparó y tantas veces como lo preparó: una llamada
 * de más —un reintento de la emisión, por ejemplo— lanza y pone el test en rojo. Las respuestas de
 * emisión son las oficiales (`__fixtures__/fulfill-*.json`, ver la cabecera de
 * `ticketing/fulfill.response.mapper.test.ts`) y las de `checkFlightTickets`, los ejemplos de
 * `help-documentation-check-flight-tickets-examples.txt` leídos del expediente. Ningún test llama a
 * Sabre.
 */

type Json = Record<string, unknown>;

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'req-tkt' };
const PNR = 'QWERTY';
const NOW_MS = Date.parse('2026-10-13T15:00:00.000Z');

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
    ...overrides,
  };
}

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as Json;
}

/** Emisión con `CASH`, un pasajero, tiquete `TE` grabado (`…-examples.txt:178-230`). */
const fulfilledCash = (): Json => fixture('fulfill-atpco-cash-200.json');

/** La reserva tal como la lee `getBooking` de post-venta. */
function booking(
  options: {
    readonly tickets?: readonly { number: string; travelerIndex: number; code?: string }[];
    readonly isTicketed?: boolean;
    readonly cancelled?: boolean;
  } = {},
): Json {
  return {
    bookingId: PNR,
    isCancelable: true,
    ...(options.isTicketed === undefined ? {} : { isTicketed: options.isTicketed }),
    flights: [
      {
        itemId: '1',
        confirmationId: 'AB123',
        airlineCode: 'AV',
        sourceType: 'ATPCO',
        flightStatusCode: options.cancelled === true ? 'XX' : 'HK',
        flightStatusName: options.cancelled === true ? 'Cancelled' : 'Confirmed',
      },
    ],
    ...(options.tickets === undefined
      ? {}
      : {
          flightTickets: options.tickets.map((ticket) => ({
            number: ticket.number,
            travelerIndex: ticket.travelerIndex,
            ticketStatusCode: ticket.code ?? 'TE',
          })),
        }),
  };
}

const notIssued = (): Json => booking();
/** Lo que deja grabado la emisión de `fulfilledCash`: el mismo número, para el pasajero 1. */
const issuedOne = (): Json => booking({ tickets: [{ number: '0016802004060', travelerIndex: 1 }] });

// ---------------------------------------------------------------------------------------------
// El arnés
// ---------------------------------------------------------------------------------------------

interface LogCall {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

interface WireCall {
  readonly path: string;
  readonly raw: string;
  readonly headers: Record<string, string>;
}

type Reply =
  | { readonly status: number; readonly body: unknown }
  | { readonly network: true }
  /** No contesta nunca: sólo termina cuando el cliente aborta la petición. */
  | { readonly hang: true; readonly onAbort?: () => void }
  /** No contesta hasta que el test llama a `release`. */
  | { readonly gate: Promise<void> };

const ok = (body: unknown): Reply => ({ status: 200, body });

function wire(
  routes: Record<string, readonly Reply[]>,
  options: {
    readonly cfg?: SabreConfig;
    readonly settings?: SabreTicketingAdapterSettings;
  } = {},
) {
  const cfg = options.cfg ?? config();
  const calls: WireCall[] = [];
  const logs: LogCall[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  const queues = new Map(Object.entries(routes).map(([path, replies]) => [path, [...replies]]));

  const fetchImpl: SabreFetch = (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      raw: typeof init.body === 'string' ? init.body : '',
      headers: { ...(init.headers as Record<string, string>) },
    });
    const next = queues.get(path)?.shift();
    if (next === undefined) {
      throw new Error(`el ACL llamó a ${path}, que este test no preparó (o ya agotó)`);
    }
    if ('network' in next) return Promise.reject(new Error('socket hang up'));
    if ('hang' in next) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          next.onAbort?.();
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if ('gate' in next) {
      return next.gate.then(() => new Response('{}', { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  };

  const tokens: SabreTokenProvider = {
    getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
    invalidate: () => Promise.resolve(),
  };
  const http = new SabreHttpClient(cfg, tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const adapter = new SabreTicketingAdapter(
    cfg,
    http,
    { logger, now: () => NOW_MS },
    options.settings,
  );
  const paths = (): string[] => calls.map((call) => call.path);
  const bodyAt = (path: string): Json => {
    const matches = calls.filter((call) => call.path === path);
    const only = matches[0];
    if (only === undefined || matches.length !== 1) {
      throw new Error(`se esperaba exactamente un POST a ${path}, hubo ${String(matches.length)}`);
    }
    return JSON.parse(only.raw) as Json;
  };
  const port: TicketingPort = adapter;
  return { adapter, port, http, calls, logs, paths, bodyAt };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba un rechazo');
}

function issueLine(logs: readonly LogCall[]): LogCall {
  const line = logs.find((call) => call.message === 'sabre.fulfillFlightTickets');
  if (line === undefined) throw new Error('no hay línea sabre.fulfillFlightTickets');
  return line;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// El camino feliz y el orden de las llamadas
// ---------------------------------------------------------------------------------------------

describe('issueTickets — lee la reserva antes de emitir, y emite una sola vez', () => {
  it('CASH: lectura previa, una emisión, ISSUED con el documento y la oficina que emitió', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
      [SABRE_FULFILL_PATH]: [ok(fulfilledCash())],
    });
    const result = await h.port.issueTickets(PNR, CTX, { travelerCount: 1 });

    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_FULFILL_PATH]);
    expect(result).toEqual({
      outcome: 'ISSUED',
      documents: [
        { number: '0016802004060', kind: 'TICKET', status: 'ISSUED', providerStatusCode: 'TE' },
      ],
      warnings: [],
      issues: [],
      idempotencyKey: sabreBodyDigest(h.bodyAt(SABRE_FULFILL_PATH)),
      formOfPaymentType: 'CASH',
      ticketingPcc: 'E9E7',
    });
  });

  it('el cuerpo que sale: CASH, índice 1, precio estricto, firma fija y nada más', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
      [SABRE_FULFILL_PATH]: [ok(fulfilledCash())],
    });
    await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1, commissionPercentage: 7.5 });

    expect(h.bodyAt(SABRE_FULFILL_PATH)).toEqual({
      confirmationId: PNR,
      bookingSource: 'SABRE',
      fulfillments: [
        {
          ticketingQualifiers: { commissionPercentage: '7.50' },
          payment: { primaryFormOfPayment: 1 },
        },
      ],
      formsOfPayment: [{ type: 'CASH' }],
      receivedFrom: 'PLANETOUR',
      acceptPriceChanges: false,
      priceQuoteExpirationMethod: 'Quit',
      backDatePriceQuoteMethod: 'Quit',
      commitTicketToBookingWaitTime: 3000,
    });
  });

  it('la forma de pago es la de la cuenta: ON_ACCOUNT e INVOICE salen tal cual', async () => {
    for (const settings of [
      { formOfPayment: 'ON_ACCOUNT' },
      { formOfPayment: 'INVOICE', invoiceDescription: 'AGT INVOICE' },
    ] as const) {
      const h = wire(
        {
          [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
          [SABRE_FULFILL_PATH]: [ok(fulfilledCash())],
        },
        { settings },
      );
      const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
      const { formOfPayment, ...rest } = settings;
      expect(h.bodyAt(SABRE_FULFILL_PATH)['formsOfPayment']).toEqual([
        { type: formOfPayment, ...rest },
      ]);
      expect(result.formOfPaymentType).toBe(formOfPayment);
    }
  });

  it('el PCC de emisión viaja como targetPcc con la cabecera del grupo', async () => {
    const h = wire(
      {
        [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
        [SABRE_FULFILL_PATH]: [ok(fulfilledCash())],
      },
      { cfg: config({ sabreGroup: 'GRP1' }), settings: { ticketingPcc: 'A1B2' } },
    );
    await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(h.bodyAt(SABRE_FULFILL_PATH)['targetPcc']).toBe('A1B2');
    const call = h.calls.find((c) => c.path === SABRE_FULFILL_PATH);
    expect(call?.headers['X-Sabre-Group']).toBe('GRP1');
  });

  it('un PCC de emisión sin grupo no sale: actuaría sobre el PCC propio', async () => {
    const h = wire({}, { settings: { ticketingPcc: 'A1B2' } });
    const error = await rejection(() => h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 }));
    expect(error).toBeInstanceOf(SabreTicketingNotSentError);
    expect((error as SabreTicketingNotSentError).code).toBe('TARGET_PCC_NOT_ADDRESSABLE');
    expect((error as SabreTicketingNotSentError).sentToProvider).toBe(false);
    expect(h.paths()).toEqual([]);
  });

  it('una entrada inválida no toca la red', async () => {
    for (const travelerCount of [0, 10, 1.5, Number.NaN]) {
      const h = wire({});
      const error = await rejection(() => h.adapter.issueTickets(PNR, CTX, { travelerCount }));
      expect((error as SabreTicketingNotSentError).code).toBe('TRAVELER_COUNT_INVALID');
      expect(h.paths()).toEqual([]);
    }
    const h = wire({});
    const error = await rejection(() =>
      h.adapter.issueTickets(PNR, CTX, { travelerCount: 1, commissionPercentage: 100 }),
    );
    expect(error).toBeInstanceOf(SabreFulfillBuildError);
    expect((error as SabreFulfillBuildError).sentToProvider).toBe(false);
    expect(h.paths()).toEqual([]);
  });

  it('el log de una emisión limpia va en info, y no lleva PNR, nombres ni texto del proveedor', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
      [SABRE_FULFILL_PATH]: [ok(fulfilledCash())],
    });
    await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    const line = issueLine(h.logs);
    expect(line.level).toBe('info');
    expect(line.meta).toMatchObject({ outcome: 'ISSUED', sent: true, travelerCount: 1 });
    const text = JSON.stringify(h.logs);
    for (const leak of [PNR, 'DRAKE', 'JOHN', 'ATK-SUPERSECRETO', 'Pa55w0rd!']) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe('issueTickets — la lectura previa decide sin emitir', () => {
  it('cada pasajero ya tiene su tiquete: ALREADY_ISSUED y NO se llama a fulfill', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [
        ok(
          booking({
            tickets: [
              { number: '0016802004060', travelerIndex: 1 },
              { number: '0016802004061', travelerIndex: 2 },
            ],
          }),
        ),
      ],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 2 });
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH]);
    expect(result.outcome).toBe('ALREADY_ISSUED');
    expect(result.documents.map((d) => [d.number, d.travelerIndex])).toEqual([
      ['0016802004060', 0],
      ['0016802004061', 1],
    ]);
    expect(issueLine(h.logs).meta).toMatchObject({ sent: false, outcome: 'ALREADY_ISSUED' });
  });

  it('unos sí y otros no: PARTIAL sin emitir, porque reemitir sobre una reserva a medias duplica', async () => {
    const h = wire({ [SABRE_GET_BOOKING_PATH]: [ok(issuedOne())] });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 2 });
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH]);
    expect(result.outcome).toBe('PARTIAL');
    expect(result.warnings).toEqual(['issued-before-request', 'documents-missing']);
  });

  it('el proveedor dice que está emitida y no hay tiquete legible: NEEDS_HUMAN sin emitir', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [
        ok(booking({ tickets: [{ number: '0016802004060', travelerIndex: 1, code: 'OV' }] })),
      ],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH]);
    expect(result.outcome).toBe('NEEDS_HUMAN');
    expect(result.warnings).toEqual(['ticketed-without-documents']);
  });

  it('una reserva cancelada en el proveedor no se emite: lanza y no sale', async () => {
    const h = wire({ [SABRE_GET_BOOKING_PATH]: [ok(booking({ cancelled: true }))] });
    const error = await rejection(() => h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 }));
    expect((error as SabreTicketingNotSentError).code).toBe('BOOKING_CANCELLED');
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH]);
  });

  it('si la lectura previa falla, lanza y la emisión no sale', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [
        { status: 500, body: {} },
        { status: 500, body: {} },
        { status: 500, body: {} },
      ],
    });
    const error = await rejection(() => h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 }));
    expect(error).toBeInstanceOf(SabreApiError);
    expect(h.paths()).not.toContain(SABRE_FULFILL_PATH);
  });
});

// ---------------------------------------------------------------------------------------------
// Sin reintentos: ante la duda, una lectura de conciliación
// ---------------------------------------------------------------------------------------------

describe('issueTickets — sin reintento, con conciliación', () => {
  it.each<[string, Reply]>([
    ['un 503', { status: 503, body: { status: 'ERROR' } }],
    ['un 500', { status: 500, body: {} }],
    ['la red caída', { network: true }],
  ])(
    '%s: UNA emisión, UNA lectura, y la lectura dice que se emitió → ISSUED',
    async (_l, reply) => {
      const h = wire({
        [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(issuedOne())],
        [SABRE_FULFILL_PATH]: [reply],
      });
      const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
      expect(h.paths()).toEqual([
        SABRE_GET_BOOKING_PATH,
        SABRE_FULFILL_PATH,
        SABRE_GET_BOOKING_PATH,
      ]);
      expect(result.outcome).toBe('ISSUED');
      expect(result.warnings).toEqual(['no-response', 'reconciled']);
      expect(result.documents).toEqual([
        {
          number: '0016802004060',
          kind: 'TICKET',
          status: 'ISSUED',
          travelerIndex: 0,
          providerStatusCode: 'TE',
        },
      ]);
    },
  );

  it('sin respuesta y la reserva sin tiquetes: UNVERIFIED, nunca FAILED', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(notIssued())],
      [SABRE_FULFILL_PATH]: [{ status: 504, body: {} }],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.warnings).toEqual(['no-response']);
    expect(issueLine(h.logs).level).toBe('warn');
  });

  it('aunque el llamador del cliente pidiera idempotencia, la emisión no se repite', async () => {
    // La sonda del cliente: el path está en SABRE_NON_IDEMPOTENT_PATHS. Si alguien lo quitara de la
    // lista, `idempotent: true` reintentaría y el `fetch` falso lanzaría por la segunda llamada.
    const h = wire({ [SABRE_FULFILL_PATH]: [{ status: 503, body: {} }] });
    await expect(h.http.postJson(SABRE_FULFILL_PATH, {}, { idempotent: true })).rejects.toThrow(
      SabreApiError,
    );
    expect(h.paths()).toEqual([SABRE_FULFILL_PATH]);
  });

  it('si la relectura también falla, se queda en duda y lo dice', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [
        ok(notIssued()),
        { status: 500, body: {} },
        { status: 500, body: {} },
        { status: 500, body: {} },
      ],
      [SABRE_FULFILL_PATH]: [{ status: 502, body: {} }],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.warnings).toEqual(['no-response', 'reconciliation-failed']);
    expect(h.paths().filter((p) => p === SABRE_FULFILL_PATH)).toHaveLength(1);
  });

  it('un 4xx del gateway es rechazo antes de ejecutar: FAILED y sin relectura', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
      [SABRE_FULFILL_PATH]: [{ status: 400, body: { errorCode: 'ERR.2SG.CLIENT.BAD_REQUEST' } }],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('FAILED');
    expect(result.warnings).toEqual(['provider-rejected']);
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_FULFILL_PATH]);
  });

  it('un 408 no es un rechazo: no se sabe si se ejecutó', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(notIssued())],
      [SABRE_FULFILL_PATH]: [{ status: 408, body: {} }],
    });
    expect((await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 })).outcome).toBe(
      'UNVERIFIED',
    );
  });

  it('una respuesta que no se entiende es duda, no fallo: se relee', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(issuedOne())],
      [SABRE_FULFILL_PATH]: [ok({ tickets: 'TE 0016802004060 DRAKE' })],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('ISSUED');
    expect(result.warnings).toEqual(['response-unreadable', 'reconciled']);
  });
});

describe('issueTickets — timeout de 45 s', () => {
  it('la emisión se corta a los 45 s, no a los 30 del default; después se relee una vez', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(notIssued())],
      [SABRE_FULFILL_PATH]: [{ hang: true, onAbort: () => (aborted = true) }],
    });
    const pending = h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });

    await vi.advanceTimersByTimeAsync(SABRE_DEFAULT_REQUEST_TIMEOUT_MS + 1);
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_FULFILL_PATH]);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(
      SABRE_FULFILL_TIMEOUT_MS - SABRE_DEFAULT_REQUEST_TIMEOUT_MS - 2,
    );
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);

    const result = await pending;
    expect(SABRE_FULFILL_TIMEOUT_MS).toBe(45_000);
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.warnings).toEqual(['no-response']);
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_FULFILL_PATH, SABRE_GET_BOOKING_PATH]);
  });

  it('si la emisión ni siquiera sale (cola local vencida), lanza con sentToProvider false', async () => {
    // Una cuenta con un solo hueco: dos lecturas lo ocupan y la emisión espera en la cola hasta su
    // propio timeout. Nada llegó a Sabre, así que no es «en duda»: es «no salió», y se lanza.
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    const h = wire(
      {
        [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [{ gate: first }, { hang: true }],
        [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
      },
      // La comprobación que ocupa el hueco cuelga 60 s: más que los 45 de la emisión en cola.
      { cfg: config({ maxConcurrentRequests: 1, requestTimeoutMs: 60_000 }) },
    );
    const blocker = h.adapter.checkTickets(PNR, CTX).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const issuing = h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const second = h.adapter.checkTickets(PNR, CTX).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // La primera lectura termina: el hueco pasa a la lectura previa de la emisión, y después a la
    // segunda comprobación, que no contesta nunca. La emisión queda en la cola.
    releaseFirst();
    const outcome = issuing.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(SABRE_FULFILL_TIMEOUT_MS + 1);
    const error = await outcome;
    expect(error).toBeInstanceOf(SabreApiError);
    expect((error as { sentToProvider?: unknown }).sentToProvider).toBe(false);
    expect(h.paths()).not.toContain(SABRE_FULFILL_PATH);
    await vi.advanceTimersByTimeAsync(60_001);
    await Promise.all([blocker, second]);
  });
});

// ---------------------------------------------------------------------------------------------
// Lo que dice el proveedor dentro del 200
// ---------------------------------------------------------------------------------------------

describe('issueTickets — errores y avisos dentro del 200', () => {
  it('PRICE_MISMATCH: FAILED, sin relectura, y sin el texto del proveedor', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
      [SABRE_FULFILL_PATH]: [
        ok({
          timestamp: '2026-10-13T15:00:01',
          errors: [
            {
              category: 'APPLICATION_ERROR',
              type: 'PRICE_MISMATCH',
              description:
                'No new tickets have been issued due to the price change (new total price: 999.99). Update retained price (888.88) in the booking',
            },
          ],
        }),
      ],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('FAILED');
    expect(result.warnings).toEqual(['provider-rejected', 'price-changed']);
    expect(result.issues).toEqual([
      { severity: 'ERROR', category: 'APPLICATION_ERROR', type: 'PRICE_MISMATCH' },
    ]);
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_FULFILL_PATH]);
    const text = JSON.stringify([result, h.logs]);
    expect(text).not.toContain('999.99');
    expect(text).not.toContain('No new tickets');
  });

  it('BOOKING_FULFILLED: se relee, y si cada pasajero tiene su tiquete es ALREADY_ISSUED', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(issuedOne())],
      [SABRE_FULFILL_PATH]: [
        ok({ errors: [{ category: 'APPLICATION_ERROR', type: 'BOOKING_FULFILLED' }] }),
      ],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('ALREADY_ISSUED');
    expect(result.warnings).toEqual(['already-fulfilled', 'reconciled']);
  });

  it('BOOKING_FULFILLED sin un tiquete a la vista: NEEDS_HUMAN, no se adivina', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(notIssued())],
      [SABRE_FULFILL_PATH]: [
        ok({ errors: [{ category: 'APPLICATION_ERROR', type: 'BOOKING_FULFILLED' }] }),
      ],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('NEEDS_HUMAN');
    expect(result.warnings).toEqual(['already-fulfilled', 'ticketed-without-documents']);
  });

  it('UNABLE_TO_RETRIEVE_TICKETS como error: NEEDS_HUMAN aunque la relectura lo muestre todo', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(issuedOne())],
      [SABRE_FULFILL_PATH]: [
        ok({ errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_RETRIEVE_TICKETS' }] }),
      ],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('NEEDS_HUMAN');
    expect(result.documents).toHaveLength(1);
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_FULFILL_PATH, SABRE_GET_BOOKING_PATH]);
  });

  it('PARTIAL_FULFILLMENT con tiquetes: NEEDS_HUMAN, y los documentos de las dos lecturas se unen', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(issuedOne())],
      [SABRE_FULFILL_PATH]: [
        ok({
          ...fulfilledCash(),
          warnings: [
            {
              category: 'PROCESSING_WARNING',
              type: 'PARTIAL_FULFILLMENT',
              description: 'At least one fulfillment operation was not processed correctly. DRAKE',
            },
          ],
        }),
      ],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('NEEDS_HUMAN');
    expect(result.warnings).toEqual(['partial-fulfillment']);
    // El número de la emisión, con el pasajero que sólo la lectura de la reserva sabe.
    expect(result.documents).toEqual([
      {
        number: '0016802004060',
        kind: 'TICKET',
        status: 'ISSUED',
        travelerIndex: 0,
        providerStatusCode: 'TE',
      },
    ]);
    expect(result.issues).toEqual([
      { severity: 'WARNING', category: 'PROCESSING_WARNING', type: 'PARTIAL_FULFILLMENT' },
    ]);
    expect(JSON.stringify([result, h.logs])).not.toContain('DRAKE');
  });

  it('un tiquete no grabado en la reserva se confirma releyendo', async () => {
    const body = fulfilledCash();
    const [ticket] = body['tickets'] as Json[];
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued()), ok(issuedOne())],
      [SABRE_FULFILL_PATH]: [ok({ ...body, tickets: [{ ...ticket, isCommitted: false }] })],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });
    expect(result.outcome).toBe('ISSUED');
    expect(result.warnings).toEqual(['document-not-committed', 'reconciled']);
  });

  it('menos tiquetes que pasajeros, sin aviso: PARTIAL y sin relectura', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
      [SABRE_FULFILL_PATH]: [ok(fulfilledCash())],
    });
    const result = await h.adapter.issueTickets(PNR, CTX, { travelerCount: 2 });
    expect(result.outcome).toBe('PARTIAL');
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_FULFILL_PATH]);
  });

  it('la misma emisión dos veces da la misma clave: es el mismo paso del saga', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const h = wire({
        [SABRE_GET_BOOKING_PATH]: [ok(notIssued())],
        [SABRE_FULFILL_PATH]: [ok(fulfilledCash())],
      });
      keys.push((await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 })).idempotencyKey);
    }
    expect(keys[0]).toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------------------------
// checkTickets
// ---------------------------------------------------------------------------------------------

describe('checkTickets — las condiciones, con los ejemplos oficiales', () => {
  it('caso 1 (ATPCO, CX): anulable, reembolsable, con la estimación en unidades menores', async () => {
    // `help-documentation-check-flight-tickets-examples.txt`, use case 1: refundTotals.total 802.00
    // USD y la penalidad BEFORE/AFTER de 222.0: se toma la mayor, que es lo que estima el proveedor.
    const example = checkExample('The response does not contain errors:', 'Use case 1');
    const h = wire({ [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok(example)] });
    const result = await h.port.checkTickets(PNR, CTX);
    expect(result).toEqual({
      checkedAt: new Date(NOW_MS).toISOString(),
      tickets: [
        {
          number: '1607958830515',
          voidable: 'yes',
          refundable: 'yes',
          refund: { totalMinor: 80200, penaltyMinor: 22200, currency: 'USD' },
        },
      ],
      cancelOffers: [],
    });
    expect(h.bodyAt(SABRE_CHECK_FLIGHT_TICKETS_PATH)).toEqual({ confirmationId: PNR });
  });

  it('caso 4 (NDC): la oferta de anulación con su caducidad en UTC', async () => {
    const example = checkExample('There are no errors in the response:', 'Use case 4');
    const h = wire({ [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ok(example)] });
    const result = await h.adapter.checkTickets('1SXXXCITUW8P4', CTX);
    expect(result.tickets).toEqual([]);
    expect(result.cancelOffers).toEqual([
      {
        offerRef: 'cb7778589bcbb4hpnkmkhp4ya1',
        kind: 'VOID',
        expiresAt: '2021-03-22T11:53:00.000Z',
      },
    ]);
  });

  it('Category 16 quita la garantía: isRefundable true pasa a unknown', async () => {
    const example = checkExample('The response does not contain errors:', 'Use case 1');
    const [ticket] = example['tickets'] as Json[];
    const penalties = (ticket?.['refundPenalties'] as Json[]).map((p) => ({
      ...p,
      source: 'Category 16',
    }));
    const h = wire({
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [
        ok({ ...example, tickets: [{ ...ticket, refundPenalties: penalties }] }),
      ],
    });
    const [entry] = (await h.adapter.checkTickets(PNR, CTX)).tickets;
    expect(entry?.refundable).toBe('unknown');
    expect(entry?.voidable).toBe('yes');
  });

  it('la tasa de cancelación del reembolso automatizado manda sobre la estimación', async () => {
    const h = wire({
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [
        ok({
          tickets: [
            {
              number: '0016802004060',
              isVoidable: false,
              isRefundable: true,
              refundTotals: { total: '100.00', currencyCode: 'USD' },
              refundFee: { amount: '25.00', currencyCode: 'USD' },
              refundPenalties: [
                {
                  applicability: 'BEFORE_DEPARTURE',
                  penalty: { amount: '80.0', currencyCode: 'USD' },
                },
              ],
            },
          ],
        }),
      ],
    });
    const [entry] = (await h.adapter.checkTickets(PNR, CTX)).tickets;
    expect(entry).toEqual({
      number: '0016802004060',
      voidable: 'no',
      refundable: 'yes',
      refund: { totalMinor: 10000, penaltyMinor: 2500, currency: 'USD' },
    });
  });

  it('lo que el proveedor no dice no se inventa', async () => {
    const h = wire({
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [
        ok({
          tickets: [
            { number: '0016802004060' },
            {
              number: '0016802004061',
              refundTotals: { total: '1.2345', currencyCode: 'USD' },
            },
            { number: '0016802004062', refundTotals: { total: '1000', currencyCode: 'CLP' } },
            { number: 'X' },
          ],
          cancelOffers: [
            { offerItemId: 'OFFER1', offerType: 'CANCEL', offerExpirationDate: '2026-10-14' },
            { offerItemId: 'oferta con espacios', offerType: 'VOID' },
            {
              offerItemId: 'OFFER2',
              offerType: 'REFUND',
              offerExpirationDate: '2026-10-14',
              offerExpirationTime: '25:00',
            },
          ],
        }),
      ],
    });
    const result = await h.adapter.checkTickets(PNR, CTX);
    expect(result.tickets).toEqual([
      { number: '0016802004060', voidable: 'unknown', refundable: 'unknown' },
      { number: '0016802004061', voidable: 'unknown', refundable: 'unknown' },
      {
        number: '0016802004062',
        voidable: 'unknown',
        refundable: 'unknown',
        refund: { totalMinor: 1000, currency: 'CLP' },
      },
    ]);
    expect(result.cancelOffers).toEqual([
      { offerRef: 'OFFER1', kind: 'OTHER' },
      { offerRef: 'OFFER2', kind: 'REFUND' },
    ]);
  });

  it('es una lectura: un 503 transitorio se reintenta', async () => {
    const example = checkExample('The response does not contain errors:', 'Use case 1');
    const h = wire({
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [{ status: 503, body: {} }, ok(example)],
    });
    expect((await h.adapter.checkTickets(PNR, CTX)).tickets).toHaveLength(1);
    expect(h.paths()).toEqual([SABRE_CHECK_FLIGHT_TICKETS_PATH, SABRE_CHECK_FLIGHT_TICKETS_PATH]);
  });

  it('una comprobación con errors[] no se convierte en condiciones', async () => {
    const h = wire({
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [
        ok({ errors: [{ category: 'CHECK_ERROR', type: 'BOOKING_NOT_FULFILLED' }] }),
      ],
    });
    await expect(h.adapter.checkTickets(PNR, CTX)).rejects.toThrow(SabreApiError);
  });
});

// ---------------------------------------------------------------------------------------------
// El expediente
// ---------------------------------------------------------------------------------------------

const BACKSLASH = String.fromCharCode(92);

function checkExample(label: string, after: string): Json {
  const text = readFileSync(
    join(
      findRepoRoot(),
      'docs',
      'sabre',
      'evidence',
      'specs',
      'help',
      'booking-management-api-v1',
      'help-documentation-check-flight-tickets-examples.txt',
    ),
    'utf8',
  );
  const from = text.indexOf(after);
  if (from < 0) throw new Error(`no está la sección «${after}»`);
  const start = text.indexOf('{', text.indexOf(label, from));
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === BACKSLASH) i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Json;
    }
  }
  throw new Error(`bloque JSON sin cerrar tras «${label}»`);
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}
