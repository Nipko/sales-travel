import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Lo que `migrations-search-path.test.ts` verifica en el texto, contra la base migrada: la sección 12
 * de 0060 dejó a toda función de `public` con un `search_path` que termina en `pg_temp`, y a toda
 * SECURITY DEFINER con el suyo. Incluye las de las 0055, que se aplicaron en producción con
 * `search_path = public` y no se editan: las endurece 0060 al migrar, en producción y en una base
 * nueva por igual. Con `main` llegan las de 0056, también con `search_path = public`: no se
 * nombran acá porque la rama todavía no las tiene, pero las cubren los dos chequeos generales. Las
 * funciones de extensiones no son nuestras y no se miran.
 *
 * Se salta sin base (PGHOST), como los demás tests de integración.
 */
const hasDb = Boolean(process.env['PGHOST']);
const d = hasDb ? describe : describe.skip;

/** Las funciones de las 0055 que se crearon con `SET search_path = public`. */
const FROM_0055 = [
  'seat_pool_of(uuid)',
  'effective_idle_timeout_minutes(uuid)',
  'seats_in_use(uuid,uuid)',
  'pool_active_sessions(uuid)',
  'revoke_session(uuid,text)',
  'admin_reset_user_mfa(uuid)',
  'user_admin_overview(uuid)',
  'refresh_session_idle_timeouts(uuid)',
  'tenant_booking_permissions_guard()',
  'non_refundable_rates_block(uuid)',
];

const HARDENED = 'search_path=pg_catalog, public, pg_temp';

interface ProcRow {
  fn: string;
  definer: boolean;
  search_path: string | null;
}

d('search_path de las funciones en la base migrada', () => {
  const admin = new pg.Pool();

  afterAll(async () => {
    await admin.end();
  });

  async function functions(): Promise<ProcRow[]> {
    const { rows } = await admin.query<ProcRow>(
      `SELECT p.oid::regprocedure::text AS fn,
              p.prosecdef AS definer,
              (SELECT c FROM unnest(COALESCE(p.proconfig, '{}'::text[])) c
                WHERE c LIKE 'search_path=%' LIMIT 1) AS search_path
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend dep
             WHERE dep.classid = 'pg_catalog.pg_proc'::regclass
               AND dep.objid = p.oid
               AND dep.deptype = 'e'
          )
        ORDER BY 1`,
    );
    return rows;
  }

  it('lee las funciones de la base (si no, lo de abajo no prueba nada)', async () => {
    const all = await functions();
    expect(all.length).toBeGreaterThan(80);
    expect(all.map((f) => f.fn)).toEqual(expect.arrayContaining(FROM_0055));
  });

  it('todo search_path fijado termina en pg_temp', async () => {
    const offenders = (await functions())
      .filter((f) => f.search_path !== null && !/,\s*pg_temp$/i.test(f.search_path))
      .map((f) => `${f.fn}: ${f.search_path}`);
    expect(offenders).toEqual([]);
  });

  it('toda SECURITY DEFINER tiene su search_path', async () => {
    const offenders = (await functions())
      .filter((f) => f.definer && f.search_path === null)
      .map((f) => f.fn);
    expect(offenders).toEqual([]);
  });

  it('las de las 0055 las endureció la sección 12 de 0060, sin editar su migración', async () => {
    const byName = new Map((await functions()).map((f) => [f.fn, f.search_path]));
    expect(FROM_0055.map((fn) => [fn, byName.get(fn)])).toEqual(
      FROM_0055.map((fn) => [fn, HARDENED]),
    );
  });
});
