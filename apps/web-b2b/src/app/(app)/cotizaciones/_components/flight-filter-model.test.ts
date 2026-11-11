import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import type { FlightGroup } from './flight-row';
import {
  activeFilterCount,
  applyFlightFilters,
  deriveFilterOptions,
  EMPTY_FILTERS,
  localHour,
  toggleWindow,
} from './flight-filter-model';

interface LegSpec {
  readonly from: string;
  readonly to: string;
  readonly dep: string;
  readonly arr: string;
  readonly carrier: string;
  readonly stops?: number;
  readonly minutes?: number;
}

function group(key: string, amount: number, legs: LegSpec[], checked = false): FlightGroup {
  const offer = {
    id: key,
    total: { amountMinor: amount, currency: 'COP' },
    taxes: { amountMinor: 0, currency: 'COP' },
    ...(checked ? { baggage: { checked: { qty: 1 } } } : {}),
    itineraries: legs.map((l) => ({
      totalDurationMinutes: l.minutes ?? 180,
      stops: l.stops ?? 0,
      segments: [
        {
          carrier: l.carrier,
          flightNumber: '1',
          origin: l.from,
          destination: l.to,
          departureAt: l.dep,
          arrivalAt: l.arr,
        },
      ],
    })),
  } as unknown as Offer;
  return { key, offers: [offer] };
}

const manana = group('manana', 100, [
  {
    from: 'CTG',
    to: 'MCO',
    dep: '2026-12-09T08:00:00-05:00',
    arr: '2026-12-09T12:00:00-05:00',
    carrier: 'AA',
  },
]);
const noche = group(
  'noche',
  200,
  [
    {
      from: 'CTG',
      to: 'SFB',
      dep: '2026-12-09T20:00:00-05:00',
      arr: '2026-12-09T23:30:00-05:00',
      carrier: 'DL',
      stops: 1,
      minutes: 400,
    },
  ],
  true,
);
const groups = [manana, noche];

describe('filtros de vuelos, sólo en el navegador', () => {
  it('la hora es la del aeropuerto escrita en el ISO, no la del navegador', () => {
    expect(localHour('2026-12-09T20:00:00-05:00')).toBe(20);
    expect(localHour(undefined)).toBeNull();
  });

  it('sin filtros pasan todos y no cuenta ninguno activo', () => {
    expect(applyFlightFilters(groups, EMPTY_FILTERS)).toHaveLength(2);
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it('escalas, aerolínea, horario, duración, equipaje, aeropuerto y precio', () => {
    const keys = (f: Parameters<typeof applyFlightFilters>[1]) =>
      applyFlightFilters(groups, f).map((g) => g.key);
    expect(keys({ ...EMPTY_FILTERS, maxStops: 0 })).toEqual(['manana']);
    expect(keys({ ...EMPTY_FILTERS, carriers: ['DL'] })).toEqual(['noche']);
    expect(keys({ ...EMPTY_FILTERS, departure: [[18, 24]] })).toEqual(['noche']);
    expect(keys({ ...EMPTY_FILTERS, arrival: [[6, 12]] })).toEqual([]);
    expect(keys({ ...EMPTY_FILTERS, maxDurationMinutes: 300 })).toEqual(['manana']);
    expect(keys({ ...EMPTY_FILTERS, baggage: { checked: true, carryOn: false } })).toEqual([
      'noche',
    ]);
    expect(keys({ ...EMPTY_FILTERS, excludedAirports: ['SFB'] })).toEqual(['manana']);
    expect(keys({ ...EMPTY_FILTERS, maxPriceMinor: 150 })).toEqual(['manana']);
  });

  it('los conteos aplican los DEMÁS filtros, y los aeropuertos salen sólo si hay varios', () => {
    const options = deriveFilterOptions(groups, { ...EMPTY_FILTERS, carriers: ['AA'] });
    expect(options.stops.direct.count).toBe(1);
    // El filtro de aerolínea no se aplica a sus propios conteos.
    expect(options.carriers.map((c) => [c.code, c.count])).toEqual([
      ['AA', 1],
      ['DL', 1],
    ]);
    expect(options.airports.map((a) => a.code)).toEqual(['MCO', 'SFB']);
    expect(options.stops.direct.minPriceMinor).toBe(100);
  });

  it('marcar dos veces la misma franja la quita', () => {
    const once = toggleWindow([], 1, [6, 12]);
    expect(once).toEqual([null, [6, 12]]);
    expect(toggleWindow(once, 1, [6, 12])).toEqual([null, null]);
  });
});
