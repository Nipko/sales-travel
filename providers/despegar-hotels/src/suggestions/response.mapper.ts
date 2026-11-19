import type { GeoSuggestion } from '../types';

interface RawSuggestionItem {
  id?: number | string;
  target?: {
    id?: number | string;
    gid?: string;
    type?: number | string;
    parents?: {
      continent?: string;
      country?: string;
      administrative_division?: string;
      city?: string;
    };
  };
  display?: string;
  highlight?: string;
  /** `/suggestions` agrupa por tipo (`CITY`, `AIRPORT`…): cada grupo trae sus `items`. */
  group?: string;
  items?: RawSuggestionItem[];
}

interface RawSuggestionsResponse {
  items?: RawSuggestionItem[];
}

/** Los grupos de `/suggestions` aplanados; una respuesta plana queda igual. */
function flatten(items: readonly RawSuggestionItem[]): RawSuggestionItem[] {
  return items.flatMap((it) => (Array.isArray(it.items) ? flatten(it.items) : [it]));
}

/**
 * La búsqueda de Despegar resuelve un destino a los hoteles de esa CIUDAD en `hotel_inventory`
 * (por `location.city.id`). Un hotel, aeropuerto o región sugerido no tiene hoteles ahí y terminaba
 * en "catálogo no sincronizado": sólo pasan las ciudades.
 */
function isCity(it: RawSuggestionItem): boolean {
  const type = it.target?.type;
  if (typeof type === 'string') return type.toUpperCase() === 'CITY';
  return it.target?.gid?.startsWith('CIT_') === true;
}

/** `target.id` (`"6585"`) o, si falta, los dígitos del gid (`CIT_6585`). */
function cityIdOf(it: RawSuggestionItem): number | undefined {
  const raw = it.target?.id ?? it.target?.gid?.replace(/^CIT_/, '');
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function mapSuggestions(raw: RawSuggestionsResponse): GeoSuggestion[] {
  const seen = new Set<string>();
  const out: GeoSuggestion[] = [];
  for (const it of flatten(raw.items ?? [])) {
    const gid = it.target?.gid;
    if (gid === undefined || seen.has(gid) || !isCity(it)) continue;
    const id = cityIdOf(it);
    if (id === undefined) continue;
    seen.add(gid);
    out.push({
      id,
      gid,
      // Ciudades, como las del catálogo local: el tipo del proveedor viene como texto.
      type: typeof it.target?.type === 'number' ? it.target.type : 0,
      display: it.display ?? '',
      ...(it.target?.parents?.city === undefined ? {} : { city: it.target.parents.city }),
      ...(it.target?.parents?.country === undefined ? {} : { country: it.target.parents.country }),
    });
  }
  return out;
}
