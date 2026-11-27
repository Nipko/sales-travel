import { describe, expect, it } from 'vitest';
import { isSafeSvg } from './brand-assets.controller.js';

const svg = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${attrs}>${inner}</svg>`;
const relleno = `<!--${'x'.repeat(600)}-->`;

describe('isSafeSvg (QA-H-34)', () => {
  it.each([
    ['un logo simple', svg('<rect width="10" height="10" fill="#123"/>')],
    ['con <use> a un id propio', svg('<defs><path id="a" d="M0 0h1"/></defs><use href="#a"/>')],
    [
      'con una imagen embebida',
      svg('<image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>'),
    ],
    ['con estilo y url a un gradiente propio', svg('<rect style="fill:url(#g)"/>')],
  ])('acepta %s', (_caso, texto) => {
    expect(isSafeSvg(texto)).toBe(true);
  });

  it.each([
    ['un script después de 512 bytes', svg(`${relleno}<script>alert(1)</script>`)],
    ['un manejador de eventos', svg('<rect onclick="alert(1)"/>')],
    ['un onload en la raíz', svg('', ' onload="alert(1)"')],
    ['foreignObject', svg('<foreignObject><div>x</div></foreignObject>')],
    [
      'un href a javascript',
      svg(`${relleno}<a xlink:href="javascript:alert(1)"><text>x</text></a>`),
    ],
    ['un href externo', svg('<image href="https://evil.example/x.png"/>')],
    ['un javascript codificado con entidades', svg('<a href="&#106;avascript:alert(1)">x</a>')],
    ['un @import de CSS', svg('<style>@import url(https://evil.example/a.css);</style>')],
    ['un url() externo en el estilo', svg('<rect style="fill:url(https://evil.example/p)"/>')],
    ['una entidad XML', `<!DOCTYPE svg [<!ENTITY x "y">]>${svg('')}`],
    ['algo que no es SVG', 'hola'],
  ])('rechaza %s', (_caso, texto) => {
    expect(isSafeSvg(texto)).toBe(false);
  });
});
