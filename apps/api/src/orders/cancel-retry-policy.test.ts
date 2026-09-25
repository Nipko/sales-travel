import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreakerRejectionError, CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { classifyCancelThrownFailure, persistedCancelRetryPolicy } from './cancel-retry-policy.js';

function typedError(
  name: string,
  fields: Readonly<Record<string, unknown>> = {},
): Error & Record<string, unknown> {
  const error = new Error(name) as Error & Record<string, unknown>;
  error.name = name;
  return Object.assign(error, fields);
}

describe('classifyCancelThrownFailure', () => {
  it('un build determinista no es reintentable ni entra a conciliación', () => {
    expect(classifyCancelThrownFailure(typedError('SabreCancelBookingBuildError'))).toEqual({
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
      reason: 'deterministic',
    });
  });

  it('un rechazo de negocio no se reintenta', () => {
    expect(
      classifyCancelThrownFailure(
        typedError('SabreApiError', {
          path: '/v1/trip/orders/cancelBooking',
          status: 200,
          retryable: false,
          failure: { kind: 'BUSINESS', retry: 'NO_RETRY' },
        }),
      ),
    ).toEqual({
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
      reason: 'provider-rejected',
    });
  });

  it('un timeout del write queda UNVERIFIED aunque la política HTTP diga retryable', () => {
    expect(
      classifyCancelThrownFailure(
        typedError('SabreApiError', {
          path: '/v1/trip/orders/cancelBooking',
          status: 0,
          retryable: true,
          failure: { kind: 'TRANSPORT', retry: 'RETRY_BACKOFF' },
        }),
      ),
    ).toEqual({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'write-unverified',
    });
  });

  it('un fallo transitorio del get/check anterior al write sí se puede reintentar', () => {
    expect(
      classifyCancelThrownFailure(
        typedError('SabreApiError', {
          path: '/v1/trip/orders/getBooking',
          status: 503,
          retryable: true,
          failure: { kind: 'UPSTREAM', retry: 'RETRY_BACKOFF' },
        }),
      ),
    ).toEqual({
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      reason: 'pre-write-transient',
    });
  });

  it('no adivina con un error desconocido: exige conciliación', () => {
    expect(classifyCancelThrownFailure(new Error('falló'))).toMatchObject({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
    });
  });
});

describe('classifyCancelThrownFailure — rechazo local del breaker (PR-0.6)', () => {
  const PRE_WRITE = {
    outcome: 'FAILED',
    retryable: true,
    reconciliationRequired: false,
    reason: 'pre-write-transient',
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Lo que recibe el runner cuando la cancelación pasa por el breaker y éste la frena. */
  async function rechazoDelBreaker(breaker: CircuitBreakerService): Promise<unknown> {
    const cancelar = vi.fn(() => Promise.resolve({ success: true }));
    const err = await breaker
      .execute('prov-a', cancelar, { scope: 'post-sale' })
      .catch((e: unknown) => e);
    expect(cancelar).not.toHaveBeenCalled();
    return err;
  }

  it('kill-switch en Cancel → previo al write, reintentable, sin conciliar', async () => {
    // Antes era un 503 sin `path`: caía en el caso por defecto y quedaba UNVERIFIED, con
    // conciliación y escalado, aunque la cancelación nunca salió.
    vi.stubEnv('PROVIDERS_DISABLED', 'prov-a');
    const err = await rechazoDelBreaker(new CircuitBreakerService());

    expect(err).toBeInstanceOf(BreakerRejectionError);
    expect(classifyCancelThrownFailure(err)).toEqual(PRE_WRITE);
  });

  it('circuito abierto en Cancel → previo al write', async () => {
    const breaker = new CircuitBreakerService();
    for (let i = 0; i < 5; i++) {
      await breaker
        .execute('prov-a', () => Promise.reject(new Error('caído')))
        .catch(() => undefined);
    }

    expect(classifyCancelThrownFailure(await rechazoDelBreaker(breaker))).toEqual(PRE_WRITE);
  });

  it('cuenta suspendida en Cancel → previo al write', async () => {
    const breaker = new CircuitBreakerService();
    await breaker
      .execute(
        'prov-a',
        () =>
          Promise.reject(
            typedError('ProvApiError', {
              failure: { kind: 'CREDENTIALS_INVALID', circuit: 'OPEN_ACCOUNT' },
            }),
          ),
        { accountRef: 'acct-1', scope: 'post-sale' },
      )
      .catch(() => undefined);

    const cancelar = vi.fn(() => Promise.resolve({ success: true }));
    const err = await breaker
      .execute('prov-a', cancelar, { accountRef: 'acct-1', scope: 'post-sale' })
      .catch((e: unknown) => e);
    expect(cancelar).not.toHaveBeenCalled();
    expect(classifyCancelThrownFailure(err)).toEqual(PRE_WRITE);
  });

  it('un timeout del write que cruzó el breaker sigue UNVERIFIED: la marca es sólo del rechazo local', async () => {
    const timeout = typedError('ProvApiError', {
      path: '/cancel',
      status: 0,
      retryable: true,
      failure: { kind: 'TRANSPORT', retry: 'RETRY_BACKOFF', circuit: 'COUNT' },
    });
    const err = await new CircuitBreakerService()
      .execute('prov-a', () => Promise.reject(timeout), { scope: 'post-sale' })
      .catch((e: unknown) => e);

    expect(err).toBe(timeout);
    expect(classifyCancelThrownFailure(err)).toEqual({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'write-unverified',
    });
  });

  it('`sentToProvider` distinto de `false` no dice nada', () => {
    expect(
      classifyCancelThrownFailure(typedError('ProvApiError', { sentToProvider: 'no' })),
    ).toMatchObject({ outcome: 'UNVERIFIED', reconciliationRequired: true });
  });
});

describe('persistedCancelRetryPolicy', () => {
  it('lee JSONB tanto como objeto como texto serializado', () => {
    const value = {
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      reason: 'pre-write-transient',
    };
    expect(persistedCancelRetryPolicy(value)).toEqual(value);
    expect(persistedCancelRetryPolicy(JSON.stringify(value))).toEqual(value);
  });

  it('una fila legacy sin política queda bloqueada, nunca retryable por defecto', () => {
    expect(persistedCancelRetryPolicy({ status: 'failed' })).toEqual({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'legacy-unknown',
    });
  });
});
