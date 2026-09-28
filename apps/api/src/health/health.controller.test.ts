import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { HealthController } from './health.controller.js';

/**
 * `GET /health` es `@Public()`: lo que devuelve lo lee cualquiera, sin token.
 *
 * Desde PR-0.6 el breaker lleva además un circuito por cuenta de proveedor. La propiedad que se
 * fija acá es que esos circuitos no salen por esta ruta: ni su huella ni, aunque alguien pasara
 * por error el id del tenant como huella, el id del tenant.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function controlador(breaker: CircuitBreakerService, ping: () => Promise<boolean>) {
  const db = { ping } as unknown as DatabaseService;
  return new HealthController(db, breaker);
}

/** Un fallo de credencial de la cuenta, como lo clasifica un ACL con `OPEN_ACCOUNT`. */
function credencialRechazada(): Error {
  return Object.assign(new Error('credencial rechazada'), {
    failure: { kind: 'CREDENTIALS_INVALID', circuit: 'OPEN_ACCOUNT' },
  });
}

describe('HealthController', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publica los circuitos por código y NO los de cuenta ni ids de tenant', async () => {
    const breaker = new CircuitBreakerService();
    await breaker
      .execute('prov-a', () => Promise.reject(new Error('caído')))
      .catch(() => undefined);
    for (const accountRef of ['acct-3f9a1c', TENANT]) {
      await breaker
        .execute('prov-b', () => Promise.reject(credencialRechazada()), { accountRef })
        .catch(() => undefined);
    }
    // La cuenta quedó suspendida de verdad: el test no pasa por no haberla abierto.
    await expect(
      breaker.execute('prov-b', () => Promise.resolve('ok'), { accountRef: TENANT }),
    ).rejects.toMatchObject({ reason: 'account-circuit' });

    const res = await controlador(breaker, () => Promise.resolve(true)).check();

    expect(res.providers).toEqual({
      'prov-a': { state: 'closed', failures: 1 },
      'prov-b': { state: 'closed', failures: 0 },
    });
    const publicado = JSON.stringify(res);
    expect(publicado).not.toContain(TENANT);
    expect(publicado).not.toContain('acct-3f9a1c');
    expect(publicado).not.toContain('@');
  });

  it('base caída → 503 sin tocar el breaker', async () => {
    const breaker = new CircuitBreakerService();
    const snapshot = vi.spyOn(breaker, 'snapshot');

    for (const ping of [
      () => Promise.resolve(false),
      () => Promise.reject(new Error('ECONNREFUSED')),
    ]) {
      await expect(controlador(breaker, ping).check()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    }
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('base viva → estado, versión y circuitos', async () => {
    vi.stubEnv('APP_VERSION', 'v9.9.9');
    try {
      const res = await controlador(new CircuitBreakerService(), () =>
        Promise.resolve(true),
      ).check();
      expect(res).toMatchObject({
        status: 'ok',
        version: 'v9.9.9',
        checks: { db: 'ok' },
        providers: {},
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
