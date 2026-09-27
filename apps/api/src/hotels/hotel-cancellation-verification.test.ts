import type { HotelBookingStatus, HotelBookingView } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { ORDER_EVENTS } from '../orders/order-events.js';
import type { HotelVerificationRead } from './hotel-booking-verification.js';
import {
  HOTEL_CANCEL_VERIFY_FIRST_MS,
  HOTEL_CANCEL_VERIFY_SCHEDULE_MS,
  HOTEL_CANCEL_VERIFY_STEPS,
  cancellationStepIsCurrent,
  cancellationVerifyAt,
  decideCancellationVerification,
  sweepCancellationStep,
  type HotelCancelVerifyFacts,
} from './hotel-cancellation-verification.js';
import type { HotelOrderSnapshot } from './hotel-order-state.js';

/**
 * `verify-cancellation` como función pura (docs/tbo/09 PR-5.3; 04 §4.4 punto 6 y §10; D-TBO-25 A):
 * el calendario y qué hacer con cada lectura. Lo que la lectura significa para la orden lo decide
 * la tabla de 04 §6.3; aquí se prueba qué pasa con el calendario.
 */

const MIN = 60_000;
const ANCLA = Date.parse('2026-09-26T15:00:00Z');

/** Una cancelación aceptada que el proveedor todavía procesa. */
const EN_CURSO: HotelOrderSnapshot = {
  status: 'pending',
  subStatus: null,
  providerStatus: 'CxlRequestSentToHotel',
  voucherStatus: 'true',
  refundAwaited: false,
  hcn: null,
  hcnState: null,
};

/** Una cancelación de la que no se sabe si se aplicó. */
const SIN_VERIFICAR: HotelOrderSnapshot = {
  ...EN_CURSO,
  subStatus: 'cancel-unverified',
  providerStatus: 'Confirmed',
};

function leida(status: HotelBookingStatus, providerStatus: string): HotelVerificationRead {
  const view: HotelBookingView = {
    found: true,
    providerBookingId: 'FL1IMA',
    status,
    providerStatus,
    warnings: [],
  };
  return { kind: 'read', view };
}

function hechos(parcial: Partial<HotelCancelVerifyFacts>): HotelCancelVerifyFacts {
  return {
    order: EN_CURSO,
    read: leida('CANCELLATION_IN_PROGRESS', 'CxlRequestSentToHotel'),
    step: 0,
    anchorAt: ANCLA,
    runner: 'job',
    finalAttempt: false,
    ...parcial,
  };
}

describe('el calendario (04 §10)', () => {
  it('+2 min, +15 min, +1 h, +6 h y +24 h desde la respuesta de la cancelación', () => {
    expect(HOTEL_CANCEL_VERIFY_SCHEDULE_MS).toEqual([
      2 * MIN,
      15 * MIN,
      60 * MIN,
      6 * 60 * MIN,
      24 * 60 * MIN,
    ]);
    expect(HOTEL_CANCEL_VERIFY_FIRST_MS).toBe(2 * MIN);
    expect(HOTEL_CANCEL_VERIFY_STEPS).toBe(5);
    expect(cancellationVerifyAt(ANCLA, 1)).toBe(ANCLA + 15 * MIN);
    expect(cancellationVerifyAt(ANCLA, HOTEL_CANCEL_VERIFY_STEPS)).toBeUndefined();
  });

  it('el barrido ejecuta el último paso ya vencido, nunca uno anterior al guardado', () => {
    expect(sweepCancellationStep(0, ANCLA, ANCLA + 20 * MIN)).toBe(1);
    expect(sweepCancellationStep(0, ANCLA, ANCLA + 7 * 60 * MIN)).toBe(3);
    expect(sweepCancellationStep(3, ANCLA, ANCLA + 20 * MIN)).toBe(3);
    expect(sweepCancellationStep(0, ANCLA, ANCLA)).toBe(0);
  });

  it('un job sólo ejecuta el paso vigente del calendario vigente', () => {
    const fila = { anchorAt: ANCLA, step: 2, nextAt: ANCLA + 60 * MIN };
    expect(cancellationStepIsCurrent(fila, 2, ANCLA)).toBe(true);
    expect(cancellationStepIsCurrent(fila, 1, ANCLA)).toBe(false);
    // Una cancelación nueva abrió otro calendario: el job del anterior no toca el nuevo.
    expect(cancellationStepIsCurrent(fila, 2, ANCLA - 1)).toBe(false);
    // Cerrado.
    expect(cancellationStepIsCurrent({ ...fila, nextAt: null }, 2, ANCLA)).toBe(false);
  });
});

describe('lo que decide cada lectura (sólo en la dirección segura: PV-B)', () => {
  it.each(['Cancelled', 'CancelledAndRefundAwaited'])(
    'la ve cancelada (%s): cierra la orden',
    (raw) => {
      const d = decideCancellationVerification(hechos({ read: leida('CANCELLED', raw) }));
      expect(d.kind).toBe('close');
      expect(d).toMatchObject({ plan: { orderStatus: 'cancelled', actions: ['stop-hcn'] } });
    },
  );

  it('una cancelación sin verificar que la lectura muestra cancelada también se cierra', () => {
    const d = decideCancellationVerification(
      hechos({ order: SIN_VERIFICAR, read: leida('CANCELLED', 'Cancelled') }),
    );
    expect(d).toMatchObject({ kind: 'close', plan: { subStatus: null } });
  });

  it('el cierre siempre deja OrderProviderStatusChanged, también sin lectura anterior en la fila', () => {
    const cambios = (order: HotelOrderSnapshot) => {
      const d = decideCancellationVerification(
        hechos({ order, read: leida('CANCELLED', 'Cancelled') }),
      );
      return d.kind === 'close'
        ? d.plan.events.filter((e) => e.type === ORDER_EVENTS.providerStatusChanged)
        : [];
    };

    // El Book no registra su lectura: una cancelación sin verificar llega sin estado guardado.
    expect(cambios({ ...SIN_VERIFICAR, providerStatus: null })).toEqual([
      { type: ORDER_EVENTS.providerStatusChanged, previous: null, current: 'Cancelled' },
    ]);
    // Con estado guardado lo emite la tabla, una sola vez.
    expect(cambios(EN_CURSO)).toEqual([
      {
        type: ORDER_EVENTS.providerStatusChanged,
        previous: 'CxlRequestSentToHotel',
        current: 'Cancelled',
      },
    ]);
    // Una consulta manual ya lo registró (y avisó): el cierre no lo repite.
    expect(cambios({ ...EN_CURSO, providerStatus: 'Cancelled' })).toEqual([]);
  });

  it('sigue en curso: registra y lee otra vez a la hora del paso siguiente', () => {
    expect(
      decideCancellationVerification(
        hechos({ step: 1, read: leida('CANCELLATION_IN_PROGRESS', 'CancelPending') }),
      ),
    ).toMatchObject({
      kind: 'advance',
      step: 2,
      at: ANCLA + 60 * MIN,
      plan: {
        record: { providerStatus: 'CancelPending' },
        events: [
          {
            type: ORDER_EVENTS.providerStatusChanged,
            previous: 'CxlRequestSentToHotel',
            current: 'CancelPending',
          },
        ],
      },
    });
  });

  it('una aceptada que la lectura todavía ve vigente también espera: puede ser asíncrona', () => {
    expect(
      decideCancellationVerification(hechos({ read: leida('CONFIRMED', 'Confirmed') })),
    ).toMatchObject({ kind: 'advance', step: 1 });
  });

  it('un "no la encuentro" no prueba nada: se sigue leyendo', () => {
    expect(
      decideCancellationVerification(
        hechos({ read: { kind: 'read', view: { found: false, warnings: [] } } }),
      ),
    ).toMatchObject({ kind: 'advance' });
  });

  it('el último paso todavía en curso: se atasca y lo mira una persona (cancellation-stuck)', () => {
    expect(
      decideCancellationVerification(hechos({ step: HOTEL_CANCEL_VERIFY_STEPS - 1 })),
    ).toMatchObject({ kind: 'stuck' });
  });

  it('PV-B: sin verificar y la lectura la ve vigente → a una persona, nunca otro Cancel', () => {
    const d = decideCancellationVerification(
      hechos({ order: SIN_VERIFICAR, read: leida('CONFIRMED', 'Confirmed') }),
    );
    expect(d).toMatchObject({
      kind: 'settle',
      plan: {
        orderStatus: 'keep',
        actions: ['human-review'],
        events: [{ type: ORDER_EVENTS.escalated, reason: 'cancellation-unverified' }],
      },
    });
  });

  it('HARD-1: un estado que el proveedor no documenta avisa a una persona y se sigue leyendo', () => {
    expect(
      decideCancellationVerification(hechos({ read: leida('UNKNOWN', 'Frozen') })),
    ).toMatchObject({
      kind: 'advance',
      step: 1,
      at: ANCLA + 15 * MIN,
      plan: {
        subStatus: 'unknown',
        record: { providerStatus: 'Frozen' },
        events: [{ type: ORDER_EVENTS.escalated, reason: 'provider-status-unknown' }],
      },
    });
    // Lo mismo sobre una cancelación sin verificar: la lectura rara no prueba nada en ningún sentido.
    expect(
      decideCancellationVerification(
        hechos({ order: SIN_VERIFICAR, read: leida('UNKNOWN', 'Frozen') }),
      ),
    ).toMatchObject({ kind: 'advance', plan: { subStatus: 'keep' } });
    expect(
      decideCancellationVerification(hechos({ read: leida('PENDING', 'Pending') })),
    ).toMatchObject({ kind: 'advance' });
  });

  it('HARD-1: el mismo estado raro otra vez no repite el aviso; en el último paso, stuck', () => {
    const rara: HotelOrderSnapshot = {
      ...EN_CURSO,
      subStatus: 'unknown',
      providerStatus: 'Frozen',
    };

    expect(
      decideCancellationVerification(hechos({ order: rara, read: leida('UNKNOWN', 'Frozen') })),
    ).toMatchObject({ kind: 'advance', plan: { events: [] } });
    // Otro valor raro sí es novedad.
    expect(
      decideCancellationVerification(hechos({ order: rara, read: leida('UNKNOWN', 'Thawed') })),
    ).toMatchObject({
      kind: 'advance',
      plan: { events: [{ type: ORDER_EVENTS.escalated, reason: 'provider-status-unknown' }] },
    });
    expect(
      decideCancellationVerification(
        hechos({
          order: rara,
          read: leida('UNKNOWN', 'Frozen'),
          step: HOTEL_CANCEL_VERIFY_STEPS - 1,
        }),
      ),
    ).toMatchObject({ kind: 'stuck' });
    // Y si en el paso siguiente la ve cancelada, se cierra.
    expect(
      decideCancellationVerification(
        hechos({ order: rara, read: leida('CANCELLED', 'Cancelled') }),
      ),
    ).toMatchObject({ kind: 'close', plan: { orderStatus: 'cancelled' } });
  });

  it('una orden que ya no espera una cancelación y lee un estado raro: a una persona', () => {
    const confirmada: HotelOrderSnapshot = {
      ...EN_CURSO,
      status: 'confirmed',
      providerStatus: 'Confirmed',
    };
    expect(
      decideCancellationVerification(
        hechos({ order: confirmada, read: leida('UNKNOWN', 'Frozen') }),
      ),
    ).toMatchObject({ kind: 'settle', plan: { actions: ['human-review'] } });
  });

  it('un rechazo cuya lectura posterior falló sólo necesitaba UNA lectura', () => {
    const confirmada: HotelOrderSnapshot = {
      ...EN_CURSO,
      status: 'confirmed',
      providerStatus: 'Confirmed',
    };

    expect(
      decideCancellationVerification(
        hechos({ order: confirmada, read: leida('CONFIRMED', 'Confirmed') }),
      ),
    ).toMatchObject({ kind: 'settle', plan: { orderStatus: 'keep', actions: [] } });
    // Cancelada del lado del proveedor: es la fila 14 (R3) y la cierra la conciliación, no esto.
    expect(
      decideCancellationVerification(
        hechos({ order: confirmada, read: leida('CANCELLED', 'Cancelled') }),
      ),
    ).toMatchObject({
      kind: 'settle',
      plan: { orderStatus: 'keep', actions: ['notify-agency', 'await-reconciliation'] },
    });
  });
});

describe('lo que decide una lectura que no se hizo', () => {
  it('la cuenta de la reserva ya no está: se deja de leer (leer con otra diría "no está")', () => {
    expect(decideCancellationVerification(hechos({ read: { kind: 'account-changed' } }))).toEqual({
      kind: 'hold',
      reason: 'provider-account-changed',
    });
  });

  it('un fallo permanente deja de leer y escala', () => {
    expect(
      decideCancellationVerification(hechos({ read: { kind: 'failed', error: 'permanent' } })),
    ).toEqual({ kind: 'hold', reason: 'verification-unavailable' });
  });

  it('un fallo de transporte: la cola lo repite; en el último intento o en el barrido, queda vencido', () => {
    const transporte: HotelVerificationRead = { kind: 'failed', error: 'transient' };
    expect(decideCancellationVerification(hechos({ read: transporte }))).toEqual({ kind: 'retry' });
    expect(
      decideCancellationVerification(hechos({ read: transporte, finalAttempt: true })),
    ).toEqual({
      kind: 'unavailable',
      reason: 'verification-unavailable',
      escalate: true,
    });
    expect(decideCancellationVerification(hechos({ read: transporte, runner: 'sweep' }))).toEqual({
      kind: 'unavailable',
      reason: 'verification-unavailable',
      escalate: false,
    });
  });

  it('la cuenta no puede leer: se avisa una vez por job y el barrido lo reintenta callado', () => {
    const cuenta: HotelVerificationRead = { kind: 'failed', error: 'account' };
    expect(decideCancellationVerification(hechos({ read: cuenta }))).toEqual({
      kind: 'unavailable',
      reason: 'provider-account-issue',
      escalate: true,
    });
    expect(decideCancellationVerification(hechos({ read: cuenta, runner: 'sweep' }))).toMatchObject(
      {
        escalate: false,
      },
    );
  });
});
