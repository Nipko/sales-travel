import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * El aviso de inactividad tiene que poder usarse aunque el usuario se haya ido dejando abierto un
 * menú de la barra. Un DropdownMenu de Radix modal (el default) atrapa el foco, deja el `<body>`
 * con `pointer-events: none` y marca con `aria-hidden` todo lo demás: el foco de "Seguir
 * conectado" volvía al menú, el primer clic sólo lo cerraba y el lector de pantalla no anunciaba
 * el aviso. Sin DOM en los tests, se verifica en el código.
 */

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
}

describe('el aviso de inactividad no queda atrapado detrás de un menú abierto', () => {
  it('los menús de la barra son no modales', () => {
    const roots = source('./topbar.tsx').match(/<DropdownMenu\.Root\b[^>]*>/g) ?? [];
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect(root).toContain('modal={false}');
  });

  it('el aviso se monta en un portal al <body>, fuera de lo que un menú modal marca aria-hidden', () => {
    expect(source('./session-guard.tsx')).toMatch(/createPortal\(\s*dialog,\s*document\.body\s*\)/);
  });
});
