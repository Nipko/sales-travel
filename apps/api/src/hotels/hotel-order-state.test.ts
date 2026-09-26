import type { HotelBookingStatus, HotelBookingView } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  HOTEL_ORDER_SUB_STATUSES,
  type HotelOrderSubStatus,
  type OrderStatus,
} from '../database/database.types.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import { decideVerification } from './hotel-booking-verification.js';
import {
  planHotelOrderObservation,
  type HotelOrderObservation,
  type HotelOrderReadSource,
  type HotelOrderSnapshot,
} from './hotel-order-state.js';

/**
 * La tabla de docs/tbo/04 §6.3 como test de una función pura (08 RF-26 CA; docs/tbo/09 PR-5.2).
 * Un `it` por fila, con la observación de la tabla en el título y lo que la tabla dice en el
 * `expect`: `orders.status`, subestado, acción y evento. Los estados de TBO van con su grafía del
 * enum (p. 70-71) y `Vouchered` (p. 64), ya normalizados como los entrega el ACL.
 *
 * Donde la tabla no lista `OrderProviderStatusChanged` y el caso cambia el estado guardado, el
 * evento aparece igual: 04 §6.5 lo pide "cada vez que una lectura observa un BookingStatus distinto
 * al guardado".
 */

function leida(
  status: HotelBookingStatus,
  providerStatus: string,
  extra: Partial<HotelBookingView> = {},
): HotelBookingView {
  return {
    found: true,
    providerBookingId: 'YOSUR8',
    status,
    providerStatus,
    warnings: [],
    ...extra,
  };
}

const CONFIRMED = leida('CONFIRMED', 'Confirmed');
const VOUCHERED = leida('CONFIRMED', 'Vouchered');
const CANCELLED = leida('CANCELLED', 'Cancelled');
const REFUND_AWAITED = leida('CANCELLED', 'CancelledAndRefundAwaited', { refundAwaited: true });
const EN_CURSO = [
  leida('CANCELLATION_IN_PROGRESS', 'CancellationInProgress'),
  leida('CANCELLATION_IN_PROGRESS', 'CancelPending'),
  leida('CANCELLATION_IN_PROGRESS', 'CxlRequestSentToHotel'),
] as const;
const DESCONOCIDO = leida('UNKNOWN', 'On_Request', { warnings: ['BOOKING_STATUS_UNKNOWN'] });
const NO_ENCONTRADA: HotelBookingView = { found: false, warnings: [] };

function orden(over: Partial<HotelOrderSnapshot> = {}): HotelOrderSnapshot {
  return {
    status: 'confirmed',
    subStatus: null,
    providerStatus: 'Confirmed',
    voucherStatus: null,
    refundAwaited: false,
    hcn: null,
    hcnState: null,
    ...over,
  };
}

/** Una orden con el claim de cancelación tomado (fila 8). */
const EN_CANCELACION = orden({ status: 'pending', subStatus: 'cancel-requested' });
/** Un intent sin respuesta del Book todavía (filas 1 y 5). */
const INTENT = orden({ status: 'pending', subStatus: 'create-pending', providerStatus: null });

const plan = planHotelOrderObservation;

describe('04 §6.3 — mapeo de observaciones a estados, fila por fila', () => {
  it('1. intent creado; el Book no salió o está en vuelo → pending / create-pending, OrderCreateRequested', () => {
    expect(plan(INTENT, { kind: 'intent-opened' })).toEqual({
      orderStatus: 'pending',
      subStatus: 'create-pending',
      actions: [],
      events: [{ type: ORDER_EVENTS.createRequested }],
    });
  });

  it.each([CONFIRMED, VOUCHERED])(
    '2. Book 200 y BookingDetail en $providerStatus → confirmed / valor crudo, HCN, OrderCreated y OrderCreationVerified',
    (read) => {
      expect(plan(INTENT, { kind: 'book-confirmed', read })).toEqual({
        orderStatus: 'confirmed',
        subStatus: null,
        record: { providerStatus: read.providerStatus, refundAwaited: false },
        actions: ['schedule-hcn'],
        events: [
          { type: ORDER_EVENTS.created, outcome: 'CONFIRMED' },
          { type: ORDER_EVENTS.verified },
        ],
      });
    },
  );

  it('3. Book 200 y falla la lectura de cierre → confirmed / unverified-read, releer por localizador, verification-unavailable', () => {
    expect(plan(INTENT, { kind: 'book-confirmed', read: null })).toEqual({
      orderStatus: 'confirmed',
      subStatus: 'unverified-read',
      actions: ['verify-by-locator'],
      events: [{ type: ORDER_EVENTS.escalated, reason: 'verification-unavailable' }],
    });
  });

  it('4. Book con error definitivo → failed, se libera la clave, OrderCreated (FAILED)', () => {
    expect(plan(INTENT, { kind: 'book-failed' })).toEqual({
      orderStatus: 'failed',
      subStatus: null,
      actions: ['release-create-key'],
      events: [{ type: ORDER_EVENTS.created, outcome: 'FAILED' }],
    });
  });

  it('5. Book incierto → pending / create-uncertain, lectura por referencia a +120 s, OrderCreateFailed (uncertain)', () => {
    expect(plan(INTENT, { kind: 'book-uncertain' })).toEqual({
      orderStatus: 'pending',
      subStatus: 'create-uncertain',
      actions: ['verify-by-reference'],
      events: [{ type: ORDER_EVENTS.createFailed, uncertain: true }],
    });
  });

  it('6. la recuperación encuentra la reserva → según el mapeo / valor crudo, consolidar y HCN, OrderCreationVerified', () => {
    const incierta = orden({
      status: 'pending',
      subStatus: 'create-uncertain',
      providerStatus: null,
    });
    expect(plan(incierta, { kind: 'recovered', read: CONFIRMED, by: 'booking-reference' })).toEqual(
      {
        orderStatus: 'confirmed',
        subStatus: null,
        record: { providerStatus: 'Confirmed', refundAwaited: false },
        actions: ['consolidate-intent', 'schedule-hcn'],
        events: [{ type: ORDER_EVENTS.verified, recoveredBy: 'booking-reference' }],
      },
    );
  });

  it('7. la recuperación no la encuentra → pending / create-not-found-yet, la cierra la conciliación, create-not-found', () => {
    const incierta = orden({
      status: 'pending',
      subStatus: 'create-uncertain',
      providerStatus: null,
    });
    expect(plan(incierta, { kind: 'recovery-not-found' })).toEqual({
      orderStatus: 'pending',
      subStatus: 'create-not-found-yet',
      actions: ['await-reconciliation'],
      events: [{ type: ORDER_EVENTS.escalated, reason: 'create-not-found' }],
    });
  });

  it('8. claim de cancelación adquirido → pending / cancel-requested, Cancel, sin evento', () => {
    expect(plan(orden(), { kind: 'cancel-claimed' })).toEqual({
      orderStatus: 'pending',
      subStatus: 'cancel-requested',
      actions: ['send-cancel'],
      events: [],
    });
  });

  it.each(EN_CURSO)(
    '9. $providerStatus → pending / valor crudo, verify-cancellation, OrderProviderStatusChanged',
    (read) => {
      expect(plan(EN_CANCELACION, { kind: 'cancel-accepted', read })).toEqual({
        orderStatus: 'pending',
        subStatus: null,
        record: { providerStatus: read.providerStatus, refundAwaited: false },
        actions: ['verify-cancellation'],
        events: [
          {
            type: ORDER_EVENTS.providerStatusChanged,
            previous: 'Confirmed',
            current: read.providerStatus,
          },
        ],
      });
    },
  );

  it('10. CancelledAndRefundAwaited → cancelled / valor crudo y refundAwaited, la conciliación sigue el reembolso', () => {
    expect(plan(EN_CANCELACION, { kind: 'cancel-accepted', read: REFUND_AWAITED })).toEqual({
      orderStatus: 'cancelled',
      subStatus: null,
      record: { providerStatus: 'CancelledAndRefundAwaited', refundAwaited: true },
      actions: ['stop-hcn', 'track-refund'],
      events: [
        {
          type: ORDER_EVENTS.providerStatusChanged,
          previous: 'Confirmed',
          current: 'CancelledAndRefundAwaited',
        },
      ],
    });
  });

  it('11. Cancelled → cancelled / valor crudo, se detiene el HCN, OrderProviderStatusChanged', () => {
    expect(plan(EN_CANCELACION, { kind: 'cancel-accepted', read: CANCELLED })).toEqual({
      orderStatus: 'cancelled',
      subStatus: null,
      record: { providerStatus: 'Cancelled', refundAwaited: false },
      actions: ['stop-hcn'],
      events: [
        { type: ORDER_EVENTS.providerStatusChanged, previous: 'Confirmed', current: 'Cancelled' },
      ],
    });
  });

  it.each([CONFIRMED, VOUCHERED])(
    '12. Cancel 479 y lectura $providerStatus → estado previo / valor crudo, OrderCancellationAttempted (success: false)',
    (read) => {
      const antes = { ...EN_CANCELACION, providerStatus: read.providerStatus ?? null };
      expect(plan(antes, { kind: 'cancel-rejected', read })).toEqual({
        orderStatus: 'prior',
        subStatus: null,
        record: { providerStatus: read.providerStatus, refundAwaited: false },
        actions: [],
        events: [{ type: ORDER_EVENTS.cancelled, success: false }],
      });
    },
  );

  it('13. Cancel UNVERIFIED → pending / cancel-unverified, verify-cancellation, cancellation-unverified', () => {
    expect(plan(EN_CANCELACION, { kind: 'cancel-unverified' })).toEqual({
      orderStatus: 'pending',
      subStatus: 'cancel-unverified',
      actions: ['verify-cancellation'],
      events: [{ type: ORDER_EVENTS.escalated, reason: 'cancellation-unverified' }],
    });
  });

  describe('14. conciliación: TBO en cancelación y la nuestra confirmed → según el mapeo, avisar a la agencia', () => {
    const discrepancia = {
      type: ORDER_EVENTS.reconciliationDiscrepancy,
      kind: 'R3',
      severity: 'warning',
    };

    it.each(EN_CURSO)('$providerStatus → pending y verify-cancellation', (read) => {
      expect(plan(orden(), { kind: 'read', source: 'reconciliation', read })).toEqual({
        orderStatus: 'pending',
        subStatus: null,
        record: { providerStatus: read.providerStatus, refundAwaited: false },
        actions: ['verify-cancellation', 'notify-agency'],
        events: [
          discrepancia,
          {
            type: ORDER_EVENTS.providerStatusChanged,
            previous: 'Confirmed',
            current: read.providerStatus,
          },
        ],
      });
    });

    it('Cancelled → cancelled y se detiene el HCN', () => {
      expect(plan(orden(), { kind: 'read', source: 'reconciliation', read: CANCELLED })).toEqual({
        orderStatus: 'cancelled',
        subStatus: null,
        record: { providerStatus: 'Cancelled', refundAwaited: false },
        actions: ['stop-hcn', 'notify-agency'],
        events: [
          discrepancia,
          { type: ORDER_EVENTS.providerStatusChanged, previous: 'Confirmed', current: 'Cancelled' },
        ],
      });
    });
  });

  it.each([CONFIRMED, VOUCHERED])(
    '15. conciliación: TBO en $providerStatus y la nuestra cancelled → sin cambio automático, revisión urgente, discrepancia critical',
    (read) => {
      const cancelada = orden({ status: 'cancelled', providerStatus: 'Cancelled' });
      expect(plan(cancelada, { kind: 'read', source: 'reconciliation', read })).toEqual({
        orderStatus: 'keep',
        subStatus: 'keep',
        record: { providerStatus: read.providerStatus, refundAwaited: false },
        actions: ['urgent-human-review'],
        events: [
          { type: ORDER_EVENTS.reconciliationDiscrepancy, kind: 'R4', severity: 'critical' },
          {
            type: ORDER_EVENTS.providerStatusChanged,
            previous: 'Cancelled',
            current: read.providerStatus,
          },
        ],
      });
    },
  );

  it.each<HotelOrderReadSource>(['retrieve', 'verify', 'hcn', 'reconciliation'])(
    '16. BookingStatus desconocido (%s) → sin cambio / unknown con el valor crudo, revisión humana, provider-status-unknown',
    (source) => {
      expect(plan(orden(), { kind: 'read', source, read: DESCONOCIDO })).toEqual({
        orderStatus: 'keep',
        subStatus: 'unknown',
        record: { providerStatus: 'On_Request', refundAwaited: false },
        actions: ['human-review'],
        events: [{ type: ORDER_EVENTS.escalated, reason: 'provider-status-unknown' }],
      });
    },
  );

  it('17. VoucherStatus false o "Confirm" con Confirmed → confirmed / valor crudo, alerta (PV-02), OrderProviderStatusChanged', () => {
    const sinVoucher = leida('CONFIRMED', 'Confirmed', {
      voucherIssued: false,
      warnings: ['VOUCHER_NOT_ISSUED'],
    });
    expect(
      plan(orden({ voucherStatus: 'true' }), {
        kind: 'read',
        source: 'retrieve',
        read: sinVoucher,
      }),
    ).toEqual({
      orderStatus: 'keep',
      subStatus: null,
      record: { providerStatus: 'Confirmed', voucherStatus: 'false', refundAwaited: false },
      actions: ['voucher-alert'],
      events: [
        {
          type: ORDER_EVENTS.providerStatusChanged,
          previous: 'Confirmed',
          current: 'Confirmed',
          voucherIssued: false,
        },
      ],
    });
  });
});

describe('reglas que la tabla da por supuestas', () => {
  const ESTADOS: readonly OrderStatus[] = [
    'pending',
    'confirmed',
    'ticketed',
    'cancelled',
    'failed',
  ];
  const SUBESTADOS: readonly (HotelOrderSubStatus | null)[] = [null, ...HOTEL_ORDER_SUB_STATUSES];
  const LECTURAS: readonly HotelBookingView[] = [
    CONFIRMED,
    VOUCHERED,
    ...EN_CURSO,
    CANCELLED,
    REFUND_AWAITED,
    DESCONOCIDO,
    NO_ENCONTRADA,
    leida('PENDING', 'Pending'),
  ];

  function todas(): { order: HotelOrderSnapshot; read: HotelBookingView }[] {
    return ESTADOS.flatMap((status) =>
      SUBESTADOS.flatMap((subStatus) =>
        LECTURAS.map((read) => ({ order: orden({ status, subStatus }), read })),
      ),
    );
  }

  it.each<HotelOrderReadSource>(['retrieve', 'hcn'])(
    'una lectura de "%s" nunca cambia orders.status: la transición es de la cancelación o de la conciliación',
    (source) => {
      for (const { order, read } of todas()) {
        expect(plan(order, { kind: 'read', source, read }).orderStatus, JSON.stringify(order)).toBe(
          'keep',
        );
      }
    },
  );

  it('con el claim de cancelación en vuelo, ninguna lectura toca el estado ni el subestado', () => {
    for (const source of ['retrieve', 'verify', 'hcn', 'reconciliation'] as const) {
      for (const read of LECTURAS) {
        const p = plan(EN_CANCELACION, { kind: 'read', source, read });
        expect({ source, status: p.orderStatus, sub: p.subStatus }).toEqual({
          source,
          status: 'keep',
          sub: 'keep',
        });
      }
    }
  });

  it('una lectura vigente resuelve un unknown o una lectura de cierre que había fallado', () => {
    for (const subStatus of ['unknown', 'unverified-read'] as const) {
      expect(
        plan(orden({ subStatus }), { kind: 'read', source: 'retrieve', read: CONFIRMED }).subStatus,
      ).toBeNull();
    }
    // Un proceso abierto conserva su subestado.
    expect(
      plan(orden({ status: 'pending', subStatus: 'cancel-unverified' }), {
        kind: 'read',
        source: 'retrieve',
        read: CONFIRMED,
      }).subStatus,
    ).toBe('keep');
  });

  it('un valor fuera del enum nunca sale en un evento: va como unknown', () => {
    for (const { order, read } of todas()) {
      for (const source of ['retrieve', 'verify', 'hcn', 'reconciliation'] as const) {
        const eventos = JSON.stringify(plan(order, { kind: 'read', source, read }).events);
        expect(eventos).not.toContain('On_Request');
      }
    }
    // Y un estado guardado raro tampoco sale como "anterior".
    const guardadoRaro = orden({ subStatus: 'unknown', providerStatus: 'On_Request' });
    expect(
      plan(guardadoRaro, { kind: 'read', source: 'retrieve', read: CANCELLED }).events,
    ).toEqual([
      { type: ORDER_EVENTS.reconciliationDiscrepancy, kind: 'R3', severity: 'warning' },
      { type: ORDER_EVENTS.providerStatusChanged, previous: 'unknown', current: 'Cancelled' },
    ]);
  });

  it('la primera lectura no es un cambio de estado', () => {
    const sinLeer = orden({ providerStatus: null });
    expect(plan(sinLeer, { kind: 'read', source: 'retrieve', read: CONFIRMED }).events).toEqual([]);
  });

  it('la consulta manual de una orden confirmada que el proveedor ve cancelada avisa y la deja para la conciliación', () => {
    expect(plan(orden(), { kind: 'read', source: 'retrieve', read: CANCELLED })).toMatchObject({
      orderStatus: 'keep',
      subStatus: 'keep',
      record: { providerStatus: 'Cancelled' },
      actions: ['notify-agency', 'await-reconciliation'],
    });
  });

  it('PV-01: "no la encuentro" nunca prueba que no exista; avisa sólo si la orden dice confirmada', () => {
    expect(plan(orden(), { kind: 'read', source: 'retrieve', read: NO_ENCONTRADA })).toEqual({
      orderStatus: 'keep',
      subStatus: 'keep',
      actions: ['human-review'],
      events: [{ type: ORDER_EVENTS.escalated, reason: 'verified-not-found' }],
    });
    expect(
      plan(orden({ status: 'cancelled' }), {
        kind: 'read',
        source: 'retrieve',
        read: NO_ENCONTRADA,
      }),
    ).toEqual({ orderStatus: 'keep', subStatus: 'keep', actions: [], events: [] });
  });

  it('un estado neutral que una reserva creada no debería tener se escala sin cambiar nada', () => {
    expect(
      plan(orden(), { kind: 'read', source: 'retrieve', read: leida('FAILED', 'Failed') }),
    ).toMatchObject({
      orderStatus: 'keep',
      subStatus: 'keep',
      events: [{ type: ORDER_EVENTS.escalated, reason: 'verified-status-unexpected' }],
    });
  });

  it('la verificación de una cancelación sin verificar que ve la reserva vigente no reenvía nada: persona (PV-B)', () => {
    const sinVerificar = orden({ status: 'pending', subStatus: 'cancel-unverified' });
    expect(plan(sinVerificar, { kind: 'read', source: 'verify', read: CONFIRMED })).toEqual({
      orderStatus: 'keep',
      subStatus: 'keep',
      record: { providerStatus: 'Confirmed', refundAwaited: false },
      actions: ['human-review'],
      events: [{ type: ORDER_EVENTS.escalated, reason: 'cancellation-unverified' }],
    });
    // Y si la ve cancelada, la cierra en la dirección segura.
    expect(plan(sinVerificar, { kind: 'read', source: 'verify', read: CANCELLED })).toMatchObject({
      orderStatus: 'cancelled',
      subStatus: null,
      actions: ['stop-hcn'],
    });
  });

  it('el reembolso que llega a una orden ya cancelada sólo se registra', () => {
    const esperando = orden({
      status: 'cancelled',
      providerStatus: 'CancelledAndRefundAwaited',
      refundAwaited: true,
    });
    expect(plan(esperando, { kind: 'read', source: 'reconciliation', read: CANCELLED })).toEqual({
      orderStatus: 'keep',
      subStatus: 'keep',
      record: { providerStatus: 'Cancelled', refundAwaited: false },
      actions: [],
      events: [
        {
          type: ORDER_EVENTS.providerStatusChanged,
          previous: 'CancelledAndRefundAwaited',
          current: 'Cancelled',
        },
      ],
    });
  });
});

describe('HCN en una lectura (RF-27, lado lectura)', () => {
  const conHcn = leida('CONFIRMED', 'Confirmed', { hotelConfirmationNumber: ' HCN-4711 ' });

  it('aparece: se registra como recibido y se emite HotelConfirmationNumberReceived', () => {
    const p = plan(orden({ hcnState: 'scheduled' }), {
      kind: 'read',
      source: 'retrieve',
      read: conHcn,
    });
    expect(p.hcn).toEqual({ hcn: 'HCN-4711', markReceived: true });
    expect(p.events).toEqual([
      { type: ORDER_EVENTS.hotelConfirmationNumberReceived, hcn: 'HCN-4711' },
    ]);
  });

  it('el mismo HCN otra vez no escribe ni emite nada', () => {
    const p = plan(orden({ hcn: 'HCN-4711', hcnState: 'received' }), {
      kind: 'read',
      source: 'hcn',
      read: conHcn,
    });
    expect(p.hcn).toBeUndefined();
    expect(p.events).toEqual([]);
  });

  it('con el seguimiento cortado se guarda el número sin reabrirlo', () => {
    expect(
      plan(orden({ hcnState: 'stopped' }), { kind: 'read', source: 'retrieve', read: conHcn }).hcn,
    ).toEqual({ hcn: 'HCN-4711', markReceived: false });
  });

  it('una reserva cancelada no registra HCN', () => {
    const cancelada = leida('CANCELLED', 'Cancelled', { hotelConfirmationNumber: 'HCN-4711' });
    expect(
      plan(orden({ status: 'cancelled', providerStatus: 'Cancelled' }), {
        kind: 'read',
        source: 'retrieve',
        read: cancelada,
      }).hcn,
    ).toBeUndefined();
  });
});

describe('la tabla y las decisiones de la creación no se contradicen', () => {
  const incierta = orden({
    status: 'pending',
    subStatus: 'create-uncertain',
    providerStatus: null,
  });

  it.each([CONFIRMED, CANCELLED, EN_CURSO[0], DESCONOCIDO])(
    'recuperación con $providerStatus: lo mismo que decide la verificación de PR-4.7',
    (read) => {
      const verificacion = decideVerification({
        read: { kind: 'read', view: read },
        step: 0,
        anchorAt: 0,
        runner: 'job',
        finalAttempt: false,
      });
      const tabla = plan(incierta, { kind: 'recovered', read, by: 'booking-reference' });

      if (verificacion.kind === 'consolidate') {
        expect(tabla.orderStatus).toBe('confirmed');
        expect(tabla.actions).toContain('consolidate-intent');
      } else {
        expect(verificacion.kind).toBe('hold');
        if (verificacion.kind !== 'hold') return;
        expect(tabla).toMatchObject({
          orderStatus: 'keep',
          subStatus: verificacion.subStatus,
          events: [{ type: ORDER_EVENTS.escalated, reason: verificacion.reason }],
        });
      }
    },
  );

  it('la lectura de cierre que no es una confirmada decide como la saga de reserva', () => {
    const observaciones: HotelOrderObservation[] = [
      { kind: 'book-confirmed', read: NO_ENCONTRADA },
      { kind: 'book-confirmed', read: CANCELLED },
      { kind: 'book-confirmed', read: DESCONOCIDO },
    ];
    expect(observaciones.map((o) => plan(INTENT, o)).map((p) => [p.orderStatus, p.events])).toEqual(
      [
        ['pending', [{ type: ORDER_EVENTS.escalated, reason: 'verified-not-found' }]],
        ['pending', [{ type: ORDER_EVENTS.escalated, reason: 'verified-cancelled-upstream' }]],
        ['pending', [{ type: ORDER_EVENTS.escalated, reason: 'verified-status-unexpected' }]],
      ],
    );
  });
});

describe('lo que la tabla no lista, en la cancelación y en la recuperación (04 §4.4, §7.3)', () => {
  it('un 200 sin lectura posterior, o sin encontrarla, espera a la verificación: nunca se reenvía', () => {
    for (const read of [null, NO_ENCONTRADA]) {
      expect(plan(EN_CANCELACION, { kind: 'cancel-accepted', read })).toEqual({
        orderStatus: 'pending',
        subStatus: null,
        actions: ['verify-cancellation'],
        events: [],
      });
    }
  });

  it('un 479 sin lectura es un rechazo: vuelve al estado previo y agenda la lectura (08 §9 C-05)', () => {
    for (const read of [null, NO_ENCONTRADA]) {
      expect(plan(EN_CANCELACION, { kind: 'cancel-rejected', read })).toEqual({
        orderStatus: 'prior',
        subStatus: null,
        actions: ['verify-cancellation'],
        events: [{ type: ORDER_EVENTS.cancelled, success: false }],
      });
    }
  });

  /**
   * Lo que un plan deja en la orden, para encadenarlo con la observación siguiente. `prior` es el
   * estado de antes del claim, que en estos casos es `confirmed`.
   */
  function aplicar(antes: HotelOrderSnapshot, p: ReturnType<typeof plan>): HotelOrderSnapshot {
    return {
      ...antes,
      status:
        p.orderStatus === 'keep'
          ? antes.status
          : p.orderStatus === 'prior'
            ? 'confirmed'
            : p.orderStatus,
      subStatus: p.subStatus === 'keep' ? antes.subStatus : p.subStatus,
      providerStatus: p.record?.providerStatus ?? antes.providerStatus,
    };
  }

  it.each([
    ['un 200 sin lectura', { kind: 'cancel-accepted', read: null }],
    ['un 200 que no la encuentra', { kind: 'cancel-accepted', read: NO_ENCONTRADA }],
    ['un 200 con la reserva todavía vigente', { kind: 'cancel-accepted', read: CONFIRMED }],
    ['un 200 con la cancelación en curso', { kind: 'cancel-accepted', read: EN_CURSO[2] }],
    ['un UNVERIFIED', { kind: 'cancel-unverified' }],
  ] as const)(
    'la verify-cancellation que agenda %s puede cerrar la orden cuando la ve cancelada',
    (_caso, observacion) => {
      const despues = aplicar(EN_CANCELACION, plan(EN_CANCELACION, observacion));
      expect(despues.subStatus).not.toBe('cancel-requested');

      const cierre = plan(despues, { kind: 'read', source: 'verify', read: CANCELLED });

      expect(cierre).toMatchObject({ orderStatus: 'cancelled', actions: ['stop-hcn'] });
    },
  );

  it('ningún desenlace del Cancel deja el claim `cancel-requested` en la orden', () => {
    const lecturas = [null, NO_ENCONTRADA, CONFIRMED, VOUCHERED, CANCELLED, REFUND_AWAITED];
    const raras = [DESCONOCIDO, leida('PENDING', 'Pending'), leida('FAILED', 'Failed')];
    for (const kind of ['cancel-accepted', 'cancel-rejected'] as const) {
      for (const read of [...lecturas, ...EN_CURSO, ...raras]) {
        const p = plan(EN_CANCELACION, { kind, read });
        expect(p.subStatus, `${kind} con ${read?.providerStatus ?? 'sin lectura'}`).not.toBe(
          'keep',
        );
        expect(p.subStatus).not.toBe('cancel-requested');
      }
    }
  });

  it('un 479 con la reserva ya cancelada es un éxito idempotente (04 §4.2)', () => {
    expect(plan(EN_CANCELACION, { kind: 'cancel-rejected', read: CANCELLED })).toMatchObject({
      orderStatus: 'cancelled',
      subStatus: null,
      actions: ['stop-hcn'],
    });
  });

  it('un 200 con la reserva todavía vigente sigue en curso y se verifica', () => {
    expect(plan(EN_CANCELACION, { kind: 'cancel-accepted', read: CONFIRMED })).toEqual({
      orderStatus: 'pending',
      subStatus: null,
      record: { providerStatus: 'Confirmed', refundAwaited: false },
      actions: ['verify-cancellation'],
      events: [],
    });
  });

  it.each([
    ['cancel-accepted', 'keep'],
    ['cancel-rejected', 'prior'],
  ] as const)(
    '%s con un estado desconocido o inesperado escala; la orden sigue la suerte del pedido (%s)',
    (kind, orderStatus) => {
      // Aceptada, la cancelación sigue pedida y la orden, en el `pending` del claim. Rechazada (o
      // no mandada), no abrió nada: vuelve a su estado, con la persona mirándola igual.
      expect(plan(EN_CANCELACION, { kind, read: DESCONOCIDO })).toMatchObject({
        orderStatus,
        subStatus: 'unknown',
        actions: ['human-review'],
        events: [{ type: ORDER_EVENTS.escalated, reason: 'provider-status-unknown' }],
      });
      expect(plan(EN_CANCELACION, { kind, read: leida('PENDING', 'Pending') })).toMatchObject({
        orderStatus,
        subStatus: null,
        actions: ['human-review'],
        events: [{ type: ORDER_EVENTS.escalated, reason: 'verified-status-unexpected' }],
      });
    },
  );

  it('una recuperación que no la encuentra es la fila 7', () => {
    const incierta = orden({
      status: 'pending',
      subStatus: 'create-uncertain',
      providerStatus: null,
    });
    expect(
      plan(incierta, { kind: 'recovered', read: NO_ENCONTRADA, by: 'reconciliation' }),
    ).toEqual(plan(incierta, { kind: 'recovery-not-found' }));
  });

  it('R1: la conciliación que encuentra el intent lo consolida con su propio origen', () => {
    const incierta = orden({
      status: 'pending',
      subStatus: 'create-uncertain',
      providerStatus: null,
    });
    expect(
      plan(incierta, { kind: 'recovered', read: CONFIRMED, by: 'reconciliation' }).events,
    ).toEqual([{ type: ORDER_EVENTS.verified, recoveredBy: 'reconciliation' }]);
  });
});

describe('lecturas de un proveedor que no informa todo', () => {
  it('sin el valor crudo se guarda el estado neutral; sin ninguno de los dos, UNKNOWN', () => {
    const sinCrudo: HotelBookingView = { found: true, status: 'CONFIRMED', warnings: [] };
    const sinNada: HotelBookingView = { found: true, warnings: [] };
    expect(plan(orden(), { kind: 'read', source: 'retrieve', read: sinCrudo }).record).toEqual({
      providerStatus: 'CONFIRMED',
      refundAwaited: false,
    });
    expect(plan(orden(), { kind: 'read', source: 'retrieve', read: sinNada })).toMatchObject({
      record: { providerStatus: 'UNKNOWN' },
      subStatus: 'unknown',
    });
  });

  it('un voucher sin emitir en la primera lectura avisa, sin estado anterior que citar', () => {
    const sinVoucher = leida('CONFIRMED', 'Confirmed', { voucherIssued: false });
    expect(
      plan(orden({ providerStatus: null }), { kind: 'read', source: 'retrieve', read: sinVoucher })
        .events,
    ).toEqual([
      {
        type: ORDER_EVENTS.providerStatusChanged,
        previous: null,
        current: 'Confirmed',
        voucherIssued: false,
      },
    ]);
    // Y un voucher que ya se sabía sin emitir no se vuelve a avisar como cambio.
    expect(
      plan(orden({ voucherStatus: 'false' }), {
        kind: 'read',
        source: 'retrieve',
        read: sinVoucher,
      }).events,
    ).toEqual([]);
  });
});

describe('voucher emitido', () => {
  it('se registra como el booleano del proveedor, en texto, y no es un cambio', () => {
    const conVoucher = leida('CONFIRMED', 'Vouchered', { voucherIssued: true });
    const p = plan(orden({ providerStatus: 'Vouchered', voucherStatus: null }), {
      kind: 'read',
      source: 'hcn',
      read: conVoucher,
    });
    expect(p.record).toEqual({
      providerStatus: 'Vouchered',
      voucherStatus: 'true',
      refundAwaited: false,
    });
    expect(p.events).toEqual([]);
    expect(p.actions).toEqual([]);
  });
});
