import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Los textos que ve el vendedor en hoteles van en "tú" neutro, nunca en voseo. Se recorre toda la
 * pantalla de hoteles, las librerías propias de hoteles y el aviso del superadmin, que es lo que ve
 * cuando entra a /hoteles. Comentarios incluidos: citan textos de pantalla y se copian de ahí.
 *
 * El espejo del API vive en `apps/api/src/hotels/voseo.guard.test.ts`, con la misma expresión.
 */

const HOTELS_DIR = fileURLToPath(new URL('.', import.meta.url));
const SRC = fileURLToPath(new URL('../../../', import.meta.url));

const ARCHIVOS_SUELTOS = [
  'components/layout/sales-blocked.tsx',
  'lib/hotel-book.ts',
  'lib/hotel-content-batch.ts',
  'lib/hotel-image-proxy.ts',
  'lib/viewer.ts',
] as const;

const VOSEO =
  /(?<!\p{L})(usá|probá|volvé|elegí|revisá|intentá|reintentá|cargá|avisá|avisale|pedile|pedíselos?|completala|cargalas|configuralos|quitá|confirmalo|elegila|indicá|informá|contactá|buscá|tenés|podés|querés|armás|corregís|creala|sumale|verificá|verificalos|confirmá|confirmalas|agregá|revisala|revisalas|consultá|completá|generá|recordale|entendés|indicala|esperá)(?!\p{L})/iu;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function voseoEn(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => {
        const found = VOSEO.exec(line);
        const path = relative(SRC, file).split(sep).join('/');
        return found ? [`${path}:${i + 1}: ${found[0]}`] : [];
      }),
  );
}

describe('hoteles — textos en tú, sin voseo', () => {
  it('la expresión reconoce el voseo y deja pasar el tú', () => {
    for (const voseo of ['Recordale al huésped', 'usá un usuario', 'creala y sumale', 'armás']) {
      expect(VOSEO.test(voseo), voseo).toBe(true);
    }
    for (const tu of ['Recuérdale al huésped', 'usa un usuario', 'créala y súmale', 'armas']) {
      expect(VOSEO.test(tu), tu).toBe(false);
    }
  });

  it('los archivos sueltos siguen existiendo (si se movió uno, actualiza la lista)', () => {
    expect(ARCHIVOS_SUELTOS.filter((file) => !existsSync(join(SRC, file)))).toEqual([]);
  });

  it('ni la pantalla de hoteles ni el aviso del superadmin usan voseo', () => {
    const files = [...sources(HOTELS_DIR), ...ARCHIVOS_SUELTOS.map((file) => join(SRC, file))];
    expect(files.length).toBeGreaterThan(40);
    expect(voseoEn(files)).toEqual([]);
  });
});
