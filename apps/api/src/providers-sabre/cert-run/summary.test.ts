import { describe, expect, it } from 'vitest';
import { CertEvidenceRecorder } from './captures.js';
import { buildCertPlan } from './plan.js';
import {
  CERT_EXIT,
  buildCertSummary,
  certRunOutcome,
  renderCertSummaryMarkdown,
} from './summary.js';

describe('certRunOutcome', () => {
  it('un PNR sin limpiar gana a todo lo demás', () => {
    expect(
      certRunOutcome({
        fatal: { refused: false },
        scenarios: [{ outcome: 'failed' }],
        leftovers: [{}],
      }),
    ).toEqual({ outcome: 'leftovers', exitCode: CERT_EXIT.LEFTOVERS });
  });

  it('la guarda que se negó sale con su propio código', () => {
    expect(certRunOutcome({ fatal: { refused: true }, scenarios: [], leftovers: [] })).toEqual({
      outcome: 'refused',
      exitCode: CERT_EXIT.REFUSED,
    });
  });

  it('un escenario fallido o abortado es un fallo; todo ok es cero', () => {
    expect(certRunOutcome({ scenarios: [{ outcome: 'aborted' }], leftovers: [] }).exitCode).toBe(
      CERT_EXIT.FAILED,
    );
    expect(certRunOutcome({ scenarios: [{ outcome: 'ok' }], leftovers: [] }).exitCode).toBe(
      CERT_EXIT.OK,
    );
  });
});

describe('buildCertSummary y summary.md', () => {
  it('junta pasos, Conversation-ID y estados, y avisa si hubo que tapar un secreto conocido', () => {
    const recorder = new CertEvidenceRecorder(() => 0);
    const record = recorder.begin('book-cancel', 'createBooking');
    recorder.recordExchange({
      seq: 1,
      method: 'POST',
      url: 'https://api.cert.platform.sabre.com/v1/trip/orders/createBooking',
      startedAt: '2026-10-14T00:00:00.000Z',
      durationMs: 1200,
      conversationId: 'conv-7',
      request: { headers: {}, body: {} },
      response: { status: 200, headers: {}, body: {} },
    });
    recorder.end('ok');

    const summary = buildCertSummary({
      runId: 'r1',
      startedAt: new Date('2026-10-14T00:00:00Z'),
      finishedAt: new Date('2026-10-14T00:05:00Z'),
      plan: buildCertPlan({
        scenarios: ['book-cancel'],
        allowMoney: false,
        routes: ['BOG-LIM'],
        pax: '1ADT',
        days: 30,
      }),
      scenarios: [
        { id: 'book-cancel', forPackage: 'SAB-12', outcome: 'ok', pnr: 'ABC123', notes: [] },
      ],
      steps: recorder.steps,
      stepFiles: new Map([[record, '01-book-cancel-createbooking.json']]),
      pnrs: [{ pnr: 'ABC123', scenario: 'book-cancel', state: 'cancelled' }],
      leftovers: [],
      secretsScrubbed: 2,
      callsOutsideSteps: 0,
    });

    expect(summary.outcome).toBe('ok');
    expect(summary.steps[0]).toEqual({
      scenario: 'book-cancel',
      step: 'createBooking',
      outcome: 'ok',
      durationMs: 0,
      calls: 1,
      conversationIds: ['conv-7'],
      httpStatuses: [200],
      file: '01-book-cancel-createbooking.json',
    });
    expect(summary.warnings[0]).toMatch(/se taparon 2 apariciones/);

    const md = renderCertSummaryMarkdown(summary);
    expect(md).toContain('| book-cancel | SAB-12 | ok | ABC123 | — |');
    expect(md).toContain('conv-7');
    expect(md).toContain('Nada: ningún PNR de esta corrida quedó vivo.');
  });
});
