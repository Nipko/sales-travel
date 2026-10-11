import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProviderNotAvailableError,
  ProviderOrderAccountUnavailableError,
} from '../providers/provider.types.js';
import { notSentMessage } from './orders.service.js';

/*
 * Los mensajes de vuelos que llegan al vendedor van en "tú" neutro, nunca en voseo (decisión del
 * founder). Se recorre lo que redacta esos textos: reservas y post-venta (`orders/`), la búsqueda
 * (`search/`), las cotizaciones (`quotations/`), los ACL de vuelos de la app (`providers-latam/`,
 * `providers-sabre/`), el registry de vuelos, los errores de proveedor compartidos, el aviso de una
 * cuenta con reservas vivas y los correos de cotización y de confirmación. Comentarios incluidos:
 * citan textos de pantalla y se copian de ahí.
 *
 * El espejo del panel vive en `apps/web-b2b/src/app/(app)/cotizaciones/voseo.guard.test.ts`, con el
 * mismo detector.
 */

const SRC = join(__dirname, '..');

const CARPETAS = ['orders', 'search', 'quotations', 'providers-latam', 'providers-sabre'] as const;

const ARCHIVOS_SUELTOS = [
  'mail/templates.ts',
  'provider-credentials/provider-credentials.service.ts',
  'providers/flight-provider.registry.ts',
  'providers/provider.types.ts',
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
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
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

describe('vuelos — textos del API en tú, sin voseo', () => {
  it('el detector reconoce el voseo y deja pasar el tú', () => {
    for (const voseo of [
      'Revalidá el precio y volvé a intentar.',
      'Completala en Mi Red',
      'Cargalas en Mi Red',
      'Pedile al administrador',
      'Podés actualizar la contraseña',
      'Guardá este correo. Para cambios, respondé a tu agencia.',
      // Verbos que la lista no nombra: los ve la red de las tildes finales.
      'Configurá el email de la agencia en Mi Red.',
      'Ajustá las fechas y repetí la búsqueda',
      'Si no lo encontrás, avisanos',
      // Los que terminan como un futuro van en la lista.
      'Esperá a que termine la revalidación',
    ]) {
      expect(voseoDe(voseo), voseo).not.toEqual([]);
    }
    for (const tu of [
      'Revalida el precio y vuelve a intentar.',
      'Complétala en Mi Red',
      'Cárgalas en Mi Red',
      'Pídele al administrador',
      'Puedes actualizar la contraseña',
      'Guarda este correo. Para cambios, responde a tu agencia.',
      // Palabras que empiezan igual y no son voseo.
      'la reserva podrá cancelarse; está pagada y emitida',
      'Configura el email de la agencia en Mi Red.',
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

  it('ni las reservas, ni la búsqueda, ni los proveedores de vuelos usan voseo', () => {
    const files = [
      ...CARPETAS.flatMap((dir) => sources(join(SRC, dir))),
      ...ARCHIVOS_SUELTOS.map((file) => join(SRC, file)),
    ];
    expect(files.length).toBeGreaterThan(40);
    expect(voseoEn(files)).toEqual([]);
  });
});

describe('vuelos — los textos corregidos dicen lo que dicen, en tú', () => {
  it('una reserva que no salió por la oferta pide revalidar', () => {
    expect(notSentMessage('offer.priceId:required')).toBe(
      'La reserva no se envió a la aerolínea: los datos de esta oferta no alcanzan para reservar. Revalida el precio y vuelve a intentar.',
    );
  });

  it('una reserva que no salió por los datos dice qué revisar', () => {
    expect(notSentMessage('travelers.0.givenName:invalid_string; contactInfo.emails:invalid')).toBe(
      'La reserva no se envió a la aerolínea. Revisa pasajero 1: nombre; email de contacto. La cotización sigue disponible para reintentar.',
    );
  });

  it('los errores de proveedor compartidos mandan a Mi Red en tú', () => {
    expect(new ProviderNotAvailableError('alfa-air').message).toBe(
      "El proveedor 'alfa-air' no está habilitado para esta agencia. Revisa Mi Red → Credenciales.",
    );
    expect(new ProviderOrderAccountUnavailableError('alfa-air').message).toContain(
      'Pídele al administrador de tu red que la revise en Mi Red → Credenciales.',
    );
  });
});
