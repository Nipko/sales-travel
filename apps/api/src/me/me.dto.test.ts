import {
  normalizePersonName,
  PERSON_NAME_MAX,
  PERSON_NAME_MESSAGES,
  PersonNameSchema,
} from '@sales-travel/validation';
import { describe, expect, it } from 'vitest';
import { UpdateProfileSchema } from './me.dto.js';

/** Los caracteres invisibles se arman por código: escritos tal cual, un reencode los borra sin aviso. */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

function messageOf(input: unknown): string | undefined {
  const res = PersonNameSchema.safeParse(input);
  return res.success ? undefined : res.error.issues[0]?.message;
}

describe('PersonNameSchema (el nombre visible de una persona)', () => {
  it('recorta los bordes y junta los espacios y saltos de línea de adentro', () => {
    expect(PersonNameSchema.parse('  Laura   Gómez  ')).toBe('Laura Gómez');
    expect(PersonNameSchema.parse('Laura\tGómez\r\nPérez')).toBe('Laura Gómez Pérez');
    // Espacio duro, espacio fino y el ideográfico también son espacios.
    expect(PersonNameSchema.parse(`Laura${cp(0xa0)}${cp(0x202f)}Gómez${cp(0x3000)}`)).toBe(
      'Laura Gómez',
    );
  });

  it('guarda en NFC: la tilde combinada y la compuesta son el mismo nombre', () => {
    const combinada = `Jose${cp(0x301)}`;
    expect(PersonNameSchema.parse(combinada)).toBe('José');
    expect(PersonNameSchema.parse(combinada)).toBe(normalizePersonName('José'));
  });

  it('acepta nombres de cualquier alfabeto, con apóstrofo, guion o punto', () => {
    for (const name of [
      "María José O'Neill",
      'Ana-Lucía Pérez',
      'J. R. Tolkien',
      'Zoë',
      '李小龙',
    ]) {
      expect(PersonNameSchema.parse(name)).toBe(name);
    }
    expect(PersonNameSchema.parse('J')).toBe('J');
  });

  it('vacío o sólo espacios: pide el nombre', () => {
    expect(messageOf('')).toBe(PERSON_NAME_MESSAGES.required);
    expect(messageOf('   \n\t ')).toBe(PERSON_NAME_MESSAGES.required);
    expect(messageOf(undefined)).toBe(PERSON_NAME_MESSAGES.required);
    expect(messageOf(42)).toBe(PERSON_NAME_MESSAGES.required);
    expect(messageOf(null)).toBe(PERSON_NAME_MESSAGES.required);
  });

  it('el tope es el del canje de la invitación (120), contado después de normalizar', () => {
    expect(PERSON_NAME_MAX).toBe(120);
    expect(PersonNameSchema.parse('a'.repeat(120))).toHaveLength(120);
    expect(messageOf('a'.repeat(121))).toBe(PERSON_NAME_MESSAGES.tooLong);
    // Los espacios de sobra no cuentan: se juntan antes de medir.
    expect(PersonNameSchema.parse(`  ${'a'.repeat(60)}     ${'b'.repeat(59)}  `)).toHaveLength(120);
  });

  it('rechaza caracteres de control (no se quitan en silencio)', () => {
    for (const code of [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9b]) {
      expect(messageOf(`Ana${cp(code)}Gómez`), code.toString(16)).toBe(
        PERSON_NAME_MESSAGES.invisible,
      );
    }
  });

  it('rechaza los controles de dirección que dan vuelta lo que se ve', () => {
    for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066]) {
      expect(messageOf(`Ana${cp(code)}Gómez`), code.toString(16)).toBe(
        PERSON_NAME_MESSAGES.invisible,
      );
    }
    expect(messageOf(`Ana${cp(0x2067)}Gómez${cp(0x2069)}`)).toBe(PERSON_NAME_MESSAGES.invisible);
  });

  it('rechaza los invisibles: ancho cero, guion blando, etiquetas y los rellenos que parecen vacío', () => {
    const invisibles = [
      0x200b, // espacio de ancho cero
      0x200c, // ZWNJ
      0x200d, // ZWJ
      0x2060, // word joiner
      0x00ad, // guion blando
      0x180e, // separador vocálico mongol
      0xe0041, // etiqueta
      0xe000, // uso privado
      0x115f, // rellenos Hangul (Unicode los cuenta como letras)
      0x1160,
      0x3164,
      0xffa0,
      0x2800, // braille en blanco
    ];
    for (const code of invisibles) {
      expect(messageOf(`Ana${cp(code)}Gómez`), code.toString(16)).toBe(
        PERSON_NAME_MESSAGES.invisible,
      );
    }
    // Un nombre hecho sólo de rellenos no es un nombre "vacío que pasa".
    expect(messageOf(cp(0x3164, 0x3164))).toBe(PERSON_NAME_MESSAGES.invisible);
  });

  it('un U+FEFF suelto cuenta como espacio, no como parte del nombre', () => {
    expect(PersonNameSchema.parse(`${cp(0xfeff)}Ana${cp(0xfeff)}Gómez`)).toBe('Ana Gómez');
  });

  it('rechaza un sustituto suelto', () => {
    expect(messageOf(`Ana${String.fromCharCode(0xd800)}`)).toBe(PERSON_NAME_MESSAGES.invisible);
  });

  it('pide al menos una letra: sin eso no es un nombre', () => {
    expect(messageOf('.')).toBe(PERSON_NAME_MESSAGES.noLetter);
    expect(messageOf('123 456')).toBe(PERSON_NAME_MESSAGES.noLetter);
    expect(messageOf('— · —')).toBe(PERSON_NAME_MESSAGES.noLetter);
    expect(PersonNameSchema.parse('Ana 2')).toBe('Ana 2');
  });

  it('el HTML no se interpreta acá: se guarda como texto y lo escapa quien lo pinta', () => {
    expect(PersonNameSchema.parse('<b>Ana</b>')).toBe('<b>Ana</b>');
  });
});

describe('UpdateProfileSchema (PATCH /me)', () => {
  it('sólo el nombre, normalizado', () => {
    expect(UpdateProfileSchema.parse({ name: '  Laura  Gómez ' })).toEqual({ name: 'Laura Gómez' });
  });

  it('un correo o un id en el cuerpo es un 400, no algo que se ignora', () => {
    for (const extra of [{ email: 'otra@x.com' }, { userId: 'u-2' }, { id: 'u-2' }]) {
      const res = UpdateProfileSchema.safeParse({ name: 'Laura', ...extra });
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.message).toBe('Desde tu perfil sólo puedes cambiar tu nombre.');
    }
  });

  it('sin nombre, pide el nombre', () => {
    const res = UpdateProfileSchema.safeParse({});
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]).toMatchObject({
      path: ['name'],
      message: PERSON_NAME_MESSAGES.required,
    });
  });
});
