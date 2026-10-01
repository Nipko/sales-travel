import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HotelOffer, HotelRoompack } from '../actions';
import { HotelResultCard } from './hotel-result-card';
import {
  NO_FILTERS,
  applyResultsFilters,
  resultHotelsOf,
  resultsFacets,
  type ResultsFilters,
} from './hotel-results-filters';
import { ResultsFiltersPanel } from './hotel-results-filters-panel';

/*
 * La tarjeta y el panel de filtros en su primer pintado: lo que el vendedor no puede pasar por alto
 * de una tarifa no reembolsable (pedido del founder del 2026-09-29) y que la divulgación de
 * proveedor se respeta.
 */

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const noop = () => undefined;

function tarifa(id: string, saleMinor: number, extra: Partial<HotelRoompack> = {}): HotelRoompack {
  return {
    id,
    provider: { name: 'tbo-hotels', offerRef: `${id}-REF` },
    board: 'RO',
    rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: saleMinor, currency: 'COP' }, taxesDetail: [] },
    ...extra,
  };
}

const SOLO_NR: HotelOffer = {
  hotelId: '1',
  name: 'Hotel Solo No Reembolsable',
  stars: 3,
  address: 'Calle 10 # 5-72, La Candelaria',
  roompacks: [tarifa('A', 690_000_00), tarifa('B', 750_000_00, { board: 'BB' })],
};

function card(offer: HotelOffer, showProvider: boolean): string {
  const [item] = applyResultsFilters(resultHotelsOf([offer], showProvider, NOW), NO_FILTERS);
  return renderToStaticMarkup(
    createElement(HotelResultCard, { item: item!, photo: undefined, nights: 3, rooms: 1 }),
  );
}

describe('HotelResultCard', () => {
  it('"No reembolsable" a la vista y el aviso de que el hotel no tiene ninguna reembolsable', () => {
    const html = card(SOLO_NR, false);
    expect(html).toContain('No reembolsable');
    expect(html).toContain('var(--color-warning)');
    expect(html).toContain(
      'Este hotel no tiene tarifas reembolsables para estas fechas: si se cancela, se cobra el 100 %.',
    );
  });

  it('precio por noche grande, el total de la estadía y la zona en vez del ID técnico', () => {
    const html = card(SOLO_NR, false);
    expect(html).toMatch(/230\.000(,00)?\s*COP/);
    expect(html).toMatch(/Total 3 noches:.*690\.000(,00)?\s*COP/);
    expect(html).toContain('Calle 10 # 5-72, La Candelaria');
    expect(html).not.toContain('ID 1');
    expect(html).toContain('Ver 2 habitaciones');
  });

  it('sin divulgación no hay pastilla de proveedor; con ella, la de la tarifa del precio', () => {
    expect(card(SOLO_NR, false)).not.toContain('Proveedor: ');
    expect(card(SOLO_NR, true)).toContain('Proveedor: ');
  });
});

function panel(filters: ResultsFilters): string {
  const hotels = resultHotelsOf([SOLO_NR], false, NOW);
  return renderToStaticMarkup(
    createElement(ResultsFiltersPanel, {
      facets: resultsFacets(hotels, filters, false),
      filters,
      onChange: noop,
    }),
  );
}

describe('HotelResultCard — "Nuevo"', () => {
  it('sólo los que llegaron con el último "Ver más hoteles" llevan la marca, fuera del título', () => {
    const [item] = applyResultsFilters(resultHotelsOf([SOLO_NR], false, NOW), NO_FILTERS);
    const nuevo = renderToStaticMarkup(
      createElement(HotelResultCard, { item: item!, photo: undefined, fresh: true }),
    );
    expect(nuevo).toContain('Nuevo');
    // El título dice sólo el nombre: el foco que llega a él no lee "Nuevo" como parte del hotel.
    expect(nuevo).toMatch(/<h3[^>]*>Hotel Solo No Reembolsable<\/h3>/);

    expect(card(SOLO_NR, false)).not.toContain('Nuevo');
  });
});

describe('ResultsFiltersPanel', () => {
  it('"Solo reembolsables" sin hoteles que mostrar no se puede marcar', () => {
    const html = panel(NO_FILTERS);
    expect(html).toMatch(/<input type="checkbox" disabled=""[^>]*\/>.*Solo reembolsables/);
  });

  it('marcado desde la URL aunque no deje hoteles: se puede desmarcar', () => {
    const html = panel({ ...NO_FILTERS, refundableOnly: true });
    const input = /<input type="checkbox"([^>]*)\/><span[^>]*>Solo reembolsables/.exec(html)?.[1];
    expect(input).toContain('checked=""');
    expect(input).not.toContain('disabled');
  });

  it('sin divulgación no hay sección de proveedor', () => {
    expect(panel(NO_FILTERS)).not.toContain('Proveedor');
  });

  it('el deslizador de precio dice su valor a un lector de pantalla', () => {
    const html = panel(NO_FILTERS);
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-valuetext="Sin tope"');
  });
});
