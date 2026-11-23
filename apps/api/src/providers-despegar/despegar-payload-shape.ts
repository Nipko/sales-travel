/**
 * La FORMA de una respuesta de Despegar: las rutas de sus campos, sin un solo valor
 * (`roompacks[].rooms[].choice_id`). Sirve para ver dónde manda Despegar un campo que la
 * documentación ubica en otro lado sin abrir la bóveda: los nombres de campo son el esquema de su
 * API, no datos de nadie. Una clave que no parece un nombre de campo (un id usado como clave) sale
 * como `*`.
 */

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MAX_PATHS = 150;
const MAX_DEPTH = 8;

export function payloadShape(body: string | undefined): string[] {
  if (body === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const paths = new Set<string>();
  const walk = (v: unknown, path: string, depth: number): void => {
    if (paths.size >= MAX_PATHS || depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 20)) walk(item, `${path}[]`, depth + 1);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        const p = `${path}${path === '' ? '' : '.'}${FIELD.test(k) ? k : '*'}`;
        paths.add(p);
        walk(child, p, depth + 1);
      }
    }
  };
  walk(json, '', 0);
  return [...paths].sort();
}

/**
 * Una respuesta de disponibilidad sin una sola tarifa: ninguna ruta entra en un `roompacks`
 * (`roompacks: []` deja la ruta `roompacks`, pero no `roompacks[]…`).
 */
export function isEmptyAvailability(shape: readonly string[]): boolean {
  return !shape.some((p) => p.includes('roompacks[]'));
}
