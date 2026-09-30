import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Un modal `position: fixed` se ubica contra la ventana salvo que un ancestro tenga `transform`: ahí
 * se ubica contra ese ancestro. Las páginas entraban con `animate-fade-in-up` y su `forwards` dejaba
 * `transform: translateY(0)` puesto para siempre, así que el editor de credenciales de
 * /admin/proveedores abría centrado en la página —fuera de la pantalla en el teléfono— y su fondo no
 * tapaba la barra. Sin DOM en los tests, se verifica en el código.
 */

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
}

const css = source('../../app/globals.css');

/** `--animate-x: keyframe …;` → [nombre de la utilidad, keyframe, declaración completa]. */
function animations(): [string, string, string][] {
  return [...css.matchAll(/--animate-([\w-]+):\s*([\w-]+)\s+([^;]+);/g)].map((m) => [
    m[1]!,
    m[2]!,
    m[3]!,
  ]);
}

function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start === -1) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(start, i + 1);
  }
  return '';
}

describe('ningún modal queda atado a la página por una animación que no terminó de soltarse', () => {
  it('las animaciones que mueven no dejan el transform puesto al terminar', () => {
    const moving = animations().filter(
      ([, keyframe, decl]) =>
        !/\binfinite\b/.test(decl) && keyframes(keyframe).includes('transform'),
    );
    expect(moving.map(([name]) => name)).toEqual(
      expect.arrayContaining(['fade-in-up', 'scale-up', 'sheet-in']),
    );
    for (const [name, , decl] of moving) {
      expect(decl, name).not.toMatch(/\b(forwards|both)\b/);
    }
  });

  it('los modales se montan en un portal al <body>', () => {
    const dialog = source('./dialog.tsx');
    expect(dialog).toMatch(/createPortal\(children,\s*document\.body\)/);
    expect(dialog).toMatch(/<ModalPortal>\s*<div className="fixed inset-0/);
    expect(source('./form-sheet.tsx')).toMatch(/<ModalPortal>\s*<div className="fixed inset-0/);
  });

  it('las pantallas de credenciales no arman su propio overlay: usan Dialog o FormSheet', () => {
    for (const page of [
      '../../app/(app)/admin/proveedores/page.tsx',
      '../../app/(app)/red/page.tsx',
    ]) {
      expect(source(page), page).not.toContain('fixed inset-0');
    }
  });
});
