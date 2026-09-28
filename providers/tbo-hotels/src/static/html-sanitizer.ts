import type { TboContentSection } from './content.types';
import { stripTboControlChars } from './normalize';

/**
 * Saneo del HTML de terceros que trae TBO (docs/tbo/05 §3-§4; 08 RF-32 y RNF-16).
 *
 * `Description` y `Attractions` son HTML de un tercero: riesgo XSS. Se sanea AL INGERIR, con lista
 * blanca, y lo que se guarda en `hotel_content` ya es seguro; la web además escapa al renderizar.
 *
 * El saneador no intenta reproducir el parser de un navegador. Es seguro POR CONSTRUCCIÓN: la
 * salida sólo contiene las etiquetas canónicas de {@link TBO_HTML_ALLOWED_TAGS}, escritas por
 * nosotros y sin atributos, y texto escapado. Si la entrada engaña al tokenizador, lo peor que pasa
 * es que un trozo de marcado se muestre como texto o que se pierda texto, nunca que salga marcado
 * de TBO. Por eso no hay regex sobre la entrada entera: un recorrido lineal, sin retroceso.
 *
 * No hay librería de saneo en el monorepo y no hace falta una: con cinco etiquetas sin atributos la
 * gramática de salida cabe en una línea, y es lo que fija el test.
 */

/** Lista blanca de 05 §3. Sin atributos: ni `href`, ni `style`, ni `on*`. */
export const TBO_HTML_ALLOWED_TAGS = Object.freeze(['p', 'br', 'b', 'ul', 'li'] as const);
type AllowedTag = (typeof TBO_HTML_ALLOWED_TAGS)[number];

const ALLOWED: ReadonlySet<string> = new Set<string>(TBO_HTML_ALLOWED_TAGS);

function isAllowed(name: string): name is AllowedTag {
  return ALLOWED.has(name);
}

/**
 * Elementos cuyo CONTENIDO también se descarta: código, estilos o texto que el navegador no pinta
 * como texto. Quitar sólo la etiqueta de un `<script>` dejaría su código a la vista del vendedor.
 */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'svg',
  'math',
  'textarea',
  'title',
  'head',
  'xmp',
  'plaintext',
  'select',
]);

/**
 * Techo de la entrada. Una descripción de TBO ronda los 3 KB (p. 60); algo mil veces más grande no
 * es contenido y no se procesa entero.
 */
const MAX_INPUT_LENGTH = 200_000;

/** Entidades con nombre que aparecen en texto de hoteles; las demás quedan como texto literal. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
  ['ndash', '\u2013'],
  ['mdash', '\u2014'],
  ['lsquo', '\u2018'],
  ['rsquo', '\u2019'],
  ['ldquo', '\u201c'],
  ['rdquo', '\u201d'],
  ['hellip', '\u2026'],
  ['bull', '\u2022'],
  ['middot', '\u00b7'],
  ['deg', '\u00b0'],
  ['copy', '\u00a9'],
  ['reg', '\u00ae'],
  ['trade', '\u2122'],
  ['euro', '\u20ac'],
  ['laquo', '\u00ab'],
  ['raquo', '\u00bb'],
  ['aacute', 'á'],
  ['eacute', 'é'],
  ['iacute', 'í'],
  ['oacute', 'ó'],
  ['uacute', 'ú'],
  ['Aacute', 'Á'],
  ['Eacute', 'É'],
  ['Iacute', 'Í'],
  ['Oacute', 'Ó'],
  ['Uacute', 'Ú'],
  ['agrave', 'à'],
  ['egrave', 'è'],
  ['acirc', 'â'],
  ['ecirc', 'ê'],
  ['ocirc', 'ô'],
  ['atilde', 'ã'],
  ['otilde', 'õ'],
  ['ntilde', 'ñ'],
  ['Ntilde', 'Ñ'],
  ['ccedil', 'ç'],
  ['Ccedil', 'Ç'],
  ['uuml', 'ü'],
]);

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

function fromCodePoint(codePoint: number): string {
  const invalid =
    codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
  return invalid ? '\ufffd' : String.fromCodePoint(codePoint);
}

/**
 * Decodifica las entidades HTML UNA sola vez, de izquierda a derecha y sin volver sobre lo
 * decodificado: `&amp;lt;` da `&lt;`, nunca `<`. Lo usan el saneador y las condiciones de PreBook,
 * que llegan con el HTML escapado como entidades (docs/tbo/03 §2.4 paso 3).
 */
export function decodeTboHtmlEntities(text: string): string {
  return text.replace(
    ENTITY,
    (
      match: string,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined,
    ) => {
      if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
      if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
      return (name === undefined ? undefined : NAMED_ENTITIES.get(name)) ?? match;
    },
  );
}

/** Todo texto de TBO sale escapado: ni un `<` ni una comilla llegan crudos a la salida. */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeText(raw: string): string {
  // Primero se decodifica y después se quitan los controles: un `&#27;` también es un control.
  return escapeText(stripTboControlChars(decodeTboHtmlEntities(raw)));
}

type Markup =
  | {
      readonly kind: 'tag';
      readonly name: string;
      readonly closing: boolean;
      readonly hasAttributes: boolean;
      readonly end: number;
    }
  /** Comentario, doctype o instrucción de proceso: se descarta entero. */
  | { readonly kind: 'skip'; readonly end: number };

const TAG_NAME_START = /[A-Za-z]/;
const TAG_NAME_CHAR = /[A-Za-z0-9:-]/;
const ATTRIBUTE_SEPARATOR = /[\s/]/;

const GREATER_THAN = 0x3e;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

/**
 * `ends[i]`: el primer `>` fuera de comillas leyendo desde `i`, o `-1` si no hay (o si una comilla
 * no cierra). Se calcula UNA vez por entrada, de derecha a izquierda. Buscarlo desde cada `<` era
 * cuadrático: 200 KB de `<a ` sin ningún `>` tardaban casi un minuto, y el API que lea contenido bajo
 * demanda (PR-3.6) comparte el hilo con las ventas.
 */
function tagEnds(input: string): Int32Array {
  const ends = new Int32Array(input.length + 1).fill(-1);
  let nextDouble = -1;
  let nextSingle = -1;
  for (let at = input.length - 1; at >= 0; at -= 1) {
    const code = input.charCodeAt(at);
    if (code === GREATER_THAN) {
      ends[at] = at;
    } else if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      // La comilla que la cierra es la siguiente igual; la etiqueta sigue después de ella.
      const close = code === DOUBLE_QUOTE ? nextDouble : nextSingle;
      ends[at] = close === -1 ? -1 : (ends[close + 1] ?? -1);
    } else {
      ends[at] = ends[at + 1] ?? -1;
    }
    if (code === DOUBLE_QUOTE) nextDouble = at;
    else if (code === SINGLE_QUOTE) nextSingle = at;
  }
  return ends;
}

/**
 * Lee el marcado que empieza en `input[start] === '<'`. `undefined` si no es marcado: ese `<` se
 * escapa como texto. Una etiqueta sin `>` o con una comilla sin cerrar tampoco es marcado.
 * `tagEndFrom` es {@link tagEnds} ya calculado: cada carácter de la entrada se mira un número
 * acotado de veces, sea cual sea la entrada.
 */
function readMarkup(
  input: string,
  start: number,
  tagEndFrom: (at: number) => number,
): Markup | undefined {
  if (input.startsWith('<!--', start)) {
    const close = input.indexOf('-->', start + 4);
    return { kind: 'skip', end: close === -1 ? input.length : close + 3 };
  }
  const next = input.charAt(start + 1);
  if (next === '!' || next === '?') {
    const close = input.indexOf('>', start + 2);
    return { kind: 'skip', end: close === -1 ? input.length : close + 1 };
  }
  const closing = next === '/';
  let at = start + (closing ? 2 : 1);
  if (!TAG_NAME_START.test(input.charAt(at))) return undefined;
  const nameStart = at;
  while (at < input.length && TAG_NAME_CHAR.test(input.charAt(at))) at += 1;
  const name = input.slice(nameStart, at).toLowerCase();

  const close = tagEndFrom(at);
  if (close === -1) return undefined;
  // Cualquier cosa entre el nombre y el `>` que no sea espacio o `/` es un atributo (también una
  // comilla). El tramo lo consume el cursor, así que recorrerlo no repite trabajo.
  let hasAttributes = false;
  for (; at < close && !hasAttributes; at += 1) {
    if (!ATTRIBUTE_SEPARATOR.test(input.charAt(at))) hasAttributes = true;
  }
  return { kind: 'tag', name, closing, hasAttributes, end: close + 1 };
}

/**
 * Fin del contenido de un elemento descartado: después de su `</nombre …>`, o el final de la
 * entrada si no se cierra. Sin cierre se pierde el resto a propósito: un `<script>` abierto es
 * código hasta el final para un navegador.
 */
function skipDroppedContent(input: string, name: string, from: number): number {
  // `name` sale de `DROPPED_WITH_CONTENT`: sólo letras, seguro dentro de una regex.
  const closer = new RegExp(`</${name}(?=[\\s/>]|$)`, 'gi');
  closer.lastIndex = from;
  const found = closer.exec(input);
  if (found === null) return input.length;
  const close = input.indexOf('>', found.index);
  return close === -1 ? input.length : close + 1;
}

/** Cierra las etiquetas abiertas hasta `name` inclusive, en orden. */
function closeUpTo(name: AllowedTag, open: AllowedTag[], out: string[]): void {
  for (let tag = open.pop(); tag !== undefined; tag = open.pop()) {
    out.push(`</${tag}>`);
    if (tag === name) return;
  }
}

/** La más interna de `names` que está abierta, o `undefined`. */
function innermostOpen(open: readonly AllowedTag[], names: readonly AllowedTag[]) {
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const tag = open[index];
    if (tag !== undefined && names.includes(tag)) return tag;
  }
  return undefined;
}

/**
 * Profundidad máxima de anidamiento. El HTML de TBO no pasa de 3 (p. 60-61, 67-68); el techo acota
 * lo que cuesta cada etiqueta, que si no crecería con la pila (miles de `<b>` abiertos).
 */
const MAX_OPEN_DEPTH = 32;

/**
 * Emite una etiqueta permitida, balanceada. `false` si se descartó (cierre sin apertura, o una
 * apertura por encima de {@link MAX_OPEN_DEPTH}).
 */
function emitAllowed(
  name: AllowedTag,
  closing: boolean,
  open: AllowedTag[],
  out: string[],
): boolean {
  // `</br>` es un `<br>` para el navegador; aquí también, y nunca se apila.
  if (name === 'br') {
    out.push('<br>');
    return true;
  }
  if (closing) {
    if (!open.includes(name)) return false;
    closeUpTo(name, open, out);
    return true;
  }
  // Un `<p>` dentro de otro `<p>`, o un `<li>` dentro de otro `<li>` de la misma lista, cierra el
  // anterior, como en el navegador: así la salida no depende de cómo lo repare quien la pinte.
  if (name === 'p' && open.includes('p')) closeUpTo('p', open, out);
  if (name === 'li' && innermostOpen(open, ['li', 'ul']) === 'li') closeUpTo('li', open, out);
  if (open.length >= MAX_OPEN_DEPTH) return false;
  open.push(name);
  out.push(`<${name}>`);
  return true;
}

export interface TboSanitizedHtml {
  /** Sólo etiquetas de la lista blanca, sin atributos y balanceadas, y texto escapado. */
  readonly html: string;
  /** Etiquetas, atributos, comentarios o bloques quitados. `0` si la entrada ya era segura. */
  readonly removed: number;
}

/**
 * HTML de TBO → HTML seguro (RNF-16). Un `<script>` desaparece con su contenido; un `<a
 * href="javascript:…">` pierde la etiqueta y conserva su texto; un `<p onclick=…>` queda `<p>`.
 */
export function sanitizeTboHtml(input: string): TboSanitizedHtml {
  const source = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input;
  const out: string[] = [];
  const open: AllowedTag[] = [];
  let removed = source.length === input.length ? 0 : 1;
  let cursor = 0;
  // Sólo se calcula si aparece un `<`: el texto sin marcado no paga el arreglo.
  let ends: Int32Array | undefined;
  const tagEndFrom = (at: number): number => {
    ends ??= tagEnds(source);
    return ends[at] ?? -1;
  };

  while (cursor < source.length) {
    const lt = source.indexOf('<', cursor);
    const textEnd = lt === -1 ? source.length : lt;
    if (textEnd > cursor) out.push(safeText(source.slice(cursor, textEnd)));
    if (lt === -1) break;

    const markup = readMarkup(source, lt, tagEndFrom);
    if (markup === undefined) {
      out.push('&lt;');
      cursor = lt + 1;
      continue;
    }
    cursor = markup.end;
    if (markup.kind === 'skip') {
      removed += 1;
      continue;
    }
    if (!markup.closing && DROPPED_WITH_CONTENT.has(markup.name)) {
      removed += 1;
      cursor = skipDroppedContent(source, markup.name, markup.end);
      continue;
    }
    if (!isAllowed(markup.name)) {
      removed += 1;
      continue;
    }
    if (markup.hasAttributes) removed += 1;
    if (!emitAllowed(markup.name, markup.closing, open, out)) removed += 1;
  }
  for (let tag = open.pop(); tag !== undefined; tag = open.pop()) out.push(`</${tag}>`);
  return { html: out.join(''), removed };
}

/**
 * Texto plano para WhatsApp y B2C (RF-32): párrafos separados por una línea en blanco, `<br>` como
 * salto, `<li>` como viñeta y los espacios colapsados. Sanea primero, así que acepta tanto el HTML
 * de TBO como el ya saneado (sanear es idempotente). `null` si no queda texto.
 */
export function tboHtmlToText(html: string): string | null {
  const text = sanitizeTboHtml(html)
    .html.replace(/<br>/g, '\n')
    .replace(/<\/?p>/g, '\n\n')
    .replace(/<li>/g, '\n\u2022 ')
    // El salto de cada viñeta lo pone su `<li>`: si el cierre también saltara, quedaría una línea
    // en blanco entre viñetas.
    .replace(/<\/li>/g, '')
    .replace(/<\/?ul>/g, '\n')
    .replace(/<\/?b>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // `&amp;` al final: decodificarlo antes convertiría un `&amp;lt;` literal en un `<`.
    .replace(/&amp;/g, '&');
  const joined = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return joined.length === 0 ? null : joined;
}

/**
 * `<p>Etiqueta : texto</p>` → `{label, text}` (05 §3). Así llegan "HeadLine", "Location",
 * "CheckIn Instructions" o "Special Instructions" (p. 60, 68). Lo que no tiene esa forma —el aviso
 * "Disclaimer notification" que va fuera de todo `<p>`— queda en el texto completo, no en una
 * sección.
 */
const SECTION = /^([A-Za-z][A-Za-z &/-]{0,59}?)\s*:\s*(\S[\s\S]*)$/;

export function splitTboDescriptionSections(html: string): TboContentSection[] {
  const sections: TboContentSection[] = [];
  for (const paragraph of sanitizeTboHtml(html).html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    const text = tboHtmlToText(`<p>${paragraph[1] ?? ''}</p>`);
    const match = text === null ? null : SECTION.exec(text);
    const label = match?.[1]?.trim();
    const body = match?.[2]?.trim();
    if (label !== undefined && label.length > 0 && body !== undefined && body.length > 0) {
      sections.push({ label, text: body });
    }
  }
  return sections;
}

// ───────────────────────── Servicios negados ─────────────────────────

/** Techo de un servicio: son etiquetas cortas ("Free WiFi"); más es un párrafo mal puesto. */
const MAX_FACILITY_LENGTH = 200;

/** "… – no", con guion, guion corto, raya o signo menos (p. 61: "Wheelchair accessible – no"). */
const NEGATED_FACILITY = /^(.*?\S)\s*[-\u2010-\u2015\u2212]\s*no\.?$/i;

export interface TboFacilityRead {
  readonly label: string;
  readonly available: boolean;
}

/**
 * Un servicio de `HotelFacilities` en texto plano, y si está disponible. "Wheelchair accessible –
 * no" es la NEGACIÓN de un servicio: mostrarlo en la lista de servicios diría lo contrario de lo que
 * dice TBO (RF-32; 05 §4). No alimenta filtros hasta que exista un diccionario. `undefined` si no
 * queda texto.
 */
export function classifyTboFacility(raw: string): TboFacilityRead | undefined {
  const text = tboHtmlToText(raw)?.replace(/\s+/g, ' ').slice(0, MAX_FACILITY_LENGTH);
  if (text === undefined || text.length === 0) return undefined;
  const negated = NEGATED_FACILITY.exec(text)?.[1];
  return negated === undefined
    ? { label: text, available: true }
    : { label: negated, available: false };
}
