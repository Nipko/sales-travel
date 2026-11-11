import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import type { FlightGroup } from './flight-row';
import {
  findHighlights,
  groupDuration,
  highlightTags,
  preferSaleCurrency,
} from './result-highlights';

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

describe('con monedas mezcladas', () => {
  it('el más barato se busca en la moneda principal, no comparando cifras de otra', () => {
    const cop = (key: string, amount: number) => group(key, amount, [100]);
    const brl = group('brl', 314083, [100]);
    (brl.offers[0] as { total: { currency: string } }).total.currency = 'BRL';
    (brl.offers[0] as { taxes: { currency: string } }).taxes.currency = 'BRL';
    const groups = [cop('a', 258983000), cop('b', 300000000), brl];
    expect(findHighlights(groups).cheapest?.key).toBe('a');
  });
});

describe('tarifas de un mismo vuelo en dos monedas', () => {
  it('primero la de la moneda de venta, aunque la cifra en otra moneda sea menor', () => {
    const cop = group('cop', 113870000, [100]).offers[0]!;
    const brl = group('brl', 173443, [100]).offers[0]!;
    (brl as { total: { currency: string } }).total.currency = 'BRL';
    const [g] = preferSaleCurrency([{ key: 'LA4117', offers: [brl, cop] }], 'COP');
    expect(g!.offers[0]!.total.currency).toBe('COP');
  });
});
