import type { HotelBookingView } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { ORDER_EVENTS } from '../orders/order-events.js';
import {
  HCN_CHECK_GRACE_MS,
  HCN_EARLY_TOLERANCE_MS,
  HCN_READS,
  HCN_RETRIES,
  HCN_RETRY_EVERY_MS,
  HCN_TIERS,
  HCN_WINDOW_MS,
  decideHcnRead,
  hcnBornOutOfWindow,
  hcnCheckIn,
  hcnCheckIsCurrent,
  hcnGate,
  hcnPlan,
  hcnPlanAtWindowEntry,
  hcnSweepRetryAt,
  openHcnTracking,
  type HcnCheckIn,
  type HcnReadFacts,
} from './hcn-plan.js';
import type { HotelOrderSnapshot } from './hotel-order-state.js';

/**
 * El plan del HCN como funciones puras (docs/tbo/09 PR-5.4; 08 RF-27 CA; 04 §8.3 y §8.4). Los
 * ejemplos E1 a E4 de 04 §8.4 son tests, desde la fecha de entrada y la zona del hotel.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const utc = (iso: string): number => Date.parse(iso);

/** 04 §8.4: todas las reservas el 2026-10-01 a las 10:00 UTC. */
const RESERVA = utc('2026-10-01T10:00:00Z');

function checkIn(fecha: string, zona?: string): HcnCheckIn {
  const valor = hcnCheckIn(fecha, zona);
  if (valor === undefined) throw new Error(`fecha inválida ${fecha}`);
  return valor;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

describe('hcnPlan: los ejemplos E1 a E4 de 04 §8.4', () => {
  it.each([
    [
      'E1',
      '2026-10-02',
      'America/Bogota',
      '2026-10-02T05:00:00Z',
      19,
      'P0',
      '2026-10-01T13:00:00Z',
      ['2026-10-01T14:00:00Z', '2026-10-01T15:00:00Z', '2026-10-01T16:00:00Z'],
    ],
    [
      'E2',
      '2026-10-04',
      'America/Lima',
      '2026-10-04T05:00:00Z',
      67,
      'P2',
      '2026-10-01T16:00:00Z',
      ['2026-10-01T17:00:00Z', '2026-10-01T18:00:00Z', '2026-10-01T19:00:00Z'],
    ],
    [
      'E3',
      '2026-10-20',
      'America/Sao_Paulo',
      '2026-10-20T03:00:00Z',
      449,
      'P5',
      '2026-10-06T10:00:00Z',
      ['2026-10-06T11:00:00Z', '2026-10-06T12:00:00Z', '2026-10-06T13:00:00Z'],
    ],
  ])(
    '%s: check-in %s en %s',
    (_caso, fecha, zona, instante, horas, prioridad, primera, reintentos) => {
      const entrada = checkIn(fecha, zona);
      expect(iso(entrada.checkInAt)).toBe(instante);
      expect((entrada.checkInAt - RESERVA) / HOUR).toBe(horas);

      const plan = hcnPlan(RESERVA, entrada.checkInAt);

      expect(plan).toEqual({
        kind: 'in-window',
        priority: prioridad,
        firstCheckAt: utc(primera),
        retryAt: reintentos.map(utc),
        // PV-37: la tarea sale después de la cuarta lectura, a la hora del último reintento.
        ticketAt: utc(reintentos[2]!),
      });
    },
  );

  it('E4: check-in a 1795 h en Cartagena → fuera de ventana; entra a check-in − 720 h y lee a +120 h', () => {
    const entrada = checkIn('2026-12-15', 'America/Bogota');
    expect(iso(entrada.checkInAt)).toBe('2026-12-15T05:00:00Z');
    expect((entrada.checkInAt - RESERVA) / HOUR).toBe(1795);

    const plan = hcnPlan(RESERVA, entrada.checkInAt);

    expect(plan).toEqual({ kind: 'out-of-window', windowEntryAt: utc('2026-11-15T05:00:00Z') });
    const enVentana = hcnPlanAtWindowEntry(utc('2026-11-15T05:00:00Z'));
    expect(enVentana).toMatchObject({
      priority: 'P5',
      firstCheckAt: utc('2026-11-20T05:00:00Z'),
    });
    // Sin ticket automático para estas reservas (PV-38).
    expect(hcnBornOutOfWindow(RESERVA, entrada)).toBe(true);
    expect(hcnBornOutOfWindow(RESERVA, checkIn('2026-10-20', 'America/Sao_Paulo'))).toBe(false);
  });
});

describe('hcnPlan: la tabla de p. 43 con intervalos [a, b) (PV-35)', () => {
  it('cada límite pertenece al tramo superior, y cada tramo lee a su SLA', () => {
    const casos = [
      [-5, 'P0', 3],
      [0, 'P0', 3],
      [23.99, 'P0', 3],
      [24, 'P1', 4],
      [47.5, 'P1', 4],
      // "For a check-in in 2 days (P2), first API call should be made 6 hours after booking".
      [48, 'P2', 6],
      [72, 'P3', 12],
      [120, 'P4', 48],
      [192, 'P4+', 72],
      [336, 'P5', 120],
      [719.99, 'P5', 120],
    ] as const;

    for (const [horas, prioridad, sla] of casos) {
      const plan = hcnPlan(RESERVA, RESERVA + horas * HOUR);
      expect(plan, `W = ${horas} h`).toMatchObject({
        kind: 'in-window',
        priority: prioridad,
        firstCheckAt: RESERVA + sla * HOUR,
      });
    }
  });

  it('W = 720 h ya está fuera de ventana: el HCN sólo existe con el check-in a menos de 30 días', () => {
    expect(hcnPlan(RESERVA, RESERVA + HCN_WINDOW_MS)).toEqual({
      kind: 'out-of-window',
      windowEntryAt: RESERVA,
    });
    expect(HCN_WINDOW_MS).toBe(720 * HOUR);
  });

  it('cuatro lecturas: la del SLA y tres reintentos a una hora de la anterior (PV-37)', () => {
    expect({ HCN_RETRIES, HCN_READS, HCN_RETRY_EVERY_MS }).toEqual({
      HCN_RETRIES: 3,
      HCN_READS: 4,
      HCN_RETRY_EVERY_MS: HOUR,
    });
    expect(HCN_TIERS.map((t) => t.priority)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P4+', 'P5']);
  });
});

describe('hcnCheckIn: 00:00 del día de entrada en la hora del hotel (PV-36)', () => {
  it('sin la zona del hotel (hoy, siempre): 00:00 UTC, y el día termina en la última zona (UTC−12)', () => {
    expect(hcnCheckIn('2026-10-02')).toEqual({
      checkInAt: utc('2026-10-02T00:00:00Z'),
      endsAt: utc('2026-10-03T12:00:00Z'),
      clock: 'utc',
    });
  });

  it('con la zona, el día de entrada termina a las 00:00 locales del día siguiente', () => {
    expect(hcnCheckIn('2026-10-02', 'America/Bogota')).toEqual({
      checkInAt: utc('2026-10-02T05:00:00Z'),
      endsAt: utc('2026-10-03T05:00:00Z'),
      clock: 'hotel-time-zone',
    });
    // Una zona al este de UTC: las 00:00 locales son del día anterior en UTC.
    expect(hcnCheckIn('2026-10-02', 'Asia/Kolkata')?.checkInAt).toBe(utc('2026-10-01T18:30:00Z'));
  });

  it('un cambio de horario entre las 00:00 locales y las 00:00 UTC se corrige', () => {
    // Sídney adelanta la hora el 4/10/2026 a las 02:00 (16:00 UTC del 3/10): a las 00:00 UTC ya es
    // UTC+11, pero sus 00:00 locales todavía eran UTC+10.
    expect(iso(checkIn('2026-10-04', 'Australia/Sydney').checkInAt)).toBe('2026-10-03T14:00:00Z');
    expect(iso(checkIn('2026-10-05', 'Australia/Sydney').checkInAt)).toBe('2026-10-04T13:00:00Z');
  });

  it('una zona que no existe cae a UTC; una fecha que no es real no da check-in', () => {
    expect(hcnCheckIn('2026-10-02', 'Mar/Del_Plata')?.clock).toBe('utc');
    expect(hcnCheckIn('2026-02-31')).toBeUndefined();
    expect(hcnCheckIn('02/10/2026')).toBeUndefined();
    expect(hcnCheckIn('2026-10-02T00:00:00Z')).toBeUndefined();
  });
});

describe('openHcnTracking: el plan de una orden confirmada', () => {
  const entrada = checkIn('2026-10-04', 'America/Lima');

  it('dentro de ventana: programado a la hora del SLA, aunque ya haya pasado (sale enseguida)', () => {
    expect(openHcnTracking({ bookedAt: RESERVA, checkIn: entrada, now: RESERVA })).toEqual({
      state: 'scheduled',
      priority: 'P2',
      nextAt: RESERVA + 6 * HOUR,
    });
    expect(
      openHcnTracking({ bookedAt: RESERVA, checkIn: entrada, now: RESERVA + 10 * HOUR }),
    ).toMatchObject({ state: 'scheduled', nextAt: RESERVA + 6 * HOUR });
  });

  it('fuera de ventana: espera la entrada; si ya entró, P5 desde la entrada', () => {
    const lejos = checkIn('2026-12-15', 'America/Bogota');
    const entradaEnVentana = utc('2026-11-15T05:00:00Z');

    expect(openHcnTracking({ bookedAt: RESERVA, checkIn: lejos, now: RESERVA })).toEqual({
      state: 'out-of-window',
      priority: null,
      nextAt: entradaEnVentana,
    });
    expect(openHcnTracking({ bookedAt: RESERVA, checkIn: lejos, now: entradaEnVentana })).toEqual({
      state: 'scheduled',
      priority: 'P5',
      nextAt: entradaEnVentana + 120 * HOUR,
    });
  });

  it('con el día de entrada terminado no hay nada que seguir', () => {
    expect(openHcnTracking({ bookedAt: RESERVA, checkIn: entrada, now: entrada.endsAt })).toEqual({
      state: 'stopped',
      priority: null,
      nextAt: null,
    });
  });

  it('una reserva del mismo día de entrada es P0 y se sigue durante ese día', () => {
    const hoy = checkIn('2026-10-01');
    expect(openHcnTracking({ bookedAt: RESERVA, checkIn: hoy, now: RESERVA })).toEqual({
      state: 'scheduled',
      priority: 'P0',
      nextAt: RESERVA + 3 * HOUR,
    });
  });
});

describe('hcnGate: cuándo se corta, cuándo se espera y cuándo se lee', () => {
  const ahora = RESERVA;

  it('cancelada o fallida: se corta', () => {
    for (const status of ['cancelled', 'failed'] as const) {
      expect(hcnGate({ status, now: ahora, endsAt: undefined })).toEqual({
        kind: 'stop',
        reason: 'order-closed',
      });
    }
  });

  it('terminó el día de entrada: se corta', () => {
    expect(hcnGate({ status: 'confirmed', now: ahora, endsAt: ahora })).toEqual({
      kind: 'stop',
      reason: 'check-in-passed',
    });
  });

  it('pendiente (una cancelación en curso): se espera una hora sin leer ni gastar un intento', () => {
    expect(hcnGate({ status: 'pending', now: ahora, endsAt: ahora + DAY })).toEqual({
      kind: 'pause',
      until: ahora + HOUR,
    });
  });

  it('confirmada y en fecha: se lee; sin fecha conocida no se corta por fecha', () => {
    expect(hcnGate({ status: 'confirmed', now: ahora, endsAt: ahora + 1 })).toEqual({
      kind: 'read',
    });
    expect(hcnGate({ status: 'confirmed', now: ahora, endsAt: undefined })).toEqual({
      kind: 'read',
    });
  });
});

describe('hcnCheckIsCurrent: sólo la lectura que toca, y no antes de su hora', () => {
  const fila = { state: 'scheduled' as const, attempts: 1, nextAt: RESERVA };

  it('la del plan, a su hora o con el desfase de reloj tolerado', () => {
    expect(hcnCheckIsCurrent(fila, 1, RESERVA)).toBe(true);
    expect(hcnCheckIsCurrent(fila, 1, RESERVA - HCN_EARLY_TOLERANCE_MS)).toBe(true);
  });

  it('otra lectura, otro estado, sin hora o adelantada: no', () => {
    expect(hcnCheckIsCurrent(fila, 0, RESERVA)).toBe(false);
    expect(hcnCheckIsCurrent({ ...fila, state: 'received' }, 1, RESERVA)).toBe(false);
    expect(hcnCheckIsCurrent({ ...fila, nextAt: null }, 1, RESERVA)).toBe(false);
    expect(hcnCheckIsCurrent(fila, 1, RESERVA - HCN_EARLY_TOLERANCE_MS - 1)).toBe(false);
    expect(HCN_CHECK_GRACE_MS).toBe(15 * MIN);
  });
});

describe('decideHcnRead: qué hace el seguimiento con cada lectura', () => {
  const orden: HotelOrderSnapshot = {
    status: 'confirmed',
    subStatus: null,
    providerStatus: 'Confirmed',
    voucherStatus: 'true',
    refundAwaited: false,
    hcn: null,
    hcnState: 'scheduled',
  };

  function vista(parcial: Partial<HotelBookingView> = {}): HotelBookingView {
    return {
      found: true,
      providerBookingId: 'FL1IMA',
      status: 'CONFIRMED',
      providerStatus: 'Confirmed',
      voucherIssued: true,
      warnings: [],
      ...parcial,
    };
  }

  function hechos(parcial: Partial<HcnReadFacts>): HcnReadFacts {
    return {
      order: orden,
      read: { kind: 'read', view: vista() },
      attempt: 0,
      bornOutOfWindow: false,
      now: RESERVA,
      runner: 'job',
      finalAttempt: false,
      ...parcial,
    };
  }

  it('llegó el HCN: se recibe, con su evento y sin tocar la orden', () => {
    const d = decideHcnRead(
      hechos({ read: { kind: 'read', view: vista({ hotelConfirmationNumber: ' HCN-4711 ' }) } }),
    );

    expect(d.kind).toBe('received');
    if (d.kind !== 'received') return;
    expect(d.plan).toMatchObject({
      orderStatus: 'keep',
      hcn: { hcn: 'HCN-4711', markReceived: true },
      events: [{ type: ORDER_EVENTS.hotelConfirmationNumberReceived, hcn: 'HCN-4711' }],
    });
  });

  it('todavía sin HCN: la lectura siguiente a una hora, sin lanzar (04 §8.5)', () => {
    for (const hcn of [undefined, '', '   ']) {
      const d = decideHcnRead(
        hechos({
          attempt: 2,
          read: { kind: 'read', view: vista({ hotelConfirmationNumber: hcn }) },
        }),
      );
      expect(d).toMatchObject({ kind: 'next', at: RESERVA + HCN_RETRY_EVERY_MS });
    }
  });

  it('la cuarta lectura sin HCN agota el plan: tarea de operaciones, salvo si nació fuera de ventana (PV-38)', () => {
    expect(decideHcnRead(hechos({ attempt: HCN_READS - 1 }))).toMatchObject({
      kind: 'missing',
      reason: 'sla-exhausted',
      ticket: true,
      plan: { orderStatus: 'keep' },
    });
    expect(decideHcnRead(hechos({ attempt: HCN_READS - 1, bornOutOfWindow: true }))).toMatchObject({
      kind: 'missing',
      reason: 'sla-exhausted',
      ticket: false,
    });
  });

  it('la ve cancelada o cancelándose: se corta y avisa (R3), sin mover la orden', () => {
    for (const status of ['CANCELLED', 'CANCELLATION_IN_PROGRESS'] as const) {
      const d = decideHcnRead(
        hechos({ read: { kind: 'read', view: vista({ status, providerStatus: 'Cancelled' }) } }),
      );
      expect(d).toMatchObject({
        kind: 'stop',
        plan: {
          orderStatus: 'keep',
          events: expect.arrayContaining([
            expect.objectContaining({ type: ORDER_EVENTS.reconciliationDiscrepancy, kind: 'R3' }),
          ]) as unknown,
        },
      });
    }
  });

  it('"no la encuentro" o un estado raro no son HCN: cuentan como lectura y se escalan', () => {
    expect(
      decideHcnRead(hechos({ read: { kind: 'read', view: { found: false, warnings: [] } } })),
    ).toMatchObject({
      kind: 'next',
      plan: { events: [{ type: ORDER_EVENTS.escalated, reason: 'verified-not-found' }] },
    });
    expect(
      decideHcnRead(
        hechos({
          read: { kind: 'read', view: vista({ status: 'UNKNOWN', providerStatus: 'Raro' }) },
        }),
      ),
    ).toMatchObject({
      kind: 'next',
      plan: {
        subStatus: 'unknown',
        events: [{ type: ORDER_EVENTS.escalated, reason: 'provider-status-unknown' }],
      },
    });
  });

  it('un HCN que llega con el seguimiento cortado se guarda sin reabrirlo', () => {
    const d = decideHcnRead(
      hechos({
        order: { ...orden, hcnState: 'stopped' },
        read: { kind: 'read', view: vista({ hotelConfirmationNumber: 'HCN-1' }) },
      }),
    );
    expect(d).toMatchObject({ kind: 'next', plan: { hcn: { hcn: 'HCN-1', markReceived: false } } });
  });

  it('una lectura que no se puede hacer nunca, o con otra cuenta, agota el plan con tarea', () => {
    expect(decideHcnRead(hechos({ read: { kind: 'failed', error: 'permanent' } }))).toEqual({
      kind: 'missing',
      reason: 'read-unavailable',
      ticket: true,
    });
    expect(
      decideHcnRead(hechos({ read: { kind: 'account-changed' }, bornOutOfWindow: true })),
    ).toEqual({ kind: 'missing', reason: 'account-changed', ticket: true });
  });

  it('transporte: la cola repite mientras le queden intentos; después, queda vencida sin contar', () => {
    const transitorio = { kind: 'failed', error: 'transient' } as const;
    expect(decideHcnRead(hechos({ read: transitorio }))).toEqual({ kind: 'retry' });
    expect(decideHcnRead(hechos({ read: transitorio, finalAttempt: true }))).toEqual({
      kind: 'unavailable',
      reason: 'verification-unavailable',
      escalate: false,
    });
    expect(decideHcnRead(hechos({ read: transitorio, runner: 'sweep' }))).toEqual({
      kind: 'unavailable',
      reason: 'verification-unavailable',
      escalate: false,
    });
  });

  it('la cuenta no puede leer: queda vencida y se avisa una vez por job, no en cada barrido', () => {
    const cuenta = { kind: 'failed', error: 'account' } as const;
    expect(decideHcnRead(hechos({ read: cuenta }))).toEqual({
      kind: 'unavailable',
      reason: 'provider-account-issue',
      escalate: true,
    });
    expect(decideHcnRead(hechos({ read: cuenta, runner: 'sweep' }))).toMatchObject({
      escalate: false,
    });
  });
});

describe('hcnSweepRetryAt: una lectura del barrido que falló (HARD-2)', () => {
  // Check-in a 62 h de la reserva: P2, SLA de 6 h.
  const entrada = checkIn('2026-10-04');
  const sla = RESERVA + 6 * HOUR;

  it('se mide desde la hora que el plan le daba a esa lectura: la espera crece con la demora', () => {
    const hechos = { bookedAt: RESERVA, checkIn: entrada, attempt: 0, nextAt: sla };
    expect(hcnSweepRetryAt({ ...hechos, now: sla + 15 * MIN })).toBe(sla + 30 * MIN);
    expect(hcnSweepRetryAt({ ...hechos, nextAt: sla + 30 * MIN, now: sla + 45 * MIN })).toBe(
      sla + 90 * MIN,
    );
  });

  it('nunca espera más de una hora, la cadencia del plan', () => {
    // La lectura 2 tocaba a SLA + 2 h; tres horas tarde, la espera se queda en una.
    const now = sla + 5 * HOUR;
    expect(
      hcnSweepRetryAt({ bookedAt: RESERVA, checkIn: entrada, attempt: 2, nextAt: now, now }),
    ).toBe(now + HCN_RETRY_EVERY_MS);
  });

  it('nunca después del fin del día de entrada, cuando el seguimiento se corta', () => {
    const now = entrada.endsAt - 20 * MIN;
    expect(
      hcnSweepRetryAt({ bookedAt: RESERVA, checkIn: entrada, attempt: 3, nextAt: now, now }),
    ).toBe(entrada.endsAt);
  });

  it('un plan nacido fuera de ventana cuenta desde la entrada en ventana (PV-38)', () => {
    const lejana = checkIn('2026-12-15');
    const plan = hcnPlan(RESERVA, lejana.checkInAt);
    if (plan.kind !== 'out-of-window') throw new Error('se esperaba fuera de ventana');
    const primera = hcnPlanAtWindowEntry(plan.windowEntryAt).firstCheckAt;
    const now = primera + 20 * MIN;
    expect(
      hcnSweepRetryAt({ bookedAt: RESERVA, checkIn: lejana, attempt: 0, nextAt: primera, now }),
    ).toBe(now + 20 * MIN);
  });

  it('sin fecha de entrada legible, desde la hora programada y sin plazo', () => {
    const now = sla + 25 * MIN;
    expect(
      hcnSweepRetryAt({ bookedAt: RESERVA, checkIn: undefined, attempt: 1, nextAt: sla, now }),
    ).toBe(now + 25 * MIN);
    expect(
      hcnSweepRetryAt({ bookedAt: RESERVA, checkIn: undefined, attempt: 1, nextAt: null, now }),
    ).toBe(now + 15 * MIN);
  });
});
