import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog, firstFocusableWithin } from './dialog';

/*
 * El diálogo centrado: título fijo, contenido con su scroll y pie fijo opcional. Con un formulario
 * largo, el título y los botones ya no se van con el scroll.
 */

const noop = () => undefined;

function render(footer?: string): string {
  return renderToStaticMarkup(
    createElement(Dialog, {
      open: true,
      onClose: noop,
      title: 'Crear agencia',
      description: 'Cuelga de Planetour.',
      footer: footer === undefined ? undefined : createElement('button', null, footer),
      children: createElement('input', { id: 'nombre' }),
    }),
  );
}

describe('Dialog', () => {
  it('se nombra por su título visible y se describe por su descripción', () => {
    const html = render();
    const tag = /<div[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? '';
    const titleId = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
    const descriptionId = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
    expect(html).toMatch(new RegExp(`<h2 id="${titleId}"[^>]*>Crear agencia</h2>`));
    expect(html).toMatch(new RegExp(`<p id="${descriptionId}"[^>]*>Cuelga de Planetour\\.</p>`));
  });

  it('el panel no scrollea entero: lo hace el cuerpo, con alto máximo a la ventana', () => {
    const html = render();
    const tag = /<div[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag).toContain('max-h-[calc(100dvh-2rem)]');
    expect(tag).toContain('flex-col');
    expect(tag).not.toContain('overflow-y-auto');
    const body = /<div[^>]*data-dialog-body[^>]*>/.exec(html)?.[0] ?? '';
    expect(body).toContain('overflow-y-auto');
    expect(body).toContain('scroll-panel');
  });

  it('el pie va después del cuerpo, fuera de lo que scrollea', () => {
    const html = render('Guardar');
    const body = html.indexOf('data-dialog-body');
    const bodyEnd = html.indexOf('</div>', html.indexOf('id="nombre"'));
    const footer = html.indexOf('>Guardar</button>');
    expect(footer).toBeGreaterThan(body);
    expect(footer).toBeGreaterThan(bodyEnd);
  });

  it('sin pie, no pinta la franja vacía', () => {
    expect(render()).not.toContain('border-t');
  });

  // Sólo el selector: sin DOM en los tests, adónde llega el foco se verifica en el navegador.
  it('el selector del foco inicial se limita al cuerpo, no incluye la X de la cabecera', () => {
    const selector = firstFocusableWithin('[data-dialog-body]');
    expect(selector.split(', ').every((s) => s.startsWith('[data-dialog-body] '))).toBe(true);
    expect(selector).toContain('[data-dialog-body] input:not([disabled])');
  });
});
