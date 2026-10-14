import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import type { OrderModifyRef, SearchContext, TravelerChange } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_EXTRA_FEATURES, SABRE_GET_BOOKING_PATH } from './booking/get.request.builder';
import {
  SABRE_MODIFY_BOOKING_PATH,
  SabreModifyBookingBuildError,
} from './booking/modify.request.builder';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreHttpClient } from './http/sabre-http.client';
import { SABRE_MODIFY_MAX_ATTEMPTS, SabreOrderManageAdapter } from './sabre-order-manage.adapter';

/**
 * MODIFICAR LOS PASAJEROS POR LA PUERTA PÚBLICA (SAB-25, RF-17).
 *
 * El adapter corre sobre un `SabreHttpClient` real con un `fetch` interceptado: se mide la secuencia
 * de rutas, los cuerpos SERIALIZADOS y lo que llega al log. El `fetch` falso sólo contesta lo que
 * el test preparó: una llamada de más pone el test rojo.
 *
 * Lo que se prueba:
 *
 *  - read-modify-write: cada `modifyBooking` sale con la firma de SU lectura, sin `returnOnly`, y
 *    con el perfil de `extraFeatures` de esa lectura;
 *  - firma vieja → lectura nueva, hasta {@link SABRE_MODIFY_MAX_ATTEMPTS} escrituras;
 *  - el desenlace se VERIFICA contra la reserva, y lo que la reserva no muestra no se da por hecho;
 *  - ni el pasaporte, ni el viajero frecuente, ni el apellido, ni la firma llegan al log.
 *
 * La reserva es la del ejemplo oficial de pasaporte ATPCO
 * (`help-documentation-modify-booking-examples-0.txt`). Ningún test llama a Sabre.
 */

type Json = Record<string, unknown>;
const BACKSLASH = String.fromCharCode(92);
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'op-modify' };
const PNR = 'OFGBRU';
const OLD_PASSPORT = '987765452';
const NEW_PASSPORT = 'AB1234567';
const FF_NUMBER = '55667788';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

function officialBlock(section: string, label: string): Json {
  const text = readFileSync(
    join(
      findRepoRoot(),
      'docs',
      'sabre',
      'evidence',
      'specs',
      'help',
      'booking-management-api-v1',
      'help-documentation-modify-booking-examples-0.txt',
    ),
    'utf8',
  );
  const from = text.indexOf(section);
  if (from < 0) throw new Error(`no está la sección «${section}»`);
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

/** El `booking` del ejemplo oficial: un adulto, su pasaporte, el DOCS y un OTHS de la aerolínea. */
function officialBooking(): Json {
  const response = officialBlock(
    'modify identity document details (PASSPORT)',
    'The expected response is presented by the following snippet:',
  );
  return response['booking'] as Json;
}

/** `getBooking` sin `returnOnly`: la reserva, su firma y el eco de la request (con el apellido). */
function fullRead(signature: string, mutate: (booking: Json) => void = () => undefined): Json {
  const booking = officialBooking();
  mutate(booking);
  return {
    ...booking,
    bookingSignature: signature,
    timestamp: '2026-10-14T12:00:00Z',
    request: { confirmationId: PNR, surname: 'DOE' },
  };
}

/** La lectura de display con `TRAVELERS` y `SPECIAL_SERVICES`, sin firma. */
function displayRead(mutate: (booking: Json) => void = () => undefined): Json {
  const booking = officialBooking();
  mutate(booking);
  return { travelers: booking['travelers'], specialServices: booking['specialServices'] };
}

function traveler(booking: Json): Json {
  return (booking['travelers'] as Json[])[0] as Json;
}

/** Deja la reserva con el pasaporte nuevo, como la dejaría un `modifyBooking` que salió bien. */
function withNewPassport(booking: Json): void {
  const doc = (traveler(booking)['identityDocuments'] as Json[])[0] as Json;
  doc['documentNumber'] = NEW_PASSPORT;
  doc['issuingCountryCode'] = 'CO';
  doc['citizenshipCountryCode'] = 'CO';
  doc['expiryDate'] = '2034-05-31';
}

function withFrequentFlyer(booking: Json): void {
  traveler(booking)['loyaltyPrograms'] = [{ supplierCode: 'AV', programNumber: FF_NUMBER }];
}

/** `modifyBooking` limpio con la reserva cambiada (`retrieveBooking: true`) y el eco entero. */
function modified(mutate: (booking: Json) => void, sentBody?: Json): Json {
  const booking = officialBooking();
  mutate(booking);
  return { timestamp: '2026-10-14T12:00:01Z', booking, request: sentBody ?? {} };
}

function sabreErrors(...errors: { category: string; type: string; fieldValue?: string }[]): Json {
  return {
    timestamp: '2026-10-14T12:00:01Z',
    errors: errors.map((error) => ({
      ...error,
      description: `Problema con el pasajero DOE/JOHN ${OLD_PASSPORT}`,
      fieldPath: 'ModifyBookingRequest.after.travelers[0].identityDocuments[0].documentNumber',
    })),
  };
}

const PASSPORT_CHANGE: TravelerChange = {
  index: 0,
  identityDocument: {
    type: 'PASSPORT',
    number: NEW_PASSPORT,
    issuingCountry: 'CO',
    nationality: 'CO',
    expiryDate: '2034-05-31',
  },
};

const ORDER: OrderModifyRef = {
  orderId: PNR,
  contentSource: 'ATPCO',
  passengers: [{ paxType: 'ADT', surname: 'Doe', gender: 'M' }],
};

// ---------------------------------------------------------------------------------------------
// El arnés
// ---------------------------------------------------------------------------------------------

type Reply = { readonly status?: number; readonly body: Json } | { readonly abort: true };

interface WireCall {
  readonly path: string;
  readonly body: Json;
}

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

function wire(routes: Record<string, readonly Reply[]>) {
  const calls: WireCall[] = [];
  const logs: { level: string; message: string; meta: unknown }[] = [];
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
      body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Json,
    });
    const next = queues.get(path)?.shift();
    if (next === undefined) {
      throw new Error(`el ACL llamó a ${path}, que este test no preparó (o ya agotó)`);
    }
    if ('abort' in next) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status ?? 200 }));
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
  const manage = new SabreOrderManageAdapter(cfg, http, {
    logger,
    now: () => Date.parse('2026-10-14T12:00:00Z'),
  });
  return {
    manage,
    calls,
    logs,
    paths: (): string[] => calls.map((call) => call.path),
    modifies: (): Json[] =>
      calls.filter((call) => call.path === SABRE_MODIFY_BOOKING_PATH).map((call) => call.body),
    reads: (): Json[] =>
      calls.filter((call) => call.path === SABRE_GET_BOOKING_PATH).map((call) => call.body),
  };
}

const ok = (body: Json): Reply => ({ body });

/** Nada de lo sensible en el log: ni números, ni nombres, ni la firma. */
function expectCleanLogs(logs: readonly { meta: unknown; message: string }[]): void {
  const text = JSON.stringify(logs);
  for (const secret of [
    NEW_PASSPORT,
    OLD_PASSPORT,
    FF_NUMBER,
    'DOE',
    'JOHN',
    'SIG-1',
    'SIG-2',
    'SIG-3',
    'ATK-SUPERSECRETO',
  ]) {
    expect(text, `el log tiene «${secret}»`).not.toContain(secret);
  }
}

describe('read-modify-write: una escritura con la firma de su lectura', () => {
  it('lee sin returnOnly, escribe con esa firma y ese perfil, y verifica con la reserva de la respuesta', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1'))],
      [SABRE_MODIFY_BOOKING_PATH]: [ok(modified(withNewPassport))],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);

    expect(result).toEqual({
      outcome: 'MODIFIED',
      unchanged: false,
      applied: [{ index: 0, field: 'identityDocuments' }],
      pending: [],
      attempts: 1,
      issues: [],
    });
    expect(w.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_MODIFY_BOOKING_PATH]);

    const [read] = w.reads();
    expect(read).not.toHaveProperty('returnOnly');
    expect(read?.['extraFeatures']).toEqual({ ...SABRE_EXTRA_FEATURES });

    const [body] = w.modifies();
    expect(body?.['bookingSignature']).toBe('SIG-1');
    expect(body?.['confirmationId']).toBe(PNR);
    expect(body?.['retrieveBooking']).toBe(true);
    expect(body?.['extraFeatures']).toEqual({
      returnFrequentRenter: SABRE_EXTRA_FEATURES.returnFrequentRenter,
      returnWalletFormsOfPayment: SABRE_EXTRA_FEATURES.returnWalletFormsOfPayment,
      returnFiscalId: SABRE_EXTRA_FEATURES.returnFiscalId,
    });
    // `before` es la lectura: los pasajeros y los SSR tal cual vinieron.
    const official = officialBooking();
    expect((body?.['before'] as Json)['travelers']).toEqual(official['travelers']);
    expect((body?.['before'] as Json)['specialServices']).toEqual(official['specialServices']);
    expectCleanLogs(w.logs);
  });

  it('un segundo cambio vuelve a leer: modifyBooking no devuelve firma nueva', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(fullRead('SIG-2', withNewPassport))],
      [SABRE_MODIFY_BOOKING_PATH]: [
        ok(modified(withNewPassport)),
        ok(
          modified((booking) => {
            withNewPassport(booking);
            withFrequentFlyer(booking);
          }),
        ),
      ],
    });
    await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    const second = await w.manage.modifyTravelers(
      ORDER,
      [{ index: 0, loyalty: { carrierCode: 'AV', number: FF_NUMBER } }],
      CTX,
    );
    expect(second.outcome).toBe('MODIFIED');
    expect(w.paths()).toEqual([
      SABRE_GET_BOOKING_PATH,
      SABRE_MODIFY_BOOKING_PATH,
      SABRE_GET_BOOKING_PATH,
      SABRE_MODIFY_BOOKING_PATH,
    ]);
    expect(w.modifies().map((body) => body['bookingSignature'])).toEqual(['SIG-1', 'SIG-2']);
    // El segundo `before` es la reserva YA cambiada: el pasaporte nuevo no se pisa con el viejo.
    const before = (w.modifies()[1]?.['before'] as Json)['travelers'] as Json[];
    expect(JSON.stringify(before)).toContain(NEW_PASSPORT);
    expect(JSON.stringify(w.modifies()[1]?.['after'])).toContain(NEW_PASSPORT);
  });

  it('la reserva ya tiene lo pedido: lee y no escribe', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [
        ok(
          fullRead('SIG-1', (booking) => {
            withNewPassport(booking);
          }),
        ),
      ],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({ outcome: 'MODIFIED', unchanged: true, attempts: 0 });
    expect(w.paths()).toEqual([SABRE_GET_BOOKING_PATH]);
  });
});

describe('firma vieja: lectura nueva y otro intento, con tope', () => {
  const signatureError = (): Reply => ({
    body: sabreErrors({
      category: 'APPLICATION_ERROR',
      type: 'UNABLE_TO_MODIFY_BOOKING_WRONG_SIGNATURE',
    }),
  });

  it('una firma vieja no aplicó nada: relee, reconstruye y vuelve a mandar con la firma nueva', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(fullRead('SIG-2'))],
      [SABRE_MODIFY_BOOKING_PATH]: [signatureError(), ok(modified(withNewPassport))],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({ outcome: 'MODIFIED', attempts: 2 });
    expect(w.modifies().map((body) => body['bookingSignature'])).toEqual(['SIG-1', 'SIG-2']);
    expectCleanLogs(w.logs);
  });

  it(`a la ${String(SABRE_MODIFY_MAX_ATTEMPTS)}ª firma vieja se rinde: FAILED por cambio concurrente, sin verificar`, async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [
        ok(fullRead('SIG-1')),
        ok(fullRead('SIG-2')),
        ok(fullRead('SIG-3')),
      ],
      [SABRE_MODIFY_BOOKING_PATH]: [signatureError(), signatureError(), signatureError()],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({
      outcome: 'FAILED',
      failureReason: 'CONCURRENT_CHANGE',
      attempts: SABRE_MODIFY_MAX_ATTEMPTS,
      applied: [],
      pending: [{ index: 0, field: 'identityDocuments' }],
    });
    expect(w.modifies()).toHaveLength(SABRE_MODIFY_MAX_ATTEMPTS);
    expect(w.reads()).toHaveLength(SABRE_MODIFY_MAX_ATTEMPTS);
  });
});

describe('el desenlace se verifica contra la reserva', () => {
  it('BAD_REQUEST: no se ejecutó; FAILED sin otra lectura y sin el valor que Sabre devolvió', async () => {
    // La capa de aplicación contesta HTTP 200 con `errors[]` (`errors.ts`, cabecera).
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1'))],
      [SABRE_MODIFY_BOOKING_PATH]: [
        ok(
          sabreErrors({ category: 'BAD_REQUEST', type: 'INVALID_VALUE', fieldValue: NEW_PASSPORT }),
        ),
      ],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({ outcome: 'FAILED', failureReason: 'REJECTED', applied: [] });
    expect(result.issues).toEqual([
      expect.objectContaining({ category: 'BAD_REQUEST', type: 'INVALID_VALUE' }),
    ]);
    expect(JSON.stringify(result)).not.toContain(NEW_PASSPORT);
    expect(w.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_MODIFY_BOOKING_PATH]);
    expectCleanLogs(w.logs);
  });

  it('un 4xx del gateway (token, cuota, petición): no se ejecutó; FAILED sin otra lectura', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1'))],
      [SABRE_MODIFY_BOOKING_PATH]: [
        { status: 400, body: { status: 'NotProcessed', message: 'bad' } },
      ],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({ outcome: 'FAILED', failureReason: 'REJECTED' });
    expect(w.paths()).toEqual([SABRE_GET_BOOKING_PATH, SABRE_MODIFY_BOOKING_PATH]);
  });

  it('un rechazo de la aerolínea y la reserva sin nada de lo pedido: FAILED', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(displayRead())],
      [SABRE_MODIFY_BOOKING_PATH]: [
        ok(
          sabreErrors({
            category: 'APPLICATION_ERROR',
            type: 'UNABLE_TO_UPDATE_RESERVATION_LOYALTY_NOT_ACCEPTED',
          }),
        ),
      ],
    });
    const result = await w.manage.modifyTravelers(
      ORDER,
      [{ index: 0, loyalty: { carrierCode: 'AV', number: FF_NUMBER } }],
      CTX,
    );
    expect(result).toMatchObject({
      outcome: 'FAILED',
      failureReason: 'REJECTED',
      pending: [{ index: 0, field: 'loyalty' }],
    });
    expect(w.reads()[1]?.['returnOnly']).toEqual(['TRAVELERS', 'SPECIAL_SERVICES']);
  });

  it('un rechazo con una parte aplicada: UNVERIFIED, con lo que quedó y lo que no', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(displayRead(withNewPassport))],
      [SABRE_MODIFY_BOOKING_PATH]: [
        ok(
          sabreErrors({
            category: 'APPLICATION_ERROR',
            type: 'UNABLE_TO_UPDATE_RESERVATION_LOYALTY_NOT_ACCEPTED',
          }),
        ),
      ],
    });
    const result = await w.manage.modifyTravelers(
      ORDER,
      [{ ...PASSPORT_CHANGE, loyalty: { carrierCode: 'AV', number: FF_NUMBER } }],
      CTX,
    );
    expect(result).toMatchObject({
      outcome: 'UNVERIFIED',
      applied: [{ index: 0, field: 'identityDocuments' }],
      pending: [{ index: 0, field: 'loyalty' }],
    });
  });

  it('un corte de red después de mandar: si la reserva lo muestra, quedó', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(displayRead(withNewPassport))],
      [SABRE_MODIFY_BOOKING_PATH]: [{ abort: true }],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({ outcome: 'MODIFIED', attempts: 1 });
  });

  it('un corte de red y la reserva sin el cambio: UNVERIFIED, nunca FAILED (puede llegar después)', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(displayRead())],
      [SABRE_MODIFY_BOOKING_PATH]: [{ abort: true }],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({
      outcome: 'UNVERIFIED',
      applied: [],
      pending: [{ index: 0, field: 'identityDocuments' }],
    });
  });

  it('un tiempo agotado de Sabre (TIMEOUT) tampoco se da por fallido', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(displayRead())],
      [SABRE_MODIFY_BOOKING_PATH]: [
        ok(sabreErrors({ category: 'APPLICATION_ERROR', type: 'TIMEOUT' })),
      ],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result.outcome).toBe('UNVERIFIED');
  });

  it('2xx sin la reserva en la respuesta: se relee para saber si quedó', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(displayRead(withNewPassport))],
      [SABRE_MODIFY_BOOKING_PATH]: [ok({ timestamp: '2026-10-14T12:00:01Z' })],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result.outcome).toBe('MODIFIED');
    expect(w.paths()).toEqual([
      SABRE_GET_BOOKING_PATH,
      SABRE_MODIFY_BOOKING_PATH,
      SABRE_GET_BOOKING_PATH,
    ]);
  });

  it('2xx cuya reserva no muestra el cambio, ni la relectura: UNVERIFIED', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), ok(displayRead())],
      [SABRE_MODIFY_BOOKING_PATH]: [ok(modified(() => undefined))],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({ outcome: 'UNVERIFIED', applied: [] });
  });

  it('2xx sin reserva y la relectura falla: UNVERIFIED con todo pendiente', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1')), { status: 503, body: { message: 'down' } }],
      [SABRE_MODIFY_BOOKING_PATH]: [ok({ timestamp: '2026-10-14T12:00:01Z' })],
    });
    const result = await w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX);
    expect(result).toMatchObject({
      outcome: 'UNVERIFIED',
      pending: [{ index: 0, field: 'identityDocuments' }],
    });
  });
});

describe('lo que lanza: nada se escribió', () => {
  it('una lectura sin firma no arma nada', async () => {
    const read = fullRead('SIG-1');
    delete read['bookingSignature'];
    const w = wire({ [SABRE_GET_BOOKING_PATH]: [ok(read)] });
    await expect(w.manage.modifyTravelers(ORDER, [PASSPORT_CHANGE], CTX)).rejects.toBeInstanceOf(
      SabreModifyBookingBuildError,
    );
    expect(w.modifies()).toHaveLength(0);
  });

  it('pasajeros que no casan con la reserva: se rechaza sin escribir', async () => {
    const w = wire({ [SABRE_GET_BOOKING_PATH]: [ok(fullRead('SIG-1'))] });
    await expect(
      w.manage.modifyTravelers(
        { ...ORDER, passengers: [{ paxType: 'ADT', surname: 'Smith' }] },
        [PASSPORT_CHANGE],
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'TRAVELER_MISMATCH' });
    expect(w.modifies()).toHaveLength(0);
  });

  it('un cambio inválido se rechaza antes de leer', async () => {
    const w = wire({});
    await expect(
      w.manage.modifyTravelers(ORDER, [{ index: 0, specialServices: ['XBAG' as 'WCHR'] }], CTX),
    ).rejects.toMatchObject({ code: 'INVALID_CHANGE' });
    expect(w.calls).toHaveLength(0);
  });
});

describe('readTravelers: la reserva enmascarada', () => {
  it('una lectura de display con vuelos, pasajeros y SSR; los números salen por sus últimos caracteres', async () => {
    const w = wire({
      [SABRE_GET_BOOKING_PATH]: [
        ok({
          ...officialBooking(),
          request: { confirmationId: PNR },
          travelers: (() => {
            const booking = officialBooking();
            withFrequentFlyer(booking);
            return booking['travelers'];
          })(),
          specialServices: [
            ...(officialBooking()['specialServices'] as Json[]),
            { code: 'WCHR', travelerIndices: [1], statusCode: 'NN' },
          ],
        }),
      ],
    });
    const view = await w.manage.readTravelers(ORDER, CTX);
    expect(w.reads()[0]?.['returnOnly']).toEqual(['FLIGHTS', 'TRAVELERS', 'SPECIAL_SERVICES']);
    expect(view).toEqual({
      travelers: [
        {
          index: 0,
          documents: [
            {
              type: 'PASSPORT',
              numberLast4: '5452',
              issuingCountry: 'US',
              expiryDate: '2024-07-09',
            },
          ],
          loyalty: [{ carrierCode: 'AV', numberLast4: '7788' }],
          specialServices: ['WCHR'],
        },
      ],
      supported: ['identityDocuments', 'loyalty', 'specialServices'],
      warnings: [],
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain(OLD_PASSPORT);
    expect(text).not.toContain(FF_NUMBER);
    expect(text).not.toContain('DOE');
    expectCleanLogs(w.logs);
  });

  it('una reserva NDC no ofrece servicios especiales', async () => {
    const booking = officialBooking();
    ((booking['flights'] as Json[])[0] as Json)['sourceType'] = 'NDC';
    const w = wire({ [SABRE_GET_BOOKING_PATH]: [ok(booking)] });
    const view = await w.manage.readTravelers(ORDER, CTX);
    expect(view.supported).toEqual(['identityDocuments', 'loyalty']);
  });

  it('supportedModifications declara los tres campos y nada de BookingToModify que no se use', () => {
    const w = wire({});
    expect(w.manage.supportedModifications()).toEqual([
      'identityDocuments',
      'loyalty',
      'specialServices',
    ]);
  });
});
