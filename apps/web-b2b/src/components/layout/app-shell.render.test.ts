import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./sidebar', () => ({ Sidebar: () => null }));
vi.mock('./topbar', () => ({ Topbar: () => null }));
vi.mock('./session-guard', () => ({ SessionGuard: () => null }));
vi.mock('./agency-switcher', () => ({
  AgencySwitcherProvider: ({ children }: { children: ReactNode }) => children,
}));

import { AppShell } from './app-shell';

/*
 * El shell no deja que el documento scrollee: sólo `<main>`. En producción, al terminar la lista
 * de hoteles la rueda seguía por una franja en blanco que se llevaba el menú y la barra: los
 * `sr-only` (position: absolute) de cada tarjeta no tenían ningún ancestro posicionado, así que su
 * bloque contenedor era el documento, ningún `overflow` los recortaba y el documento medía lo que
 * la lista. Con `main` posicionado, su bloque contenedor es el área que scrollea.
 */

function classesOf(html: string, tag: RegExp): string[] {
  return (html.match(tag)?.[1] ?? '').split(' ');
}

describe('AppShell', () => {
  const html = renderToStaticMarkup(
    createElement(AppShell, null, createElement('span', { className: 'sr-only' }, 'Oculto')),
  );

  it('<main> scrollea y es el bloque contenedor de lo que se posiciona adentro', () => {
    expect(classesOf(html, /<main class="([^"]*)"/)).toEqual(
      expect.arrayContaining(['relative', 'min-h-0', 'flex-1', 'overflow-y-auto']),
    );
    expect(html).toMatch(/<main[^>]*><span class="sr-only">Oculto<\/span><\/main>/);
  });

  it('el shell mide la ventana y recorta lo que se le escape a sus columnas', () => {
    expect(classesOf(html, /^<div class="([^"]*)"/)).toEqual(
      expect.arrayContaining(['relative', 'flex', 'h-dvh', 'overflow-hidden']),
    );
  });
});
