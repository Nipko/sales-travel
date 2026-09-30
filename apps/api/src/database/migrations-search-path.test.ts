import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ninguna migración posterior a 0053 fija un `search_path` sin `pg_temp` al final.
 *
 * Sin `pg_temp` en la lista, PostgreSQL busca PRIMERO en el esquema temporal de la sesión: una tabla
 * temporal con el nombre de una tabla de verdad (o de `pg_roles`) la sombrea dentro de una función
 * SECURITY DEFINER o de una guarda. 0060 endurece una sola vez, al migrar, todas las funciones que
 * existen con `search_path = public` (sección 12), pero una migración que se aplique DESPUÉS —otra
 * rama con un número menor que llega más tarde al deploy, o un CREATE OR REPLACE que copie el
 * encabezado viejo— quedaría sin endurecer y nadie se enteraría: en CI la base es nueva y las aplica
 * en orden. Por eso se revisa el texto, no la base.
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

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
const later = files.filter((f) => Number(f.slice(0, 4)) > HARDENED_BY_0060);
const settings = later.flatMap((f) =>
  searchPathSettings(f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')),
);

describe('search_path de las migraciones posteriores a 0053', () => {
  it('lee las migraciones (si no, lo de abajo no prueba nada)', () => {
    expect(later).toContain('0060_wallet_network_holds.sql');
    expect(
      settings.filter((s) => s.file === '0060_wallet_network_holds.sql').length,
    ).toBeGreaterThan(10);
  });

  it('todo SET search_path termina en pg_temp', () => {
    const offenders = settings
      .filter((s) => !endsWithPgTemp(s.value))
      .map((s) => `${s.file}: SET search_path = ${s.value}`);
    expect(offenders).toEqual([]);
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
