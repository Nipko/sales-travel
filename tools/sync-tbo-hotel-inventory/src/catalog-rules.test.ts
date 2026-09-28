import { describe, expect, it } from 'vitest';
import {
  cityStats,
  isSweepAnomaly,
  median,
  normalizeName,
  selectDueCities,
  sweepVerdict,
  type CityCandidate,
} from './catalog-rules.js';
import type { CityCadence } from './env.js';

describe('normalizeName (name_norm de 0041)', () => {
  it('minúsculas, sin acentos ni puntuación, espacios colapsados', () => {
    expect(normalizeName('São Paulo')).toBe('sao paulo');
    expect(normalizeName('  Bogotá, D.C. ')).toBe('bogota d c');
    expect(normalizeName("N'Djamena")).toBe('n djamena');
    expect(normalizeName('Abtenau')).toBe('abtenau');
  });
});

describe('median y centroide (05 §7.3: mediana, no promedio)', () => {
  it('impar, par y vacío', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('una coordenada absurda no mueve el centroide', () => {
    const stats = cityStats([
      { latitude: 4.6, longitude: -74.08 },
      { latitude: 4.61, longitude: -74.07 },
      { latitude: 4.62, longitude: -74.06 },
      { latitude: 89, longitude: 170 },
      { latitude: null, longitude: null },
    ]);
    expect(stats.hotelCount).toBe(5);
    expect(stats.centroid?.lat).toBeCloseTo(4.615, 10);
    expect(stats.centroid?.lng).toBeCloseTo(-74.065, 10);
  });

  it('sin hoteles con coordenadas no hay centroide', () => {
    expect(cityStats([{ latitude: null, longitude: null }])).toEqual({
      hotelCount: 1,
      centroid: null,
    });
    expect(cityStats([])).toEqual({ hotelCount: 0, centroid: null });
  });
});

describe('sweepVerdict: la guarda de caída máxima (05 §6.5; 08 RF-30 CA 2)', () => {
  const base = { previouslyActive: 10, missing: 0, received: 10, unreadable: 0, maxDrop: 0.5 };

  it('barre cuando lo que falta está dentro del umbral', () => {
    expect(sweepVerdict({ ...base, missing: 5, received: 5 })).toBe('swept');
    expect(sweepVerdict({ ...base, missing: 1, received: 12 })).toBe('swept');
  });

  it('no barre si pierde MÁS que el umbral, y eso es anomalía', () => {
    const verdict = sweepVerdict({ ...base, missing: 6, received: 4 });
    expect(verdict).toBe('drop-exceeded');
    expect(isSweepAnomaly(verdict)).toBe(true);
  });

  it('una respuesta vacía nunca barre', () => {
    const verdict = sweepVerdict({ ...base, missing: 10, received: 0, maxDrop: 1 });
    expect(verdict).toBe('empty-response');
    expect(isSweepAnomaly(verdict)).toBe(true);
  });

  it('hoteles ilegibles: la lista no está completa, no se da de baja nada, y no es anomalía', () => {
    const verdict = sweepVerdict({ ...base, missing: 1, received: 9, unreadable: 1 });
    expect(verdict).toBe('incomplete-response');
    expect(isSweepAnomaly(verdict)).toBe(false);
  });

  it('sin faltantes no hay nada que barrer, aunque la respuesta venga vacía y la ciudad también', () => {
    expect(sweepVerdict({ ...base, missing: 0 })).toBe('nothing-missing');
    expect(
      sweepVerdict({ previouslyActive: 0, missing: 0, received: 0, unreadable: 0, maxDrop: 0.5 }),
    ).toBe('nothing-missing');
  });

  it('con 0 no se tolera ninguna baja; con 1, cualquiera que no deje la ciudad vacía', () => {
    expect(sweepVerdict({ ...base, missing: 1, received: 9, maxDrop: 0 })).toBe('drop-exceeded');
    expect(sweepVerdict({ ...base, missing: 10, received: 3, maxDrop: 1 })).toBe('swept');
  });
});

describe('selectDueCities: qué ciudad toca y en qué orden (05 §6.3)', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = Date.UTC(2026, 8, 25, 8, 0, 0);
  const cadence: CityCadence = {
    demandMaxAgeMs: 20 * HOUR,
    regularMaxAgeMs: 7 * DAY,
    emptyMaxAgeMs: 30 * DAY,
    demandWindowMs: 14 * DAY,
  };
  const city = (code: string, extra: Partial<CityCandidate> = {}): CityCandidate => ({
    code,
    countryCode: 'CO',
    hotelCount: 10,
    syncedAt: new Date(now - 8 * DAY),
    lastStatusCode: 200,
    demand: 0,
    ...extra,
  });

  it('demanda primero, luego nunca intentadas, luego nunca sincronizadas que fallaron, luego las más viejas', () => {
    const due = selectDueCities(
      [
        city('viejo-2', { syncedAt: new Date(now - 9 * DAY) }),
        city('fallida', { syncedAt: null, lastStatusCode: 500 }),
        city('nueva', { syncedAt: null, lastStatusCode: null }),
        city('demanda-baja', { demand: 2, syncedAt: new Date(now - 21 * HOUR) }),
        city('demanda-alta', { demand: 9, syncedAt: new Date(now - 30 * HOUR) }),
        city('viejo-1', { syncedAt: new Date(now - 8 * DAY) }),
      ],
      { now, cadence, limit: 10 },
    );
    expect(due.map((c) => c.code)).toEqual([
      'demanda-alta',
      'demanda-baja',
      'nueva',
      'fallida',
      'viejo-2',
      'viejo-1',
    ]);
  });

  it('frecuencias: diaria con demanda, semanal el resto, mensual si no tiene hoteles', () => {
    const due = selectDueCities(
      [
        city('demanda-fresca', { demand: 1, syncedAt: new Date(now - 19 * HOUR) }),
        city('demanda-vencida', { demand: 1, syncedAt: new Date(now - 20 * HOUR) }),
        city('semanal-fresca', { syncedAt: new Date(now - 6 * DAY) }),
        city('semanal-vencida', { syncedAt: new Date(now - 7 * DAY) }),
        city('vacia-fresca', { hotelCount: 0, syncedAt: new Date(now - 29 * DAY) }),
        city('vacia-vencida', { hotelCount: 0, syncedAt: new Date(now - 30 * DAY) }),
      ],
      { now, cadence, limit: 10 },
    );
    expect(due.map((c) => c.code).sort()).toEqual([
      'demanda-vencida',
      'semanal-vencida',
      'vacia-vencida',
    ]);
  });

  it('el límite es el presupuesto de llamadas que queda', () => {
    const cities = ['a', 'b', 'c'].map((code) =>
      city(code, { syncedAt: null, lastStatusCode: null }),
    );
    expect(selectDueCities(cities, { now, cadence, limit: 2 }).map((c) => c.code)).toEqual([
      'a',
      'b',
    ]);
    expect(selectDueCities(cities, { now, cadence, limit: 0 })).toEqual([]);
  });
});
