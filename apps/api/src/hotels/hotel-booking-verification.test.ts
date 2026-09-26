import type { HotelBookingView } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  HOTEL_BOOK_ORPHAN_ANCHOR_MS,
  HOTEL_BOOK_VERIFY_GRACE_MS,
  HOTEL_BOOK_VERIFY_SCHEDULE_MS,
  HOTEL_BOOK_VERIFY_STEPS,
  adoptOrphan,
  classifyVerificationReadError,
  decideVerification,
  dueStep,
  stepIsCurrent,
  sweepStep,
  verificationStepAt,
  type HotelVerificationFacts,
  type HotelVerificationRead,
} from './hotel-booking-verification.js';

/**
 * Las decisiones de la verificación de una reserva de hotel sin respuesta, sin I/O (docs/tbo/09
 * PR-4.7; 08 RF-21; 03 §4.2 y §4.3; 04 §7.3). Todo con instantes explícitos: el reloj es un dato.
 */

const MIN = 60_000;
const TF = Date.parse('2026-09-25T15:02:00Z');

function vista(parcial: Partial<HotelBookingView>): HotelBookingView {
  return { found: true, warnings: [], ...parcial };
}

function hechos(read: HotelVerificationRead, extra: Partial<HotelVerificationFacts> = {}) {
  return decideVerification({
    read,
    step: 0,
    anchorAt: TF,
    runner: 'job',
    finalAttempt: false,
    ...extra,
  });
}

describe('el calendario: tf + 120 s, +5, +15 y +60 min', () => {
  it('cuatro pasos contados desde el fallo observado', () => {
    expect(HOTEL_BOOK_VERIFY_SCHEDULE_MS).toEqual([120_000, 5 * MIN, 15 * MIN, 60 * MIN]);
    expect(HOTEL_BOOK_VERIFY_STEPS).toBe(4);
    expect([0, 1, 2, 3, 4].map((paso) => verificationStepAt(TF, paso))).toEqual([
      TF + 120_000,
      TF + 5 * MIN,
      TF + 15 * MIN,
      TF + 60 * MIN,
      undefined,
    ]);
  });

  it('RF-21 CA-1: a `tf + 119 s` no toca ningún paso; a `tf + 120 s`, el primero', () => {
    expect(dueStep(TF, TF + 119_999)).toBeUndefined();
    expect(dueStep(TF, TF + 120_000)).toEqual({ step: 0, at: TF + 120_000 });
    expect(dueStep(TF, TF + 16 * MIN)).toEqual({ step: 2, at: TF + 15 * MIN });
    expect(dueStep(TF, TF + 10 * 60 * MIN)).toEqual({ step: 3, at: TF + 60 * MIN });
  });

  it('el barrido nunca retrocede y salta lo que ya venció', () => {
    expect(sweepStep(1, TF, TF + 121_000)).toBe(1);
    expect(sweepStep(0, TF, TF + 20 * MIN)).toBe(2);
    // Sin nada vencido (no pasa por el filtro del barrido, pero la función no inventa un paso).
    expect(sweepStep(0, TF, TF)).toBe(0);
  });

  it('una huérfana se ancla al último instante en que su Book pudo terminar', () => {
    const escrita = TF - 10 * MIN;
    expect(adoptOrphan(escrita, TF)).toEqual({
      anchorAt: escrita + HOTEL_BOOK_ORPHAN_ANCHOR_MS,
      step: 1,
      at: escrita + HOTEL_BOOK_ORPHAN_ANCHOR_MS + 5 * MIN,
    });
    // Recién escrita: el primer paso, a su hora (el barrido no la elegiría todavía).
    expect(adoptOrphan(TF, TF)).toEqual({
      anchorAt: TF + HOTEL_BOOK_ORPHAN_ANCHOR_MS,
      step: 0,
      at: TF + HOTEL_BOOK_ORPHAN_ANCHOR_MS + 120_000,
    });
  });

  it('una huérfana que el barrido elige ya tiene su primer paso vencido: nunca lee antes de tiempo', () => {
    // El barrido elige huérfanas escritas antes de `now - ancla - margen`.
    const ahora = TF;
    const escrita = ahora - HOTEL_BOOK_ORPHAN_ANCHOR_MS - HOTEL_BOOK_VERIFY_GRACE_MS;
    const adopcion = adoptOrphan(escrita, ahora);

    expect(adopcion.at).toBeLessThanOrEqual(ahora);
    expect(adopcion.anchorAt + 120_000).toBeLessThanOrEqual(ahora);
  });
});

describe('¿el paso del job sigue vigente?', () => {
  const fila = { open: true, anchorAt: TF, step: 1, nextAt: TF + 5 * MIN };

  it('sólo con la orden abierta, calendario activo y el mismo paso', () => {
    expect(stepIsCurrent(fila, 1)).toBe(true);
    expect(stepIsCurrent(fila, 0)).toBe(false);
    expect(stepIsCurrent({ ...fila, open: false }, 1)).toBe(false);
    expect(stepIsCurrent({ ...fila, nextAt: null }, 1)).toBe(false);
    expect(stepIsCurrent({ ...fila, anchorAt: null, step: null }, 1)).toBe(false);
  });
});

describe('qué dice un error de la lectura, sin conocer al proveedor', () => {
  it.each([
    ['el breaker no la dejó salir', { sentToProvider: false, status: 503 }, 'transient'],
    // El limitador de la cuenta sin cupo (QUEUE_TIMEOUT): no salió, así que se repite; nunca
    // detiene el calendario como un error determinista.
    ['sin cupo en el limitador', { name: 'TboDispatchRejectedError' }, 'transient'],
    ['otro rechazo previo al envío', { name: 'AcmeDispatchRejectedError' }, 'transient'],
    ['red (TBO TRANSPORT)', { name: 'TboApiError', status: 0, retryable: true }, 'transient'],
    ['429', { failure: { kind: 'THROTTLED', retry: 'RETRY_BACKOFF' } }, 'transient'],
    ['5xx sin forma', { status: 502 }, 'transient'],
    ['un Error cualquiera', new Error('boom'), 'transient'],
    ['un texto lanzado', 'boom', 'transient'],
    ['401', { failure: { kind: 'CREDENTIALS_INVALID', notifyAccountOwner: true } }, 'account'],
    ['402', { failure: { kind: 'ACCOUNT_BLOCKED' } }, 'account'],
    ['credenciales faltantes', { name: 'TboCredentialsMissingError' }, 'account'],
    ['HTTP 401 a secas', { status: 401 }, 'account'],
    ['pedido mal armado', { name: 'TboRequestBuildError' }, 'permanent'],
    ['respuesta ilegible', { name: 'TboResponseMappingError' }, 'permanent'],
    ['proveedor deshabilitado', { name: 'ProviderNotAvailableError', status: 400 }, 'permanent'],
    ['sin reintento', { retryable: false }, 'permanent'],
    ['NO_RETRY', { failure: { kind: 'UNKNOWN_CODE', retry: 'NO_RETRY' } }, 'permanent'],
    ['404', { status: 404 }, 'permanent'],
    ['408', { status: 408 }, 'transient'],
  ] as [string, unknown, string][])('%s → %s', (_caso, err, esperado) => {
    expect(classifyVerificationReadError(err)).toBe(esperado);
  });
});

describe('los desenlaces de una lectura (03 §4.3)', () => {
  it('confirmada con localizador: se consolida con ESE localizador', () => {
    expect(
      hechos({
        kind: 'read',
        view: vista({
          status: 'CONFIRMED',
          providerBookingId: ' YOSUR8 ',
          providerStatus: 'Vouchered',
        }),
      }),
    ).toEqual({ kind: 'consolidate', providerBookingId: 'YOSUR8', providerStatus: 'Vouchered' });
    expect(
      hechos({ kind: 'read', view: vista({ status: 'CONFIRMED', providerBookingId: 'YOSUR8' }) }),
    ).toEqual({ kind: 'consolidate', providerBookingId: 'YOSUR8' });
  });

  it('no aparece: el paso siguiente, a su hora', () => {
    expect(hechos({ kind: 'read', view: { found: false, warnings: [] } }, { step: 1 })).toEqual({
      kind: 'advance',
      step: 2,
      at: TF + 15 * MIN,
    });
  });

  it('no aparece en el último paso: queda para la conciliación, nunca `failed` (D-TBO-24 A)', () => {
    expect(hechos({ kind: 'read', view: { found: false, warnings: [] } }, { step: 3 })).toEqual({
      kind: 'not-found-yet',
    });
  });

  it.each(['CANCELLED', 'CANCELLATION_IN_PROGRESS'] as const)(
    'la encuentra %s: se deja de preguntar y la mira una persona',
    (status) => {
      expect(
        hechos({
          kind: 'read',
          view: vista({ status, providerStatus: 'Cancelled', providerBookingId: 'YOSUR8' }),
        }),
      ).toEqual({
        kind: 'hold',
        reason: 'verified-cancelled-upstream',
        subStatus: 'create-uncertain',
        providerStatus: 'Cancelled',
        providerBookingId: 'YOSUR8',
      });
    },
  );

  it.each([
    ['fuera del vocabulario', vista({ status: 'UNKNOWN', providerStatus: 'OnHold' })],
    ['sin estado', vista({})],
    ['confirmada sin localizador', vista({ status: 'CONFIRMED' })],
    [
      'confirmada con localizador en blanco',
      vista({ status: 'CONFIRMED', providerBookingId: ' ' }),
    ],
  ])('%s: estado desconocido, a revisión', (_caso, view) => {
    expect(hechos({ kind: 'read', view })).toMatchObject({
      kind: 'hold',
      reason: 'provider-status-unknown',
      subStatus: 'unknown',
    });
  });

  it('la cuenta cambió: no se lee con otra y se detiene', () => {
    expect(hechos({ kind: 'account-changed' })).toEqual({
      kind: 'hold',
      reason: 'provider-account-changed',
      subStatus: 'create-uncertain',
    });
  });

  it('un error permanente detiene el calendario con escalamiento', () => {
    expect(hechos({ kind: 'failed', error: 'permanent' })).toEqual({
      kind: 'hold',
      reason: 'verification-unavailable',
      subStatus: 'create-uncertain',
    });
  });

  it('transporte en el job: que la cola repita, y en su último intento se escala sin avanzar', () => {
    const fallo: HotelVerificationRead = { kind: 'failed', error: 'transient' };
    expect(hechos(fallo)).toEqual({ kind: 'retry' });
    expect(hechos(fallo, { finalAttempt: true })).toEqual({
      kind: 'unavailable',
      reason: 'verification-unavailable',
      escalate: true,
    });
    // El barrido tiene un intento y no repite el aviso cada 15 minutos.
    expect(hechos(fallo, { runner: 'sweep', finalAttempt: true })).toEqual({
      kind: 'unavailable',
      reason: 'verification-unavailable',
      escalate: false,
    });
  });

  it('la cuenta no puede leer: se escala una vez, sin reintentos de la cola (04 §7.3)', () => {
    const fallo: HotelVerificationRead = { kind: 'failed', error: 'account' };
    expect(hechos(fallo)).toEqual({
      kind: 'unavailable',
      reason: 'provider-account-issue',
      escalate: true,
    });
    expect(hechos(fallo, { runner: 'sweep' })).toEqual({
      kind: 'unavailable',
      reason: 'provider-account-issue',
      escalate: false,
    });
  });
});
