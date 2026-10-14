import { describe, expect, it } from 'vitest';
import { checkPersonName, PERSON_NAME_MAX, PERSON_NAME_MESSAGES } from './person-name';
import { voseoIn } from './voseo';

/*
 * Los mismos casos que `apps/api/src/me/me.dto.test.ts` (PersonNameSchema): el panel dice el error
 * junto al campo y el API lo vuelve a validar, así que tienen que estar de acuerdo.
 */

/** Los invisibles se arman por código: escritos tal cual, un reencode los borra sin aviso. */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

function errorOf(raw: unknown): string | undefined {
  const res = checkPersonName(raw);
  return res.ok ? undefined : res.error;
}

function nameOf(raw: string): string | undefined {
  const res = checkPersonName(raw);
  return res.ok ? res.name : undefined;
}

describe('checkPersonName (espejo de PersonNameSchema)', () => {
  it('recorta, junta espacios y saltos de línea y pasa a NFC', () => {
    expect(nameOf('  Laura   Gómez  ')).toBe('Laura Gómez');
    expect(nameOf('Laura\tGómez\r\nPérez')).toBe('Laura Gómez Pérez');
    expect(nameOf(`Laura${cp(0xa0)}${cp(0x202f)}Gómez${cp(0x3000)}`)).toBe('Laura Gómez');
    expect(nameOf(`Jose${cp(0x301)}`)).toBe('José');
    expect(nameOf(`${cp(0xfeff)}Ana${cp(0xfeff)}Gómez`)).toBe('Ana Gómez');
  });

  it('acepta nombres de cualquier alfabeto, con apóstrofo, guion o punto', () => {
    for (const name of [
      "María José O'Neill",
      'Ana-Lucía Pérez',
      'J. R. Tolkien',
      'Zoë',
      '李小龙',
    ]) {
      expect(nameOf(name)).toBe(name);
    }
  });

  it('vacío, sólo espacios o algo que no es texto: pide el nombre', () => {
    for (const raw of ['', '   \n\t ', undefined, null, 42]) {
      expect(errorOf(raw)).toBe(PERSON_NAME_MESSAGES.required);
    }
  });

  it('hasta 120, contados después de normalizar', () => {
    expect(PERSON_NAME_MAX).toBe(120);
    expect(nameOf('a'.repeat(120))).toHaveLength(120);
    expect(errorOf('a'.repeat(121))).toBe(PERSON_NAME_MESSAGES.tooLong);
    expect(nameOf(`  ${'a'.repeat(60)}     ${'b'.repeat(59)}  `)).toHaveLength(120);
  });

  it('rechaza controles, los de dirección y los invisibles', () => {
    const codes = [
      0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9b, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d,
      0x202e, 0x2066, 0x2067, 0x2069, 0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0x180e, 0xe0041,
      0xe000, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800,
    ];
    for (const code of codes) {
      expect(errorOf(`Ana${cp(code)}Gómez`), code.toString(16)).toBe(
        PERSON_NAME_MESSAGES.invisible,
      );
    }
    expect(errorOf(cp(0x3164, 0x3164))).toBe(PERSON_NAME_MESSAGES.invisible);
    expect(errorOf(`Ana${String.fromCharCode(0xd800)}`)).toBe(PERSON_NAME_MESSAGES.invisible);
  });

  it('pide al menos una letra', () => {
    for (const raw of ['.', '123 456', '— · —']) {
      expect(errorOf(raw)).toBe(PERSON_NAME_MESSAGES.noLetter);
    }
    expect(nameOf('Ana 2')).toBe('Ana 2');
  });

  it('los mensajes van en tú', () => {
    expect(voseoIn(Object.values(PERSON_NAME_MESSAGES).join(' '))).toEqual([]);
  });
});
