import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormSheet } from './form-sheet';

/*
 * El panel de un formulario largo: tres franjas y una sola con scroll. Sin DOM en los tests, se
 * verifica la estructura que lo garantiza.
 */

const noop = () => undefined;

function render(over: Partial<Parameters<typeof FormSheet>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(FormSheet, {
      title: 'Editar variables · LATAM NDC',
      subtitle: 'Agencia Planetour',
      onClose: noop,
      onSubmit: noop,
      submitLabel: 'Guardar y activar',
      children: createElement('input', { id: 'campo' }),
      ...over,
    }),
  );
}

function dialogTag(html: string): string {
  return /<div[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? '';
}

describe('FormSheet', () => {
  it('es un diálogo modal nombrado por su título y descrito por la línea de abajo', () => {
    const html = render();
    const tag = dialogTag(html);
    expect(tag).toContain('aria-modal="true"');
    const titleId = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
    expect(html).toMatch(new RegExp(`<h2 id="${titleId}"[^>]*>Editar variables · LATAM NDC</h2>`));
    const described = /aria-describedby="([^"]+)"/.exec(tag)?.[1] ?? '';
    const subtitleId = described.split(' ')[0];
    expect(html).toMatch(new RegExp(`<p id="${subtitleId}"[^>]*>Agencia Planetour</p>`));
  });

  it('suma a la descripción los avisos que se le pasen', () => {
    const tag = dialogTag(render({ describedBy: 'aviso-reescritura' }));
    expect(tag).toMatch(/aria-describedby="[^"]+ aviso-reescritura"/);
  });

  it('cabecera y pie fijos; el cuerpo es lo único que scrollea', () => {
    const html = render();
    const header = html.indexOf('<header');
    const body = html.indexOf('data-sheet-body');
    const footer = html.indexOf('<footer');
    expect(header).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(header);
    expect(footer).toBeGreaterThan(body);

    expect(/<header[^>]*class="[^"]*shrink-0/.test(html)).toBe(true);
    expect(/<footer[^>]*class="[^"]*shrink-0/.test(html)).toBe(true);
    const bodyTag = /<div[^>]*data-sheet-body[^>]*>/.exec(html)?.[0] ?? '';
    expect(bodyTag).toContain('overflow-y-auto');
    expect(bodyTag).toContain('min-h-0');
    expect(bodyTag).toMatch(/class="[^"]*\brelative\b/);
    // La barra visible (globals.css) y sin que el scroll se escape a la página de atrás.
    expect(bodyTag).toContain('scroll-panel');
    expect(bodyTag).toContain('overscroll-contain');
    // El panel entero NO scrollea: ése era el modal de antes, que se llevaba título y botones.
    expect(dialogTag(html)).not.toContain('overflow-y-auto');
  });

  it('pantalla completa en el teléfono, panel a la derecha de ~600 px desde sm', () => {
    const tag = dialogTag(render());
    expect(tag).toContain('w-full');
    expect(tag).toContain('sm:max-w-[600px]');
    expect(tag).toContain('flex-col');
  });

  it('Cancelar y el botón de guardar viven en el pie, con el estado al lado', () => {
    const html = render({
      status: createElement('p', { role: 'alert' }, 'Falta el API Key.'),
    });
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toContain('role="alert"');
    expect(footer).toContain('Falta el API Key.');
    expect(footer).toMatch(/>Cancelar</);
    expect(footer).toMatch(/Guardar y activar/);
  });

  it('mientras guarda: cerrar deshabilitado, y el botón dice que está guardando', () => {
    const html = render({ busy: true });
    expect(dialogTag(html)).toContain('aria-busy="true"');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Cerrar"|<button[^>]*aria-label="Cerrar"[^>]*disabled=""/,
    );
    const footer = html.slice(html.indexOf('<footer'));
    const buttons = [...footer.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('disabled=""');
    expect(footer).toContain('Guardando…');
    expect(footer).not.toContain('Guardar y activar');
  });

  it('Guardar no se deshabilita al guardar: queda aria-disabled y conserva el foco', () => {
    // Un botón `disabled` suelta el foco al <body>: quien guardó con el teclado quedaba fuera del
    // panel, y el Tab siguiente caía en la página de atrás.
    const footer = (busy: boolean) => {
      const html = render({ busy });
      return html.slice(html.indexOf('<footer'));
    };
    const save = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0])[1] ?? '';
    expect(save(footer(true))).toContain('aria-disabled="true"');
    expect(save(footer(true))).not.toContain('disabled=""');
    expect(save(footer(false))).not.toContain('aria-disabled="');
  });

  it('en el teléfono los botones del pie bajan de fila en vez de salirse de la pantalla', () => {
    const html = render({ submitLabel: 'Guardar en Deshabilitado' });
    const footer = html.slice(html.indexOf('<footer'));
    const row = /<div class="([^"]*)"><button/.exec(footer)?.[1] ?? '';
    expect(row).toContain('flex-wrap-reverse');
    expect(row).toContain('justify-end');
  });

  it('sin desenfoque de fondo', () => {
    expect(render()).not.toContain('backdrop-blur');
  });
});
