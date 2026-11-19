import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FLIGHT_ROUTE,
  HOTEL_WINDOWS,
  SCENE_WINDOW_STEP_MS,
  TravelScene,
  sceneForSubject,
  windowStyle,
  type TravelSceneKind,
} from './travel-scene';

/*
 * La escena de la espera: decorativa, temática por búsqueda, con los colores del tema y quieta
 * (pero completa) con «reducir movimiento».
 */

const scene = (kind: TravelSceneKind): string =>
  renderToStaticMarkup(createElement(TravelScene, { kind }));

describe('TravelScene', () => {
  it('cada búsqueda tiene la suya; las demás, ninguna', () => {
    expect(sceneForSubject('hoteles')).toBe('hotels');
    expect(sceneForSubject('vuelos')).toBe('flights');
    expect(sceneForSubject('autos')).toBe('cars');
    expect(sceneForSubject('cotizaciones')).toBeUndefined();
  });

  it.each<TravelSceneKind>(['hotels', 'flights', 'cars'])(
    '%s: decorativa, fuera del árbol accesible y del foco',
    (kind) => {
      const html = scene(kind);
      expect(html).toMatch(/^<svg aria-hidden="true" focusable="false"/);
      expect(html).toContain(`data-scene="${kind}"`);
    },
  );

  it('todo el movimiento es `motion-safe:`: con «reducir movimiento» nada se anima', () => {
    for (const kind of ['hotels', 'flights', 'cars'] as const) {
      const html = scene(kind);
      const animated = html.match(/[\w:-]*animate-scene-[\w-]+/g) ?? [];
      for (const cls of animated) expect(cls.startsWith('motion-safe:')).toBe(true);
    }
  });

  it('colores del tema, no fijos: el modo oscuro y la marca de la agencia la pintan solas', () => {
    for (const kind of ['hotels', 'flights', 'cars'] as const) {
      const html = scene(kind);
      expect(html).toContain('var(--color-primary)');
      expect(html).not.toMatch(/fill="#|stroke="#/);
    }
  });

  it('el hotel enciende sus 16 ventanas de abajo hacia arriba, una tras otra', () => {
    expect(HOTEL_WINDOWS).toHaveLength(16);
    expect(HOTEL_WINDOWS[0]!.y).toBeGreaterThan(HOTEL_WINDOWS[15]!.y);
    expect(windowStyle(3)).toEqual({ animationDelay: `${3 * SCENE_WINDOW_STEP_MS}ms` });
    expect(scene('hotels').match(/animate-scene-window/g)).toHaveLength(16);
  });

  it('la ruta del vuelo es la misma que recorre el avión en el CSS', () => {
    expect(scene('flights')).toContain(`d="${FLIGHT_ROUTE}"`);
    const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
    expect(css).toContain(`offset-path: path('${FLIGHT_ROUTE}')`);
  });
});
