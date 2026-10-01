import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FiltersSheet } from './filters-sheet';

/*
 * La hoja de filtros del teléfono. Es un modal: al llegar al final de las opciones, la rueda o el
 * dedo no tienen que mover la lista de atrás, que quien filtra no está mirando. Lo contrario que
 * la columna de pantallas anchas (filters-aside), que sí tiene que dejar correr la página.
 */

function render(): string {
  return renderToStaticMarkup(
    createElement(FiltersSheet, {
      open: true,
      onClose: () => undefined,
      submitLabel: 'Ver 12 hoteles',
      children: createElement('p', null, 'Opciones'),
    }),
  );
}

describe('FiltersSheet', () => {
  it('las opciones scrollean en su área, sin arrastrar la página de atrás', () => {
    const area = (render().match(/data-scroll-area="" class="([^"]*)"/)?.[1] ?? '').split(' ');
    expect(area).toEqual(
      expect.arrayContaining(['relative', 'overflow-y-auto', 'overscroll-contain']),
    );
  });

  it('cerrada no pinta nada', () => {
    expect(
      renderToStaticMarkup(
        createElement(FiltersSheet, {
          open: false,
          onClose: () => undefined,
          submitLabel: 'Ver 12 hoteles',
          children: createElement('p', null, 'Opciones'),
        }),
      ),
    ).toBe('');
  });
});
