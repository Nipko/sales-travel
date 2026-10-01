import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HotelSearchResult } from '../actions';
import {
  moreArrived,
  moreLoading,
  moreStateFor,
  type HotelSearchPaging,
  type MoreState,
} from './hotel-paging';
import { ResultsPager, type ResultsPagerProps } from './hotel-results-pager';

/*
 * El pie de la lista de hoteles en su primer pintado (docs/tbo/02 §4.4): qué ofrece en cada estado
 * y qué oye un lector de pantalla.
 */

const SESION = '5b0e8d1c-2a4f-4c6e-9b7a-0d3e1f2a4b6c';
const noop = () => undefined;

const PRIMERO: HotelSearchPaging = {
  sessionId: SESION,
  page: 0,
  consulted: 100,
  total: 420,
  hasMore: true,
  nextBatch: 100,
};

function busqueda(paging: HotelSearchPaging): HotelSearchResult {
  return { ok: true, hotels: [], providers: [], showProviderInResults: false, paging };
}

function pie(more: MoreState | undefined, extra: Partial<ResultsPagerProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ResultsPager, {
      shown: 64,
      visible: 64,
      onShowMore: noop,
      more,
      destinationLabel: 'Cartagena de Indias, Colombia',
      onLoadMore: noop,
      onSearchAgain: noop,
      searching: false,
      ...extra,
    }),
  );
}

function segmentos(html: string): string[] {
  return [...html.matchAll(/data-segment="([a-z]+)"/g)].map((m) => m[1] ?? '');
}

describe('ResultsPager', () => {
  it('con todo a la vista: cuánto del destino se consultó, el medidor y "Ver más hoteles"', () => {
    const html = pie(moreStateFor(busqueda(PRIMERO)));
    expect(html).toContain('Consultamos 100 de 420 hoteles de Cartagena de Indias.');
    expect(html).toContain('Ver más hoteles');
    expect(segmentos(html)).toEqual(['consulted', 'next', 'rest']);
    // El medidor es decorativo: lo dice la línea de arriba.
    expect(html).toMatch(/<div aria-hidden="true" data-coverage-meter=""/);
    expect(html).not.toContain('Mostrar');
  });

  it('con hoteles cargados sin mostrar: "Mostrar 20 más" y todavía no se consulta a nadie', () => {
    const html = pie(moreStateFor(busqueda(PRIMERO)), { visible: 20 });
    expect(html).toContain('Viendo 20 de 64 hoteles');
    expect(html).toContain('Mostrar 20 más');
    expect(html).not.toContain('Ver más hoteles');
    expect(html).toContain(
      'Cuando termines de ver los que ya llegaron, puedes consultar los siguientes 100.',
    );
  });

  it('consultando: la región ocupada, el barrido en el segmento siguiente y el botón que no se suelta', () => {
    const html = pie(moreLoading(moreStateFor(busqueda(PRIMERO))));
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/data-segment="next"[^>]*><span class="[^"]*animate-search-sweep/);
    expect(html).toContain('Buscando…');
    expect(html).toMatch(/<button type="button" aria-disabled="true"/);
    expect(html).toContain('Consultando los siguientes hoteles…');
    // Con «reducir movimiento» no hay barrido.
    expect(html).toContain('motion-reduce:hidden');
  });

  it('un tramo que falló: el motivo como alerta y "Reintentar"', () => {
    const html = pie(
      moreArrived(moreStateFor(busqueda(PRIMERO)), {
        ok: false,
        hotels: [],
        providers: [],
        error: 'Ningún proveedor de hoteles respondió.',
      }),
    );
    expect(html).toMatch(/role="alert"[^>]*>.*Ningún proveedor de hoteles respondió\./);
    expect(html).toContain('Reintentar');
  });

  it('vencida: "Buscar de nuevo" en lugar de "Ver más hoteles"', () => {
    const html = pie(
      moreArrived(moreStateFor(busqueda(PRIMERO)), {
        ok: false,
        hotels: [],
        providers: [],
        reason: 'expired',
        error: 'Esta búsqueda ya no está vigente. Vuelve a buscar para ver más hoteles.',
      }),
    );
    expect(html).toContain('Buscar de nuevo');
    expect(html).not.toContain('Ver más hoteles');
  });

  it('todo el destino consultado: la marca de completo y ningún botón', () => {
    const html = pie(moreStateFor(busqueda({ page: 0, consulted: 64, total: 64, hasMore: false })));
    expect(html).toContain('Consultamos los 64 hoteles de Cartagena de Indias.');
    expect(html).toContain('var(--color-success)');
    expect(html).not.toContain('<button');
    expect(segmentos(html)).toEqual(['consulted']);
  });

  it('un tramo sin disponibilidad lo dice junto al botón', () => {
    const html = pie(
      moreArrived(moreStateFor(busqueda(PRIMERO)), {
        ok: true,
        hotels: [],
        providers: [{ code: 'tbo-hotels', status: 'empty', count: 0 }],
        paging: { ...PRIMERO, page: 1, consulted: 200 },
      }),
    );
    expect(html).toContain(
      'Los siguientes 100 hoteles no tienen disponibilidad para estas fechas.',
    );
    expect(html).toContain('Consultamos 200 de 420 hoteles');
    expect(html).toContain('Ver más hoteles');
  });

  it('una búsqueda sin tramos (IDs escritos a mano) sólo tiene "Mostrar 20 más"', () => {
    expect(pie(undefined, { visible: 20 })).toContain('Mostrar 20 más');
    expect(pie(undefined)).toBe('<div class="space-y-3"></div>');
  });
});
