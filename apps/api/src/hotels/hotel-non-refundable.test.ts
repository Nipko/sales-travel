import type { HotelCancellation, HotelRoompack } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import {
  effectiveNonRefundable,
  fullPenaltySinceLocal,
  latestHotelLocalNow,
} from './hotel-non-refundable.js';

/**
 * "No reembolsable en los hechos" (pedido del founder del 2026-09-29, puntos b y c): la lectura
 * conservadora que decide si el Book exige la confirmación y si el permiso de la agencia aplica.
 */

/** 25/09/2026 15:00 UTC: en UTC+14 ya son las 05:00 del 26. */
const AHORA = Date.parse('2026-09-25T15:00:00Z');

function pack(
  cancellation: HotelCancellation,
  opts: { rooms?: number; finalMinor?: number } = {},
): HotelRoompack {
  return {
    id: 'R-1',
    provider: { name: 'stub-hotels', offerRef: 'R-1' },
    board: 'RO',
    rooms: Array.from({ length: opts.rooms ?? 1 }, (_, i) => ({
      name: `Habitación ${i + 1}`,
      reference: i,
      bedOptions: [],
    })),
    cancellation,
    price: { total: { amountMinor: 30_000, currency: 'USD' }, taxesDetail: [] },
    ...(opts.finalMinor === undefined
      ? {}
      : {
          pricing: {
            costMinor: 30_000,
            finalMinor: opts.finalMinor,
            ownMarkupMinor: opts.finalMinor - 30_000,
            currency: 'USD',
          },
        }),
  };
}

const DECLARADA: HotelCancellation = {
  refundable: false,
  status: 'non_refundable',
  rules: [],
  policySource: 'none',
};

describe('effectiveNonRefundable', () => {
  it('declarada no reembolsable → el 100 % es el precio de VENTA, no el neto', () => {
    expect(effectiveNonRefundable(pack(DECLARADA, { finalMinor: 33_000 }), AHORA)).toEqual({
      reason: 'declared',
      penalty: { amountMinor: 33_000, currency: 'USD' },
    });
  });

  it('sin pricing, el precio de venta es el neto', () => {
    expect(effectiveNonRefundable(pack(DECLARADA), AHORA)?.penalty).toEqual({
      amountMinor: 30_000,
      currency: 'USD',
    });
  });

  it('IsRefundable=false con tramos a 0 (TBO p. 50): gana lo más caro, no reembolsable', () => {
    const contradictoria: HotelCancellation = {
      refundable: false,
      status: 'non_refundable',
      rules: [
        {
          type: 'Fixed',
          penaltyAmount: { amountMinor: 0, currency: 'USD' },
          fromLocalDateTime: '2026-10-01T00:00:00',
        },
      ],
      policySource: 'prebook-final',
    };
    expect(effectiveNonRefundable(pack(contradictoria), AHORA)?.reason).toBe('declared');
  });

  it('reembolsable con el 100 % que PUEDE estar rigiendo (UTC+14) → full-penalty-in-force', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        { type: 'Percentage', penaltyPercentage: 50, fromLocalDateTime: '2026-09-20T00:00:00' },
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-09-26T04:59:59' },
      ],
      policySource: 'prebook-final',
    };
    expect(effectiveNonRefundable(pack(c), AHORA)).toEqual({
      reason: 'full-penalty-in-force',
      penalty: { amountMinor: 30_000, currency: 'USD' },
      fullPenaltySinceLocal: '2026-09-26T04:59:59',
    });
  });

  it('el 100 % que empieza después de la hora local más adelantada todavía no rige', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'fully_refundable',
      rules: [
        { type: 'Percentage', penaltyPercentage: 0, fromLocalDateTime: '2026-09-20T00:00:00' },
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-09-26T05:00:01' },
      ],
      policySource: 'prebook-final',
      freeCancellationUntilLocal: '2026-09-26T05:00:01',
    };
    expect(effectiveNonRefundable(pack(c), AHORA)).toBeUndefined();
  });

  it('un importe fijo de toda la reserva igual o mayor que el neto cuenta como el 100 %', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        {
          type: 'Fixed',
          penaltyAmount: { amountMinor: 30_000, currency: 'USD' },
          fromLocalDateTime: '2026-09-01T00:00:00',
        },
      ],
      policySource: 'prebook-final',
    };
    expect(effectiveNonRefundable(pack(c), AHORA)?.reason).toBe('full-penalty-in-force');
  });

  it('un importe fijo en otra moneda no se compara: no se inventa el 100 %', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        {
          type: 'Fixed',
          penaltyAmount: { amountMinor: 99_999_999, currency: 'COP' },
          fromLocalDateTime: '2026-09-01T00:00:00',
        },
      ],
      policySource: 'prebook-final',
    };
    expect(effectiveNonRefundable(pack(c), AHORA)).toBeUndefined();
  });

  it('un tramo que vuelve a bajar después del 100 % no deja el 100 % vigente', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-09-01T00:00:00' },
        { type: 'Percentage', penaltyPercentage: 20, fromLocalDateTime: '2026-09-10T00:00:00' },
      ],
      policySource: 'prebook-final',
    };
    expect(effectiveNonRefundable(pack(c), AHORA)).toBeUndefined();
  });

  it('reembolsable sin tramos (política no informada): no se afirma que cueste el total', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [],
      policySource: 'none',
    };
    expect(effectiveNonRefundable(pack(c), AHORA)).toBeUndefined();
  });
});

describe('fullPenaltySinceLocal con tramos por habitación', () => {
  it('cuesta el total cuando TODAS las habitaciones cobran el 100 %: desde la más tardía', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        {
          type: 'Percentage',
          penaltyPercentage: 100,
          fromLocalDateTime: '2026-10-01T00:00:00',
          roomIndex: 1,
        },
        {
          type: 'Percentage',
          penaltyPercentage: 100,
          fromLocalDateTime: '2026-10-03T00:00:00',
          roomIndex: 2,
        },
      ],
      policySource: 'prebook-final',
    };
    expect(fullPenaltySinceLocal(pack(c, { rooms: 2 }))).toBe('2026-10-03T00:00:00');
  });

  it('si una habitación no llega al 100 %, no hay un momento en que cueste el total', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        {
          type: 'Percentage',
          penaltyPercentage: 100,
          fromLocalDateTime: '2026-10-01T00:00:00',
          roomIndex: 1,
        },
        {
          type: 'Percentage',
          penaltyPercentage: 50,
          fromLocalDateTime: '2026-10-01T00:00:00',
          roomIndex: 2,
        },
      ],
      policySource: 'prebook-final',
    };
    expect(fullPenaltySinceLocal(pack(c, { rooms: 2 }))).toBeUndefined();
  });
});

describe('tramos que no se pueden ubicar o que llegan desordenados', () => {
  it('un tramo sin fecha local (horas antes del check-in) no cuenta: no se inventa el 100 %', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [{ type: 'Percentage', penaltyPercentage: 100, fromHours: 48 }],
      policySource: 'prebook-final',
    };
    expect(fullPenaltySinceLocal(pack(c))).toBeUndefined();
    expect(effectiveNonRefundable(pack(c), AHORA)).toBeUndefined();
  });

  it('el orden de llegada no cambia qué rige: se ordena por el inicio de cada tramo', () => {
    const c: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-10-05T00:00:00' },
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-10-05T00:00:00' },
        { type: 'Percentage', penaltyPercentage: 30, fromLocalDateTime: '2026-10-01T00:00:00' },
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-10-09T00:00:00' },
      ],
      policySource: 'prebook-final',
    };
    expect(fullPenaltySinceLocal(pack(c))).toBe('2026-10-05T00:00:00');
  });
});

describe('latestHotelLocalNow', () => {
  it('es la hora de UTC+14, sin zona', () => {
    expect(latestHotelLocalNow(AHORA)).toBe('2026-09-26T05:00:00');
  });
});
