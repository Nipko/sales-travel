import {
  HotelCancellationSchema,
  type HotelCancellation,
  type HotelRoompack,
} from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { effectiveNonRefundable } from '../hotels/hotel-non-refundable.js';
import {
  DESPEGAR_UNDETAILED_PENALTY_TYPE,
  withDespegarCancellationDates,
} from './despegar-cancellation-dates.js';

const FREE_72_THEN_FULL: HotelCancellation = {
  refundable: true,
  status: 'fully_refundable',
  hoursBeforePenalty: 72,
  rules: [
    { type: 'FREE', fromHours: 72 },
    { type: 'PENALTY', penaltyPercentage: 100, fromHours: 0, toHours: 72 },
  ],
};

function pack(cancellation: HotelCancellation): HotelRoompack {
  return {
    id: 'rp-1',
    rooms: [{ name: 'Doble' }],
    price: { total: { amountMinor: 50_000, currency: 'USD' } },
    cancellation,
    provider: { name: 'despegar', offerRef: 'rp-1' },
  } as unknown as HotelRoompack;
}

describe('withDespegarCancellationDates', () => {
  it('ubica cada tramo y el fin de la cancelación gratis en hora local del hotel', () => {
    const out = withDespegarCancellationDates(FREE_72_THEN_FULL, '2026-12-10');
    expect(out.freeCancellationUntilLocal).toBe('2026-12-07T00:00:00');
    expect(out.rules).toEqual([
      { type: 'FREE', fromHours: 72 },
      {
        type: 'PENALTY',
        penaltyPercentage: 100,
        fromHours: 0,
        toHours: 72,
        fromLocalDateTime: '2026-12-07T00:00:00',
      },
    ]);
    expect(HotelCancellationSchema.safeParse(out).success).toBe(true);
  });

  it('con check-in mañana y "gratis hasta 72 h antes", la tarifa ya es no reembolsable', () => {
    const now = Date.parse('2026-11-19T15:00:00Z');
    const terms = effectiveNonRefundable(
      pack(withDespegarCancellationDates(FREE_72_THEN_FULL, '2026-11-20')),
      now,
    );
    expect(terms?.reason).toBe('full-penalty-in-force');
    expect(terms?.fullPenaltySinceLocal).toBe('2026-11-17T00:00:00');
  });

  it('con el plazo todavía lejos, sigue siendo cancelable', () => {
    const now = Date.parse('2026-11-19T15:00:00Z');
    const terms = effectiveNonRefundable(
      pack(withDespegarCancellationDates(FREE_72_THEN_FULL, '2026-12-20')),
      now,
    );
    expect(terms).toBeUndefined();
  });

  it('un cargo parcial pasado el plazo no se vuelve no reembolsable', () => {
    const partial: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      hoursBeforePenalty: 72,
      rules: [
        { type: 'PERCENTAGE', penaltyPercentage: 50, fromHours: 0, toHours: 72 },
        { type: 'FREE', fromHours: 72 },
      ],
    };
    const out = withDespegarCancellationDates(partial, '2026-11-20');
    expect(out.freeCancellationUntilLocal).toBeUndefined();
    expect(effectiveNonRefundable(pack(out), Date.parse('2026-11-19T15:00:00Z'))).toBeUndefined();
  });

  it('con el plazo y sin ningún cargo detallado, pasado el plazo se lee como el 100 %', () => {
    const undetailed: HotelCancellation = {
      refundable: true,
      status: 'fully_refundable',
      hoursBeforePenalty: 48,
      rules: [{ type: 'FREE', fromHours: 48 }],
    };
    const out = withDespegarCancellationDates(undetailed, '2026-11-20');
    expect(out.rules.at(-1)).toEqual({
      type: DESPEGAR_UNDETAILED_PENALTY_TYPE,
      penaltyPercentage: 100,
      fromHours: 0,
      toHours: 48,
      fromLocalDateTime: '2026-11-18T00:00:00',
    });
    expect(HotelCancellationSchema.safeParse(out).success).toBe(true);
    expect(effectiveNonRefundable(pack(out), Date.parse('2026-11-19T15:00:00Z'))?.reason).toBe(
      'full-penalty-in-force',
    );
  });

  it('el no-show no es un plazo de cancelación: no se ubica', () => {
    const withNoShow: HotelCancellation = {
      ...FREE_72_THEN_FULL,
      rules: [...FREE_72_THEN_FULL.rules, { type: 'no_show', penaltyPercentage: 100, toHours: 0 }],
    };
    const out = withDespegarCancellationDates(withNoShow, '2026-12-10');
    expect(out.rules[2]).toEqual({ type: 'no_show', penaltyPercentage: 100, toHours: 0 });
  });

  it('una no reembolsable o una fecha de entrada inválida quedan como llegaron', () => {
    const nonRefundable: HotelCancellation = {
      refundable: false,
      status: 'non_refundable',
      rules: [],
    };
    expect(withDespegarCancellationDates(nonRefundable, '2026-12-10')).toBe(nonRefundable);
    expect(withDespegarCancellationDates(FREE_72_THEN_FULL, 'mañana')).toBe(FREE_72_THEN_FULL);
  });
});
