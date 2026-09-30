import { describe, expect, it } from 'vitest';
import type { HotelCancellation, HotelRoompack } from '../../actions';
import { checkGuestDraft, emptyGuestDraft } from './guest-form-view';
import {
  NON_REFUNDABLE_FIELD,
  NON_REFUNDABLE_REQUIRED,
  nonRefundableAckKey,
  nonRefundableAckLabel,
  nonRefundableAt,
  nonRefundableForTotal,
  nonRefundableNoticeView,
  parseNonRefundable,
} from './non-refundable-view';
import { cancelPolicyView } from './conditions-view';
import { parsePrebook } from './prebook-view';

/** 25/09/2026 15:00 UTC: en UTC+14 ya son las 05:00 del 26. */
const AHORA = Date.parse('2026-09-25T15:00:00Z');

function pack(cancellation: HotelCancellation): HotelRoompack {
  return {
    id: 'pack-1',
    provider: { name: 'tbo-hotels', offerRef: 'BC-1', raw: { searchId: 's-1' } },
    board: 'RO',
    rooms: [{ name: 'Doble', reference: 1, bedOptions: [] }],
    cancellation,
    price: { total: { amountMinor: 30_575, currency: 'USD' }, taxesDetail: [] },
    pricing: { costMinor: 30_575, finalMinor: 32_134, ownMarkupMinor: 0, currency: 'USD' },
  };
}

const NO_REEMBOLSABLE: HotelCancellation = {
  refundable: false,
  status: 'non_refundable',
  rules: [],
  policySource: 'prebook-final',
};

const CIEN_VIGENTE: HotelCancellation = {
  refundable: true,
  status: 'fully_refundable',
  rules: [
    { type: 'Percentage', penaltyPercentage: 0, fromLocalDateTime: '2026-09-20T00:00:00' },
    { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-09-25T23:00:00' },
  ],
  policySource: 'prebook-final',
  freeCancellationUntilLocal: '2026-09-25T23:00:00',
};

const GRATIS: HotelCancellation = {
  ...CIEN_VIGENTE,
  rules: [
    { type: 'Percentage', penaltyPercentage: 0, fromLocalDateTime: '2026-09-20T00:00:00' },
    { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-11-05T00:00:00' },
  ],
  freeCancellationUntilLocal: '2026-11-05T00:00:00',
};

describe('parseNonRefundable — lo que dice el servidor', () => {
  it('lee el del PreBook y el de un rechazo del Book (`nonRefundableReason`)', () => {
    expect(
      parseNonRefundable({ reason: 'declared', penalty: { amountMinor: 100, currency: 'USD' } }),
    ).toEqual({ reason: 'declared', penalty: { amountMinor: 100, currency: 'USD' } });
    expect(
      parseNonRefundable({
        nonRefundableReason: 'full-penalty-in-force',
        penalty: { amountMinor: 100, currency: 'USD' },
        fullPenaltySinceLocal: '2026-09-25T23:00:00',
      }),
    ).toEqual({
      reason: 'full-penalty-in-force',
      penalty: { amountMinor: 100, currency: 'USD' },
      fullPenaltySinceLocal: '2026-09-25T23:00:00',
    });
  });

  it('sin importe legible no hay aviso; un motivo desconocido es "declarada"', () => {
    expect(parseNonRefundable(undefined)).toBeUndefined();
    expect(parseNonRefundable({ reason: 'declared' })).toBeUndefined();
    expect(parseNonRefundable({ penalty: { amountMinor: 1.5, currency: 'USD' } })).toBeUndefined();
    expect(
      parseNonRefundable({
        reason: 'otro',
        penalty: { amountMinor: 1, currency: 'usd' },
      }),
    ).toBeUndefined();
    expect(
      parseNonRefundable({
        reason: 'otro',
        penalty: { amountMinor: 1, currency: 'USD' },
        fullPenaltySinceLocal: 'mañana',
      }),
    ).toEqual({ reason: 'declared', penalty: { amountMinor: 1, currency: 'USD' } });
  });

  it('el PreBook lo trae en `nonRefundable`', () => {
    const prebook = parsePrebook({
      prebookRef: '0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b',
      providerCode: 'tbo-hotels',
      hotelId: '1402689',
      expiresAt: '2026-09-25T15:27:00Z',
      roompack: pack(NO_REEMBOLSABLE),
      rateConditions: [],
      signals: [],
      repricing: { outcome: 'UNCHANGED', price: 'SAME', changes: [] },
      nonRefundable: { reason: 'declared', penalty: { amountMinor: 32_134, currency: 'USD' } },
    });
    expect(prebook?.nonRefundable).toEqual({
      reason: 'declared',
      penalty: { amountMinor: 32_134, currency: 'USD' },
    });
  });
});

describe('nonRefundableAt — lo del servidor, o lo que el reloj ya volvió no reembolsable', () => {
  it('manda lo que dijo el servidor', () => {
    const nr = { reason: 'declared' as const, penalty: { amountMinor: 1, currency: 'USD' } };
    expect(nonRefundableAt({ roompack: pack(GRATIS), nonRefundable: nr }, AHORA)).toBe(nr);
  });

  it('declarada, con el precio de VENTA como el 100 %', () => {
    expect(nonRefundableAt({ roompack: pack(NO_REEMBOLSABLE) }, AHORA)).toEqual({
      reason: 'declared',
      penalty: { amountMinor: 32_134, currency: 'USD' },
    });
  });

  it('reembolsable con el 100 % que ya puede regir en la hora del hotel', () => {
    expect(nonRefundableAt({ roompack: pack(CIEN_VIGENTE) }, AHORA)).toEqual({
      reason: 'full-penalty-in-force',
      penalty: { amountMinor: 32_134, currency: 'USD' },
      fullPenaltySinceLocal: '2026-09-25T23:00:00',
    });
  });

  it('con la cancelación gratis vigente, no', () => {
    expect(nonRefundableAt({ roompack: pack(GRATIS) }, AHORA)).toBeUndefined();
  });
});

describe('los textos: el 100 % con su monto, sin rodeos', () => {
  const nr = {
    reason: 'full-penalty-in-force' as const,
    penalty: { amountMinor: 32_134, currency: 'USD' },
    fullPenaltySinceLocal: '2026-09-25T23:00:00',
  };

  it('el aviso dice cuánto, que no se recupera, de dónde sale y quién responde', () => {
    const view = nonRefundableNoticeView(nr);
    expect(view.title).toBe('Tarifa no reembolsable');
    expect(view.amount).toMatch(/^321,34\s(US\$|USD)$/);
    expect(view.lead).toBe(
      'Si se cancela, se modifica o el pasajero no se presenta, se cobra el 100 %:',
    );
    expect(view.points).toEqual([
      'No se recupera: ni la agencia ni el cliente reciben un reembolso.',
      'Se descuenta de la cartera o del crédito de la agencia en USD.',
      'La agencia responde ante su cliente por ese monto.',
    ]);
    expect(view.since).toMatch(/rige desde el 25 sept? 2026, 23:00 \(hora local del hotel\)/);
    const { fullPenaltySinceLocal: _drop, ...declarada } = nr;
    expect(nonRefundableNoticeView({ ...declarada, reason: 'declared' })).not.toHaveProperty(
      'since',
    );
  });

  it('con la cuenta propia de la agencia, el 100 % lo cobra el proveedor en esa cuenta, no una cartera', () => {
    expect(nonRefundableNoticeView(nr, { ownAccount: true }).points).toEqual([
      'No se recupera: ni la agencia ni el cliente reciben un reembolso.',
      'Lo cobra el proveedor en la cuenta de la agencia, en USD.',
      'La agencia responde ante su cliente por ese monto.',
    ]);
    expect(nonRefundableNoticeView(nr, { ownAccount: false }).points[1]).toBe(
      'Se descuenta de la cartera o del crédito de la agencia en USD.',
    );
  });

  it('la casilla lleva el monto exacto', () => {
    expect(nonRefundableAckLabel(nr)).toMatch(
      /^Entiendo que esta tarifa no es reembolsable: si se cancela, modifica o el pasajero no se presenta, se cobra el 100 % \(321,34\s(US\$|USD)\)\.$/,
    );
  });

  it('la política no promete una cancelación gratis que ya pasó', () => {
    expect(cancelPolicyView(pack(CIEN_VIGENTE), true)).toMatchObject({
      headline: 'No reembolsable: el cargo del 100 % ya rige.',
      refundable: false,
    });
    expect(cancelPolicyView(pack(CIEN_VIGENTE)).headline).toContain('Cancelación sin cargo');
    expect(cancelPolicyView(pack(NO_REEMBOLSABLE), true).headline).toBe('No reembolsable.');
  });
});

describe('checkGuestDraft — la casilla es obligatoria si la tarifa es no reembolsable', () => {
  const lleno = {
    ...emptyGuestDraft([{ adults: 1, childrenAges: [] }], 'CO'),
  };
  const draft = {
    rooms: [
      {
        guests: [
          {
            ...lleno.rooms[0]!.guests[0]!,
            title: 'Mr' as const,
            firstName: 'Juan',
            lastName: 'Pérez',
          },
        ],
      },
    ],
    contact: { email: 'ana@correo.com', phoneCountryCode: '+57', phoneNumber: '300 123 4567' },
  };

  it('sin marcar, el error va a su campo; marcada, pasa', () => {
    const sin = checkGuestDraft(
      draft,
      { required: false, acknowledged: false },
      { required: true, acknowledged: false },
    );
    expect(sin).toEqual({
      ok: false,
      issues: [{ path: NON_REFUNDABLE_FIELD, message: NON_REFUNDABLE_REQUIRED }],
    });
    expect(
      checkGuestDraft(
        draft,
        { required: false, acknowledged: false },
        { required: true, acknowledged: true },
      ).ok,
    ).toBe(true);
    // Una reembolsable no la pide.
    expect(checkGuestDraft(draft, { required: false, acknowledged: false }).ok).toBe(true);
  });
});

describe('paso 2 con un precio nuevo aceptado: el 100 % y la confirmación siguen al monto', () => {
  const delPrebook = nonRefundableAt({ roompack: pack(NO_REEMBOLSABLE) }, AHORA);
  const nuevo = { amountMinor: 35_000, currency: 'USD' };

  it('el 100 % de la casilla es el precio con que se reserva, no el del PreBook', () => {
    expect(delPrebook?.penalty).toEqual({ amountMinor: 32_134, currency: 'USD' });
    const conNuevo = nonRefundableForTotal(delPrebook, nuevo);
    expect(conNuevo).toEqual({ reason: 'declared', penalty: nuevo });
    expect(nonRefundableAckLabel(conNuevo!)).toMatch(/se cobra el 100 % \(350,00\s(US\$|USD)\)/);
    expect(nonRefundableForTotal(undefined, nuevo)).toBeUndefined();
  });

  it('una casilla marcada para un monto no vale para otro', () => {
    const antes = nonRefundableAckKey(nonRefundableForTotal(delPrebook, delPrebook!.penalty));
    const despues = nonRefundableAckKey(nonRefundableForTotal(delPrebook, nuevo));
    expect(antes).toBe('32134 USD');
    expect(despues).toBe('35000 USD');
    expect(antes).not.toBe(despues);
    expect(nonRefundableAckKey(undefined)).toBeUndefined();
  });
});
