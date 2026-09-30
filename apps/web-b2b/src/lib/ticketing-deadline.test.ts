import { describe, expect, it } from 'vitest';
import { describeTicketingDeadline, ticketingDeadline, ticketingState } from './ticketing-deadline';

describe('ticketingDeadline', () => {
  it('prefiere el instante con zona de Flight Check sobre el reloj de BFM', () => {
    expect(
      ticketingDeadline({
        lastTicketDate: '2026-09-30',
        lastTicketTime: '01:28',
        flightCheckPaymentTimeLimit: '2026-09-30T06:28:00.000Z',
      }),
    ).toEqual({ kind: 'instant', at: '2026-09-30T06:28:00.000Z' });
  });

  it('sin instante usa la fecha y hora de BFM tal cual, sin zona', () => {
    expect(ticketingDeadline({ lastTicketDate: '2026-09-30', lastTicketTime: '01:28' })).toEqual({
      kind: 'provider-clock',
      date: '2026-09-30',
      time: '01:28',
    });
  });

  it('un instante sin offset no se toma por instante', () => {
    expect(
      ticketingDeadline({
        flightCheckPaymentTimeLimit: '2026-09-30T01:28:00',
        lastTicketDate: 'x',
      }),
    ).toBeNull();
  });

  it('sin datos no hay plazo', () => {
    expect(ticketingDeadline(undefined)).toBeNull();
    expect(ticketingDeadline({ lastTicketDate: null })).toBeNull();
  });
});

describe('ticketingState', () => {
  const ahora = new Date('2026-09-29T13:30:00-05:00');

  it('con instante: vencido, urgente (<24 h) o con tiempo', () => {
    expect(ticketingState({ kind: 'instant', at: '2026-09-29T18:00:00.000Z' }, ahora)).toBe(
      'expired',
    );
    expect(ticketingState({ kind: 'instant', at: '2026-09-30T06:28:00.000Z' }, ahora)).toBe(
      'urgent',
    );
    expect(ticketingState({ kind: 'instant', at: '2026-10-05T06:28:00.000Z' }, ahora)).toBe('ok');
  });

  it('con el reloj de Sabre peca de temprano: 48 h de margen por la zona desconocida', () => {
    // Vendedor en Bogotá a las 23:00; el plazo puede estar en una zona que ya va por el día 1.
    const noche = new Date('2026-09-29T23:00:00-05:00');
    expect(ticketingState({ kind: 'provider-clock', date: '2026-10-01' }, noche)).toBe('urgent');
    expect(ticketingState({ kind: 'provider-clock', date: '2026-10-04' }, noche)).toBe('ok');
  });

  it('con el reloj de Sabre sólo es «vencido» cuando no puede no haberlo', () => {
    expect(ticketingState({ kind: 'provider-clock', date: '2026-09-28' }, ahora)).toBe('urgent');
    expect(ticketingState({ kind: 'provider-clock', date: '2026-09-27' }, ahora)).toBe('expired');
  });
});

describe('describeTicketingDeadline', () => {
  const ahora = new Date('2026-09-29T13:30:00-05:00');

  it('dice de dónde sale la hora y escribe la urgencia, no sólo la colorea', () => {
    const texto = describeTicketingDeadline(
      { kind: 'provider-clock', date: '2026-09-30', time: '01:28' },
      ahora,
    );
    expect(texto).toMatch(/^Urgente · Emitir antes del/);
    expect(texto).toContain('01:28');
    expect(texto).toContain('hora informada por Sabre');
  });

  it('un plazo vencido no se presenta como instrucción de emitir', () => {
    const texto = describeTicketingDeadline(
      { kind: 'instant', at: '2026-09-29T18:00:00.000Z' },
      ahora,
    );
    expect(texto).toMatch(/^Plazo de emisión vencido/);
  });

  it('en una reserva dice que es el plazo de la tarifa, no el del PNR', () => {
    expect(
      describeTicketingDeadline({ kind: 'provider-clock', date: '2026-10-20' }, ahora, {
        fromOrder: true,
      }),
    ).toMatch(/^Plazo de la tarifa: emitir antes del/);
  });
});
