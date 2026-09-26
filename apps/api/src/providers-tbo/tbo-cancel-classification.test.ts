import {
  TBO_OPERATIONS,
  TboApiError,
  TboCancelMappingError,
  TboDispatchRejectedError,
  TboRequestBuildError,
  TboResponseMappingError,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import { classifyCancelThrownFailure } from '../orders/cancel-retry-policy.js';
import { BreakerRejectionError } from '../search/circuit-breaker.service.js';

/**
 * Los errores de TBO frente a la política de cancelaciones, que decide sin conocer al proveedor
 * leyendo `name`, `path`, `status`, `retryable` y `failure` (docs/tbo/01 §9.3; 08 RF-04 CA-1, CA-2
 * y CA-5).
 *
 * Lo que se protege: una cancelación que PUDO aplicarse en TBO nunca se cierra como fallida sin
 * releer la reserva, y una que no salió nunca se manda a conciliar.
 */

const CANCEL = TBO_OPERATIONS.cancel.path;

describe('`TboApiError` en /Cancel', () => {
  it('RF-04 CA-1: un `479` viaja con HTTP 200, así que la regla "4xx determinista" no lo toca', () => {
    const err = new TboApiError({
      status: 200,
      tboCode: 479,
      path: CANCEL,
      kind: 'CANCEL_FAILED',
      requestId: 'req-479',
    });

    // Si `status` y `tboCode` fueran un solo campo, el 479 se leería como un 4xx de transporte.
    expect(err.status).toBe(200);
    expect(classifyCancelThrownFailure({ status: err.status, path: err.path }).outcome).toBe(
      'UNVERIFIED',
    );
    // Lo que lo hace determinista es su política (`NO_RETRY`): TBO dijo que no.
    expect(classifyCancelThrownFailure(err)).toEqual({
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
      reason: 'deterministic',
    });
  });

  it('RF-04 CA-2: un timeout en /Cancel no prueba nada → `UNVERIFIED`, a conciliar', () => {
    const err = new TboApiError({
      status: 0,
      path: CANCEL,
      kind: 'TRANSPORT',
      requestId: 'req-timeout',
      timedOut: true,
    });

    // `retryable` refleja la NATURALEZA del fallo; si fuera `false` "por seguridad", esto saldría
    // `FAILED` determinista y sin reconciliar (01 §9.3, advertencia de diseño).
    expect(err.retryable).toBe(true);
    expect(classifyCancelThrownFailure(err)).toEqual({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'write-unverified',
    });
  });

  it('un `500` dentro de un HTTP 200 también queda `UNVERIFIED`', () => {
    const err = new TboApiError({
      status: 200,
      tboCode: 500,
      path: CANCEL,
      kind: 'UPSTREAM',
      requestId: 'req-500',
    });
    expect(classifyCancelThrownFailure(err).outcome).toBe('UNVERIFIED');
  });
});

describe('lecturas fallidas de la respuesta de /Cancel', () => {
  it('RF-04 CA-2: `TboCancelMappingError` → `UNVERIFIED`: TBO respondió 200 y pudo cancelar', () => {
    const err = new TboCancelMappingError(CANCEL, ['ConfirmationNumber:invalid_type'], 'req-map');
    expect(classifyCancelThrownFailure(err)).toEqual({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
      reason: 'write-unverified',
    });
  });

  it('con la clase madre se cerraría como fallida: por eso existe la subclase', () => {
    const err = new TboResponseMappingError(CANCEL, ['ConfirmationNumber:invalid_type']);
    expect(classifyCancelThrownFailure(err).outcome).toBe('FAILED');
  });
});

describe('lo que no salió hacia TBO', () => {
  it('RF-04 CA-5: el rechazo del breaker o del kill-switch es previo al envío, no `UNVERIFIED`', () => {
    const err = new BreakerRejectionError('tbo-hotels', 'kill-switch', 'apagado');
    expect(classifyCancelThrownFailure(err)).toEqual({
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      reason: 'pre-write-transient',
    });
  });

  it('el rechazo del limitador de la cuenta tampoco pide conciliar', () => {
    const err = new TboDispatchRejectedError(CANCEL, 'QUEUE_TIMEOUT', 10_000);
    expect(classifyCancelThrownFailure(err)).toMatchObject({
      outcome: 'FAILED',
      reconciliationRequired: false,
    });
  });

  it('un body que no pasó la guarda D1 es determinista y previo al cable', () => {
    const err = new TboRequestBuildError(CANCEL, 'CARD_DATA', ['PaymentInfo']);
    expect(classifyCancelThrownFailure(err)).toMatchObject({
      outcome: 'FAILED',
      reconciliationRequired: false,
      reason: 'deterministic',
    });
  });

  it('RF-25 CA-4: si falla la lectura PREVIA al Cancel, el fallo es previo al envío y reintentable', () => {
    // El ACL lee BookingDetail antes de mandar el Cancel (04 §4.4) y deja salir su error tal cual:
    // el path distinto del write es lo que prueba que no se mandó nada.
    const err = new TboApiError({
      status: 200,
      tboCode: 500,
      path: TBO_OPERATIONS.bookingDetail.path,
      kind: 'UPSTREAM',
      requestId: 'req-pre-read',
    });
    expect(classifyCancelThrownFailure(err)).toEqual({
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      reason: 'pre-write-transient',
    });
  });
});
