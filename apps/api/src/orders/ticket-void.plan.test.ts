import type { OrderView, TicketCheckResult } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { TicketVoidNotAvailableError } from '../providers/provider.types.js';
import {
  TICKET_VOID_MESSAGES,
  TICKET_VOID_REASONS,
  persistedTicketOperation,
  publicTicketCheck,
  settleTicketVoid,
  ticketVoidAvailability,
  ticketVoidRefusal,
  voidedTicketCount,
} from './ticket-void.plan.js';

/*
 * El semáforo de la anulación (SAB-09) sin I/O: lo que el proveedor dijo, leído tal cual. Nunca un
 * cálculo propio de la ventana, nunca un «sí» donde el proveedor no lo dijo.
 */

const NOW = new Date('2026-10-13T15:00:00.000Z');

function check(parcial: Partial<TicketCheckResult> = {}): TicketCheckResult {
  return { checkedAt: '2026-10-13T14:59:58.000Z', tickets: [], cancelOffers: [], ...parcial };
}

const ticket = (voidable: 'yes' | 'no' | 'unknown', number = '0016802004060') => ({
  number,
  voidable,
  refundable: 'unknown' as const,
});

describe('ticketVoidAvailability', () => {
  it('todos los tiquetes anulables: verde, sin plazo (ATPCO no publica uno)', () => {
    expect(
      ticketVoidAvailability(
        check({ tickets: [ticket('yes'), ticket('yes', '0016802004061')] }),
        NOW,
      ),
    ).toEqual({ status: 'available' });
  });

  it('uno solo no anulable cierra la puerta: anular es todo o nada', () => {
    expect(
      ticketVoidAvailability(
        check({
          tickets: [ticket('yes'), ticket('no', '0016802004061')],
          cancelOffers: [{ offerRef: 'V1', kind: 'VOID' }],
        }),
        NOW,
      ),
    ).toEqual({ status: 'unavailable' });
  });

  it('una oferta VOID vigente abre la puerta, con su plazo tal cual', () => {
    expect(
      ticketVoidAvailability(
        check({
          cancelOffers: [
            { offerRef: 'R1', kind: 'REFUND' },
            { offerRef: 'V1', kind: 'VOID', expiresAt: '2026-10-13T23:59:00.000Z' },
          ],
        }),
        NOW,
      ),
    ).toEqual({ status: 'available', expiresAt: '2026-10-13T23:59:00.000Z' });
  });

  it('la oferta vale hasta su minuto, y después ya no', () => {
    const offer = { offerRef: 'V1', kind: 'VOID' as const, expiresAt: NOW.toISOString() };
    expect(ticketVoidAvailability(check({ cancelOffers: [offer] }), NOW).status).toBe('available');
    expect(
      ticketVoidAvailability(check({ cancelOffers: [offer] }), new Date(NOW.getTime() + 60_000)),
    ).toEqual({ status: 'unavailable' });
  });

  it('una fecha de caducidad ilegible no promete nada', () => {
    expect(
      ticketVoidAvailability(
        check({ cancelOffers: [{ offerRef: 'V1', kind: 'VOID', expiresAt: 'mañana' }] }),
        NOW,
      ),
    ).toEqual({ status: 'unavailable' });
  });

  it('una VOID sin plazo declarado sale verde y sin «hasta»', () => {
    expect(
      ticketVoidAvailability(check({ cancelOffers: [{ offerRef: 'V1', kind: 'VOID' }] }), NOW),
    ).toEqual({ status: 'available' });
  });

  it('sólo REFUND u otras formas de cancelar: rojo', () => {
    expect(
      ticketVoidAvailability(check({ cancelOffers: [{ offerRef: 'X', kind: 'OTHER' }] }), NOW),
    ).toEqual({ status: 'unavailable' });
  });

  it.each([
    ['sin tiquetes ni ofertas', check()],
    ['un tiquete sin dato', check({ tickets: [ticket('unknown')] })],
    [
      'uno sí y otro sin dato',
      check({ tickets: [ticket('yes'), ticket('unknown', '0016802004061')] }),
    ],
  ])('%s: gris, el proveedor no lo dijo', (_caso, value) => {
    expect(ticketVoidAvailability(value, NOW)).toEqual({ status: 'unknown' });
  });
});

describe('publicTicketCheck', () => {
  it('lo que sale por la API: tiquetes, semáforo y plazo, sin importes', () => {
    const result = publicTicketCheck(
      check({
        tickets: [
          {
            ...ticket('yes'),
            refundable: 'yes',
            refund: { totalMinor: 80_200, penaltyMinor: 22_200, currency: 'USD' },
          },
        ],
        cancelOffers: [{ offerRef: 'V1', kind: 'VOID', expiresAt: '2026-10-13T23:59:00.000Z' }],
      }),
      NOW,
    );

    expect(result).toEqual({
      checkedAt: '2026-10-13T14:59:58.000Z',
      tickets: [{ number: '0016802004060', voidable: 'yes', refundable: 'yes' }],
      voidAvailable: true,
      voidStatus: 'available',
      voidExpiresAt: '2026-10-13T23:59:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/totalMinor|penaltyMinor|"refund"|offerRef/);
  });

  it('un número que no es de tiquete no sale, y un instante ilegible se cambia por el de ahora', () => {
    const result = publicTicketCheck(
      check({ checkedAt: 'ayer', tickets: [ticket('no', 'ABC'), ticket('no')] }),
      NOW,
    );
    expect(result.checkedAt).toBe(NOW.toISOString());
    expect(result.tickets.map((t) => t.number)).toEqual(['0016802004060']);
    expect(result).toMatchObject({ voidAvailable: false, voidStatus: 'unavailable' });
    expect(result).not.toHaveProperty('voidExpiresAt');
  });

  it('una elegibilidad fuera del vocabulario sale como «sin dato»', () => {
    const raro = { number: '0016802004060', voidable: 'maybe', refundable: 'si' };
    const result = publicTicketCheck(
      check({ tickets: [raro as unknown as TicketCheckResult['tickets'][number]] }),
      NOW,
    );
    expect(result.tickets).toEqual([
      { number: '0016802004060', voidable: 'unknown', refundable: 'unknown' },
    ]);
  });
});

function vista(statuses: readonly ('ISSUED' | 'VOIDED' | 'UNKNOWN')[], found = true): OrderView {
  return {
    found,
    airlineLocators: [],
    warnings: [],
    documents: statuses.map((status, i) => ({
      number: `001680200406${String(i)}`,
      kind: 'TICKET' as const,
      status,
    })),
  };
}

describe('settleTicketVoid', () => {
  it('sin respuesta verificable no se mira más: UNVERIFIED', () => {
    expect(
      settleTicketVoid({ success: true, verified: false, partial: false, read: vista(['VOIDED']) }),
    ).toEqual({ outcome: 'UNVERIFIED' });
  });

  it('confirmada: VOIDED, con lo que muestra la relectura', () => {
    expect(
      settleTicketVoid({ success: true, verified: true, partial: false, read: vista(['VOIDED']) }),
    ).toMatchObject({ outcome: 'VOIDED', voidedTickets: 1 });
    expect(
      settleTicketVoid({ success: true, verified: true, partial: false, read: undefined }),
    ).toEqual({ outcome: 'VOIDED' });
  });

  it('confirmada con un EMD de servicios todavía emitido: PARTIAL, la retención no se libera (SAB-20)', () => {
    const conEmd = (status: 'ISSUED' | 'VOIDED'): OrderView => {
      const base = vista(['VOIDED']);
      return {
        ...base,
        documents: [
          ...(base.documents ?? []),
          { number: '0458800112233', kind: 'EMD' as const, status },
        ],
      };
    };
    expect(
      settleTicketVoid({ success: true, verified: true, partial: false, read: conEmd('ISSUED') }),
    ).toMatchObject({ outcome: 'PARTIAL', voidedTickets: 1 });
    expect(
      settleTicketVoid({ success: true, verified: true, partial: false, read: conEmd('VOIDED') }),
    ).toMatchObject({ outcome: 'VOIDED' });
  });

  it('declarada a medias: PARTIAL', () => {
    expect(
      settleTicketVoid({ success: false, verified: true, partial: true, read: undefined }),
    ).toEqual({ outcome: 'PARTIAL' });
  });

  it('rechazada con la reserva intacta: REJECTED', () => {
    expect(
      settleTicketVoid({ success: false, verified: true, partial: false, read: vista(['ISSUED']) }),
    ).toMatchObject({ outcome: 'REJECTED', voidedTickets: 0 });
  });

  it('rechazada con un tiquete anulado: PARTIAL; y sin relectura, UNVERIFIED', () => {
    expect(
      settleTicketVoid({
        success: false,
        verified: true,
        partial: false,
        read: vista(['ISSUED', 'VOIDED']),
      }),
    ).toMatchObject({ outcome: 'PARTIAL', voidedTickets: 1 });
    expect(
      settleTicketVoid({ success: false, verified: true, partial: false, read: undefined }),
    ).toEqual({ outcome: 'UNVERIFIED' });
  });

  it('rechazada con una relectura que no prueba la reserva intacta: UNVERIFIED, no REJECTED', () => {
    // REJECTED devuelve la reserva a emitida y deja pedir otra anulación: hay que VER los tiquetes
    // emitidos. Una lectura sin tiquetes, o con uno que no se sabe leer, no lo prueba.
    expect(
      settleTicketVoid({ success: false, verified: true, partial: false, read: vista([]) }),
    ).toMatchObject({ outcome: 'UNVERIFIED', voidedTickets: 0 });
    expect(
      settleTicketVoid({
        success: false,
        verified: true,
        partial: false,
        read: vista(['ISSUED', 'UNKNOWN']),
      }),
    ).toMatchObject({ outcome: 'UNVERIFIED' });
    const sinDocumentos: OrderView = { found: true, airlineLocators: [], warnings: [] };
    expect(
      settleTicketVoid({ success: false, verified: true, partial: false, read: sinDocumentos }),
    ).toMatchObject({ outcome: 'UNVERIFIED' });
  });
});

describe('persistedTicketOperation y voidedTicketCount', () => {
  it.each([
    [{ ticketOperation: 'VOID' }, 'VOID'],
    [JSON.stringify({ ticketOperation: 'VOID', status: 'failed' }), 'VOID'],
    [{ ticketOperation: 'REFUND' }, undefined],
    [{ status: 'failed' }, undefined],
    ['no es json', undefined],
    [null, undefined],
    [['VOID'], undefined],
  ])('%j → %s', (raw, expected) => {
    expect(persistedTicketOperation(raw)).toBe(expected);
  });

  it('cuenta tiquetes anulados de una lectura encontrada; los EMD no son tiquetes', () => {
    const view = vista(['VOIDED', 'ISSUED', 'VOIDED']);
    expect(voidedTicketCount(view)).toBe(2);
    expect(
      voidedTicketCount({
        ...view,
        documents: [{ number: '0016802004060', kind: 'EMD', status: 'VOIDED' }],
      }),
    ).toBe(0);
    expect(voidedTicketCount(vista(['VOIDED'], false))).toBe(0);
    expect(voidedTicketCount({ found: true, airlineLocators: [], warnings: [] })).toBe(0);
  });
});

describe('los rechazos de la anulación llevan su motivo máquina', () => {
  it('cada rechazo: el texto para el vendedor y un motivo con la forma que deja salir el filtro', () => {
    for (const kind of ['unverified', 'rejected', 'notSent'] as const) {
      const refusal = ticketVoidRefusal(kind);
      expect(refusal).toEqual({
        message: TICKET_VOID_MESSAGES[kind],
        reason: TICKET_VOID_REASONS[kind],
      });
      expect(refusal.reason).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
    }
  });

  it('la ventana cerrada usa el mismo vocabulario que su error', () => {
    expect(new TicketVoidNotAvailableError().reason).toBe(TICKET_VOID_REASONS.notAvailable);
  });

  it('los cuatro motivos son distintos: la pantalla decide con ellos', () => {
    const reasons = Object.values(TICKET_VOID_REASONS);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
