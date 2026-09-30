import { describe, expect, it } from 'vitest';
import type { HotelCancellation, HotelRoompack } from '../actions';
import {
  fullPenaltySinceLocal,
  latestHotelLocalNow,
  rateRefundability,
  refundBadge,
  refundLine,
} from './rate-refundability';

/** 29 sep 2026, 12:00 UTC: en UTC+14 son las 02:00 del 30. */
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

function tarifa(cancellation: HotelCancellation, extra: Partial<HotelRoompack> = {}) {
  return {
    cancellation,
    price: { total: { amountMinor: 300_000_00, currency: 'COP' }, taxesDetail: [] },
    rooms: [{ name: 'Doble', reference: 1, bedOptions: [] }],
    ...extra,
  };
}

describe('latestHotelLocalNow — la hora local más adelantada posible', () => {
  it('es UTC+14, sin zona', () => {
    expect(latestHotelLocalNow(NOW)).toBe('2026-09-30T02:00:00');
  });
});

describe('rateRefundability — lo declarado', () => {
  it('no reembolsable declarada: no reembolsable, sin importar el reloj', () => {
    const r = rateRefundability(
      tarifa({ refundable: false, status: 'non_refundable', rules: [] }),
      NOW,
    );
    expect(r).toMatchObject({ kind: 'non_refundable', refundable: false });
    expect(r.fullPenaltySinceLocal).toBeUndefined();
  });

  it('contradicción de TBO (IsRefundable=false con tramos a 0): se cree lo más caro', () => {
    const r = rateRefundability(
      tarifa({
        refundable: false,
        status: 'non_refundable',
        policySource: 'search-indicative',
        rules: [
          {
            type: 'Fixed',
            fromLocalDateTime: '2026-10-01T00:00:00',
            penaltyAmount: { amountMinor: 0, currency: 'COP' },
          },
          { type: 'Percentage', fromLocalDateTime: '2026-10-10T00:00:00', penaltyPercentage: 100 },
        ],
      }),
      NOW,
    );
    expect(r.kind).toBe('non_refundable');
  });

  it('`refundable` y `status` que se contradicen: si uno dice "no", es no reembolsable', () => {
    const r = rateRefundability(
      tarifa({ refundable: true, status: 'non_refundable', policySource: 'none', rules: [] }),
      NOW,
    );
    expect(r).toMatchObject({ kind: 'non_refundable', refundable: false });
  });

  it('cancelación gratis de Despegar (sin fecha, horas antes del check-in): dice el plazo', () => {
    const r = rateRefundability(
      tarifa({
        refundable: true,
        status: 'fully_refundable',
        hoursBeforePenalty: 48,
        rules: [{ type: 'Percentage', fromHours: 0, toHours: 48, penaltyPercentage: 100 }],
      }),
      NOW,
    );
    expect(r).toMatchObject({ kind: 'free_cancellation', freeUntilHoursBeforeCheckin: 48 });
    expect(refundLine(r)).toEqual({
      tone: 'success',
      label: 'Cancelación gratis',
      note: 'hasta 48 h antes del check-in',
    });
  });

  it('reembolsable sin tramos: plazos a confirmar', () => {
    const r = rateRefundability(
      tarifa({ refundable: true, status: 'partially_refundable', policySource: 'none', rules: [] }),
      NOW,
    );
    expect(r).toMatchObject({ kind: 'refundable_terms_pending', refundable: true });
    expect(refundLine(r)).toEqual({
      tone: 'neutral',
      label: 'Reembolsable',
      note: 'plazos a confirmar',
    });
  });

  it('cancelación gratis con fecha futura: la fecha en hora local del hotel', () => {
    const r = rateRefundability(
      tarifa({
        refundable: true,
        status: 'fully_refundable',
        policySource: 'search-indicative',
        freeCancellationUntilLocal: '2026-10-10T00:00:00',
        rules: [
          { type: 'Percentage', fromLocalDateTime: '2026-09-29T00:00:00', penaltyPercentage: 0 },
          { type: 'Percentage', fromLocalDateTime: '2026-10-10T00:00:00', penaltyPercentage: 100 },
        ],
      }),
      NOW,
    );
    expect(r).toMatchObject({ kind: 'free_cancellation', freeUntilLocal: '2026-10-10T00:00:00' });
    expect(refundBadge(r)).toEqual({ tone: 'success', label: 'Cancelación gratis' });
    expect(refundLine(r)).toEqual({
      tone: 'success',
      label: 'Sin cargo hasta el 10 oct 2026, 00:00',
      note: 'hora local del hotel, sujeta a confirmación',
    });
  });

  it('sin reloj sólo cuenta lo declarado', () => {
    const r = rateRefundability(
      tarifa({
        refundable: true,
        status: 'fully_refundable',
        policySource: 'prebook-final',
        freeCancellationUntilLocal: '2020-01-01T00:00:00',
        rules: [
          { type: 'Percentage', fromLocalDateTime: '2020-01-01T00:00:00', penaltyPercentage: 100 },
        ],
      }),
    );
    expect(r).toMatchObject({ kind: 'free_cancellation', indicative: false });
    expect(refundLine(r).note).toBe('hora local del hotel');
  });
});

describe('rateRefundability — la penalidad del 100 % ya vigente se trata como no reembolsable', () => {
  const conCienDesde = (from: string): HotelCancellation => ({
    refundable: true,
    status: 'fully_refundable',
    policySource: 'prebook-final',
    freeCancellationUntilLocal: from,
    rules: [
      { type: 'Percentage', fromLocalDateTime: '2026-09-20T00:00:00', penaltyPercentage: 0 },
      { type: 'Percentage', fromLocalDateTime: from, penaltyPercentage: 100 },
    ],
  });

  it('el 100 % ya rige: no reembolsable, con desde cuándo', () => {
    const r = rateRefundability(tarifa(conCienDesde('2026-09-29T00:00:00')), NOW);
    expect(r).toMatchObject({
      kind: 'non_refundable',
      refundable: false,
      fullPenaltySinceLocal: '2026-09-29T00:00:00',
    });
    const line = refundLine(r);
    expect(line).toMatchObject({ tone: 'warning', label: 'No reembolsable' });
    // "sep" o "sept" según el ICU del runtime.
    expect(line.note).toMatch(
      /^el cargo del 100 % rige desde el 29 sept? 2026, 00:00 \(hora local del hotel\)$/,
    );
  });

  it('PUEDE regir (en UTC+14 ya pasó): conservador, no reembolsable', () => {
    const r = rateRefundability(tarifa(conCienDesde('2026-09-30T01:00')), NOW);
    expect(r.kind).toBe('non_refundable');
  });

  it('todavía no puede regir en ningún lugar: sigue siendo cancelación gratis', () => {
    const r = rateRefundability(tarifa(conCienDesde('2026-09-30T03:00:00')), NOW);
    expect(r.kind).toBe('free_cancellation');
  });

  it('un cargo fijo igual o mayor al total de la reserva es el 100 %', () => {
    const r = rateRefundability(
      tarifa({
        refundable: true,
        status: 'partially_refundable',
        policySource: 'search-indicative',
        rules: [
          {
            type: 'Fixed',
            fromLocalDateTime: '2026-09-01T00:00:00',
            penaltyAmount: { amountMinor: 300_000_00, currency: 'COP' },
          },
        ],
      }),
      NOW,
    );
    expect(r.kind).toBe('non_refundable');
  });

  it('un cargo fijo en OTRA moneda no se compara contra el total', () => {
    const r = rateRefundability(
      tarifa({
        refundable: true,
        status: 'partially_refundable',
        policySource: 'search-indicative',
        rules: [
          {
            type: 'Fixed',
            fromLocalDateTime: '2026-09-01T00:00:00',
            // La cifra (400.000 USD) "supera" la del total (300.000 COP), pero son dos monedas:
            // no dice que se pierda todo.
            penaltyAmount: { amountMinor: 400_000_00, currency: 'USD' },
          },
        ],
      }),
      NOW,
    );
    expect(r.kind).toBe('refundable_with_charge');
  });

  it('un cargo parcial vigente: reembolsable con cargo', () => {
    const r = rateRefundability(
      tarifa({
        refundable: true,
        status: 'partially_refundable',
        policySource: 'search-indicative',
        rules: [
          { type: 'Percentage', fromLocalDateTime: '2026-09-01T00:00:00', penaltyPercentage: 50 },
        ],
      }),
      NOW,
    );
    expect(r).toMatchObject({ kind: 'refundable_with_charge', refundable: true });
    expect(refundLine(r)).toEqual({
      tone: 'neutral',
      label: 'Reembolsable con cargo',
      note: 'sujeta a confirmación',
    });
  });

  it('la cancelación gratis que ya pudo vencer ya no se promete', () => {
    const r = rateRefundability(
      tarifa({
        refundable: true,
        status: 'fully_refundable',
        policySource: 'prebook-final',
        freeCancellationUntilLocal: '2026-09-29T10:00:00',
        rules: [
          { type: 'Percentage', fromLocalDateTime: '2026-09-20T00:00:00', penaltyPercentage: 0 },
          { type: 'Percentage', fromLocalDateTime: '2026-09-29T10:00:00', penaltyPercentage: 30 },
        ],
      }),
      NOW,
    );
    expect(r.kind).toBe('refundable_with_charge');
  });
});

describe('fullPenaltySinceLocal — desde cuándo se pierde todo', () => {
  it('un tramo al 100 % seguido de otro menor no es "desde siempre"', () => {
    expect(
      fullPenaltySinceLocal(
        tarifa({
          refundable: true,
          status: 'partially_refundable',
          rules: [
            {
              type: 'Percentage',
              fromLocalDateTime: '2026-09-01T00:00:00',
              penaltyPercentage: 100,
            },
            { type: 'Percentage', fromLocalDateTime: '2026-09-10T00:00:00', penaltyPercentage: 50 },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('por habitación: sólo cuando TODAS cobran el 100 %, desde la última', () => {
    const rooms = [
      { name: 'Doble', reference: 1, bedOptions: [] },
      { name: 'Doble', reference: 2, bedOptions: [] },
    ];
    const cancellation: HotelCancellation = {
      refundable: true,
      status: 'partially_refundable',
      rules: [
        {
          type: 'Percentage',
          roomIndex: 1,
          fromLocalDateTime: '2026-10-01T00:00:00',
          penaltyPercentage: 100,
        },
        {
          type: 'Percentage',
          roomIndex: 2,
          fromLocalDateTime: '2026-10-03T00:00:00',
          penaltyPercentage: 100,
        },
      ],
    };
    expect(fullPenaltySinceLocal(tarifa(cancellation, { rooms }))).toBe('2026-10-03T00:00:00');
    expect(
      fullPenaltySinceLocal(
        tarifa({ ...cancellation, rules: cancellation.rules.slice(0, 1) }, { rooms }),
      ),
    ).toBeUndefined();
  });

  it('un cargo fijo de UNA habitación no se compara contra el total', () => {
    expect(
      fullPenaltySinceLocal(
        tarifa({
          refundable: true,
          status: 'partially_refundable',
          rules: [
            {
              type: 'Fixed',
              roomIndex: 1,
              fromLocalDateTime: '2026-09-01T00:00:00',
              penaltyAmount: { amountMinor: 999_999_00, currency: 'COP' },
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('tramos sin fecha local (horas antes del check-in) no cuentan', () => {
    expect(
      fullPenaltySinceLocal(
        tarifa({
          refundable: true,
          status: 'partially_refundable',
          rules: [{ type: 'Percentage', fromHours: 0, toHours: 48, penaltyPercentage: 100 }],
        }),
      ),
    ).toBeUndefined();
  });
});
