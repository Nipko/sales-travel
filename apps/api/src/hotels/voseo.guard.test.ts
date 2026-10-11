import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD: los textos que ve el vendedor en el flujo de hoteles van en "tú" neutro, nunca en voseo.
 *
 * Los mensajes de error del API llegan tal cual a la pantalla (el filtro global publica `message`),
 * así que un "Volvé a buscar" en un error de TBO es un "Volvé a buscar" en el checkout. Se recorre
 * todo `hotels/` y `providers-tbo/`, más los archivos de otras carpetas cuyos mensajes ve el
 * checkout de hoteles (cartera, intents de orden, registry y tipos de proveedor) y el 403 del
 * superadmin. Comentarios incluidos: citan textos de pantalla y se copian de ahí.
 *
 * El espejo web vive en `apps/web-b2b/src/app/(app)/hoteles/voseo.guard.test.ts`.
 */

function raizDeFuentes(): string {
  for (const candidato of [
    resolvePath(process.cwd(), 'src'),
    resolvePath(process.cwd(), 'apps', 'api', 'src'),
  ]) {
    if (existsSync(join(candidato, 'hotels'))) return candidato;
  }
  throw new Error(`no se encontró apps/api/src desde ${process.cwd()}`);
}

const SRC = raizDeFuentes();

const CARPETAS = ['hotels', 'providers-tbo'] as const;

const ARCHIVOS_SUELTOS = [
  'auth/sales-operation-errors.ts',
  'orders/external-order-intent.service.ts',
  'orders/order-create-intent.store.ts',
  'portfolios/booking-hold.ts',
  'portfolios/portfolio-errors.ts',
  'providers/hotel-provider.registry.ts',
  'providers/provider.types.ts',
] as const;

/**
 * Formas de voseo que ya aparecieron en estos textos. Sin `\p{L}` a los lados, para que "probá" no
 * case dentro de "probábamos" ni "elegí" dentro de "elegíamos".
 */
const VOSEO =
  /(?<!\p{L})(usá|probá|volvé|elegí|revisá|intentá|reintentá|cargá|avisá|avisale|pedile|pedíselos?|completala|cargalas|configuralos|quitá|confirmalo|elegila|indicá|informá|contactá|buscá|tenés|podés|querés|armás|corregís|creala|sumale|verificá|verificalos|confirmá|confirmalas|agregá|revisala|revisalas|consultá|completá|generá|recordale|entendés|indicala|esperá)(?!\p{L})/iu;

function fuentes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return fuentes(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

function ruta(full: string): string {
  return relative(SRC, full).split(sep).join('/');
}

/** `archivo:línea: palabra` de cada voseo, para que el fallo diga qué cambiar. */
function voseoEn(files: readonly string[]): string[] {
  return files.flatMap((full) =>
    readFileSync(full, 'utf8')
      .split('\n')
      .flatMap((linea, i) => {
        const hallado = VOSEO.exec(linea);
        return hallado ? [`${ruta(full)}:${i + 1}: ${hallado[0]}`] : [];
      }),
  );
}

describe('hoteles — textos en tú, sin voseo', () => {
  it('la expresión reconoce el voseo y deja pasar el tú', () => {
    for (const voseo of [
      'Volvé a buscar',
      'Probá de nuevo',
      'pedile a tu consolidador',
      'Revisalas y confirmalas',
      'Configuralos en Mi agencia',
      'usá un usuario de una sucursal',
      'si no tenés permiso',
    ]) {
      expect(VOSEO.test(voseo), voseo).toBe(true);
    }
    for (const tu of [
      'Vuelve a buscar',
      'Prueba de nuevo',
      'pídele a tu consolidador',
      'Revísalas y confírmalas',
      'Configúralos en Mi agencia',
      'usa un usuario de una sucursal',
      'si no tienes permiso',
      'no esperábamos este estado',
      'la tarifa elegida',
    ]) {
      expect(VOSEO.test(tu), tu).toBe(false);
    }
  });

  it('los archivos sueltos siguen existiendo (si se movió uno, actualiza la lista)', () => {
    const faltantes = ARCHIVOS_SUELTOS.filter((archivo) => !existsSync(join(SRC, archivo)));
    expect(faltantes).toEqual([]);
  });

  it('ningún texto de hoteles, TBO ni los mensajes que ve su checkout usa voseo', () => {
    const files = [
      ...CARPETAS.flatMap((carpeta) => fuentes(join(SRC, carpeta))),
      ...ARCHIVOS_SUELTOS.map((archivo) => join(SRC, archivo)),
    ];
    expect(files.length).toBeGreaterThan(40);
    expect(voseoEn(files)).toEqual([]);
  });
});
