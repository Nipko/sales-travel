import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IdleWarningDialog, SessionGuard } from './session-guard';

function renderDialog(remainingMs: number): string {
  return renderToStaticMarkup(
    createElement(IdleWarningDialog, { remainingMs, onStay: () => {}, onLogout: () => {} }),
  );
}

describe('IdleWarningDialog: aviso de inactividad accesible', () => {
  it('es un alertdialog modal con título y descripción enlazados', () => {
    const html = renderDialog(119_000);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');

    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<h2 id="${labelledBy}"`);
    expect(html).toContain(`<p id="${describedBy}"`);
  });

  it('muestra la cuenta regresiva en m:ss y los dos botones', () => {
    const html = renderDialog(119_000);
    expect(html).toContain('Tu sesión se va a cerrar por inactividad en');
    expect(html).toContain('1:59');
    expect(html).toContain('Seguir conectado');
    expect(html).toContain('Cerrar sesión');
  });

  it('la región que se anuncia arranca vacía: al abrir, el lector lee la descripción, no un duplicado', () => {
    const html = renderDialog(120_000);
    expect(html).toMatch(/<p class="sr-only" aria-live="polite" aria-atomic="true"><\/p>/);
  });

  it('recibe clics aunque un menú de Radix abierto haya dejado el <body> sin pointer-events', () => {
    const root = /^<div class="([^"]*)"/.exec(renderDialog(60_000))?.[1] ?? '';
    expect(root.split(' ')).toContain('pointer-events-auto');
  });

  it('la cuenta regresiva visible NO está en una región viva (se anunciaría cada segundo)', () => {
    const html = renderDialog(90_000);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1] ?? '';
    const description = new RegExp(`<p id="${describedBy}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(description).not.toContain('aria-live');
  });
});

describe('SessionGuard', () => {
  it('en el servidor no dibuja nada: el aviso sólo aparece en el navegador', () => {
    expect(renderToStaticMarkup(createElement(SessionGuard, { initial: null }))).toBe('');
  });
});
