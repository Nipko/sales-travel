import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEST_FARE_DESCRIPTION, TEST_ORDER_DESCRIPTION } from '../lib/test-content';
import { TestContentBadge, TestContentNotice } from './test-content-badge';

/*
 * La etiqueta «Prueba» y el aviso en bloque: lo que se ve, lo que oye un lector de pantalla y que
 * nada de eso dependa sólo del color.
 */

describe('TestContentBadge', () => {
  it('dice «Prueba» a la vista y qué es en el tooltip y al lector de pantalla', () => {
    const html = renderToStaticMarkup(createElement(TestContentBadge));

    expect(html).toContain('Prueba');
    expect(html).toContain(`title="${TEST_FARE_DESCRIPTION}"`);
    expect(html).toMatch(/<span class="sr-only">: Tarifa del entorno de pruebas del proveedor/);
    // El ícono es decorativo: la información va en texto.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('ámbar de fondo con el texto principal encima (AA en los dos temas)', () => {
    const html = renderToStaticMarkup(createElement(TestContentBadge));

    expect(html).toContain('bg-[var(--color-warning)]/20');
    expect(html).toContain('text-[var(--color-fg)]');
    expect(html).not.toMatch(/text-\[var\(--color-warning\)\]/);
  });

  it('no recibe foco: vive dentro de filas que ya son botones', () => {
    const html = renderToStaticMarkup(createElement(TestContentBadge));

    expect(html).not.toMatch(/tabindex|<button|<a /i);
  });

  it('acepta otra etiqueta y otra explicación (la de una reserva)', () => {
    const html = renderToStaticMarkup(
      createElement(TestContentBadge, {
        label: 'Reserva de prueba',
        description: TEST_ORDER_DESCRIPTION,
      }),
    );

    expect(html).toContain('Reserva de prueba');
    expect(html).toContain(`title="${TEST_ORDER_DESCRIPTION}"`);
    expect(html).toContain(`: ${TEST_ORDER_DESCRIPTION}`);
  });
});

describe('TestContentNotice', () => {
  it('es una nota con su texto', () => {
    const html = renderToStaticMarkup(
      createElement(TestContentNotice, null, 'Estás reservando en el entorno de pruebas.'),
    );

    expect(html).toMatch(/^<div role="note"/);
    expect(html).toContain('<p>Estás reservando en el entorno de pruebas.</p>');
  });
});
