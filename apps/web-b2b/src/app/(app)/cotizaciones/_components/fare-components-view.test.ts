import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import { fareComponentsForDisplay, fareFamilySummary } from './fare-components-view';

function roundTrip(): Pick<Offer, 'fareComponents' | 'fareFamily' | 'itineraries'> {
  return {
    fareFamily: { name: 'NO DEBE APLANAR', cabin: 'economy' },
    itineraries: [
      {
        totalDurationMinutes: 210,
        stops: 0,
        segments: [
          {
            carrier: 'LA',
            flightNumber: '1',
            origin: 'BOG',
            destination: 'LIM',
            departureAt: '2026-09-01T10:00:00Z',
            arrivalAt: '2026-09-01T13:30:00Z',
            durationMinutes: 210,
            cabin: 'economy',
            bookingClass: 'L',
          },
        ],
      },
      {
        totalDurationMinutes: 210,
        stops: 0,
        segments: [
          {
            carrier: 'LA',
            flightNumber: '2',
            origin: 'LIM',
            destination: 'BOG',
            departureAt: '2026-09-08T10:00:00Z',
            arrivalAt: '2026-09-08T13:30:00Z',
            durationMinutes: 210,
            cabin: 'economy',
            bookingClass: 'B',
          },
        ],
      },
    ],
    fareComponents: [
      {
        segmentRefs: [0],
        brand: { code: 'LIGHT', name: 'Light', programId: 10 },
        fareBasisCode: 'L0AWZRN1',
        bookingClasses: ['L'],
      },
      {
        segmentRefs: [1],
        brand: { code: 'FLEX', name: 'Full Flex', programCode: 'JA-V' },
        fareBasisCode: 'B0AWZRN1',
        bookingClasses: ['B'],
      },
    ],
  };
}

describe('fareComponentsForDisplay', () => {
  it('mantiene ida y vuelta como componentes distintos con su ruta e identidad', () => {
    const out = fareComponentsForDisplay(roundTrip());

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ legLabel: 'Ida', route: 'BOG → LIM', name: 'Light' });
    expect(out[0]?.details).toEqual(['Programa 10', 'Base L0AWZRN1', 'Clase L']);
    expect(out[1]).toMatchObject({ legLabel: 'Vuelta', route: 'LIM → BOG', name: 'Full Flex' });
    expect(out[1]?.details).toEqual(['FLEX', 'JA-V', 'Base B0AWZRN1', 'Clase B']);
  });

  it('el resumen usa ambas familias y no el fareFamily singular de compatibilidad', () => {
    expect(fareFamilySummary(roundTrip())).toBe('Light / Full Flex');
  });

  it('sin componentes cae a fareFamily para ofertas antiguas', () => {
    expect(
      fareFamilySummary({ fareFamily: { name: 'Basic', cabin: 'economy' }, itineraries: [] }),
    ).toBe('Basic');
  });
});
