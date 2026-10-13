import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Los textos de vuelos van en "tú" neutro, nunca en voseo (decisión del founder). Se recorre la
 * búsqueda y el checkout (`cotizaciones/`), la post-venta (`reservas/`), las rutas que reenvían sus
 * pedidos al API (`api/orders`, `api/quotations`) y las librerías que pintan mensajes de vuelos:
 * los errores del proveedor, la fecha de nacimiento del pasajero, el plazo de emisión y el aviso de
 * una cuenta de proveedor con reservas vivas. Comentarios incluidos: citan textos de pantalla y se
 * copian de ahí.
 *
 * El espejo del API vive en `apps/api/src/orders/voseo.guard.test.ts`, con el mismo detector.
 */

const SRC = fileURLToPath(new URL('../../../', import.meta.url));

const CARPETAS = [
  'app/(app)/cotizaciones',
  'app/(app)/reservas',
  'app/api/orders',
  'app/api/quotations',
] as const;

const ARCHIVOS_SUELTOS = [
  'components/test-content-badge.tsx',
  'lib/baggage.ts',
  'lib/birthdate.ts',
  'lib/full-name.ts',
  'lib/provider-account-errors.ts',
  'lib/provider-errors.ts',
  'lib/test-content.ts',
  'lib/ticketing-deadline.ts',
] as const;

/**
 * Formas del voseo que se nombran una por una: las que no llevan tilde ("cargalo", "pedile",
 * "fijate") y las que terminan como un futuro ("esperá", "generá", "mirá"), que la red de abajo
 * deja pasar a propósito.
 */
const VOSEO =
  /(?<!\p{L})(usá|probá|volvé|elegí|elegila|revisá|revisala|revisalas|intentá|reintentá|cargá|cargalo|cargalas|completá|completala|avisá|avisale|pedile|pedí|pedíselos?|verificá|verificalas|revalidá|revalidala|aceptá|aceptala|confirmá|confirmalo|confirmala|ingresá|seleccioná|esperá|cambiá|gestioná|buscá|buscala|contactá|consultá|indicá|agregá|escribí|fijate|asegurate|conectate|hacé|hacelo|poné|recargá|copiá|copiala|copialos|pegá|entrá|emití|emitila|anulá|anulala|cancelá|cancelala|reservá|pagá|guardá|guardalos|descargalos|respondé|configurá|contá|mirá|generá|separá|compará|prepará|declará|aclará|operá|recuperá|considerá|liberá|tenés|podés|querés|necesitás|sabés|perdés|vos)(?!\p{L})/iu;

/**
 * La red para el verbo que nadie anotó: una palabra que termina en vocal tildada, o en -ás/-és/-ís,
 * suena a voseo ("Configurá el email", "verificá la reserva", "tenés"). La lista sola no los vio.
 */
const TILDE_FINAL = /(?<!\p{L})\p{L}+(?:á|é|í|ás|és|ís)(?!\p{L})/gu;

/** El futuro termina igual y no es voseo: "podrá", "enviará", "volverás", "habrá". */
const FUTURO = /(?:[aei]|d|b)rás?$/u;

/**
 * Lo que termina en tilde y no es voseo. Si el guarda marca una palabra que tampoco lo es (un
 * adverbio, un pretérito, un nombre propio), se suma aquí; si es voseo, se cambia el texto a tú.
 */
const NO_VOSEO: ReadonlySet<string> = new Set([
  'acá',
  'además',
  'ahí',
  'allá',
  'allí',
  'aquí',
  'así',
  'atrás',
  'bogotá',
  'caché',
  'demás',
  'después',
  'detrás',
  'encontré',
  'está',
  'estás',
  'esté',
  'jamás',
  'más',
  'país',
  'qué',
  'quizá',
  'rellené',
  'reservé',
  'revés',
  'revisé',
  'sé',
  'sí',
  'través',
]);

/** Las formas del voseo de una línea, en orden de aparición. Vacío si está en tú. */
function voseoDe(line: string): string[] {
  const nombrado = VOSEO.exec(line);
  const sueltos = [...line.matchAll(TILDE_FINAL)]
    .map((m) => m[0])
    .filter((w) => !FUTURO.test(w.toLowerCase()) && !NO_VOSEO.has(w.toLowerCase()));
  return [...new Set([...(nombrado ? [nombrado[0]] : []), ...sueltos])];
}

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
        const path = relative(SRC, file).split(sep).join('/');
        return voseoDe(line).map((word) => `${path}:${i + 1}: ${word}`);
      }),
  );
}

describe('vuelos — textos en tú, sin voseo', () => {
  it('el detector reconoce el voseo y deja pasar el tú', () => {
    for (const voseo of [
      'Revalidá el precio y volvé a intentar.',
      'Aceptá la tarifa revalidada',
      'Elegí el aeropuerto de origen.',
      'pasajero 1: completá nombre',
      'Cargalo en Mi Red',
      'Podés actualizar la contraseña',
      'gestioná la cancelación con la aerolínea',
      // Verbos que la lista no nombra: los ve la red de las tildes finales.
      'No hay correo configurado para enviar. Configurá el email de la agencia',
      'Plazo de emisión vencido el 12 oct: verificá la reserva',
      'Ajustá las fechas y repetí la búsqueda',
      'Si no lo encontrás, avisanos',
      // Los que terminan como un futuro van en la lista.
      'Esperá a que termine la revalidación',
      'Mirá el detalle de la tarifa',
    ]) {
      expect(voseoDe(voseo), voseo).not.toEqual([]);
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
      'Configura el email de la agencia; verifica la reserva.',
      'Bogotá → Lima: después de emitir, volverás a verla aquí; se enviará y habrá más.',
      '¿Qué pasa si estás fuera del país? Así sí: quizá más tarde.',
    ]) {
      expect(voseoDe(tu), tu).toEqual([]);
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
