import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from '../auth/token.service';
import { SABRE_DEFAULT_MAX_CONCURRENT_REQUESTS, SABRE_HOSTS, type SabreConfig } from '../config';
import { SabreApiError, SabreConfigError } from '../errors';
import {
  SABRE_NON_IDEMPOTENT_PATHS,
  SabreHttpClient,
  isNonIdempotentSabrePath,
} from './sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';
const CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';

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

interface LogCall {
  level: string;
  message: string;
  meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, calls };
}

function fakeTokens(): SabreTokenProvider & { invalidated: number; issued: number } {
  const state = {
    invalidated: 0,
    issued: 0,
    getToken: () => {
      state.issued++;
      return Promise.resolve('ATK-SUPERSECRETO');
    },
    invalidate: () => {
      state.invalidated++;
      return Promise.resolve();
    },
  };
  return state;
}

interface FetchSpy {
  fetch: SabreFetch;
  calls: Array<{ url: string; init: RequestInit }>;
}

function spyFetch(responder: (n: number) => Response): FetchSpy {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(responder(calls.length));
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Cabeceras recibidas y el cuerpo se corta a medias, como un socket reseteado. */
function cutBody(status: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":[{"ancil'));
      controller.error(new TypeError('socket hang up 4111111111111111'));
    },
  });
  return new Response(stream, { status });
}

function client(
  spy: FetchSpy,
  extras: {
    logger?: LoggerPort;
    tokens?: SabreTokenProvider;
    cfg?: SabreConfig;
  } = {},
): { http: SabreHttpClient; tokens: SabreTokenProvider & { invalidated: number; issued: number } } {
  const tokens = (extras.tokens as ReturnType<typeof fakeTokens>) ?? fakeTokens();
  const http = new SabreHttpClient(extras.cfg ?? config(), tokens, {
    fetch: spy.fetch,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
    ...(extras.logger ? { logger: extras.logger } : {}),
  });
  return { http, tokens };
}

/*
 * El bloque que llamaba a `classifySabreEnvelope` directamente vivía aquí y se ha ido: el cliente
 * ya no expone clasificador propio, y probar la regla dura llamándola a mano fue justo lo que dejó
 * pasar 16 de 16 sobres hostiles en producción. La regla se prueba en `errors.test.ts` y, sobre
 * todo, extremo a extremo por `postJson` en `envelope-bypass.e2e.test.ts`.
 */
describe('SabreHttpClient — 200 con fallo de negocio', () => {
  it('un fixture 200-con-errors produce SabreApiError, no un resultado vacío', async () => {
    const spy = spyFetch(() =>
      json({
        errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CANCEL' }],
      }),
    );
    const { http } = client(spy);

    const error = (await http
      .postJson(SHOP_PATH, {}, { idempotent: true })
      .catch((e: unknown) => e)) as SabreApiError;

    expect(error).toBeInstanceOf(SabreApiError);
    expect(error.status).toBe(200);
    expect(error.issues).toHaveLength(1);
    expect(error.failure.kind).toBe('BUSINESS');
    // No cuenta para el breaker: el proveedor respondió, el negocio dijo que no.
    expect(error.failure.circuit).toBe('IGNORE');
    expect(spy.calls).toHaveLength(1);
  });

  it('un messages[].severity === "Error" también falla la operación', async () => {
    const spy = spyFetch(() =>
      json({ groupedItineraryResponse: { messages: [{ code: 'E1', severity: 'Error' }] } }),
    );
    const { http } = client(spy);
    await expect(http.postJson(SHOP_PATH, {}, { idempotent: true })).rejects.toBeInstanceOf(
      SabreApiError,
    );
  });

  it('un 200 con entitlement parcial se entrega, pero marcado y logueado', async () => {
    const spy = spyFetch(() =>
      json({
        warnings: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
        groupedItineraryResponse: { version: '5' },
      }),
    );
    const { logger, calls } = spyLogger();
    const { http } = client(spy, { logger });

    const result = await http.postJson(SHOP_PATH, {}, { idempotent: true });
    expect(result.partialUnauthorized).toHaveLength(1);
    expect(calls.some((c) => c.message === 'sabre.http.entitlement_parcial')).toBe(true);
  });
});

describe('SabreHttpClient — política de 401', () => {
  it('401 → re-auth + 1 reintento; el segundo 401 lanza SabreApiError', async () => {
    const spy = spyFetch(() => json({ message: 'Expired or invalid security token' }, 401));
    const { http, tokens } = client(spy);

    const error = (await http
      .postJson(SHOP_PATH, {}, { idempotent: true })
      .catch((e: unknown) => e)) as SabreApiError;

    expect(error).toBeInstanceOf(SabreApiError);
    expect(spy.calls).toHaveLength(2);
    expect(tokens.invalidated).toBe(1);
  });

  it('tras re-autenticar, el reintento que funciona devuelve datos', async () => {
    const spy = spyFetch((n) =>
      n === 1
        ? json({ message: 'token' }, 401)
        : json({ groupedItineraryResponse: { version: '5' } }),
    );
    const { http, tokens } = client(spy);

    const result = await http.postJson(SHOP_PATH, {}, { idempotent: true });
    expect(result.status).toBe(200);
    expect(tokens.invalidated).toBe(1);
    expect(spy.calls).toHaveLength(2);
  });
});

describe('SabreHttpClient — las operaciones con dinero no reintentan JAMÁS', () => {
  it.each(SABRE_NON_IDEMPOTENT_PATHS)('%s no reintenta un 401', async (path) => {
    const spy = spyFetch(() => json({ message: 'Expired or invalid security token' }, 401));
    const { http, tokens } = client(spy);

    await expect(http.postJson(path, {}, { idempotent: true })).rejects.toBeInstanceOf(
      SabreApiError,
    );
    // Reintentar una emisión la duplica: una sola llamada, y el token ni se invalida.
    expect(spy.calls).toHaveLength(1);
    expect(tokens.invalidated).toBe(0);
  });

  it('tampoco reintenta un 429 ni un 503', async () => {
    for (const status of [429, 503]) {
      const spy = spyFetch(() => json({ message: 'throttled' }, status));
      const { http } = client(spy);
      await expect(
        http.postJson(CREATE_BOOKING_PATH, {}, { idempotent: true }),
      ).rejects.toBeInstanceOf(SabreApiError);
      expect(spy.calls).toHaveLength(1);
    }
  });

  it('reconoce el path aunque venga con query o barra final', () => {
    expect(isNonIdempotentSabrePath('/v1/trip/orders/createBooking/')).toBe(true);
    expect(isNonIdempotentSabrePath('/v1/trip/orders/createBooking?x=1')).toBe(true);
    expect(isNonIdempotentSabrePath(SHOP_PATH)).toBe(false);
  });
});

describe('SabreHttpClient — reintentos de operaciones idempotentes', () => {
  it('un 429 se reintenta hasta el tope de intentos', async () => {
    const spy = spyFetch(() => json({ errorCode: 'ERR.2SG.GATEWAY.REQUEST_THROTTLED' }, 429));
    const { http } = client(spy);

    const error = (await http
      .postJson(SHOP_PATH, {}, { idempotent: true })
      .catch((e: unknown) => e)) as SabreApiError;

    expect(error.failure.kind).toBe('THROTTLED');
    expect(spy.calls).toHaveLength(3);
  });

  it('sin idempotent explícito no hay reintentos', async () => {
    const spy = spyFetch(() => json({ errorCode: 'ERR.2SG.GATEWAY.REQUEST_THROTTLED' }, 429));
    const { http } = client(spy);
    await expect(http.postJson(SHOP_PATH, {})).rejects.toBeInstanceOf(SabreApiError);
    expect(spy.calls).toHaveLength(1);
  });

  it('un 403 de entitlement no se reintenta y no abre circuito', async () => {
    const spy = spyFetch(() => json({ errorCode: 'ERR.2SG.SEC.NOT_AUTHORIZED' }, 403));
    const { http } = client(spy);

    const error = (await http
      .postJson(SHOP_PATH, {}, { idempotent: true })
      .catch((e: unknown) => e)) as SabreApiError;

    expect(error.code).toBe('ERR.2SG.SEC.NOT_AUTHORIZED');
    expect(error.failure.circuit).toBe('IGNORE');
    expect(spy.calls).toHaveLength(1);
  });
});

describe('SabreHttpClient — headers y modo mock', () => {
  it('manda Conversation-ID con el prefijo del tenant y Bearer del token', async () => {
    const spy = spyFetch(() => json({ groupedItineraryResponse: { version: '5' } }));
    const { http } = client(spy);

    const result = await http.postJson(SHOP_PATH, { OTA_AirLowFareSearchRQ: {} });
    const headers = spy.calls[0]?.init.headers as Record<string, string>;

    expect(headers['Conversation-ID']).toBe('sales-travel-conv-fijo');
    expect(headers['Authorization']).toBe('Bearer ATK-SUPERSECRETO');
    expect(headers['Content-Type']).toBe('application/json');
    expect(result.conversationId).toBe('sales-travel-conv-fijo');
    expect(spy.calls[0]?.url).toBe(`${SABRE_HOSTS.cert.rest}${SHOP_PATH}`);
  });

  it('emite X-Sabre-Group y X-Sabre-Current-City cuando la cuenta las declara', async () => {
    // Por la PUERTA PÚBLICA (`postJson`) y mirando lo que llega a `fetch`: `buildHeaders` es
    // privado y llamarlo a mano probaría la función, no lo que sale al cable — que es la
    // diferencia exacta que dejó el carril de grupo sin emitir mientras el guard del builder
    // comprobaba que la config lo tuviera.
    const spy = spyFetch(() => json({ groupedItineraryResponse: { version: '5' } }));
    const { http } = client(spy, {
      cfg: config({ sabreGroup: 'W0H3', sabreCurrentCity: 'BOG' }),
    });

    await http.postJson(SHOP_PATH, { OTA_AirLowFareSearchRQ: {} });
    const headers = spy.calls[0]?.init.headers as Record<string, string>;

    expect(headers['X-Sabre-Group']).toBe('W0H3');
    expect(headers['X-Sabre-Current-City']).toBe('BOG');
  });

  it('una cuenta sin grupo sale sin esas cabeceras, no con el string vacío', async () => {
    // Una cabecera presente y vacía NO es lo mismo que ausente: el proveedor la interpretaría
    // como un grupo declarado y en blanco.
    const spy = spyFetch(() => json({ groupedItineraryResponse: { version: '5' } }));
    const { http } = client(spy);

    await http.postJson(SHOP_PATH, { OTA_AirLowFareSearchRQ: {} });
    const headers = spy.calls[0]?.init.headers as Record<string, string>;

    expect(Object.hasOwn(headers, 'X-Sabre-Group')).toBe(false);
    expect(Object.hasOwn(headers, 'X-Sabre-Current-City')).toBe(false);
  });

  it('sin credenciales no sale ni una petición: es trabajo del modo mock', async () => {
    const spy = spyFetch(() => json({}));
    const { http } = client(spy, { cfg: { host: SABRE_HOSTS.cert.rest } });

    await expect(http.postJson(SHOP_PATH, {})).rejects.toBeInstanceOf(SabreConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('SabreHttpClient — redacción de logs (RNF-07, R-13)', () => {
  /**
   * El test que el plan pide antes de la primera llamada real: el transporte de logs nunca ve
   * `Authorization`, `secret`, `password`, `access_token` ni un body de reserva.
   */
  it('el transporte de logs nunca recibe secretos ni el body de una reserva', async () => {
    const bookingBody = {
      createBookingRQ: {
        travelers: [
          {
            givenName: 'Ana',
            surname: 'Pérez',
            passportNumber: 'AB1234567',
            birthDate: '1989-04-01',
          },
        ],
        paymentCard: { cardNumber: '4111111111111111', cardSecurityCode: '123' },
      },
    };
    const spy = spyFetch(() =>
      json({ errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] }),
    );
    const { logger, calls } = spyLogger();
    const { http } = client(spy, { logger });

    await http.postJson(CREATE_BOOKING_PATH, bookingBody).catch(() => undefined);

    const dump = JSON.stringify(calls);
    expect(calls.length).toBeGreaterThan(0);
    for (const forbidden of [
      'Authorization',
      'ATK-SUPERSECRETO',
      'Pa55w0rd!',
      'access_token',
      'AB1234567',
      '4111111111111111',
      'Ana',
      'Pérez',
    ]) {
      expect(dump).not.toContain(forbidden);
    }
    // Y sin embargo el log sirve para diagnosticar.
    expect(dump).toContain('UNABLE_TO_CREATE');
    expect(dump).toContain('conv-fijo');
  });

  it('el SabreApiError de un 500 no arrastra el cuerpo crudo', async () => {
    const spy = spyFetch(() =>
      json({ message: 'oops', echo: { password: 'Pa55w0rd!', access_token: 'ATK' } }, 500),
    );
    const { http } = client(spy);

    const error = (await http.postJson(SHOP_PATH, {}).catch((e: unknown) => e)) as SabreApiError;
    expect(error.message).not.toContain('Pa55w0rd!');
    expect(error.body).not.toContain('Pa55w0rd!');
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Semáforo por cuenta (RNF-04)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Todo por `postJson`, mirando cuántos `fetch` hay ABIERTOS a la vez: es lo único que Sabre ve. Las
 * dos direcciones importan igual: más de N en vuelo agota el cupo de la agencia, y un semáforo mal
 * hecho que serialice las búsquedas convierte el fan-out en una cola de uno.
 */

const SHOP_OK = { groupedItineraryResponse: { version: '5' } };

interface PendingFetch {
  readonly resolve: (res: Response) => void;
  readonly reject: (err: Error) => void;
}

interface GatedFetch {
  readonly fetch: SabreFetch;
  /** Rutas en el orden en que llegaron al cable. */
  readonly started: string[];
  inFlight(): number;
  maxInFlight(): number;
  /** Contesta el `fetch` abierto más antiguo. */
  releaseNext(response?: Response): void;
  /** Hace fallar el `fetch` abierto más antiguo, como una red caída. */
  failNext(error: Error): void;
}

/** `fetch` que no contesta hasta que el test lo suelta. Cuenta lo que hay abierto a cada momento. */
function gatedFetch(): GatedFetch {
  const pending: PendingFetch[] = [];
  const started: string[] = [];
  let open = 0;
  let peak = 0;
  const oldest = (): PendingFetch => {
    const head = pending.shift();
    if (head === undefined) throw new Error('no hay ningún fetch abierto que soltar');
    return head;
  };
  return {
    started,
    inFlight: () => open,
    maxInFlight: () => peak,
    fetch: (url) => {
      started.push(new URL(url).pathname);
      open++;
      peak = Math.max(peak, open);
      return new Promise<Response>((resolve, reject) => {
        pending.push({
          resolve: (res) => {
            open--;
            resolve(res);
          },
          reject: (err) => {
            open--;
            reject(err);
          },
        });
      });
    },
    releaseNext: (response = json(SHOP_OK)) => oldest().resolve(response),
    failNext: (error) => oldest().reject(error),
  };
}

/** Deja correr las microtareas y los timers ya vencidos: lo que tenía que salir al cable, salió. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Un `sleep` que no vuelve hasta que el test llama a `wake()`: congela un backoff a mitad. */
function frozenSleep(): { sleep: (ms: number) => Promise<void>; wake: () => void } {
  let resume: (() => void) | undefined;
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
    wake: () => {
      if (resume === undefined) throw new Error('nadie está durmiendo un backoff');
      resume();
    },
  };
}

function gatedClient(
  gated: GatedFetch,
  cfg: Partial<SabreConfig>,
  extras: {
    logger?: LoggerPort;
    sleep?: (ms: number) => Promise<void>;
    tokens?: SabreTokenProvider;
  } = {},
): SabreHttpClient {
  return new SabreHttpClient(config(cfg), extras.tokens ?? fakeTokens(), {
    fetch: gated.fetch,
    sleep: extras.sleep ?? (() => Promise.resolve()),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
    ...(extras.logger ? { logger: extras.logger } : {}),
  });
}

type MaybeNotSent = SabreApiError & { sentToProvider?: unknown };

describe('SabreHttpClient — semáforo de concurrencia por cuenta', () => {
  it('con N+1 llamadas simultáneas nunca hay más de N fetch en vuelo, y sí hay N', async () => {
    const gated = gatedFetch();
    const http = gatedClient(gated, { maxConcurrentRequests: 3 });

    const calls = [1, 2, 3, 4].map(() => http.postJson(SHOP_PATH, {}, { idempotent: true }));
    await settle();

    // Exactamente N: ni N+1 (se pasa del cupo) ni 1 (serializa el fan-out).
    expect(gated.started).toHaveLength(3);
    expect(gated.inFlight()).toBe(3);

    gated.releaseNext();
    await settle();
    // La cuarta sale en cuanto se libera un hueco, no al final de las tres.
    expect(gated.started).toHaveLength(4);

    gated.releaseNext();
    gated.releaseNext();
    gated.releaseNext();
    const results = await Promise.all(calls);

    expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200]);
    expect(gated.maxInFlight()).toBe(3);
  });

  it('sin `maxConcurrentRequests` en la cuenta, el tope es el default defensivo', async () => {
    const gated = gatedFetch();
    const http = gatedClient(gated, {});
    const total = SABRE_DEFAULT_MAX_CONCURRENT_REQUESTS + 2;

    const calls = Array.from({ length: total }, () => http.postJson(SHOP_PATH, {}));
    await settle();
    expect(gated.started).toHaveLength(SABRE_DEFAULT_MAX_CONCURRENT_REQUESTS);

    for (let i = 0; i < total; i++) {
      gated.releaseNext();
      await settle();
    }
    await Promise.all(calls);
    expect(gated.started).toHaveLength(total);
    expect(gated.maxInFlight()).toBe(SABRE_DEFAULT_MAX_CONCURRENT_REQUESTS);
  });

  it('el cupo es de la INSTANCIA: la llamada de otra cuenta no espera a ésta', async () => {
    const gated = gatedFetch();
    const cuentaA = gatedClient(gated, { maxConcurrentRequests: 1 });
    const cuentaB = gatedClient(gated, { maxConcurrentRequests: 1, homePcc: 'YYYY' });

    const calls = [cuentaA.postJson(SHOP_PATH, {}), cuentaB.postJson(SHOP_PATH, {})];
    await settle();
    expect(gated.started).toHaveLength(2);

    gated.releaseNext();
    gated.releaseNext();
    await Promise.all(calls);
  });

  it('la espera vence con el timeout de la petición: THROTTLED, sin salir al cable ni abrir circuito', async () => {
    const gated = gatedFetch();
    const { logger, calls: logs } = spyLogger();
    const http = gatedClient(gated, { maxConcurrentRequests: 1 }, { logger });

    const ocupada = http.postJson(SHOP_PATH, {});
    await settle();
    const error = (await http
      .postJson(CREATE_BOOKING_PATH, { travelers: [] }, { timeoutMs: 25 })
      .catch((caught: unknown) => caught)) as MaybeNotSent;

    expect(error).toBeInstanceOf(SabreApiError);
    expect(error.failure.kind).toBe('THROTTLED');
    // La saturación es de la cuenta, no de Sabre: no puede abrir el circuito de toda la red.
    expect(error.failure.circuit).toBe('IGNORE');
    expect(error.failure.disableAccount).toBe(false);
    // Contrato neutral de `apps/api`: «no salió», así que repetirla no duplica una reserva.
    expect(error.sentToProvider).toBe(false);
    expect(gated.started).toEqual([SHOP_PATH]);

    const vencida = logs.find((call) => call.message === 'sabre.http.cola_vencida');
    expect(vencida?.level).toBe('warn');
    expect(vencida?.meta?.['moneyOperation']).toBe(true);
    expect(vencida?.meta?.['maxConcurrent']).toBe(1);
    expect(vencida?.meta?.['kind']).toBe('THROTTLED');

    gated.releaseNext();
    await expect(ocupada).resolves.toMatchObject({ status: 200 });
  });

  it('una espera vencida no se queda con el hueco: sale UNA de las que esperan al liberarse', async () => {
    const gated = gatedFetch();
    const { logger, calls: logs } = spyLogger();
    const http = gatedClient(gated, { maxConcurrentRequests: 1 }, { logger });

    const ocupada = http.postJson(SHOP_PATH, {});
    await settle();
    await expect(http.postJson(SHOP_PATH, {}, { timeoutMs: 10 })).rejects.toBeInstanceOf(
      SabreApiError,
    );

    const siguiente = http.postJson(SHOP_PATH, {});
    const otra = http.postJson(SHOP_PATH, {});
    await settle();
    expect(gated.started).toHaveLength(1);

    gated.releaseNext();
    await settle();
    // Sale UNA de las dos en espera, no las dos: el hueco de la vencida no se regaló.
    expect(gated.started).toHaveLength(2);
    expect(gated.inFlight()).toBe(1);

    gated.releaseNext();
    await settle();
    gated.releaseNext();
    await Promise.all([ocupada, siguiente, otra]);
    expect(gated.maxInFlight()).toBe(1);
    // Las que esperaron lo dicen en el log: es el dato para calibrar el cupo de la cuenta.
    expect(logs.filter((call) => call.message === 'sabre.http.en_cola')).toHaveLength(2);
  });

  it('un fallo del token o de la red también devuelve el hueco', async () => {
    const gated = gatedFetch();
    const base = fakeTokens();
    let tokenFails = true;
    const tokens: SabreTokenProvider = {
      getToken: () => {
        if (!tokenFails) return base.getToken();
        tokenFails = false;
        return Promise.reject(new Error('token caído'));
      },
      invalidate: () => base.invalidate(),
    };
    const http = gatedClient(gated, { maxConcurrentRequests: 1 }, { tokens });

    await expect(http.postJson(SHOP_PATH, {})).rejects.toThrow('token caído');

    const caida = http.postJson(CREATE_BOOKING_PATH, {});
    const detras = http.postJson(SHOP_PATH, {});
    await settle();
    expect(gated.started).toEqual([CREATE_BOOKING_PATH]);

    gated.failNext(new Error('ECONNRESET'));
    await expect(caida).rejects.toBeInstanceOf(SabreApiError);
    await settle();
    expect(gated.started).toEqual([CREATE_BOOKING_PATH, SHOP_PATH]);

    gated.releaseNext();
    await expect(detras).resolves.toMatchObject({ status: 200 });
  });

  it('el hueco se suelta durante el backoff: dormir no bloquea a las demás llamadas', async () => {
    const gated = gatedFetch();
    const frozen = frozenSleep();
    const http = gatedClient(gated, { maxConcurrentRequests: 1 }, { sleep: frozen.sleep });

    const reintenta = http.postJson(SHOP_PATH, {}, { idempotent: true });
    await settle();
    gated.releaseNext(json({ errorCode: 'ERR.2SG.GATEWAY.REQUEST_THROTTLED' }, 429));
    await settle();

    // Mientras la primera duerme su backoff, la segunda tiene el hueco.
    const mientras = http.postJson(CREATE_BOOKING_PATH, {});
    await settle();
    expect(gated.started).toEqual([SHOP_PATH, CREATE_BOOKING_PATH]);

    frozen.wake();
    await settle();
    // El reintento espera su turno: el cupo sigue siendo 1.
    expect(gated.started).toHaveLength(2);

    gated.releaseNext(json({ errors: [{ category: 'APPLICATION_ERROR', type: 'X' }] }));
    await expect(mientras).rejects.toBeInstanceOf(SabreApiError);
    await settle();
    expect(gated.started).toEqual([SHOP_PATH, CREATE_BOOKING_PATH, SHOP_PATH]);

    gated.releaseNext();
    await expect(reintenta).resolves.toMatchObject({ status: 200 });
    expect(gated.maxInFlight()).toBe(1);
  });

  it('si un intento anterior ya salió, la espera vencida del reintento no afirma «no salió»', async () => {
    const gated = gatedFetch();
    const frozen = frozenSleep();
    const http = gatedClient(gated, { maxConcurrentRequests: 1 }, { sleep: frozen.sleep });

    const lectura = http.postJson(SHOP_PATH, {}, { idempotent: true, timeoutMs: 25 });
    await settle();
    gated.releaseNext(json({ message: 'unavailable' }, 503));
    await settle();

    const ocupa = http.postJson(SHOP_PATH, {});
    await settle();
    frozen.wake();

    const error = (await lectura.catch((caught: unknown) => caught)) as MaybeNotSent;
    expect(error.failure.kind).toBe('THROTTLED');
    expect(error.sentToProvider).toBe(true);
    expect(gated.started).toEqual([SHOP_PATH, SHOP_PATH]);

    gated.releaseNext();
    await ocupa;
  });
});

describe('SabreHttpClient — Stateless Ancillaries: agregar y quitar escriben en el PNR (SAB-19)', () => {
  // Literales y no las constantes del builder: lo que se fija es la ruta del contrato
  // (`stateless-ancillaries-api-1.0.yml:11`, `:47`, `:66`), no lo que el builder diga hoy. Las dos
  // llevan `isCommitEnabled`: un alta reintentada tras un timeout cobra la maleta dos veces.
  const WRITES = ['/v1/dc/ancillaries/add', '/v1/dc/ancillaries/remove'] as const;

  it('las dos rutas de escritura están en la lista', () => {
    for (const path of WRITES) expect(SABRE_NON_IDEMPOTENT_PATHS).toContain(path);
  });

  it.each(WRITES)('%s no se reintenta tras un 503 ni un 401, aunque se pida', async (path) => {
    for (const status of [503, 401]) {
      const spy = spyFetch(() => json({ message: 'down' }, status));
      const { http, tokens } = client(spy);
      await expect(http.postJson(path, {}, { idempotent: true })).rejects.toBeInstanceOf(
        SabreApiError,
      );
      expect(spy.calls).toHaveLength(1);
      expect(tokens.invalidated).toBe(0);
    }
  });

  it('/v1/dc/ancillaries/shop es una lectura: con idempotent sí se reintenta', async () => {
    const spy = spyFetch((n) =>
      n === 1 ? json({ message: 'down' }, 503) : json({ offers: [{ id: 'o', items: [{}] }] }),
    );
    const { http } = client(spy);
    const result = await http.postJson('/v1/dc/ancillaries/shop', {}, { idempotent: true });
    expect(result.status).toBe(200);
    expect(spy.calls).toHaveLength(2);
  });

  it('un cuerpo cortado tras las cabeceras es fallo de transporte: la escritura no se reintenta', async () => {
    // `fetch` resuelve con las cabeceras; el alta ya llegó y puede estar aplicada. Antes salía un
    // `TypeError` crudo, que el adapter lee como «no se escribió nada».
    for (const path of WRITES) {
      const spy = spyFetch(() => cutBody(200));
      const { http } = client(spy);
      const error = await http.postJson(path, {}, { idempotent: true }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(SabreApiError);
      expect((error as SabreApiError).status).toBe(0);
      expect((error as SabreApiError).failure.kind).toBe('TRANSPORT');
      expect((error as SabreApiError).message).not.toContain('socket');
      expect((error as SabreApiError).message).not.toContain('4111');
      expect(spy.calls).toHaveLength(1);
    }
  });

  it('un cuerpo cortado en /shop sí se reintenta: es una lectura', async () => {
    const spy = spyFetch((n) => (n === 1 ? cutBody(200) : json({ offers: [{ id: 'o' }] })));
    const { http } = client(spy);
    const result = await http.postJson('/v1/dc/ancillaries/shop', {}, { idempotent: true });
    expect(result.status).toBe(200);
    expect(spy.calls).toHaveLength(2);
  });

  it('un {} en /v1/dc/ancillaries/remove no es éxito: no es el contrato de Manage Ancillary', async () => {
    // `SABRE_EMPTY_BODY_SUCCESS_PATHS` admite `{}` en `/v1/ancillaries/remove`, cuyo schema sólo
    // declara `errors[]`. El de Stateless declara `results[]`: aquí `{}` es un fallo silencioso.
    const spy = spyFetch(() => json({}));
    const { http } = client(spy);
    await expect(http.postJson('/v1/dc/ancillaries/remove', {})).rejects.toBeInstanceOf(
      SabreApiError,
    );
    expect(spy.calls).toHaveLength(1);
  });
});
