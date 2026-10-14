import { z } from 'zod';

/**
 * El nombre visible de una persona (`users.name`): el que ve su equipo en Equipo, la ficha y el
 * directorio, y el que sale en los correos ("Te invitó Laura Gómez", el saludo de los avisos).
 *
 * El tope es el del canje de la invitación (`AcceptInvitationSchema.name`, 1 a 120), contado en
 * unidades UTF-16 como `z.string().max()`, para que un nombre elegido al sumarse quepa siempre al
 * editarlo.
 */
export const PERSON_NAME_MAX = 120;

/**
 * Lo que no se ve o no es texto: controles (`Cc`), formato (`Cf`: los de dirección como U+202E, que
 * dan vuelta lo que sigue, y los de ancho cero), sustitutos sueltos, uso privado y sin asignar
 * (todo `\p{C}`). Más los rellenos que Unicode clasifica como letra o símbolo y se pintan vacíos
 * (Hangul U+115F, U+1160, U+3164, U+FFA0 y el braille en blanco U+2800): son el truco de siempre
 * para un nombre "invisible". Se rechazan en vez de quitarse: quitarlos en silencio guardaría algo
 * distinto de lo que la persona cree que escribió.
 */
const INVISIBLE_OR_CONTROL = /[\p{C}\u115F\u1160\u3164\uFFA0\u2800]/u;

const LETTER = /\p{L}/u;

export const PERSON_NAME_MESSAGES = {
  required: 'Escribe tu nombre.',
  tooLong: `Tu nombre puede tener hasta ${PERSON_NAME_MAX} caracteres.`,
  invisible: 'Tu nombre tiene caracteres invisibles o de control. Escríbelo de nuevo a mano.',
  noLetter: 'Tu nombre tiene que tener al menos una letra.',
} as const;

/**
 * La forma en que se guarda: NFC (una "é" compuesta y una "e" con tilde combinada son el mismo
 * nombre y miden lo mismo), cualquier espacio de Unicode o salto de línea seguidos pasan a un solo
 * espacio, y sin espacios en los bordes.
 */
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

/** El nombre de una persona en un borde del API: normalizado y validado (ver arriba). */
export const PersonNameSchema = z
  .string({
    required_error: PERSON_NAME_MESSAGES.required,
    invalid_type_error: PERSON_NAME_MESSAGES.required,
  })
  .transform(normalizePersonName)
  .superRefine((name, ctx) => {
    const problem = personNameProblem(name);
    if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });
