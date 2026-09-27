import type { HotelBookingSummary } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  RECONCILIATION_CANCEL_STUCK_MS,
  RECONCILIATION_INTENT_MIN_AGE_MS,
  RECONCILIATION_MAX_LOOKBACK_DAYS,
  addDays,
  observedStatus,
  planReconciliation,
  planReconciliationWindows,
  reconciliationDedupeKey,
  utcDay,
  windowsCoverDay,
  type ReconciliationFinding,
  type ReconciliationOrder,
  type ReconciliationWindow,
} from './reconciliation.plan.js';

/**
 * Las decisiones de la conciliación, sin I/O (docs/tbo/09 PR-5.5; 04 §9.3 y §9.4; 08 RF-28;
 * D-TBO-24 A). Tramos A y B, cruce por localizador y por referencia, R1 a R8 y, sobre todo, cuándo
 * un intent incierto puede pasar a fallido: sólo con una respuesta válida que cubra su día de
 * creación y no lo tenga.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const TENANT = '11111111-1111-4111-8111-111111111111';

/** Las ventanas de una corrida sin reservas activas viejas: sólo el tramo A. */
const TRAMO_A: ReconciliationWindow[] = [{ from: '2026-09-24', to: '2026-09-26', leg: 'A' }];
/** Tramo A más un B que cubre la última semana. */
const SEMANA: ReconciliationWindow[] = [{ from: '2026-09-18', to: '2026-09-26', leg: 'A' }];

function orden(extra: Partial<ReconciliationOrder> = {}): ReconciliationOrder {
  return {
    tenantId: TENANT,
    orderId: 'o-confirmada',
    userId: 'u1',
    status: 'confirmed',
    subStatus: null,
    providerStatus: 'Confirmed',
    refundAwaited: false,
    providerOrderId: 'GOF05R',
    bookingReference: 'STTREF000000000000001',
    createdAt: NOW - 2 * DAY,
    openIntent: false,
    verificationScheduled: false,
    cancelSince: null,
    net: { amountMinor: 58_389, currency: 'USD' },
    ...extra,
  };
}

/** Un intent incierto sin localizador, creado hace dos días y con el calendario agotado. */
function intent(extra: Partial<ReconciliationOrder> = {}): ReconciliationOrder {
  return orden({
    orderId: 'o-intent',
    status: 'pending',
    subStatus: 'create-not-found-yet',
    providerStatus: null,
    providerOrderId: null,
    bookingReference: 'STTREF000000000000002',
    createdAt: Date.parse('2026-09-24T15:00:00Z'),
    openIntent: true,
    net: null,
    ...extra,
  });
}

function fila(extra: Partial<HotelBookingSummary> = {}): HotelBookingSummary {
  return {
    providerBookingId: 'GOF05R',
    bookingDate: '2026-09-24',
    bookingReference: 'STTREF000000000000001',
    status: 'CONFIRMED',
    providerStatus: 'Confirmed',
    total: { amountMinor: 58_389, currency: 'USD' },
    agencyCommission: { amountMinor: 0, currency: 'USD' },
    currency: 'USD',
    ...extra,
  };
}

function clases(findings: readonly ReconciliationFinding[]): string[] {
  return findings.map((f) => f.kind);
}

describe('tramos A y B (04 §9.3)', () => {
  it('sin reservas activas viejas, sólo el tramo A: [D−2, D] en UTC, una llamada', () => {
    expect(planReconciliationWindows({ now: NOW, anchors: [], maxDays: 60 })).toEqual({
      windows: TRAMO_A,
      uncovered: 0,
    });
  });

  it('una reserva activa vieja estira el rango hasta su día de creación menos uno (Q-57)', () => {
    const creada = Date.parse('2026-09-10T23:30:00Z');
    const { windows } = planReconciliationWindows({ now: NOW, anchors: [creada], maxDays: 60 });

    expect(windows).toEqual([{ from: '2026-09-09', to: '2026-09-26', leg: 'A' }]);
    expect(windowsCoverDay(windows, '2026-09-10')).toBe(true);
  });

  it('un rango largo se parte en ventanas del proveedor, desde hoy hacia atrás y sin huecos', () => {
    const creada = NOW - 150 * DAY;
    const { windows } = planReconciliationWindows({ now: NOW, anchors: [creada], maxDays: 60 });

    expect(windows).toHaveLength(3);
    expect(windows[2]).toEqual({ from: addDays('2026-09-26', -59), to: '2026-09-26', leg: 'A' });
    expect(windows.map((w) => w.leg)).toEqual(['B', 'B', 'A']);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.from).toBe(addDays(windows[i - 1]!.to, 1));
    }
    expect(windows[0]!.from).toBe(addDays(utcDay(creada), -1));
    expect(windows.every((w) => addDays(w.from, 59) >= w.to)).toBe(true);
  });

  it('una reserva con check-in a un año cuesta unas 7 llamadas; más atrás no se mira y se cuenta', () => {
    const unAnio = planReconciliationWindows({ now: NOW, anchors: [NOW - 364 * DAY], maxDays: 60 });
    expect(unAnio.windows).toHaveLength(7);
    expect(unAnio.uncovered).toBe(0);

    const viejisima = planReconciliationWindows({
      now: NOW,
      anchors: [NOW - (RECONCILIATION_MAX_LOOKBACK_DAYS + 10) * DAY],
      maxDays: 60,
    });
    expect(viejisima.uncovered).toBe(1);
    expect(viejisima.windows[0]!.from).toBe(
      addDays('2026-09-26', -(RECONCILIATION_MAX_LOOKBACK_DAYS - 1)),
    );
  });

  it('un largo de ventana inválido no rompe nada: ventanas de un día', () => {
    const { windows } = planReconciliationWindows({ now: NOW, anchors: [], maxDays: 0 });
    expect(windows.map((w) => [w.from, w.to])).toEqual([
      ['2026-09-24', '2026-09-24'],
      ['2026-09-25', '2026-09-25'],
      ['2026-09-26', '2026-09-26'],
    ]);
  });

  it('la cobertura exige el día y uno a cada lado', () => {
    expect(windowsCoverDay(TRAMO_A, '2026-09-25')).toBe(true);
    expect(windowsCoverDay(TRAMO_A, '2026-09-24')).toBe(false);
    expect(windowsCoverDay(TRAMO_A, '2026-09-26')).toBe(false);
  });
});

describe('cruce y clasificación (04 §9.4)', () => {
  it('una fila consistente con su orden no produce nada', () => {
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila()],
      orders: [orden()],
    });
    expect(plan).toMatchObject({
      findings: [],
      matched: 1,
      ambiguous: 0,
      referenceEvidence: 'proven',
    });
  });

  it('R2: una fila que no cruza por ninguna clave es externa', () => {
    const externa = fila({ providerBookingId: 'ZZZ999', bookingReference: 'PORTAL-77' });
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [externa],
      orders: [],
    });

    expect(plan.findings).toEqual([{ kind: 'R2', booking: externa, severity: 'info' }]);
    expect(plan.matched).toBe(0);
  });

  it('el localizador cruza sin distinguir mayúsculas', () => {
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ providerBookingId: 'gof05r' })],
      orders: [orden()],
    });
    expect(plan.matched).toBe(1);
  });

  it('R1: un intent sin localizador cruza por nuestra referencia', () => {
    const i = intent();
    const suya = fila({ providerBookingId: 'NEW001', bookingReference: i.bookingReference! });
    const plan = planReconciliation({ now: NOW, windows: TRAMO_A, bookings: [suya], orders: [i] });

    expect(plan.findings).toEqual([{ kind: 'R1', order: i, booking: suya, severity: 'warning' }]);
    expect(plan.held).toEqual([]);
  });

  it('R3: la orden confirmada y el proveedor en la familia de cancelación', () => {
    for (const status of ['CANCELLED', 'CANCELLATION_IN_PROGRESS'] as const) {
      const plan = planReconciliation({
        now: NOW,
        windows: TRAMO_A,
        bookings: [fila({ status, providerStatus: 'Cancelled' })],
        orders: [orden()],
      });
      expect(clases(plan.findings)).toEqual(['R3']);
    }
  });

  it('R4: la orden cancelada y el proveedor la sigue teniendo viva, crítico', () => {
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila()],
      orders: [orden({ status: 'cancelled', providerStatus: 'Cancelled' })],
    });
    expect(plan.findings).toEqual([expect.objectContaining({ kind: 'R4', severity: 'critical' })]);
  });

  it('R4 también para una orden que dimos por fallida y el proveedor tiene viva', () => {
    const fallida = orden({ status: 'failed', providerOrderId: null, providerStatus: null });
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila()],
      orders: [fallida],
    });
    expect(clases(plan.findings)).toEqual(['R4']);
  });

  it('R6: el neto (BookingPrice − AgentMarkup) distinto del guardado, o la moneda, sólo se registra', () => {
    const neto = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [
        fila({
          total: { amountMinor: 60_000, currency: 'USD' },
          agencyCommission: { amountMinor: 1_000, currency: 'USD' },
        }),
      ],
      orders: [orden()],
    });
    expect(neto.findings).toEqual([
      expect.objectContaining({
        kind: 'R6',
        severity: 'info',
        price: expect.objectContaining({
          observed: 'net:USD:59000',
          providerNet: { amountMinor: 59_000, currency: 'USD' },
          storedNet: { amountMinor: 58_389, currency: 'USD' },
        }) as unknown,
      }),
    ]);

    const moneda = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ total: { amountMinor: 58_389, currency: 'EUR' } })],
      orders: [orden()],
    });
    expect(moneda.findings).toEqual([
      expect.objectContaining({
        kind: 'R6',
        price: expect.objectContaining({ observed: 'currency:EUR' }) as unknown,
      }),
    ]);
  });

  it('R6 no se calcula a ciegas: sin comisión legible o sin neto guardado', () => {
    const sinComision = fila({ total: { amountMinor: 1, currency: 'USD' } });
    const { agencyCommission: _c, ...sinCampo } = sinComision;
    expect(
      planReconciliation({ now: NOW, windows: TRAMO_A, bookings: [sinCampo], orders: [orden()] })
        .findings,
    ).toEqual([]);
    expect(
      planReconciliation({
        now: NOW,
        windows: TRAMO_A,
        bookings: [fila({ total: { amountMinor: 1, currency: 'USD' } })],
        orders: [orden({ net: null })],
      }).findings,
    ).toEqual([]);
  });

  it('R7: un estado fuera del vocabulario', () => {
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ status: 'UNKNOWN', providerStatus: 'OnHoldByHotel' })],
      orders: [orden()],
    });
    expect(clases(plan.findings)).toEqual(['R7']);
  });

  it('R7: una orden confirmada (o emitida) que el listado trae PENDING o FAILED, a leer y escalar', () => {
    for (const status of ['PENDING', 'FAILED'] as const) {
      for (const estado of ['confirmed', 'ticketed'] as const) {
        const plan = planReconciliation({
          now: NOW,
          windows: TRAMO_A,
          bookings: [fila({ status, providerStatus: status })],
          orders: [orden({ status: estado })],
        });
        // Una lectura primero (lleva la fila a leer): la clase del listado no cambia la orden sola.
        expect(plan.findings).toEqual([
          expect.objectContaining({
            kind: 'R7',
            severity: 'warning',
            booking: expect.objectContaining({ status }) as unknown,
          }),
        ]);
        expect(plan.matched).toBe(1);
      }
    }
  });

  it('una orden cerrada que el proveedor tiene PENDING puede confirmarse y cobrarse: R7; FAILED coincide', () => {
    for (const cerrada of [
      orden({ status: 'cancelled', providerStatus: 'Cancelled' }),
      orden({ status: 'failed', providerOrderId: 'GOF05R', providerStatus: null }),
    ]) {
      const pendiente = planReconciliation({
        now: NOW,
        windows: TRAMO_A,
        bookings: [fila({ status: 'PENDING', providerStatus: 'PENDING' })],
        orders: [cerrada],
      });
      expect(clases(pendiente.findings)).toEqual(['R7']);

      const fallida = planReconciliation({
        now: NOW,
        windows: TRAMO_A,
        bookings: [fila({ status: 'FAILED', providerStatus: 'FAILED' })],
        orders: [cerrada],
      });
      expect(fallida.findings).toEqual([]);
    }
  });

  it('una orden fallida con un estado fuera del vocabulario también va a R7, como la cancelada', () => {
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ status: 'UNKNOWN', providerStatus: 'OnHoldByHotel' })],
      orders: [orden({ status: 'failed', providerStatus: null })],
    });
    expect(clases(plan.findings)).toEqual(['R7']);
  });

  it('una fila sin BookingStatus (PV-28) no se compara', () => {
    const { status: _s, providerStatus: _p, ...sinEstado } = fila();
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [sinEstado],
      orders: [orden()],
    });
    expect(plan.findings).toEqual([]);
    expect(plan.matched).toBe(1);
  });

  it('R8: una cancelación nuestra en estado intermedio más de 72 h', () => {
    const enCurso = orden({
      status: 'pending',
      providerStatus: 'CxlRequestSentToHotel',
      cancelSince: NOW - RECONCILIATION_CANCEL_STUCK_MS,
    });
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [
        fila({ status: 'CANCELLATION_IN_PROGRESS', providerStatus: 'CxlRequestSentToHotel' }),
      ],
      orders: [enCurso],
    });
    expect(plan.findings).toEqual([expect.objectContaining({ kind: 'R8', severity: 'warning' })]);

    const reciente = { ...enCurso, cancelSince: NOW - RECONCILIATION_CANCEL_STUCK_MS + HOUR };
    expect(
      planReconciliation({
        now: NOW,
        windows: TRAMO_A,
        bookings: [fila({ status: 'CANCELLATION_IN_PROGRESS' })],
        orders: [reciente],
      }).findings,
    ).toEqual([]);
  });

  it('R8 mira nuestra cancelación: atascada más de 72 h, aunque el listado la traiga PENDING o FAILED', () => {
    const atascada = orden({
      status: 'pending',
      providerStatus: 'CxlRequestSentToHotel',
      cancelSince: NOW - RECONCILIATION_CANCEL_STUCK_MS,
    });
    for (const status of ['PENDING', 'FAILED'] as const) {
      const plan = planReconciliation({
        now: NOW,
        windows: TRAMO_A,
        bookings: [fila({ status, providerStatus: status })],
        orders: [atascada],
      });
      expect(clases(plan.findings)).toEqual(['R8']);

      // Sin 72 h, la verificación de la cancelación es la que la lee y la escala.
      const reciente = { ...atascada, cancelSince: NOW - HOUR };
      expect(
        planReconciliation({
          now: NOW,
          windows: TRAMO_A,
          bookings: [fila({ status, providerStatus: status })],
          orders: [reciente],
        }).findings,
      ).toEqual([]);
    }
  });

  it('una cancelación nuestra que el proveedor ya terminó se cierra sin ítem (settle)', () => {
    const enCurso = orden({ status: 'pending', providerStatus: 'CancelPending', cancelSince: NOW });
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ status: 'CANCELLED', providerStatus: 'Cancelled' })],
      orders: [enCurso],
    });
    expect(plan.findings).toEqual([expect.objectContaining({ kind: 'settle', severity: 'info' })]);
  });

  it('el reembolso que llegó (CancelledAndRefundAwaited → Cancelled) también se registra sin ítem', () => {
    const cancelada = orden({
      status: 'cancelled',
      providerStatus: 'CancelledAndRefundAwaited',
      refundAwaited: true,
    });
    const plan = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ status: 'CANCELLED', providerStatus: 'Cancelled' })],
      orders: [cancelada],
    });
    expect(clases(plan.findings)).toEqual(['settle']);
  });

  it('con el claim de cancelación en vuelo, o un proceso de creación abierto, nadie toca la orden', () => {
    for (const subStatus of ['cancel-requested', 'create-uncertain'] as const) {
      const plan = planReconciliation({
        now: NOW,
        windows: TRAMO_A,
        bookings: [fila({ status: 'CANCELLED' })],
        orders: [orden({ status: 'pending', subStatus, cancelSince: NOW - 10 * DAY })],
      });
      expect(plan.findings).toEqual([]);
    }
  });

  it('nadie actúa sobre una fila ambigua: localizador repetido, dos órdenes, o referencia con otro localizador', () => {
    const repetida = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila(), fila({ status: 'CANCELLED' })],
      orders: [orden()],
    });
    expect(repetida).toMatchObject({ findings: [], ambiguous: 2, matched: 0 });

    const dos = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ status: 'CANCELLED' })],
      orders: [orden(), orden({ orderId: 'otra', tenantId: 'otro-tenant' })],
    });
    expect(dos).toMatchObject({ findings: [], ambiguous: 1 });

    const cruzada = planReconciliation({
      now: NOW,
      windows: TRAMO_A,
      bookings: [fila({ providerBookingId: 'OTRO01', status: 'CANCELLED' })],
      orders: [orden()],
    });
    expect(cruzada).toMatchObject({ findings: [], ambiguous: 1 });
  });
});

describe('R5: un intent incierto pasa a fallido SÓLO con evidencia fuerte (D-TBO-24 A)', () => {
  /** Una reserva confirmada de la misma cuenta que prueba que ClientReferenceNumber es nuestra referencia. */
  const prueba = { orden: orden(), fila: fila() };

  function r5(
    i: ReconciliationOrder,
    opts: {
      windows?: ReconciliationWindow[];
      bookings?: HotelBookingSummary[];
      orders?: ReconciliationOrder[];
      now?: number;
    } = {},
  ) {
    return planReconciliation({
      now: opts.now ?? NOW,
      windows: opts.windows ?? SEMANA,
      bookings: opts.bookings ?? [prueba.fila],
      orders: opts.orders ?? [prueba.orden, i],
    });
  }

  it('una respuesta válida que cubre su día de creación, con un día a cada lado, y no lo tiene: R5', () => {
    const plan = r5(intent());
    expect(plan.referenceEvidence).toBe('proven');
    expect(clases(plan.findings)).toEqual(['R5']);
    expect(plan.held).toEqual([]);
  });

  it('si la respuesta lo tiene, es R1 y nunca R5', () => {
    const i = intent();
    const plan = r5(i, {
      bookings: [
        prueba.fila,
        fila({ providerBookingId: 'NEW001', bookingReference: i.bookingReference! }),
      ],
    });
    expect(clases(plan.findings)).toEqual(['R1']);
  });

  it('sin cubrir el día anterior o el siguiente al de creación, sigue bloqueado', () => {
    // Creado el 24: el tramo A empieza justo el 24 y no cubre el 23.
    const plan = r5(intent(), { windows: TRAMO_A });
    expect(plan.findings).toEqual([]);
    expect(plan.held.map((h) => [h.order.orderId, h.reason])).toEqual([
      ['o-intent', 'not-covered'],
    ]);
  });

  it('con menos de 24 h, sigue bloqueado', () => {
    const joven = intent({ createdAt: NOW - RECONCILIATION_INTENT_MIN_AGE_MS + HOUR });
    expect(r5(joven).held.map((h) => h.reason)).toEqual(['too-recent']);
  });

  it('con la verificación todavía buscándola, sigue bloqueado', () => {
    expect(r5(intent({ verificationScheduled: true })).held.map((h) => h.reason)).toEqual([
      'verification-running',
    ]);
  });

  it('si una lectura ya la vio en el proveedor, nunca pasa a fallido', () => {
    expect(r5(intent({ providerStatus: 'Cancelled' })).held.map((h) => h.reason)).toEqual([
      'seen-by-provider',
    ]);
  });

  it('sin haber visto a ClientReferenceNumber traer nuestra referencia en esta cuenta, sigue bloqueado (PV-31)', () => {
    const sinPrueba = r5(intent(), { bookings: [], orders: [intent()] });
    expect(sinPrueba.referenceEvidence).toBe('unproven');
    expect(sinPrueba.held.map((h) => h.reason)).toEqual(['reference-unproven']);

    const contradicha = r5(intent(), {
      bookings: [fila({ bookingReference: 'OTRA-COSA' })],
    });
    expect(contradicha.referenceEvidence).toBe('contradicted');
    expect(contradicha.held.map((h) => h.reason)).toEqual(['reference-contradicted']);
  });

  it('una reserva sin referencia legible y sin orden, creada cerca de ese día, podría ser la suya', () => {
    const { bookingReference: _r, ...sinReferencia } = fila({
      providerBookingId: 'ANON01',
      bookingDate: '2026-09-25',
    });
    const plan = r5(intent(), { bookings: [prueba.fila, sinReferencia] });
    expect(plan.held.map((h) => h.reason)).toEqual(['ambiguous-booking']);
    // La externa sigue yendo al reporte del dueño.
    expect(clases(plan.findings)).toEqual(['R2']);

    const lejos = { ...sinReferencia, bookingDate: '2026-09-18' };
    expect(clases(r5(intent(), { bookings: [prueba.fila, lejos] }).findings)).toEqual(['R2', 'R5']);
  });

  it('una fila ambigua (localizador repetido, p. ej. una por habitación) que trae su referencia no es ausencia', () => {
    const i = intent();
    const suya = fila({ providerBookingId: 'NEW001', bookingReference: i.bookingReference! });
    const { bookingReference: _r, ...anonima } = suya;
    const plan = r5(i, { bookings: [prueba.fila, suya, anonima] });
    expect(plan.ambiguous).toBe(2);
    expect(plan.findings).toEqual([]);
    expect(plan.held.map((h) => h.reason)).toEqual(['ambiguous-booking']);

    // Sin referencia en ninguna de las dos filas, igual podría ser la suya si es de ese día.
    const sinReferencia = r5(i, { bookings: [prueba.fila, anonima, { ...anonima }] });
    expect(sinReferencia.findings).toEqual([]);
    expect(sinReferencia.held.map((h) => h.reason)).toEqual(['ambiguous-booking']);
  });

  it('sólo los intents abiertos: una orden pending con localizador (cancelación) nunca es R5', () => {
    const cancelando = orden({ status: 'pending', providerOrderId: 'LOC999', openIntent: false });
    const plan = r5(cancelando);
    expect(plan.findings).toEqual([]);
    expect(plan.held).toEqual([]);
  });
});

describe('deduplicación (04 §9.5 punto 4)', () => {
  it('clase|sujeto|valor observado; el localizador sin distinguir mayúsculas', () => {
    expect(reconciliationDedupeKey('R3', { providerBookingId: 'gof05r' }, 'Cancelled')).toBe(
      'R3|booking:GOF05R|Cancelled',
    );
    expect(reconciliationDedupeKey('R5', { orderId: 'o1' })).toBe('R5|order:o1|');
  });

  it('el estado observado es un código del enum o `unknown`, nunca texto libre', () => {
    expect(observedStatus(fila())).toBe('Confirmed');
    expect(observedStatus(fila({ status: 'UNKNOWN', providerStatus: 'Algo raro' }))).toBe(
      'unknown',
    );
    const { status: _s, ...sinEstado } = fila();
    expect(observedStatus(sinEstado)).toBe('absent');
  });
});
