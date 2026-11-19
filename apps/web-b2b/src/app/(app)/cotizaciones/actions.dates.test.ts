import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * La fecha de ida contra «hoy». El servidor corre en UTC y el vendedor en LATAM: a las 21:00 de
 * Bogotá ya es mañana en UTC, y un vuelo para esa misma noche no puede volver «anterior a hoy».
 */

const api = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ ok: true, data: { offers: [], providers: [] } })),
);
vi.mock('../../../lib/api', () => ({ api }));

const { searchFlightsAction } = await import('./actions');

function form(departureDate: string): FormData {
  const f = new FormData();
  f.set('tripType', 'oneway');
  f.set('origin', 'BOG');
  f.set('destination', 'MDE');
  f.set('departureDate', departureDate);
  f.set('adults', '1');
  return f;
}

const PREV = { ok: true, offers: [] } as unknown as Parameters<typeof searchFlightsAction>[0];
let tz: string | undefined;

beforeEach(() => {
  tz = process.env.TZ;
  process.env.TZ = 'UTC';
  vi.useFakeTimers();
  api.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = tz;
});

describe('fecha de ida y el reloj UTC del servidor', () => {
  it('a las 21:00 de Bogotá (02:00 UTC del día siguiente) acepta un vuelo para hoy', async () => {
    vi.setSystemTime(new Date('2026-11-20T02:00:00Z'));
    const res = await searchFlightsAction(PREV, form('2026-11-19'));
    expect(res.error).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('una fecha que ya pasó en todo el mundo sigue rechazada', async () => {
    vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
    const res = await searchFlightsAction(PREV, form('2026-11-18'));
    expect(res.error).toBe('La fecha de ida no puede ser anterior a hoy.');
    expect(api).not.toHaveBeenCalled();
  });
});
