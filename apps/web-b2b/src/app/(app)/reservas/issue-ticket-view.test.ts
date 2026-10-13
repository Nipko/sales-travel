import { describe, expect, it } from 'vitest';
import { issueBodyOf } from '../../api/orders/[id]/issue/issue-proxy';
import type { OrderOperationView } from './cancel-retry-policy';
import {
  ISSUE_MESSAGES,
  ISSUE_POLL_EVERY_MS,
  ISSUE_POLL_FOR_MS,
  canIssueTicket,
  issueBlock,
  issueOutcomeOf,
  issuePollDecision,
  issueRequestBody,
  issueResponseOf,
  type IssuableOrder,
} from './issue-ticket-view';

/*
 * Emitir tiquetes desde Reservas (SAB-08), sin React: cuándo se ofrece, qué se manda, qué bloquea y
 * cómo se lee el desenlace en el historial. Una emisión en duda nunca se ofrece repetir.
 */

const ORDEN: IssuableOrder = {
  status: 'confirmed',
  pnr: 'ABC123',
  capabilities: {
    retrieve: true,
    cancel: true,
    pay: false,
    services: false,
    reshop: false,
    issue: true,
  },
  totalAmount: 34012,
  currency: 'USD',
};

function op(partial: Partial<OrderOperationView>): OrderOperationView {
  return {
    id: 'op-1',
    type: 'issue',
    status: 'pending',
    attempts: 1,
    last_error: null,
    created_at: '2026-10-13T12:00:00.000Z',
    retryable: false,
    outcome: null,
    reconciliationRequired: false,
    ...partial,
  };
}

describe('canIssueTicket', () => {
  it('una reserva confirmada, con localizador y con la capacidad, se puede emitir', () => {
    expect(canIssueTicket(ORDEN)).toBe(true);
  });

  it.each([
    ['pendiente', { status: 'pending' }],
    ['ya emitida', { status: 'ticketed' }],
    ['cancelada', { status: 'cancelled' }],
    ['sin localizador', { pnr: null }],
    ['sin la capacidad (LATAM, o el superadmin que no vende)', { capabilities: { issue: false } }],
    ['sin capacidades', { capabilities: undefined }],
  ] as const)('%s, no', (_caso, cambio) => {
    expect(canIssueTicket({ ...ORDEN, ...cambio })).toBe(false);
  });
});

describe('issueRequestBody', () => {
  it('manda el total y la moneda que ve el vendedor, y nada más', () => {
    expect(issueRequestBody(ORDEN)).toEqual({ expectedTotalMinor: 34012, currency: 'USD' });
  });

  it('el total llega del API como texto (BIGINT) y sale como número, que es lo que acepta el BFF', () => {
    const body = issueRequestBody({ ...ORDEN, totalAmount: '34012' });
    expect(body).toEqual({ expectedTotalMinor: 34012, currency: 'USD' });
    expect(issueBodyOf(body)).toEqual(body);
  });
});

describe('issueBlock', () => {
  it('sin emisiones anteriores, o con una fallida sin emitir, se puede pedir', () => {
    expect(issueBlock([])).toBeNull();
    expect(issueBlock([op({ status: 'failed', retryable: true })])).toBeNull();
    expect(issueBlock([op({ type: 'cancel', status: 'pending' })])).toBeNull();
  });

  it('con una en curso, en duda o ya emitida, no', () => {
    expect(issueBlock([op({ status: 'pending' })])).toBe(ISSUE_MESSAGES.pendingBlock);
    expect(issueBlock([op({ status: 'failed', reconciliationRequired: true })])).toBe(
      ISSUE_MESSAGES.unverifiedBlock,
    );
    expect(issueBlock([op({ status: 'success' })])).toBe(ISSUE_MESSAGES.issuedBlock);
  });

  it('manda la más reciente (el historial viene del más nuevo al más viejo)', () => {
    expect(
      issueBlock([
        op({ id: 'nueva', status: 'failed', retryable: true }),
        op({ id: 'vieja', status: 'failed', reconciliationRequired: true }),
      ]),
    ).toBeNull();
  });
});

describe('issueOutcomeOf', () => {
  it('pendiente mientras la operación no aparece o sigue en curso', () => {
    expect(issueOutcomeOf([], 'op-1')).toEqual({ kind: 'pending' });
    expect(issueOutcomeOf([op({})], 'op-1')).toEqual({ kind: 'pending' });
    expect(issueOutcomeOf([op({ id: 'otra', status: 'success' })], 'op-1')).toEqual({
      kind: 'pending',
    });
  });

  it('emitida: «Tiquete emitido.»', () => {
    expect(issueOutcomeOf([op({ status: 'success' })], 'op-1')).toEqual({
      kind: 'issued',
      message: 'Tiquete emitido.',
    });
  });

  it('en duda: la aerolínea no confirmó y no se vuelve a emitir', () => {
    expect(
      issueOutcomeOf([op({ status: 'failed', reconciliationRequired: true })], 'op-1'),
    ).toEqual({
      kind: 'unverified',
      message:
        'La aerolínea no confirmó la emisión. Revisamos la reserva automáticamente; no vuelvas a emitir.',
    });
  });

  it('fallida: «No se pudo emitir: {motivo}.» con el motivo del API', () => {
    expect(
      issueOutcomeOf(
        [op({ status: 'failed', last_error: 'No se pudo emitir: el precio cambió.' })],
        'op-1',
      ),
    ).toEqual({ kind: 'failed', message: 'No se pudo emitir: el precio cambió.' });
    expect(issueOutcomeOf([op({ status: 'failed', last_error: 'sin cupo.' })], 'op-1')).toEqual({
      kind: 'failed',
      message: 'No se pudo emitir: sin cupo.',
    });
    expect(issueOutcomeOf([op({ status: 'failed' })], 'op-1')).toEqual({
      kind: 'failed',
      message: 'No se pudo emitir.',
    });
  });
});

describe('issuePollDecision — cada 5 s, hasta 2 minutos', () => {
  const seguida = { operationId: 'op-1', startedAt: 1_000_000 };

  it('los plazos son los de la pantalla', () => {
    expect(ISSUE_POLL_EVERY_MS).toBe(5_000);
    expect(ISSUE_POLL_FOR_MS).toBe(120_000);
  });

  it('sigue mientras esté en curso, y cierra con el desenlace', () => {
    expect(issuePollDecision(seguida, 1_005_000, [op({})])).toEqual({ kind: 'keep' });
    expect(issuePollDecision(seguida, 1_005_000, [op({ status: 'success' })])).toEqual({
      kind: 'settled',
      outcome: { kind: 'issued', message: ISSUE_MESSAGES.issued },
    });
  });

  it('una lectura que falla no corta el seguimiento, pero el plazo corre igual', () => {
    expect(issuePollDecision(seguida, 1_005_000, null)).toEqual({ kind: 'keep' });
    expect(issuePollDecision(seguida, 1_000_000 + ISSUE_POLL_FOR_MS, null)).toEqual({
      kind: 'timeout',
      message: ISSUE_MESSAGES.stillRunning,
    });
  });

  it('pasados 2 minutos sin desenlace, queda en el historial: no se da por fallida', () => {
    expect(issuePollDecision(seguida, 1_000_000 + ISSUE_POLL_FOR_MS, [op({})])).toEqual({
      kind: 'timeout',
      message:
        'La emisión sigue en curso. Revisa el historial de la reserva en unos minutos; no la vuelvas a pedir.',
    });
  });
});

describe('issueResponseOf', () => {
  it('202 con la operación: a seguirla', () => {
    expect(issueResponseOf(202, { operationId: 'op-9', status: 'pending' })).toEqual({
      ok: true,
      operationId: 'op-9',
    });
  });

  it('un rechazo trae el mensaje del API (texto o lista)', () => {
    expect(
      issueResponseOf(409, { message: 'Ya hay una emisión en curso para esta reserva.' }),
    ).toEqual({ ok: false, message: 'Ya hay una emisión en curso para esta reserva.' });
    expect(issueResponseOf(400, { message: ['uno', 'dos'] })).toEqual({
      ok: false,
      message: 'uno. dos',
    });
    expect(issueResponseOf(503, { error: 'sin cola' })).toEqual({ ok: false, message: 'sin cola' });
  });

  it('con la forma del API ({ statusCode, error, message }) se lee el mensaje, no «Conflict»', () => {
    expect(
      issueResponseOf(409, {
        statusCode: 409,
        error: 'Conflict',
        message: 'Ya hay una emisión en curso para esta reserva.',
      }),
    ).toEqual({ ok: false, message: 'Ya hay una emisión en curso para esta reserva.' });
  });

  it('un 202 sin operación, o una respuesta sin mensaje, no se da por buena', () => {
    expect(issueResponseOf(202, {})).toEqual({ ok: false, message: ISSUE_MESSAGES.sendFailed });
    expect(issueResponseOf(500, null)).toEqual({ ok: false, message: ISSUE_MESSAGES.sendFailed });
  });
});
