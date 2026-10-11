import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Los textos de vuelos van en "tú" neutro, nunca en voseo (decisión del founder). Se recorre la
 * búsqueda y el checkout (`cotizaciones/`), la post-venta (`reservas/`) y las librerías que pintan
 * mensajes de vuelos: los errores del proveedor, la fecha de nacimiento del pasajero y el aviso de
 * una cuenta de proveedor con reservas vivas. Comentarios incluidos: citan textos de pantalla y se
 * copian de ahí.
 *
 * El espejo del API vive en `apps/api/src/orders/voseo.guard.test.ts`, con la misma expresión.
 */

const SRC = fileURLToPath(new URL('../../../', import.meta.url));

const CARPETAS = ['app/(app)/cotizaciones', 'app/(app)/reservas'] as const;

const ARCHIVOS_SUELTOS = [
  'lib/baggage.ts',
  'lib/birthdate.ts',
  'lib/full-name.ts',
  'lib/provider-account-errors.ts',
  'lib/provider-errors.ts',
] as const;

const VOSEO =
  /(?<!\p{L})(usá|probá|volvé|elegí|revisá|revisala|revisalas|intentá|reintentá|cargá|cargalo|cargalas|completá|completala|avisá|avisale|pedile|pedí|pedíselos?|verificá|verificalas|revalidá|aceptá|aceptala|confirmá|confirmalo|ingresá|seleccioná|esperá|cambiá|gestioná|buscá|contactá|consultá|indicá|agregá|escribí|fijate|asegurate|hacé|hacelo|poné|recargá|copiá|pegá|entrá|emití|anulá|cancelá|reservá|pagá|guardá|respondé|tenés|podés|querés|necesitás|sabés|perdés|vos)(?!\p{L})/iu;

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

describe('vuelos — textos en tú, sin voseo', () => {
  it('la expresión reconoce el voseo y deja pasar el tú', () => {
    for (const voseo of [
      'Revalidá el precio y volvé a intentar.',
      'Aceptá la tarifa revalidada',
      'Elegí el aeropuerto de origen.',
      'pasajero 1: completá nombre',
      'Cargalo en Mi Red',
      'Podés actualizar la contraseña',
      'gestioná la cancelación con la aerolínea',
    ]) {
      expect(VOSEO.test(voseo), voseo).toBe(true);
    }
    for (const tu of [
      'Revalida el precio y vuelve a intentar.',
      'Acepta la tarifa revalidada',
      'Elige el aeropuerto de origen.',
      'pasajero 1: completa nombre',
      'Cárgalo en Mi Red',
      'Puedes actualizar la contraseña',
      'gestiona la cancelación con la aerolínea',
      // Palabras que empiezan igual y no son voseo.
      'animate-spin podrá cancelarse; la reserva está pagada',
    ]) {
      expect(VOSEO.test(tu), tu).toBe(false);
    }
  });

  it('las carpetas y los archivos sueltos siguen existiendo (si se movió uno, actualiza la lista)', () => {
    const rutas = [...CARPETAS, ...ARCHIVOS_SUELTOS];
    expect(rutas.filter((ruta) => !existsSync(join(SRC, ruta)))).toEqual([]);
  });

  it('ni la búsqueda, ni el checkout, ni la post-venta de vuelos usan voseo', () => {
    const files = [
      ...CARPETAS.flatMap((dir) => sources(join(SRC, dir))),
      ...ARCHIVOS_SUELTOS.map((file) => join(SRC, file)),
    ];
    expect(files.length).toBeGreaterThan(30);
    expect(voseoEn(files)).toEqual([]);
  });
});
