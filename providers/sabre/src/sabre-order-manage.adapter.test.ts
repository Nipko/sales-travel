import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import type { SearchContext } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import {
  SABRE_CANCEL_BOOKING_PATH,
  SABRE_CHECK_FLIGHT_TICKETS_PATH,
  SabreCancelBookingBuildError,
  readSabreTicketCheck,
} from './booking/cancel.request.builder';
import { SABRE_GET_BOOKING_PATH } from './booking/get.request.builder';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreHttpClient } from './http/sabre-http.client';
import { SabreOrderManageAdapter, cancelOfferFor } from './sabre-order-manage.adapter';

/**
 * ANULAR (VOID) POR LA PUERTA PÚBLICA (SAB-09).
 *
 * El adapter corre sobre un `SabreHttpClient` real con un `fetch` interceptado: se mide la secuencia
 * de rutas y el cuerpo SERIALIZADO de `cancelBooking`. El `fetch` falso sólo contesta lo que el test
 * preparó: si el ACL manda la cancelación cuando no debía, la ruta no está preparada y el test se
 * pone rojo por partida doble (lanza, y la secuencia no coincide).
 *
 * La regla que se prueba: una anulación sólo sale si la comprobación de tiquetes la permite, y sale
 * por el carril que corresponde —el VOID de ATPCO o la oferta VOID de NDC—. La comprobación de NDC
 * es el ejemplo oficial (`help-documentation-check-flight-tickets-examples.txt`, use case 4). Ningún
 * test llama a Sabre.
 */

type Json = Record<string, unknown>;

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'req-void' };
const PNR = 'QWERTY';
/** El Sabre Order ID del ejemplo oficial NDC. */
const NDC_ORDER = '1SXXXCITUW8P4';
/** La oferta VOID del ejemplo oficial, vigente hasta el 2021-03-22 a las 11:53 UTC. */
const NDC_VOID_OFFER = 'cb7778589bcbb4hpnkmkhp4ya1';
const BEFORE_NDC_EXPIRY = Date.parse('2021-03-22T11:00:00.000Z');
const AFTER_NDC_EXPIRY = Date.parse('2021-03-22T11:54:00.000Z');
const NOW_MS = Date.parse('2026-10-13T15:00:00.000Z');
const BACKSLASH = String.fromCharCode(92);

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
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

/** Un bloque JSON del texto oficial de ejemplos, después de `after` y de la etiqueta `label`. */
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

/** Use case 4: la orden NDC entera, todavía en la ventana de anulación. */
const ndcVoidCheck = (): Json => checkExample('There are no errors in the response:', 'Use case 4');

/** La misma comprobación, ya fuera de la ventana: el proveedor ofrece REFUND en lugar de VOID. */
function ndcRefundOnlyCheck(): Json {
  return {
    request: { confirmationId: NDC_ORDER },
    cancelOffers: [
      {
        offerType: 'REFUND',
        offerItemId: 'rf7778589bcbb4hpnkmkhp4ya1',
        offerExpirationDate: '2021-03-29',
        offerExpirationTime: '11:53',
      },
    ],
  };
}

/** La reserva tal como la lee `getBooking`: un vuelo del carril pedido, emitida o no. */
function booking(
  lane: 'ATPCO' | 'NDC' | undefined,
  options: { readonly isTicketed?: boolean; readonly id?: string } = {},
): Json {
  return {
    bookingId: options.id ?? PNR,
    isCancelable: true,
    isTicketed: options.isTicketed ?? true,
    flights: [
      {
        itemId: '1',
        confirmationId: 'AB123',
        airlineCode: 'AV',
        ...(lane === undefined ? {} : { sourceType: lane }),
        flightStatusCode: 'HK',
        flightStatusName: 'Confirmed',
      },
    ],
  };
}

/** `checkFlightTickets` de ATPCO con los tiquetes dados. */
function atpcoCheck(
  tickets: readonly { readonly number: string; readonly isVoidable?: boolean }[],
): Json {
  return {
    timestamp: '2026-10-13T15:00:01',
    request: { confirmationId: PNR },
    tickets: tickets.map((ticket) => ({
      number: ticket.number,
      ...(ticket.isVoidable === undefined ? {} : { isVoidable: ticket.isVoidable }),
      isRefundable: true,
    })),
  };
}

/** Cancelación limpia: sin `errors[]`, con los tiquetes anulados. */
const voided = (): Json => ({
  timestamp: '2026-10-13T15:00:02',
  voidedTickets: ['0016802004060'],
});

// ---------------------------------------------------------------------------------------------
// El arnés
// ---------------------------------------------------------------------------------------------

interface WireCall {
  readonly path: string;
  readonly raw: string;
}

interface LogCall {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

function wire(routes: Record<string, readonly Json[]>, nowMs: number = NOW_MS) {
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
    calls.push({ path, raw: typeof init.body === 'string' ? init.body : '' });
    const next = queues.get(path)?.shift();
    if (next === undefined) {
      throw new Error(`el ACL llamó a ${path}, que este test no preparó (o ya agotó)`);
    }
    return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
  };
  const tokens: SabreTokenProvider = {
    getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
    invalidate: () => Promise.resolve(),
  };
  const cfg = config();
  const http = new SabreHttpClient(cfg, tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const manage = new SabreOrderManageAdapter(cfg, http, { logger, now: () => nowMs });
  return {
    manage,
    logs,
    paths: (): string[] => calls.map((call) => call.path),
    cancelBody: (): Json => {
      const sent = calls.filter((call) => call.path === SABRE_CANCEL_BOOKING_PATH);
      const [only] = sent;
      if (only === undefined || sent.length !== 1) {
        throw new Error(`se esperaba UNA cancelación, hubo ${String(sent.length)}`);
      }
      return JSON.parse(only.raw) as Json;
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<SabreCancelBookingBuildError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof SabreCancelBookingBuildError)) {
    throw new Error(`se esperaba SabreCancelBookingBuildError y llegó ${String(error)}`);
  }
  return error;
}

// ---------------------------------------------------------------------------------------------
// cancelOfferFor
// ---------------------------------------------------------------------------------------------

describe('cancelOfferFor — la oferta VOID vigente, leída y nunca calculada', () => {
  const evidence = (raw: Json) => readSabreTicketCheck(raw, { confirmationId: NDC_ORDER });

  it('el ejemplo oficial dentro de la ventana: la oferta VOID que hay que aplicar', () => {
    expect(
      cancelOfferFor('VOID', evidence(ndcVoidCheck()), new Date(BEFORE_NDC_EXPIRY).toISOString()),
    ).toBe(NDC_VOID_OFFER);
  });

  it('la ventana se mide hasta el minuto que da el proveedor, en UTC', () => {
    expect(cancelOfferFor('VOID', evidence(ndcVoidCheck()), '2021-03-22T11:53:00.000Z')).toBe(
      NDC_VOID_OFFER,
    );
    expect(() =>
      cancelOfferFor('VOID', evidence(ndcVoidCheck()), new Date(AFTER_NDC_EXPIRY).toISOString()),
    ).toThrow(/VOID_NOT_AVAILABLE/);
  });

  it('fuera de la ventana el proveedor sólo ofrece REFUND: no hay VOID que elegir', () => {
    const error = (() => {
      try {
        cancelOfferFor('VOID', evidence(ndcRefundOnlyCheck()), '2021-03-22T11:00:00.000Z');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(SabreCancelBookingBuildError);
    expect((error as SabreCancelBookingBuildError).rule).toBe('VOID_NOT_AVAILABLE');
  });

  it('una VOID listada después de una REFUND se encuentra igual', () => {
    const raw = ndcRefundOnlyCheck();
    const offers = [
      ...(raw['cancelOffers'] as Json[]),
      ...(ndcVoidCheck()['cancelOffers'] as Json[]),
    ];
    expect(
      cancelOfferFor('VOID', evidence({ ...raw, cancelOffers: offers }), '2021-03-22T11:00:00Z'),
    ).toBe(NDC_VOID_OFFER);
  });

  it('una VOID sin caducidad declarada vale: el proveedor no puso fin', () => {
    const raw = {
      request: { confirmationId: NDC_ORDER },
      cancelOffers: [{ offerType: 'VOID', offerItemId: 'sinfecha1' }],
    };
    expect(cancelOfferFor('VOID', evidence(raw), '2030-01-01T00:00:00Z')).toBe('sinfecha1');
  });

  it('una oferta de otro tipo con forma de VOID no cuenta: el tipo es exacto', () => {
    const raw = {
      request: { confirmationId: NDC_ORDER },
      cancelOffers: [{ offerType: 'void', offerItemId: 'minusculas' }],
    };
    expect(() => cancelOfferFor('VOID', evidence(raw), '2021-03-22T11:00:00Z')).toThrow(
      /VOID_NOT_AVAILABLE/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// cancelBooking con ticketOperation: 'VOID'
// ---------------------------------------------------------------------------------------------

describe('anular ATPCO: VOID sólo si cada tiquete es isVoidable', () => {
  it('todos anulables: lee, comprueba y manda flightTicketOperation VOID', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [booking('ATPCO')],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [
        atpcoCheck([
          { number: '0016802004060', isVoidable: true },
          { number: '0016802004061', isVoidable: true },
        ]),
      ],
      [SABRE_CANCEL_BOOKING_PATH]: [voided()],
    });

    const outcome = await h.manage.cancelBooking(PNR, CTX, { ticketOperation: 'VOID' });

    expect(h.paths()).toEqual([
      SABRE_GET_BOOKING_PATH,
      SABRE_CHECK_FLIGHT_TICKETS_PATH,
      SABRE_CANCEL_BOOKING_PATH,
    ]);
    const body = h.cancelBody();
    expect(body['flightTicketOperation']).toBe('VOID');
    expect(body).not.toHaveProperty('offerItemId');
    expect(body['cancelAll']).toBe(true);
    expect(body['errorHandlingPolicy']).toBe('HALT_ON_ERROR');
    expect(outcome.result.success).toBe(true);
    expect(outcome.detail.voidedTickets).toEqual(['0016802004060']);
    expect(outcome.ticketCheckPerformed).toBe(true);
  });

  it.each([
    ['un tiquete ya no es anulable', [{ number: '0016802004060', isVoidable: false }]],
    [
      'uno sí y otro no',
      [
        { number: '0016802004060', isVoidable: true },
        { number: '0016802004061', isVoidable: false },
      ],
    ],
    ['el proveedor no dice si es anulable', [{ number: '0016802004060' }]],
    ['la comprobación no trae tiquetes', []],
  ] as const)('%s: VOID_NOT_AVAILABLE y la cancelación no sale', async (_caso, tickets) => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [booking('ATPCO')],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [atpcoCheck(tickets)],
      [SABRE_CANCEL_BOOKING_PATH]: [voided()],
    });

    const error = await refusal(h.manage.cancelBooking(PNR, CTX, { ticketOperation: 'VOID' }));

    expect(error.rule).toBe('VOID_NOT_AVAILABLE');
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_CHECK_FLIGHT_TICKETS_PATH]);
  });

  it('aunque la lectura no la dé por emitida, un VOID nunca sale sin la comprobación', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [booking('ATPCO', { isTicketed: false })],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [atpcoCheck([{ number: '0016802004060' }])],
      [SABRE_CANCEL_BOOKING_PATH]: [voided()],
    });

    await refusal(h.manage.cancelBooking(PNR, CTX, { ticketOperation: 'VOID' }));
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_CHECK_FLIGHT_TICKETS_PATH]);
  });

  it('un vuelo sin carril declarado no se anula por la vía ATPCO sin isVoidable (fail-closed)', async () => {
    const h = wire({
      [SABRE_GET_BOOKING_PATH]: [booking(undefined)],
      [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ndcVoidCheck()],
      [SABRE_CANCEL_BOOKING_PATH]: [voided()],
    });

    const error = await refusal(
      h.manage.cancelBooking(NDC_ORDER, CTX, { ticketOperation: 'VOID' }),
    );
    expect(error.rule).toBe('VOID_NOT_AVAILABLE');
    expect(h.paths()).not.toContain(SABRE_CANCEL_BOOKING_PATH);
  });
});

describe('anular NDC: por la oferta VOID de la comprobación, nunca por flightTicketOperation', () => {
  it('el ejemplo oficial dentro de la ventana: la oferta viaja en offerItemId', async () => {
    const h = wire(
      {
        [SABRE_GET_BOOKING_PATH]: [booking('NDC', { id: NDC_ORDER })],
        [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ndcVoidCheck()],
        [SABRE_CANCEL_BOOKING_PATH]: [{ timestamp: '2021-03-22T11:00:02' }],
      },
      BEFORE_NDC_EXPIRY,
    );

    const outcome = await h.manage.cancelBooking(NDC_ORDER, CTX, { ticketOperation: 'VOID' });

    expect(h.paths()).toEqual([
      SABRE_GET_BOOKING_PATH,
      SABRE_CHECK_FLIGHT_TICKETS_PATH,
      SABRE_CANCEL_BOOKING_PATH,
    ]);
    const body = h.cancelBody();
    expect(body['offerItemId']).toBe(NDC_VOID_OFFER);
    // Son excluyentes en el contrato (`INVALID_FLAGS_COMBINATION`).
    expect(body).not.toHaveProperty('flightTicketOperation');
    expect(outcome.result.success).toBe(true);
    // El log dice que hubo oferta, nunca cuál ni de qué reserva.
    const log = JSON.stringify(h.logs);
    expect(log).not.toContain(NDC_VOID_OFFER);
    expect(log).not.toContain(NDC_ORDER);
  });

  it('pasada la caducidad de la oferta: VOID_NOT_AVAILABLE y la cancelación no sale', async () => {
    const h = wire(
      {
        [SABRE_GET_BOOKING_PATH]: [booking('NDC', { id: NDC_ORDER })],
        [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ndcVoidCheck()],
        [SABRE_CANCEL_BOOKING_PATH]: [{ timestamp: '2021-03-22T12:00:02' }],
      },
      AFTER_NDC_EXPIRY,
    );

    const error = await refusal(
      h.manage.cancelBooking(NDC_ORDER, CTX, { ticketOperation: 'VOID' }),
    );
    expect(error.rule).toBe('VOID_NOT_AVAILABLE');
    expect(h.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_CHECK_FLIGHT_TICKETS_PATH]);
  });

  it('sólo con la oferta REFUND tampoco: anular no es reembolsar', async () => {
    const h = wire(
      {
        [SABRE_GET_BOOKING_PATH]: [booking('NDC', { id: NDC_ORDER })],
        [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ndcRefundOnlyCheck()],
        [SABRE_CANCEL_BOOKING_PATH]: [{ timestamp: '2021-03-22T11:00:02' }],
      },
      BEFORE_NDC_EXPIRY,
    );

    await refusal(h.manage.cancelBooking(NDC_ORDER, CTX, { ticketOperation: 'VOID' }));
    expect(h.paths()).not.toContain(SABRE_CANCEL_BOOKING_PATH);
  });

  it('una oferta elegida a mano sigue su camino: el adapter no la cambia', async () => {
    const h = wire(
      {
        [SABRE_GET_BOOKING_PATH]: [booking('NDC', { id: NDC_ORDER })],
        [SABRE_CHECK_FLIGHT_TICKETS_PATH]: [ndcVoidCheck()],
        [SABRE_CANCEL_BOOKING_PATH]: [{ timestamp: '2021-03-22T11:00:02' }],
      },
      BEFORE_NDC_EXPIRY,
    );

    await h.manage.cancelBooking(NDC_ORDER, CTX, { offerItemId: NDC_VOID_OFFER });
    expect(h.cancelBody()['offerItemId']).toBe(NDC_VOID_OFFER);
  });
});
