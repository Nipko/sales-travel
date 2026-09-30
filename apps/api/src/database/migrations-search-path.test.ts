import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * El `search_path` de las funciones que dejan las migraciones.
 *
 * Sin `pg_temp` al final de la lista, PostgreSQL busca PRIMERO en el esquema temporal de la sesión:
 * una tabla temporal con el nombre de una tabla de verdad (o de `pg_roles`) la sombrea dentro de una
 * función SECURITY DEFINER o de una guarda. Y una SECURITY DEFINER sin `SET search_path` corre con el
 * path de quien la llama, que lo elige él.
 *
 * La sección 12 de 0060 lo endurece una sola vez, al migrar, en todas las funciones que existen:
 * `search_path = public` pasa a `pg_catalog, public, pg_temp`, y una SECURITY DEFINER sin el suyo
 * recibe el mismo. Las migraciones ya aplicadas no se editan (el runner las registra por nombre y no
 * las vuelve a correr: editarlas dejaría a una base nueva distinta de producción), así que:
 *
 *   - hasta 0060, lo que cada migración escribe puede ser `search_path = public` o una SECURITY
 *     DEFINER sin search_path: lo cubre la sección 12, siempre que esté después de la última función
 *     de 0060 y que la migración llegue a cada base antes que 0060. En una base nueva el runner las
 *     aplica por número, así que siempre. En producción, sólo si se aplicó antes de desplegar 0060:
 *     por eso la lista de las conocidas ({@link KNOWN_SINCE_0054}). Que la base migrada quede como se
 *     espera lo verifica, contra la base, `migrations-search-path.integration.test.ts`;
 *   - después de 0060 nada las endurece: todo `SET search_path` termina en `pg_temp` y toda SECURITY
 *     DEFINER trae el suyo. Se revisa el texto: en CI la base es nueva y aplica todo en orden, así que
 *     una migración que llegara tarde a producción pasaría la integración igual.
 */
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'db', 'migrations');
const HARDENING = '0060_wallet_network_holds.sql';
const HARDENED_UP_TO = 60;

/**
 * Las migraciones de 0054 a 0060 que llegan a producción antes que 0060 (las de 0001 a 0053 también,
 * las cuenta {@link UP_TO_0053}). 0056 es de `main` (#14) y todavía no está en esta rama: se aplica
 * antes que 0060 en producción y, por número, en una base nueva, así que la sección 12 la endurece
 * igual. Está en la lista para que traer `main` no la rechace.
 *
 * Una que no esté acá: si llegó a producción antes que 0060 (de `main`, como 0056), se suma. Si 0060
 * ya está desplegada, es nueva y va después de 0060. Una migración ya aplicada nunca se renumera: el
 * runner la registra por nombre de archivo y la volvería a correr, ahora después de 0060.
 */
const KNOWN_SINCE_0054: readonly string[] = [
  '0054_hotel_catalog_on_demand.sql',
  '0055_auth_premium.sql',
  '0055_non_refundable_rates_permission.sql',
  '0056_membership_scoped_revocation.sql',
  HARDENING,
];
const UP_TO_0053 = 53;

interface SearchPathSetting {
  readonly file: string;
  readonly value: string;
}

/** El SQL sin comentarios de línea ni de bloque, para no leer la documentación como código. */
function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function searchPathSettings(file: string, sql: string): SearchPathSetting[] {
  const out: SearchPathSetting[] = [];
  // La lista de esquemas: identificadores separados por comas (lo que sigue, AS $$ o la comilla de
  // un format(), no es parte de ella).
  const re =
    /\bSET\s+search_path\s*(?:=|\bTO\b)\s*((?:"?[A-Za-z_][\w$]*"?\s*,\s*)*"?[A-Za-z_][\w$]*"?)/gi;
  for (const m of withoutComments(sql).matchAll(re)) {
    out.push({ file, value: (m[1] ?? '').trim() });
  }
  return out;
}

function schemasOf(value: string): string[] {
  return value
    .split(',')
    .map((p) => p.trim().replace(/^"|"$/g, '').toLowerCase())
    .filter((p) => p.length > 0);
}

function endsWithPgTemp(value: string): boolean {
  return schemasOf(value).at(-1) === 'pg_temp';
}

/**
 * Lo que la sección 12 de 0060 reconoce y endurece: `proconfig` con `search_path=public`, que es lo
 * que deja `SET search_path = public` (o `TO public`), sin comillas ni otros esquemas.
 */
function hardenedBy0060(value: string): boolean {
  return value.trim().toLowerCase() === 'public';
}

interface FunctionHeader {
  readonly file: string;
  readonly name: string;
  /** Dónde empieza el `CREATE FUNCTION` en el texto sin comentarios. */
  readonly at: number;
  /** Lo que la define fuera del cuerpo: antes de `AS $…$` y después, hasta el `;`. */
  readonly clauses: string;
}

/**
 * Cada `CREATE FUNCTION` con sus cláusulas, sin el cuerpo: un cuerpo que nombra `SET search_path`
 * (un `set_config`, un `EXECUTE format(…)`) no cuenta como el de la función. Recorre el texto de
 * corrido, así un cuerpo que contenga "CREATE FUNCTION" tampoco se lee como otra función.
 */
function functionHeaders(file: string, sql: string): FunctionHeader[] {
  const text = withoutComments(sql);
  const out: FunctionHeader[] = [];
  const create = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)/gi;
  const open = /\bAS\s+(\$[A-Za-z_]*\$)/gi;
  let m: RegExpExecArray | null;
  while ((m = create.exec(text)) !== null) {
    open.lastIndex = m.index;
    const body = open.exec(text);
    if (body === null) break;
    const tag = body[1] ?? '$$';
    const bodyStart = body.index + body[0].length;
    const bodyEnd = text.indexOf(tag, bodyStart);
    if (bodyEnd < 0) break;
    const after = bodyEnd + tag.length;
    const semi = text.indexOf(';', after);
    out.push({
      file,
      name: m[1] ?? '?',
      at: m.index,
      clauses: `${text.slice(m.index, body.index)} ${text.slice(after, semi < 0 ? undefined : semi)}`,
    });
    create.lastIndex = semi < 0 ? text.length : semi;
  }
  return out;
}

function isDefinerWithoutSearchPath(fn: FunctionHeader): boolean {
  return /\bSECURITY\s+DEFINER\b/i.test(fn.clauses) && !/\bSET\s+search_path\b/i.test(fn.clauses);
}

const numberOf = (file: string) => Number(file.slice(0, 4));
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
const sourceOf = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

const upTo0060 = files.filter((f) => numberOf(f) <= HARDENED_UP_TO);
const covered = upTo0060.map((f) => ({ file: f, sql: sourceOf(f) }));
const later = files
  .filter((f) => numberOf(f) > HARDENED_UP_TO)
  .map((f) => ({ file: f, sql: sourceOf(f) }));

/** El DO de la sección 12 de 0060, el que endurece lo que existe al migrar. */
function hardeningBlock(sql: string): { at: number; text: string } | undefined {
  const text = withoutComments(sql);
  for (const m of text.matchAll(/\bDO\s+\$\$[\s\S]*?\$\$\s*;/gi)) {
    if (/ALTER\s+FUNCTION\s+%s\s+SET\s+search_path/i.test(m[0])) {
      return { at: m.index, text: m[0] };
    }
  }
  return undefined;
}

describe('search_path hasta 0060: lo cubre la sección 12 de 0060', () => {
  it('lee las migraciones (si no, lo de abajo no prueba nada)', () => {
    expect(upTo0060).toContain(HARDENING);
    expect(covered.flatMap(({ file, sql }) => functionHeaders(file, sql)).length).toBeGreaterThan(
      80,
    );
    expect(
      covered.flatMap(({ file, sql }) => searchPathSettings(file, sql)).length,
    ).toBeGreaterThan(60);
  });

  it('hasta 0060, sólo las que llegan a producción antes que 0060 (ver KNOWN_SINCE_0054)', () => {
    expect(upTo0060.filter((f) => numberOf(f) > 53 && !KNOWN_SINCE_0054.includes(f))).toEqual([]);
    expect(upTo0060.filter((f) => numberOf(f) <= 53)).toHaveLength(UP_TO_0053);
  });

  it('la sección 12 corre después de la última función de 0060 y reconoce los dos casos', () => {
    const sql = sourceOf(HARDENING);
    const block = hardeningBlock(sql);
    expect(block).toBeDefined();
    const lastFunction = Math.max(...functionHeaders(HARDENING, sql).map((f) => f.at));
    expect(block!.at).toBeGreaterThan(lastFunction);
    // `search_path = public` y SECURITY DEFINER sin search_path; las de extensiones, no.
    expect(block!.text).toMatch(/'search_path=public'\s*=\s*ANY/);
    expect(block!.text).toMatch(/p\.prosecdef[\s\S]*NOT EXISTS[\s\S]*LIKE\s+'search_path=%'/);
    expect(block!.text).toMatch(/d\.deptype\s*=\s*'e'/);
    expect(block!.text).toMatch(/SET\s+search_path\s*=\s*pg_catalog,\s*public,\s*pg_temp/);
  });

  it('todo SET search_path termina en pg_temp o es el `public` que endurece la sección 12', () => {
    const offenders = covered
      .flatMap(({ file, sql }) => searchPathSettings(file, sql))
      .filter((s) => !endsWithPgTemp(s.value) && !hardenedBy0060(s.value))
      .map((s) => `${s.file}: SET search_path = ${s.value}`);
    expect(offenders).toEqual([]);
  });

  it('las 0055 quedan como se aplicaron en producción: las endurece 0060, no una edición', () => {
    for (const file of ['0055_auth_premium.sql', '0055_non_refundable_rates_permission.sql']) {
      const values = searchPathSettings(file, sourceOf(file)).map((s) => s.value);
      expect(values.length, file).toBeGreaterThan(0);
      expect(values.every(hardenedBy0060), file).toBe(true);
    }
  });
});

describe('search_path después de 0060: nada los endurece', () => {
  it('todo SET search_path termina en pg_temp', () => {
    const offenders = later
      .flatMap(({ file, sql }) => searchPathSettings(file, sql))
      .filter((s) => !endsWithPgTemp(s.value))
      .map((s) => `${s.file}: SET search_path = ${s.value}`);
    expect(offenders).toEqual([]);
  });

  it('toda función SECURITY DEFINER fija su search_path', () => {
    const offenders = later
      .flatMap(({ file, sql }) => functionHeaders(file, sql))
      .filter(isDefinerWithoutSearchPath)
      .map((f) => `${f.file}: ${f.name}`);
    expect(offenders).toEqual([]);
  });
});

describe('los detectores', () => {
  it('el de SECURITY DEFINER mira las cláusulas, no el cuerpo', () => {
    const sample = [
      '-- CREATE FUNCTION comentada() SECURITY DEFINER',
      "CREATE FUNCTION a() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN PERFORM set_config('search_path', 'x', true); END $$;",
      'CREATE OR REPLACE FUNCTION public.b() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;',
      'CREATE FUNCTION c() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$ SECURITY DEFINER SET search_path = public, pg_temp;',
      "CREATE FUNCTION d() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE 'CREATE FUNCTION e() RETURNS int SECURITY DEFINER AS $x$ SELECT 1 $x$'; END $body$;",
      'CREATE FUNCTION f() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$;',
    ].join('\n');
    const found = functionHeaders('muestra.sql', sample);
    expect(found.map((f) => [f.name, isDefinerWithoutSearchPath(f)])).toEqual([
      ['a', true],
      ['public.b', false],
      ['c', false],
      ['d', false],
      ['f', false],
    ]);
  });

  it('el de search_path distingue un encabezado endurecido, el `public` de la sección 12 y otro', () => {
    const sample = [
      '-- SET search_path = public (esto es un comentario)',
      'CREATE FUNCTION a() RETURNS int LANGUAGE sql SET search_path = public AS $$ SELECT 1 $$;',
      'CREATE FUNCTION b() RETURNS int LANGUAGE sql SET search_path = public, pg_temp AS $$ SELECT 1 $$;',
      'CREATE FUNCTION c() RETURNS int LANGUAGE sql SET search_path TO public, extensions AS $$ SELECT 1 $$;',
      "EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, public, pg_temp', f);",
    ].join('\n');
    const found = searchPathSettings('muestra.sql', sample);
    expect(found.map((s) => [s.value, endsWithPgTemp(s.value), hardenedBy0060(s.value)])).toEqual([
      ['public', false, true],
      ['public, pg_temp', true, false],
      ['public, extensions', false, false],
      ['pg_catalog, public, pg_temp', true, false],
    ]);
  });

  it('el de la sección 12 no se confunde con otro DO', () => {
    const sample = [
      "DO $$ BEGIN RAISE NOTICE 'hola'; END $$;",
      'CREATE FUNCTION x() RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$;',
      "DO $$ DECLARE f RECORD; BEGIN FOR f IN SELECT 1 LOOP EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f); END LOOP; END $$;",
    ].join('\n');
    const block = hardeningBlock(sample);
    expect(block?.text).toContain('ALTER FUNCTION %s');
    expect(block?.text).not.toContain("RAISE NOTICE 'hola'");
  });
});
