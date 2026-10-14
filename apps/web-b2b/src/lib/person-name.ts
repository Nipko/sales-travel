/**
 * El nombre visible de una persona, del lado del panel: espejo de `packages/validation/src/
 * person-name.ts` (PersonNameSchema, el borde de PATCH /me). El panel no depende de ese paquete ni
 * de Zod; repite las reglas para decir el error junto al campo sin ir al API, y el API las vuelve a
 * aplicar. Si cambian allá, cambian acá: los tests de los dos lados usan los mismos casos.
 */

export const PERSON_NAME_MAX = 120;

/**
 * Controles, formato (dirección, ancho cero), sustitutos sueltos, uso privado y sin asignar, más los
 * rellenos Hangul y el braille en blanco, que Unicode cuenta como letra o símbolo y se pintan vacíos.
 */
const INVISIBLE_OR_CONTROL = /[\p{C}\u115F\u1160\u3164\uFFA0\u2800]/u;

const LETTER = /\p{L}/u;

export const PERSON_NAME_MESSAGES = {
  required: 'Escribe tu nombre.',
  tooLong: `Tu nombre puede tener hasta ${PERSON_NAME_MAX} caracteres.`,
  invisible: 'Tu nombre tiene caracteres invisibles o de control. Escríbelo de nuevo a mano.',
  noLetter: 'Tu nombre tiene que tener al menos una letra.',
} as const;

/** NFC, los espacios y saltos de línea seguidos pasan a uno solo, y sin espacios en los bordes. */
export function normalizePersonName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Por qué un nombre ya normalizado no sirve, o `null` si sirve. */
export function personNameProblem(name: string): string | null {
  if (name.length === 0) return PERSON_NAME_MESSAGES.required;
  if (name.length > PERSON_NAME_MAX) return PERSON_NAME_MESSAGES.tooLong;
  if (INVISIBLE_OR_CONTROL.test(name)) return PERSON_NAME_MESSAGES.invisible;
  if (!LETTER.test(name)) return PERSON_NAME_MESSAGES.noLetter;
  return null;
}

export type PersonNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly error: string };

/** Lo que escribió la persona, normalizado y validado. */
export function checkPersonName(raw: unknown): PersonNameCheck {
  if (typeof raw !== 'string') return { ok: false, error: PERSON_NAME_MESSAGES.required };
  const name = normalizePersonName(raw);
  const error = personNameProblem(name);
  return error === null ? { ok: true, name } : { ok: false, error };
}
