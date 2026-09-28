import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as errors from './errors';
import {
  TBO_ERROR_CLASSES,
  TBO_FAILURE_KINDS,
  TBO_FAILURE_POLICY,
  TboApiError,
  TboCancelMappingError,
  TboCancelOutcomeUnknownError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboError,
  TboOfferExpiredError,
  TboPackageOnlyRateError,
  TboRequestBuildError,
  TboResponseMappingError,
  TboUnsupportedCurrencyError,
  type TboFailureKind,
} from './errors';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

describe('TBO_FAILURE_POLICY', () => {
  it('tiene exactamente los 14 kind de docs/tbo/01 §9.2, sin repetir', () => {
    expect(TBO_FAILURE_KINDS).toHaveLength(14);
    expect(new Set(TBO_FAILURE_KINDS).size).toBe(14);
    expect(Object.keys(TBO_FAILURE_POLICY).sort()).toEqual([...TBO_FAILURE_KINDS].sort());
  });

  it.each(TBO_FAILURE_KINDS)('la fila de %s declara su propio kind', (kind) => {
    expect(TBO_FAILURE_POLICY[kind].kind).toBe(kind);
    expect(Object.isFrozen(TBO_FAILURE_POLICY[kind])).toBe(true);
  });

  // Las columnas de docs/tbo/01 §8.3-§8.4, fila por fila. Si alguien afloja una, el test lo dice.
  it.each<[TboFailureKind, string, string, boolean, boolean]>([
    ['TRANSPORT', 'RETRY_BACKOFF', 'COUNT', false, false],
    ['MALFORMED_RESPONSE', 'RETRY_BACKOFF', 'COUNT', false, true],
    ['UNKNOWN_CODE', 'NO_RETRY', 'IGNORE', false, true],
    ['CLIENT_BUG', 'NO_RETRY', 'IGNORE', false, true],
    ['CREDENTIALS_INVALID', 'NO_RETRY', 'OPEN_ACCOUNT', true, false],
    ['ACCOUNT_BLOCKED', 'NO_RETRY', 'OPEN_ACCOUNT', true, true],
    ['INSUFFICIENT_BALANCE', 'NO_RETRY', 'IGNORE', true, false],
    ['THROTTLED', 'RETRY_BACKOFF', 'IGNORE', false, false],
    ['UPSTREAM', 'RETRY_BACKOFF', 'COUNT', false, false],
    ['NO_AVAILABILITY', 'NO_RETRY', 'IGNORE', false, false],
    ['RATE_UNAVAILABLE', 'NO_RETRY', 'IGNORE', false, false],
    ['OFFER_EXPIRED', 'NO_RETRY', 'IGNORE', false, false],
    ['BOOKING_FAILED', 'NO_RETRY', 'IGNORE', false, false],
    ['CANCEL_FAILED', 'NO_RETRY', 'IGNORE', false, false],
  ])('%s → retry %s, circuito %s', (kind, retry, circuit, notifyAccountOwner, operatorAlert) => {
    expect(TBO_FAILURE_POLICY[kind]).toEqual({
      kind,
      retry,
      circuit,
      notifyAccountOwner,
      operatorAlert,
    });
  });
});

describe('TboApiError', () => {
  it('guarda el HTTP de transporte y el Status.Code del cuerpo en campos separados', () => {
    const error = new TboApiError({
      status: 200,
      tboCode: 479,
      path: '/Cancel',
      kind: 'CANCEL_FAILED',
      requestId: REQUEST_ID,
    });
    expect(error.status).toBe(200);
    expect(error.tboCode).toBe(479);
    expect(error.failure).toBe(TBO_FAILURE_POLICY.CANCEL_FAILED);
    expect(error.kind).toBe('CANCEL_FAILED');
  });

  it('sin respuesta, status 0 y sin tboCode', () => {
    const error = new TboApiError({
      status: 0,
      path: '/Search',
      kind: 'TRANSPORT',
      requestId: REQUEST_ID,
      timedOut: true,
    });
    expect(error.tboCode).toBeUndefined();
    expect(error.timedOut).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('TBO /Search http=0 code=- [TRANSPORT]');
  });

  it('el message sólo lleva vocabulario propio: path, dos enteros y kind', () => {
    const error = new TboApiError({
      status: 500,
      tboCode: 500,
      path: '/PreBook',
      kind: 'UPSTREAM',
      requestId: REQUEST_ID,
    });
    expect(error.message).toBe('TBO /PreBook http=500 code=500 [UPSTREAM]');
    expect(error.name).toBe('TboApiError');
  });

  it('recorta query y fragmento del path aunque le pasen una URL armada', () => {
    const error = new TboApiError({
      status: 400,
      tboCode: 400,
      path: '/BookingDetail?ConfirmationNumber=ABC123#x',
      kind: 'CLIENT_BUG',
      requestId: REQUEST_ID,
    });
    expect(error.path).toBe('/BookingDetail');
    expect(error.message).not.toContain('ABC123');
  });

  it('retryable refleja la naturaleza del fallo, también en paths de dinero', () => {
    // docs/tbo/01 §9.3: forzar NO_RETRY en /Cancel haría que un timeout se cierre como FAILED
    // determinista sin conciliar. La prohibición de repetir el write vive en el cliente HTTP.
    const timeout = new TboApiError({
      status: 0,
      path: '/Cancel',
      kind: 'TRANSPORT',
      requestId: REQUEST_ID,
      timedOut: true,
    });
    expect(timeout.retryable).toBe(true);
    expect(timeout.failure.retry).toBe('RETRY_BACKOFF');
  });

  it('toLogMeta es la lista blanca de docs/tbo/01 §11.1 y nada más', () => {
    const meta = new TboApiError({
      status: 200,
      tboCode: 402,
      path: '/Search',
      kind: 'ACCOUNT_BLOCKED',
      requestId: REQUEST_ID,
    }).toLogMeta();
    expect(meta).toEqual({
      errorClass: 'TboApiError',
      path: '/Search',
      status: 200,
      tboCode: 402,
      kind: 'ACCOUNT_BLOCKED',
      retry: 'NO_RETRY',
      circuit: 'OPEN_ACCOUNT',
      timedOut: false,
      requestId: REQUEST_ID,
    });
  });

  it('toLogMeta omite tboCode cuando no hubo cuerpo legible', () => {
    const meta = new TboApiError({
      status: 0,
      path: '/Search',
      kind: 'TRANSPORT',
      requestId: REQUEST_ID,
    }).toLogMeta();
    expect(meta).not.toHaveProperty('tboCode');
  });
});

describe('clases fuera del cable', () => {
  it('TboConfigError lleva ruta:código y los expone como issues', () => {
    const error = new TboConfigError(['baseUrl:https_required', 'username:too_small']);
    expect(error.name).toBe('TboConfigError');
    expect(error.message).toBe(
      'config de TBO inválida (baseUrl:https_required, username:too_small)',
    );
    expect(error.toLogMeta()).toEqual({
      errorClass: 'TboConfigError',
      issues: ['baseUrl:https_required', 'username:too_small'],
    });
  });

  it('TboCredentialsMissingError nombra los campos', () => {
    const error = new TboCredentialsMissingError(['password', 'baseUrl']);
    expect(error.name).toBe('TboCredentialsMissingError');
    expect(error.missing).toEqual(['password', 'baseUrl']);
    expect(error.message).toContain('password, baseUrl');
  });

  it('TboRequestBuildError dice por qué se cortó y en qué operación, sin el body', () => {
    const error = new TboRequestBuildError('/Book', 'CARD_DATA', ['PaymentInfo.CardNumber']);
    expect(error.name).toBe('TboRequestBuildError');
    expect(error.path).toBe('/Book');
    expect(error.reason).toBe('CARD_DATA');
    expect(error.message).toBe(
      'TBO /Book: request rechazada antes del envío [CARD_DATA] (PaymentInfo.CardNumber)',
    );
  });

  it('TboDispatchRejectedError dice que no salió nada, por qué y cuánto esperó', () => {
    const error = new TboDispatchRejectedError('/Search?x=1', 'QUEUE_TIMEOUT', 120);
    expect(error.name).toBe('TboDispatchRejectedError');
    expect(error.path).toBe('/Search');
    expect(error.message).toBe('TBO /Search: llamada no despachada [QUEUE_TIMEOUT] tras 120 ms');
    expect(error.toLogMeta()).toEqual({
      errorClass: 'TboDispatchRejectedError',
      path: '/Search',
      reason: 'QUEUE_TIMEOUT',
      waitedMs: 120,
    });
  });

  it('TboOfferExpiredError lleva el vencimiento local', () => {
    const error = new TboOfferExpiredError('2026-09-25T15:27:00.000Z');
    expect(error.name).toBe('TboOfferExpiredError');
    expect(error.expiresAt).toBe('2026-09-25T15:27:00.000Z');
  });

  it('TboResponseMappingError lleva ruta:código de los issues y el requestId', () => {
    const error = new TboResponseMappingError(
      '/Search',
      ['HotelResult.0.Currency:invalid_type'],
      REQUEST_ID,
    );
    expect(error.name).toBe('TboResponseMappingError');
    expect(error.message).toBe(
      'TBO /Search: respuesta ilegible (HotelResult.0.Currency:invalid_type)',
    );
    expect(error.toLogMeta()).toEqual({
      errorClass: 'TboResponseMappingError',
      path: '/Search',
      issues: ['HotelResult.0.Currency:invalid_type'],
      requestId: REQUEST_ID,
    });
  });

  it('TboCancelMappingError es un error de lectura con nombre propio', () => {
    const error = new TboCancelMappingError('/Cancel', ['Status.Code:unknown_code']);
    expect(error).toBeInstanceOf(TboResponseMappingError);
    expect(error.name).toBe('TboCancelMappingError');
    expect(error.toLogMeta()).toMatchObject({ errorClass: 'TboCancelMappingError' });
  });

  it('TboPackageOnlyRateError nombra la restricción', () => {
    const error = new TboPackageOnlyRateError();
    expect(error.name).toBe('TboPackageOnlyRateError');
    expect(error.restriction).toBe('PACKAGE_WITH_FLIGHT_ONLY');
  });

  it('TboUnsupportedCurrencyError nombra las monedas y deja fuera lo que no es un código ISO', () => {
    const error = new TboUnsupportedCurrencyError(['KWD', 'CLP', 'KWD', 'kwd', 'US D', '<b>']);
    expect(error.name).toBe('TboUnsupportedCurrencyError');
    expect(error.currencies).toEqual(['CLP', 'KWD']);
    expect(error.message).toBe(
      'la cuenta de TBO cotiza en CLP, KWD sin dos decimales; hace falta un perfil en USD u otra ' +
        'moneda de dos decimales',
    );
    expect(error.toLogMeta()).toEqual({
      errorClass: 'TboUnsupportedCurrencyError',
      currencies: ['CLP', 'KWD'],
    });
    expect(new TboUnsupportedCurrencyError(['<script>']).message).not.toContain('<');
  });
});

describe('TBO_ERROR_CLASSES', () => {
  it('lista TODAS las clases concretas que el módulo exporta, para el @Catch del filtro', () => {
    const exported = Object.values(errors).filter(
      (value): value is typeof TboError =>
        typeof value === 'function' &&
        value !== TboError &&
        (value as { prototype?: unknown }).prototype instanceof TboError,
    );
    expect(new Set<unknown>(TBO_ERROR_CLASSES)).toEqual(new Set<unknown>(exported));
  });

  it('todas son Error y TboError, y todas tienen toLogMeta', () => {
    const samples: readonly TboError[] = [
      new TboApiError({ status: 0, path: '/Search', kind: 'TRANSPORT', requestId: REQUEST_ID }),
      new TboConfigError([]),
      new TboCredentialsMissingError([]),
      new TboRequestBuildError('/Search', 'SCHEMA'),
      new TboDispatchRejectedError('/Search', 'ABORTED', 0),
      new TboOfferExpiredError('2026-09-25T15:27:00.000Z'),
      new TboResponseMappingError('/Search', []),
      new TboCancelMappingError('/Cancel', []),
      new TboCancelOutcomeUnknownError({
        status: 200,
        tboCode: 405,
        path: '/Cancel',
        kind: 'BOOKING_FAILED',
        requestId: REQUEST_ID,
      }),
      new TboUnsupportedCurrencyError(['KWD']),
      new TboPackageOnlyRateError(),
    ];
    expect(samples).toHaveLength(TBO_ERROR_CLASSES.length);
    for (const sample of samples) {
      expect(sample).toBeInstanceOf(Error);
      expect(sample).toBeInstanceOf(TboError);
      expect(sample.toLogMeta()).toMatchObject({ errorClass: sample.name });
    }
  });
});

/**
 * El contrato con `classifyCancelThrownFailure` (08 RF-04; docs/tbo/01 §9.3), contra el
 * clasificador REAL de `apps/api` y no contra una copia de sus regex: una copia seguiría verde el
 * día que el clasificador cambie, que es justo cuando este contrato se rompe. El archivo no importa
 * nada, así que se carga por ruta sin arrastrar la app.
 *
 * `apps/api` no es dependencia del paquete, así que su código no entra en el hash de turbo: sin
 * declarar el clasificador como input de `test` en `providers/tbo-hotels/turbo.json`, turbo
 * repetiría desde caché el verde de este archivo justo el día que el clasificador cambia.
 */
describe('compatibilidad con el clasificador de cancelaciones de apps/api', () => {
  const CLASSIFIER_FILE = 'apps/api/src/orders/cancel-retry-policy.ts';

  interface CancelPolicy {
    readonly outcome: string;
    readonly retryable: boolean;
    readonly reconciliationRequired: boolean;
    readonly reason: string;
  }

  it('turbo vuelve a correr este archivo cuando cambia el clasificador', () => {
    const turbo = JSON.parse(
      readFileSync(join(repoRoot(), 'providers', 'tbo-hotels', 'turbo.json'), 'utf8'),
    ) as { tasks?: { test?: { inputs?: unknown } } };
    const inputs = turbo.tasks?.test?.inputs;
    const declared: readonly unknown[] = Array.isArray(inputs) ? inputs : [];
    expect(declared).toContain(`$TURBO_ROOT$/${CLASSIFIER_FILE}`);
    // Sin `$TURBO_DEFAULT$` el hash dejaría de ver el propio código del paquete.
    expect(declared).toContain('$TURBO_DEFAULT$');
  });

  async function classify(error: unknown): Promise<CancelPolicy> {
    const file = join(repoRoot(), ...CLASSIFIER_FILE.split('/'));
    expect(existsSync(file), `no se encontró ${file}`).toBe(true);
    const policyModule = (await import(file)) as {
      classifyCancelThrownFailure: (error: unknown) => CancelPolicy;
    };
    return policyModule.classifyCancelThrownFailure(error);
  }

  it('un código del cuerpo no se lee como 4xx de transporte (RF-04 CA-1)', async () => {
    // `kind` reintentable a propósito: con CANCEL_FAILED el NO_RETRY ya daría determinista y el
    // test no podría ver si la regla del status se disparó o no. Lo que se aísla es el `status`.
    const inBody = new TboApiError({
      status: 200,
      tboCode: 479,
      path: '/Cancel',
      kind: 'UPSTREAM',
      requestId: REQUEST_ID,
    });
    expect(inBody.status).toBe(200);
    expect(await classify(inBody)).toMatchObject({
      outcome: 'UNVERIFIED',
      reconciliationRequired: true,
    });

    // La otra rama, para que el test demuestre que distingue algo: si el código del cuerpo se
    // hubiera colado en `status`, la regla "HTTP 4xx determinista" cerraría la cancelación como
    // fallida sin releer la reserva.
    const mixed = {
      name: inBody.name,
      path: inBody.path,
      status: 479,
      retryable: inBody.retryable,
      failure: inBody.failure,
    };
    expect(await classify(mixed)).toMatchObject({
      outcome: 'FAILED',
      reconciliationRequired: false,
    });
  });

  it('un timeout en /Cancel queda UNVERIFIED y pide conciliar (RF-04 CA-2)', async () => {
    const timeout = new TboApiError({
      status: 0,
      path: '/Cancel',
      kind: 'TRANSPORT',
      requestId: REQUEST_ID,
      timedOut: true,
    });
    expect(await classify(timeout)).toMatchObject({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
    });
  });

  it('una respuesta ilegible de /Cancel queda UNVERIFIED por el nombre de la clase (RF-04 CA-2)', async () => {
    expect(await classify(new TboCancelMappingError('/Cancel', []))).toMatchObject({
      outcome: 'UNVERIFIED',
      reconciliationRequired: true,
    });
    // La clase madre, en cambio, es determinista: por eso /Cancel necesita la suya.
    expect(await classify(new TboResponseMappingError('/Cancel', []))).toMatchObject({
      outcome: 'FAILED',
      reconciliationRequired: false,
    });
  });

  it('un body cortado antes del cable es determinista y no pide conciliar', async () => {
    expect(await classify(new TboRequestBuildError('/Cancel', 'SCHEMA'))).toMatchObject({
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
    });
  });

  it('un Cancel que el limitador no despachó es previo al write (RF-04 CA-5)', async () => {
    // Nada salió hacia TBO: si quedara UNVERIFIED se bloquearía el reintento hasta conciliar una
    // cancelación que no existió, y si fuera determinista la orden no se podría volver a cancelar
    // (04 §14.3). La otra rama es el timeout de más arriba, que sí es incierto.
    const error = new TboDispatchRejectedError('/Cancel', 'QUEUE_TIMEOUT', 60_000);
    expect(error.sentToProvider).toBe(false);
    expect(await classify(error)).toMatchObject({
      outcome: 'FAILED',
      retryable: true,
      reconciliationRequired: false,
      reason: 'pre-write-transient',
    });
  });

  it('HARD-1: un código NO_RETRY de /Cancel sale del ACL con nombre propio y queda UNVERIFIED', async () => {
    for (const [tboCode, kind] of [
      [401, 'CREDENTIALS_INVALID'],
      [402, 'ACCOUNT_BLOCKED'],
      [405, 'BOOKING_FAILED'],
      [300, 'INSUFFICIENT_BALANCE'],
    ] as const) {
      const raw = new TboApiError({
        status: 200,
        tboCode,
        path: '/Cancel',
        kind,
        requestId: REQUEST_ID,
      });
      // Con la clase madre el `NO_RETRY` cerraría la cancelación como fallida sin releer: por eso
      // el mapper de Cancel nunca la deja salir.
      expect(await classify(raw)).toMatchObject({ outcome: 'FAILED' });
      expect(await classify(TboCancelOutcomeUnknownError.from(raw))).toEqual({
        outcome: 'UNVERIFIED',
        retryable: false,
        reconciliationRequired: true,
        reason: 'write-unverified',
      });
    }
  });

  it('un fallo transitorio en la lectura previa al write sí se puede reintentar', async () => {
    const readTimeout = new TboApiError({
      status: 0,
      path: '/BookingDetail',
      kind: 'TRANSPORT',
      requestId: REQUEST_ID,
      timedOut: true,
    });
    expect(await classify(readTimeout)).toMatchObject({
      outcome: 'FAILED',
      retryable: true,
      reason: 'pre-write-transient',
    });
  });
});

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('no se encontró la raíz del monorepo desde el cwd de vitest');
    dir = parent;
  }
}
