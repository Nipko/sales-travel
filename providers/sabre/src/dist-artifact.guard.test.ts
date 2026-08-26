import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Por qué este fichero existe: el artefacto compilado es una SEGUNDA resolución del paquete.
 *
 * Hasta esta ronda la divergencia estaba escrita en el propio `package.json`, que publicaba dos
 * entradas distintas para el mismo especificador:
 *
 *   "exports": { ".": { "types": "./src/index.ts", "default": "./dist/index.js" } }
 *
 * Un consumidor comprobaba tipos contra la FUENTE y ejecutaba el COMPILADO: dos programas con un
 * nombre, y la garantía de que el compilador nunca miraría el que corre. Se cerró apuntando
 * `types` a `./dist/index.d.ts`, que es el emit del mismo módulo que `default`.
 *
 * **El guard sigue haciendo falta, y por la misma razón de siempre.** Cerrar el `package.json` no
 * cierra el carril: los 1.244 tests de este paquete importan por ruta RELATIVA (`./errors`,
 * `./http/sabre-http.client`), así que siguen midiendo `src/` y ninguno toca `dist/`. Lo que ha
 * cambiado es dónde vive la divergencia —antes en la resolución del paquete, ahora en la frescura
 * del artefacto—, no que haya desaparecido. Este fichero entra por donde entra el consumidor:
 * resuelve el especificador con `createRequire` y ejerce lo que sale de ahí.
 *
 * Eso no es teoría. El `dist/` de esta máquina llevaba rancio desde la ronda 2: contenía la copia
 * DÉBIL del clasificador dentro de `dist/http/sabre-http.client.js` y `dist/index.js:29` la
 * reexportaba como el símbolo público. El sobre hostil nº1 —`errors[]` a profundidad 4— entraba
 * por el entry compilado y salía con `{ ok: true }`, es decir, reserva fantasma: el cliente no
 * vuela y ya se le cobró. `envelope-bypass.e2e.test.ts` no lo veía porque vigila el duplicado en
 * FUENTE, y la fuente ya estaba bien.
 *
 * `createRequire` usa la auto-referencia de Node, habilitada por el campo `exports`.
 * No compara fechas de `src` contra `dist` a propósito: un guard de
 * frescura se pone rojo en cada edición sin rebuild, y un guard que molesta se borra. Éste sólo
 * grita cuando el artefacto publicado es INSEGURO, que es la única condición que importa.
 *
 * Si no hay `dist/`, no hay artefacto que pueda estar rancio y el bloque se salta: `turbo test`
 * declara `dependsOn: ["^build"]`, que construye las dependencias del paquete, no el paquete.
 */

/**
 * Raíz del paquete. Se busca subiendo desde el cwd —el mismo idiom que `spec-manifest.test.ts`—
 * porque vitest puede arrancar desde la raíz del monorepo (`pnpm test`) o desde el paquete
 * (`pnpm --filter … test`). `import.meta.url` no sirve: este paquete compila a CommonJS y `tsc`
 * lo rechaza (TS1343), y un guard que no pasa el typecheck no es un guard.
 */
function findPackageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === '@sales-travel/sabre') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Desde la raíz del monorepo el cwd nunca es el paquete: se cae al camino conocido.
  const fromWorkspace = resolvePath(process.cwd(), 'providers', 'sabre');
  if (existsSync(join(fromWorkspace, 'package.json'))) return fromWorkspace;
  throw new Error('no se encontró la raíz de @sales-travel/sabre desde el cwd');
}

const PKG_DIR = findPackageRoot();
/** `createRequire` necesita un fichero base DENTRO del paquete: la auto-referencia por `exports`
 *  sólo funciona resolviendo desde dentro, que es justo lo que hace un consumidor del entry. */
const require_ = createRequire(join(PKG_DIR, 'package.json'));
const PKG_JSON = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  exports: { '.': { types: string; default: string } };
};

const DEFAULT_ENTRY = resolvePath(PKG_DIR, PKG_JSON.exports['.'].default);
const DIST_ERRORS = join(PKG_DIR, 'dist', 'errors.js');
const DIST_CLIENT = join(PKG_DIR, 'dist', 'http', 'sabre-http.client.js');
const HAS_BUILD = existsSync(DEFAULT_ENTRY);

/**
 * Los cuatro sobres que definían la copia débil: tope de profundidad, sin bajar por arrays, y sin
 * `messages[]`. La lista completa vive en `envelope-bypass.e2e.test.ts`; aquí basta el subconjunto
 * que distingue una regla de la otra, porque el invariante fuerte es la identidad de función de más
 * abajo y esto es sólo la sonda de comportamiento que la respalda.
 */
const HOSTILE: ReadonlyArray<readonly [string, unknown]> = [
  [
    'errors[] a profundidad >= 4',
    { a: { b: { c: { d: { errors: [{ category: 'APPLICATION_ERROR' }] } } } } },
  ],
  [
    'errors[] dentro de un elemento de array',
    { orders: [{ confirmationId: 'ABC123' }, { errors: [{ category: 'APPLICATION_ERROR' }] }] },
  ],
  [
    'messages[] sin severity ni type',
    { messages: [{ content: 'Booking could not be completed' }] },
  ],
  ['status NotProcessed en la raiz', { status: 'NotProcessed', data: {} }],
  // El bypass de la ronda 5. Se anade aqui y no solo en `errors.status-subtree.regression.test.ts`
  // porque se midio reproducible EN EL ARTEFACTO COMPILADO, que es el programa que corre en
  // produccion: un dist/ rancio con el `case 'status'` que no descendia entrega esta reserva como
  // confirmada aunque la fuente ya este arreglada. Es literalmente el incidente de la ronda 2.
  [
    'errors[] dentro de un `status` objeto (subarbol ciego)',
    { status: { errors: [{ category: 'APPLICATION_ERROR' }] } },
  ],
];

interface CompiledEntry {
  classifySabreEnvelope: (payload: unknown) => {
    ok: boolean;
    exhaustive?: boolean;
    nodesVisited?: number;
  };
  SabreApiError: new (...args: never[]) => Error;
  SabreHttpClient: new (
    cfg: unknown,
    tokens: unknown,
    deps: unknown,
  ) => {
    postJson: (path: string, body: unknown, options?: unknown) => Promise<unknown>;
  };
}

describe('el artefacto publicado es el mismo programa que la fuente', () => {
  it('`types` y `default` apuntan al MISMO artefacto: un solo programa, un nombre', () => {
    // La condición que se cerró esta ronda. Volver a apuntar `types` a `./src/` reabre el carril
    // por el que un consumidor comprueba tipos contra un programa y ejecuta otro — que es la forma
    // exacta del incidente de la ronda 2. Si esto se pone rojo, no se ajusta el patrón: se mira
    // por qué alguien separó las dos entradas otra vez.
    expect(PKG_JSON.exports['.'].types).toMatch(/^\.\/dist\//);
    expect(PKG_JSON.exports['.'].default).toMatch(/^\.\/dist\//);
    // Y son el mismo módulo, no dos ficheros distintos que casualmente viven en `dist/`: el `.d.ts`
    // tiene que ser el emit de declaraciones del `.js` que se ejecuta.
    expect(PKG_JSON.exports['.'].types).toBe(
      PKG_JSON.exports['.'].default.replace(/\.js$/, '.d.ts'),
    );
  });

  describe.skipIf(!HAS_BUILD)('con dist/ presente', () => {
    it('el especificador del paquete resuelve al entry COMPILADO, no a la fuente', () => {
      const resolved = require_.resolve('@sales-travel/sabre');
      expect(resolved).toBe(DEFAULT_ENTRY);
      expect(resolved.includes(`${sep}dist${sep}`)).toBe(true);
    });

    it('las declaraciones a las que apunta `types` existen de verdad', () => {
      // `types` apuntando a un fichero que el build no emite es la misma avería con otro disfraz:
      // el consumidor se queda sin tipos y TypeScript cae a `any` en silencio, que es peor que
      // apuntar a la fuente. `declaration` vive en `tsconfig.base.json` y nadie de este paquete lo
      // pide explícitamente, así que conviene comprobarlo desde aquí.
      const types = resolvePath(PKG_DIR, PKG_JSON.exports['.'].types);
      expect(existsSync(types), `${PKG_JSON.exports['.'].types} no existe tras el build`).toBe(
        true,
      );
      expect(readFileSync(types, 'utf8')).toContain('SabreHttpClient');
    });

    it('el clasificador que obtiene un consumidor es el de errors.js, no una copia del cliente', () => {
      const entry = require_('@sales-travel/sabre') as CompiledEntry;
      const errorsModule = require_(DIST_ERRORS) as Record<string, unknown>;
      const clientModule = require_(DIST_CLIENT) as Record<string, unknown>;

      // La firma exacta del incidente: `dist/index.js` reexportaba el símbolo desde el cliente.
      expect(clientModule['classifySabreEnvelope']).toBeUndefined();
      expect(entry.classifySabreEnvelope).toBe(errorsModule['classifySabreEnvelope']);
    });

    it('el veredicto compilado trae los campos que sólo existen en la regla endurecida', () => {
      const entry = require_('@sales-travel/sabre') as CompiledEntry;
      const verdict = entry.classifySabreEnvelope({ errors: ['x'] });
      expect(verdict.ok).toBe(false);
      expect(verdict.exhaustive).toBe(true);
      expect(typeof verdict.nodesVisited).toBe('number');
    });

    it.each(HOSTILE)(
      'postJson del artefacto rechaza el sobre hostil: %s',
      async (name, payload) => {
        const entry = require_('@sales-travel/sabre') as CompiledEntry;
        const client = new entry.SabreHttpClient(
          {
            host: 'https://api.cert.platform.sabre.com',
            epr: '500001',
            homePcc: 'ZZZZ',
            password: 'Pa55w0rd!',
            conversationIdPrefix: 'sales-travel',
          },
          { getToken: () => Promise.resolve('ATK'), invalidate: () => Promise.resolve() },
          {
            fetch: () => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
            sleep: () => Promise.resolve(),
            jitter: () => 0,
            uuid: () => 'conv-fijo',
          },
        );

        let thrown: unknown;
        try {
          await client.postJson('/v1/trip/orders/createBooking', {});
        } catch (error) {
          thrown = error;
        }
        // Resolver aquí es la reserva fantasma, y lanzar otra cosa tampoco es protección.
        expect(thrown, `${name}: el artefacto compilado aceptó el sobre`).toBeInstanceOf(
          entry.SabreApiError,
        );
      },
    );
  });
});
