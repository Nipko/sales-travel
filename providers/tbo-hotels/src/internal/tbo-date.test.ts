import { describe, expect, it } from 'vitest';
import {
  isTboIsoDate,
  parseTboCancelPolicyDate,
  parseTboDayMonthNameDate,
  parseTboResponseDate,
} from './tbo-date';

describe('isTboIsoDate', () => {
  it('acepta YYYY-MM-DD de fechas que existen (CheckIn, p. 10)', () => {
    expect(isTboIsoDate('2025-11-20')).toBe(true);
    expect(isTboIsoDate('2024-02-29')).toBe(true);
    expect(isTboIsoDate('2000-02-29')).toBe(true);
  });

  it.each([
    '2023-02-29', // no bisiesto
    '1900-02-29', // divisible por 100 y no por 400
    '2025-04-31',
    '2025-13-01',
    '2025-00-10',
    '2025-01-00',
    '2025-1-01',
    '20-11-2025',
    '2025-11-20T00:00:00',
    '',
  ])('rechaza %j', (value) => {
    expect(isTboIsoDate(value)).toBe(false);
  });
});

describe('parseTboResponseDate', () => {
  it('toma la fecha de un YYYY-MM-DD o de un YYYY-MM-DDTHH:mm:ss (BookingDetail, p. 45)', () => {
    expect(parseTboResponseDate('2021-10-16')).toBe('2021-10-16');
    expect(parseTboResponseDate('2021-10-16T00:00:00')).toBe('2021-10-16');
    expect(parseTboResponseDate('2021-10-16T00:00:00.000')).toBe('2021-10-16');
  });

  it('no rescata una fecha rota como el BookingDate del ejemplo (p. 45)', () => {
    expect(parseTboResponseDate('2021-07-1317T00:00:00')).toBeUndefined();
  });

  it.each<[unknown]>([['2021-02-30'], ['2021-10-16 00:00:00'], ['16-10-2021'], [20211016], [null]])(
    '%j → undefined',
    (value) => {
      expect(parseTboResponseDate(value)).toBeUndefined();
    },
  );
});

describe('parseTboCancelPolicyDate', () => {
  it('lee DD-MM-YYYY HH:mm:ss como fecha y hora local sin offset (p. 50)', () => {
    expect(parseTboCancelPolicyDate('15-10-2021 00:00:00')).toBe('2021-10-15T00:00:00');
    expect(parseTboCancelPolicyDate('01-02-2026 23:59:59')).toBe('2026-02-01T23:59:59');
  });

  it('el resultado no lleva zona: no se inventa un offset que el contrato no da (Q-24)', () => {
    const parsed = parseTboCancelPolicyDate('15-10-2021 12:30:00');
    expect(parsed).toBe('2021-10-15T12:30:00');
    expect(parsed).not.toMatch(/Z|[+-]\d{2}:\d{2}$/);
  });

  it.each<[unknown]>([
    ['10-15-2021 00:00:00'], // orden mes-día: no hay mes 15
    ['31-04-2021 00:00:00'],
    ['15-10-2021 24:00:00'],
    ['15-10-2021 10:60:00'],
    ['15-10-2021'],
    ['2021-10-15 00:00:00'],
    ['15/10/2021 00:00:00'],
    ['5-10-2021 00:00:00'],
    [''],
    [undefined],
  ])('%j → undefined', (value) => {
    expect(parseTboCancelPolicyDate(value)).toBeUndefined();
  });
});

describe('parseTboDayMonthNameDate', () => {
  it('lee DD-MMM-YYYY con meses en inglés (BookingDetailsbasedondate, p. 64)', () => {
    expect(parseTboDayMonthNameDate('10-Nov-2023')).toBe('2023-11-10');
    expect(parseTboDayMonthNameDate('02-Dec-2023')).toBe('2023-12-02');
    expect(parseTboDayMonthNameDate('29-feb-2024')).toBe('2024-02-29');
    expect(parseTboDayMonthNameDate('01-JAN-2024')).toBe('2024-01-01');
  });

  it.each<[unknown]>([
    ['10-Nov-23'],
    ['10-November-2023'],
    ['10-Dic-2023'], // abreviatura en español: la tabla es fija en inglés
    ['29-Feb-2023'],
    ['10 Nov 2023'],
    ['2023-11-10'],
    [null],
  ])('%j → undefined', (value) => {
    expect(parseTboDayMonthNameDate(value)).toBeUndefined();
  });
});
