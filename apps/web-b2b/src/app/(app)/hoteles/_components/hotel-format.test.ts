import { describe, expect, it } from 'vitest';
import type { HotelCancellation } from '../actions';
import {
  cancellationView,
  formatFee,
  formatHotelLocalDateTime,
  rateBoardLabel,
} from './hotel-format';

describe('rateBoardLabel — régimen de la tarifa (RF-11)', () => {
  it('la etiqueta del proveedor gana sobre el código', () => {
    expect(rateBoardLabel({ board: 'BB', boardLabel: 'Desayuno para 1 persona' })).toBe(
      'Desayuno para 1 persona',
    );
  });

  it('sin etiqueta, o con una en blanco, la del código', () => {
    expect(rateBoardLabel({ board: 'HB' })).toBe('Media pensión');
    expect(rateBoardLabel({ board: 'AI', boardLabel: '  ' })).toBe('Todo incluido');
  });
});

describe('formatFee', () => {
  it('con el literal del proveedor cuando la moneda no tiene 2 decimales', () => {
    expect(
      formatFee({ amount: { amountMinor: 25_810, currency: 'KWD' }, amountText: '25.810' }),
    ).toBe('25.810 KWD');
  });

  it('sin literal, como dinero en su moneda', () => {
    const text = formatFee({ amount: { amountMinor: 20_00, currency: 'AED' } });
    expect(text).toContain('20');
    expect(text).toContain('AED');
  });
});

describe('formatHotelLocalDateTime — hora local del hotel, sin zona', () => {
  it('no pasa por la zona del navegador', () => {
    expect(formatHotelLocalDateTime('2026-10-12T14:00:00')).toMatch(/^12 oct 2026, 14:00$/);
    expect(formatHotelLocalDateTime('2026-01-01T00:30:00')).toMatch(/^1 ene 2026, 00:30$/);
  });

  it('un valor que no es fecha local se muestra tal cual', () => {
    expect(formatHotelLocalDateTime('mañana')).toBe('mañana');
  });
});

function politica(extra: Partial<HotelCancellation>): HotelCancellation {
  return { refundable: true, status: 'partially_refundable', rules: [], ...extra };
}

describe('cancellationView — la política según su origen (D-TBO-19 A)', () => {
  it('sin tramos: sólo "reembolsable" o "no reembolsable", sin inventar parcial ni total', () => {
    expect(cancellationView(politica({ policySource: 'none' }))).toEqual({
      label: 'Reembolsable',
      refundable: true,
      note: 'plazos a confirmar',
    });
    expect(
      cancellationView(
        politica({ refundable: false, status: 'non_refundable', policySource: 'none' }),
      ),
    ).toEqual({ label: 'No reembolsable', refundable: false });
  });

  it('de una búsqueda: sujeta a confirmación, con la hora local del hotel si hay fecha', () => {
    expect(
      cancellationView(
        politica({
          status: 'fully_refundable',
          policySource: 'search-indicative',
          freeCancellationUntilLocal: '2026-10-12T14:00:00',
        }),
      ),
    ).toEqual({
      label: 'Sin cargo hasta el 12 oct 2026, 14:00',
      refundable: true,
      note: 'hora local del hotel, sujeta a confirmación',
    });
    expect(cancellationView(politica({ policySource: 'search-indicative' })).note).toBe(
      'sujeta a confirmación',
    );
  });

  it('del PreBook: definitiva, sin "sujeta a confirmación"', () => {
    const view = cancellationView(
      politica({
        status: 'fully_refundable',
        policySource: 'prebook-final',
        freeCancellationUntilLocal: '2026-10-12T14:00:00',
      }),
    );
    expect(view.note).toBe('hora local del hotel');
  });

  it('sin origen declarado se muestra como hasta ahora', () => {
    expect(cancellationView(politica({}))).toEqual({
      label: 'Parcialmente reembolsable',
      refundable: true,
    });
  });
});
