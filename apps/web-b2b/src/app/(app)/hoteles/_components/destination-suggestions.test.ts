import { describe, expect, it } from 'vitest';
import {
  SUGGESTIONS_MAX_QUERY,
  SUGGESTIONS_UNAVAILABLE,
  destinationNotice,
  parseSuggestionItems,
  suggestionsErrorMessage,
  suggestionsQuery,
} from './destination-suggestions';

/**
 * "No hay ciudades que coincidan" no es lo mismo que "no se pudo consultar": el vendedor prueba
 * otro nombre en el primer caso y espera o avisa en el segundo.
 */

describe('suggestionsQuery — lo que se le pregunta al API', () => {
  it('muy corto: no se pregunta', () => {
    expect(suggestionsQuery('')).toBeUndefined();
    expect(suggestionsQuery(' b ')).toBeUndefined();
  });

  it('recortado y dentro del tope del borde', () => {
    expect(suggestionsQuery('  bogo ')).toBe('bogo');
    expect(suggestionsQuery('a'.repeat(300))).toHaveLength(SUGGESTIONS_MAX_QUERY);
  });
});

describe('suggestionsErrorMessage — el motivo, sin datos técnicos', () => {
  it('sesión vencida y sin permiso, con qué hacer', () => {
    expect(suggestionsErrorMessage(401)).toBe(
      'Tu sesión venció. Volvé a iniciar sesión para buscar destinos.',
    );
    expect(suggestionsErrorMessage(403)).toBe(
      'Tu usuario no tiene permiso para buscar destinos de hoteles.',
    );
  });

  it('demasiadas consultas y servicio caído', () => {
    expect(suggestionsErrorMessage(429)).toContain('demasiadas consultas');
    expect(suggestionsErrorMessage(503)).toContain('no está disponible ahora');
  });

  it('cualquier otro fallo: no se pudo consultar', () => {
    for (const status of [400, 404, 500, 502, 504]) {
      expect(suggestionsErrorMessage(status)).toBe(SUGGESTIONS_UNAVAILABLE);
    }
  });

  it('ningún motivo nombra estados HTTP ni proveedores', () => {
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      const text = suggestionsErrorMessage(status);
      expect(text).not.toMatch(/\d{3}|despegar|tbo|http/i);
    }
  });
});

describe('parseSuggestionItems — la respuesta, sin confiar en su forma', () => {
  it('las sugerencias con id, gid y texto', () => {
    const items = [
      { id: 982, gid: 'g-1', type: 1, display: 'Bogotá, Colombia' },
      { id: 'tbo-hotels:150184', gid: 'g-2', type: 1, display: 'Cartagena' },
    ];
    expect(parseSuggestionItems({ items })).toEqual(items);
  });

  it('descarta las que no tienen forma de sugerencia', () => {
    expect(
      parseSuggestionItems({ items: [{ id: 1, gid: 'g', display: 'Lima' }, { id: 2 }, null] }),
    ).toEqual([{ id: 1, gid: 'g', display: 'Lima' }]);
  });

  it('sin lista no hay respuesta legible', () => {
    expect(parseSuggestionItems({})).toBeUndefined();
    expect(parseSuggestionItems({ items: 'x' })).toBeUndefined();
    expect(parseSuggestionItems(null)).toBeUndefined();
  });
});

describe('destinationNotice — qué decir debajo del campo', () => {
  const base = { query: 'bogo', label: '', loading: false, itemsCount: 0 };

  it('sin coincidencias: lo dice y pide otro nombre', () => {
    expect(destinationNotice(base)).toEqual({
      kind: 'no-match',
      text: 'No hay ciudades que coincidan con «bogo». Probá con otro nombre.',
    });
  });

  it('si no se pudo consultar, el motivo y no "no hay ciudades"', () => {
    expect(destinationNotice({ ...base, error: SUGGESTIONS_UNAVAILABLE })).toEqual({
      kind: 'error',
      text: SUGGESTIONS_UNAVAILABLE,
    });
  });

  it('con sugerencias, cargando, muy corto o ya elegido: nada', () => {
    expect(destinationNotice({ ...base, itemsCount: 3 })).toBeUndefined();
    expect(destinationNotice({ ...base, loading: true, error: 'x' })).toBeUndefined();
    expect(destinationNotice({ ...base, query: 'b' })).toBeUndefined();
    expect(destinationNotice({ ...base, query: 'Bogotá', label: 'Bogotá' })).toBeUndefined();
  });
});
