import { describe, expect, it } from 'vitest';
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
