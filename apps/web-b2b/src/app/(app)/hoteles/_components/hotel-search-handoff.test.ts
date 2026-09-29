import { describe, expect, it } from 'vitest';
import type { HotelOffer } from '../actions';
import { decodeHotelKey } from './hotel-key';
import {
  detailLinkForOffer,
  HANDOFF_MAX_ENTRIES,
  HANDOFF_TTL_MS,
  handoffFor,
  hotelDetailLink,
  isSearchToken,
  newSearchToken,
  parseHandoffs,
  parseStay,
  stayOfCriteria,
  withHandoff,
  type SearchHandoff,
} from './hotel-search-handoff';

const STAY = {
  checkinDate: '2026-10-12',
  checkoutDate: '2026-10-15',
  rooms: [
    { adults: 2, childrenAges: [5] },
    { adults: 1, childrenAges: [] },
  ],
  guestNationality: 'CO',
  refundableOnly: false,
};

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

function handoff(savedAt: number, show = false): SearchHandoff {
  return { stay: STAY, showProviderInResults: show, savedAt };
}

describe('parseStay — la estadía que se vuelve a pedir', () => {
  it('acepta una estadía completa dentro de los topes', () => {
    expect(parseStay(STAY)).toEqual(STAY);
  });

  it('sin nacionalidad válida no hay estadía: nunca un valor por defecto (RF-06)', () => {
    expect(parseStay({ ...STAY, guestNationality: '' })).toBeUndefined();
    expect(parseStay({ ...STAY, guestNationality: 'Colombia' })).toBeUndefined();
    expect(parseStay({ ...STAY, guestNationality: 'COL' })).toBeUndefined();
  });

  it('rechaza fechas, habitaciones y edades fuera del borde', () => {
    expect(parseStay({ ...STAY, checkoutDate: '2026-10-12' })).toBeUndefined();
    expect(parseStay({ ...STAY, checkinDate: '12/10/2026' })).toBeUndefined();
    expect(parseStay({ ...STAY, rooms: [] })).toBeUndefined();
    expect(parseStay({ ...STAY, rooms: [{ adults: 0, childrenAges: [] }] })).toBeUndefined();
    expect(parseStay({ ...STAY, rooms: [{ adults: 2, childrenAges: [18] }] })).toBeUndefined();
    expect(
      parseStay({ ...STAY, rooms: Array.from({ length: 9 }, () => ({ adults: 1 })) }),
    ).toBeUndefined();
    expect(parseStay(null)).toBeUndefined();
  });

  it('`refundableOnly` sólo con `true`', () => {
    expect(parseStay({ ...STAY, refundableOnly: 'true' })?.refundableOnly).toBe(false);
    expect(parseStay({ ...STAY, refundableOnly: true })?.refundableOnly).toBe(true);
  });

  it('D-TBO-15: la moneda de la búsqueda viaja con la estadía', () => {
    expect(parseStay({ ...STAY, currency: 'USD' })).toEqual({ ...STAY, currency: 'USD' });
  });

  it('sin moneda también vale (la de la agencia, o una guardada antes del selector)', () => {
    expect(parseStay(STAY)).not.toHaveProperty('currency');
  });

  it('una moneda que no es un código ISO no se descarta callada: no hay estadía', () => {
    expect(parseStay({ ...STAY, currency: 'usd' })).toBeUndefined();
    expect(parseStay({ ...STAY, currency: 'DOLAR' })).toBeUndefined();
    expect(parseStay({ ...STAY, currency: 840 })).toBeUndefined();
  });
});

describe('parseHandoffs — lo guardado, sin confiar en su forma', () => {
  it('JSON roto o de otra forma: nada', () => {
    expect(parseHandoffs(null)).toEqual({});
    expect(parseHandoffs('{')).toEqual({});
    expect(parseHandoffs('[]')).toEqual({});
  });

  it('una entrada rota se descarta sin tirar las demás', () => {
    const ok = handoff(NOW, true);
    const raw = JSON.stringify({
      'token-bueno-1': ok,
      'token-malo-22': { stay: { ...STAY, guestNationality: 'XX' }, savedAt: NOW },
      'x!': ok,
    });
    expect(parseHandoffs(raw)).toEqual({ 'token-bueno-1': ok });
  });

  it('la divulgación sólo se lee encendida con `true` (RF-40 CA 6)', () => {
    const raw = JSON.stringify({
      'token-abcdef': { stay: STAY, savedAt: NOW, showProviderInResults: 'true' },
    });
    expect(parseHandoffs(raw)['token-abcdef']?.showProviderInResults).toBe(false);
  });
});

describe('withHandoff / handoffFor — plazo y tope', () => {
  it('una búsqueda vieja se olvida; la vigente se encuentra', () => {
    const entries = withHandoff(
      { 'token-viejo-1': handoff(NOW - HANDOFF_TTL_MS - 1) },
      'token-nuevo-1',
      handoff(NOW),
      NOW,
    );
    expect(Object.keys(entries)).toEqual(['token-nuevo-1']);
    expect(handoffFor(entries, 'token-nuevo-1', NOW)).toEqual(handoff(NOW));
    expect(handoffFor(entries, 'token-nuevo-1', NOW + HANDOFF_TTL_MS + 1)).toBeUndefined();
    expect(handoffFor(entries, 'token-otro-99', NOW)).toBeUndefined();
  });

  it('guarda sólo las más recientes', () => {
    let entries: Record<string, SearchHandoff> = {};
    for (let i = 0; i < HANDOFF_MAX_ENTRIES + 3; i += 1) {
      entries = withHandoff(entries, `token-${String(i).padStart(4, '0')}`, handoff(NOW + i), NOW);
    }
    expect(Object.keys(entries)).toHaveLength(HANDOFF_MAX_ENTRIES);
    expect(entries['token-0000']).toBeUndefined();
    expect(entries[`token-${String(HANDOFF_MAX_ENTRIES + 2).padStart(4, '0')}`]).toBeDefined();
  });
});

describe('dirección del detalle', () => {
  it('la nacionalidad no viaja en la URL: sólo la clave y el identificador de la búsqueda', () => {
    expect(isSearchToken(newSearchToken())).toBe(true);
    const link = hotelDetailLink('dGJvLWhvdGVscw', 'token-abcdef');
    expect(link).toEqual({
      pathname: '/hoteles/dGJvLWhvdGVscw',
      query: { busqueda: 'token-abcdef' },
    });
    expect(JSON.stringify(link)).not.toMatch(/CO|nacionalidad|2026/);
  });

  it('un identificador inválido no se pone', () => {
    expect(hotelDetailLink('abc', '<script>')).toEqual({ pathname: '/hoteles/abc' });
    expect(hotelDetailLink('abc', undefined)).toEqual({ pathname: '/hoteles/abc' });
  });

  it('de la tarjeta a la clave: el detalle pide cada hotel de la tarjeta', () => {
    const offer: HotelOffer = {
      hotelId: '555',
      roompacks: [],
      providerHotels: [
        { provider: 'despegar-hotels', hotelId: '555' },
        { provider: 'tbo-hotels', hotelId: '1402689' },
      ],
    };
    const link = detailLinkForOffer(offer, 'token-abcdef');
    expect(link?.query).toEqual({ busqueda: 'token-abcdef' });
    const key = /^\/hoteles\/(.+)$/.exec(link?.pathname ?? '')?.[1] ?? '';
    expect(decodeHotelKey(key)).toEqual(offer.providerHotels);
    expect(detailLinkForOffer({ hotelId: '1', roompacks: [] }, 'token-abcdef')).toBeUndefined();
  });

  it('la estadía sale del criterio de la búsqueda, con la ocupación por habitación', () => {
    expect(
      stayOfCriteria({
        checkinDate: STAY.checkinDate,
        checkoutDate: STAY.checkoutDate,
        occupancy: STAY.rooms,
        guestNationality: 'CO',
        refundableOnly: false,
      }),
    ).toEqual(STAY);
  });

  it('con la moneda que se eligió: el detalle pide sus tarifas en la misma', () => {
    expect(
      stayOfCriteria({
        checkinDate: STAY.checkinDate,
        checkoutDate: STAY.checkoutDate,
        occupancy: STAY.rooms,
        guestNationality: 'CO',
        refundableOnly: false,
        currency: 'USD',
      }),
    ).toEqual({ ...STAY, currency: 'USD' });
  });
});
