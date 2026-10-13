import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TICKET_DOCUMENT_STATUSES } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  SABRE_TICKET_STATUS_CODES,
  SABRE_TICKET_STATUS_CODE_PATTERN,
  classifySabreTicketStatus,
  sabreDocumentStatusRank,
} from './document-status';

/**
 * RF-15: el código de estado de un `FlightTicket` al vocabulario del dominio. La tabla del
 * expediente (06 §10) es el contrato de este módulo; los casos son uno por fila.
 */

describe('classifySabreTicketStatus — la tabla de 06 §10', () => {
  it.each([
    ['TE', 'TICKET', 'ISSUED'],
    ['TO', 'TICKET', 'ISSUED'],
    ['ME', 'EMD', 'ISSUED'],
    ['OV', 'TICKET', 'VOIDED'],
    ['MV', 'EMD', 'VOIDED'],
    ['TR', 'TICKET', 'REFUNDED'],
    ['MR', 'EMD', 'REFUNDED'],
  ] as const)('%s es %s %s y conserva el código', (code, kind, status) => {
    expect(classifySabreTicketStatus(code)).toEqual({ kind, status, providerStatusCode: code });
  });

  it('TO (NDC) cuenta como emitido: sin él toda orden NDC parecería sin emitir', () => {
    expect(classifySabreTicketStatus('TO').status).toBe('ISSUED');
  });

  it('un código que no está en la tabla es UNKNOWN y conserva el código para revisarlo', () => {
    // `TV` aparece sólo en el NOMBRE de un test de WF-14 cuya aserción dice `OV`: no se adivina.
    expect(classifySabreTicketStatus('TV')).toEqual({
      kind: 'TICKET',
      status: 'UNKNOWN',
      providerStatusCode: 'TV',
    });
    expect(classifySabreTicketStatus('X')).toEqual({
      kind: 'TICKET',
      status: 'UNKNOWN',
      providerStatusCode: 'X',
    });
  });

  it.each([undefined, null, 7, '', 'te', 'TEX', 'T E', 'Issued', { code: 'TE' }])(
    'sin un código con la forma del contrato (%j) es UNKNOWN y no conserva nada',
    (raw) => {
      expect(classifySabreTicketStatus(raw)).toEqual({ kind: 'TICKET', status: 'UNKNOWN' });
    },
  );

  it('la tabla está congelada y sólo produce estados del dominio', () => {
    expect(Object.isFrozen(SABRE_TICKET_STATUS_CODES)).toBe(true);
    for (const [code, entry] of Object.entries(SABRE_TICKET_STATUS_CODES)) {
      expect(SABRE_TICKET_STATUS_CODE_PATTERN.test(code), code).toBe(true);
      expect(TICKET_DOCUMENT_STATUSES).toContain(entry.status);
      expect(Object.isFrozen(entry)).toBe(true);
    }
    // El canje existe en el dominio, pero ningún código observado lo produce todavía (06 §11).
    expect(Object.values(SABRE_TICKET_STATUS_CODES).map((e) => e.status)).not.toContain(
      'EXCHANGED',
    );
  });

  it('el patrón es el de FlightTicket.ticketStatusCode en el contrato', () => {
    const spec = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'docs',
        'sabre',
        'evidence',
        'specs',
        'booking-management-v1.yml',
      ),
      'utf8',
    );
    const block = spec.slice(spec.indexOf('  FlightTicket:'), spec.indexOf('  FlightCoupon:'));
    expect(block).toMatch(/ticketStatusCode:\s+type: string\s+pattern: '\^\[A-Z\]\{1,2\}\$'/);
    expect(SABRE_TICKET_STATUS_CODE_PATTERN.source).toBe('^[A-Z]{1,2}$');
  });
});

describe('sabreDocumentStatusRank — dos observaciones del mismo documento', () => {
  it('terminal > emitido > desconocido', () => {
    for (const terminal of ['VOIDED', 'REFUNDED', 'EXCHANGED'] as const) {
      expect(sabreDocumentStatusRank(terminal)).toBeGreaterThan(sabreDocumentStatusRank('ISSUED'));
    }
    expect(sabreDocumentStatusRank('ISSUED')).toBeGreaterThan(sabreDocumentStatusRank('UNKNOWN'));
  });

  it('tiene un rango para cada estado del dominio', () => {
    for (const status of TICKET_DOCUMENT_STATUSES) {
      expect(Number.isInteger(sabreDocumentStatusRank(status)), status).toBe(true);
    }
  });
});
