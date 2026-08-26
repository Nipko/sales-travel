import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD: en el ciclo de la orden no queda ningún camino que decida por el NOMBRE de un
 * proveedor de vuelos.
 *
 * El bug R-07 fue exactamente eso: `createOrder` llamaba al adapter del único proveedor
 * inyectado y estampaba su code literal en la fila, mirara lo que mirara la oferta. Con dos
 * proveedores, reservar una oferta de Sabre contra el ACL de LATAM devuelve "no existe ese
 * vuelo" en el mejor caso, y en el peor cancela el billete de otro.
 *
 * `order-provider-routing.test.ts` y `order-create-saga.test.ts` ya prueban por comportamiento
 * que el enrutado sale del `provider.name` de la oferta. Este guard cubre lo que el
 * comportamiento no puede ver: el camino que **todavía no existe**. Un `if (provider === 'x')`
 * añadido mañana en una rama que ningún test recorre pasaría los otros dos verdes.
 *
 * ## Por qué la lista de codes se DERIVA y no se escribe
 *
 * Enumerar `['latam-ndc', 'sabre']` aquí sería la misma clase de avería que el guard vigila: el
 * tercer proveedor entraría sin que nadie se acordase de esta lista, y el guard seguiría verde
 * ignorándolo. Los codes se leen de los propios factories, así que un proveedor nuevo queda
 * cubierto por existir.
 *
 * `agent-cars` es la única excepción y está en el código con su motivo: no es un proveedor de
 * VUELOS, es otra vertical con otro puerto (`CarsService.book` confirma fuera de `OrdersService`)
 * y su rama en `runCancel` no se puede resolver por el registry de vuelos.
 */

/**
 * Raíz de `apps/api/src`, resuelta desde el cwd del runner. Se prueban las dos posiciones desde
 * las que se lanza vitest en este repo (el paquete y la raíz del monorepo) y se FALLA si ninguna
 * existe: un guard que no encuentra la fuente tiene que ponerse rojo, no pasar por vacío.
 */
function raizDeFuentes(): string {
  for (const candidato of [
    resolvePath(process.cwd(), 'src'),
    resolvePath(process.cwd(), 'apps', 'api', 'src'),
  ]) {
    if (existsSync(join(candidato, 'orders'))) return candidato;
  }
  throw new Error(`no se encontró apps/api/src desde ${process.cwd()}`);
}

const SRC = raizDeFuentes();
const ORDERS = join(SRC, 'orders');

/** Verticales cuyos codes NO son proveedores de vuelos y por tanto no entran en este guard. */
const NO_ES_VUELOS = new Set(['agent-cars', 'despegar-hotels']);

function ficheros(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isFile());
}

/** Codes declarados por los factories del repo: `const … PROVIDER_CODE = '<code>'`. */
function codesDeProveedoresDeVuelos(): string[] {
  const codes = new Set<string>();
  for (const entry of readdirSync(SRC)) {
    if (!entry.startsWith('providers-')) continue;
    const dir = join(SRC, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of ficheros(dir)) {
      if (!file.endsWith('.factory.ts') || file.endsWith('.test.ts')) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(
        /\bconst\s+\w*PROVIDER_CODE\s*=\s*'([a-z0-9-]+)'/g,
      )) {
        const code = m[1];
        if (code !== undefined && !NO_ES_VUELOS.has(code)) codes.add(code);
      }
    }
  }
  return [...codes].sort();
}

/** Fuente sin líneas de `import`: un specifier de módulo no es una decisión de enrutado. */
function sinImports(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\b/.test(line) && !/^\s*}\s*from\s*'/.test(line))
    .join('\n');
}

describe('el ciclo de la orden no enruta por el nombre del proveedor', () => {
  const codes = codesDeProveedoresDeVuelos();

  it('el guard encontró los codes de los proveedores de vuelos (anti-vacuidad)', () => {
    // Sin esto, un cambio de forma en los factories dejaría la lista vacía y el guard pasaría
    // por no tener nada que buscar, que es la forma más silenciosa de morirse.
    expect(codes.length).toBeGreaterThanOrEqual(2);
    expect(codes).toContain('sabre');
  });

  it.each(ficheros(ORDERS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')))(
    '%s no menciona ningún code de proveedor de vuelos',
    (file) => {
      const cuerpo = sinImports(readFileSync(file, 'utf8'));
      const mencionados = codes.filter((code) =>
        new RegExp(`['"\`]${code.replace(/-/g, '\\-')}['"\`]`).test(cuerpo),
      );

      expect(
        mencionados,
        `este fichero decide algo mirando el nombre de un proveedor de vuelos ` +
          `(${mencionados.join(', ')}). El enrutado sale de \`offer.provider.name\` / ` +
          `\`orders.provider\` a través de \`FlightProviderRegistry\`, y las capacidades ` +
          `(\`capabilitiesOf\`) deciden qué operaciones se permiten.`,
      ).toEqual([]);
    },
  );
});
