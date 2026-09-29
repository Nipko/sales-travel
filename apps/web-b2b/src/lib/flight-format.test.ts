import { describe, expect, it } from 'vitest';
import { flightDate, flightTime, formatMoney } from './flight-format';

describe('flightTime y flightDate', () => {
  it('leen el reloj del aeropuerto escrito en el string, sin convertir de zona', () => {
    // 15:15 en Bogotá son las 20:15 UTC: el PDF, generado en un servidor UTC, imprimía 20:15.
    expect(flightTime('2026-10-14T15:15:00-05:00')).toBe('15:15');
    expect(flightTime('2026-10-14T23:50:00+09:00')).toBe('23:50');
  });

  it('el día no se corre aunque el instante UTC caiga en otro día', () => {
    // 23:50 del 14 en Tokio es el 14 en UTC-… cualquiera; el día del vuelo es el 14.
    expect(flightDate('2026-10-14T23:50:00+09:00', 'long')).toContain('14');
    expect(flightDate('2026-10-14T00:10:00-05:00')).toContain('14');
  });

  it('un string mal formado no inventa una hora', () => {
    expect(flightTime('mañana')).toBe('');
    expect(flightDate('mañana')).toBe('');
  });
});

describe('formatMoney', () => {
  it('COP sin centavos y USD con dos decimales', () => {
    expect(formatMoney(141_696_000, 'COP')).not.toMatch(/,\d{2}$/);
    expect(formatMoney(8_050, 'USD')).toMatch(/80,50/);
  });
});
