import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveScene } from './resolve-scene';
import { STAGE_TITLES, destinationPhrase } from './search-stage';
import { StageScene, type StageVertical } from './stage-scene';
import { FLIGHT_PATH } from './stories';

/*
 * La escena grande de la espera: decorativa, con la historia de la búsqueda en primer plano y
 * liviana (sólo CSS que mueve transform/opacity).
 */

function render(vertical: StageVertical, name?: string, paused?: boolean): string {
  return renderToStaticMarkup(
    createElement(StageScene, {
      vertical,
      scene: resolveScene(name === undefined ? undefined : { name }),
      ...(paused ? { paused } : {}),
    }),
  );
}

describe('StageScene', () => {
  it.each<StageVertical>(['hotels', 'flights', 'cars'])(
    '%s: decorativa, fuera del foco, con su historia',
    (vertical) => {
      const html = render(vertical, 'Cartagena, Colombia');
      expect(html).toMatch(/^<svg aria-hidden="true" focusable="false" viewBox="0 0 640 360"/);
      expect(html).toContain('data-scene="cartagena"');
      expect(html).toContain(`data-story="${vertical}"`);
      expect(html).toContain('class="ss-root');
    },
  );

  it('pausada (pestaña oculta o minimizada): marca para congelar la animación', () => {
    expect(render('hotels', undefined, true)).toContain('data-paused=""');
    expect(render('hotels')).not.toContain('data-paused');
  });

  it('sin colores fijos: todo sale de la paleta --ss-* (día y noche)', () => {
    for (const v of ['hotels', 'flights', 'cars'] as const) {
      expect(render(v)).not.toMatch(/fill="#|stroke="#|rgb\(/);
    }
  });

  it('el avión recorre la ruta que se dibuja como estela', () => {
    const html = render('flights');
    expect(html).toContain(`d="${FLIGHT_PATH}"`);
    expect(html).toContain(`offset-path:path(&#x27;${FLIGHT_PATH}&#x27;)`);
  });
});

describe('stage.css — liviana y respetuosa', () => {
  const css = readFileSync(new URL('./stage.css', import.meta.url), 'utf8');

  it('las animaciones sólo mueven transform, opacity, offset-distance o el trazo', () => {
    const bodies = css.match(/@keyframes[\s\S]*?\n}/g) ?? [];
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) {
      const props = [...body.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      for (const p of props) {
        expect(['transform', 'opacity', 'offset-distance', 'stroke-dashoffset']).toContain(p);
      }
    }
  });

  it('todo el movimiento va dentro de prefers-reduced-motion: no-preference', () => {
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n}\n/g,
      '',
    );
    expect(outside).not.toMatch(/^\s+animation:/m);
  });
});

describe('la ventana', () => {
  it('dice qué se busca y adónde', () => {
    expect(STAGE_TITLES.hotels).toBe('Buscando tu hotel');
    expect(destinationPhrase(resolveScene({ iata: 'CDG' }), { iata: 'CDG' })).toBe('en París');
    expect(
      destinationPhrase(resolveScene({ name: 'Isla Margarita, Venezuela' }), {
        name: 'Isla Margarita, Venezuela',
      }),
    ).toBe('en Isla Margarita');
    expect(destinationPhrase(resolveScene({ iata: 'XXX' }), { iata: 'XXX' })).toBe('· Ciudad');
  });
});
