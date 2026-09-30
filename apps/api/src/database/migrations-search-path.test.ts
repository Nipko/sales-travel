import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ninguna migración posterior a 0053 fija un `search_path` sin `pg_temp` al final, ni crea una
 * función SECURITY DEFINER sin `search_path` propio.
 *
 * Sin `pg_temp` en la lista, PostgreSQL busca PRIMERO en el esquema temporal de la sesión: una tabla
 * temporal con el nombre de una tabla de verdad (o de `pg_roles`) la sombrea dentro de una función
 * SECURITY DEFINER o de una guarda. 0060 endurece una sola vez, al migrar, todas las funciones que
 * existen con `search_path = public` (sección 12), pero una migración que se aplique DESPUÉS —otra
 * rama con un número menor que llega más tarde al deploy, o un CREATE OR REPLACE que copie el
 * encabezado viejo— quedaría sin endurecer y nadie se enteraría: en CI la base es nueva y las aplica
 * en orden. Por eso se revisa el texto, no la base.
 *
 * Lo mismo con una SECURITY DEFINER sin `SET search_path`: corre con el path de quien la llama, que
 * lo elige él (`SET search_path = …` en su sesión). La sección 12 de 0060 también les fija el suyo a
 * las que ya existían, y una posterior quedaría igual de afuera.
 *
 * Las migraciones hasta la 0053 quedan fuera: las endurece el DO de la sección 12 de 0060.
 */
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'db', 'migrations');
const HARDENED_BY_0060 = 53;

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

function endsWithPgTemp(value: string): boolean {
  const parts = value
    .split(',')
    .map((p) => p.trim().replace(/^"|"$/g, '').toLowerCase())
    .filter((p) => p.length > 0);
  return parts[parts.length - 1] === 'pg_temp';
}

interface FunctionHeader {
  readonly file: string;
  readonly name: string;
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
      clauses: `${text.slice(m.index, body.index)} ${text.slice(after, semi < 0 ? undefined : semi)}`,
    });
    create.lastIndex = semi < 0 ? text.length : semi;
  }
  return out;
}

function isDefinerWithoutSearchPath(fn: FunctionHeader): boolean {
  return /\bSECURITY\s+DEFINER\b/i.test(fn.clauses) && !/\bSET\s+search_path\b/i.test(fn.clauses);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
const later = files.filter((f) => Number(f.slice(0, 4)) > HARDENED_BY_0060);
const sources = later.map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));
const settings = sources.flatMap(({ file, sql }) => searchPathSettings(file, sql));
const functions = sources.flatMap(({ file, sql }) => functionHeaders(file, sql));

describe('search_path de las migraciones posteriores a 0053', () => {
  it('lee las migraciones (si no, lo de abajo no prueba nada)', () => {
    expect(later).toContain('0060_wallet_network_holds.sql');
    expect(
      settings.filter((s) => s.file === '0060_wallet_network_holds.sql').length,
    ).toBeGreaterThan(10);
    expect(
      functions.filter((f) => f.file === '0060_wallet_network_holds.sql').length,
    ).toBeGreaterThan(20);
  });

  it('todo SET search_path termina en pg_temp', () => {
    const offenders = settings
      .filter((s) => !endsWithPgTemp(s.value))
      .map((s) => `${s.file}: SET search_path = ${s.value}`);
    expect(offenders).toEqual([]);
  });

  it('toda función SECURITY DEFINER fija su search_path', () => {
    const offenders = functions
      .filter(isDefinerWithoutSearchPath)
      .map((f) => `${f.file}: ${f.name}`);
    expect(offenders).toEqual([]);
  });

  it('el detector de SECURITY DEFINER mira las cláusulas, no el cuerpo', () => {
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

  it('el detector distingue un encabezado endurecido de uno que no', () => {
    const sample = [
      '-- SET search_path = public (esto es un comentario)',
      'CREATE FUNCTION a() RETURNS int LANGUAGE sql SET search_path = public AS $$ SELECT 1 $$;',
      'CREATE FUNCTION b() RETURNS int LANGUAGE sql SET search_path = public, pg_temp AS $$ SELECT 1 $$;',
      "EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, public, pg_temp', f);",
    ].join('\n');
    const found = searchPathSettings('muestra.sql', sample);
    expect(found.map((s) => [s.value, endsWithPgTemp(s.value)])).toEqual([
      ['public', false],
      ['public, pg_temp', true],
      ['pg_catalog, public, pg_temp', true],
    ]);
  });
});
