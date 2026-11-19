/*
 * Los nombres de huésped como los recibe Despegar. HotelDO, del otro lado, sólo acepta letras
 * latinas (con tildes y ñ) y espacios (certificación, punto 4): un guion o un apóstrofo hace fallar
 * el Book. El vendedor, en cambio, escribe el nombre como figura en el documento (`García-López`,
 * `O'Brien`), y es lo que TBO acepta y lo que pide el formulario. En vez de rechazarlo, el borde de
 * Despegar lo adapta (auditoría de flujos de venta, H5):
 *
 * - un guion separa dos nombres: pasa a espacio (`García-López` → `García López`);
 * - un apóstrofo une partes de un mismo apellido: se quita, como hacen las aerolíneas
 *   (`O'Brien` → `OBrien`);
 * - una letra latina fuera del rango de HotelDO pierde su marca (`Łukasz` → `Lukasz`).
 *
 * Lo que no se puede pasar a letras sin inventar (otro alfabeto, números, signos) sigue siendo un
 * nombre inválido: mejor pedirlo en latino que mandar algo que el hotel lea como otra persona.
 */

/** Sólo letras (latinas con tildes y ñ) y espacios: lo que acepta HotelDO. */
export const DESPEGAR_GUEST_NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]+( [A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;

const DESPEGAR_LETTER = /^[A-Za-zÀ-ÖØ-öø-ÿ]$/;
/** El ASCII y los tipográficos que pone un teclado móvil o un documento pegado. */
const APOSTROPHES = /['‘’‛ʼʹ´`′]/g;
const HYPHENS = /[-‐‑‒–—−]/g;
const COMBINING_MARKS = /[̀-ͯ]/g;
const TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  ['ł', 'l'],
  ['Ł', 'L'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ı', 'i'],
  ['ħ', 'h'],
  ['Ħ', 'H'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
]);

function letterForDespegar(char: string): string {
  if (char === ' ' || DESPEGAR_LETTER.test(char)) return char;
  const stripped = char.normalize('NFKD').replace(COMBINING_MARKS, '');
  if (stripped.length > 0 && [...stripped].every((c) => DESPEGAR_LETTER.test(c))) return stripped;
  return TRANSLITERATIONS.get(char) ?? char;
}

/**
 * El nombre adaptado a Despegar, o `undefined` si no se puede sin inventar. No mide largos: eso lo
 * decide quien llama, con el nombre ya adaptado.
 */
export function despegarGuestName(raw: string): string | undefined {
  const adapted = [
    ...raw
      .normalize('NFC')
      .replace(APOSTROPHES, '')
      .replace(HYPHENS, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .map(letterForDespegar)
    .join('')
    .normalize('NFC');
  return DESPEGAR_GUEST_NAME_RE.test(adapted) ? adapted : undefined;
}
