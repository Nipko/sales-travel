import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RateConditions } from './_components/rate-conditions';

/*
 * RF-16 CA-2: ninguna pantalla del panel pinta las condiciones de una tarifa (ni ningún otro texto
 * de un proveedor) como HTML. La búsqueda recorre TODO `apps/web-b2b/src`, no sólo hoteles: las
 * condiciones viajan al voucher, a reservas y a lo que venga, y el día que alguien las inyecte en
 * otra pantalla este test lo obliga a decidirlo a la vista.
 *
 * Los dos usos que quedan inyectan contenido NUESTRO y ningún dato de un proveedor: el script que
 * fija el tema antes de pintar (una constante) y la hoja de colores de la marca del tenant, que se
 * arma con colores ya validados.
 */

const SRC_DIR = fileURLToPath(new URL('../../../..', import.meta.url));

const ALLOWED = new Set([
  ['app', 'layout.tsx'].join(sep),
  ['components', 'layout', 'app-shell.tsx'].join(sep),
]);

const HTML_SINKS = /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('RF-16 CA-2 — las condiciones de la tarifa nunca se pintan como HTML', () => {
  it('ningún archivo de apps/web-b2b/src inyecta HTML, salvo el tema y la marca', () => {
    const files = sources(SRC_DIR);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((file) => HTML_SINKS.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file));
    expect(offenders.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  it('los dos usos permitidos no tocan contenido de tarifas', () => {
    for (const file of ALLOWED) {
      const text = readFileSync(join(SRC_DIR, file), 'utf8');
      expect(text).not.toMatch(/rateConditions|conditionGroups|HotelPrebook|roompack/i);
    }
  });

  it('el componente escapa lo que parece marcado: queda como texto visible', () => {
    const html = renderToStaticMarkup(
      createElement(RateConditions, {
        conditions: [
          { category: 'specialInstructions', text: '<script>alert(1)</script> &lt;b&gt;ok' },
          { category: 'other', text: '<img src=x onerror=alert(1)>' },
        ],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;lt;b&amp;gt;ok');
  });

  it('abre de entrada, con el título como título y el botón que pliega adentro', () => {
    const html = renderToStaticMarkup(
      createElement(RateConditions, {
        conditions: [{ category: 'checkIn', text: 'CheckIn Time-Begin: 3:00 PM' }],
      }),
    );
    expect(html).not.toContain('<summary');
    expect(html).toMatch(/<h2[^>]*><button[^>]*aria-expanded="true"/);
    expect(html).toContain('CheckIn Time-Begin: 3:00 PM');
  });
});
