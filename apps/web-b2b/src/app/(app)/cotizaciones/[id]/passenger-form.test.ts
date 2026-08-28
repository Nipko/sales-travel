import { describe, expect, it } from 'vitest';
import { buildEmptyPassengers } from './passenger-form';

describe('buildEmptyPassengers', () => {
  it('asigna el índice global que Sabre Offer Price usa en orden ADT → CHD → INF', () => {
    const passengers = buildEmptyPassengers({ adults: 2, children: 1, infants: 1 });

    expect(
      passengers.map(({ paxType, requestedTravelerIndex }) => ({
        paxType,
        requestedTravelerIndex,
      })),
    ).toEqual([
      { paxType: 'ADT', requestedTravelerIndex: 0 },
      { paxType: 'ADT', requestedTravelerIndex: 1 },
      { paxType: 'CHD', requestedTravelerIndex: 2 },
      { paxType: 'INF', requestedTravelerIndex: 3 },
    ]);
  });
});
