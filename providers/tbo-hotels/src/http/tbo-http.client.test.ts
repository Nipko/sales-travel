import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TBO_BASE_URLS, parseTboConfig, type TboHotelsConfig } from '../config';
import {
  TBO_FAILURE_KINDS,
  TboApiError,
  TboCancelMappingError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboRequestBuildError,
  TboResponseMappingError,
} from '../errors';
import { TboInMemoryRateLimiter, type TboLimiterRequest, type TboRateLimiter } from './limiter';
import { TBO_OPERATIONS, type TboOperationName } from './operations';
import {
  TboHttpClient,
  tboAccountRef,
  tboBackoffDelayMs,
  type TboAccountContext,
  type TboFetch,
  type TboHttpDeps,
  type TboPayloadRecord,
} from './tbo-http.client';

/**
 * El cliente por su puerta pública, con `fetch` espiado (06 §7.3): lo que se mide es lo que sale al
 * cable (`init`) y lo que llega al logger, no el estado interno.
 */

// Valores con forma reconocible para buscarlos en cualquier salida. No son credenciales.
const USERNAME = 'agencia-demo';
const PASSWORD = ' Pa55 w0rd!é ';
const TOKEN = Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf8').toString('base64');
const BASIC = `Basic ${TOKEN}`;
const REQUEST_ID = '00000000-0000-4000-8000-0000000000aa';

const NAMES = Object.keys(TBO_OPERATIONS) as TboOperationName[];

function config(overrides: Record<string, unknown> = {}): TboHotelsConfig {
  return parseTboConfig({
    environment: 'test',
    username: USERNAME,
    password: PASSWORD,
    ...overrides,
  });
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

type Responder = (call: FetchCall) => Response | Promise<Response>;

/** Responde con cada `responder` en orden; el último se repite. */
function spyFetch(...responders: Responder[]): { fetch: TboFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: TboFetch = (url, init) => {
    const call = { url, init };
    calls.push(call);
    const responder = responders[Math.min(calls.length, responders.length) - 1];
    if (responder === undefined) throw new Error('spyFetch sin respuestas');
    return Promise.resolve(responder(call));
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Responder {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

const OK = json({ Status: { Code: 200, Description: 'Successful' } });

/** Un `fetch` que nunca responde y rechaza cuando se dispara su señal, como el de verdad. */
const hangingFetch: Responder = (call) =>
  new Promise<Response>((_, reject) => {
    call.init.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
  });

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

interface MetricCall {
  readonly kind: 'counter' | 'gauge' | 'histogram';
  readonly name: string;
  readonly value: number | undefined;
  readonly tags: Record<string, string> | undefined;
}

function spyMetrics(): { metrics: MetricsPort; calls: MetricCall[] } {
  const calls: MetricCall[] = [];
  const metrics: MetricsPort = {
    counter: (name, value, tags) => calls.push({ kind: 'counter', name, value, tags }),
    gauge: (name, value, tags) => calls.push({ kind: 'gauge', name, value, tags }),
    histogram: (name, value, tags) => calls.push({ kind: 'histogram', name, value, tags }),
  };
  return { metrics, calls };
}

/**
 * El limitador real, con cupos holgados: los tests de reintentos no pueden esperar la ventana de
 * 1 s del cupo de fondo. El comportamiento del limitador se prueba en `limiter.test.ts`.
 */
function roomyLimiter(): TboInMemoryRateLimiter {
  return new TboInMemoryRateLimiter({
    maxQps: 1_000,
    maxConcurrent: 100,
    background: { qps: 1_000, concurrent: 100 },
  });
}

function client(
  deps: TboHttpDeps = {},
  cfg: TboHotelsConfig = config(),
  context: TboAccountContext = {},
): TboHttpClient {
  return new TboHttpClient(
    cfg,
    {
      sleep: () => Promise.resolve(),
      random: () => 0,
      uuid: () => REQUEST_ID,
      limiter: roomyLimiter(),
      ...deps,
    },
    context,
  );
}

function bodyFor(operation: TboOperationName): unknown {
  return TBO_OPERATIONS[operation].method === 'GET' ? undefined : { probe: 1 };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('la llamada debía fallar y no falló');
}

async function apiError(promise: Promise<unknown>): Promise<TboApiError> {
  const err = await failure(promise);
  if (err instanceof TboApiError) return err;
  throw new Error(`se esperaba TboApiError y llegó ${String(err)}`);
}

// ---------------------------------------------------------------------------------------------
// 08 RF-03 CA-1: una fila de 01 §8.3 y §8.4 por caso, desde los fixtures
// ---------------------------------------------------------------------------------------------

const FixtureSchema = z
  .object({
    row: z.string().min(1),
    source: z.string().min(1),
    operation: z.enum(NAMES as [TboOperationName, ...TboOperationName[]]),
    response: z.union([
      z.object({ network: z.enum(['refused', 'timeout']) }).strict(),
      z
        .object({
          status: z.number().int(),
          headers: z.record(z.string()).optional(),
          bodyJson: z.unknown().optional(),
          bodyText: z.string().optional(),
        })
        .strict()
        .refine((r) => (r.bodyJson === undefined) !== (r.bodyText === undefined), {
          message: 'bodyJson o bodyText, uno de los dos',
        }),
    ]),
    responseSchema: z.record(z.enum(['string', 'array'])).optional(),
    expect: z.union([
      z
        .object({
          outcome: z.enum(['SUCCESS', 'NO_AVAILABILITY']),
          status: z.number().int(),
          tboCode: z.number().int().nullable(),
        })
        .strict(),
      z
        .object({
          error: z.literal('TboApiError'),
          kind: z.enum(TBO_FAILURE_KINDS),
          status: z.number().int(),
          tboCode: z.number().int().nullable(),
          timedOut: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          error: z.enum(['TboResponseMappingError', 'TboCancelMappingError']),
          issues: z.array(z.string()),
        })
        .strict(),
    ]),
  })
  .strict();

type EnvelopeFixture = z.infer<typeof FixtureSchema>;

const FIXTURE_DIR = join(__dirname, '..', '__fixtures__', 'envelope');
const FIXTURES: readonly [string, EnvelopeFixture][] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => [
    file,
    FixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'))),
  ]);

function responderFor(fixture: EnvelopeFixture): Responder {
  const { response } = fixture;
  if ('network' in response) {
    return () => Promise.reject(new TypeError('fetch failed'));
  }
  const text =
    response.bodyText ?? (response.bodyJson === undefined ? '' : JSON.stringify(response.bodyJson));
  return () =>
    new Response(text, {
      status: response.status,
      ...(response.headers === undefined ? {} : { headers: response.headers }),
    });
}

function schemaFor(fixture: EnvelopeFixture): z.ZodTypeAny | undefined {
  if (fixture.responseSchema === undefined) return undefined;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, type] of Object.entries(fixture.responseSchema)) {
    shape[key] = type === 'string' ? z.string() : z.array(z.unknown());
  }
  return z.object(shape).passthrough();
}

describe('las filas de 01 §8.3 y §8.4, por la puerta pública (08 RF-03 CA-1)', () => {
  it('hay un fixture por cada código del contrato y por cada fila de 01 §8.4', () => {
    const codes = new Set(
      FIXTURES.map(([, fx]) => fx.expect).flatMap((e) =>
        'tboCode' in e && e.tboCode !== null ? [e.tboCode] : [],
      ),
    );
    for (const code of [200, 201, 207, 315, 300, 402, 401, 400, 405, 479, 429, 500]) {
      expect(codes, `falta un fixture con Status.Code ${code}`).toContain(code);
    }
    expect(FIXTURES.filter(([file]) => file.startsWith('84-')).length).toBeGreaterThanOrEqual(13);
  });

  it.each(FIXTURES)('%s', async (_file, fixture) => {
    const { fetch, calls } = spyFetch(responderFor(fixture));
    const timesOut = 'network' in fixture.response && fixture.response.network === 'timeout';
    const subject = client({
      fetch,
      ...(timesOut
        ? { timeoutSignal: () => AbortSignal.abort(new DOMException('t', 'TimeoutError')) }
        : {}),
    });
    const schema = schemaFor(fixture);
    // Un intento: aquí se mide la clasificación; los reintentos tienen sus propios tests.
    const call = subject.send(fixture.operation, bodyFor(fixture.operation), {
      maxAttempts: 1,
      ...(schema === undefined ? {} : { responseSchema: schema }),
    });
    const expected = fixture.expect;

    if ('outcome' in expected) {
      const result = await call;
      expect(result.outcome).toBe(expected.outcome);
      expect(result.status).toBe(expected.status);
      expect(result.tboCode).toBe(expected.tboCode ?? undefined);
    } else if (expected.error === 'TboApiError') {
      const error = await apiError(call);
      expect(error.kind).toBe(expected.kind);
      expect(error.status).toBe(expected.status);
      expect(error.tboCode).toBe(expected.tboCode ?? undefined);
      if (expected.timedOut !== undefined) expect(error.timedOut).toBe(expected.timedOut);
      expect(error.requestId).toBe(REQUEST_ID);
      expect(error.path).toBe(TBO_OPERATIONS[fixture.operation].path);
    } else {
      const error = await failure(call);
      const Expected =
        expected.error === 'TboCancelMappingError'
          ? TboCancelMappingError
          : TboResponseMappingError;
      expect(error).toBeInstanceOf(Expected);
      expect((error as TboResponseMappingError).name).toBe(expected.error);
      expect((error as TboResponseMappingError).issues).toEqual(expected.issues);
    }
    expect(calls).toHaveLength(1);
  });

  it('el message del error no repite Status.Description (01 §8.6)', async () => {
    const { fetch } = spyFetch(
      json({ Status: { Code: 400, Description: 'FirstName Ana is invalid' } }),
    );
    const error = await apiError(client({ fetch }).send('book', { BookingCode: 'x' }));
    expect(error.message).toBe('TBO /Book http=200 code=400 [CLIENT_BUG]');
  });

  it('data sólo sale tipada si pasó por responseSchema (Zod en el borde, CLAUDE.md)', async () => {
    const { fetch } = spyFetch(json({ Status: { Code: 200 }, Foo: 'x' }));
    const subject = client({ fetch });
    // @ts-expect-error: un tipo sin esquema sería un cast sin validar.
    const untyped = await subject.send<{ Foo: string }>('search', { probe: 1 });
    expect(untyped.outcome).toBe('SUCCESS');

    const typed = await subject.send(
      'search',
      { probe: 1 },
      { responseSchema: z.object({ Foo: z.string() }).passthrough() },
    );
    if (typed.outcome !== 'SUCCESS') throw new Error('se esperaba SUCCESS');
    const foo: string = typed.data.Foo;
    expect(foo).toBe('x');
  });
});

// ---------------------------------------------------------------------------------------------
// Lo que sale al cable
// ---------------------------------------------------------------------------------------------

describe('lo que sale al cable (08 RF-02)', () => {
  it('POST a baseUrl + path, con Basic en cabecera, JSON y redirect manual', async () => {
    const { fetch, calls } = spyFetch(OK);
    await client({ fetch }).send('prebook', { BookingCode: 'abc', PaymentMode: 'Limit' });
    const [call] = calls;
    expect(call?.url).toBe(`${TBO_BASE_URLS.test}/PreBook`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    expect(call?.init.body).toBe('{"BookingCode":"abc","PaymentMode":"Limit"}');
    expect(call?.init.headers).toEqual({
      Authorization: BASIC,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });

  it('la credencial nunca va en la URL', async () => {
    const { fetch, calls } = spyFetch(OK);
    await client({ fetch }).send('search', { probe: 1 });
    const url = calls[0]?.url ?? '';
    expect(url).not.toContain(USERNAME);
    expect(url).not.toContain(TOKEN);
    expect(new URL(url).username).toBe('');
  });

  it.each(['countryList', 'hotelCodeList'] as const)(
    '%s sale por GET, sin cuerpo y sin Content-Type (08 RF-02 CA-4)',
    async (operation) => {
      const { fetch, calls } = spyFetch(json({ Status: { Code: 200 }, HotelCodes: [] }));
      await client({ fetch }).send(operation, undefined);
      expect(calls[0]?.init.method).toBe('GET');
      expect(calls[0]?.init.body).toBeUndefined();
      expect(calls[0]?.init.headers).toEqual({ Authorization: BASIC, Accept: 'application/json' });
    },
  );

  it('cada operación usa el path y el verbo de su fila', async () => {
    for (const operation of NAMES) {
      const { fetch, calls } = spyFetch(json({ Status: { Code: 200 } }));
      await client({ fetch }).send(operation, bodyFor(operation));
      const spec = TBO_OPERATIONS[operation];
      expect(calls[0]?.url, operation).toBe(`${TBO_BASE_URLS.test}${spec.path}`);
      expect(calls[0]?.init.method, operation).toBe(spec.method);
    }
  });

  it('una base live llega tal cual, normalizada, sin la barra final', async () => {
    const { fetch, calls } = spyFetch(OK);
    const live = config({ environment: 'live', baseUrl: 'https://live.example.test/HotelAPI/' });
    await client({ fetch }, live).send('search', { probe: 1 });
    expect(calls[0]?.url).toBe('https://live.example.test/HotelAPI/Search');
  });
});

describe('puertas locales: nada sale al cable', () => {
  it('sin contraseña, TboCredentialsMissingError con el nombre del campo', async () => {
    const { fetch, calls } = spyFetch(OK);
    const error = await failure(
      client({ fetch }, parseTboConfig({ environment: 'test', username: USERNAME })).send(
        'search',
        {},
      ),
    );
    expect(error).toBeInstanceOf(TboCredentialsMissingError);
    expect((error as TboCredentialsMissingError).missing).toEqual(['password']);
    expect(calls).toHaveLength(0);
  });

  it('live sin baseUrl: falta baseUrl', async () => {
    const { fetch, calls } = spyFetch(OK);
    const live = parseTboConfig({ environment: 'live', username: USERNAME, password: PASSWORD });
    const error = await failure(client({ fetch }, live).send('search', {}));
    expect((error as TboCredentialsMissingError).missing).toEqual(['baseUrl']);
    expect(calls).toHaveLength(0);
  });

  it('una config armada a mano con http en live no sale', async () => {
    const { fetch, calls } = spyFetch(OK);
    const handMade = {
      ...config(),
      environment: 'live' as const,
      baseUrl: 'http://x.test/HotelAPI',
    };
    const error = await failure(client({ fetch }, handMade).send('search', {}));
    expect(error).toBeInstanceOf(TboConfigError);
    expect(calls).toHaveLength(0);
  });

  it('una operación que no es de la tabla se corta con error tipado, aunque sea de Object.prototype', async () => {
    const { fetch, calls } = spyFetch(OK);
    for (const name of ['noExiste', 'toString', 'constructor', '__proto__']) {
      const error = await failure(client({ fetch }).send(name as TboOperationName, {}));
      expect(error, name).toMatchObject({
        name: 'TboRequestBuildError',
        reason: 'SCHEMA',
        issues: ['operation:unknown'],
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('un GET con cuerpo o un POST sin cuerpo son errores de construcción', async () => {
    const { fetch, calls } = spyFetch(OK);
    const subject = client({ fetch });
    expect(await failure(subject.send('countryList', { x: 1 }))).toMatchObject({
      name: 'TboRequestBuildError',
      reason: 'SCHEMA',
      issues: ['<root>:unexpected_body'],
    });
    expect(await failure(subject.send('search', undefined))).toMatchObject({
      issues: ['<root>:missing_body'],
    });
    expect(await failure(subject.send('search', 'texto armado a mano'))).toMatchObject({
      issues: ['<root>:not_an_object'],
    });
    expect(calls).toHaveLength(0);
  });

  it('el esquema de salida corta antes del cable con ruta:código, sin valores', async () => {
    const { fetch, calls } = spyFetch(OK);
    const strict = z.object({ BookingCode: z.string(), PaymentMode: z.literal('Limit') }).strict();
    const error = await failure(
      client({ fetch }).send(
        'prebook',
        { BookingCode: 42, PaymentMode: 'Limit', Extra: 'secreto' },
        { requestSchema: strict },
      ),
    );
    expect(error).toBeInstanceOf(TboRequestBuildError);
    expect((error as TboRequestBuildError).issues).toEqual([
      'BookingCode:invalid_type',
      '<root>:unrecognized_keys',
    ]);
    expect((error as Error).message).not.toContain('secreto');
    expect(calls).toHaveLength(0);
  });

  it('lo que sale es lo que produjo el esquema', async () => {
    const { fetch, calls } = spyFetch(OK);
    const trimming = z.object({ BookingCode: z.string().trim() });
    await client({ fetch }).send(
      'prebook',
      { BookingCode: '  abc  ' },
      { requestSchema: trimming },
    );
    expect(calls[0]?.init.body).toBe('{"BookingCode":"abc"}');
  });
});

// ---------------------------------------------------------------------------------------------
// D1 (01 §10.5; 08 RNF-04 capa 3)
// ---------------------------------------------------------------------------------------------

describe('guarda D1: sólo Limit y ninguna clave de tarjeta, a cualquier profundidad', () => {
  const book = {
    BookingCode: '1345320!TB!3!TB!af78e57f',
    CustomerDetails: [
      { CustomerNames: [{ Title: 'Mr', FirstName: 'Ana', LastName: 'Pérez', Type: 'Adult' }] },
    ],
    ClientReferenceId: 'REF-1',
    BookingReferenceId: 'REF-1',
    TotalFare: 164.65,
    EmailId: 'ana@example.test',
    PhoneNumber: '+573001112233',
    BookingType: 'Voucher',
    PaymentMode: 'Limit',
  };

  it('un Book Limit sin tarjeta sale', async () => {
    const { fetch, calls } = spyFetch(json({ Status: { Code: 200 }, ConfirmationNumber: 'X' }));
    await client({ fetch }).send('book', book);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).not.toMatch(/card|cvv|paymentinfo/i);
  });

  it.each(['NewCard', 'SavedCard', 'limit', '', null])(
    'PaymentMode %j se corta con PAYMENT_MODE',
    async (mode) => {
      const { fetch, calls } = spyFetch(OK);
      const error = await failure(client({ fetch }).send('book', { ...book, PaymentMode: mode }));
      expect(error).toMatchObject({ name: 'TboRequestBuildError', reason: 'PAYMENT_MODE' });
      expect((error as TboRequestBuildError).issues).toEqual(['PaymentMode']);
      expect(calls).toHaveLength(0);
    },
  );

  // Las claves de p. 33-35 y variantes de casing. Cada una se inyecta en tres profundidades.
  const CARD_KEYS = [
    'PaymentInfo',
    'CardNumber',
    'CvvNumber',
    'CardExpirationMonth',
    'CardExpirationYear',
    'CardHolderFirstName',
    'CardHolderlastName',
    'CardHolderAddress',
    'cardNumber',
    'card_number',
    'CVV',
  ];

  it.each(CARD_KEYS)(
    '%s se corta con CARD_DATA en la raíz, anidada y dentro de un array',
    async (key) => {
      const placements: [unknown, string][] = [
        [{ ...book, [key]: '4111111111111111' }, key],
        [{ ...book, Extra: { Deeper: { [key]: '4111111111111111' } } }, `Extra.Deeper.${key}`],
        [
          { ...book, CustomerDetails: [{ CustomerNames: [{ FirstName: 'Ana', [key]: 'x' }] }] },
          `CustomerDetails.0.CustomerNames.0.${key}`,
        ],
      ];
      for (const [body, path] of placements) {
        const { fetch, calls } = spyFetch(OK);
        const error = await failure(client({ fetch }).send('book', body));
        expect(error).toMatchObject({ name: 'TboRequestBuildError', reason: 'CARD_DATA' });
        expect((error as TboRequestBuildError).issues).toEqual([path]);
        expect((error as Error).message).not.toContain('4111111111111111');
        expect(calls).toHaveLength(0);
      }
    },
  );

  it('la guarda aplica a toda operación con cuerpo, no sólo al Book', async () => {
    for (const operation of NAMES.filter((name) => TBO_OPERATIONS[name].method === 'POST')) {
      const { fetch, calls } = spyFetch(OK);
      const error = await failure(client({ fetch }).send(operation, { PaymentInfo: {} }));
      expect(error, operation).toMatchObject({ reason: 'CARD_DATA' });
      expect(calls, operation).toHaveLength(0);
    }
  });

  it('un esquema que transforma no puede meter una tarjeta que el llamador no escribió', async () => {
    const { fetch, calls } = spyFetch(OK);
    const sneaky = z
      .object({ BookingCode: z.string() })
      .transform((v) => ({ ...v, PaymentInfo: { CvvNumber: '123' } }));
    const error = await failure(
      client({ fetch }).send('prebook', { BookingCode: 'x' }, { requestSchema: sneaky }),
    );
    expect(error).toMatchObject({ reason: 'CARD_DATA', issues: ['PaymentInfo'] });
    expect(calls).toHaveLength(0);
  });

  // `JSON.stringify` llama a `toJSON`: lo que viaja puede tener claves que el objeto no muestra.
  // La guarda tiene que barrer los bytes del cable, como `providers/sabre/src/pan-egress.guard.test.ts`.
  it.each<[string, unknown, string, string]>([
    [
      'un toJSON en la raíz',
      { ...book, toJSON: () => ({ ...book, PaymentInfo: { CardNumber: '4111111111111111' } }) },
      'CARD_DATA',
      'PaymentInfo',
    ],
    [
      'un toJSON anidado',
      { ...book, Extra: { toJSON: () => ({ CvvNumber: '4111111111111111' }) } },
      'CARD_DATA',
      'Extra.CvvNumber',
    ],
    [
      'un toJSON que cambia el modo de pago',
      { ...book, toJSON: () => ({ ...book, PaymentMode: 'NewCard' }) },
      'PAYMENT_MODE',
      'PaymentMode',
    ],
  ])('%s no cuela nada: se barre lo que viaja', async (_label, body, reason, issue) => {
    const { fetch, calls } = spyFetch(OK);
    const error = await failure(client({ fetch }).send('book', body));
    expect(error).toMatchObject({ name: 'TboRequestBuildError', reason, issues: [issue] });
    expect((error as Error).message).not.toContain('4111111111111111');
    expect(calls).toHaveLength(0);
  });

  it('un cuerpo que se serializa a nada o a un texto no sale como POST sin cuerpo', async () => {
    const { fetch, calls } = spyFetch(OK);
    const subject = client({ fetch });
    expect(await failure(subject.send('book', { toJSON: () => undefined }))).toMatchObject({
      reason: 'SCHEMA',
      issues: ['<root>:not_serializable'],
    });
    expect(await failure(subject.send('book', { toJSON: () => 'texto' }))).toMatchObject({
      reason: 'SCHEMA',
      issues: ['<root>:not_an_object'],
    });
    expect(calls).toHaveLength(0);
  });

  it('un cuerpo más profundo de lo razonable se corta en vez de recorrerse sin fin', async () => {
    const { fetch, calls } = spyFetch(OK);
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    const error = await failure(client({ fetch }).send('search', deep));
    expect(error).toMatchObject({ reason: 'SCHEMA', issues: ['<root>:too_deep'] });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Timeouts (01 §5; 08 RF-02 CA-2)
// ---------------------------------------------------------------------------------------------

describe('timeouts', () => {
  it('un cuerpo que llega despacio se corta: no basta con que lleguen las cabeceras', async () => {
    const slowBody: Responder = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Cabeceras y el primer trozo enseguida; el resto no llega nunca.
            controller.enqueue(new TextEncoder().encode('{"Status":'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const { fetch, calls } = spyFetch(slowBody);
    const started = Date.now();
    const error = await apiError(client({ fetch }).send('search', { probe: 1 }, { timeoutMs: 50 }));
    expect(error).toMatchObject({ kind: 'TRANSPORT', status: 0, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    // Search nunca reintenta tras un timeout.
    expect(calls).toHaveLength(1);
  });

  it('un servidor que no responde se corta por la misma señal', async () => {
    const { fetch } = spyFetch(hangingFetch);
    const error = await apiError(
      client({ fetch }).send('bookingDetail', { probe: 1 }, { timeoutMs: 30, maxAttempts: 1 }),
    );
    expect(error).toMatchObject({ kind: 'TRANSPORT', status: 0, timedOut: true });
  });

  it('un cuerpo que termina a tiempo se lee entero, aunque llegue en trozos', async () => {
    const chunked: Responder = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('{"Status":{"Code":'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.enqueue(encoder.encode('200}}'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const { fetch } = spyFetch(chunked);
    const result = await client({ fetch }).send('search', { probe: 1 }, { timeoutMs: 2_000 });
    expect(result).toMatchObject({ outcome: 'SUCCESS', tboCode: 200 });
  });

  // Reloj fijo: Search descuenta del plazo compartido lo que ya pasó, y con el reloj real un
  // milisegundo de carga pedía 12 999 ms.
  const frozenClock = (): number => 1_000;

  it('cada operación pide la espera de su fila: Book no corta a los 23 s y Search sí', async () => {
    const asked: number[] = [];
    const timeoutSignal = (ms: number): AbortSignal => {
      asked.push(ms);
      return new AbortController().signal;
    };
    for (const operation of NAMES) {
      const { fetch } = spyFetch(json({ Status: { Code: 200 } }));
      await client({ fetch, timeoutSignal, now: frozenClock }).send(operation, bodyFor(operation));
    }
    expect(Object.fromEntries(NAMES.map((name, i) => [name, asked[i]]))).toEqual({
      search: 13_000,
      prebook: 23_000,
      book: 120_000,
      bookingDetail: 30_000,
      cancel: 60_000,
      bookingDetailsByDate: 60_000,
      countryList: 30_000,
      cityList: 30_000,
      hotelCodeList: 180_000,
      tboHotelCodeList: 60_000,
      hotelDetails: 60_000,
    });
  });

  it('la configuración sólo acorta; Search sube con ResponseTime hasta 23 s', async () => {
    const asked: number[] = [];
    const timeoutSignal = (ms: number): AbortSignal => {
      asked.push(ms);
      return new AbortController().signal;
    };
    const { fetch } = spyFetch(json({ Status: { Code: 200 } }));
    const subject = client({ fetch, timeoutSignal, now: frozenClock });
    await subject.send('book', {}, { timeoutMs: 200_000 });
    await subject.send('book', {}, { timeoutMs: 5_000 });
    await subject.send('hotelDetails', {}, { timeoutMs: 45_000 });
    await subject.send('search', {}, { timeoutMs: 23_000 });
    await subject.send('search', {}, { timeoutMs: 30_000 });
    expect(asked).toEqual([120_000, 5_000, 45_000, 23_000, 23_000]);
  });
});

// ---------------------------------------------------------------------------------------------
// Reintentos (01 §10.4; 08 RNF-01)
// ---------------------------------------------------------------------------------------------

describe('reintentos', () => {
  const UPSTREAM = json({ Status: { Code: 500 } });

  it('Search reintenta una vez un 500 y devuelve el segundo intento', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = spyFetch(UPSTREAM, OK);
    const result = await client({
      fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).send('search', {});
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ outcome: 'SUCCESS', attempts: 2, requestId: REQUEST_ID });
    expect(sleeps).toEqual([tboBackoffDelayMs(1, () => 0)]);
  });

  it('Search no pasa de 2 intentos aunque se pidan más', async () => {
    const { fetch, calls } = spyFetch(UPSTREAM);
    await apiError(client({ fetch }).send('search', {}, { maxAttempts: 5 }));
    expect(calls).toHaveLength(2);
  });

  it('un código NO_RETRY no se repite', async () => {
    const { fetch, calls } = spyFetch(json({ Status: { Code: 401 } }));
    await apiError(client({ fetch }).send('bookingDetail', {}));
    expect(calls).toHaveLength(1);
  });

  it('PreBook reintenta un 429 rápido', async () => {
    const { fetch, calls } = spyFetch(json({ Status: { Code: 429 } }), OK);
    await client({ fetch }).send('prebook', {});
    expect(calls).toHaveLength(2);
  });

  it('PreBook no reintenta si el primer fallo se comió el plazo de 23 s (08 §9 C-24)', async () => {
    let now = 1_000_000;
    const slowFail: Responder = () => {
      now += 21_500;
      return UPSTREAM(undefined as unknown as FetchCall);
    };
    const { fetch, calls } = spyFetch(slowFail, OK);
    await apiError(client({ fetch, now: () => now }).send('prebook', {}));
    expect(calls).toHaveLength(1);
  });

  it('el segundo intento de PreBook sólo tiene lo que queda de los 23 s', async () => {
    let now = 1_000_000;
    const asked: number[] = [];
    const fastFail: Responder = () => {
      now += 3_000;
      return json({ Status: { Code: 429 } })(undefined as unknown as FetchCall);
    };
    const { fetch } = spyFetch(fastFail, OK);
    await client({
      fetch,
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      timeoutSignal: (ms) => {
        asked.push(ms);
        return new AbortController().signal;
      },
    }).send('prebook', {});
    // 23 s − 3 s del primer intento − el backoff.
    expect(asked).toEqual([23_000, 20_000 - tboBackoffDelayMs(1, () => 0)]);
  });

  it('BookingDetail en job hace hasta 3 intentos; la lectura interactiva pide 2', async () => {
    const job = spyFetch(UPSTREAM);
    await apiError(client({ fetch: job.fetch }).send('bookingDetail', {}));
    expect(job.calls).toHaveLength(3);

    const interactive = spyFetch(UPSTREAM);
    await apiError(
      client({ fetch: interactive.fetch }).send('bookingDetail', {}, { maxAttempts: 2 }),
    );
    expect(interactive.calls).toHaveLength(2);
  });

  it('BookingDetail sí reintenta tras un timeout: es un job, no espera nadie', async () => {
    const { fetch, calls } = spyFetch(hangingFetch, OK);
    const result = await client({ fetch }).send('bookingDetail', {}, { timeoutMs: 20 });
    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe('SUCCESS');
  });

  it('un MALFORMED_RESPONSE de una lectura se reintenta como un 500', async () => {
    const { fetch, calls } = spyFetch(() => new Response('<html/>', { status: 200 }), OK);
    await client({ fetch }).send('hotelDetails', {});
    expect(calls).toHaveLength(2);
  });

  it('un llamador que abortó no provoca reintentos', async () => {
    const controller = new AbortController();
    const abortingFail: Responder = () => {
      controller.abort();
      return UPSTREAM(undefined as unknown as FetchCall);
    };
    const { fetch, calls } = spyFetch(abortingFail, OK);
    await apiError(client({ fetch }).send('search', {}, { signal: controller.signal }));
    expect(calls).toHaveLength(1);
  });

  it('backoff exponencial con suelo de 500 ms y techo de 4 s', () => {
    expect([1, 2, 3, 4, 5, 10].map((n) => tboBackoffDelayMs(n, () => 0))).toEqual([
      500, 1_000, 2_000, 4_000, 4_000, 4_000,
    ]);
    expect(tboBackoffDelayMs(1, () => 0.999)).toBe(750);
  });
});

// ---------------------------------------------------------------------------------------------
// 01 §8.5: la ciudad sin hoteles de TBOHotelCodeList, tal como llegó en producción (2026-09-29)
// ---------------------------------------------------------------------------------------------

describe('TBOHotelCodeList: 500 "No Hotels Found" es un resultado vacío, no un error', () => {
  const observed = FIXTURES.find(([file]) => file === '83-500-no-hotels-found.json')?.[1];
  if (observed === undefined || 'network' in observed.response) {
    throw new Error('falta el fixture 83-500-no-hotels-found.json');
  }
  const bodyText = observed.response.bodyText ?? '';
  const noHotelsFound =
    (status = 200): Responder =>
    () =>
      new Response(bodyText, { status, headers: { 'content-type': 'application/json' } });

  it('el fixture es el cuerpo observado: 55 bytes, Code 500, "No Hotels Found"', () => {
    expect(Buffer.byteLength(bodyText)).toBe(55);
    expect(JSON.parse(bodyText)).toEqual({
      Status: { Code: 500, Description: 'No Hotels Found' },
    });
  });

  it('UNA llamada con los 5 intentos de la tabla: vacío con su código, sin error para el breaker', async () => {
    const { fetch, calls } = spyFetch(noHotelsFound());
    const { logger, calls: logs } = spyLogger();
    const { metrics, calls: measured } = spyMetrics();
    const sleeps: number[] = [];
    const result = await client({
      fetch,
      logger,
      metrics,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).send('tboHotelCodeList', { CityCode: '130452', IsDetailedResponse: 'true' });

    // No lanza: no hay `TboApiError` que el breaker cuente (circuito IGNORE) ni que se reintente.
    expect(result).toMatchObject({
      outcome: 'NO_AVAILABILITY',
      status: 200,
      tboCode: 500,
      attempts: 1,
      requestId: REQUEST_ID,
    });
    expect(TBO_OPERATIONS.tboHotelCodeList.maxAttempts).toBe(5);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(logs.filter((log) => log.level === 'warn' || log.level === 'error')).toEqual([]);
    expect(logs.map((log) => log.message)).toEqual(['tbo.http.ok']);
    expect(logs[0]).toMatchObject({
      level: 'debug',
      meta: { outcome: 'NO_AVAILABILITY', tboCode: 500, description: 'No Hotels Found' },
    });
    expect(JSON.stringify(logs)).not.toMatch(/"circuit"|"retry"/);
    expect(measured.find((m) => m.name === 'tbo.http.requests')?.tags).toEqual({
      op: 'tboHotelCodeList',
      kind: 'NO_AVAILABILITY',
      tbo_code: '500',
    });
  });

  it('otro 500 en la misma operación sigue siendo UPSTREAM: 5 intentos y circuito COUNT', async () => {
    const { fetch, calls } = spyFetch(
      json({ Status: { Code: 500, Description: 'Unexpected Error' } }),
    );
    const error = await apiError(client({ fetch }).send('tboHotelCodeList', { probe: 1 }));
    expect(error.kind).toBe('UPSTREAM');
    expect(error.failure.circuit).toBe('COUNT');
    expect(calls).toHaveLength(5);
  });

  it('el mismo cuerpo con HTTP 500 de transporte no es lo observado: UPSTREAM y se reintenta', async () => {
    const { fetch, calls } = spyFetch(noHotelsFound(500));
    const error = await apiError(client({ fetch }).send('tboHotelCodeList', { probe: 1 }));
    expect(error).toMatchObject({ kind: 'UPSTREAM', status: 500, tboCode: 500 });
    expect(calls).toHaveLength(5);
  });

  it.each(['cityList', 'hotelDetails'] as const)(
    'en %s, sin evidencia, el mismo cuerpo es UPSTREAM y se reintenta',
    async (op) => {
      const { fetch, calls } = spyFetch(noHotelsFound());
      const error = await apiError(client({ fetch }).send(op, { probe: 1 }));
      expect(error.kind).toBe('UPSTREAM');
      expect(calls).toHaveLength(TBO_OPERATIONS[op].maxAttempts);
    },
  );
});

describe('TBOHotelCodeList: un "No Hotels Found" lento es el plazo de TBO vencido (01 §8.5)', () => {
  const observed = FIXTURES.find(([file]) => file === '83-500-no-hotels-found.json')?.[1];
  if (observed === undefined || 'network' in observed.response) {
    throw new Error('falta el fixture 83-500-no-hotels-found.json');
  }
  const bodyText = observed.response.bodyText ?? '';
  const HOTELS = json({
    Status: { Code: 200, Description: 'Success' },
    Hotels: [{ HotelCode: '1' }],
  });

  /** Reloj falso del cliente: cada "No Hotels Found" lo adelanta lo que tardó en el log. */
  function tbo(): { now: () => number; noHotelsFoundAfter: (ms: number) => Responder } {
    let clock = 0;
    return {
      now: () => clock,
      noHotelsFoundAfter: (ms) => () => {
        clock += ms;
        return new Response(bodyText, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
  }

  it('UPSTREAM con su motivo, backoff y COUNT; el reintento que trae hoteles es un éxito', async () => {
    // d121e5da en el log: 5.088 y 5.092 ms, y el tercer intento trajo hoteles.
    const { now, noHotelsFoundAfter } = tbo();
    const { fetch, calls } = spyFetch(noHotelsFoundAfter(5_088), noHotelsFoundAfter(5_092), HOTELS);
    const { logger, calls: logs } = spyLogger();
    const { metrics, calls: measured } = spyMetrics();
    const sleeps: number[] = [];
    const result = await client({
      fetch,
      now,
      logger,
      metrics,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).send('tboHotelCodeList', { CityCode: '130452', IsDetailedResponse: 'true' });

    expect(result).toMatchObject({ outcome: 'SUCCESS', status: 200, tboCode: 200, attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([tboBackoffDelayMs(1, () => 0), tboBackoffDelayMs(2, () => 0)]);
    const errors = logs.filter((log) => log.message === 'tbo.http.error');
    expect(errors.map((log) => log.level)).toEqual(['warn', 'warn']);
    expect(errors.map((log) => log.meta)).toEqual([
      expect.objectContaining({
        attempt: 1,
        durationMs: 5_088,
        kind: 'UPSTREAM',
        retry: 'RETRY_BACKOFF',
        circuit: 'COUNT',
        reason: 'slow_no_hotels_found',
        tboCode: 500,
        description: 'No Hotels Found',
        retryInMs: sleeps[0],
      }),
      expect.objectContaining({ attempt: 2, durationMs: 5_092, reason: 'slow_no_hotels_found' }),
    ]);
    expect(
      measured.filter((m) => m.name === 'tbo.http.requests').map((m) => m.tags?.['kind']),
    ).toEqual(['UPSTREAM', 'UPSTREAM', 'SUCCESS']);
  });

  it('lento en los 5 intentos: TboApiError UPSTREAM que el breaker cuenta, nunca un vacío', async () => {
    // 57ed77c7 en el log: los 5 intentos entre 5.089 y 5.357 ms.
    const { now, noHotelsFoundAfter } = tbo();
    const { fetch, calls } = spyFetch(
      ...[5_089, 5_092, 5_094, 5_089, 5_357].map((ms) => noHotelsFoundAfter(ms)),
    );
    const { logger, calls: logs } = spyLogger();
    const error = await apiError(
      client({ fetch, now, logger }).send('tboHotelCodeList', { CityCode: '130452' }),
    );

    expect(error).toMatchObject({ kind: 'UPSTREAM', status: 200, tboCode: 500 });
    expect(error.failure.circuit).toBe('COUNT');
    expect(calls).toHaveLength(TBO_OPERATIONS.tboHotelCodeList.maxAttempts);
    const errors = logs.filter((log) => log.message === 'tbo.http.error');
    expect(errors.map((log) => log.meta?.['reason'])).toEqual(
      Array.from({ length: 5 }, () => 'slow_no_hotels_found'),
    );
    expect(errors.at(-1)?.meta).not.toHaveProperty('retryInMs');
  });

  it('el umbral es el de la opción de send, si la hay', async () => {
    const early = tbo();
    const late = spyFetch(early.noHotelsFoundAfter(5_092));
    await expect(
      client({ fetch: late.fetch, now: early.now }).send(
        'tboHotelCodeList',
        { probe: 1 },
        {
          slowNoHotelsFoundMs: 10_000,
        },
      ),
    ).resolves.toMatchObject({ outcome: 'NO_AVAILABILITY', attempts: 1 });

    const strict = tbo();
    const quick = spyFetch(strict.noHotelsFoundAfter(200));
    const error = await apiError(
      client({ fetch: quick.fetch, now: strict.now }).send(
        'tboHotelCodeList',
        { probe: 1 },
        {
          slowNoHotelsFoundMs: 200,
          maxAttempts: 1,
        },
      ),
    );
    expect(error.kind).toBe('UPSTREAM');
  });

  it('mide sólo el intercambio HTTP: la espera del cupo y el backoff no vuelven lento un intento', async () => {
    // El reloj salta 10 s en cada espera del cupo y en cada backoff. Si el intento se midiera
    // desde antes, el "No Hotels Found" de 100 ms del segundo intento contaría como lento.
    let clock = 0;
    const limiter: TboRateLimiter = {
      acquire: () => {
        clock += 10_000;
        return Promise.resolve({ granted: true, permit: { release: () => undefined } });
      },
      reportThrottled: () => undefined,
    };
    const answer =
      (ms: number): Responder =>
      () => {
        clock += ms;
        return new Response(bodyText, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    const { fetch, calls } = spyFetch(answer(5_088), answer(100));
    const { logger, calls: logs } = spyLogger();
    const result = await client({
      fetch,
      limiter,
      logger,
      now: () => clock,
      sleep: () => {
        clock += 10_000;
        return Promise.resolve();
      },
    }).send('tboHotelCodeList', { CityCode: '130452' });

    expect(result).toMatchObject({ outcome: 'NO_AVAILABILITY', attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(
      logs
        .filter((log) => log.message.startsWith('tbo.http.'))
        .map((log) => [log.message, log.meta?.['durationMs'], log.meta?.['reason']]),
    ).toEqual([
      ['tbo.http.error', 5_088, 'slow_no_hotels_found'],
      ['tbo.http.ok', 100, undefined],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Dinero: una llamada, siempre (08 RF-02 CA-1). La guarda contra la tabla editada está en
// `src/money-paths.guard.test.ts`.
// ---------------------------------------------------------------------------------------------

describe('Book y Cancel: exactamente una llamada', () => {
  it.each(['book', 'cancel'] as const)(
    '%s: un timeout hace UNA llamada aunque sea RETRY_BACKOFF',
    async (operation) => {
      const { fetch, calls } = spyFetch(hangingFetch, OK);
      const error = await apiError(
        client({ fetch }).send(operation, {}, { timeoutMs: 20, maxAttempts: 5 }),
      );
      expect(error).toMatchObject({ kind: 'TRANSPORT', timedOut: true });
      // La naturaleza del fallo sigue siendo reintentable (01 §9.3): el clasificador de
      // cancelaciones la necesita para pedir conciliación.
      expect(error.retryable).toBe(true);
      expect(calls).toHaveLength(1);
    },
  );

  it.each(['book', 'cancel'] as const)(
    '%s: un 500 o un 429 tampoco se repiten',
    async (operation) => {
      for (const code of [500, 429]) {
        const { fetch, calls } = spyFetch(json({ Status: { Code: code } }), OK);
        await apiError(client({ fetch }).send(operation, {}));
        expect(calls, `${operation} ${code}`).toHaveLength(1);
      }
    },
  );

  it('la señal del llamador no llega a un Book: abortar no cancela nada en TBO (01 §5.4)', async () => {
    const { fetch, calls } = spyFetch(json({ Status: { Code: 200 }, ConfirmationNumber: 'X' }));
    const result = await client({ fetch }).send('book', {}, { signal: AbortSignal.abort() });
    expect(result.outcome).toBe('SUCCESS');
    expect(calls[0]?.init.signal?.aborted).toBe(false);
  });

  it('un Status.Code desconocido en /Cancel llega como TboCancelMappingError; en /Book, como TboApiError', async () => {
    const unknown = json({ Status: { Code: 999 } });
    const cancel = await failure(client({ fetch: spyFetch(unknown).fetch }).send('cancel', {}));
    expect(cancel).toBeInstanceOf(TboCancelMappingError);
    expect((cancel as TboCancelMappingError).requestId).toBe(REQUEST_ID);
    const book = await failure(client({ fetch: spyFetch(unknown).fetch }).send('book', {}));
    expect(book).toBeInstanceOf(TboApiError);
    expect((book as TboApiError).kind).toBe('UNKNOWN_CODE');
  });
});

// ---------------------------------------------------------------------------------------------
// Limitador (01 §7.2; 08 RNF-02)
// ---------------------------------------------------------------------------------------------

describe('limitador', () => {
  function spyLimiter(grant: 'yes' | 'QUEUE_TIMEOUT' = 'yes'): {
    limiter: TboRateLimiter;
    requests: TboLimiterRequest[];
    throttled: string[];
    released: number[];
  } {
    const requests: TboLimiterRequest[] = [];
    const throttled: string[] = [];
    const released: number[] = [];
    const limiter: TboRateLimiter = {
      acquire: (request) => {
        requests.push(request);
        if (grant !== 'yes') return Promise.resolve({ granted: false, reason: grant });
        const index = requests.length;
        return Promise.resolve({
          granted: true,
          permit: { release: () => released.push(index) },
        });
      },
      reportThrottled: (accountRef) => throttled.push(accountRef),
    };
    return { limiter, requests, throttled, released };
  }

  it('la clave es la cuenta resuelta y cada operación va a su cupo', async () => {
    const spy = spyLimiter();
    const subject = client({ fetch: spyFetch(OK).fetch, limiter: spy.limiter }, config(), {
      ownerTenantId: 'tenant-consolidador',
    });
    await subject.send('search', {});
    await subject.send('book', {});
    await subject.send('bookingDetail', {});
    await subject.send('bookingDetail', {}, { lane: 'money' });
    await subject.send('search', {}, { lane: 'money' });
    expect(spy.requests.map((r) => r.lane)).toEqual([
      'sales',
      'money',
      'background',
      'money',
      // Search no puede colarse en la reserva de dinero.
      'sales',
    ]);
    expect(new Set(spy.requests.map((r) => r.accountRef))).toEqual(
      new Set([tboAccountRef('tenant-consolidador', USERNAME)]),
    );
    expect(spy.released).toHaveLength(5);
  });

  it('el cupo se devuelve también cuando el intento falla', async () => {
    const spy = spyLimiter();
    await apiError(
      client({ fetch: spyFetch(json({ Status: { Code: 400 } })).fetch, limiter: spy.limiter }).send(
        'search',
        {},
      ),
    );
    expect(spy.released).toEqual([1]);
  });

  it('un 429 (en el cuerpo o en el HTTP) se le informa al limitador de esa cuenta', async () => {
    const spy = spyLimiter();
    const subject = client({
      fetch: spyFetch(json({ Status: { Code: 429 } }), () => new Response('', { status: 429 }))
        .fetch,
      limiter: spy.limiter,
    });
    await apiError(subject.send('search', {}));
    expect(spy.throttled).toEqual([subject.accountRef, subject.accountRef]);
  });

  it('sin cupo a tiempo: TboDispatchRejectedError y ninguna llamada', async () => {
    const spy = spyLimiter('QUEUE_TIMEOUT');
    const { fetch, calls } = spyFetch(OK);
    const { metrics, calls: metricCalls } = spyMetrics();
    const error = await failure(
      client({ fetch, limiter: spy.limiter, metrics }).send('search', {}),
    );
    expect(error).toBeInstanceOf(TboDispatchRejectedError);
    expect(error).toMatchObject({ path: '/Search', reason: 'QUEUE_TIMEOUT' });
    expect(calls).toHaveLength(0);
    expect(metricCalls).toContainEqual({
      kind: 'counter',
      name: 'tbo.limiter.rejected',
      value: 1,
      tags: { op: 'search', lane: 'sales', reason: 'QUEUE_TIMEOUT' },
    });
  });

  it('en Search la espera del cupo consume el mismo plazo que la llamada', async () => {
    const spy = spyLimiter();
    const frozen = { now: () => 5_000 };
    await client({ fetch: spyFetch(OK).fetch, limiter: spy.limiter, ...frozen }).send('search', {});
    await client({ fetch: spyFetch(OK).fetch, limiter: spy.limiter, ...frozen }).send('book', {});
    expect(spy.requests.map((r) => r.maxWaitMs)).toEqual([13_000, 120_000]);
  });

  it('un llamador que ya abortó no sale: el limitador real lo rechaza', async () => {
    const { fetch, calls } = spyFetch(OK);
    const error = await failure(
      client({ fetch, limiter: new TboInMemoryRateLimiter() }).send(
        'search',
        {},
        { signal: AbortSignal.abort() },
      ),
    );
    expect(error).toMatchObject({ name: 'TboDispatchRejectedError', reason: 'ABORTED' });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Logging, métricas y bóveda (01 §11; 08 RNF-05 y RNF-07)
// ---------------------------------------------------------------------------------------------

describe('el log no recibe credenciales ni datos personales (08 RNF-05)', () => {
  const PII = ['Ana', 'Pérez', 'ana@example.test', '+573001112233'];
  const bookBody = {
    BookingCode: 'BC-1',
    CustomerDetails: [
      { CustomerNames: [{ Title: 'Mr', FirstName: 'Ana', LastName: 'Pérez', Type: 'Adult' }] },
    ],
    EmailId: 'ana@example.test',
    PhoneNumber: '+573001112233',
    PaymentMode: 'Limit',
  };
  const echo = {
    FirstName: 'Ana',
    LastName: 'Pérez',
    EmailId: 'ana@example.test',
    PhoneNumber: '+573001112233',
  };

  function assertClean(calls: readonly LogCall[]): void {
    const dump = JSON.stringify(calls);
    for (const needle of [
      'Authorization',
      TOKEN,
      USERNAME,
      PASSWORD.trim(),
      'FirstName',
      'LastName',
      'EmailId',
      'PhoneNumber',
      ...PII,
    ]) {
      expect(dump, `el log contiene ${needle}`).not.toContain(needle);
    }
  }

  it.each<[string, Responder]>([
    ['éxito con los datos del huésped en la respuesta', json({ Status: { Code: 200 }, ...echo })],
    [
      '400 cuya Description repite el nombre',
      json({ Status: { Code: 400, Description: 'Invalid FirstName Ana ana@example.test' } }),
    ],
    [
      '500 con eco',
      json({ Status: { Code: 500, Description: 'Error for +573001112233' }, ...echo }, 500),
    ],
    ['405 en un 200', json({ Status: { Code: 405, Description: 'Booking Failed for Ana Pérez' } })],
    [
      'HTML de un proxy con eco',
      () => new Response('<p>Ana Pérez ana@example.test</p>', { status: 502 }),
    ],
  ])('Book: %s', async (_label, responder) => {
    const { logger, calls } = spyLogger();
    await client({ fetch: spyFetch(responder).fetch, logger })
      .send('book', bookBody)
      .catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    assertClean(calls);
  });

  it('BookingDetail con PII en la respuesta, y un fallo de esquema', async () => {
    const { logger, calls } = spyLogger();
    const responder = json({ Status: { Code: 200 }, BookingDetail: { ...echo } });
    await client({ fetch: spyFetch(responder).fetch, logger })
      .send(
        'bookingDetail',
        { ConfirmationNumber: 'X', PaymentMode: 'Limit' },
        {
          responseSchema: z.object({ Missing: z.string() }),
        },
      )
      .catch(() => undefined);
    expect(calls.some((c) => c.message === 'tbo.http.response_unreadable')).toBe(true);
    assertClean(calls);
  });

  it('un body con tarjeta rechazado tampoco deja el valor en el log', async () => {
    const { logger, calls } = spyLogger();
    await client({ fetch: spyFetch(OK).fetch, logger })
      .send('book', { ...bookBody, PaymentInfo: { CardNumber: '4111111111111111' } })
      .catch(() => undefined);
    expect(calls.map((c) => c.message)).toEqual(['tbo.http.request_rejected']);
    expect(JSON.stringify(calls)).not.toContain('4111111111111111');
    assertClean(calls);
  });

  it('Search sí loguea Status.Description, recortada; Book no', async () => {
    const description = `No Available rooms ${'x'.repeat(300)}`;
    const search = spyLogger();
    await client({
      fetch: spyFetch(json({ Status: { Code: 207, Description: description } })).fetch,
      logger: search.logger,
    })
      .send('search', {})
      .catch(() => undefined);
    const logged = search.calls.find((c) => c.message === 'tbo.http.error')?.meta?.['description'];
    expect(typeof logged).toBe('string');
    expect(String(logged)).toHaveLength(120);

    const book = spyLogger();
    await client({
      fetch: spyFetch(json({ Status: { Code: 207, Description: description } })).fetch,
      logger: book.logger,
    })
      .send('book', {})
      .catch(() => undefined);
    expect(JSON.stringify(book.calls)).not.toContain('No Available rooms');
  });

  it('el log lleva la lista blanca: op, path, intento, status, código, kind, requestId, cuenta', async () => {
    const { logger, calls } = spyLogger();
    const subject = client(
      { fetch: spyFetch(json({ Status: { Code: 207 } })).fetch, logger },
      config(),
      { ownerTenantId: 'tenant-1', credentialSource: 'inherited' },
    );
    await failure(subject.send('prebook', {}));
    const entry = calls.find((c) => c.message === 'tbo.http.error');
    expect(entry?.level).toBe('warn');
    expect(entry?.meta).toMatchObject({
      provider: 'tbo-hotels',
      op: 'prebook',
      path: '/PreBook',
      method: 'POST',
      lane: 'sales',
      attempt: 1,
      status: 200,
      tboCode: 207,
      kind: 'RATE_UNAVAILABLE',
      requestId: REQUEST_ID,
      accountRef: subject.accountRef,
      credentialSource: 'inherited',
      environment: 'test',
      contentType: 'application/json; charset=utf-8',
    });
  });

  it.each<[string, TboOperationName, Responder, string]>([
    ['éxito', 'search', OK, 'debug'],
    ['UNKNOWN_CODE', 'search', json({ Status: { Code: 999 } }), 'error'],
    ['MALFORMED', 'prebook', () => new Response('', { status: 200 }), 'error'],
    ['500 en un Book: incierto', 'book', json({ Status: { Code: 500 } }), 'error'],
    ['405 en un Book: incierto', 'book', json({ Status: { Code: 405 } }), 'error'],
    ['300 en un Book: precondición', 'book', json({ Status: { Code: 300 } }), 'warn'],
    ['207 en un PreBook', 'prebook', json({ Status: { Code: 207 } }), 'warn'],
  ])('nivel de log: %s', async (_label, operation, responder, level) => {
    const { logger, calls } = spyLogger();
    await client({ fetch: spyFetch(responder).fetch, logger })
      .send(operation, {}, { maxAttempts: 1 })
      .catch(() => undefined);
    expect(calls.map((c) => c.level)).toEqual([level]);
  });

  it('un logger que lanza no cambia el desenlace de un Book', async () => {
    const exploding: LoggerPort = {
      debug: () => {
        throw new Error('logger roto');
      },
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => exploding,
    };
    const result = await client({
      fetch: spyFetch(json({ Status: { Code: 200 }, ConfirmationNumber: 'X' })).fetch,
      logger: exploding,
      metrics: {
        counter: () => {
          throw new Error('métricas rotas');
        },
        gauge: () => undefined,
        histogram: () => undefined,
      },
    }).send('book', {});
    expect(result.outcome).toBe('SUCCESS');
  });
});

describe('métricas (08 RNF-07)', () => {
  it('tbo.http.requests por intento, tbo.http.duration y la variante de casing', async () => {
    const { metrics, calls } = spyMetrics();
    let now = 0;
    const { fetch } = spyFetch(json({ Status: { Code: 500 } }), () => {
      now += 42;
      return new Response(JSON.stringify({ status: { code: 201 } }), { status: 200 });
    });
    await client({ fetch, metrics, now: () => now }).send('search', {});
    expect(calls.filter((c) => c.name === 'tbo.http.requests')).toEqual([
      {
        kind: 'counter',
        name: 'tbo.http.requests',
        value: 1,
        tags: { op: 'search', kind: 'UPSTREAM', tbo_code: '500' },
      },
      {
        kind: 'counter',
        name: 'tbo.http.requests',
        value: 1,
        tags: { op: 'search', kind: 'NO_AVAILABILITY', tbo_code: '201' },
      },
    ]);
    expect(calls.filter((c) => c.name === 'tbo.http.duration').map((c) => c.value)).toEqual([
      0, 42,
    ]);
    expect(calls.filter((c) => c.name === 'tbo.envelope.casing_variant')).toHaveLength(1);
  });

  it('un fallo de transporte se mide sin código', async () => {
    const { metrics, calls } = spyMetrics();
    await failure(
      client({ fetch: () => Promise.reject(new TypeError('fetch failed')), metrics }).send(
        'book',
        {},
      ),
    );
    expect(calls.find((c) => c.name === 'tbo.http.requests')?.tags).toEqual({
      op: 'book',
      kind: 'TRANSPORT',
      tbo_code: 'none',
    });
  });
});

describe('bóveda de payloads (D-TBO-31 A; 01 §11.2)', () => {
  it('guarda RQ y RS completos de cada intento con el mismo requestId', async () => {
    const records: TboPayloadRecord[] = [];
    const vault = { record: (entry: TboPayloadRecord) => void records.push(entry) };
    const { fetch } = spyFetch(json({ Status: { Code: 500 } }), OK);
    await client({ fetch, payloadVault: vault }).send('search', { HotelCodes: '1' });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(records.map((r) => [r.attempt, r.responseStatus, r.tboCode, r.outcome])).toEqual([
      [1, 200, 500, 'UPSTREAM'],
      [2, 200, 200, 'SUCCESS'],
    ]);
    expect(new Set(records.map((r) => r.requestId))).toEqual(new Set([REQUEST_ID]));
    expect(records[0]?.requestBody).toBe('{"HotelCodes":"1"}');
    expect(records[1]?.responseBody).toBe('{"Status":{"Code":200,"Description":"Successful"}}');
    expect(records[0]?.path).toBe('/Search');
  });

  it('una bóveda que falla no cambia el desenlace y deja un aviso sin datos', async () => {
    const { logger, calls } = spyLogger();
    const vault = {
      record: (): Promise<void> => Promise.reject(new Error('disco lleno con FirstName Ana')),
    };
    const result = await client({
      fetch: spyFetch(json({ Status: { Code: 200 }, ConfirmationNumber: 'X' })).fetch,
      payloadVault: vault,
      logger,
    }).send('book', {});
    expect(result.outcome).toBe('SUCCESS');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((c) => c.message)).toContain('tbo.payload_vault.failed');
    expect(JSON.stringify(calls)).not.toContain('FirstName');
  });

  it('una bóveda que lanza en síncrono tampoco', async () => {
    const vault = {
      record: (): void => {
        throw new Error('boom');
      },
    };
    const result = await client({ fetch: spyFetch(OK).fetch, payloadVault: vault }).send(
      'search',
      {},
    );
    expect(result.outcome).toBe('SUCCESS');
  });
});

// ---------------------------------------------------------------------------------------------
// La credencial no se vuelca (08 RF-01 CA-5; 01 §1.2)
// ---------------------------------------------------------------------------------------------

describe('el cliente serializado no contiene la credencial', () => {
  it('ni en JSON.stringify ni en util.inspect', () => {
    const subject = client({ fetch: spyFetch(OK).fetch, logger: spyLogger().logger });
    for (const dump of [
      JSON.stringify(subject),
      inspect(subject, { depth: 10, showHidden: true }),
    ]) {
      expect(dump).not.toContain(PASSWORD.trim());
      expect(dump).not.toContain(TOKEN);
      expect(dump).not.toContain(USERNAME);
    }
  });

  it('accountRef es un digest corto que no expone ni el tenant ni el usuario', () => {
    const ref = tboAccountRef('tenant-1', USERNAME);
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(tboAccountRef('tenant-1', USERNAME)).toBe(ref);
    expect(tboAccountRef('tenant-2', USERNAME)).not.toBe(ref);
    expect(tboAccountRef('tenant-1', 'otro-usuario')).not.toBe(ref);
    // Las partes van separadas: ("ab","c") no es ("a","bc").
    expect(tboAccountRef('ab', 'c')).not.toBe(tboAccountRef('a', 'bc'));
  });
});
