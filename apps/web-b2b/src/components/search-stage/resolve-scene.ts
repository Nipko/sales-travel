import {
  ARCHETYPE_GROUND,
  CITY_SCENES,
  COUNTRY_ARCHETYPE,
  COUNTRY_NAMES,
  KEYWORD_ARCHETYPE,
  type ArchetypeId,
  type CityScene,
} from './catalog';
import type { Ground } from './kit';

/*
 * Qué escena mostrar para el destino de una búsqueda. Del más preciso al más general:
 * 1. el código del aeropuerto (vuelos y autos);
 * 2. el nombre de la ciudad (el primer tramo de "Cartagena de Indias, Bolívar, Colombia");
 * 3. una palabra del nombre que dice qué tipo de lugar es ("Isla Margarita" → playa);
 * 4. el país ("…, República Dominicana" → playa);
 * 5. la ciudad genérica.
 */

export interface DestinationHint {
  /** Lo que eligió el vendedor, como lo muestra el autocompletado. */
  readonly name?: string;
  /** Código IATA del aeropuerto o de la ciudad. */
  readonly iata?: string;
  /** ISO alfa-2, si se conoce. */
  readonly country?: string;
}

export type ResolvedScene =
  | { readonly kind: 'city'; readonly city: CityScene; readonly ground: Ground }
  | { readonly kind: 'archetype'; readonly archetype: ArchetypeId; readonly ground: Ground };

/** Sin acentos, en minúsculas y con espacios simples. */
export function normalizePlace(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9.,\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_IATA = new Map(CITY_SCENES.flatMap((c) => c.iata.map((code) => [code, c] as const)));

function cityByName(name: string): CityScene | undefined {
  const first = normalizePlace(name).split(',')[0]?.trim() ?? '';
  if (first === '') return undefined;
  // El alias más largo que coincide: "santiago de chile" antes que "santiago".
  let best: { city: CityScene; length: number } | undefined;
  for (const city of CITY_SCENES) {
    for (const alias of city.aliases) {
      const hit = first === alias || first.startsWith(`${alias} `) || first.startsWith(`${alias}-`);
      if (hit && (best === undefined || alias.length > best.length)) {
        best = { city, length: alias.length };
      }
    }
  }
  return best?.city;
}

function countryOf(hint: DestinationHint): string | undefined {
  if (hint.country && /^[A-Za-z]{2}$/.test(hint.country)) return hint.country.toUpperCase();
  if (!hint.name) return undefined;
  const parts = normalizePlace(hint.name).split(',');
  const last = parts[parts.length - 1]?.trim();
  return last === undefined || parts.length < 2 ? undefined : COUNTRY_NAMES[last];
}

const archetype = (id: ArchetypeId): ResolvedScene => ({
  kind: 'archetype',
  archetype: id,
  ground: ARCHETYPE_GROUND[id],
});

export function resolveScene(hint: DestinationHint | undefined): ResolvedScene {
  if (hint === undefined) return archetype('city');
  const iata = hint.iata?.trim().toUpperCase();
  const byCode = iata ? BY_IATA.get(iata) : undefined;
  if (byCode) return { kind: 'city', city: byCode, ground: byCode.ground };

  const byName = hint.name ? cityByName(hint.name) : undefined;
  // Mismo nombre en otro país (Santiago de Compostela no es Santiago de Chile): manda el país.
  const country = countryOf(hint);
  if (byName && (country === undefined || country === byName.country)) {
    return { kind: 'city', city: byName, ground: byName.ground };
  }

  const text = hint.name ? normalizePlace(hint.name) : '';
  for (const [pattern, id] of KEYWORD_ARCHETYPE) {
    if (pattern.test(text)) return archetype(id);
  }
  if (country !== undefined) {
    const byCountry = COUNTRY_ARCHETYPE[country];
    if (byCountry) return archetype(byCountry);
  }
  return archetype('city');
}
