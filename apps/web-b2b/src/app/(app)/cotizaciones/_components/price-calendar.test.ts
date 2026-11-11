import { describe, expect, it } from 'vitest';
import { calendarCells } from './price-calendar';

const days = [
  { date: '2026-12-06', minPriceMinor: 1_162_347 },
  { date: '2026-12-07', minPriceMinor: null },
  { date: '2026-12-08', minPriceMinor: 979_800 },
  { date: '2026-12-09', minPriceMinor: 990_000 },
  { date: '2026-12-10', minPriceMinor: 987_963 },
];

describe('calendario de precios', () => {
  it('el día buscado muestra el precio REAL de la búsqueda, no el estimado', () => {
    const cells = calendarCells(days, '2026-12-09', 942_705, '2026-11-11');
    expect(cells.find((c) => c.selected)?.price).toBe(942_705);
  });

  it('marca el más barato y deja sin precio los días sin búsquedas', () => {
    const cells = calendarCells(days, '2026-12-09', 942_705, '2026-11-11');
    expect(cells.filter((c) => c.cheapest).map((c) => c.date)).toEqual(['2026-12-09']);
    expect(cells.find((c) => c.date === '2026-12-07')?.price).toBeNull();
  });

  it('los días pasados no se ofrecen ni compiten por el más barato', () => {
    const cells = calendarCells(days, '2026-12-09', 1_500_000, '2026-12-08');
    expect(cells.filter((c) => c.past).map((c) => c.date)).toEqual(['2026-12-06', '2026-12-07']);
    expect(cells.find((c) => c.cheapest)?.date).toBe('2026-12-08');
  });
});
