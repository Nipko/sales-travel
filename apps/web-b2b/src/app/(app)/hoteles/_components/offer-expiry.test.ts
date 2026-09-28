import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../actions';
import {
  formatRemaining,
  isRateExpired,
  OFFER_WARNING_REMAINING_MS,
  OFFER_WINDOW_MS,
  offerExpiryNotice,
  offerExpiryState,
  timerLabel,
} from './offer-expiry';

const MIN = 60_000;
const SEARCH_SENT = Date.parse('2026-10-01T15:00:00Z');
const EXPIRES = SEARCH_SENT + OFFER_WINDOW_MS;

function pack(id: string, expiresAt?: number): HotelRoompack {
  return {
    id,
    board: 'RO',
    rooms: [{ name: 'Doble', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: 100, currency: 'USD' }, taxesDetail: [] },
    ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
  };
}

const soloConVencimiento = [{ roompacks: [pack('T1', EXPIRES), pack('T2', EXPIRES)] }];
const mezcla = [{ roompacks: [pack('D1'), pack('T1', EXPIRES)] }];

describe('RF-09 — la ventana de 27 minutos y el aviso a los 20', () => {
  it('el aviso llega cuando faltan 7 minutos: a los 20 de la búsqueda', () => {
    expect(OFFER_WARNING_REMAINING_MS).toBe(7 * MIN);
  });

  it('recién buscado: contando, sin aviso', () => {
    const state = offerExpiryState(soloConVencimiento, SEARCH_SENT + 1 * MIN);
    expect(state.phase).toBe('running');
    expect(state.remainingMs).toBe(26 * MIN);
    expect(offerExpiryNotice(state)).toBeUndefined();
  });

  it('a los 19:59 todavía no avisa; a los 20:00 sí', () => {
    expect(offerExpiryState(soloConVencimiento, SEARCH_SENT + 20 * MIN - 1000).phase).toBe(
      'running',
    );
    const state = offerExpiryState(soloConVencimiento, SEARCH_SENT + 20 * MIN);
    expect(state.phase).toBe('warning');
    expect(offerExpiryNotice(state)).toMatchObject({
      tone: 'warning',
      title: 'Quedan menos de 7 minutos para reservar estas tarifas.',
    });
  });

  it('vencidas: todas marcadas y el aviso pide buscar de nuevo', () => {
    const state = offerExpiryState(soloConVencimiento, EXPIRES);
    expect(state).toMatchObject({ phase: 'expired', expired: 2, cutoffMs: EXPIRES });
    expect(offerExpiryNotice(state)).toEqual({
      tone: 'expired',
      title: 'Las tarifas vencieron.',
      detail: 'Buscá de nuevo para ver precios vigentes antes de reservar.',
    });
  });

  it('sin ninguna tarifa con vencimiento no hay contador ni aviso', () => {
    const state = offerExpiryState([{ roompacks: [pack('D1'), pack('D2')] }], EXPIRES + 60 * MIN);
    expect(state.phase).toBe('none');
    expect(offerExpiryNotice(state)).toBeUndefined();
  });

  it('con tarifas de un proveedor sin plazo, el aviso habla sólo de las que vencen', () => {
    const running = offerExpiryState(mezcla, SEARCH_SENT + 1 * MIN);
    expect(timerLabel(running)).toBe('1 tarifa vence en');

    const warning = offerExpiryState(mezcla, SEARCH_SENT + 21 * MIN);
    expect(offerExpiryNotice(warning)?.title).toBe(
      'Quedan menos de 7 minutos para reservar algunas de estas tarifas.',
    );

    const expired = offerExpiryState(mezcla, EXPIRES + 1000);
    expect(offerExpiryNotice(expired)?.title).toBe('1 tarifa venció y quedó marcada en la lista.');
  });

  it('un `expiresAt` ilegible no vence ni rompe la cuenta', () => {
    const roto = { ...pack('X'), expiresAt: 'no-es-fecha' };
    const state = offerExpiryState([{ roompacks: [roto] }], EXPIRES);
    expect(state.phase).toBe('none');
    expect(isRateExpired('no-es-fecha', EXPIRES)).toBe(false);
  });
});

describe('isRateExpired', () => {
  it('vence en el instante exacto, no antes', () => {
    const at = new Date(EXPIRES).toISOString();
    expect(isRateExpired(at, EXPIRES - 1)).toBe(false);
    expect(isRateExpired(at, EXPIRES)).toBe(true);
  });

  it('una tarifa sin plazo nunca vence en pantalla', () => {
    expect(isRateExpired(undefined, EXPIRES)).toBe(false);
  });
});

describe('formatRemaining', () => {
  it('m:ss, redondeando hacia arriba', () => {
    expect(formatRemaining(26 * MIN)).toBe('26:00');
    expect(formatRemaining(6 * MIN + 59_001)).toBe('7:00');
    expect(formatRemaining(1)).toBe('0:01');
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-5000)).toBe('0:00');
  });
});
