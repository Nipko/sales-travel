import type { HotelCancellation, HotelCancellationRule } from '@sales-travel/canonical';
import type { HotelCancelResult } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  estimateHotelCancellationPenalty,
  hotelCancelObservationOf,
  hotelCancellationSnapshotOf,
  settleHotelCancel,
  type HotelCancellationSnapshot,
} from './hotel-cancellation.js';
import type { HotelOrderSnapshot } from './hotel-order-state.js';

/**
 * La cancelación de una reserva de hotel como funciones puras (docs/tbo/09 PR-5.3; 08 RF-25; 04 §4.4
 * y §4.5; D-TBO-25 A, D-TBO-26 A): la penalidad estimada con el snapshot del PreBook en la hora del
 * hotel, y qué queda de la orden con la respuesta del proveedor.
 */

const USD = 'USD';
const TOTAL = { amountMinor: 100_000, currency: USD };

function tramo(parcial: Partial<HotelCancellationRule>): HotelCancellationRule {
  return { type: 'Percentage', ...parcial };
}

/** Los tramos de un PreBook de TBO: gratis, 50 % desde el 5 y 100 % desde el 9 (hora del hotel). */
const TRAMOS_TBO: HotelCancellationRule[] = [
  tramo({
    type: 'Fixed',
    fromLocalDateTime: '2026-09-01T00:00:00',
    penaltyAmount: { amountMinor: 0, currency: USD },
  }),
  tramo({ fromLocalDateTime: '2026-10-05T00:00:00', penaltyPercentage: 50 }),
  tramo({ fromLocalDateTime: '2026-10-09T00:00:00', penaltyPercentage: 100 }),
];

function politica(parcial: Partial<HotelCancellation> = {}): HotelCancellation {
  return {
    refundable: true,
    status: 'fully_refundable',
    rules: TRAMOS_TBO,
    policySource: 'prebook-final',
    ...parcial,
  };
}

function snapshot(parcial: Partial<HotelCancellationSnapshot> = {}): HotelCancellationSnapshot {
  return {
    total: TOTAL,
    roomCount: 2,
    cancellation: politica(),
    checkinDate: '2026-10-10',
    ...parcial,
  };
}

const BOGOTA = 'America/Bogota';

describe('el snapshot de la orden (orders.selected_offer)', () => {
  const ofertaGuardada = {
    vertical: 'hotels',
    checkinDate: '2026-10-10',
    roompack: {
      price: { total: TOTAL },
      rooms: [{ name: 'Doble' }, { name: 'Doble' }],
      cancellation: politica(),
    },
    // Lo que la estimación no necesita no se valida: una fila vieja con otras claves sigue sirviendo.
    pricing: { finalMinor: 120_000 },
  };

  it('toma el total del PreBook, las habitaciones, la política y la fecha de entrada', () => {
    expect(hotelCancellationSnapshotOf(ofertaGuardada)).toEqual(snapshot());
  });

  it('también de la columna como texto JSON', () => {
    expect(hotelCancellationSnapshotOf(JSON.stringify(ofertaGuardada))).toEqual(snapshot());
  });

  it.each([
    ['texto que no es JSON', '{roto'],
    ['sin fecha de entrada', { ...ofertaGuardada, checkinDate: undefined }],
    [
      'una política que se contradice',
      {
        ...ofertaGuardada,
        roompack: { ...ofertaGuardada.roompack, cancellation: politica({ refundable: false }) },
      },
    ],
    ['nada', null],
  ])('%s: sin snapshot, y sin inventar uno', (_caso, valor) => {
    expect(hotelCancellationSnapshotOf(valor)).toBeUndefined();
  });
});

describe('la penalidad estimada (RF-25; D-TBO-26 A)', () => {
  it('sin snapshot no hay estimación', () => {
    expect(estimateHotelCancellationPenalty({ snapshot: undefined, now: 0 })).toEqual({
      kind: 'unavailable',
      reason: 'no-snapshot',
    });
  });

  it('con la zona del hotel: el tramo vigente en SU hora, sin margen', () => {
    // 23:00 UTC del 4 son las 18:00 del 4 en Bogotá: todavía gratis.
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot(),
        now: Date.parse('2026-10-04T23:00:00Z'),
        timeZone: BOGOTA,
      }),
    ).toEqual({
      kind: 'estimated',
      penalty: { amountMinor: 0, currency: USD },
      base: TOTAL,
      basis: 'free',
      policySource: 'prebook-final',
      clock: 'hotel-time-zone',
      conservative: false,
      checkInReached: false,
    });
    // 06:00 UTC del 5 es la 01:00 del 5 en Bogotá: 50 % del total del PreBook.
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot(),
        now: Date.parse('2026-10-05T06:00:00Z'),
        timeZone: BOGOTA,
      }),
    ).toMatchObject({ penalty: { amountMinor: 50_000 }, basis: 'charged', conservative: false });
  });

  it('sin la zona (hoy, siempre): el tramo más caro que puede regir en alguna zona real', () => {
    // A las 23:00 UTC del 4 ya es el 5 desde UTC+1: puede regir el 50 %.
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot(),
        now: Date.parse('2026-10-04T23:00:00Z'),
      }),
    ).toMatchObject({
      penalty: { amountMinor: 50_000, currency: USD },
      basis: 'charged',
      clock: 'widest-offset',
      conservative: true,
    });
    // Lejos de cualquier cambio de tramo, no depende de la zona: no es conservadora.
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot(),
        now: Date.parse('2026-09-20T12:00:00Z'),
      }),
    ).toMatchObject({ penalty: { amountMinor: 0 }, basis: 'free', conservative: false });
  });

  it('una zona que no existe no rompe: se estima como sin zona', () => {
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot(),
        now: Date.parse('2026-10-04T23:00:00Z'),
        timeZone: 'Marte/Olimpo',
      }),
    ).toMatchObject({ clock: 'widest-offset', penalty: { amountMinor: 50_000 } });
  });

  it('dice si ya es el día de entrada en la hora del hotel (desde ahí, soporte: 04 PV-22)', () => {
    const now = Date.parse('2026-10-10T04:00:00Z');
    // En Bogotá todavía son las 23:00 del 9.
    expect(
      estimateHotelCancellationPenalty({ snapshot: snapshot(), now, timeZone: BOGOTA }),
    ).toMatchObject({ checkInReached: false, penalty: { amountMinor: 100_000 } });
    // Sin la zona, en UTC+14 ya es el 10.
    expect(estimateHotelCancellationPenalty({ snapshot: snapshot(), now })).toMatchObject({
      checkInReached: true,
    });
  });

  it('una tarifa no reembolsable cuesta el total, digan lo que digan los tramos', () => {
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({
          cancellation: politica({ refundable: false, status: 'non_refundable' }),
        }),
        now: Date.parse('2026-09-20T12:00:00Z'),
      }),
    ).toMatchObject({
      penalty: TOTAL,
      basis: 'non-refundable',
      conservative: false,
    });
  });

  it('reembolsable sin un solo tramo: no se estima (no se inventa "gratis")', () => {
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({
          cancellation: politica({
            status: 'partially_refundable',
            rules: [],
            policySource: 'none',
          }),
        }),
        now: 0,
      }),
    ).toEqual({ kind: 'unavailable', reason: 'no-policy' });
  });

  it('una política sin origen declarado lo dice', () => {
    const { policySource: _omitida, ...sinOrigen } = politica();
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: sinOrigen }),
        now: Date.parse('2026-09-20T12:00:00Z'),
      }),
    ).toMatchObject({ policySource: 'undeclared' });
  });

  it('tramos por habitación: cada una sobre su parte del total; si también hay de la reserva, rige el mayor', () => {
    const porHabitacion = [
      tramo({
        type: 'Fixed',
        roomIndex: 1,
        fromLocalDateTime: '2026-10-01T00:00:00',
        penaltyAmount: { amountMinor: 10_000, currency: USD },
      }),
      tramo({ roomIndex: 2, fromLocalDateTime: '2026-10-01T00:00:00', penaltyPercentage: 100 }),
      // Antes del tramo de la habitación 2: todavía no rige.
      tramo({ roomIndex: 2, fromLocalDateTime: '2026-09-01T00:00:00', penaltyPercentage: 0 }),
    ];
    const ahora = { now: Date.parse('2026-10-03T12:00:00Z'), timeZone: BOGOTA };

    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: porHabitacion }) }),
        ...ahora,
      }),
    ).toMatchObject({ penalty: { amountMinor: 60_000 }, conservative: false });

    // Una habitación cuyo primer tramo todavía no empezó no cobra nada.
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({
          cancellation: politica({
            rules: [
              tramo({
                roomIndex: 1,
                fromLocalDateTime: '2026-10-20T00:00:00',
                penaltyPercentage: 100,
              }),
            ],
          }),
        }),
        ...ahora,
      }),
    ).toMatchObject({ penalty: { amountMinor: 0 }, basis: 'free' });

    const conDeLaReserva = [
      ...porHabitacion,
      tramo({ fromLocalDateTime: '2026-10-01T00:00:00', penaltyPercentage: 75 }),
    ];
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: conDeLaReserva }) }),
        ...ahora,
      }),
    ).toMatchObject({ penalty: { amountMinor: 75_000 } });
  });

  it('un cargo que no se entiende cobra la parte entera y lo marca como conservadora', () => {
    const ilegibles = [
      // Un importe en otra moneda que el pack no se puede sumar.
      tramo({
        type: 'Fixed',
        roomIndex: 1,
        fromLocalDateTime: '2026-10-01T00:00:00',
        penaltyAmount: { amountMinor: 1, currency: 'EUR' },
      }),
      // Por noches: la API no da el precio por noche que haría falta.
      tramo({
        type: 'Nights',
        roomIndex: 2,
        fromLocalDateTime: '2026-10-01T00:00:00',
        penaltyNights: 1,
      }),
    ];
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: ilegibles }) }),
        now: Date.parse('2026-10-03T12:00:00Z'),
        timeZone: BOGOTA,
      }),
    ).toMatchObject({ penalty: { amountMinor: 100_000 }, conservative: true });
  });

  it('nunca más que el total', () => {
    const excesiva = [
      tramo({
        type: 'Fixed',
        fromLocalDateTime: '2026-09-01T00:00:00',
        penaltyAmount: { amountMinor: 250_000, currency: USD },
      }),
    ];
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: excesiva }) }),
        now: Date.parse('2026-09-20T12:00:00Z'),
        timeZone: BOGOTA,
      }),
    ).toMatchObject({ penalty: TOTAL, basis: 'charged' });
  });

  it('tramos sin inicio (horas antes de la entrada): rige el más caro, siempre conservadora', () => {
    const relativos = [
      tramo({ fromHours: 100, penaltyPercentage: 0 }),
      tramo({ roomIndex: 1, fromHours: 48, penaltyPercentage: 40 }),
      tramo({ fromHours: 72, penaltyPercentage: 10 }),
    ];
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: relativos }) }),
        now: Date.parse('2026-09-20T12:00:00Z'),
      }),
    ).toMatchObject({ penalty: { amountMinor: 20_000 }, basis: 'charged', conservative: true });

    // Las habitaciones se cancelan juntas: el peor tramo de cada una se suma, y el más caro de un
    // solo tramo (la mitad) prometería devolver una habitación que el hotel cobra.
    const porHabitacion = [
      tramo({ roomIndex: 1, fromHours: 48, penaltyPercentage: 100 }),
      tramo({ roomIndex: 2, fromHours: 48, penaltyPercentage: 100 }),
      tramo({ roomIndex: 2, fromHours: 96, penaltyPercentage: 20 }),
      tramo({ fromHours: 72, penaltyPercentage: 30 }),
    ];
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: porHabitacion }) }),
        now: Date.parse('2026-09-20T12:00:00Z'),
      }),
    ).toMatchObject({ penalty: TOTAL, basis: 'charged', conservative: true });

    const gratis = [tramo({ fromHours: 100, penaltyPercentage: 0 })];
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: gratis }) }),
        now: Date.parse('2026-09-20T12:00:00Z'),
      }),
    ).toMatchObject({ penalty: { amountMinor: 0 }, basis: 'free', conservative: true });
  });

  it('el orden de los tramos no cambia el resultado: se ordenan por su inicio', () => {
    const desordenados = [...TRAMOS_TBO].reverse();
    const ahora = { now: Date.parse('2026-10-06T12:00:00Z'), timeZone: BOGOTA };
    expect(
      estimateHotelCancellationPenalty({
        snapshot: snapshot({ cancellation: politica({ rules: desordenados }) }),
        ...ahora,
      }),
    ).toEqual(estimateHotelCancellationPenalty({ snapshot: snapshot(), ...ahora }));
  });
});

describe('la respuesta del proveedor como observación de la tabla (04 §6.3)', () => {
  it('con la lectura posterior: una reserva leída, con el reembolso pendiente si lo dijo', () => {
    expect(
      hotelCancelObservationOf({
        success: true,
        bookingStatus: 'CANCELLED',
        providerStatus: 'CancelledAndRefundAwaited',
        refundAwaited: true,
        warnings: [],
      }),
    ).toEqual({
      kind: 'cancel-accepted',
      read: {
        found: true,
        status: 'CANCELLED',
        providerStatus: 'CancelledAndRefundAwaited',
        refundAwaited: true,
        warnings: [],
      },
    });
    expect(
      hotelCancelObservationOf({
        success: false,
        error: 'TBO_CANCEL_FAIL',
        bookingStatus: 'CONFIRMED',
        warnings: [],
      }),
    ).toEqual({
      kind: 'cancel-rejected',
      read: { found: true, status: 'CONFIRMED', warnings: [] },
    });
  });

  it('sin lectura posterior (falló o no la encontró): nada que decida', () => {
    expect(
      hotelCancelObservationOf({ success: true, warnings: ['POST_CANCEL_READ_FAILED'] }),
    ).toEqual({ kind: 'cancel-accepted', read: null });
  });
});

describe('qué queda de la orden (D-TBO-25 A)', () => {
  /** La orden con el claim tomado: `pending` y `cancel-requested`. */
  const CLAIM: HotelOrderSnapshot = {
    status: 'pending',
    subStatus: 'cancel-requested',
    providerStatus: 'Confirmed',
    voucherStatus: 'true',
    refundAwaited: false,
    hcn: null,
    hcnState: null,
  };

  function respuesta(parcial: Partial<HotelCancelResult>): HotelCancelResult {
    return { success: true, warnings: [], ...parcial };
  }

  it.each<[string, HotelCancelResult, string, string | undefined]>([
    [
      'aceptada y ya cancelada',
      respuesta({ bookingStatus: 'CANCELLED', providerStatus: 'Cancelled' }),
      'cancelled',
      'final',
    ],
    [
      'RF-25 CA-2: aceptada y en curso → "Cancelación en curso"',
      respuesta({
        bookingStatus: 'CANCELLATION_IN_PROGRESS',
        providerStatus: 'CxlRequestSentToHotel',
      }),
      'pending',
      'in-progress',
    ],
    ['aceptada sin lectura', respuesta({}), 'pending', 'in-progress'],
    [
      'aceptada con un estado desconocido',
      respuesta({ bookingStatus: 'UNKNOWN', providerStatus: 'Frozen' }),
      'pending',
      'in-progress',
    ],
    [
      'RF-25 CA-1: 479 con la reserva vigente → el estado previo',
      respuesta({
        success: false,
        error: 'TBO_CANCEL_FAIL',
        bookingStatus: 'CONFIRMED',
        providerStatus: 'Confirmed',
      }),
      'confirmed',
      undefined,
    ],
    [
      'rechazada con un estado desconocido → el estado previo, a revisión',
      respuesta({ success: false, error: 'TBO_BOOKING_STATUS_UNKNOWN', bookingStatus: 'UNKNOWN' }),
      'confirmed',
      undefined,
    ],
  ])('%s', (_caso, result, orderStatus, settlement) => {
    const outcome = settleHotelCancel(CLAIM, 'confirmed', result);
    expect(outcome.orderStatus).toBe(orderStatus);
    // Un rechazo no deja cancelación que asentar: la orden vuelve a su estado.
    if (settlement !== undefined) expect(outcome.settlement).toBe(settlement);
    expect(outcome.plan.subStatus).not.toBe('cancel-requested');
  });

  it('en curso agenda la verificación y no corta nada; cancelada corta el HCN', () => {
    expect(
      settleHotelCancel(
        CLAIM,
        'confirmed',
        respuesta({ bookingStatus: 'CANCELLATION_IN_PROGRESS', providerStatus: 'CancelPending' }),
      ).plan.actions,
    ).toEqual(['verify-cancellation']);
    expect(
      settleHotelCancel(
        CLAIM,
        'confirmed',
        respuesta({
          bookingStatus: 'CANCELLED',
          refundAwaited: true,
          providerStatus: 'CancelledAndRefundAwaited',
        }),
      ).plan,
    ).toMatchObject({
      orderStatus: 'cancelled',
      record: { providerStatus: 'CancelledAndRefundAwaited', refundAwaited: true },
      actions: ['stop-hcn', 'track-refund'],
    });
  });
});
