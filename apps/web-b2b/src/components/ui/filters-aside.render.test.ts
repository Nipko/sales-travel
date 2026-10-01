import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FiltersAside } from './filters-aside';

/*
 * La columna de filtros de hoteles y autos en su primer pintado. El panel scrolleaba entero —el
 * título y "Limpiar" se iban con las opciones— y cortaba renglones por la mitad sin avisar.
 */

function render(): string {
  return renderToStaticMarkup(
    createElement(FiltersAside, {
      headerAction: createElement('button', { type: 'button' }, 'Limpiar (2)'),
      children: createElement('p', null, 'Opciones'),
    }),
  );
}

const classOf = (html: string, pattern: RegExp): string => html.match(pattern)?.[1] ?? '';

describe('FiltersAside', () => {
  it('sólo en pantallas anchas, pegada arriba y con el alto que deja la barra de arriba', () => {
    const aside = classOf(render(), /<aside aria-label="Filtros" class="([^"]*)"/);
    expect(aside.split(' ')).toEqual(
      expect.arrayContaining(['hidden', 'xl:flex', 'xl:sticky', 'xl:top-4']),
    );
    expect(aside).toContain('xl:max-h-[calc(100dvh-var(--app-topbar-height)-2.5rem)]');
  });

  it('el título y "Limpiar" quedan fuera del área que scrollea', () => {
    const html = render();
    const area = html.indexOf('data-scroll-area');
    expect(area).toBeGreaterThan(-1);
    expect(html.indexOf('>Filtros</h2>')).toBeLessThan(area);
    expect(html.indexOf('Limpiar (2)')).toBeLessThan(area);
    expect(html.indexOf('Opciones')).toBeGreaterThan(area);
  });

  it('los sr-only de las opciones corren con el área y no con la columna', () => {
    // Sin área posicionada, su bloque contenedor era el `aside` (overflow-hidden): un lector de
    // pantalla que llevaba uno a la vista scrolleaba la columna, que perdía el título.
    const area = classOf(render(), /data-scroll-area="" class="([^"]*)"/).split(' ');
    expect(area).toEqual(expect.arrayContaining(['relative', 'overflow-y-auto']));
  });

  it('la rueda sigue con la lista: la columna tiene que poder pegarse arriba', () => {
    // Con `overscroll-contain`, la rueda sobre los filtros no movía la página: si todo entraba,
    // nada se movía, y si no, la columna no llegaba a pegarse y el final quedaba bajo el borde.
    const area = classOf(render(), /data-scroll-area="" class="([^"]*)"/).split(' ');
    expect(area).not.toContain('overscroll-contain');
  });

  it('los degradados arrancan ocultos y no atajan clics', () => {
    const html = render();
    const fades = [...html.matchAll(/<span aria-hidden="true" class="([^"]*)"/g)].map((m) => m[1]);
    expect(fades).toHaveLength(2);
    for (const fade of fades) {
      expect(fade).toContain('pointer-events-none');
      expect(fade).toContain('opacity-0');
    }
  });
});
