import { describe, expect, it } from 'vitest';
import { InvalidOverviewPeriodError } from './admin-console.errors.js';
import {
  AdminOverviewQuerySchema,
  OVERVIEW_MAX_DAYS,
  addDays,
  isCalendarDate,
  periodDays,
  resolveOverviewPeriod,
  todayIn,
  trendMonths,
} from './admin-overview.schemas.js';

/** El borde de Plataforma → Resumen: la query y el período que se lee. */

const TENANT = '7C9E6679-7425-40DE-944B-E07FC1F90AE7';

describe('AdminOverviewQuerySchema', () => {
  it('sin nada, vacía: el período lo completa el servicio', () => {
    expect(AdminOverviewQuerySchema.parse({})).toEqual({});
  });

  it('acepta el período y el nodo, con el uuid en minúsculas', () => {
    expect(
      AdminOverviewQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30', tenantId: TENANT }),
    ).toEqual({ from: '2026-09-01', to: '2026-09-30', tenantId: TENANT.toLowerCase() });
  });

  it.each([
    ['otro formato', { from: '01/09/2026' }],
    ['un día que no existe', { to: '2026-02-30' }],
    ['una fecha con hora', { from: '2026-09-01T00:00:00Z' }],
    ['un nodo que no es uuid', { tenantId: 'planetour' }],
    ['un campo de más', { currency: 'COP' }],
  ])('rechaza %s', (_caso, query) => {
    expect(AdminOverviewQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('fechas calendario', () => {
  it('isCalendarDate distingue días que existen', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('hoy')).toBe(false);
  });

  it('addDays cruza meses y años', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('periodDays cuenta los dos extremos', () => {
    expect(periodDays({ from: '2026-10-11', to: '2026-10-11' })).toBe(1);
    expect(periodDays({ from: '2026-09-12', to: '2026-10-11' })).toBe(30);
  });

  it('todayIn usa el día de la zona, no el de UTC', () => {
    // 02:00 UTC del 12 son las 21:00 del 11 en Bogotá (UTC-5).
    expect(todayIn('America/Bogota', new Date('2026-10-12T02:00:00Z'))).toBe('2026-10-11');
    expect(todayIn('UTC', new Date('2026-10-12T02:00:00Z'))).toBe('2026-10-12');
  });
});

describe('resolveOverviewPeriod', () => {
  const now = new Date('2026-10-12T02:00:00Z'); // 11 de octubre en Bogotá

  it('sin período, los últimos 30 días hasta hoy en Bogotá', () => {
    expect(resolveOverviewPeriod({}, now)).toEqual({ from: '2026-09-12', to: '2026-10-11' });
  });

  it('con un solo extremo, el otro con el mismo largo', () => {
    expect(resolveOverviewPeriod({ to: '2026-09-30' }, now)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(resolveOverviewPeriod({ from: '2026-01-01' }, now)).toEqual({
      from: '2026-01-01',
      to: '2026-01-30',
    });
  });

  it('respeta el período que piden, de un día a un año', () => {
    expect(resolveOverviewPeriod({ from: '2026-10-11', to: '2026-10-11' }, now)).toEqual({
      from: '2026-10-11',
      to: '2026-10-11',
    });
    const year = { from: '2025-10-12', to: addDays('2025-10-12', OVERVIEW_MAX_DAYS - 1) };
    expect(resolveOverviewPeriod(year, now)).toEqual(year);
  });

  it('al revés, 400 con motivo', () => {
    const error = (() => {
      try {
        return resolveOverviewPeriod({ from: '2026-10-11', to: '2026-10-01' }, now);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(InvalidOverviewPeriodError);
    expect((error as InvalidOverviewPeriodError).getStatus()).toBe(400);
    expect((error as InvalidOverviewPeriodError).reason).toBe('OVERVIEW_PERIOD_INVALID');
  });

  it('más largo que un año, 400', () => {
    expect(() =>
      resolveOverviewPeriod(
        { from: '2025-01-01', to: addDays('2025-01-01', OVERVIEW_MAX_DAYS) },
        now,
      ),
    ).toThrow(InvalidOverviewPeriodError);
  });
});

describe('trendMonths', () => {
  it('los 12 meses que terminan en el de `to`, del más viejo al más nuevo', () => {
    expect(trendMonths('2026-03-15')).toEqual([
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
  });

  it('acepta otro largo', () => {
    expect(trendMonths('2026-01-31', 2)).toEqual(['2025-12', '2026-01']);
  });
});
