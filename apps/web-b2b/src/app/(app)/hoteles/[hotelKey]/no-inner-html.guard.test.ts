import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * RNF-16: el contenido de hoteles es de terceros (descripciones, alrededores, políticas) y se pinta
 * como texto. Ningún archivo de la pantalla de hoteles puede inyectar HTML: el día que alguien lo
 * necesite, este test lo obliga a decidirlo a la vista y no de pasada.
 */

const HOTELS_DIR = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('hoteles — sin HTML inyectado (RNF-16)', () => {
  it('ningún componente de hoteles usa dangerouslySetInnerHTML ni innerHTML', () => {
    const files = sources(HOTELS_DIR);
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((file) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
