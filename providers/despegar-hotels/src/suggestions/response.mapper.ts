import type { GeoSuggestion } from '../types';

interface RawSuggestionsResponse {
  items?: {
    id?: number;
    target?: {
      id?: number;
      gid?: string;
      type?: number;
      parents?: {
        continent?: string;
        country?: string;
        administrative_division?: string;
        city?: string;
      };
    };
    display?: string;
    highlight?: string;
  }[];
}

export function mapSuggestions(raw: RawSuggestionsResponse): GeoSuggestion[] {
  return (raw.items ?? [])
    .filter((it) => it.target?.gid)
    .map((it) => ({
      // target.id es el id geográfico (= location.city.id del inventario) que usa el catálogo
      // ciudad→IDs; preferirlo sobre el id del item.
      id: it.target?.id ?? it.id ?? 0,
      gid: it.target!.gid!,
      type: it.target?.type ?? 0,
      display: it.display ?? '',
      city: it.target?.parents?.city,
      country: it.target?.parents?.country,
    }));
}
