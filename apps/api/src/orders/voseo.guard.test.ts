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
 * (`search/`), los ACL de vuelos de la app (`providers-latam/`, `providers-sabre/`), el registry
 * de vuelos, los errores de proveedor compartidos, el aviso de una cuenta con reservas vivas y el
 * correo de confirmación. Comentarios incluidos: citan textos de pantalla y se copian de ahí.
 *
 * El espejo del panel vive en `apps/web-b2b/src/app/(app)/cotizaciones/voseo.guard.test.ts`.
 */

const SRC = join(__dirname, '..');

const CARPETAS = ['orders', 'search', 'providers-latam', 'providers-sabre'] as const;

const ARCHIVOS_SUELTOS = [
  'mail/templates.ts',
  'provider-credentials/provider-credentials.service.ts',
  'providers/flight-provider.registry.ts',
  'providers/provider.types.ts',
] as const;

const VOSEO =
  /(?<!\p{L})(usá|probá|volvé|elegí|revisá|revisala|revisalas|intentá|reintentá|cargá|cargalo|cargalas|completá|completala|avisá|avisale|pedile|pedí|pedíselos?|verificá|verificalas|revalidá|aceptá|aceptala|confirmá|confirmalo|ingresá|seleccioná|esperá|cambiá|gestioná|buscá|contactá|consultá|indicá|agregá|escribí|fijate|asegurate|hacé|hacelo|poné|recargá|copiá|pegá|entrá|emití|anulá|cancelá|reservá|pagá|guardá|respondé|tenés|podés|querés|necesitás|sabés|perdés|vos)(?!\p{L})/iu;

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
        const found = VOSEO.exec(line);
        const path = relative(SRC, file).split(sep).join('/');
        return found ? [`${path}:${i + 1}: ${found[0]}`] : [];
      }),
  );
}

describe('vuelos — textos del API en tú, sin voseo', () => {
  it('la expresión reconoce el voseo y deja pasar el tú', () => {
    for (const voseo of [
      'Revalidá el precio y volvé a intentar.',
      'Completala en Mi Red',
      'Cargalas en Mi Red',
      'Pedile al administrador',
      'Podés actualizar la contraseña',
      'Guardá este correo. Para cambios, respondé a tu agencia.',
    ]) {
      expect(VOSEO.test(voseo), voseo).toBe(true);
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
    ]) {
      expect(VOSEO.test(tu), tu).toBe(false);
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
