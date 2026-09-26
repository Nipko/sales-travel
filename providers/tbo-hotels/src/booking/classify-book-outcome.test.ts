import { describe, expect, it } from 'vitest';
import {
  TboApiError,
  TboCancelMappingError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboOfferExpiredError,
  TboPackageOnlyRateError,
  TboRequestBuildError,
  TboResponseMappingError,
  TboUnsupportedCurrencyError,
  type TboFailureKind,
} from '../errors';
import type { TboBookReply } from './book.response.mapper';
import {
  TBO_BOOK_OUTCOME_REASONS,
  classifyTboBookOutcome,
  type TboBookClassification,
} from './classify-book-outcome';

/**
 * La tabla de clasificación del Book, completa (docs/tbo/03 §3.9; 01 §8.5; 08 RF-03 CA-2, RF-20
 * CA 2 y 3; BK-06). Cada fila del documento es un caso; ninguna queda sin probar.
 */

const SENT = 'STT7K2M9QX4D8R1VZ6AB';
const EXPECTED = { clientReferenceId: SENT };

function reply(overrides: Partial<TboBookReply> = {}): TboBookReply {
  return {
    tboCode: 200,
    confirmationNumber: 'FL1IMA',
    clientReferenceId: SENT,
    diagnostics: {
      unknownKeys: [],
      confirmationNumberMalformed: false,
      clientReferenceIdMalformed: false,
    },
    ...overrides,
  };
}

function answered(overrides: Partial<TboBookReply> = {}): TboBookClassification {
  return classifyTboBookOutcome({ kind: 'answered', reply: reply(overrides) }, EXPECTED);
}

function threw(error: unknown): TboBookClassification {
  return classifyTboBookOutcome({ kind: 'threw', error }, EXPECTED);
}

/** Un `TboApiError` como lo arma el cliente con un envelope válido. */
function coded(tboCode: number, kind: TboFailureKind, status = 200): TboApiError {
  return new TboApiError({ status, tboCode, path: '/Book', kind, requestId: 'req-1' });
}

/** Un `TboApiError` sin envelope: sólo habló el transporte. */
function bare(kind: TboFailureKind, status: number, timedOut = false): TboApiError {
  return new TboApiError({ status, path: '/Book', kind, requestId: 'req-1', timedOut });
}

describe('200: la respuesta decide (03 §3.9 filas 1 y 2; RF-03 CA-2)', () => {
  it('con ConfirmationNumber y el ClientReferenceId enviado → CONFIRMED', () => {
    expect(answered()).toEqual({
      outcome: 'CONFIRMED',
      reason: 'confirmed',
      dispatched: true,
      verifyByReference: false,
      confirmationNumber: 'FL1IMA',
      tboCode: 200,
    });
  });

  it('sin ConfirmationNumber → UNCERTAIN, no éxito', () => {
    expect(answered({ confirmationNumber: undefined })).toMatchObject({
      outcome: 'UNCERTAIN',
      reason: 'missing-confirmation-number',
      verifyByReference: true,
    });
  });

  it('con otro ClientReferenceId → UNCERTAIN: el localizador puede ser de otra reserva', () => {
    const outcome = answered({ clientReferenceId: '1625733337375-78767296' });
    expect(outcome).toMatchObject({ outcome: 'UNCERTAIN', reason: 'client-reference-mismatch' });
    expect(outcome.confirmationNumber).toBeUndefined();
  });

  it('sin ClientReferenceId → UNCERTAIN: no hay con qué atarlo a este intento', () => {
    expect(answered({ clientReferenceId: undefined })).toMatchObject({
      outcome: 'UNCERTAIN',
      reason: 'client-reference-missing',
    });
  });

  it('la comparación es exacta: otra grafía de la referencia no es la referencia', () => {
    expect(answered({ clientReferenceId: SENT.toLowerCase() }).outcome).toBe('UNCERTAIN');
  });
});

describe('códigos definitivos en el cuerpo → FAILED sin verificación (03 §3.9 fila 3)', () => {
  it.each([
    [207, 'RATE_UNAVAILABLE', 'rate-unavailable'],
    [315, 'OFFER_EXPIRED', 'session-expired'],
    [300, 'INSUFFICIENT_BALANCE', 'insufficient-balance'],
    [402, 'ACCOUNT_BLOCKED', 'agent-blocked'],
    [400, 'CLIENT_BUG', 'invalid-request'],
    [401, 'CREDENTIALS_INVALID', 'credentials-invalid'],
    [201, 'NO_AVAILABILITY', 'no-availability'],
  ] as const)('%i (%s) → FAILED %s', (code, kind, reason) => {
    expect(threw(coded(code, kind))).toEqual({
      outcome: 'FAILED',
      reason,
      dispatched: true,
      verifyByReference: false,
      tboCode: code,
      failureKind: kind,
      errorClass: 'TboApiError',
    });
  });

  it('manda el cuerpo aunque el HTTP diga otra cosa (01 §8.4, segunda fila)', () => {
    expect(threw(coded(207, 'RATE_UNAVAILABLE', 500)).outcome).toBe('FAILED');
  });
});

describe('405 → incierto hasta verificar (03 §3.9 fila 4; Q-36)', () => {
  it('BOOKING_FAIL no prueba que no se reservó: la nota de p. 42 dice "failure"', () => {
    expect(threw(coded(405, 'BOOKING_FAILED'))).toMatchObject({
      outcome: 'UNCERTAIN',
      reason: 'booking-failed',
      dispatched: true,
      verifyByReference: true,
      tboCode: 405,
    });
  });
});

describe('sin respuesta cierta → UNCERTAIN (03 §3.9 fila 5)', () => {
  it.each([
    ['500 en el cuerpo', coded(500, 'UPSTREAM'), 'provider-error'],
    ['429 en el cuerpo', coded(429, 'THROTTLED'), 'throttled'],
    ['código fuera de la tabla', coded(999, 'UNKNOWN_CODE'), 'unknown-code'],
    ['479 (de Cancel) en un Book', coded(479, 'CANCEL_FAILED'), 'unexpected-code'],
    [
      'HTTP 200 con cuerpo 200 y transporte en error',
      coded(200, 'MALFORMED_RESPONSE', 502),
      'malformed-response',
    ],
    ['2xx no JSON', bare('MALFORMED_RESPONSE', 200), 'malformed-response'],
    ['timeout de 120 s', bare('TRANSPORT', 0, true), 'timeout'],
    ['red', bare('TRANSPORT', 0), 'transport'],
    ['HTTP 503 sin envelope', bare('UPSTREAM', 503), 'http-error'],
    ['HTTP 429 sin envelope', bare('THROTTLED', 429), 'http-error'],
    ['HTTP 401 sin envelope', bare('CREDENTIALS_INVALID', 401), 'http-error'],
    ['HTTP 404 sin envelope', bare('CLIENT_BUG', 404), 'http-error'],
    ['HTTP 301 sin envelope', bare('CLIENT_BUG', 301), 'http-error'],
  ])('%s → %s', (_name, error, reason) => {
    expect(threw(error)).toMatchObject({
      outcome: 'UNCERTAIN',
      reason,
      dispatched: true,
      verifyByReference: true,
    });
  });

  it('un 200 que no pasó el esquema es incierto: TBO respondió y quizá reservó', () => {
    expect(
      threw(new TboResponseMappingError('/Book', ['ConfirmationNumber:invalid_type'])),
    ).toEqual({
      outcome: 'UNCERTAIN',
      reason: 'unreadable-response',
      dispatched: true,
      verifyByReference: true,
      errorClass: 'TboResponseMappingError',
    });
    expect(threw(new TboCancelMappingError('/Book', [])).reason).toBe('unreadable-response');
  });

  it('cualquier otra excepción es incierta: puede haber salido o no', () => {
    for (const error of [new TypeError('x'), new Error('boom'), 'string', undefined, { a: 1 }]) {
      expect(threw(error)).toMatchObject({ outcome: 'UNCERTAIN', reason: 'unexpected-error' });
    }
  });

  it('del error sólo viaja el nombre de la clase, nunca el mensaje', () => {
    const outcome = threw(new Error('Shubham Gupta 4111111111111111'));
    expect(outcome.errorClass).toBe('Error');
    expect(JSON.stringify(outcome)).not.toMatch(/Shubham|4111/);
  });
});

describe('rechazo local antes del cable → FAILED sin envío (RF-20 CA-4)', () => {
  it.each([
    new TboRequestBuildError('/Book', 'SCHEMA', ['totalFare:not_exact']),
    new TboRequestBuildError('/Book', 'CARD_DATA', ['PaymentInfo']),
    new TboDispatchRejectedError('/Book', 'QUEUE_TIMEOUT', 120_000),
    new TboCredentialsMissingError(['password']),
    new TboConfigError(['environment:invalid_enum_value']),
    new TboOfferExpiredError('2026-09-25T15:27:00.000Z'),
    new TboPackageOnlyRateError(),
    new TboUnsupportedCurrencyError(['KWD']),
  ])('%s', (error) => {
    expect(threw(error)).toEqual({
      outcome: 'FAILED',
      reason: 'not-dispatched',
      dispatched: false,
      verifyByReference: false,
      errorClass: error.name,
    });
  });
});

describe('invariantes de la tabla', () => {
  const all: TboBookClassification[] = [
    answered(),
    answered({ confirmationNumber: undefined }),
    threw(coded(207, 'RATE_UNAVAILABLE')),
    threw(coded(405, 'BOOKING_FAILED')),
    threw(bare('TRANSPORT', 0, true)),
    threw(new TboRequestBuildError('/Book', 'SCHEMA')),
    threw(new Error('x')),
  ];

  it('se verifica por referencia si y sólo si es incierto', () => {
    for (const outcome of all) {
      expect(outcome.verifyByReference).toBe(outcome.outcome === 'UNCERTAIN');
    }
  });

  it('sólo un rechazo local dice que no salió nada', () => {
    for (const outcome of all) {
      expect(outcome.dispatched).toBe(outcome.reason !== 'not-dispatched');
    }
  });

  it('todo motivo es del vocabulario cerrado', () => {
    for (const outcome of all) expect(TBO_BOOK_OUTCOME_REASONS).toContain(outcome.reason);
  });

  it('sólo CONFIRMED trae localizador', () => {
    for (const outcome of all) {
      expect(outcome.confirmationNumber !== undefined).toBe(outcome.outcome === 'CONFIRMED');
    }
  });
});
