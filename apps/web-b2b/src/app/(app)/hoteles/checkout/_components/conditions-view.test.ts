import { describe, expect, it } from 'vitest';
import type { HotelCancellation, HotelRoompack } from '../../actions';
import { cancelPolicyView, conditionGroups } from './conditions-view';

describe('conditionGroups — las condiciones del hotel completas (U-11)', () => {
  it('agrupa por categoría en el orden de la llegada al hotel, con sus etiquetas', () => {
    const groups = conditionGroups([
      { category: 'other', text: 'Pets not allowed' },
      { category: 'checkOut', text: 'CheckOut Time: 12:00 PM' },
      { category: 'checkIn', text: 'CheckIn Time-Begin: 3:00 PM' },
      { category: 'checkIn', text: 'CheckIn Time-End: 3:00 AM' },
      { category: 'mandatoryFees', text: '• City tax\n• Resort fee' },
    ]);
    expect(groups.map((g) => [g.label, g.items])).toEqual([
      ['Check-in', ['CheckIn Time-Begin: 3:00 PM', 'CheckIn Time-End: 3:00 AM']],
      ['Check-out', ['CheckOut Time: 12:00 PM']],
      ['Cargos obligatorios', ['• City tax\n• Resort fee']],
      ['Otras condiciones', ['Pets not allowed']],
    ]);
  });

  it('el texto va completo y tal cual: lo que parece marcado sigue siendo texto (RF-16 CA-1)', () => {
    const text =
      'Read &lt;script&gt;alert(1)&lt;/script&gt; and <b>terms</b> at http://x.test/t.pdf';
    const [group] = conditionGroups([{ category: 'specialInstructions', text }]);
    expect(group?.items).toEqual([text]);
  });

  it('descarta vacíos y repeticiones exactas, nada más', () => {
    const groups = conditionGroups([
      { category: 'other', text: '  ' },
      { category: 'other', text: 'No smoking' },
      { category: 'other', text: 'No smoking ' },
      { category: 'cardsAccepted', text: 'No smoking' },
    ]);
    expect(groups.map((g) => [g.category, g.items])).toEqual([
      ['cardsAccepted', ['No smoking']],
      ['other', ['No smoking']],
    ]);
  });

  it('sin condiciones, sin grupos', () => {
    expect(conditionGroups([])).toEqual([]);
  });
});

function pack(
  cancellation: HotelCancellation,
  finalMinor = 40000,
): Pick<HotelRoompack, 'cancellation' | 'price' | 'pricing'> {
  return {
    cancellation,
    price: { total: { amountMinor: 30000, currency: 'USD' }, taxesDetail: [] },
    pricing: { costMinor: 30000, finalMinor, ownMarkupMinor: 10000, currency: 'USD' },
  };
}

describe('cancelPolicyView — la política del PreBook (U-10)', () => {
  it('final, con la fecha sin cargo en hora local del hotel y la penalidad estimada en VENTA', () => {
    const view = cancelPolicyView(
      pack({
        refundable: true,
        status: 'partially_refundable',
        policySource: 'prebook-final',
        freeCancellationUntilLocal: '2026-10-10T23:59:00',
        rules: [
          { type: 'Percentage', penaltyPercentage: 50, fromLocalDateTime: '2026-10-11T00:00:00' },
          {
            type: 'Fixed',
            penaltyAmount: { amountMinor: 30000, currency: 'USD' },
            fromLocalDateTime: '2026-10-12T00:00:00',
          },
        ],
      }),
    );
    expect(view.final).toBe(true);
    expect(view.headline).toBe('Cancelación sin cargo hasta el 10 oct 2026, 23:59.');
    expect(view.hotelLocalTime).toBe(true);
    expect(view.hasEstimates).toBe(true);
    expect(view.tiers.map((t) => t.when)).toEqual([
      'Desde el 11 oct 2026, 00:00',
      'Desde el 12 oct 2026, 00:00',
    ]);
    // 50 % de 400,00 de venta; el fijo, como la proporción del neto llevada a la venta.
    expect(view.tiers[0]?.approx).toMatch(/200,00/);
    expect(view.tiers[1]?.charge).toMatch(/100 %/);
    expect(view.tiers[1]?.approx).toMatch(/400,00/);
  });

  it('nunca muestra el importe neto de una penalidad fija (G3)', () => {
    const view = cancelPolicyView(
      pack({
        refundable: true,
        status: 'partially_refundable',
        policySource: 'prebook-final',
        rules: [{ type: 'Fixed', penaltyAmount: { amountMinor: 15000, currency: 'USD' } }],
      }),
    );
    expect(JSON.stringify(view)).not.toMatch(/150,00/);
    expect(view.tiers[0]?.approx).toMatch(/200,00/);
  });

  it('no reembolsable', () => {
    const view = cancelPolicyView(
      pack({
        refundable: false,
        status: 'non_refundable',
        policySource: 'prebook-final',
        rules: [],
      }),
    );
    expect(view).toMatchObject({ headline: 'No reembolsable.', refundable: false, tiers: [] });
    expect(view.hotelLocalTime).toBe(false);
  });

  it('sin tramos no se inventan plazos', () => {
    const view = cancelPolicyView(
      pack({ refundable: true, status: 'partially_refundable', policySource: 'none', rules: [] }),
    );
    expect(view.headline).toBe('Reembolsable. El proveedor no informó los plazos.');
    expect(view.final).toBe(false);
  });

  it('las notas del proveedor van como texto', () => {
    const view = cancelPolicyView(
      pack({
        refundable: true,
        status: 'partially_refundable',
        policySource: 'prebook-final',
        vendorNotes: 'No show: 100 %',
        rules: [],
      }),
    );
    expect(view.notes).toBe('No show: 100 %');
  });
});
