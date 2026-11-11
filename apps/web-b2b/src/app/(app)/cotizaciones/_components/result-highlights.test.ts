import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import type { FlightGroup } from './flight-row';
import { findHighlights, groupDuration, highlightTags } from './result-highlights';

function group(key: string, amountMinor: number, durations: number[]): FlightGroup {
  const offer = {
    total: { amountMinor, currency: 'COP' },
    taxes: { amountMinor: 0, currency: 'COP' },
    itineraries: durations.map((totalDurationMinutes) => ({
      totalDurationMinutes,
      stops: 0,
      segments: [],
    })),
  } as unknown as Offer;
  return { key, offers: [offer] };
}

describe('destacados de la lista', () => {
  const barato = group('barato', 100, [300, 300]);
  const rapido = group('rapido', 200, [120, 130]);
  const medio = group('medio', 150, [200, 200]);

  it('la duración suma todos los tramos, o sólo el elegido por trayecto', () => {
    expect(groupDuration(rapido)).toBe(250);
    expect(groupDuration(rapido, 0)).toBe(120);
  });

  it('marca el más barato y el más rápido', () => {
    const groups = [medio, barato, rapido];
    const tags = highlightTags(groups, findHighlights(groups));
    expect(tags.get('barato')).toEqual(['Más barato']);
    expect(tags.get('rapido')).toEqual(['Más rápido']);
    expect(tags.has('medio')).toBe(false);
  });

  it('el que es las dos cosas lleva las dos, y un resultado solo no lleva ninguna', () => {
    const solo = group('solo', 90, [60]);
    const both = [solo, medio];
    expect(highlightTags(both, findHighlights(both)).get('solo')).toEqual([
      'Más barato',
      'Más rápido',
    ]);
    expect(highlightTags([solo], findHighlights([solo])).size).toBe(0);
  });
});
