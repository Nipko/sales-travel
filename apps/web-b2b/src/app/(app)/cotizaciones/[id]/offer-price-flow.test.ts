import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import {
  acceptRevalidatedPrice,
  displayedPriceChanged,
  isServerPriceChange,
  offersSeatSelection,
  PRICE_CHECK_FRESH_MS,
  priceChangeQuestion,
  priceStatusLine,
  readOfferPriceResponse,
  reserveDecision,
  seatsSurviveRevalidation,
  shouldAutoVerifyPrice,
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

describe('offersSeatSelection (SAB-16)', () => {
  it('sólo un `true` explícito del API ofrece elegir asientos', async () => {
    for (const [seatSelection, esperado] of [
      [true, true],
      [false, false],
      [undefined, false],
      ['true', false],
    ] as const) {
      const out = await readOfferPriceResponse(
        response({ offer: offer('x'), priceChanged: false, warnings: [], seatSelection }),
      );
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(offersSeatSelection(out.data), String(seatSelection)).toBe(esperado);
    }
  });
});

describe('reemplazo de la oferta revalidada', () => {
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
});

describe('revalidación automática al abrir la cotización', () => {
  it('corre en cotizaciones abiertas y no en las cerradas', () => {
    expect(shouldAutoVerifyPrice('draft')).toBe(true);
    expect(shouldAutoVerifyPrice('sent')).toBe(true);
    expect(shouldAutoVerifyPrice('expired')).toBe(true);
    expect(shouldAutoVerifyPrice('accepted')).toBe(false);
    expect(shouldAutoVerifyPrice('cancelled')).toBe(false);
  });

  it('la línea de estado dice qué pasa, sin pedirle nada al vendedor salvo reintentar un error', () => {
    expect(priceStatusLine(null, false)).toBeNull();
    expect(priceStatusLine(null, true)).toEqual({
      tone: 'pending',
      text: 'Verificando precio…',
      retry: false,
    });
    // Mientras revalida manda «Verificando», aunque haya un estado anterior.
    expect(priceStatusLine({ kind: 'error', message: 'falló' }, true)?.tone).toBe('pending');
    expect(priceStatusLine({ kind: 'confirmed', changed: false, checkedAt: 0 }, false)).toEqual({
      tone: 'ok',
      text: 'Precio confirmado',
      retry: false,
    });
    expect(priceStatusLine({ kind: 'error', message: 'Sabre no respondió' }, false)).toEqual({
      tone: 'error',
      text: 'Sabre no respondió',
      retry: true,
    });
    expect(
      priceStatusLine({ kind: 'acceptance-required', newTotal: 'USD 1.250', checkedAt: 0 }, false),
    ).toMatchObject({ tone: 'warning', retry: false, text: expect.stringContaining('USD 1.250') });
  });
});

describe('reserveDecision — qué hace el clic en «Reservar»', () => {
  const now = 1_000_000_000;

  it('sin revalidación, con error o con una vieja: revalida primero', () => {
    const states: Array<PriceVerificationState | null> = [
      null,
      { kind: 'error', message: 'falló' },
      { kind: 'confirmed', changed: false, checkedAt: now - PRICE_CHECK_FRESH_MS - 1 },
    ];
    for (const state of states)
      expect(reserveDecision(state, now), JSON.stringify(state)).toBe('revalidate');
  });

  it('con una confirmación fresca reserva en el mismo clic', () => {
    expect(reserveDecision({ kind: 'confirmed', changed: false, checkedAt: now }, now)).toBe('go');
    expect(
      reserveDecision(
        { kind: 'confirmed', changed: false, checkedAt: now - PRICE_CHECK_FRESH_MS },
        now,
      ),
    ).toBe('go');
    expect(
      reserveDecision({ kind: 'confirmed', changed: true, newTotal: 'USD 1', checkedAt: now }, now),
    ).toBe('go');
  });

  it('con un precio nuevo sin aceptar pregunta, por fresco que sea', () => {
    expect(
      reserveDecision({ kind: 'acceptance-required', newTotal: 'USD 1', checkedAt: now }, now),
    ).toBe('ask');
  });

  it('aceptar convierte la pregunta en una confirmación con la misma hora de revalidación', () => {
    expect(
      acceptRevalidatedPrice({ kind: 'acceptance-required', newTotal: 'USD 9', checkedAt: 42 }),
    ).toEqual({ kind: 'confirmed', changed: true, newTotal: 'USD 9', checkedAt: 42 });
    expect(priceChangeQuestion('USD 9')).toBe(
      'El precio cambió a USD 9. ¿Reservar con el nuevo precio?',
    );
  });

  it('los asientos sólo sobreviven a una revalidación sin cambios y con asientos ofrecidos', () => {
    const same: PriceVerificationState = { kind: 'confirmed', changed: false, checkedAt: 0 };
    expect(seatsSurviveRevalidation(same, true)).toBe(true);
    expect(seatsSurviveRevalidation(same, false)).toBe(false);
    expect(
      seatsSurviveRevalidation({ kind: 'acceptance-required', newTotal: 'x', checkedAt: 0 }, true),
    ).toBe(false);
    expect(seatsSurviveRevalidation({ kind: 'error', message: 'x' }, true)).toBe(false);
  });

  it('el 409 de precio o familia del servidor se trata como cambio de precio; otros 409 no', () => {
    expect(
      isServerPriceChange(
        409,
        'El precio cambió. Revalida la oferta y acepta el nuevo precio antes de reservar.',
      ),
    ).toBe(true);
    expect(
      isServerPriceChange(
        409,
        'La familia o la base tarifaria cambió. Revalida la oferta y acepta la nueva opción antes de reservar.',
      ),
    ).toBe(true);
    expect(
      isServerPriceChange(
        409,
        'La oferta revalidada ya venció o no tiene una vigencia válida. Vuelve a buscar antes de reservar.',
      ),
    ).toBe(false);
    expect(isServerPriceChange(400, 'El precio cambió.')).toBe(false);
    expect(isServerPriceChange(409, undefined)).toBe(false);
  });
});
