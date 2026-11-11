import { describe, expect, it } from 'vitest';
import { isRoundTripLegs, legLabel } from './flight-legs';

const leg = (...hops: string[]) => ({
  segments: hops.slice(1).map((destination, i) => ({ origin: hops[i]!, destination })),
});

describe('legLabel — Ida/Vuelta sólo en ida y vuelta de verdad', () => {
  it('ida y vuelta, aunque tenga escalas', () => {
    const legs = [leg('BOG', 'PTY', 'MIA'), leg('MIA', 'BOG')];
    expect(isRoundTripLegs(legs)).toBe(true);
    expect([legLabel(legs, 0), legLabel(legs, 1)]).toEqual(['Ida', 'Vuelta']);
  });

  it('open jaw de dos tramos y multidestino: «Tramo n»', () => {
    const openJaw = [leg('BOG', 'MIA'), leg('MEX', 'BOG')];
    expect(isRoundTripLegs(openJaw)).toBe(false);
    expect(legLabel(openJaw, 1)).toBe('Tramo 2');
    const tres = [leg('BOG', 'MIA'), leg('MIA', 'MEX'), leg('MEX', 'BOG')];
    expect(legLabel(tres, 2)).toBe('Tramo 3');
  });

  it('solo ida no lleva rótulo', () => {
    expect(legLabel([leg('BOG', 'MIA')], 0)).toBeUndefined();
  });
});
