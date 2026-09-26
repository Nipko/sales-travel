import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TBO_HTML_ALLOWED_TAGS,
  classifyTboFacility,
  sanitizeTboHtml,
  splitTboDescriptionSections,
  tboHtmlToText,
} from './html-sanitizer';

/**
 * El saneador del HTML de TBO (docs/tbo/05 §3-§4; 08 RF-32 y RNF-16). La defensa se prueba de dos
 * maneras: con los vectores conocidos, y con una gramática de salida que cualquier entrada tiene
 * que cumplir. La gramática lleva su propia prueba de que distingue las dos ramas (06 §7.4).
 */

interface HotelDetailsFixture {
  readonly HotelDetails: readonly { readonly Description: string }[];
}

const DESCRIPTION_P60 = (
  JSON.parse(
    readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'hotel-details.p59.json'), 'utf8'),
  ) as HotelDetailsFixture
).HotelDetails[0]?.Description;

function description(): string {
  if (DESCRIPTION_P60 === undefined) throw new Error('fixture sin Description');
  return DESCRIPTION_P60;
}

const ALLOWED_MARKUP = new Set(
  TBO_HTML_ALLOWED_TAGS.flatMap((tag) => (tag === 'br' ? ['<br>'] : [`<${tag}>`, `</${tag}>`])),
);
const SAFE_ENTITIES = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'];

/**
 * La gramática de salida: sólo etiquetas canónicas de la lista blanca, balanceadas; y en el texto,
 * ni `<`, ni `>`, ni comillas crudas, y todo `&` empieza una de las cinco entidades de escape.
 * Devuelve el primer motivo por el que NO cumple, o `undefined`.
 */
function grammarViolation(html: string): string | undefined {
  const stack: string[] = [];
  let at = 0;
  while (at < html.length) {
    const char = html.charAt(at);
    if (char === '<') {
      const end = html.indexOf('>', at);
      const tag = end === -1 ? html.slice(at) : html.slice(at, end + 1);
      if (!ALLOWED_MARKUP.has(tag)) return `etiqueta no canónica: ${tag.slice(0, 40)}`;
      if (tag !== '<br>') {
        const name = tag.replace(/[</>]/g, '');
        if (tag.startsWith('</')) {
          if (stack.pop() !== name) return `cierre desbalanceado: ${tag}`;
        } else {
          stack.push(name);
        }
      }
      at += tag.length;
      continue;
    }
    if (char === '>' || char === '"' || char === "'") return `carácter crudo: ${char}`;
    if (char === '&' && !SAFE_ENTITIES.some((entity) => html.startsWith(entity, at))) {
      return `& sin escapar en ${at}`;
    }
    at += 1;
  }
  return stack.length === 0 ? undefined : `sin cerrar: ${stack.join(',')}`;
}

describe('la gramática de salida distingue las dos ramas (si no, el fuzz sería vacuo)', () => {
  it.each([
    '<p>ok</p><br><b>x</b><ul><li>a</li></ul>',
    'a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;',
  ])('acepta %j', (html) => {
    expect(grammarViolation(html)).toBeUndefined();
  });

  it.each([
    '<img src=x>',
    '<p class="x">a</p>',
    '<br/>',
    '<p>a',
    '</p>',
    '<b><p>x</b></p>',
    'a "b"',
    "a 'b'",
    'a > b',
    'a & b',
    '&nbsp;',
    '<script>',
  ])('rechaza %j', (html) => {
    expect(grammarViolation(html)).toBeDefined();
  });
});

describe('sanitizeTboHtml: lista blanca sin atributos (RNF-16)', () => {
  it('conserva p, br, b, ul y li, y normaliza <br/> a <br>', () => {
    expect(sanitizeTboHtml('<p>a</p><br/><BR /><b>x</b><ul><li>1</li></ul>')).toEqual({
      html: '<p>a</p><br><br><b>x</b><ul><li>1</li></ul>',
      removed: 0,
    });
  });

  it('RF-32 CA: un <script> se elimina al ingerir, con su contenido', () => {
    const out = sanitizeTboHtml('<p>Hola</p><script>alert(document.cookie)</script><p>Chau</p>');
    expect(out).toEqual({ html: '<p>Hola</p><p>Chau</p>', removed: 1 });
  });

  it.each([
    ['<SCRIPT SRC="//x.test/a.js"></SCRIPT>ok', 'ok'],
    ['<script type="text/javascript">var a = "</p>";</script >ok', 'ok'],
    ['<p>a</p><script>never closed <p>b</p>', '<p>a</p>'],
    ['<svg><script>alert(1)</script></svg>ok', 'ok'],
    ['<iframe src="https://x.test">inner</iframe>ok', 'ok'],
    ['<style>p { color: red }</style>ok', 'ok'],
    ['<noscript><p>x</p></noscript>ok', 'ok'],
    ['<template><b>x</b></template>ok', 'ok'],
    ['<textarea><script>x</script></textarea>ok', 'ok'],
  ])('%j → %j', (input, html) => {
    expect(sanitizeTboHtml(input).html).toBe(html);
  });

  it('quita atributos: ni on*, ni style, ni href', () => {
    const out = sanitizeTboHtml(
      '<p onclick="alert(1)" style="background:url(javascript:alert(1))">t</p>' +
        '<a href="javascript:alert(1)">click</a><img src=x onerror=alert(1)>',
    );
    expect(out.html).toBe('<p>t</p>click');
    // Los atributos del <p>, el <a>, su cierre y el <img>.
    expect(out.removed).toBe(4);
  });

  it('un > dentro de un atributo entre comillas no corta la etiqueta', () => {
    expect(sanitizeTboHtml('<p title="a>b">x</p>').html).toBe('<p>x</p>');
  });

  it('comentarios, doctype e instrucciones de proceso desaparecen enteros', () => {
    expect(sanitizeTboHtml('a<!-- <script>x</script> -->b<!DOCTYPE html><?xml x?>c').html).toBe(
      'abc',
    );
    expect(sanitizeTboHtml('a<!-- sin cerrar <b>x</b>').html).toBe('a');
  });

  it('el marcado de TBO escrito como texto sigue siendo texto', () => {
    expect(sanitizeTboHtml('&lt;script&gt;alert(1)&lt;/script&gt;').html).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(sanitizeTboHtml('5 < 6 y 7 > 3; <3 <').html).toBe('5 &lt; 6 y 7 &gt; 3; &lt;3 &lt;');
  });

  it('escapa comillas y ampersands del texto', () => {
    expect(sanitizeTboHtml(`Say "hi" & 'bye'`).html).toBe('Say &quot;hi&quot; &amp; &#39;bye&#39;');
  });

  it('decodifica una sola vez las entidades y deja literal la que no conoce', () => {
    expect(sanitizeTboHtml('a&nbsp;b &#233; &#x41; &eacute; &amp;nbsp; &foo; &#0;').html).toBe(
      'a\u00a0b é A é &amp;nbsp; &amp;foo; \ufffd',
    );
  });

  it('quita caracteres de control, también si llegan como entidad', () => {
    expect(sanitizeTboHtml('a\u0000b&#27;c\u0007d\te\nf').html).toBe('abcd\te\nf');
  });

  it('balancea: cierra lo abierto, descarta el cierre huérfano y cierra el <p> anidado', () => {
    expect(sanitizeTboHtml('<b>x').html).toBe('<b>x</b>');
    expect(sanitizeTboHtml('</b>x')).toEqual({ html: 'x', removed: 1 });
    expect(sanitizeTboHtml('<p>a<p>b').html).toBe('<p>a</p><p>b</p>');
    expect(sanitizeTboHtml('<ul><li>a<li>b</ul>').html).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(sanitizeTboHtml('<p><b>a</p>b').html).toBe('<p><b>a</b></p>b');
  });

  it('la descripción de p. 60 sale igual, salvo &nbsp; y <br/> en forma canónica', () => {
    const input = description();
    expect(sanitizeTboHtml(input)).toEqual({
      html: input.replace('&nbsp;', '\u00a0').replace('<br/>', '<br>'),
      removed: 0,
    });
  });

  it('es idempotente', () => {
    for (const input of [description(), '<p onclick=x>a<script>b</script><b>c', '&amp;lt; <']) {
      const once = sanitizeTboHtml(input).html;
      expect(sanitizeTboHtml(once)).toEqual({ html: once, removed: 0 });
    }
  });

  it('una comilla sin cerrar no se traga la etiqueta que viene después', () => {
    expect(sanitizeTboHtml('<a "x <b> "y').html).toBe('&lt;a &quot;x <b> &quot;y</b>');
    expect(sanitizeTboHtml('<b " <p>c</p> " >z')).toEqual({ html: '<b>z</b>', removed: 1 });
  });

  it('el anidamiento tiene techo: lo que pasa de 32 niveles se descarta y sigue balanceado', () => {
    const out = sanitizeTboHtml(`${'<b>'.repeat(100)}x`);
    expect(out.html).toBe(`${'<b>'.repeat(32)}x${'</b>'.repeat(32)}`);
    expect(out.removed).toBe(68);
    expect(grammarViolation(out.html)).toBeUndefined();
  });

  it('coste lineal: 200 KB de marcado roto no bloquean el hilo', () => {
    // Antes de calcular el cierre de etiqueta una sola vez, el primero tardaba ~56 s y el segundo
    // ~3 s: cada `<` sin `>` releía la entrada hasta el final. El techo es holgado para CI.
    const hostile = [
      '<a '.repeat(66_000),
      '<a "'.repeat(50_000),
      "<a '".repeat(50_000),
      `${'<b>'.repeat(40_000)}${'<p>'.repeat(20_000)}`,
      `${'<ul>'.repeat(30_000)}${'</li>'.repeat(20_000)}`,
    ];
    for (const input of hostile) {
      const started = performance.now();
      const { html } = sanitizeTboHtml(input);
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(grammarViolation(html)).toBeUndefined();
    }
  });

  it('una entrada enorme se procesa recortada y se marca', () => {
    const out = sanitizeTboHtml(`<p>${'a'.repeat(300_000)}</p>`);
    expect(out.html.length).toBeLessThanOrEqual(200_010);
    expect(out.removed).toBeGreaterThan(0);
    expect(grammarViolation(out.html)).toBeUndefined();
  });
});

describe('sanitizeTboHtml: cualquier entrada cumple la gramática (fuzz determinista)', () => {
  const FRAGMENTS = [
    '<',
    '>',
    '/',
    '"',
    "'",
    '=',
    ' ',
    '&',
    ';',
    '#',
    'x',
    'p',
    'b',
    'li',
    'ul',
    'br',
    'script',
    'SCRIPT',
    'style',
    'img',
    'svg',
    'a',
    'href',
    'onerror',
    'javascript:',
    '<!--',
    '-->',
    '<!',
    '<?',
    '</',
    '&lt;',
    '&amp;',
    '&#60;',
    '&#x3c;',
    '&nbsp;',
    '\u0000',
    '\n',
    '\u00a0',
    '\u2019',
  ];

  /** LCG con semilla fija: el mismo recorrido en cada corrida y en CI. */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it('10 000 entradas aleatorias', () => {
    const random = generator(20_260_925);
    for (let run = 0; run < 10_000; run += 1) {
      const length = 1 + Math.floor(random() * 40);
      let input = '';
      for (let i = 0; i < length; i += 1) {
        input += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? '';
      }
      const { html } = sanitizeTboHtml(input);
      const violation = grammarViolation(html);
      expect(violation, `${JSON.stringify(input)} → ${JSON.stringify(html)}`).toBeUndefined();
      expect(html.toLowerCase()).not.toMatch(/<(script|style|img|svg|a)\b/);
    }
  });
});

describe('tboHtmlToText: texto plano para WhatsApp (RF-32)', () => {
  it('párrafos separados por una línea en blanco, sin etiquetas ni entidades', () => {
    const text = tboHtmlToText(description());
    expect(text).not.toBeNull();
    expect(text?.startsWith('HeadLine : Near Nubian Museum\n\nLocation : A stay at Sofitel')).toBe(
      true,
    );
    expect(text).toContain('coffee shop/café.');
    expect(text).toContain('this property\u2019s food');
    expect(text).toMatch(
      /local regulations\.\n\nDisclaimer notification: Amenities are subject to availability/,
    );
    expect(text).not.toMatch(/[<>]|&nbsp;|&amp;|\u00a0/);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('<br> es un salto, <li> una viñeta, y el texto escapado vuelve a su carácter', () => {
    expect(tboHtmlToText('a<br>b<ul><li>x</li><li>y &amp; z</li></ul>')).toBe(
      'a\nb\n\n\u2022 x\n\u2022 y & z',
    );
    expect(tboHtmlToText('&lt;b&gt; "q"')).toBe('<b> "q"');
  });

  it('sin texto es null, y un <script> no deja rastro', () => {
    expect(tboHtmlToText('<p> </p><br/>&nbsp;')).toBeNull();
    expect(tboHtmlToText('<script>alert(1)</script>')).toBeNull();
  });
});

describe('splitTboDescriptionSections: <p>Etiqueta : texto</p> (05 §3)', () => {
  it('las siete secciones de la descripción de p. 60, con el aviso fuera', () => {
    const sections = splitTboDescriptionSections(description());
    expect(sections.map((section) => section.label)).toEqual([
      'HeadLine',
      'Location',
      'Rooms',
      'Dining',
      'Renovations',
      'CheckIn Instructions',
      'Special Instructions',
    ]);
    expect(sections[0]?.text).toBe('Near Nubian Museum');
    expect(sections[5]?.text.startsWith('Extra-person charges may apply')).toBe(true);
    expect(sections.some((section) => section.text.includes('Disclaimer'))).toBe(false);
  });

  it('un párrafo sin etiqueta no es una sección', () => {
    expect(
      splitTboDescriptionSections('<p>Sin etiqueta.</p><p>12:00 check-in</p><p>Note: x</p>'),
    ).toEqual([{ label: 'Note', text: 'x' }]);
  });
});

describe('classifyTboFacility: servicios negados (RF-32)', () => {
  it('"Wheelchair accessible \u2013 no" (p. 61) no es un servicio disponible', () => {
    expect(classifyTboFacility('Wheelchair accessible \u2013 no')).toEqual({
      label: 'Wheelchair accessible',
      available: false,
    });
  });

  it.each([
    ['Smoking - No.', 'Smoking'],
    ['Pets allowed \u2014 no', 'Pets allowed'],
    ['Parking-no', 'Parking'],
  ])('%j también es una negación', (raw, label) => {
    expect(classifyTboFacility(raw)).toEqual({ label, available: false });
  });

  it.each([
    'Number of meeting rooms - 3',
    'Wheelchair accessible (may have limitations)',
    'Casino - none',
    'No onsite parking notice board',
  ])('%j está disponible', (raw) => {
    expect(classifyTboFacility(raw)).toEqual({ label: raw, available: true });
  });

  it('texto plano: sin etiquetas, entidades decodificadas; vacío es undefined', () => {
    expect(classifyTboFacility('<b>Free&nbsp;WiFi</b>')).toEqual({
      label: 'Free WiFi',
      available: true,
    });
    expect(classifyTboFacility('A &amp; B')).toEqual({ label: 'A & B', available: true });
    expect(classifyTboFacility('  ')).toBeUndefined();
    expect(classifyTboFacility('<script>x</script>')).toBeUndefined();
  });
});
