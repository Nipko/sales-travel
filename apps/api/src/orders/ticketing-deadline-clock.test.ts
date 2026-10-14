import { describe, expect, it } from 'vitest';
import {
  countryTimeZone,
  dayLabel,
  instantOfWallClock,
  isIanaTimeZone,
  offsetLabel,
  wallClockIn,
} from './ticketing-deadline-clock.js';

/*
 * Los relojes del plazo de emisión (SAB-14): de la hora de la oficina a un instante UTC, y de vuelta
 * a la hora de una zona. Todo por `Intl`, sin tablas de husos propias.
 */

describe('isIanaTimeZone', () => {
  it('acepta las zonas que el motor conoce y la forma del CHECK de 0084', () => {
    for (const zona of [
      'America/Bogota',
      'America/Argentina/Buenos_Aires',
      'UTC',
      'Etc/GMT+5',
      'America/Sao_Paulo',
    ]) {
      expect(isIanaTimeZone(zona), zona).toBe(true);
    }
  });

  it('rechaza lo que no es una zona, lo que el motor no conoce y lo que no es texto', () => {
    for (const valor of [
      'Marte/Olympus',
      'America/Bogota; DROP TABLE',
      '../etc/passwd',
      '',
      'x'.repeat(65),
      '-05:00',
      null,
      undefined,
      42,
    ]) {
      expect(isIanaTimeZone(valor), String(valor)).toBe(false);
    }
  });
});

describe('instantOfWallClock — la hora de la oficina como instante', () => {
  it('Bogotá (UTC-5, sin horario de verano)', () => {
    expect(instantOfWallClock('2026-10-20', '18:00', 'America/Bogota')).toEqual(
      new Date('2026-10-20T23:00:00.000Z'),
    );
  });

  it('cruza el día: las 22:00 de Lima son las 03:00 UTC del día siguiente', () => {
    expect(instantOfWallClock('2026-10-20', '22:00', 'America/Lima')).toEqual(
      new Date('2026-10-21T03:00:00.000Z'),
    );
  });

  it('con horario de verano usa el desfase de ese día', () => {
    // Nueva York: EDT (UTC-4) en julio, EST (UTC-5) en diciembre.
    expect(instantOfWallClock('2026-07-01', '12:00', 'America/New_York')).toEqual(
      new Date('2026-07-01T16:00:00.000Z'),
    );
    expect(instantOfWallClock('2026-12-01', '12:00', 'America/New_York')).toEqual(
      new Date('2026-12-01T17:00:00.000Z'),
    );
  });

  it('una hora que no existe (el salto del verano) cae una hora antes, al oeste y al este', () => {
    // 2026-03-08 02:30 no existe en Nueva York: a las 02:00 EST se pasa a las 03:00 EDT. Antes es
    // las 01:30 EST (06:30Z); después serían las 03:30 EDT (07:30Z).
    expect(instantOfWallClock('2026-03-08', '02:30', 'America/New_York')).toEqual(
      new Date('2026-03-08T06:30:00.000Z'),
    );
    // Chile salta a medianoche: el 6 de septiembre de 2026 no tiene 00:30.
    expect(instantOfWallClock('2026-09-06', '00:30', 'America/Santiago')).toEqual(
      new Date('2026-09-06T03:30:00.000Z'),
    );
    // Brasil tuvo horario de verano hasta 2019, también a medianoche.
    expect(instantOfWallClock('2018-11-04', '00:30', 'America/Sao_Paulo')).toEqual(
      new Date('2018-11-04T02:30:00.000Z'),
    );
    // Una oficina al este de Greenwich: en Madrid 02:30 del 29-03 no existe; antes es 01:30 CET.
    expect(instantOfWallClock('2026-03-29', '02:30', 'Europe/Madrid')).toEqual(
      new Date('2026-03-29T00:30:00.000Z'),
    );
  });

  it('una hora que existe dos veces (el regreso del verano) es la primera', () => {
    // Nueva York, 2026-11-01 01:30: primero EDT (05:30Z), después EST (06:30Z).
    expect(instantOfWallClock('2026-11-01', '01:30', 'America/New_York')).toEqual(
      new Date('2026-11-01T05:30:00.000Z'),
    );
    // Chile, 2026-04-04 23:30: primero UTC-3 (02:30Z), después UTC-4 (03:30Z).
    expect(instantOfWallClock('2026-04-04', '23:30', 'America/Santiago')).toEqual(
      new Date('2026-04-05T02:30:00.000Z'),
    );
    // Madrid, 2026-10-25 02:30: primero CEST (00:30Z), después CET (01:30Z).
    expect(instantOfWallClock('2026-10-25', '02:30', 'Europe/Madrid')).toEqual(
      new Date('2026-10-25T00:30:00.000Z'),
    );
  });

  it('ida y vuelta: el instante vuelve a la misma hora de pared', () => {
    const at = instantOfWallClock('2026-10-20', '06:45', 'America/Sao_Paulo');
    expect(at).toBeDefined();
    expect(wallClockIn(at!, 'America/Sao_Paulo')).toEqual({ date: '2026-10-20', time: '06:45' });
  });

  it('lo que no se entiende no tiene instante', () => {
    expect(instantOfWallClock('2026-10-20', '18:00', 'Marte/Olympus')).toBeUndefined();
    expect(instantOfWallClock('20-10-2026', '18:00', 'America/Bogota')).toBeUndefined();
    expect(instantOfWallClock('2026-10-20', '24:00', 'America/Bogota')).toBeUndefined();
  });
});

describe('wallClockIn', () => {
  it('un instante en la hora de cada zona', () => {
    const at = new Date('2026-10-21T03:30:00.000Z');
    expect(wallClockIn(at, 'America/Bogota')).toEqual({ date: '2026-10-20', time: '22:30' });
    expect(wallClockIn(at, 'America/Sao_Paulo')).toEqual({ date: '2026-10-21', time: '00:30' });
    expect(wallClockIn(at, 'UTC')).toEqual({ date: '2026-10-21', time: '03:30' });
  });

  it('sin zona válida o con un instante inválido, nada', () => {
    expect(wallClockIn(new Date(), 'Marte/Olympus')).toBeUndefined();
    expect(wallClockIn(new Date(Number.NaN), 'UTC')).toBeUndefined();
  });
});

describe('countryTimeZone, offsetLabel y dayLabel', () => {
  it('la zona de la agencia por su país; un país fuera de la red no tiene', () => {
    expect(countryTimeZone('CO')).toBe('America/Bogota');
    expect(countryTimeZone(' pe ')).toBe('America/Lima');
    expect(countryTimeZone('BR')).toBe('America/Sao_Paulo');
    expect(countryTimeZone('JP')).toBeUndefined();
    expect(countryTimeZone(null)).toBeUndefined();
    expect(countryTimeZone(undefined)).toBeUndefined();
  });

  it('el desfase como lo escribe Intl, y la zona tal cual si no se puede', () => {
    const at = new Date('2026-10-20T23:00:00.000Z');
    expect(offsetLabel(at, 'America/Bogota')).toBe('GMT-5');
    expect(offsetLabel(at, 'America/Sao_Paulo')).toBe('GMT-3');
    expect(offsetLabel(at, 'UTC')).toBe('GMT');
    expect(offsetLabel(at, 'Marte/Olympus')).toBe('Marte/Olympus');
  });

  it('el día sin coma ni puntos, y lo que no es fecha tal cual', () => {
    expect(dayLabel('2026-10-15')).toBe('jue 15 oct');
    expect(dayLabel('mañana')).toBe('mañana');
  });
});
