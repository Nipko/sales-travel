import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * TRV-07: las tablas sin RLS forzada. Lo que la base no aísla lo tiene que aislar la API, así que la
 * lista es corta, cerrada y con su porqué:
 *
 * - una tabla nueva sin RLS forzada hace fallar este test hasta que alguien la ponga en la lista;
 * - los catálogos de plataforma son de sólo lectura para `app_user` (QA-H-45: `airports`);
 * - en `tenants`, `users`, `password_reset_tokens` y `consumed_tokens`, cada consulta de la API
 *   filtra (`.where`); las que leen todo son barridos del sistema o rutas sólo de superadmin, y están
 *   nombradas abajo.
 *
 * Se salta sin base (PGHOST), como los demás tests de integración.
 */
const hasDb = Boolean(process.env['PGHOST']);
const d = hasDb ? describe : describe.skip;

/** Sin RLS forzada, a propósito. */
const SIN_RLS: Readonly<Record<string, string>> = {
  tenants: 'la jerarquía misma: la lee la RLS de las demás; la API filtra por actor',
  users: 'una cuenta vive en varios nodos; la API filtra por id o correo',
  password_reset_tokens: 'se canjea antes de tener sesión; se busca por el hash del token',
  consumed_tokens: 'lista de jti gastados, sin datos de un tenant',
  schema_migrations: 'del migrador; app_user no la lee',
  airports: 'catálogo de plataforma, sólo lectura',
  provider_catalog: 'catálogo de plataforma, sólo lectura',
  hotel_content: 'catálogo de plataforma, sólo lectura',
  hotel_destination_map: 'catálogo de plataforma, sólo lectura',
  hotel_inventory: 'catálogo de plataforma, sólo lectura',
  hotel_match: 'catálogo de plataforma, sólo lectura',
  hotel_provider_city: 'catálogo de plataforma, sólo lectura',
  hotel_room_content: 'catálogo de plataforma, sólo lectura',
  hotel_room_content_fetch: 'catálogo de plataforma, sólo lectura',
};

const SOLO_LECTURA = Object.entries(SIN_RLS)
  .filter(([, porque]) => porque.startsWith('catálogo'))
  .map(([t]) => t);

/** Las consultas que leen todas las filas, a propósito (archivo → tabla). */
const LECTURAS_COMPLETAS: readonly string[] = [
  // Barridos del sistema: recorren todos los nodos y fijan el tenant de cada uno al leer lo suyo.
  'cars/cars-pending-sweep.service.ts tenants',
  'orders/post-sale-sweeper.ts tenants',
  'reconciliation/reconciliation.store.ts tenants',
  // Sólo superadmin (SuperadminGuard + assertSuperadmin): la red entera y el directorio.
  'tenants/tenants.service.ts tenants',
  'tenants/platform-users.service.ts users',
];

const SRC = join(__dirname, '..');
const TABLAS = ['tenants', 'users', 'password_reset_tokens', 'consumed_tokens'];

function archivos(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      return name === '__fixtures__' || name === 'node_modules' ? [] : archivos(p);
    }
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [p] : [];
  });
}

/** `archivo tabla` de cada consulta Kysely a esas tablas sin `.where` antes de ejecutarse. */
function lecturasSinFiltro(): string[] {
  const consulta = new RegExp(
    String.raw`\.(?:selectFrom|updateTable|deleteFrom)\(\s*'(${TABLAS.join('|')})(?: as \w+)?'`,
    'g',
  );
  const fin = /\.execute(?:TakeFirst(?:OrThrow)?)?\(|\.compile\(|;\n/;
  const out = new Set<string>();
  for (const p of archivos()) {
    const texto = readFileSync(p, 'utf8');
    for (const m of texto.matchAll(consulta)) {
      const resto = texto.slice(m.index);
      const corte = resto.search(fin);
      const cadena = resto.slice(0, corte < 0 ? 600 : corte);
      if (!/\.where(?:Ref)?\(/.test(cadena)) {
        out.add(`${relative(SRC, p).replace(/\\/g, '/')} ${m[1]}`);
      }
    }
  }
  return [...out].sort();
}

d('TRV-07 tablas sin RLS', () => {
  const pool = new pg.Pool();
  afterAll(() => pool.end());

  it('las tablas sin RLS forzada son exactamente las de la lista', async () => {
    const { rows } = await pool.query<{ t: string }>(
      `SELECT c.relname AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(Object.keys(SIN_RLS).sort());
  });

  it('los catálogos de plataforma: app_user lee, no escribe (QA-H-45)', async () => {
    const { rows } = await pool.query<{ t: string; lee: boolean; escribe: boolean }>(
      `SELECT t,
              has_table_privilege('app_user', t, 'SELECT') AS lee,
              has_table_privilege('app_user', t, 'INSERT, UPDATE, DELETE, TRUNCATE') AS escribe
         FROM unnest($1::text[]) AS t ORDER BY 1`,
      [SOLO_LECTURA],
    );
    expect(rows.filter((r) => !r.lee || r.escribe)).toEqual([]);
  });

  it('el migrador es suyo: app_user no lee schema_migrations', async () => {
    const { rows } = await pool.query<{ lee: boolean }>(
      `SELECT has_table_privilege('app_user', 'schema_migrations', 'SELECT') AS lee`,
    );
    expect(rows[0]!.lee).toBe(false);
  });
});

describe('TRV-07 consultas de la API a tablas sin RLS', () => {
  it('toda consulta filtra, salvo los barridos y las rutas de superadmin nombrados', () => {
    expect(lecturasSinFiltro()).toEqual([...LECTURAS_COMPLETAS].sort());
  });
});
