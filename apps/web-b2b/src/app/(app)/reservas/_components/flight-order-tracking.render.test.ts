import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FlightDeadlineBadge,
  FlightOrderTracking,
  type FlightTrackingOrder,
} from './flight-order-tracking';

/*
 * El detalle de una reserva de vuelo con lo guardado de su última lectura (0082), en su primer
 * pintado: los localizadores con su botón de copiar, los tiquetes con su estado y el plazo.
 */

const TRACKING = {
  airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
  documents: [
    { number: '0457123456789', kind: 'TICKET', status: 'ISSUED', travelerIndex: 0 },
    { number: '0457123456790', kind: 'TICKET', status: 'UNKNOWN', travelerIndex: 1 },
  ],
  ticketingDeadline: { date: '2099-10-20', time: '23:59', zone: 'PROVIDER_LOCAL' },
};

function orden(over: Partial<FlightTrackingOrder> = {}): FlightTrackingOrder {
  return {
    status: 'confirmed',
    flightTracking: TRACKING,
    passengers: [
      { givenName: 'Ana', surname: 'Ríos' },
      { givenName: 'Luis', surname: 'Paz' },
    ],
    ...over,
  };
}

function pintar(order: FlightTrackingOrder): string {
  return renderToStaticMarkup(createElement(FlightOrderTracking, { order }));
}

describe('FlightOrderTracking', () => {
  it('el localizador de la aerolínea va en un chip con su botón «Copiar» accesible', () => {
    const html = pintar(orden());
    expect(html).toContain('Localizadores de la aerolínea');
    expect(html).toContain('LA · XKCD12');
    expect(html).toContain('aria-label="Copiar localizador XKCD12"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-live="polite"');
  });

  it('los tiquetes con número, pasajero y estado escrito', () => {
    const html = pintar(orden());
    expect(html).toContain('Tiquetes');
    expect(html).toContain('0457123456789');
    expect(html).toContain('Ana Ríos');
    expect(html).toContain('Emitido');
    expect(html).toContain('Luis Paz');
    expect(html).toContain('Sin confirmar');
  });

  it('el plazo de una confirmada, con la hora local de la oficina emisora', () => {
    const html = pintar(orden());
    expect(html).toContain('Plazo de emisión');
    expect(html).toContain('Emitir antes del');
    expect(html).toContain('23:59 (hora local de la oficina emisora)');
  });

  it('una emitida no muestra plazo, y sí sus tiquetes', () => {
    const html = pintar(orden({ status: 'ticketed' }));
    expect(html).not.toContain('Plazo de emisión');
    expect(html).toContain('0457123456789');
  });

  it('una confirmada sin localizador lo dice, en vez de callarlo', () => {
    const html = pintar(orden({ flightTracking: null }));
    expect(html).toContain('La aerolínea todavía no informó su localizador.');
    expect(html).not.toContain('Tiquetes');
  });

  it('una emitida sin números de tiquete también lo dice', () => {
    const html = pintar(orden({ status: 'ticketed', flightTracking: null }));
    expect(html).toContain('Todavía no tenemos los números de tiquete.');
  });

  it('con una lectura guardada que no los trajo, no manda a consultar otra vez', () => {
    const vacio = { airlineLocators: [], documents: [], ticketingDeadline: null };
    const html = pintar(orden({ status: 'ticketed', flightTracking: vacio }));
    expect(html).toContain('La aerolínea no informó su localizador en la última consulta.');
    expect(html).toContain('La última consulta no trajo números de tiquete.');
    expect(html).not.toContain('Consultar estado');
  });

  it('una fallida sin nada guardado no pinta nada', () => {
    expect(pintar(orden({ status: 'failed', flightTracking: null }))).toBe('');
  });

  it('una cancelada sigue mostrando lo que se guardó (un tiquete anulado se ve)', () => {
    const html = pintar(
      orden({
        status: 'cancelled',
        flightTracking: {
          ...TRACKING,
          documents: [
            { number: '0457123456789', kind: 'TICKET', status: 'VOIDED', travelerIndex: 0 },
          ],
        },
      }),
    );
    expect(html).toContain('Anulado');
    expect(html).not.toContain('Plazo de emisión');
  });
});

describe('FlightDeadlineBadge — el plazo en la fila de la lista', () => {
  it('el guardado de la reserva gana al de la tarifa', () => {
    const html = renderToStaticMarkup(
      createElement(FlightDeadlineBadge, {
        order: orden({
          selectedOffer: { provider: { raw: { lastTicketDate: '2099-10-01' } } },
        }),
      }),
    );
    expect(html).toContain('hora local de la oficina emisora');
    expect(html).not.toContain('Plazo de la tarifa');
  });

  it('sin plazo guardado, el de la tarifa; sin ninguno, nada', () => {
    const tarifa = renderToStaticMarkup(
      createElement(FlightDeadlineBadge, {
        order: orden({
          flightTracking: null,
          selectedOffer: { provider: { raw: { lastTicketDate: '2099-10-01' } } },
        }),
      }),
    );
    expect(tarifa).toContain('Plazo de la tarifa');
    expect(
      renderToStaticMarkup(
        createElement(FlightDeadlineBadge, { order: orden({ flightTracking: null }) }),
      ),
    ).toBe('');
  });
});
