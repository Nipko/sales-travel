import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { voseoIn } from '../lib/voseo';
import { StepUpDialog, StepUpProvider, type StepUpDialogProps } from './step-up-dialog';

/*
 * "Confirma que eres tú" (USR-13): el diálogo que pide el código del 2FA antes de una acción de alto
 * impacto. Sin DOM: lo que pinta, cómo lo nombra un lector de pantalla y qué hace con el teléfono.
 */

const noop = () => undefined;

function render(props: Partial<StepUpDialogProps> = {}): string {
  return renderToStaticMarkup(
    createElement(StepUpDialog, {
      open: true,
      pending: false,
      error: '',
      failureKey: 0,
      onSubmit: noop,
      onCancel: noop,
      ...props,
    }),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('StepUpDialog', () => {
  it('un diálogo modal nombrado por su título, que dice qué escribir', () => {
    const html = render();
    const tag = /<div[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag).toContain('aria-modal="true"');
    const titleId = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
    const descriptionId = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
    expect(html).toMatch(new RegExp(`<h2 id="${titleId}"[^>]*>Confirma que eres tú</h2>`));
    expect(html).toContain(
      `<p id="${descriptionId}" class="mt-1 text-xs text-[var(--color-fg-muted)]">Escribe el código de 6 dígitos de tu app de autenticación.</p>`,
    );
  });

  it('seis casillas numéricas que el teléfono completa solo', () => {
    const html = render();
    const boxes = html.match(/<input[^>]*aria-label="Dígito \d de 6"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      expect(box).toContain('inputMode="numeric"');
      expect(box).toContain('autoComplete="one-time-code"');
    }
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Confirmar<\/button>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Cancelar<\/button>/);
  });

  it('el código rechazado se anuncia y marca las casillas', () => {
    const html = render({ error: 'Ese código no es válido. Inténtalo de nuevo.' });
    const alert =
      /<p id="([^"]+)" role="alert"[^>]*>Ese código no es válido\. Inténtalo de nuevo\.<\/p>/.exec(
        html,
      );
    expect(alert).not.toBeNull();
    expect(html).toContain(`aria-describedby="${alert?.[1]}"`);
    expect(html).toContain('aria-invalid="true"');
  });

  it('mientras verifica: "Verificando…" y nada para tocar', () => {
    const html = render({ pending: true });
    expect(text(html)).toContain('Verificando…');
    const boxes = html.match(/<input[^>]*aria-label="Dígito \d de 6"[^>]*>/g) ?? [];
    expect(boxes.every((b) => b.includes('disabled=""'))).toBe(true);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirmar<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancelar<\/button>/);
  });

  it('cerrado no pinta nada, y el proveedor arranca cerrado', () => {
    expect(render({ open: false })).toBe('');
    expect(renderToStaticMarkup(createElement(StepUpProvider))).toBe('');
  });

  it('todo en tú', () => {
    expect(
      voseoIn(text(render({ error: 'Ese código no es válido. Inténtalo de nuevo.' }))),
    ).toEqual([]);
  });
});
