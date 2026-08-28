import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import {
  canReserveAfterPriceCheck,
  displayedPriceChanged,
  readOfferPriceResponse,
  reservationGateMessage,
  withRevalidatedOffer,
  type PriceVerificationState,
} from './offer-price-flow';

function offer(id: string, amountMinor = 100_000): Offer {
  return {
    id,
    tenantId: 'tenant-1',
    products: ['flight'],
    provider: { name: 'sabre', offerRef: `${id}-ref`, raw: { priceOfferId: `${id}-po` } },
    total: { amountMinor, currency: 'USD' },
    baseFare: { amountMinor: amountMinor - 20_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    itineraries: [
      {
        totalDurationMinutes: 210,
        stops: 0,
        segments: [
          {
            carrier: 'AA',
            flightNumber: '100',
            origin: 'BOG',
            destination: 'MIA',
            departureAt: '2026-09-01T10:00:00Z',
            arrivalAt: '2026-09-01T13:30:00Z',
            durationMinutes: 210,
            cabin: 'economy',
            bookingClass: 'Y',
          },
        ],
      },
    ],
    fareComponents: [
      {
        segmentRefs: [0],
        brand: { code: 'MAIN', name: 'Main Cabin', programId: 7 },
        fareBasisCode: 'YMAIN',
        bookingClasses: ['Y'],
      },
    ],
    fetchedAt: '2026-08-27T10:00:00Z',
    expiresAt: '2026-08-27T10:30:00Z',
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('readOfferPriceResponse', () => {
  it('acepta únicamente el sobre completo y conserva fareComponents', async () => {
    const priced = offer('priced', 120_000);
    const out = await readOfferPriceResponse(
      response({ offer: priced, priceChanged: true, warnings: [] }),
      offer('original'),
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.offer.fareComponents).toEqual(priced.fareComponents);
  });

  it('bloquea si la revalidación pierde familias que la seleccionada sí tenía', async () => {
    const priced = { ...offer('priced'), fareComponents: undefined };
    const out = await readOfferPriceResponse(
      response({ offer: priced, priceChanged: false, warnings: [] }),
      offer('original'),
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('familias por trayecto');
  });

  it.each([400, 500])(
    'un HTTP %i con JSON de error nunca se interpreta como precio confirmado',
    async (status) => {
      const out = await readOfferPriceResponse(response({ error: 'Sabre no respondió' }, status));
      expect(out).toEqual({ ok: false, message: 'Sabre no respondió' });
    },
  );

  it.each([
    { offer: offer('x'), warnings: [] },
    { offer: { total: { amountMinor: 1, currency: 'USD' } }, priceChanged: false, warnings: [] },
    { offer: offer('x'), priceChanged: false },
  ])('rechaza un 200 con forma incompleta', async (body) => {
    const out = await readOfferPriceResponse(response(body));
    expect(out.ok).toBe(false);
  });
});

describe('reemplazo y compuerta de reserva', () => {
  it('reemplaza íntegramente la seleccionada por la revalidada', () => {
    const original = Object.assign(offer('old'), { onlyOnOld: true });
    const priced = offer('new', 125_000);
    const quotation = { selectedOffer: original, expiresAt: original.expiresAt, other: 'kept' };

    const next = withRevalidatedOffer(quotation, priced);

    expect(next.selectedOffer).toBe(priced);
    expect(next.selectedOffer.fareComponents).toBe(priced.fareComponents);
    expect(next.selectedOffer).not.toHaveProperty('onlyOnOld');
    expect(next.expiresAt).toBe(priced.expiresAt);
    expect(next.other).toBe('kept');
  });

  it('detecta también cambios del precio de venta aunque el proveedor diga false', () => {
    const before = offer('before');
    const after = {
      ...offer('after'),
      pricing: { costMinor: 100_000, finalMinor: 130_000, ownMarkupMinor: 30_000, currency: 'USD' },
    };
    expect(displayedPriceChanged(before, after, false)).toBe(true);
  });

  it('exige aceptación si cambia la familia aunque el importe sea idéntico', () => {
    const before = offer('before');
    const after = offer('after');
    after.fareComponents = [
      {
        segmentRefs: [0],
        brand: { code: 'FLEX', name: 'Flexible', programId: 99 },
        fareBasisCode: 'YFLEX',
        bookingClasses: ['B'],
      },
    ];

    expect(displayedPriceChanged(before, after, false)).toBe(true);
  });

  it('exige aceptación si cambia la cabina aunque el resto de la tarifa sea idéntico', () => {
    const before = offer('before');
    before.fareComponents = [{ ...before.fareComponents![0]!, cabin: 'ECONOMY' }];
    const after = offer('after');
    after.fareComponents = [{ ...after.fareComponents![0]!, cabin: 'PREMIUM_ECONOMY' }];

    expect(displayedPriceChanged(before, after, false)).toBe(true);
  });

  it('no trata como cambio comercial un programId enriquecido por Flight Check', () => {
    const before = offer('before');
    const after = offer('after');
    after.fareComponents = [
      {
        ...before.fareComponents![0]!,
        brand: { ...before.fareComponents![0]!.brand, programId: 42, programCode: 'NEW' },
      },
    ];

    expect(displayedPriceChanged(before, after, false)).toBe(false);
  });

  it('sólo habilita reserva después de confirmación; error y aceptación pendiente bloquean', () => {
    const states: Array<PriceVerificationState | null> = [
      null,
      { kind: 'error', message: 'falló' },
      { kind: 'acceptance-required', newTotal: 'USD 120' },
    ];
    for (const state of states) expect(canReserveAfterPriceCheck(state, false)).toBe(false);
    expect(canReserveAfterPriceCheck({ kind: 'confirmed', changed: false }, false)).toBe(true);
    expect(canReserveAfterPriceCheck({ kind: 'confirmed', changed: false }, true)).toBe(false);
    expect(reservationGateMessage(null, false)).toContain('Verificá');
  });
});
