import { describe, expect, it } from 'vitest';
import type { OrderOperationView } from './cancel-retry-policy';
import {
  TICKET_CONDITIONS_MESSAGES as M,
  TICKET_VOID_REASONS,
  canCheckTicketConditions,
  canVoidTickets,
  checkedAtLabel,
  parseTicketCheck,
  refundableLabel,
  ticketCheckResponseOf,
  voidBlock,
  voidConfirmMessage,
  voidResultOf,
  voidSignalOf,
  voidTicketCount,
  voidableLabel,
  type TicketCheckView,
  type TicketConditionsOrder,
} from './ticket-conditions-view';

/*
 * «Condiciones de los tiquetes» (SAB-09) sin React: el semáforo es lo que dijo el proveedor, nunca
 * un cálculo; el botón de anular sólo con verde, la capacidad y el historial limpio; y una anulación
 * en duda nunca se ofrece repetir.
 */

const TIQUETE = '0016802004060';
const OTRO = '0016802004061';

function orden(over: Partial<TicketConditionsOrder> = {}): TicketConditionsOrder {
  return {
    status: 'ticketed',
    pnr: 'ABC123',
    orderNumber: 41,
    capabilities: {
      retrieve: true,
      cancel: false,
      pay: false,
      services: false,
      reshop: false,
      issue: true,
      ticketCheck: true,
      void: true,
    },
    flightTracking: {
      airlineLocators: [],
      documents: [
        { number: TIQUETE, kind: 'TICKET', status: 'ISSUED', travelerIndex: 0 },
        { number: OTRO, kind: 'TICKET', status: 'ISSUED', travelerIndex: 1 },
        { number: '0019900000001', kind: 'EMD', status: 'ISSUED', travelerIndex: 0 },
      ],
    },
    ...over,
  };
}

const VERDE = {
  checkedAt: '2026-10-13T15:00:00.000Z',
  tickets: [{ number: TIQUETE, voidable: 'yes', refundable: 'unknown' }],
  voidAvailable: true,
  voidStatus: 'available',
};

function consulta(raw: Record<string, unknown> = {}): TicketCheckView {
  const check = parseTicketCheck({ ...VERDE, ...raw });
  if (check === null) throw new Error('consulta inválida');
  return check;
}

function op(over: Partial<OrderOperationView> = {}): OrderOperationView {
  return {
    id: 'op-1',
    type: 'cancel',
    status: 'failed',
    attempts: 1,
    last_error: null,
    created_at: '2026-10-13T14:00:00.000Z',
    retryable: false,
    outcome: 'FAILED',
    reconciliationRequired: false,
    ticketOperation: 'VOID',
    ...over,
  };
}

describe('canCheckTicketConditions', () => {
  it('una reserva emitida, con localizador y la capacidad declarada', () => {
    expect(canCheckTicketConditions(orden())).toBe(true);
  });

  it.each([
    ['confirmada', { status: 'confirmed' }],
    ['cancelada', { status: 'cancelled' }],
    ['sin localizador', { pnr: null }],
    ['con localizador vacío', { pnr: '' }],
    ['sin capacidades (un API viejo)', { capabilities: undefined }],
    ['con la consulta apagada', { capabilities: { ...orden().capabilities, ticketCheck: false } }],
  ] as const)('no se ofrece %s', (_caso, over) => {
    expect(canCheckTicketConditions(orden(over as Partial<TicketConditionsOrder>))).toBe(false);
  });
});

describe('parseTicketCheck', () => {
  it('lee la respuesta del API tal cual', () => {
    expect(consulta({ voidExpiresAt: '2026-10-13T23:59:00.000Z' })).toEqual({
      checkedAt: VERDE.checkedAt,
      tickets: [{ number: TIQUETE, voidable: 'yes', refundable: 'unknown' }],
      voidAvailable: true,
      voidStatus: 'available',
      voidExpiresAt: '2026-10-13T23:59:00.000Z',
    });
  });

  it.each([
    ['sin hora de consulta', { checkedAt: undefined }],
    ['con una hora ilegible', { checkedAt: 'ayer' }],
    ['sin lista de tiquetes', { tickets: 'muchos' }],
    ['sin voidAvailable', { voidAvailable: 'sí' }],
  ])('sin la forma esperada (%s) no hay semáforo', (_caso, raw) => {
    expect(parseTicketCheck({ ...VERDE, ...raw })).toBeNull();
  });

  it('nada que no sea un objeto', () => {
    for (const raw of [null, 'texto', [VERDE], 3]) expect(parseTicketCheck(raw)).toBeNull();
  });

  it('un tiquete sin forma de número no sale, y lo que no se entiende es «sin dato»', () => {
    const check = consulta({
      tickets: [
        { number: 'ABC', voidable: 'yes', refundable: 'yes' },
        { number: TIQUETE, voidable: 'quizás', refundable: 'no' },
      ],
    });
    expect(check.tickets).toEqual([{ number: TIQUETE, voidable: 'unknown', refundable: 'no' }]);
  });

  it('las dos señales tienen que coincidir para el verde; si no, gris y sin botón', () => {
    const discrepa = consulta({ voidAvailable: false, voidStatus: 'available' });
    expect(discrepa).toMatchObject({ voidAvailable: false, voidStatus: 'unknown' });

    const rojo = consulta({ voidAvailable: true, voidStatus: 'unavailable' });
    expect(rojo).toMatchObject({ voidAvailable: false, voidStatus: 'unavailable' });
  });

  it('un API sin voidStatus: verde sólo con voidAvailable, y si no, gris (nunca rojo inventado)', () => {
    expect(consulta({ voidStatus: undefined })).toMatchObject({ voidStatus: 'available' });
    expect(consulta({ voidStatus: undefined, voidAvailable: false })).toMatchObject({
      voidStatus: 'unknown',
      voidAvailable: false,
    });
  });

  it('un plazo ilegible se descarta: nunca se promete una hora que no se entiende', () => {
    expect(consulta({ voidExpiresAt: 'pronto' }).voidExpiresAt).toBeUndefined();
  });
});

describe('el semáforo (voidSignalOf)', () => {
  it('verde con el plazo del proveedor en la hora local de quien mira', () => {
    const check = consulta({ voidExpiresAt: '2026-10-14T04:59:00.000Z' });
    expect(voidSignalOf(check, 'America/Bogota')).toEqual({
      tone: 'ok',
      label: 'Se puede anular sin costo',
      until: 'hasta 13 oct 2026, 23:59',
    });
    expect(voidSignalOf(check, 'America/Sao_Paulo').until).toBe('hasta 14 oct 2026, 01:59');
  });

  it('verde sin plazo cuando el proveedor no lo da: no se calcula ninguno', () => {
    expect(voidSignalOf(consulta(), 'UTC')).toEqual({
      tone: 'ok',
      label: 'Se puede anular sin costo',
    });
  });

  it('rojo cuando el proveedor dice que ya no', () => {
    expect(
      voidSignalOf(consulta({ voidStatus: 'unavailable', voidAvailable: false }), 'UTC'),
    ).toEqual({ tone: 'danger', label: 'Ya no se puede anular' });
  });

  it('gris cuando el proveedor no lo informó', () => {
    expect(voidSignalOf(consulta({ voidStatus: 'unknown', voidAvailable: false }), 'UTC')).toEqual({
      tone: 'muted',
      label: 'La aerolínea no informó si se puede anular',
    });
  });

  it('la hora de la consulta acompaña al semáforo', () => {
    expect(checkedAtLabel(consulta(), 'America/Bogota')).toBe('Consultado el 13 oct 2026, 10:00');
  });

  it('cada tiquete dice si es anulable y reembolsable, o que no hay dato', () => {
    expect(voidableLabel('yes')).toBe('Anulable');
    expect(voidableLabel('no')).toBe('No anulable');
    expect(voidableLabel('unknown')).toBe('Anulación sin dato');
    expect(refundableLabel('yes')).toBe('Reembolsable');
    expect(refundableLabel('no')).toBe('No reembolsable');
    expect(refundableLabel('unknown')).toBe('Reembolso sin dato');
  });
});

describe('voidBlock: la misma compuerta del API', () => {
  it('sin cancelaciones previas, nada bloquea', () => {
    expect(voidBlock([])).toBeNull();
    expect(voidBlock([op({ type: 'issue', status: 'pending' })])).toBeNull();
  });

  it('una en curso, una en duda o una exitosa bloquean', () => {
    expect(voidBlock([op({ status: 'pending', outcome: null })])).toBe(M.pendingBlock);
    expect(
      voidBlock([op({ status: 'failed', outcome: 'UNVERIFIED', reconciliationRequired: true })]),
    ).toBe(M.unverifiedBlock);
    expect(voidBlock([op({ status: 'success', outcome: 'SUCCEEDED' })])).toBe(M.cancelledBlock);
  });

  it('una que falló sin nada que conciliar no bloquea: la nueva trae su propia consulta', () => {
    expect(voidBlock([op()])).toBeNull();
  });

  it('manda la más reciente (el API las devuelve de la más nueva a la más vieja)', () => {
    expect(
      voidBlock([op({ id: 'nueva' }), op({ id: 'vieja', status: 'pending', outcome: null })]),
    ).toBeNull();
  });
});

describe('canVoidTickets', () => {
  it('con la consulta en verde, la capacidad y el historial limpio', () => {
    expect(canVoidTickets(orden(), consulta(), [])).toBe(true);
  });

  it('sin consulta, con rojo o gris no se ofrece', () => {
    expect(canVoidTickets(orden(), null, [])).toBe(false);
    expect(
      canVoidTickets(orden(), consulta({ voidStatus: 'unavailable', voidAvailable: false }), []),
    ).toBe(false);
    expect(
      canVoidTickets(orden(), consulta({ voidStatus: 'unknown', voidAvailable: false }), []),
    ).toBe(false);
  });

  it('sin la capacidad `void` (o con la reserva ya no emitida) no se ofrece', () => {
    expect(
      canVoidTickets(
        orden({ capabilities: { ...orden().capabilities, void: false } }),
        consulta(),
        [],
      ),
    ).toBe(false);
    expect(canVoidTickets(orden({ status: 'cancelled' }), consulta(), [])).toBe(false);
  });

  it('con otra cancelación en curso no se ofrece', () => {
    expect(canVoidTickets(orden(), consulta(), [op({ status: 'pending', outcome: null })])).toBe(
      false,
    );
  });
});

describe('la confirmación dice cuántos tiquetes', () => {
  it('los de la consulta', () => {
    expect(voidTicketCount(orden(), consulta())).toBe(1);
  });

  it('si el proveedor contesta por oferta (sin tiquetes), los emitidos guardados, sin EMD', () => {
    expect(voidTicketCount(orden(), consulta({ tickets: [] }))).toBe(2);
  });

  it('sin tiquetes en ninguna parte, no se inventa un número', () => {
    expect(voidTicketCount(orden({ flightTracking: undefined }), consulta({ tickets: [] }))).toBe(
      null,
    );
  });

  it('el texto exacto', () => {
    expect(voidConfirmMessage(2, 41)).toBe(
      'Anular los tiquetes cancela la reserva y libera los asientos. No se cobra penalidad. ¿Anular los 2 tiquetes de la reserva #41?',
    );
    expect(voidConfirmMessage(1, 41)).toMatch(/¿Anular el tiquete de la reserva #41\?$/);
    expect(voidConfirmMessage(null, 41)).toMatch(/¿Anular los tiquetes de la reserva #41\?$/);
  });
});

describe('ticketCheckResponseOf', () => {
  it('un 200 con forma es la consulta', () => {
    expect(ticketCheckResponseOf(200, VERDE)).toEqual({ ok: true, check: consulta() });
  });

  it('un 200 sin forma no inventa semáforo', () => {
    expect(ticketCheckResponseOf(200, { tickets: [] })).toEqual({
      ok: false,
      message: M.checkFailed,
    });
  });

  it('un rechazo trae el texto del API; sin texto, el genérico', () => {
    expect(
      ticketCheckResponseOf(409, {
        message: 'Las condiciones de los tiquetes sólo se consultan en una reserva emitida.',
      }),
    ).toEqual({
      ok: false,
      message: 'Las condiciones de los tiquetes sólo se consultan en una reserva emitida.',
    });
    expect(ticketCheckResponseOf(502, null)).toEqual({ ok: false, message: M.checkFailed });
  });
});

describe('voidResultOf: en qué quedó la anulación', () => {
  it('anulada', () => {
    expect(voidResultOf(200, { outcome: 'VOIDED', orderStatus: 'cancelled' })).toEqual({
      kind: 'voided',
      message: 'Tiquetes anulados. La reserva quedó cancelada.',
    });
  });

  it('a medias o sin confirmar: se concilia y no se repite', () => {
    for (const outcome of ['PARTIAL', 'UNVERIFIED']) {
      expect(voidResultOf(200, { outcome, orderStatus: 'pending' })).toEqual({
        kind: 'unverified',
        message:
          'No pudimos confirmar la anulación. No reintentes: revisamos la reserva con el proveedor.',
      });
    }
  });

  it('un 409 «quedó en duda» se lee por su motivo, no por el texto', () => {
    expect(
      voidResultOf(409, { message: 'otro texto', reason: TICKET_VOID_REASONS.unverified }),
    ).toEqual({ kind: 'unverified', message: M.unverified });
  });

  it('la ventana cerrada, el rechazo de la aerolínea o lo que no salió: no se anuló nada', () => {
    const casos = [
      [409, TICKET_VOID_REASONS.notAvailable, 'La aerolínea ya no permite anular estos tiquetes.'],
      [409, TICKET_VOID_REASONS.rejected, 'La aerolínea rechazó la anulación.'],
      [503, TICKET_VOID_REASONS.notSent, 'No se anuló nada: vuelve a intentarlo.'],
    ] as const;
    for (const [status, reason, message] of casos) {
      expect(voidResultOf(status, { statusCode: status, message, reason })).toEqual({
        kind: 'failed',
        message,
      });
    }
  });

  it('un rechazo del API antes de anular trae su texto', () => {
    expect(
      voidResultOf(409, { message: 'Ya hay una cancelación pendiente.', error: 'Conflict' }),
    ).toEqual({ kind: 'failed', message: 'Ya hay una cancelación pendiente.' });
    expect(voidResultOf(403, null)).toEqual({ kind: 'failed', message: M.voidFailed });
  });

  it('un 5xx sin motivo, un 200 sin desenlace o nada legible: no se sabe si salió', () => {
    for (const [status, data] of [
      [502, { message: 'No pudimos conectar con el servidor. Inténtalo de nuevo.' }],
      [504, null],
      [200, { algo: 1 }],
      [200, null],
      [0, null],
    ] as const) {
      expect(voidResultOf(status, data)).toEqual({ kind: 'unverified', message: M.sendUnknown });
    }
  });
});
