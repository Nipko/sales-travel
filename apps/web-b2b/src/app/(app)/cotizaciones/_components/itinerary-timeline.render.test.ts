import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import { formatMoney } from '../../../../lib/flight-format';
import { ItineraryTimeline } from './itinerary-timeline';
import { buildTimeline } from './itinerary-timeline-view';

const money = { amountMinor: 100_00, currency: 'USD' };

const offer: Offer = {
  id: 'o1',
  tenantId: 't1',
  products: ['flight'],
  provider: { name: 'sabre', offerRef: 'r' },
  total: money,
  baseFare: money,
  taxes: { amountMinor: 0, currency: 'USD' },
  fetchedAt: '2026-10-01T00:00:00Z',
  expiresAt: '2026-10-01T00:00:00Z',
  baggage: { carryOn: { qty: 1 }, checked: { qty: 0 } },
  itineraries: [
    {
      totalDurationMinutes: 345,
      stops: 1,
      segments: [
        {
          carrier: 'AV',
          flightNumber: '8020',
          origin: 'BOG',
          destination: 'LIM',
          departureAt: '2026-10-14T22:10:00-05:00',
          arrivalAt: '2026-10-15T01:20:00-05:00',
          durationMinutes: 190,
          cabin: 'economy',
          bookingClass: 'Y',
        },
        {
          carrier: 'AV',
          operatingCarrier: 'LA',
          flightNumber: '2041',
          origin: 'LIM',
          destination: 'CUZ',
          departureAt: '2026-10-15T02:30:00-05:00',
          arrivalAt: '2026-10-15T03:55:00-05:00',
          durationMinutes: 85,
          cabin: 'economy',
          bookingClass: 'Y',
        },
      ],
    },
  ],
};

describe('ItineraryTimeline', () => {
  const html = renderToStaticMarkup(
    createElement(ItineraryTimeline, { legs: buildTimeline(offer, formatMoney) }),
  );

  it('pinta el trayecto con sus vuelos, la escala y la llegada al día siguiente', () => {
    expect(html).toMatch(/<h3[^>]*>BOG → CUZ<\/h3>/);
    expect(html).toContain('22:10');
    expect(html).toContain('03:55');
    expect(html).toContain('(llega 1 día después)');
    expect(html).toContain('Escala en LIM · 1h 10m');
    expect(html).toContain('AV 8020');
  });

  it('dice quién opera el tramo en código compartido', () => {
    expect(html).toContain('Operado por LATAM');
  });

  it('lista qué incluye la tarifa, con el estado escrito', () => {
    expect(html).toContain('aria-label="Qué incluye la tarifa"');
    expect(html).toContain('Equipaje de mano');
    expect(html).toContain('Sin maleta facturada');
  });

  it('sin vuelos lo dice en vez de quedar en blanco', () => {
    expect(renderToStaticMarkup(createElement(ItineraryTimeline, { legs: [] }))).toContain(
      'El proveedor no informó el detalle de los vuelos.',
    );
  });
});
