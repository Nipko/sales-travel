import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import { FareFamilyMatrix } from './fare-family-matrix';

const money = (amountMinor: number) => ({ amountMinor, currency: 'USD' });
const segmento = (origin: string, destination: string) => ({
  carrier: 'AV',
  flightNumber: '10',
  origin,
  destination,
  departureAt: '2026-12-01T08:00:00-05:00',
  arrivalAt: '2026-12-01T10:00:00-05:00',
  durationMinutes: 120,
  cabin: 'economy',
  bookingClass: 'Y',
});

const oferta: Offer = {
  id: 'o',
  tenantId: 't',
  products: ['flight'],
  provider: { name: 'sabre', offerRef: 'r' },
  total: money(100_00),
  baseFare: money(80_00),
  taxes: money(20_00),
  itineraries: [
    { segments: [segmento('BOG', 'LET')], totalDurationMinutes: 120, stops: 0 },
    { segments: [segmento('LET', 'BOG')], totalDurationMinutes: 120, stops: 0 },
  ],
  fareComponents: [
    {
      segmentRefs: [0],
      brand: { code: 'XS', name: 'BASIC' },
      includes: [
        { kind: 'personal-item', status: 'included', label: 'PERSONAL ITEM' },
        { kind: 'carry-on', status: 'not-offered', label: 'CARRY ON' },
        { kind: 'checked-bag', status: 'charge', label: 'CHECKED BAG' },
      ],
    },
    { segmentRefs: [1], brand: { code: 'FL', name: 'FLEX' } },
  ],
  // La oferta entera dice maleta incluida: la tarjeta de la ida NO puede repetirlo.
  baggage: { checked: { qty: 1, weightKg: 23 } },
  fetchedAt: '',
  expiresAt: '',
};

const html = (leg: 0 | 1) =>
  renderToStaticMarkup(
    createElement(FareFamilyMatrix, {
      fares: [oferta],
      formatMoney: (m: number, c: string) => `${c} ${m / 100}`,
      mode: { leg, actionLabel: 'Elegir', priceLabel: 'Desde', confirmsSave: false },
    }),
  );

describe('FareFamilyMatrix por trayecto — lo que incluye la tarifa de ese trayecto', () => {
  it('pinta las maletas de la marca de la ida, no las de la oferta entera', () => {
    const out = html(0);
    expect(out).toContain('Incluye en la ida');
    expect(out).toContain('data-baggage="personalItem" data-state="yes"');
    expect(out).toContain('data-baggage="carryOn" data-state="no"');
    expect(out).toContain('data-baggage="checked" data-state="partial"');
    expect(out).not.toContain('23 kg');
  });

  it('sin atributos de marca en la vuelta lo rotula como del viaje completo', () => {
    const out = html(1);
    expect(out).toContain('Del viaje completo');
    expect(out).toContain('data-baggage="checked" data-state="yes"');
    expect(out).toContain('data-baggage="carryOn" data-state="unknown"');
  });
});
