import type { HotelBookingStatus, HotelBookingView } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  TBO_CANCEL_ERRORS,
  TBO_CANCEL_WARNINGS,
  decideTboCancelPreflight,
  decideTboCancelResult,
} from './cancel-decision';
import type { TboCancelReply } from './response.mapper';

/**
 * Las dos tablas de 04 §4.4 como funciones puras (08 RF-25 CA-1 y CA-2; D-TBO-25 A): qué hacer con
 * la lectura previa y qué devolver según `/Cancel` y la lectura posterior.
 */

function view(status: HotelBookingStatus, providerStatus: string): HotelBookingView {
  return { found: true, providerBookingId: 'FL1IMA', status, providerStatus, warnings: [] };
}

const NOT_FOUND: HotelBookingView = {
  found: false,
  providerStatus: '201',
  warnings: ['NOT_FOUND_SHAPE_UNCONFIRMED'],
};

const ACCEPTED: TboCancelReply = {
  success: true,
  tboCode: 200,
  confirmationNumber: 'FL1IMA',
  diagnostics: { unknownKeys: [] },
};
const REJECTED: TboCancelReply = {
  success: false,
  tboCode: 479,
  error: 'TBO_CANCEL_FAIL',
  diagnostics: { unknownKeys: [] },
};

describe('lectura previa', () => {
  it('Confirmed (o Vouchered): se manda el Cancel', () => {
    expect(decideTboCancelPreflight(view('CONFIRMED', 'Confirmed'))).toEqual({ send: true });
    expect(decideTboCancelPreflight(view('CONFIRMED', 'Vouchered'))).toEqual({ send: true });
  });

  it.each(['Cancelled', 'CancelledAndRefundAwaited'])(
    'ya cancelada (%s): éxito idempotente, no se manda (PV-17)',
    (raw) => {
      expect(decideTboCancelPreflight(view('CANCELLED', raw))).toEqual({
        send: false,
        skipReason: 'ALREADY_CANCELLED',
        result: {
          success: true,
          bookingStatus: 'CANCELLED',
          providerStatus: raw,
          warnings: ['ALREADY_CANCELLED'],
        },
      });
    },
  );

  it.each(['CancellationInProgress', 'CancelPending', 'CxlRequestSentToHotel'])(
    'en curso (%s): no se manda; la cancelación ya está pedida',
    (raw) => {
      expect(decideTboCancelPreflight(view('CANCELLATION_IN_PROGRESS', raw))).toEqual({
        send: false,
        skipReason: 'ALREADY_IN_PROGRESS',
        result: {
          success: true,
          bookingStatus: 'CANCELLATION_IN_PROGRESS',
          providerStatus: raw,
          warnings: ['CANCELLATION_ALREADY_IN_PROGRESS'],
        },
      });
    },
  );

  it('estado desconocido: no se escribe con dinero sobre lo que no se entiende', () => {
    expect(decideTboCancelPreflight(view('UNKNOWN', 'OnHold'))).toEqual({
      send: false,
      skipReason: 'STATUS_UNKNOWN',
      result: {
        success: false,
        error: 'TBO_BOOKING_STATUS_UNKNOWN',
        bookingStatus: 'UNKNOWN',
        providerStatus: 'OnHold',
        warnings: ['BOOKING_STATUS_UNKNOWN'],
      },
    });
  });

  it('no encontrada: no se manda y el Status.Code no se hace pasar por un estado', () => {
    expect(decideTboCancelPreflight(NOT_FOUND)).toEqual({
      send: false,
      skipReason: 'NOT_FOUND',
      result: { success: false, error: 'TBO_BOOKING_NOT_FOUND', warnings: [] },
    });
  });
});

describe('/Cancel y lectura posterior', () => {
  it.each<[string, TboCancelReply, HotelBookingView, object]>([
    [
      '200 + Cancelled',
      ACCEPTED,
      view('CANCELLED', 'Cancelled'),
      { success: true, bookingStatus: 'CANCELLED', warnings: [] },
    ],
    [
      'RF-25 CA-2: 200 + CancellationInProgress → aceptada, no final (D-TBO-25 A)',
      ACCEPTED,
      view('CANCELLATION_IN_PROGRESS', 'CancellationInProgress'),
      { success: true, bookingStatus: 'CANCELLATION_IN_PROGRESS', warnings: [] },
    ],
    [
      '200 + Confirmed: aceptada, a verificar',
      ACCEPTED,
      view('CONFIRMED', 'Confirmed'),
      { success: true, bookingStatus: 'CONFIRMED', warnings: ['BOOKING_STILL_CONFIRMED'] },
    ],
    [
      '200 + desconocido',
      ACCEPTED,
      view('UNKNOWN', 'Frozen'),
      { success: true, bookingStatus: 'UNKNOWN', warnings: ['BOOKING_STATUS_UNKNOWN'] },
    ],
    [
      'RF-25 CA-1: 479 + Confirmed → rechazo',
      REJECTED,
      view('CONFIRMED', 'Confirmed'),
      { success: false, error: 'TBO_CANCEL_FAIL', bookingStatus: 'CONFIRMED', warnings: [] },
    ],
    [
      '479 + Vouchered → rechazo',
      REJECTED,
      view('CONFIRMED', 'Vouchered'),
      { success: false, error: 'TBO_CANCEL_FAIL', providerStatus: 'Vouchered' },
    ],
    [
      '479 + ya cancelada → éxito idempotente',
      REJECTED,
      view('CANCELLED', 'Cancelled'),
      { success: true, bookingStatus: 'CANCELLED', warnings: ['ALREADY_CANCELLED'] },
    ],
    [
      '479 + en curso → la cancelación ya está pedida',
      REJECTED,
      view('CANCELLATION_IN_PROGRESS', 'CancelPending'),
      {
        success: true,
        bookingStatus: 'CANCELLATION_IN_PROGRESS',
        warnings: ['CANCELLATION_ALREADY_IN_PROGRESS'],
      },
    ],
    [
      '479 + desconocido → rechazo con aviso',
      REJECTED,
      view('UNKNOWN', 'Frozen'),
      {
        success: false,
        error: 'TBO_CANCEL_FAIL',
        bookingStatus: 'UNKNOWN',
        warnings: ['BOOKING_STATUS_UNKNOWN'],
      },
    ],
  ])('%s', (_name, reply, after, expected) => {
    expect(decideTboCancelResult(reply, { state: 'read', view: after })).toMatchObject(expected);
  });

  it('una lectura posterior fallida NO vuelve incierto un 200: sigue aceptada, con aviso', () => {
    expect(decideTboCancelResult(ACCEPTED, { state: 'failed' })).toEqual({
      success: true,
      warnings: ['POST_CANCEL_READ_FAILED'],
    });
  });

  it('y a un 479 lo deja rechazado, con el aviso para verificar (nunca reenviar)', () => {
    expect(decideTboCancelResult(REJECTED, { state: 'failed' })).toEqual({
      success: false,
      error: 'TBO_CANCEL_FAIL',
      warnings: ['POST_CANCEL_READ_FAILED'],
    });
  });

  it('una lectura posterior que no la encuentra tampoco decide nada', () => {
    expect(decideTboCancelResult(ACCEPTED, { state: 'read', view: NOT_FOUND })).toEqual({
      success: true,
      warnings: ['POST_CANCEL_READ_NOT_FOUND'],
    });
    expect(decideTboCancelResult(REJECTED, { state: 'read', view: NOT_FOUND })).toEqual({
      success: false,
      error: 'TBO_CANCEL_FAIL',
      warnings: ['POST_CANCEL_READ_NOT_FOUND'],
    });
  });

  it('refundAmount nunca: TBO no lo informa y una estimación no es dato del proveedor (04 §4.5)', () => {
    for (const reply of [ACCEPTED, REJECTED]) {
      expect(
        decideTboCancelResult(reply, { state: 'read', view: view('CANCELLED', 'Cancelled') }),
      ).not.toHaveProperty('refundAmount');
    }
  });
});

describe('vocabulario cerrado', () => {
  it('todo `error` y todo aviso que sale está en su lista', () => {
    const outcomes = [
      ...['CONFIRMED', 'CANCELLED', 'CANCELLATION_IN_PROGRESS', 'UNKNOWN'].map((status) =>
        decideTboCancelPreflight(view(status as HotelBookingStatus, 'x')),
      ),
      decideTboCancelPreflight(NOT_FOUND),
    ].flatMap((preflight) => (preflight.send ? [] : [preflight.result]));
    for (const reply of [ACCEPTED, REJECTED]) {
      outcomes.push(decideTboCancelResult(reply, { state: 'failed' }));
      outcomes.push(decideTboCancelResult(reply, { state: 'read', view: NOT_FOUND }));
      for (const status of ['CONFIRMED', 'CANCELLED', 'CANCELLATION_IN_PROGRESS', 'UNKNOWN']) {
        outcomes.push(
          decideTboCancelResult(reply, {
            state: 'read',
            view: view(status as HotelBookingStatus, 'x'),
          }),
        );
      }
    }
    for (const result of outcomes) {
      if (result.error !== undefined) {
        expect(TBO_CANCEL_ERRORS as readonly string[]).toContain(result.error);
      }
      for (const warning of result.warnings) {
        expect(TBO_CANCEL_WARNINGS as readonly string[]).toContain(warning);
      }
    }
  });
});
