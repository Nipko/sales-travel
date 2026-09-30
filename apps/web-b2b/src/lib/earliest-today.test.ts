import { describe, expect, it } from 'vitest';
import { earliestTodayIso } from './earliest-today';

describe('earliestTodayIso: el piso de fechas del servidor, que corre en UTC', () => {
  it('a las 20:30 de Bogotá (01:30 UTC del día siguiente) hoy sigue siendo hoy para Bogotá', () => {
    // 2026-10-01T01:30Z = 30/09 20:30 en Bogotá. La fecha UTC ya es 01/10: con ella, una
    // entrada de hotel para esa misma noche se rechazaba.
    expect(earliestTodayIso(new Date('2026-10-01T01:30:00Z'))).toBe('2026-09-30');
  });

  it('a las 23:59 de Lima (04:59 UTC) también', () => {
    expect(earliestTodayIso(new Date('2026-10-01T04:59:00Z'))).toBe('2026-09-30');
  });

  it('a mediodía UTC ya es el día siguiente en todas partes', () => {
    expect(earliestTodayIso(new Date('2026-10-01T12:00:00Z'))).toBe('2026-10-01');
  });

  it('no depende del huso del proceso: sólo usa lecturas UTC', () => {
    const instant = new Date('2026-12-31T20:00:00Z');
    expect(earliestTodayIso(instant)).toBe('2026-12-31');
    expect(earliestTodayIso(new Date('2027-01-01T11:59:00Z'))).toBe('2026-12-31');
  });
});
