import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SEARCH_LOADING_MESSAGES,
  SEARCH_MESSAGE_MS,
  SearchButtonLabel,
  SearchLoading,
  searchAnnouncement,
  searchMessageStyle,
} from './search-loading';

/*
 * La espera de una búsqueda, igual en vuelos, hoteles y autos: lo que ve el vendedor, lo que oye
 * un lector de pantalla y lo que queda con «reducir movimiento».
 */

function loading(active: boolean, echo?: string): string {
  return renderToStaticMarkup(
    createElement(
      SearchLoading,
      { active, subject: 'hoteles', ...(echo ? { echo } : {}) },
      createElement('div', { className: 'silueta' }),
    ),
  );
}

describe('SearchLoading', () => {
  it('sin búsqueda en curso, sólo la región viva, vacía y montada para anunciar después', () => {
    expect(loading(false)).toBe(
      '<p role="status" aria-live="polite" aria-atomic="true" class="sr-only"></p>',
    );
  });

  it('buscando: región ocupada (aria-busy) y anuncio educado (aria-live polite)', () => {
    const html = loading(true, 'Cartagena · 12 – 15 oct 2026 · 3 noches');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(
      'Buscando hoteles: Cartagena · 12 – 15 oct 2026 · 3 noches. Consultando proveedores y comparando tarifas.',
    );
  });

  it('muestra qué se busca y los tres mensajes que se turnan', () => {
    const html = loading(true, 'Lima · 3 – 5 nov 2026 · 2 noches');
    expect(html).toContain('Buscando</span>');
    expect(html).toContain('Lima · 3 – 5 nov 2026 · 2 noches');
    for (const message of SEARCH_LOADING_MESSAGES) expect(html).toContain(message);
    expect(html).toContain('class="silueta"');
  });

  it('los mensajes que se turnan no se leen: repetidos cada dos segundos taparían todo', () => {
    const html = loading(true);
    const live = /<p role="status"[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? '';
    for (const message of SEARCH_LOADING_MESSAGES) expect(live).not.toContain(message);
    // Los mensajes que se turnan, la línea que barre y la silueta están fuera del árbol
    // accesible: ya los resume la región viva.
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
  });

  it('la región ocupada no queda vacía para el lector: dice qué se está buscando', () => {
    const html = loading(true, 'Lima · 3 – 5 nov 2026 · 2 noches');
    const busy = html.slice(html.indexOf('aria-busy="true"'));
    const echo = busy.indexOf('Lima · 3 – 5 nov 2026 · 2 noches');
    const firstHidden = busy.indexOf('aria-hidden="true"');
    expect(echo).toBeGreaterThan(-1);
    expect(echo).toBeLessThan(firstHidden);
  });

  it('con «reducir movimiento» queda sólo texto: un mensaje fijo, sin barrido ni siluetas', () => {
    const html = loading(true);
    expect(html).toContain('motion-safe:animate-search-message');
    // Los mensajes que no son el primero, la línea que barre y la silueta.
    expect(html.match(/motion-reduce:hidden/g)).toHaveLength(
      SEARCH_LOADING_MESSAGES.length - 1 + 2,
    );
    expect(html).toContain('motion-reduce:animate-none');
  });

  it('cada mensaje entra cuando se va el anterior, en un ciclo de los tres', () => {
    expect(SEARCH_LOADING_MESSAGES).toHaveLength(3);
    expect(searchMessageStyle(0)).toEqual({
      animationDelay: '0ms',
      animationDuration: `${3 * SEARCH_MESSAGE_MS}ms`,
    });
    expect(searchMessageStyle(2).animationDelay).toBe(`${2 * SEARCH_MESSAGE_MS}ms`);
  });

  it('sin eco, el anuncio dice qué se busca', () => {
    expect(searchAnnouncement('autos')).toBe(
      'Buscando autos. Consultando proveedores y comparando tarifas.',
    );
  });
});

describe('SearchButtonLabel', () => {
  it('buscando: «Buscando…» con indicador, que se apaga con «reducir movimiento»', () => {
    const html = renderToStaticMarkup(
      createElement(SearchButtonLabel, { searching: true, children: 'Buscar hoteles' }),
    );
    expect(html).toContain('Buscando…');
    expect(html).not.toContain('Buscar hoteles');
    expect(html).toContain('animate-spin');
    expect(html).toContain('motion-reduce:hidden');
  });

  it('en reposo, el texto del botón', () => {
    const html = renderToStaticMarkup(
      createElement(SearchButtonLabel, { searching: false, children: 'Buscar autos' }),
    );
    expect(html).toContain('Buscar autos');
    expect(html).not.toContain('Buscando');
  });
});
