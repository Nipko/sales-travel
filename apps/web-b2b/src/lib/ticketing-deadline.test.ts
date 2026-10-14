import { describe, expect, it } from 'vitest';
import {
  DEADLINE_URGENCY_LABEL,
  deadlineUrgency,
  describeTicketingDeadline,
  ticketingDeadline,
  ticketingState,
} from './ticketing-deadline';

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

  it('el plazo de la reserva en el proveedor dice que la hora es la de la oficina emisora', () => {
    const conHora = describeTicketingDeadline(
      { kind: 'provider-clock', date: '2026-10-20', time: '23:59' },
      ahora,
      { clock: 'office' },
    );
    expect(conHora).toMatch(/^Emitir antes del /);
    expect(conHora).toContain('23:59 (hora local de la oficina emisora)');
    expect(conHora).not.toContain('Sabre');
    expect(
      describeTicketingDeadline({ kind: 'provider-clock', date: '2026-10-20' }, ahora, {
        clock: 'office',
      }),
    ).toContain('(fecha local de la oficina emisora)');
  });
});

describe('el plazo de la oficina con su zona (SAB-14)', () => {
  // 18:00 de Bogotá = 23:00 UTC = 20:00 de São Paulo.
  const plazo = {
    kind: 'instant' as const,
    at: '2026-10-14T23:00:00.000Z',
    office: { time: '18:00', timeZone: 'America/Bogota' },
  };
  const ahora = new Date('2026-10-14T15:00:00.000Z');

  it('en la hora de quien mira; la de la oficina aparte sólo si es otra', () => {
    const enBogota = describeTicketingDeadline(plazo, ahora, {
      clock: 'office',
      timeZone: 'America/Bogota',
    });
    expect(enBogota).toMatch(/^Urgente · Emitir antes del /);
    expect(enBogota).toContain('18:00');
    expect(enBogota).not.toContain('oficina emisora');

    const enSaoPaulo = describeTicketingDeadline(plazo, ahora, {
      clock: 'office',
      timeZone: 'America/Sao_Paulo',
    });
    expect(enSaoPaulo).toContain('20:00 (18:00 en la oficina emisora)');
  });

  it('deadlineUrgency: menos de 2 h, hoy, o nada', () => {
    const zona = 'America/Bogota';
    expect(deadlineUrgency(plazo, new Date('2026-10-14T21:30:00.000Z'), zona)).toBe('two-hours');
    expect(deadlineUrgency(plazo, ahora, zona)).toBe('today');
    // Las 03:30 UTC son las 22:30 de hoy en Bogotá y las 00:30 de mañana en São Paulo.
    const noche = { kind: 'instant' as const, at: '2026-10-15T03:30:00.000Z' };
    expect(deadlineUrgency(noche, ahora, 'America/Bogota')).toBe('today');
    expect(deadlineUrgency(noche, ahora, 'America/Sao_Paulo')).toBeNull();
    // Vencido o lejos: nada (el vencido lo dice el plazo mismo).
    expect(deadlineUrgency(plazo, new Date('2026-10-15T00:00:00.000Z'), zona)).toBeNull();
    expect(deadlineUrgency(plazo, new Date('2026-10-13T15:00:00.000Z'), zona)).toBeNull();
    // Con la hora de la oficina sin zona sólo se sabe el día.
    expect(
      deadlineUrgency({ kind: 'provider-clock', date: '2026-10-14', time: '18:00' }, ahora, zona),
    ).toBe('today');
    expect(deadlineUrgency({ kind: 'provider-clock', date: '2026-10-15' }, ahora, zona)).toBeNull();
  });

  it('los textos dicen el plazo, no sólo lo colorean', () => {
    expect(DEADLINE_URGENCY_LABEL).toEqual({
      'two-hours': 'Vence en menos de 2 h',
      today: 'Vence hoy',
    });
  });
});
