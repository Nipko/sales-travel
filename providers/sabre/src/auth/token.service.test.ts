import type { CachePort, LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { SabreApiError, SabreConfigError } from '../errors';
import { SabreTokenService, deriveSabreSecret, type SabreFetch } from './token.service';

const CREDENTIALS = { epr: '500001', homePcc: 'U9PK', password: 'Pa55w0rd!' } as const;

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return { host: SABRE_HOSTS.cert.rest, ...CREDENTIALS, ...overrides };
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

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function memoryCache(): CachePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string) => Promise.resolve((store.get(key) ?? null) as T | null),
    set: <T>(key: string, value: T) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
    invalidatePattern: () => Promise.resolve(),
  };
}

/**
 * Oráculo independiente: reimplementa el algoritmo tal cual está en el script pre-request de la
 * colección oficial y en `tools/sabre/cert-probe.mjs`. Si `deriveSabreSecret` se desvía, este
 * test lo ve.
 */
function oracleSecret(epr: string, pcc: string, password: string, domain = 'AA'): string {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
  return b64(`${b64(`V1:${epr}:${pcc}:${domain}`)}:${b64(password)}`);
}

describe('deriveSabreSecret', () => {
  it('reproduce el ejemplo publicado en docs/sabre/01 §2.1 byte a byte', () => {
    expect(deriveSabreSecret({ epr: '500001', homePcc: 'U9PK', password: 'Pa55w0rd!' })).toBe(
      'VmpFNk5UQXdNREF4T2xVNVVFczZRVUU9OlVHRTFOWGN3Y21RaA==',
    );
  });

  it('coincide con el oráculo para el caso del criterio de salida', () => {
    expect(deriveSabreSecret({ epr: '500001', homePcc: 'U9PK', password: 'x' })).toBe(
      oracleSecret('500001', 'U9PK', 'x'),
    );
  });

  it('el Domain entra en el clientId y cambia el secret', () => {
    const aa = deriveSabreSecret({ ...CREDENTIALS, domain: 'AA' });
    const other = deriveSabreSecret({ ...CREDENTIALS, domain: 'DEFAULT' });
    expect(aa).not.toBe(other);
    expect(other).toBe(oracleSecret('500001', 'U9PK', 'Pa55w0rd!', 'DEFAULT'));
  });

  it('es reversible — por eso no se persiste ni se loguea', () => {
    const secret = deriveSabreSecret(CREDENTIALS);
    const inner = Buffer.from(secret, 'base64').toString('utf8');
    const password = Buffer.from(inner.split(':')[1] ?? '', 'base64').toString('utf8');
    expect(password).toBe('Pa55w0rd!');
  });
});

describe('SabreTokenService — caché', () => {
  it('dos llamadas producen una sola petición HTTP', async () => {
    const spy = spyFetch(() => tokenResponse({ access_token: 'ATK-1', expires_in: 604800 }));
    const service = new SabreTokenService(config(), { fetch: spy.fetch });

    expect(await service.getToken()).toBe('ATK-1');
    expect(await service.getToken()).toBe('ATK-1');
    expect(spy.calls).toHaveLength(1);
  });

  it('N llamadas concurrentes coalescen en una sola autenticación', async () => {
    const spy = spyFetch(() => tokenResponse({ access_token: 'ATK-1', expires_in: 604800 }));
    const service = new SabreTokenService(config(), { fetch: spy.fetch });

    const tokens = await Promise.all([service.getToken(), service.getToken(), service.getToken()]);
    expect(tokens).toEqual(['ATK-1', 'ATK-1', 'ATK-1']);
    expect(spy.calls).toHaveLength(1);
  });

  it('aplica el margen del 10 % sobre expires_in y re-autentica al vencer', async () => {
    let now = 1_000_000;
    const spy = spyFetch((n) => tokenResponse({ access_token: `ATK-${n}`, expires_in: 100 }));
    const service = new SabreTokenService(config(), { fetch: spy.fetch, now: () => now });

    expect(await service.getToken()).toBe('ATK-1');
    now += 89_000;
    expect(await service.getToken()).toBe('ATK-1');
    now += 2_000;
    expect(await service.getToken()).toBe('ATK-2');
    expect(spy.calls).toHaveLength(2);
  });

  // docs/sabre/01 §7.1: `expires_in` no aparece en ningún contrato. Si falta, se usa el TTL de
  // config — pero se dice en el log, nunca en silencio (RF-01 CA-3).
  it('sin expires_in usa tokenTtlSeconds y avisa', async () => {
    const spy = spyFetch(() => tokenResponse({ access_token: 'ATK-1' }));
    const { logger, calls } = spyLogger();
    const service = new SabreTokenService(config({ tokenTtlSeconds: 120 }), {
      fetch: spy.fetch,
      logger,
    });

    expect(await service.getToken()).toBe('ATK-1');
    const warn = calls.find((c) => c.message === 'sabre.token.sin_expires_in');
    expect(warn?.meta?.['ttlSeconds']).toBe(120);
  });

  it('usa el port de caché para no agotar el TAM Pool entre réplicas', async () => {
    const cache = memoryCache();
    const first = spyFetch(() => tokenResponse({ access_token: 'ATK-1', expires_in: 604800 }));
    const second = spyFetch(() => tokenResponse({ access_token: 'ATK-2', expires_in: 604800 }));

    const replicaA = new SabreTokenService(config(), {
      fetch: first.fetch,
      cache,
      cacheNamespace: 'tenant-1',
    });
    const replicaB = new SabreTokenService(config(), {
      fetch: second.fetch,
      cache,
      cacheNamespace: 'tenant-1',
    });

    expect(await replicaA.getToken()).toBe('ATK-1');
    expect(await replicaB.getToken()).toBe('ATK-1');
    expect(second.calls).toHaveLength(0);
    expect(replicaA.cacheKey).toMatch(/^sabre:atk:tenant-1:U9PK:[0-9a-f]{16}$/);
  });

  it('la clave de caché incluye el PCC: el ATK está atado al par (EPR, PCC)', () => {
    const home = new SabreTokenService(config(), { cacheNamespace: 'tenant-1' });
    const ticketing = new SabreTokenService(config({ homePcc: '7KFA' }), {
      cacheNamespace: 'tenant-1',
    });
    expect(home.cacheKey).not.toBe(ticketing.cacheKey);
  });

  it('invalidate borra memoria y caché distribuida', async () => {
    const cache = memoryCache();
    const spy = spyFetch((n) => tokenResponse({ access_token: `ATK-${n}`, expires_in: 604800 }));
    const service = new SabreTokenService(config(), {
      fetch: spy.fetch,
      cache,
      cacheNamespace: 'tenant-1',
    });

    expect(await service.getToken()).toBe('ATK-1');
    await service.invalidate();
    expect(cache.store.size).toBe(0);
    expect(await service.getToken()).toBe('ATK-2');
  });
});

/**
 * El ATK no lo determina el par (tenant, PCC) sino la tupla completa que entra en el `secret`
 * (host, EPR, PCC, Domain, password). Con la clave vieja —`sabre:atk:{tenant}:{pcc}`— dos oficinas
 * del mismo tenant con EPR distinto sobre el mismo Redis se pisaban el token: la segunda operaba
 * con las credenciales de la primera. Estos tests son la regresión de ese fallo.
 */
describe('SabreTokenService — la clave de caché aísla identidades de credencial', () => {
  interface Replica {
    service: SabreTokenService;
    calls: Array<{ url: string; init: RequestInit }>;
  }

  function replica(
    cache: CachePort,
    token: string,
    overrides: Partial<SabreConfig> = {},
    namespace = 'tenant-1',
  ): Replica {
    const spy = spyFetch(() => tokenResponse({ access_token: token, expires_in: 604800 }));
    return {
      calls: spy.calls,
      service: new SabreTokenService(config(overrides), {
        fetch: spy.fetch,
        cache,
        cacheNamespace: namespace,
      }),
    };
  }

  it('dos cuentas que sólo difieren en EPR no comparten token', async () => {
    const cache = memoryCache();
    const oficinaA = replica(cache, 'ATK-EPR-A', { epr: '500001' });
    const oficinaB = replica(cache, 'ATK-EPR-B', { epr: '600002' });

    expect(await oficinaA.service.getToken()).toBe('ATK-EPR-A');
    expect(await oficinaB.service.getToken()).toBe('ATK-EPR-B');
    expect(oficinaB.calls).toHaveLength(1);
    expect(oficinaA.service.cacheKey).not.toBe(oficinaB.service.cacheKey);
  });

  // Rotar el password cambia el `secret` y por tanto el ATK: el token viejo sigue en Redis con su
  // TTL, y sin esto la instancia nueva lo reutilizaría hasta que venciera.
  it('dos cuentas que sólo difieren en password no comparten token', async () => {
    const cache = memoryCache();
    const antes = replica(cache, 'ATK-PWD-VIEJO', { password: 'Pa55w0rd!' });
    const despues = replica(cache, 'ATK-PWD-NUEVO', { password: 'Pa55w0rd-rotado!' });

    expect(await antes.service.getToken()).toBe('ATK-PWD-VIEJO');
    expect(await despues.service.getToken()).toBe('ATK-PWD-NUEVO');
    expect(despues.calls).toHaveLength(1);
    expect(antes.service.cacheKey).not.toBe(despues.service.cacheKey);
  });

  it('dos cuentas que sólo difieren en Domain no comparten token', async () => {
    const cache = memoryCache();
    const aa = replica(cache, 'ATK-AA', { domain: 'AA' });
    const other = replica(cache, 'ATK-DEFAULT', { domain: 'DEFAULT' });

    expect(await aa.service.getToken()).toBe('ATK-AA');
    expect(await other.service.getToken()).toBe('ATK-DEFAULT');
    expect(other.calls).toHaveLength(1);
  });

  // Un ATK de CERT no vale en PROD: el host es parte de la identidad del token, no decoración.
  it('las mismas credenciales en CERT y en PROD no comparten token', async () => {
    const cache = memoryCache();
    const cert = replica(cache, 'ATK-CERT', { host: SABRE_HOSTS.cert.rest });
    const prod = replica(cache, 'ATK-PROD', { host: SABRE_HOSTS.prod.rest });

    expect(await cert.service.getToken()).toBe('ATK-CERT');
    expect(await prod.service.getToken()).toBe('ATK-PROD');
    expect(prod.calls).toHaveLength(1);
  });

  it('la misma tupla (tenant, EPR, PCC, password) SÍ reusa el token cacheado', async () => {
    const cache = memoryCache();
    const primera = replica(cache, 'ATK-COMPARTIDO');
    const segunda = replica(cache, 'ATK-QUE-NUNCA-SE-PIDE');

    expect(await primera.service.getToken()).toBe('ATK-COMPARTIDO');
    expect(await segunda.service.getToken()).toBe('ATK-COMPARTIDO');
    expect(segunda.calls).toHaveLength(0);
    expect(primera.service.cacheKey).toBe(segunda.service.cacheKey);
  });

  it('tenants distintos con credenciales idénticas siguen aislados', () => {
    const cache = memoryCache();
    const uno = replica(cache, 'ATK-1', {}, 'tenant-1');
    const dos = replica(cache, 'ATK-2', {}, 'tenant-2');
    expect(uno.service.cacheKey).not.toBe(dos.service.cacheKey);
  });

  // Una clave de caché acaba en logs, en dashboards y en cualquier `SCAN` de Redis: la huella es
  // un digest truncado, nunca el password ni el `secret` (RNF-07).
  it('la clave no filtra el password ni el secret derivado', () => {
    const service = new SabreTokenService(config(), { cacheNamespace: 'tenant-1' });
    const key = service.cacheKey;

    expect(key).not.toContain('Pa55w0rd!');
    expect(key).not.toContain(deriveSabreSecret(CREDENTIALS));
    expect(key).not.toContain(Buffer.from('Pa55w0rd!', 'utf8').toString('base64'));
    // 64 bits: suficiente para separar cuentas, insuficiente para reconstruir nada.
    expect(key.split(':').at(-1)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('la huella es determinista entre procesos: dos instancias iguales dan la misma clave', () => {
    const a = new SabreTokenService(config(), { cacheNamespace: 'tenant-1' });
    const b = new SabreTokenService(config(), { cacheNamespace: 'tenant-1' });
    expect(a.cacheKey).toBe(b.cacheKey);
  });

  // Sin credenciales no hay token que cachear, pero `cacheKey` se lee en logs de error: no debe
  // reventar ni colapsar todas las cuentas incompletas en la misma clave que una real.
  it('sin credenciales la clave sigue siendo legible y distinta de la de una cuenta real', () => {
    const vacio = new SabreTokenService({ host: SABRE_HOSTS.cert.rest }, {});
    expect(vacio.cacheKey).toMatch(/^sabre:atk:default:unknown:[0-9a-f]{16}$/);
    expect(vacio.cacheKey).not.toBe(new SabreTokenService(config(), {}).cacheKey);
  });
});

describe('SabreTokenService — errores', () => {
  it('sin credenciales no llama a Sabre: lanza SabreConfigError', async () => {
    const spy = spyFetch(() => tokenResponse({ access_token: 'nunca' }));
    const service = new SabreTokenService({ host: SABRE_HOSTS.cert.rest }, { fetch: spy.fetch });

    await expect(service.getToken()).rejects.toBeInstanceOf(SabreConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('invalid_client reintenta con backoff y no deshabilita la cuenta', async () => {
    const spy = spyFetch(() =>
      tokenResponse({ error: 'invalid_client', error_description: 'TAM Pool' }, 401),
    );
    const waits: number[] = [];
    const service = new SabreTokenService(config(), {
      fetch: spy.fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      jitter: () => 0,
    });

    const error = (await service.getToken().catch((e: unknown) => e)) as SabreApiError;
    expect(error).toBeInstanceOf(SabreApiError);
    expect(error.failure.kind).toBe('AUTH_POOL');
    expect(error.failure.disableAccount).toBe(false);
    expect(spy.calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('una credencial mala no se reintenta ni una vez', async () => {
    const spy = spyFetch(() =>
      tokenResponse(
        { error: 'invalid_client', error_description: 'Wrong clientID or clientSecret' },
        401,
      ),
    );
    const service = new SabreTokenService(config(), {
      fetch: spy.fetch,
      sleep: () => Promise.resolve(),
    });

    const error = (await service.getToken().catch((e: unknown) => e)) as SabreApiError;
    expect(error.failure.kind).toBe('CREDENTIALS_INVALID');
    expect(error.failure.disableAccount).toBe(true);
    expect(spy.calls).toHaveLength(1);
  });

  it('un 200 sin access_token es un error, no un token vacío', async () => {
    const spy = spyFetch(() => tokenResponse({ token_type: 'bearer' }));
    const service = new SabreTokenService(config(), { fetch: spy.fetch });
    await expect(service.getToken()).rejects.toBeInstanceOf(SabreApiError);
  });
});

describe('SabreTokenService — redacción (RNF-07)', () => {
  it('el transporte de logs nunca recibe el secret, el password ni el access_token', async () => {
    const spy = spyFetch((n) =>
      n === 1
        ? tokenResponse({ error: 'invalid_client' }, 401)
        : tokenResponse({ access_token: 'ATK-SUPERSECRETO' }),
    );
    const { logger, calls } = spyLogger();
    const service = new SabreTokenService(config(), {
      fetch: spy.fetch,
      logger,
      sleep: () => Promise.resolve(),
      jitter: () => 0,
    });

    await service.getToken();

    const secret = deriveSabreSecret(CREDENTIALS);
    const dump = JSON.stringify(calls);
    expect(calls.length).toBeGreaterThan(0);
    for (const forbidden of [secret, 'Pa55w0rd!', 'ATK-SUPERSECRETO', 'Basic ', 'Authorization']) {
      expect(dump).not.toContain(forbidden);
    }
  });

  it('el header Authorization se manda pero jamás se guarda ni se reexpone', async () => {
    const spy = spyFetch(() => tokenResponse({ access_token: 'ATK-1', expires_in: 604800 }));
    const service = new SabreTokenService(config(), { fetch: spy.fetch });
    await service.getToken();

    const headers = spy.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${deriveSabreSecret(CREDENTIALS)}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(spy.calls[0]?.init.body).toBe('grant_type=client_credentials');
    expect(spy.calls[0]?.url).toBe(`${SABRE_HOSTS.cert.rest}/v2/auth/token`);
  });
});
