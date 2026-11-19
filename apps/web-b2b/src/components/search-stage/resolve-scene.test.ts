import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, CITY_SCENES } from './catalog';
import { CITY_LOADERS } from './registry';
import { normalizePlace, resolveScene, type ResolvedScene } from './resolve-scene';

/*
 * Qué paisaje ve el vendedor mientras espera: el de su destino, o el que más se le parece.
 */

const cityOf = (r: ResolvedScene) => (r.kind === 'city' ? r.city.id : `(${r.archetype})`);

describe('resolveScene — la ciudad del destino', () => {
  it.each([
    [{ name: 'Cartagena de Indias, Bolívar, Colombia' }, 'cartagena'],
    [{ name: 'Bogotá, Colombia' }, 'bogota'],
    [{ name: 'BOGOTA D.C.' }, 'bogota'],
    [{ name: 'Ciudad de México, México' }, 'ciudad-de-mexico'],
    [{ name: 'New York, Estados Unidos' }, 'nueva-york'],
    [{ name: 'São Paulo, Brasil' }, 'sao-paulo'],
    [{ name: 'Santiago de Chile' }, 'santiago'],
    [{ name: 'Playa del Carmen, Quintana Roo, México' }, 'cancun'],
    [{ name: 'Machu Picchu, Perú' }, 'cusco'],
    [{ iata: 'mde' }, 'medellin'],
    [{ iata: 'GIG' }, 'rio'],
    [{ iata: 'JFK' }, 'nueva-york'],
    [{ name: 'Aeropuerto El Dorado (BOG)', iata: 'BOG' }, 'bogota'],
  ])('%o → %s', (hint, expected) => {
    expect(cityOf(resolveScene(hint))).toBe(expected);
  });

  it('un nombre igual en otro país no es esa ciudad: manda el país', () => {
    expect(cityOf(resolveScene({ name: 'Santiago, Chile' }))).toBe('santiago');
    expect(resolveScene({ name: 'Santiago de Compostela, España' }).kind).toBe('archetype');
    expect(resolveScene({ name: 'Cartagena, Murcia, España' }).kind).toBe('archetype');
  });

  it('el suelo de la escena es el de la ciudad', () => {
    expect(resolveScene({ iata: 'PUJ' }).ground).toBe('sand');
    expect(resolveScene({ iata: 'BOG' }).ground).toBe('street');
  });
});

describe('resolveScene — sin escena propia, la que más se le parece', () => {
  it.each([
    [{ name: 'Isla Margarita, Venezuela' }, '(beach)'],
    [{ name: 'Santa Marta, Colombia' }, '(city)'],
    [{ name: 'Bariloche, Argentina' }, '(snow)'],
    [{ name: 'Salento, Eje Cafetero, Colombia' }, '(nature)'],
    [{ name: 'Valle de Cocora, Colombia' }, '(mountain)'],
    [{ name: 'Montego Bay, Jamaica' }, '(beach)'],
    [{ name: 'Ocho Ríos, Jamaica' }, '(beach)'],
    [{ name: 'Zúrich, Suiza' }, '(snow)'],
    [{ name: 'Trinidad, Cuba' }, '(colonial)'],
    [{ name: 'Monteverde', country: 'cr' }, '(nature)'],
    [{ name: 'Una ciudad cualquiera' }, '(city)'],
    [{ iata: 'XXX' }, '(city)'],
    [{}, '(city)'],
  ])('%o → %s', (hint, expected) => {
    expect(cityOf(resolveScene(hint))).toBe(expected);
  });

  it('sin destino, la ciudad genérica', () => {
    expect(resolveScene(undefined)).toEqual({
      kind: 'archetype',
      archetype: 'city',
      ground: 'street',
    });
  });

  it('normaliza acentos, mayúsculas y signos', () => {
    expect(normalizePlace('  SÃO Paulo — Brasil!! ')).toBe('sao paulo brasil');
  });
});

describe('catálogo y escenas', () => {
  const files = new Set(
    readdirSync(new URL('./scenes/', import.meta.url)).map((f) => f.replace(/\.tsx$/, '')),
  );

  it('al menos 30 ciudades, sin ids, alias ni aeropuertos repetidos', () => {
    expect(CITY_SCENES.length).toBeGreaterThanOrEqual(30);
    const ids = CITY_SCENES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const iata = CITY_SCENES.flatMap((c) => c.iata);
    expect(new Set(iata).size).toBe(iata.length);
    for (const c of CITY_SCENES) {
      for (const a of c.aliases) expect(normalizePlace(a)).toBe(a);
      for (const code of c.iata) expect(code).toMatch(/^[A-Z]{3}$/);
      expect(c.country).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('cada ciudad y cada genérica tiene su archivo y su carga diferida', () => {
    for (const c of CITY_SCENES) {
      expect(files.has(c.id), c.id).toBe(true);
      expect(CITY_LOADERS[c.id], c.id).toBeTypeOf('function');
    }
    for (const a of ARCHETYPES) expect(files.has(a), a).toBe(true);
    expect(Object.keys(CITY_LOADERS).sort()).toEqual(CITY_SCENES.map((c) => c.id).sort());
  });

  it('ningún paisaje usa colores fijos, ids, filtros ni animaciones fuera de stage.css', () => {
    for (const name of files) {
      const code = readFileSync(new URL(`./scenes/${name}.tsx`, import.meta.url), 'utf8');
      expect(code, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/);
      expect(code, name).not.toMatch(
        /\bid=|<image|<filter|filter:|<mask|clipPath|<animate|setInterval|requestAnimationFrame/,
      );
      for (const cls of code.match(/className="([^"]+)"/g) ?? []) {
        for (const c of cls.slice(11, -1).split(/\s+/)) expect(c, name).toMatch(/^ss-[a-z-]+$/);
      }
    }
  });
});
