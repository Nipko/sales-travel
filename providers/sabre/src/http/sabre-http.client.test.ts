import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from '../auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from '../config';
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
