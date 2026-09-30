import type { GeoSuggestion } from '../actions';

/*
 * El autocompletado de destino, sin I/O: qué se le pregunta al API y qué se le dice al vendedor.
 *
 * "No hay ciudades que coincidan" y "no se pudo consultar" son cosas distintas y el vendedor actúa
 * distinto con cada una: con la primera prueba otro nombre, con la segunda espera o avisa. Antes
 * cualquier error del API se convertía en una lista vacía y se leía como la primera.
 *
 * El motivo sale del estado HTTP y nunca del texto del API, que puede traer el de un proveedor:
 * al vendedor no le llegan datos técnicos.
 */

/** Lo mínimo que el autocompletado escribe antes de preguntar. */
export const SUGGESTIONS_MIN_QUERY = 2;
/** El tope del borde del API (`HotelSuggestQuerySchema`): más largo sería un 400. */
export const SUGGESTIONS_MAX_QUERY = 120;

export interface DestinationSuggestionsResult {
  readonly items: GeoSuggestion[];
  /** Presente si NO se pudo consultar: `items` va vacío y no quiere decir "no hay ciudades". */
  readonly error?: string;
}

/** Lo que se le pregunta al API, o `undefined` si todavía es muy corto para preguntar. */
export function suggestionsQuery(raw: string): string | undefined {
  const q = raw.trim().slice(0, SUGGESTIONS_MAX_QUERY).trim();
  return q.length < SUGGESTIONS_MIN_QUERY ? undefined : q;
}

export const SUGGESTIONS_UNAVAILABLE =
  'No pudimos consultar los destinos en este momento. Prueba de nuevo en unos segundos.';

/** El motivo, en palabras del vendedor, de una consulta de destinos que no respondió. */
export function suggestionsErrorMessage(status: number): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión para buscar destinos.';
  if (status === 403) return 'Tu usuario no tiene permiso para buscar destinos de hoteles.';
  if (status === 429) {
    return 'Hubo demasiadas consultas seguidas. Espera unos segundos y vuelve a escribir.';
  }
  if (status === 503) {
    return 'El buscador de destinos no está disponible ahora. Prueba de nuevo en unos minutos; si sigue, avisa al administrador.';
  }
  return SUGGESTIONS_UNAVAILABLE;
}

/** Las sugerencias de la respuesta, o `undefined` si la respuesta no las trae con su forma. */
export function parseSuggestionItems(value: unknown): GeoSuggestion[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { items } = value as { items?: unknown };
  if (!Array.isArray(items)) return undefined;
  return items.filter((item): item is GeoSuggestion => {
    if (typeof item !== 'object' || item === null) return false;
    const { id, gid, display } = item as { id?: unknown; gid?: unknown; display?: unknown };
    return (
      (typeof id === 'number' || typeof id === 'string') &&
      typeof gid === 'string' &&
      typeof display === 'string'
    );
  });
}

/**
 * Lo que la sugerencia de una ciudad sin hoteles cargados todavía (`loadsOnSearch`, cobertura
 * global del 2026-09-29) le dice al vendedor: se ofrece igual, pero la primera búsqueda trae sus
 * hoteles del proveedor y tarda unos segundos más. `undefined` para el resto de las ciudades.
 */
export const LOADS_ON_SEARCH_OPTION_HINT = 'Sus hoteles se cargan al buscar';

export function loadsOnSearchOptionHint(
  s: Pick<GeoSuggestion, 'loadsOnSearch'>,
): string | undefined {
  return s.loadsOnSearch === true ? LOADS_ON_SEARCH_OPTION_HINT : undefined;
}

/** El aviso debajo del campo con esa ciudad elegida, o `undefined` si no hace falta. */
export function loadsOnSearchNotice(
  s: Pick<GeoSuggestion, 'loadsOnSearch' | 'display'> | undefined,
): string | undefined {
  if (s?.loadsOnSearch !== true) return undefined;
  return `Los hoteles de ${s.display} se traen al buscar: la primera búsqueda puede tardar unos segundos más.`;
}

export interface DestinationNoticeInput {
  readonly query: string;
  /** El destino ya elegido: con él escrito no se sugiere nada. */
  readonly label: string;
  readonly loading: boolean;
  readonly itemsCount: number;
  readonly error?: string;
}

export type DestinationNotice =
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'no-match'; readonly text: string };

/** Qué decir debajo del campo, o `undefined` si no hay nada que decir. */
export function destinationNotice(input: DestinationNoticeInput): DestinationNotice | undefined {
  const q = input.query.trim();
  if (input.loading || q.length < SUGGESTIONS_MIN_QUERY || q === input.label) return undefined;
  if (input.error !== undefined) return { kind: 'error', text: input.error };
  if (input.itemsCount > 0) return undefined;
  return {
    kind: 'no-match',
    text: `No hay ciudades que coincidan con «${q}». Prueba con otro nombre.`,
  };
}
