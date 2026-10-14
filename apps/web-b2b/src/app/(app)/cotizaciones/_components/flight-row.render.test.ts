import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import { SOME_TEST_FARES_DESCRIPTION, TEST_FARE_DESCRIPTION } from '../../../../lib/test-content';
import { FareFamilyMatrix } from './fare-family-matrix';
import { FlightRow, type FlightGroup } from './flight-row';

/*
 * Una tarifa del entorno de pruebas del proveedor en los resultados de vuelos: la fila lo dice
 * aunque la pastilla del proveedor esté oculta, y cada tarjeta de tarifa dice si ESA es de pruebas.
 */

const money = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

function oferta(id: string, environment?: 'test' | 'live', fareFamily = 'LIGHT'): Offer {
  return {
    id,
    tenantId: '11111111-1111-4111-8111-111111111111',
    products: ['flight'],
    provider: {
      name: 'alfa-air',
      offerRef: `REF-${id}`,
      ...(environment === undefined ? {} : { environment }),
    },
    total: money(100_000),
    baseFare: money(80_000),
    taxes: money(20_000),
    itineraries: [
      {
        segments: [
          {
            carrier: 'LA',
            flightNumber: '2401',
            origin: 'BOG',
            destination: 'LIM',
            departureAt: '2026-12-01T08:00:00-05:00',
            arrivalAt: '2026-12-01T11:10:00-05:00',
            durationMinutes: 190,
            cabin: 'economy',
            bookingClass: 'Y',
          },
        ],
        totalDurationMinutes: 190,
        stops: 0,
      },
    ],
    fareFamily: { name: fareFamily, cabin: 'economy' },
    fetchedAt: '2026-10-13T12:00:00.000Z',
    expiresAt: '2026-10-13T12:30:00.000Z',
  };
}

const fmt = {
  formatMoney: (amountMinor: number, currency: string) => `${currency} ${amountMinor / 100}`,
  formatTime: (iso: string) => iso.slice(11, 16),
  formatDate: (iso: string) => iso.slice(0, 10),
  formatDuration: (minutes: number) => `${minutes} min`,
};

function fila(offers: Offer[], showProvider = false): string {
  const group: FlightGroup = { key: 'LA2401', offers };
  return renderToStaticMarkup(createElement(FlightRow, { group, ...fmt, showProvider }));
}

const ETIQUETA = /<span class="[^"]*color-warning[^"]*"[^>]*>.*?Prueba/;

describe('FlightRow — tarifas del entorno de pruebas del proveedor', () => {
  it('un vuelo con todas sus tarifas de pruebas lleva «Prueba» y explica qué es', () => {
    const html = fila([oferta('a', 'test'), oferta('b', 'test', 'FULL')]);

    expect(html).toMatch(ETIQUETA);
    expect(html).toContain(`title="${TEST_FARE_DESCRIPTION}"`);
  });

  it('la etiqueta va aunque la divulgación del proveedor esté apagada', () => {
    const html = fila([oferta('a', 'test')], false);

    expect(html).not.toContain('alfa-air');
    expect(html).toMatch(ETIQUETA);
  });

  it('un vuelo con tarifas reales y de pruebas avisa que ALGUNAS lo son', () => {
    const html = fila([oferta('a'), oferta('b', 'test', 'FULL')]);

    expect(html).toMatch(ETIQUETA);
    expect(html).toContain(`title="${SOME_TEST_FARES_DESCRIPTION}"`);
  });

  it('un vuelo real no lleva etiqueta, con o sin `live` explícito', () => {
    for (const html of [fila([oferta('a')]), fila([oferta('a', 'live')])]) {
      expect(html).not.toContain('Prueba');
      expect(html).not.toContain('color-warning');
    }
  });
});

describe('FareFamilyMatrix — cada tarjeta dice si su tarifa es de pruebas', () => {
  it('sólo la tarjeta de la tarifa de pruebas lleva la etiqueta, y se puede cotizar igual', () => {
    const html = renderToStaticMarkup(
      createElement(FareFamilyMatrix, {
        fares: [oferta('a', 'live', 'LIGHT'), oferta('b', 'test', 'FULL')],
        formatMoney: fmt.formatMoney,
        onQuote: () => Promise.resolve(),
      }),
    );

    expect(html.match(/>Prueba<span class="sr-only">/g)).toHaveLength(1);
    // La etiqueta cae en la tarjeta FULL (la de pruebas), no en la LIGHT.
    const light = html.indexOf('>LIGHT<');
    const full = html.indexOf('>FULL<');
    const etiqueta = html.indexOf('>Prueba<span class="sr-only">');
    expect(light).toBeGreaterThan(-1);
    expect(etiqueta).toBeGreaterThan(full);
    expect(html.match(/Guardar Cotización/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Guardar Cotización/);
  });
});
