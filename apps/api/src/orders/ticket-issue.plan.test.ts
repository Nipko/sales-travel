import type { TicketDocument } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  ISSUE_STALE_AFTER_MS,
  ISSUE_UNVERIFIED_MESSAGE,
  auditableIssueTypes,
  decideIssue,
  formOfPaymentOf,
  issueFailureMessage,
  issueOperationPolicy,
  knownIssueWarnings,
  persistedIssueResult,
  requestedIssueResult,
  ticketCoverage,
  travelerCountOf,
} from './ticket-issue.plan.js';

/*
 * Las decisiones puras de la emisión (SAB-08). La que manda: una emisión que salió y no se sabe en
 * qué quedó nunca se reenvía; lo que no se puede leer se lee como «ya mandada, en conciliación».
 */

function doc(partial: Partial<TicketDocument> & Pick<TicketDocument, 'number'>): TicketDocument {
  return { kind: 'TICKET', status: 'ISSUED', ...partial };
}

describe('decideIssue', () => {
  it.each(['ISSUED', 'ALREADY_ISSUED'] as const)('%s cierra en ticketed', (outcome) => {
    expect(decideIssue({ outcome, warnings: [] })).toEqual({ kind: 'ticketed', outcome });
  });

  it.each([
    ['PARTIAL', true],
    ['NEEDS_HUMAN', true],
    ['UNVERIFIED', false],
  ] as const)('%s concilia; escala ya: %s', (outcome, escalateNow) => {
    expect(decideIssue({ outcome, warnings: [] })).toEqual({
      kind: 'reconcile',
      outcome,
      escalateNow,
    });
  });

  it('FAILED con el precio cambiado lo dice y manda a volver a cotizar', () => {
    expect(decideIssue({ outcome: 'FAILED', warnings: ['price-changed'] })).toEqual({
      kind: 'rejected',
      outcome: 'FAILED',
      message:
        'No se pudo emitir: el precio cambió en la aerolínea. Consulta la reserva y vuelve a cotizar antes de emitir.',
    });
  });

  it('FAILED sin más dice que la aerolínea la rechazó sin emitir', () => {
    const decision = decideIssue({ outcome: 'FAILED', warnings: ['provider-rejected'] });
    expect(decision).toMatchObject({
      kind: 'rejected',
      message: 'No se pudo emitir: la aerolínea rechazó la emisión y no se emitió ningún tiquete.',
    });
  });
});

describe('issueFailureMessage', () => {
  it('compone «No se pudo emitir: …» con el motivo en minúscula y un solo punto', () => {
    expect(issueFailureMessage('No pudimos conectar. Prueba de nuevo en unos segundos.')).toBe(
      'No se pudo emitir: no pudimos conectar. Prueba de nuevo en unos segundos.',
    );
    expect(issueFailureMessage('la reserva ya no está confirmada')).toBe(
      'No se pudo emitir: la reserva ya no está confirmada.',
    );
  });

  it('sin motivo, dice que no se emitió nada', () => {
    expect(issueFailureMessage('  ')).toBe(
      'No se pudo emitir: el proveedor no emitió ningún tiquete.',
    );
  });

  it('el aviso de una emisión en duda prohíbe reemitir, en tú', () => {
    expect(ISSUE_UNVERIFIED_MESSAGE).toContain('no vuelvas a emitir');
  });
});

describe('persistedIssueResult', () => {
  it('lee lo que escribe el servicio, también desde texto', () => {
    const requested = requestedIssueResult({
      at: new Date('2026-10-13T12:00:00Z'),
      testContent: true,
    });
    expect(persistedIssueResult(requested)).toEqual(requested);
    expect(persistedIssueResult(JSON.stringify(requested))).toEqual(requested);
    expect(requested).toMatchObject({
      stage: 'requested',
      requestedAt: '2026-10-13T12:00:00.000Z',
      testContent: true,
      retryable: false,
      reconciliationRequired: false,
    });
  });

  it.each([[null], ['{no es json'], [{ stage: 'enviada' }], [{ stage: 'requested' }], [42]])(
    'lo ilegible (%j) se lee como ya mandada y en conciliación: nunca como permiso para emitir',
    (raw) => {
      expect(persistedIssueResult(raw)).toEqual({
        stage: 'sent',
        retryable: false,
        reconciliationRequired: true,
        retryForbidden: true,
      });
    },
  );

  it('conserva campos que una versión nueva sume', () => {
    const raw = { ...requestedIssueResult({ at: new Date(), testContent: false }), extra: 1 };
    expect(persistedIssueResult(raw)).toMatchObject({ extra: 1 });
  });
});

describe('issueOperationPolicy', () => {
  const base = requestedIssueResult({ at: new Date(), testContent: false });

  it('pendiente o exitosa: ni reintento ni conciliación', () => {
    expect(issueOperationPolicy('pending', base)).toEqual({
      retryable: false,
      reconciliationRequired: false,
    });
    expect(issueOperationPolicy('success', base)).toEqual({
      retryable: false,
      reconciliationRequired: false,
    });
  });

  it('fallida sin emitir: se puede volver a pedir', () => {
    expect(issueOperationPolicy('failed', { ...base, retryable: true })).toEqual({
      retryable: true,
      reconciliationRequired: false,
    });
  });

  it('en duda: conciliación, y aunque diga reintentable, prohibido', () => {
    expect(
      issueOperationPolicy('failed', {
        ...base,
        retryable: true,
        reconciliationRequired: true,
        retryForbidden: true,
      }),
    ).toEqual({ retryable: false, reconciliationRequired: true });
  });

  it('fallida e ilegible: conciliación', () => {
    expect(issueOperationPolicy('failed', 'basura')).toEqual({
      retryable: false,
      reconciliationRequired: true,
    });
  });
});

describe('ticketCoverage', () => {
  it('completa sólo si cada pasajero tiene su tiquete emitido', () => {
    const docs = [
      doc({ number: '0451', travelerIndex: 0 }),
      doc({ number: '0452', travelerIndex: 1 }),
    ];
    expect(ticketCoverage(docs, 2)).toBe('COMPLETE');
    expect(ticketCoverage(docs, 3)).toBe('PARTIAL');
  });

  it('un tiquete sin pasajero o fuera de rango no completa nada', () => {
    expect(ticketCoverage([doc({ number: '0451' })], 1)).toBe('PARTIAL');
    expect(ticketCoverage([doc({ number: '0451', travelerIndex: 5 })], 1)).toBe('PARTIAL');
    expect(ticketCoverage([doc({ number: '0451', travelerIndex: -1 })], 1)).toBe('PARTIAL');
  });

  it('EMD, anulados y desconocidos no cuentan como tiquete emitido', () => {
    expect(
      ticketCoverage(
        [
          doc({ number: '0451', travelerIndex: 0, kind: 'EMD' }),
          doc({ number: '0452', travelerIndex: 0, status: 'VOIDED' }),
          doc({ number: '0453', travelerIndex: 0, status: 'UNKNOWN' }),
        ],
        1,
      ),
    ).toBe('NONE');
  });

  it('sin pasajeros nunca está completa', () => {
    expect(ticketCoverage([doc({ number: '0451', travelerIndex: 0 })], 0)).toBe('PARTIAL');
  });
});

describe('utilidades', () => {
  it('cuenta los pasajeros de la orden, infantes incluidos; lo que no es lista es cero', () => {
    expect(travelerCountOf([{}, {}, { paxType: 'INF' }])).toBe(3);
    expect(travelerCountOf(null)).toBe(0);
    expect(travelerCountOf({ length: 2 })).toBe(0);
  });

  it('sólo guarda avisos del vocabulario del puerto, sin repetir', () => {
    expect(knownIssueWarnings(['price-changed', 'texto libre', 'price-changed'])).toEqual([
      'price-changed',
    ]);
  });

  it('de las incidencias sólo pasan los códigos con forma de código', () => {
    expect(
      auditableIssueTypes([
        { type: 'PRICE_CHANGE' },
        { type: 'Juan Pérez' },
        { type: 'X'.repeat(80) },
      ]),
    ).toEqual(['PRICE_CHANGE']);
  });

  it('la forma de pago guardable es la del puerto, nunca una tarjeta', () => {
    expect(formOfPaymentOf('CASH')).toBe('CASH');
    expect(formOfPaymentOf('INVOICE')).toBe('INVOICE');
    expect(formOfPaymentOf('PAYMENTCARD')).toBeUndefined();
  });

  it('una emisión se da por perdida a los 10 minutos', () => {
    expect(ISSUE_STALE_AFTER_MS).toBe(600_000);
  });
});
