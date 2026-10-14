import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD: el fan-out, el registry y el ciclo de la orden no deciden nada por el NOMBRE de un
 * proveedor, y la marca de las tarifas y reservas de una cuenta de pruebas menos que nada.
 *
 * Una reserva de prueba se reconoce por la CUENTA con que se hizo (`TenantAdapter.providerEnvironment`,
 * que declara el factory de cada proveedor), no por quién la emitió. El atajo tentador es
 * `if (offer.provider.name === '<el de certificación>')`: funciona el día que se escribe y deja de
 * funcionar el día que ese proveedor pasa a producción —todas sus reservas reales saldrían marcadas
 * de prueba y sin correo— o que entra otro con su propio sandbox.
 *
 * `order-provider-dispatch.guard.test.ts` ya vigila `orders/` para los proveedores de vuelos. Éste
 * suma `search/` y `providers/`, mira TODAS las verticales y fija las pocas menciones que existen
 * hoy con su motivo: una nueva se pone roja.
 *
 * Los codes se DERIVAN de los propios módulos de proveedor, como en el otro guard: un proveedor
 * nuevo queda cubierto por existir.
 */

function raizDeFuentes(): string {
  for (const candidato of [
    resolvePath(process.cwd(), 'src'),
    resolvePath(process.cwd(), 'apps', 'api', 'src'),
  ]) {
    if (existsSync(join(candidato, 'providers'))) return candidato;
  }
  throw new Error(`no se encontró apps/api/src desde ${process.cwd()}`);
}

const SRC = raizDeFuentes();
const CARPETAS_NEUTRALES = ['orders', 'search', 'providers'] as const;

/**
 * Las menciones que existen hoy, con su motivo. Fichero relativo a `src/` → codes permitidos.
 * Añadir una línea aquí exige decir por qué en el PR.
 */
const MENCIONES_PERMITIDAS: Readonly<Record<string, readonly string[]>> = {
  // RF-06 CA-5: el desempate del dedupe lo gana el contrato directo. Preferencia comercial
  // declarada, configurable por parámetro.
  'search/offer-dedupe.ts': ['latam-ndc'],
  // Proveedores a los que la plataforma presta sus credenciales (comportamiento legado),
  // sobreescribible por entorno.
  'providers/flight-provider.registry.ts': ['latam-ndc'],
  'providers/hotel-provider.registry.ts': ['despegar-hotels'],
  // El espacio de ids de hotel de la plataforma es el de ese proveedor.
  'providers/hotel-provider.types.ts': ['despegar-hotels'],
  // Autos no tiene registry: su factory único se enruta aparte (ver el otro guard). Sus
  // capacidades de post-venta las declara OrderCapabilitiesService (antes, OrdersController).
  'orders/order-capabilities.service.ts': ['agent-cars'],
  'orders/orders.service.ts': ['agent-cars'],
};

/** El módulo que decide qué es una tarifa o reserva de prueba: no nombra a nadie, ni en prosa. */
const MODULO_DE_ENTORNO = 'providers/provider-environment.ts';

function ficherosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) {
      if (nombre === '__fixtures__') continue;
      salida.push(...ficherosTs(full));
    } else if (nombre.endsWith('.ts') && !nombre.endsWith('.test.ts')) {
      salida.push(full);
    }
  }
  return salida;
}

function rel(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

/** Codes declarados por los módulos de proveedor: `const …PROVIDER_CODE = '<code>'`. */
function codesDeProveedores(): string[] {
  const codes = new Set<string>();
  for (const entry of readdirSync(SRC)) {
    if (!entry.startsWith('providers-')) continue;
    const dir = join(SRC, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of ficherosTs(dir)) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /\bconst\s+\w*PROVIDER_CODE\s*=\s*'([a-z0-9-]+)'/g,
      )) {
        if (m[1] !== undefined) codes.add(m[1]);
      }
    }
  }
  return [...codes].sort();
}

/** Fuente sin líneas de `import`: un specifier de módulo no es una decisión. */
function sinImports(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\b/.test(line) && !/^\s*}\s*from\s*'/.test(line))
    .join('\n');
}

function literal(code: string): RegExp {
  return new RegExp(`['"\`]${code.replace(/-/g, '\\-')}['"\`]`);
}

const CODES = codesDeProveedores();
const FICHEROS = CARPETAS_NEUTRALES.flatMap((carpeta) => ficherosTs(join(SRC, carpeta)));

describe('neutralidad de proveedor en orders/, search/ y providers/', () => {
  it('el guard encontró los codes y los ficheros (anti-vacuidad)', () => {
    expect(CODES).toEqual(
      expect.arrayContaining(['agent-cars', 'despegar-hotels', 'latam-ndc', 'sabre', 'tbo-hotels']),
    );
    expect(FICHEROS.map(rel)).toEqual(
      expect.arrayContaining([
        MODULO_DE_ENTORNO,
        'orders/orders.controller.ts',
        'orders/orders.service.ts',
        'search/search.service.ts',
        'search/offer-dedupe.ts',
        'providers/flight-provider.registry.ts',
      ]),
    );
  });

  it.each(FICHEROS.map((f) => [rel(f), f] as const))(
    '%s no menciona codes de proveedor fuera de los permitidos',
    (nombre, file) => {
      const cuerpo = sinImports(readFileSync(file, 'utf8'));
      const permitidos = new Set(MENCIONES_PERMITIDAS[nombre] ?? []);
      const nuevos = CODES.filter((code) => !permitidos.has(code) && literal(code).test(cuerpo));

      expect(
        nuevos,
        `${nombre} decide algo mirando el nombre de un proveedor (${nuevos.join(', ')}). Lo que ` +
          `cambia por proveedor lo declara su factory: capacidades, política de llamada y entorno ` +
          `de la cuenta.`,
      ).toEqual([]);
    },
  );

  it('ninguna línea que lee o escribe el entorno de la cuenta nombra a un proveedor', () => {
    const toca = /environment|Environment|isTest|testContent/;
    const ofensas = FICHEROS.flatMap((file) =>
      sinImports(readFileSync(file, 'utf8'))
        .split('\n')
        .filter((linea) => toca.test(linea) && CODES.some((code) => literal(code).test(linea)))
        .map((linea) => `${rel(file)}: ${linea.trim()}`),
    );

    expect(ofensas).toEqual([]);
  });

  it('el módulo de entorno no nombra a ningún proveedor, ni siquiera en un comentario', () => {
    const fuente = readFileSync(join(SRC, MODULO_DE_ENTORNO), 'utf8');
    // El code entero y su primera palabra («latam», «sabre», «tbo»…), sin distinguir mayúsculas.
    const nombres = [...new Set(CODES.flatMap((code) => [code, code.split('-')[0] ?? code]))];
    const mencionados = nombres.filter((n) =>
      new RegExp(`\\b${n.replace(/-/g, '\\-')}\\b`, 'i').test(fuente),
    );

    expect(mencionados).toEqual([]);
  });
});
