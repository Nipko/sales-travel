import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../../actions';
import type { RateSelection } from '../../_components/hotel-rate-selection';
import {
  acceptedPrebookOf,
  checkoutExpiryNotice,
  continueGate,
  isRetryablePrebookStatus,
  parsePrebook,
  priceChangeView,
  signalsView,
  type HotelPrebook,
  type HotelPrebookRepricing,
} from './prebook-view';

const PREBOOK_REF = '0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b';

/** Neto 305,75 USD; venta 321,34 USD por el piso del proveedor (docs/tbo/02 §9.5). */
const ROOMPACK: HotelRoompack = {
  id: 'pack-1',
  provider: {
    name: 'tbo-hotels',
    offerRef: '1402689!TB!1!TB!3f9c',
    raw: { searchId: 'b1d4c1c2-6a8e-4c7f-9d0e-3f2a1b0c9d8e' },
  },
  board: 'RO',
  boardLabel: 'Solo alojamiento',
  rooms: [{ name: 'Deluxe King', reference: 1, bedOptions: [] }],
  cancellation: {
    refundable: true,
    status: 'partially_refundable',
    policySource: 'prebook-final',
    freeCancellationUntilLocal: '2026-10-10T23:59:59',
    rules: [
      { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-10-11T00:00:00' },
    ],
  },
  price: { total: { amountMinor: 30575, currency: 'USD' }, taxesDetail: [] },
  pricing: { costMinor: 30575, finalMinor: 32134, ownMarkupMinor: 0, currency: 'USD' },
  atPropertyCharges: [
    { roomIndex: 1, description: 'City tax', amount: { amountMinor: 2000, currency: 'AED' } },
  ],
};

function apiResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prebookRef: PREBOOK_REF,
    providerCode: 'tbo-hotels',
    hotelId: '1402689',
    expiresAt: '2026-09-26T12:27:00.000Z',
    roompack: ROOMPACK,
    rateConditions: [
      { category: 'checkIn', text: 'CheckIn Time-Begin: 3:00 PM' },
      { category: 'mandatoryFees', text: '• City tax AED 20 per night' },
    ],
    signals: [],
    repricing: {
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: { amountMinor: 30575, currency: 'USD' },
      currentTotal: { amountMinor: 30575, currency: 'USD' },
    },
    warnings: ['BOOKING_CODE_CHANGED'],
    ...overrides,
  };
}

function prebook(repricing: Partial<HotelPrebookRepricing> = {}, finalMinor = 32134): HotelPrebook {
  return {
    prebookRef: PREBOOK_REF,
    providerCode: 'tbo-hotels',
    hotelId: '1402689',
    expiresAt: '2026-09-26T12:27:00.000Z',
    roompack: {
      ...ROOMPACK,
      pricing: { costMinor: 30575, finalMinor, ownMarkupMinor: 0, currency: 'USD' },
    },
    rateConditions: [],
    signals: [],
    repricing: { outcome: 'UNCHANGED', price: 'SAME', changes: [], ...repricing },
  };
}

const SHOWN = { amountMinor: 32134, currency: 'USD' };

describe('parsePrebook — la respuesta del PreBook neutral', () => {
  it('lee una tarifa revalidada completa', () => {
    const parsed = parsePrebook(apiResponse());
    expect(parsed?.prebookRef).toBe(PREBOOK_REF);
    expect(parsed?.roompack.cancellation.policySource).toBe('prebook-final');
    expect(parsed?.rateConditions).toHaveLength(2);
  });

  it('no deja pasar los netos de la comparación ni los avisos técnicos (G3)', () => {
    const parsed = parsePrebook(apiResponse());
    expect(parsed?.repricing).toEqual({ outcome: 'UNCHANGED', price: 'SAME', changes: [] });
    expect(JSON.stringify(parsed)).not.toContain('previousTotal');
    expect(parsed).not.toHaveProperty('warnings');
  });

  it('trae el aviso de cartera del API; sin él, la tarifa se lee igual y decide el Book', () => {
    const message =
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.';
    expect(
      parsePrebook(
        apiResponse({
          funding: {
            status: 'blocked',
            currency: 'USD',
            reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
            message,
          },
        }),
      )?.funding,
    ).toEqual({ status: 'blocked', reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED', message });
    const sinAviso = parsePrebook(apiResponse());
    expect(sinAviso?.prebookRef).toBe(PREBOOK_REF);
    expect(sinAviso).not.toHaveProperty('funding');
  });

  it('sin `prebookRef` válido, sin precio o con otro vocabulario no hay tarifa que aceptar', () => {
    expect(parsePrebook(apiResponse({ prebookRef: undefined }))).toBeUndefined();
    expect(parsePrebook(apiResponse({ prebookRef: 'abc' }))).toBeUndefined();
    expect(parsePrebook(apiResponse({ expiresAt: 'mañana' }))).toBeUndefined();
    expect(
      parsePrebook(apiResponse({ roompack: { ...ROOMPACK, price: { taxesDetail: [] } } })),
    ).toBeUndefined();
    expect(parsePrebook(apiResponse({ roompack: { ...ROOMPACK, rooms: [] } }))).toBeUndefined();
    expect(
      parsePrebook(apiResponse({ repricing: { outcome: 'MAYBE', price: 'SAME', changes: [] } })),
    ).toBeUndefined();
    expect(parsePrebook(apiResponse({ signals: ['<b>solo paquete</b>'] }))).toBeUndefined();
    expect(parsePrebook(apiResponse({ rateConditions: [{ category: 'other' }] }))).toBeUndefined();
    expect(parsePrebook(null)).toBeUndefined();
  });

  it('una categoría que el API sume mañana va con las demás condiciones', () => {
    const parsed = parsePrebook(
      apiResponse({ rateConditions: [{ category: 'parking', text: 'Parking USD 10' }] }),
    );
    expect(parsed?.rateConditions).toEqual([{ category: 'other', text: 'Parking USD 10' }]);
  });
});

describe('isRetryablePrebookStatus', () => {
  it('se reintenta ante un fallo de transporte o del proveedor', () => {
    for (const status of [500, 502, 503, 504, 429, 408]) {
      expect(isRetryablePrebookStatus(status)).toBe(true);
    }
  });

  it('no ante lo que ya dijo qué cambió: se vuelve al hotel', () => {
    for (const status of [400, 403, 404, 409]) expect(isRetryablePrebookStatus(status)).toBe(false);
  });
});

describe('priceChangeView — el aviso de cambio (U-09, D-TBO-20 A)', () => {
  it('sin cambios no hay aviso', () => {
    expect(priceChangeView(prebook(), SHOWN)).toBeUndefined();
  });

  it('si sube, antes y ahora en precio de VENTA, y hay que aceptarlo', () => {
    const view = priceChangeView(prebook({ outcome: 'INCREASED', price: 'UP' }, 33500), SHOWN);
    expect(view).toMatchObject({
      tone: 'warning',
      title: 'El precio subió al revalidar la tarifa.',
      requiresAcceptance: true,
    });
    expect(view?.before).toMatch(/321,34/);
    expect(view?.after).toMatch(/335,00/);
    expect(view?.delta).toMatch(/^\+ .*13,66/);
    expect(view?.acceptLabel).toMatch(/335,00/);
  });

  it('si sube y además cambian condiciones, la aceptación cubre las dos cosas', () => {
    const view = priceChangeView(
      prebook({ outcome: 'CONDITIONS_CHANGED', price: 'UP', changes: ['MEAL_TYPE'] }, 33500),
      SHOWN,
    );
    expect(view).toMatchObject({
      title: 'El precio subió al revalidar la tarifa.',
      changes: 'Qué cambió: el régimen de comidas.',
      requiresAcceptance: true,
    });
    expect(view?.acceptLabel).toMatch(/^Revisé los cambios y acepto el precio nuevo de .*335,00/);
  });

  it('nunca muestra el neto del proveedor', () => {
    const view = priceChangeView(prebook({ outcome: 'INCREASED', price: 'UP' }, 33500), SHOWN);
    expect(JSON.stringify(view)).not.toMatch(/305,75/);
  });

  it('si baja, se avisa y se sigue sin aceptar nada', () => {
    const view = priceChangeView(prebook({ outcome: 'DECREASED', price: 'DOWN' }, 31000), SHOWN);
    expect(view).toMatchObject({ tone: 'success', requiresAcceptance: false });
    expect(view?.delta).toMatch(/^− .*11,34/);
  });

  it('si cambian las condiciones, dice cuáles y hay que aceptarlo aunque el precio no cambie', () => {
    const view = priceChangeView(
      prebook({
        outcome: 'CONDITIONS_CHANGED',
        price: 'SAME',
        changes: ['CANCEL_POLICIES', 'AT_PROPERTY_CHARGES', 'RATE_CONDITIONS'],
      }),
      SHOWN,
    );
    expect(view).toMatchObject({
      tone: 'warning',
      title: 'Cambiaron las condiciones de la tarifa.',
      changes:
        'Qué cambió: la política de cancelación, los cargos a pagar en el hotel y las condiciones del hotel.',
      requiresAcceptance: true,
    });
    expect(view?.delta).toBeUndefined();
    expect(view?.before).toBeUndefined();
  });

  it('condiciones nuevas con precio más bajo: también se acepta', () => {
    const view = priceChangeView(
      prebook({ outcome: 'CONDITIONS_CHANGED', price: 'DOWN', changes: ['REFUNDABLE'] }, 30000),
      SHOWN,
    );
    expect(view).toMatchObject({
      title: 'Cambiaron las condiciones y el precio bajó.',
      requiresAcceptance: true,
    });
  });

  it('otra moneda no se compara: se muestra el precio nuevo y se acepta', () => {
    const view = priceChangeView(
      prebook({ outcome: 'CONDITIONS_CHANGED', price: 'NOT_COMPARABLE', changes: ['CURRENCY'] }),
      { amountMinor: 1_300_000_00, currency: 'COP' },
    );
    expect(view).toMatchObject({
      title: 'Cambió la moneda de la tarifa.',
      requiresAcceptance: true,
    });
    expect(view?.delta).toBeUndefined();
  });

  it('el precio de venta se movió aunque el neto no (piso, otra regla): se acepta', () => {
    const view = priceChangeView(prebook({}, 32500), SHOWN);
    expect(view).toMatchObject({
      title: 'El precio subió al revalidar la tarifa.',
      requiresAcceptance: true,
    });
  });

  it('el neto cambió y el de venta no: se dice sin pedir nada (RF-15 CA-3)', () => {
    const view = priceChangeView(prebook({ outcome: 'INCREASED', price: 'UP' }), SHOWN);
    expect(view).toMatchObject({ tone: 'info', requiresAcceptance: false });
    expect(view?.before).toBeUndefined();
  });

  it('sin el precio que vio el vendedor, manda la dirección del servidor', () => {
    expect(
      priceChangeView(prebook({ outcome: 'INCREASED', price: 'UP' }), undefined),
    ).toMatchObject({
      requiresAcceptance: true,
    });
    expect(
      priceChangeView(prebook({ outcome: 'DECREASED', price: 'DOWN' }), undefined),
    ).toMatchObject({ tone: 'success', requiresAcceptance: false });
  });
});

describe('signalsView — señales críticas arriba (U-11, D-TBO-22 A)', () => {
  it('"sólo con aéreo" bloquea y va primero', () => {
    const view = signalsView(['NO_NAME_CHANGE', 'PACKAGE_WITH_FLIGHT_ONLY']);
    expect(view.blocking).toBe(true);
    expect(view.notices.map((n) => n.code)).toEqual(['PACKAGE_WITH_FLIGHT_ONLY', 'NO_NAME_CHANGE']);
    expect(view.notices[0]).toMatchObject({ tone: 'danger' });
  });

  it('las demás avisan sin bloquear; una desconocida también avisa', () => {
    const view = signalsView(['MARKET_RESTRICTION', 'NEW_SIGNAL', 'MARKET_RESTRICTION']);
    expect(view.blocking).toBe(false);
    expect(view.notices).toHaveLength(2);
    expect(view.notices.every((n) => n.tone === 'warning')).toBe(true);
  });

  it('sin señales, nada', () => {
    expect(signalsView([])).toEqual({ blocking: false, notices: [] });
  });
});

describe('checkoutExpiryNotice — el vencimiento de UNA tarifa (RF-09)', () => {
  it('avisa a los 20 minutos y al vencer', () => {
    expect(checkoutExpiryNotice({ phase: 'running' })).toBeUndefined();
    expect(checkoutExpiryNotice({ phase: 'warning' })?.title).toBe(
      'Quedan menos de 7 minutos para reservar esta tarifa.',
    );
    expect(checkoutExpiryNotice({ phase: 'expired' })).toMatchObject({
      tone: 'expired',
      title: 'La tarifa venció.',
    });
  });
});

describe('continueGate — qué falta para seguir', () => {
  const change = { requiresAcceptance: true };

  it('vencida no sigue, aunque esté aceptada', () => {
    expect(continueGate({ expired: true, blocked: false, change, accepted: true }).ok).toBe(false);
  });

  it('"sólo con aéreo" no sigue', () => {
    expect(
      continueGate({ expired: false, blocked: true, change: undefined, accepted: false }),
    ).toEqual({
      ok: false,
      reason: 'Esta tarifa no se puede reservar como hotel suelto.',
    });
  });

  it('un cambio que se acepta, sólo aceptado', () => {
    expect(continueGate({ expired: false, blocked: false, change, accepted: false }).ok).toBe(
      false,
    );
    expect(continueGate({ expired: false, blocked: false, change, accepted: true })).toEqual({
      ok: true,
    });
  });

  it('la cartera que no cubre la tarifa frena antes de los huéspedes, aunque todo lo demás esté bien', () => {
    const blocked = {
      status: 'blocked',
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
      message: 'x',
    } as const;
    expect(
      continueGate({
        expired: false,
        blocked: false,
        change: undefined,
        accepted: false,
        funding: blocked,
      }),
    ).toEqual({
      ok: false,
      reason:
        'Resolvé la cartera de la agencia antes de cargar los huéspedes: esta reserva se rechazaría.',
    });
    // Vencida o "sólo con aéreo" se dice primero: con esas, la cartera no cambia nada.
    expect(
      continueGate({
        expired: true,
        blocked: false,
        change: undefined,
        accepted: false,
        funding: blocked,
      }).reason,
    ).toMatch(/venció/);
    expect(
      continueGate({
        expired: false,
        blocked: false,
        change: undefined,
        accepted: false,
        funding: { status: 'ok' },
      }).ok,
    ).toBe(true);
  });

  it('si lo que no cubre es un nivel de la red, dice que hable con quien lo financia', () => {
    const gate = continueGate({
      expired: false,
      blocked: false,
      change: undefined,
      accepted: false,
      funding: { status: 'blocked', reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE', message: 'x' },
    });
    expect(gate).toEqual({
      ok: false,
      reason:
        'Hablá con quien te financia antes de cargar los huéspedes: esta reserva se rechazaría.',
    });
  });

  it('sin cambio o con una baja, sigue', () => {
    expect(
      continueGate({ expired: false, blocked: false, change: undefined, accepted: false }).ok,
    ).toBe(true);
    expect(
      continueGate({
        expired: false,
        blocked: false,
        change: { requiresAcceptance: false },
        accepted: false,
      }).ok,
    ).toBe(true);
  });
});

describe('acceptedPrebookOf — lo que recibe el paso 2', () => {
  it('el total aceptado es el precio de VENTA revalidado, el que el Book manda como acceptedTotal', () => {
    const accepted = acceptedPrebookOf(prebook({}, 33500), {} as RateSelection, -1500);
    expect(accepted.acceptedTotal).toEqual({ amountMinor: 33500, currency: 'USD' });
    expect(accepted.prebook.prebookRef).toBe(PREBOOK_REF);
    expect(accepted.clockOffsetMs).toBe(-1500);
  });
});
