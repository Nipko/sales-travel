import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La SUPERFICIE del paquete publicado: qué ficheros viajan al artefacto que carga `apps/api`.
 *
 * Es el complemento de `dist-artifact.guard.test.ts`, que vigila la SEMÁNTICA del artefacto —que
 * el clasificador compilado sea el endurecido y no una copia rancia—. Éste vigila la otra mitad:
 * que en el artefacto no viaje nada que no sea código de producción.
 *
 * Nace de un hallazgo concreto: `redaction.budget.bench.ts` vivía en `src/`, y la única exclusión
 * del build es `src/**\/*.test.ts`, que no lo cubría. Resultado: `dist/redaction.budget.bench.js`
 * —con su `.d.ts` y su `.map`— dentro del paquete que corre en producción. No es una fuga de
 * secretos, es superficie que nadie audita, y la ronda 2 ya enseñó lo que cuesta que el artefacto y
 * la fuente sean dos programas distintos.
 *
 * ## Por qué el invariante es ALCANZABILIDAD y no una lista de sufijos prohibidos
 *
 * La versión anterior de este guard afirmaba en un comentario comprobar «la propiedad y no una
 * lista de nombres prohibidos», y comprobaba exactamente lo contrario: un `RegExp` con
 * `bench|probe|scratch|spec|fixture|mock|stub`. Esa lista sólo atrapa al polizón que tuvo la
 * amabilidad de llamarse como esperábamos. Una sonda con cualquier nombre nuevo
 * —`medicion-latencia.ts`, `repro-caso-4.ts`— pasaba limpia, se compilaba y se publicaba: el
 * agujero era el mismo que el guard decía tapar.
 *
 * La propiedad de verdad no menciona nombres. El paquete publica UN entry
 * (`exports["."].default`); lo que el paquete publica es, por definición, el cierre transitivo de
 * los imports desde ese entry. Todo lo demás que aparezca compilado es superficie que nadie pidió,
 * se llame como se llame. Por eso las dos aserciones centrales son:
 *
 *   - en `src/`, todo `.ts` que no sea `*.test.ts` es alcanzable desde `src/index.ts`;
 *   - en `dist/`, todo fichero es un emit de un módulo alcanzable desde `dist/index.js`.
 *
 * El carril sobre `src/` no necesita build y es el que corre siempre; el de `dist/` se salta si no
 * hay artefacto, igual que en el otro guard. No son redundantes: el de `src/` prueba la propiedad
 * sobre la entrada del compilador, y el de `dist/` la prueba sobre la salida —donde además
 * aparecen los HUÉRFANOS de builds anteriores, que ninguna regla sobre la fuente puede ver, y que
 * son justamente lo que se publica sin que nadie lo mire—.
 *
 * Un `dist/` con huérfanos se arregla con `pnpm --filter @sales-travel/sabre clean && pnpm build`.
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
  const fromWorkspace = resolvePath(process.cwd(), 'providers', 'sabre');
  if (existsSync(join(fromWorkspace, 'package.json'))) return fromWorkspace;
  throw new Error('no se encontró la raíz de @sales-travel/sabre desde el cwd');
}

const PKG_DIR = findPackageRoot();
const SRC_DIR = join(PKG_DIR, 'src');
const DIST_DIR = join(PKG_DIR, 'dist');
const PKG_JSON = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  version: string;
  experimental?: boolean;
  files: string[];
  scripts: Record<string, string>;
  exports: { '.': { types: string; default: string } };
};

/** Rutas relativas con `/`, para que las aserciones digan lo mismo en Windows y en Linux. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(root, full).split(sep).join(posix.sep));
    }
  };
  visit(root);
  return out;
}

/**
 * Especificadores RELATIVOS de cualquiera de las formas que emite o acepta este paquete:
 * `from './x'`, `export * from './x'`, `require('./x')`, `import('./x')`. Los no relativos (`zod`,
 * `@sales-travel/core`) se ignoran a propósito: son dependencias declaradas, no ficheros del
 * paquete, y la superficie que se audita aquí es la propia.
 */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](\.[^'"]*)['"]/g;

const TS_EXTENSIONS = ['.ts', '.tsx', '.json'] as const;
const JS_EXTENSIONS = ['.js', '.json'] as const;

/**
 * Resolución relativa al estilo Node/TS: extensión explícita, extensión implícita, o `index`.
 * Se prueba también el stem sin `.js` porque bajo NodeNext la FUENTE escribe `./x.js` para un
 * fichero que en disco es `x.ts`.
 */
function resolveRelative(
  fromFile: string,
  specifier: string,
  extensions: readonly string[],
): string | null {
  const base = resolvePath(dirname(fromFile), specifier);
  const stems = base.endsWith('.js') ? [base, base.slice(0, -'.js'.length)] : [base];
  for (const stem of stems) {
    const candidates = [
      ...(extensions.some((ext) => stem.endsWith(ext)) ? [stem] : []),
      ...extensions.map((ext) => stem + ext),
      ...extensions.map((ext) => join(stem, `index${ext}`)),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

/** Cierre transitivo de imports relativos desde un entry. Rutas absolutas. */
function reachableFrom(entry: string, extensions: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (;;) {
    const file = pending.pop();
    if (file === undefined) break;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const target = resolveRelative(file, specifier, extensions);
      if (target !== null && !seen.has(target)) pending.push(target);
    }
  }
  return seen;
}

const toRelative = (root: string, absolute: string): string =>
  relative(root, absolute).split(sep).join(posix.sep);

describe('la superficie publicada del paquete', () => {
  it('en src/ todo .ts que no sea un test es alcanzable desde el entry público', () => {
    const published = reachableFrom(join(SRC_DIR, 'index.ts'), TS_EXTENSIONS);
    const publishedRelative = new Set([...published].map((file) => toRelative(SRC_DIR, file)));

    // Lo que el build COMPILA: `include: src/**/*` menos el único patrón que `exclude` conoce.
    const compiled = walk(SRC_DIR).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const stowaways = compiled.filter((name) => !publishedRelative.has(name));

    expect(
      stowaways,
      `estos ficheros de src/ se compilan y se publican sin que nadie los importe desde ` +
        `src/index.ts: ${stowaways.join(', ')}. O son *.test.ts, o viven fuera de src/ con su ` +
        `propio proyecto (ver bench/), o el entry los exporta a propósito.`,
    ).toEqual([]);
  });

  it('el bench de redacción vive fuera de src/ y tiene su propio proyecto de typecheck', () => {
    // Fijar el sitio, no sólo la ausencia: sin esto, «arreglar» el test borrando el bench pasaría.
    expect(existsSync(join(PKG_DIR, 'bench', 'redaction.budget.bench.ts'))).toBe(true);
    expect(existsSync(join(PKG_DIR, 'bench', 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(SRC_DIR, 'redaction.budget.bench.ts'))).toBe(false);
    // Fuera de `src/` nadie lo typechequea salvo que el script lo pida a propósito.
    expect(PKG_JSON.scripts['typecheck']).toContain('bench/tsconfig.json');
  });

  it('`files` publica sólo el artefacto y los tipos, sin tests ni fixtures', () => {
    // Los TIPOS ya no dependen de `src`: desde esta ronda `exports["."].types` apunta a
    // `./dist/index.d.ts`, que es el emit del mismo módulo que se ejecuta. `src` sigue en la lista
    // por los `*.d.ts.map` —`declarationMap` está activado en `tsconfig.base.json` y los mapas
    // apuntan a `../src/*.ts`—: sin la fuente, «ir a la definición» desde el consumidor cae en un
    // fichero que no existe. Lo que no tiene por qué viajar son los tests ni los fixtures.
    expect(PKG_JSON.files).toEqual(['dist', 'src', '!src/**/*.test.ts', '!src/__fixtures__']);
    // Escrito como igualdad y no como `toContain`: una entrada NUEVA en `files` —`bench`,
    // `spec`, `docs`, un `.env.example`— es superficie publicada, y `toContain` no la vería.
  });

  it('el paquete sigue marcado experimental (§6.4: falta el fixture de vuelo nocturno)', () => {
    // El plan ata el desmarcado a un fixture concreto que aún no existe; mientras no exista, ni
    // la version ni el campo pueden perder la marca. Ver `src/index.ts` y
    // `docs/sabre/11-plan-implementacion.md` §6.4.
    expect(PKG_JSON.version).toMatch(/-experimental$/);
    expect(PKG_JSON.experimental).toBe(true);
    const nightFlightFixture = walk(join(SRC_DIR, '__fixtures__')).some((name) =>
      /overnight|nocturn|day-change|cambio-dia/i.test(name),
    );
    expect(
      nightFlightFixture,
      'apareció un fixture de vuelo nocturno: revisar §6.4 y decidir si el paquete deja de ser ' +
        'experimental, en vez de dejar la marca caducada',
    ).toBe(false);
  });

  describe.skipIf(!existsSync(DIST_DIR))('con dist/ presente', () => {
    it('en dist/ sólo viaja lo que el paquete publica: emits de módulos alcanzables', () => {
      const entry = resolvePath(PKG_DIR, PKG_JSON.exports['.'].default);
      const reachable = reachableFrom(entry, JS_EXTENSIONS);

      // Lo que `tsc` emite por cada módulo alcanzable, con `declaration`/`*Map` activados en
      // `tsconfig.base.json`. Se enumeran los emits en vez de filtrar por sufijo prohibido: así
      // un fichero con nombre arbitrario no tiene por dónde colarse.
      const allowed = new Set<string>();
      for (const module of reachable) {
        const name = toRelative(DIST_DIR, module);
        allowed.add(name);
        if (!name.endsWith('.js')) continue;
        const stem = name.slice(0, -'.js'.length);
        allowed.add(`${stem}.js.map`);
        allowed.add(`${stem}.d.ts`);
        allowed.add(`${stem}.d.ts.map`);
      }

      const stowaways = walk(DIST_DIR).filter((name) => !allowed.has(name));
      expect(
        stowaways,
        `el artefacto publicado contiene ficheros que nadie alcanza desde ` +
          `${PKG_JSON.exports['.'].default}: ${stowaways.join(', ')}. Suele ser una sonda dentro ` +
          `de src/, o un huérfano de un build anterior: ` +
          `pnpm --filter @sales-travel/sabre clean && pnpm build`,
      ).toEqual([]);
    });

    it('el cierre del artefacto no tiene requires colgando (dist/ no está truncado)', () => {
      // Sin esto, un `dist/` que sólo contuviera `index.js` pasaría el test de arriba por vacío:
      // cero polizones porque no hay nada. La anti-vacuidad se comprueba SOBRE EL ARTEFACTO y no
      // comparándolo con `src/`. Una comparación contra la fuente sería un guard de FRESCURA —se
      // pondría rojo en cada edición sin rebuild— y esa es justo la clase de guard que molesta,
      // se ignora y acaba borrada. Aquí sólo se exige que el artefacto sea consistente consigo
      // mismo: que todo `require` relativo que contiene resuelva a un fichero que existe.
      const entry = resolvePath(PKG_DIR, PKG_JSON.exports['.'].default);
      const dangling: string[] = [];
      for (const module of reachableFrom(entry, JS_EXTENSIONS)) {
        if (module.endsWith('.json')) continue;
        for (const match of readFileSync(module, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
          const specifier = match[1];
          if (specifier === undefined) continue;
          if (resolveRelative(module, specifier, JS_EXTENSIONS) === null) {
            dangling.push(`${toRelative(DIST_DIR, module)} → ${specifier}`);
          }
        }
      }
      expect(
        dangling,
        `dist/ está incompleto: ${dangling.join(', ')}. ` +
          `pnpm --filter @sales-travel/sabre clean && pnpm build`,
      ).toEqual([]);
    });
  });
});
