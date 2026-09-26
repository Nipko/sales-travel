import { describe, expect, it } from 'vitest';
import { TBO_BOOKING_STATUSES, readTboBookingStatus } from './booking-status';

/**
 * `BookingStatus` → estado neutral (docs/tbo/04 §6.1 y §6.3; 08 RF-24 CA-2).
 */

describe('el enum de TBO (p. 70-71) más Vouchered (p. 64)', () => {
  it.each([
    ['Confirmed', 'CONFIRMED', false],
    ['Vouchered', 'CONFIRMED', false],
    ['CancellationInProgress', 'CANCELLATION_IN_PROGRESS', false],
    ['CancelPending', 'CANCELLATION_IN_PROGRESS', false],
    ['CxlRequestSentToHotel', 'CANCELLATION_IN_PROGRESS', false],
    ['CancelledAndRefundAwaited', 'CANCELLED', true],
    ['Cancelled', 'CANCELLED', false],
  ] as const)('%s → %s', (raw, status, refundAwaited) => {
    expect(readTboBookingStatus(raw)).toEqual({
      status,
      providerStatus: raw,
      refundAwaited,
      unknown: false,
      casingVariant: false,
    });
  });

  it('la lista publicada es exactamente ésa', () => {
    expect(TBO_BOOKING_STATUSES).toEqual([
      'Confirmed',
      'Vouchered',
      'CancellationInProgress',
      'CancelPending',
      'CxlRequestSentToHotel',
      'CancelledAndRefundAwaited',
      'Cancelled',
    ]);
  });

  it('CancelledAndRefundAwaited es cancelada, no "en curso": la habitación ya está liberada', () => {
    expect(readTboBookingStatus('CancelledAndRefundAwaited').status).toBe('CANCELLED');
  });
});

describe('otra grafía del mismo valor', () => {
  it.each(['confirmed', 'CONFIRMED', ' Confirmed ', 'Cancel Pending', 'cxl_request_sent_to_hotel'])(
    '%j se reconoce y sale con la grafía del enum',
    (raw) => {
      const reading = readTboBookingStatus(raw);
      expect(reading.unknown).toBe(false);
      expect(reading.casingVariant).toBe(true);
      expect(TBO_BOOKING_STATUSES).toContain(reading.providerStatus);
    },
  );
});

describe('lo desconocido no se adivina (04 §6.3)', () => {
  it.each([
    ['OnRequest', 'OnRequest'],
    ['Canceled', 'Canceled'],
    ['Pending Confirmation', 'Pending_Confirmation'],
    ['<b>Failed</b>', 'b_Failed_b'],
    ['???', 'unknown'],
  ])('%j → UNKNOWN, con el valor como código %j', (raw, code) => {
    expect(readTboBookingStatus(raw)).toEqual({
      status: 'UNKNOWN',
      providerStatus: code,
      refundAwaited: false,
      unknown: true,
      casingVariant: false,
    });
  });

  it('el código tiene techo: un texto largo no viaja entero a un evento', () => {
    expect(readTboBookingStatus('x'.repeat(500)).providerStatus).toHaveLength(64);
  });
});
