import type { AncillaryCatalog, AncillaryOffer } from '@sales-travel/canonical';
import type { AncillaryAddResult } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  SERVICES_MESSAGES,
  addOutcomeOf,
  notAddableReasonOf,
  planRemoval,
  priceSelections,
  publicServiceOffer,
  removalGroupOf,
  removedLinesOf,
  servicesOperationBlocks,
  servicesOperationPolicy,
  settleAddedLines,
  type StoredServiceLine,
} from './order-services.plan.js';

/**
 * Las decisiones puras de los servicios adicionales (SAB-20): qué se puede agregar, a qué precio,
 * en qué quedó cada línea y qué se quita junto. Sin base ni proveedor.
 */

function oferta(extra: Partial<AncillaryOffer> = {}): AncillaryOffer {
  return {
    serviceOfferItemId: 'BAG-1',
    category: 'BAGGAGE',
    name: 'Maleta 23 kg',
    serviceCode: '0C3',
    airlineCode: 'AV',
    segmentRefs: [0],
    passengers: [
      {
        passengerIndex: 0,
        charge: { type: 'PRICED', price: { amountMinor: 4500, currency: 'USD' } },
      },
      {
        passengerIndex: 1,
        charge: { type: 'PRICED', price: { amountMinor: 3000, currency: 'USD' } },
      },
    ],
    quantity: 1,
    weights: [{ value: 23, unit: 'KG' }],
    sellable: true,
    ...extra,
  };
}

function catalogo(offers: AncillaryOffer[] = [oferta()]): AncillaryCatalog {
  return {
    segments: [
      {
        origin: 'BOG',
        destination: 'LIM',
        departureAt: '2099-09-10T09:00',
        carrier: 'AV',
        flightNumber: '123',
      },
    ],
    offers,
    warnings: [],
  };
}

describe('qué se puede agregar', () => {
  it('con precio en la moneda de la reserva, sí; el precio por pasajero sale tal cual, sin markup', () => {
    const view = publicServiceOffer(oferta(), 'USD');
    expect(view).toMatchObject({ addable: true, notAddableReason: null });
    expect(view.passengers).toEqual([
      { passengerIndex: 0, amountMinor: 4500, included: false },
      { passengerIndex: 1, amountMinor: 3000, included: false },
    ]);
  });

  it('incluido es cero y se puede agregar; precio no informado no se vende', () => {
    const incluido = oferta({ passengers: [{ passengerIndex: 0, charge: { type: 'INCLUDED' } }] });
    expect(publicServiceOffer(incluido, 'USD').passengers).toEqual([
      { passengerIndex: 0, amountMinor: 0, included: true },
    ]);
    const ilegible = oferta({
      passengers: [{ passengerIndex: 0, charge: { type: 'NOT_INFORMED' } }],
      sellable: false,
      notSellableReason: 'PRICE_NOT_INFORMED',
    });
    const view = publicServiceOffer(ilegible, 'USD');
    expect(view).toMatchObject({ addable: false, notAddableReason: 'PRICE_NOT_INFORMED' });
    expect(view.passengers[0]?.amountMinor).toBeNull();
  });

  it('en otra moneda que la reserva no se agrega: no se convierte nada', () => {
    expect(notAddableReasonOf(oferta(), 'COP')).toBe('CURRENCY_MISMATCH');
    expect(publicServiceOffer(oferta(), 'COP').notAddableText).toContain('otra moneda');
  });

  it('lo que el proveedor marca no vendible conserva su motivo', () => {
    const view = publicServiceOffer(
      oferta({ sellable: false, notSellableReason: 'CONTACT_AIRLINE' }),
      'USD',
    );
    expect(view).toMatchObject({ addable: false, notAddableReason: 'CONTACT_AIRLINE' });
  });
});

describe('el precio de lo elegido', () => {
  it('suma el precio del catálogo por pasajero y deja una línea por pasajero con sus tramos', () => {
    const priced = priceSelections(
      catalogo(),
      [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0, 1] }],
      'USD',
    );
    expect(priced).toMatchObject({ ok: true, totalMinor: 7500 });
    if (!priced.ok) throw new Error('debía tener precio');
    expect(priced.lines.map((l) => [l.passengerIndex, l.amountMinor])).toEqual([
      [0, 4500],
      [1, 3000],
    ]);
    expect(priced.lines[0]?.segments).toEqual([catalogo().segments[0]]);
  });

  it.each([
    ['ya no se ofrece', [{ serviceOfferItemId: 'NADA', passengerIndexes: [0] }], 'not-offered'],
    [
      'un pasajero que no lo puede comprar',
      [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [2] }],
      'passenger-not-eligible',
    ],
  ] as const)('rechaza lo que %s', (_caso, selections, refusal) => {
    const priced = priceSelections(catalogo(), selections, 'USD');
    expect(priced).toMatchObject({ ok: false, refusal });
  });

  it('rechaza lo que no se puede agregar desde aquí', () => {
    const priced = priceSelections(
      catalogo([oferta({ sellable: false, notSellableReason: 'DISPLAY_ONLY' })]),
      [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0] }],
      'USD',
    );
    expect(priced).toEqual({
      ok: false,
      refusal: 'not-addable',
      message: SERVICES_MESSAGES.notAddable,
    });
  });
});

describe('en qué quedó cada línea del alta', () => {
  const priced = (() => {
    const p = priceSelections(
      catalogo([oferta(), oferta({ serviceOfferItemId: 'MEAL-1', category: 'MEAL' })]),
      [
        { serviceOfferItemId: 'BAG-1', passengerIndexes: [0] },
        { serviceOfferItemId: 'MEAL-1', passengerIndexes: [0] },
      ],
      'USD',
    );
    if (!p.ok) throw new Error('debía tener precio');
    return p.lines;
  })();

  const base: AncillaryAddResult = {
    outcome: 'ADDED',
    added: [],
    failed: [],
    unverified: [],
    issues: [],
  };

  it('todo agregado: ADDED, con los ids del proveedor para quitarlo después', () => {
    const lines = settleAddedLines(priced, {
      ...base,
      added: [
        {
          serviceOfferItemId: 'BAG-1',
          passengerIndex: 0,
          providerItemIds: ['7'],
          providerItemIdsShared: false,
        },
        {
          serviceOfferItemId: 'MEAL-1',
          passengerIndex: 0,
          providerItemIds: ['8'],
          providerItemIdsShared: false,
        },
      ],
    });
    expect(lines.map((l) => [l.status, l.providerItemIds])).toEqual([
      ['active', ['7']],
      ['active', ['8']],
    ]);
    expect(addOutcomeOf(lines)).toBe('ADDED');
  });

  it('una rechazada por línea: PARTIAL, y la rechazada no se cobra', () => {
    const lines = settleAddedLines(priced, {
      ...base,
      outcome: 'PARTIAL',
      added: [
        {
          serviceOfferItemId: 'BAG-1',
          passengerIndex: 0,
          providerItemIds: ['7'],
          providerItemIdsShared: false,
        },
      ],
      failed: [{ serviceOfferItemId: 'MEAL-1', passengerIndex: 0, reason: 'PRICE_CHANGED' }],
    });
    expect(lines.map((l) => l.status)).toEqual(['active', 'failed']);
    expect(addOutcomeOf(lines)).toBe('PARTIAL');
  });

  it('ninguna: FAILED', () => {
    const lines = settleAddedLines(priced, {
      ...base,
      outcome: 'FAILED',
      failed: [
        { serviceOfferItemId: 'BAG-1', passengerIndex: 0, reason: 'REJECTED' },
        { serviceOfferItemId: 'MEAL-1', passengerIndex: 0, reason: 'REJECTED' },
      ],
    });
    expect(addOutcomeOf(lines)).toBe('FAILED');
  });

  it('una que el resultado no nombra no se da por agregada ni por caída: en duda', () => {
    const lines = settleAddedLines(priced, {
      ...base,
      added: [
        {
          serviceOfferItemId: 'BAG-1',
          passengerIndex: 0,
          providerItemIds: ['7'],
          providerItemIdsShared: false,
        },
      ],
    });
    expect(lines.map((l) => l.status)).toEqual(['active', 'unverified']);
    expect(addOutcomeOf(lines)).toBe('UNVERIFIED');
  });
});

describe('qué se quita', () => {
  const linea = (id: string, extra: Partial<StoredServiceLine> = {}): StoredServiceLine => ({
    id,
    addedOperationId: 'op-1',
    amountMinor: 4500,
    status: 'active',
    providerItemIds: [`X${id}`],
    providerItemIdsShared: false,
    ...extra,
  });

  it('las elegidas, con sus ids del proveedor y lo que suman', () => {
    const plan = planRemoval([linea('a'), linea('b', { amountMinor: 1500 })], ['a', 'b']);
    expect(plan).toEqual({
      ok: true,
      lines: [linea('a'), linea('b', { amountMinor: 1500 })],
      providerItemIds: ['Xa', 'Xb'],
      totalMinor: 6000,
    });
  });

  it('una sin ids del proveedor, en duda o ya quitada no se quita desde aquí', () => {
    for (const extra of [
      { providerItemIds: [] },
      { status: 'unverified' as const },
      { status: 'removed' as const },
    ]) {
      expect(planRemoval([linea('a', extra)], ['a'])).toEqual({
        ok: false,
        message: SERVICES_MESSAGES.lineNotRemovable,
      });
    }
    expect(planRemoval([linea('a')], ['otra'])).toMatchObject({ ok: false });
  });

  it('las que comparten ids se quitan juntas: un grupo a medias se rechaza', () => {
    const compartida = { providerItemIds: ['9'], providerItemIdsShared: true };
    const lines = [linea('adulto', compartida), linea('nino', compartida)];
    expect(removalGroupOf(lines[0]!)).toBe(removalGroupOf(lines[1]!));
    expect(planRemoval(lines, ['adulto'])).toEqual({
      ok: false,
      message: SERVICES_MESSAGES.sharedGroup,
    });
    expect(planRemoval(lines, ['adulto', 'nino'])).toMatchObject({
      ok: true,
      providerItemIds: ['9'],
      totalMinor: 9000,
    });
  });

  it('un id que también nombra a otra línea viva (de otra alta) no sale: la quitaría sin verse', () => {
    const compartida = { providerItemIds: ['9'], providerItemIdsShared: true };
    const lines = [
      linea('adulto', compartida),
      linea('nino', { ...compartida, addedOperationId: 'op-2' }),
    ];
    // Grupos distintos (otra alta), pero el mismo id en la aerolínea.
    expect(removalGroupOf(lines[0]!)).not.toBe(removalGroupOf(lines[1]!));
    expect(planRemoval(lines, ['adulto'])).toEqual({
      ok: false,
      message: SERVICES_MESSAGES.sharedGroup,
    });
    // Una en duda también cuenta: puede seguir en la reserva.
    expect(
      planRemoval(
        [linea('a'), linea('b', { providerItemIds: ['Xa'], status: 'unverified' })],
        ['a'],
      ),
    ).toMatchObject({ ok: false });
    // Una ya quitada no.
    expect(
      planRemoval([linea('a'), linea('b', { providerItemIds: ['Xa'], status: 'removed' })], ['a']),
    ).toMatchObject({ ok: true, providerItemIds: ['Xa'] });
  });

  it('quitada es la que tiene todas sus ids confirmadas; el resto queda en duda', () => {
    const lines = [linea('a'), linea('b')];
    const { removed, pending } = removedLinesOf(lines, {
      outcome: 'UNVERIFIED',
      removed: ['Xa'],
      failed: [],
      unverified: ['Xb'],
      issues: [],
    });
    expect(removed.map((l) => l.id)).toEqual(['a']);
    expect(pending.map((l) => l.id)).toEqual(['b']);
  });
});

describe('la operación en el historial', () => {
  it('nunca se reintenta desde ahí; pendiente o en duda se concilia', () => {
    expect(servicesOperationPolicy('success', {})).toEqual({
      retryable: false,
      reconciliationRequired: false,
    });
    expect(servicesOperationPolicy('pending', {})).toMatchObject({ reconciliationRequired: true });
    expect(servicesOperationPolicy('failed', { reconciliationRequired: false })).toMatchObject({
      reconciliationRequired: false,
    });
    expect(servicesOperationPolicy('failed', { reconciliationRequired: true })).toMatchObject({
      reconciliationRequired: true,
    });
    // Ilegible = en duda: no se repite sin mirar.
    expect(servicesOperationPolicy('failed', null)).toMatchObject({ reconciliationRequired: true });
  });

  it('bloquea un cambio nuevo sólo lo que quedó en duda', () => {
    expect(servicesOperationBlocks('success', {})).toBe(false);
    expect(servicesOperationBlocks('failed', { reconciliationRequired: false })).toBe(false);
    expect(servicesOperationBlocks('failed', { reconciliationRequired: true })).toBe(true);
  });
});
