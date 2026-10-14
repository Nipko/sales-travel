import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SeatGridView, SeatMapSheet } from './seat-map-sheet';
import { seatGrids, seatPassengers, type SeatMapSegmentView, type SeatView } from './seat-map-view';

/*
 * La grilla de asientos, renderizada (SAB-16). Sin DOM en los tests, se verifica la estructura que
 * hace accesible el mapa: un `grid` con encabezados de fila y columna, una sola celda en el orden
 * de Tab (foco itinerante), cada asiento con su etiqueta completa y los que no se eligen marcados.
 */

const noop = () => undefined;

function asiento(column: string, over: Partial<SeatView> = {}, libre = true): SeatView {
  return {
    column,
    available: libre,
    characteristics: column === 'A' ? ['WINDOW'] : [],
    adultOnly: false,
    infantAllowed: true,
    offers: libre
      ? [{ passengerIndex: 0, price: { amountMinor: 0, currency: 'USD' }, offerRef: 'o' }]
      : [],
    ...over,
  };
}

const TRAMO: SeatMapSegmentView = {
  segmentRef: 0,
  legIndex: 0,
  changeOfGauge: false,
  displayOnly: false,
  cabins: [
    {
      cabin: 'economy',
      columns: ['A', 'B', 'C'],
      aisleAfter: ['A'],
      rows: [
        { number: 12, seats: [asiento('A'), asiento('B', {}, false), asiento('C')] },
        {
          number: 14,
          seats: [asiento('A', { adultOnly: true, characteristics: ['WINDOW', 'EXIT_ROW'] })],
        },
      ],
    },
  ],
};

function render(): string {
  const passengers = seatPassengers({ adults: 1, children: 0, infants: 0 }, ['Ana']);
  const grid = seatGrids({
    segment: TRAMO,
    passenger: passengers[0]!,
    passengers,
    choices: [],
    formatMoney: (amount, currency) => `${currency} ${String(amount)}`,
  })[0]!;
  return renderToStaticMarkup(
    createElement(SeatGridView, { grid, label: 'Asientos de BOG → LIM', onSelect: noop }),
  );
}

describe('SeatGridView', () => {
  it('es un grid nombrado, con encabezados de columna y de fila', () => {
    const html = render();
    expect(html).toMatch(/role="grid"[^>]*aria-label="Asientos de BOG → LIM"/);
    expect(html.match(/role="columnheader"/g)).toHaveLength(4);
    expect(html.match(/role="rowheader"/g)).toHaveLength(2);
    // La fila de salida lo dice en palabras, no sólo con el icono.
    expect(html).toContain('<span class="sr-only">, salida de emergencia</span>');
  });

  it('foco itinerante: una sola celda en el orden de Tab', () => {
    const html = render();
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)?.length).toBeGreaterThan(1);
  });

  it('cada asiento con su etiqueta completa; el que no se elige, marcado', () => {
    const html = render();
    expect(html).toContain('aria-label="Asiento 12A, ventana, disponible"');
    expect(html).toMatch(/aria-label="Asiento 12B, ocupado" aria-disabled="true"/);
    expect(html).toContain('aria-label="Asiento 14A, ventana, salida de emergencia, disponible"');
  });

  it('el hueco del avión es una celda vacía que el lector nombra, sin botón', () => {
    const html = render();
    expect(html).toContain('<span class="sr-only">Sin asiento</span>');
    expect(html.match(/<button/g)).toHaveLength(4);
  });
});

describe('SeatMapSheet', () => {
  it('abre como diálogo modal, dice que es opcional y anuncia que está cargando el mapa', () => {
    const html = renderToStaticMarkup(
      createElement(SeatMapSheet, {
        offer: {} as never,
        searchCriteria: {},
        passengers: [],
        initialChoices: [],
        onClose: noop,
        onSave: noop,
      }),
    );
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    expect(html).toMatch(/<h2 id="[^"]+"[^>]*>Elegir asientos<\/h2>/);
    expect(html).toContain('Opcional. Sólo se reservan asientos sin cargo.');
    expect(html).toMatch(/aria-live="polite"[^>]*>Cargando el mapa de asientos\.</);
    expect(html).toContain('Guardar asientos');
    expect(html).toContain('Cancelar');
  });
});
