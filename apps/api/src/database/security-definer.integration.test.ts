import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Guardas de la base que la app no puede saltarse, contra Postgres migrado (plan de pruebas §5 SQL):
 *
 * - Las SECURITY DEFINER que `app_user` ejecuta: ninguna abierta a PUBLIC y ninguna huérfana. Una
 *   función que corre como dueño y nadie llama es superficie sin dueño: así quedó
 *   `accept_invitation` de 0028 hasta 0099 (QA-H-42).
 * - SQL-02: el canje (`claim_pending_invitation`) sólo toma una invitación vigente y una sola vez.
 * - SQL-07: el localizador del proveedor de una orden no se reescribe ni se borra.
 *
 * Se salta sin base (PGHOST), como los demás tests de integración.
 */
const hasDb = Boolean(process.env['PGHOST']);
const d = hasDb ? describe : describe.skip;

const SRC = join(__dirname, '..');

/** El código de la API sin tests: dónde una función se llama de verdad. */
function codigoDeLaApi(dir = SRC): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__fixtures__' && name !== 'node_modules') out += codigoDeLaApi(p);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out += sinComentarios(readFileSync(p, 'utf8'));
    }
  }
  return out;
}

/**
 * Nombrarla en un comentario no es llamarla: `is_admin_user()` sobrevivió así hasta 0100 (QA-H-44).
 * Sólo los comentarios que abren línea; un `/*` dentro de un string no corta nada.
 */
function sinComentarios(ts: string): string {
  return ts
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*\*.*$/gm, '');
}

d('guardas SQL en la base migrada', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  let tenant = '';
  let usuario = '';

  beforeAll(async () => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', $2) RETURNING id`,
      [`sql-guardas-${sfx}`, await platformRootId(pool)],
    );
    tenant = t.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`sql-guardas-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenant) await pool.query('DELETE FROM tenants WHERE id = $1', [tenant]);
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await pool.end();
  });

  describe('SECURITY DEFINER que ejecuta app_user', () => {
    interface Fn {
      fn: string;
      name: string;
      public_exec: boolean;
    }

    async function definers(): Promise<Fn[]> {
      const { rows } = await pool.query<Fn>(
        `SELECT p.oid::regprocedure::text AS fn, p.proname AS name,
                (p.proacl IS NULL OR EXISTS (
                   SELECT 1 FROM aclexplode(p.proacl) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.prosecdef
            AND p.prorettype <> 'trigger'::regtype
            AND has_function_privilege('app_user', p.oid, 'EXECUTE')
            AND NOT EXISTS (
              SELECT 1 FROM pg_depend dep
               WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e')
          ORDER BY 1`,
      );
      return rows;
    }

    it('lee las funciones (si no, lo de abajo no prueba nada)', async () => {
      expect((await definers()).length).toBeGreaterThan(30);
    });

    it('ninguna la ejecuta PUBLIC: el permiso es de app_user, explícito', async () => {
      const abiertas = (await definers()).filter((f) => f.public_exec).map((f) => f.fn);
      expect(abiertas).toEqual([]);
    });

    it('cada una la llama la API, una política de RLS, una vista u otra función', async () => {
      const codigo = codigoDeLaApi();
      const { rows: usos } = await pool.query<{ texto: string }>(
        `SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '') AS texto
           FROM pg_policies WHERE schemaname = 'public'
         UNION ALL
         SELECT definition FROM pg_views WHERE schemaname = 'public'
         UNION ALL
         SELECT p.proname || ':' || p.prosrc
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'`,
      );
      const huerfanas = (await definers())
        .filter((f) => {
          const llamada = new RegExp(`\\b${f.name}\\b`);
          if (llamada.test(codigo)) return false;
          return !usos.some((u) => !u.texto.startsWith(`${f.name}:`) && llamada.test(u.texto));
        })
        .map((f) => f.fn);
      expect(huerfanas).toEqual([]);
    });

    it('el canje viejo de 0028 e is_admin_user ya no existen (QA-H-42, QA-H-44)', async () => {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_proc
          WHERE proname IN ('accept_invitation', 'find_pending_invitation', 'is_admin_user')`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('SQL-02 canje de invitación (claim_pending_invitation)', () => {
    let n = 0;
    async function invitacion(opts: { vence?: string; revocada?: boolean; aceptada?: boolean }) {
      n += 1;
      const token = randomBytes(16).toString('hex');
      const hash = createHash('sha256').update(token).digest('hex');
      await pool.query(
        `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at,
                                       revoked_at, accepted_at)
         VALUES ($1, $2, 'vendedor', $3, $4, now() + $5::interval,
                 CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END)`,
        [
          tenant,
          `inv-${n}-${sfx}@test.local`,
          hash,
          usuario,
          opts.vence ?? '7 days',
          opts.revocada ?? false,
          opts.aceptada ?? false,
        ],
      );
      return hash;
    }

    /** Como la API: app_user, antes de tener sesión (sin tenant ni usuario en el contexto). */
    async function canjear(hash: string): Promise<number> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        const r = await c.query('SELECT * FROM claim_pending_invitation($1)', [hash]);
        await c.query('COMMIT');
        return r.rowCount ?? 0;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }

    it('una vigente se canjea una sola vez', async () => {
      const h = await invitacion({});
      expect(await canjear(h)).toBe(1);
      expect(await canjear(h)).toBe(0);
    });

    it('vencida, revocada o ya usada: no se canjea', async () => {
      expect(await canjear(await invitacion({ vence: '-1 minute' }))).toBe(0);
      expect(await canjear(await invitacion({ revocada: true }))).toBe(0);
      expect(await canjear(await invitacion({ aceptada: true }))).toBe(0);
    });

    it('un hash que no existe no devuelve nada', async () => {
      expect(await canjear(createHash('sha256').update(sfx).digest('hex'))).toBe(0);
    });
  });

  describe('SQL-07 localizador del proveedor inmutable', () => {
    let numero = 0;
    async function orden(ref: string | null): Promise<string> {
      numero += 1;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                             contact_info, total_amount, order_number, status, provider_booking_ref)
         VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 1000, $4,
                 'pending', $5)
         RETURNING id`,
        [tenant, usuario, `sql-guardas-${sfx}`, numero, ref],
      );
      return rows[0]!.id;
    }

    /** Como la API: app_user con el tenant de la orden. */
    async function comoApp(q: string, params: unknown[]): Promise<void> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant]);
        await c.query(q, params);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }

    const ref = (id: string) =>
      pool
        .query<{
          r: string | null;
        }>('SELECT provider_booking_ref AS r FROM orders WHERE id = $1', [id])
        .then((x) => x.rows[0]?.r);

    it('escribirlo sobre NULL vale; volver a escribir el mismo, también', async () => {
      const id = await orden(null);
      await comoApp('UPDATE orders SET provider_booking_ref = $2 WHERE id = $1', [id, `LOC${sfx}`]);
      await comoApp('UPDATE orders SET provider_booking_ref = $2 WHERE id = $1', [id, `LOC${sfx}`]);
      expect(await ref(id)).toBe(`LOC${sfx}`);
    });

    it('cambiarlo o borrarlo falla, también para el dueño de la tabla', async () => {
      const id = await orden(`ORIG${sfx}`);
      await expect(
        comoApp('UPDATE orders SET provider_booking_ref = $2 WHERE id = $1', [id, `OTRO${sfx}`]),
      ).rejects.toThrow(/provider_booking_ref no se modifica/);
      await expect(
        comoApp('UPDATE orders SET provider_booking_ref = NULL WHERE id = $1', [id]),
      ).rejects.toThrow(/provider_booking_ref no se modifica/);
      await expect(
        pool.query('UPDATE orders SET provider_booking_ref = $2 WHERE id = $1', [id, 'X']),
      ).rejects.toThrow(/provider_booking_ref no se modifica/);
      expect(await ref(id)).toBe(`ORIG${sfx}`);
    });

    it('cambiar otra columna de la orden no lo toca ni dispara la guarda', async () => {
      const id = await orden(`FIJO${sfx}`);
      await comoApp(`UPDATE orders SET contact_info = '{"nota": 1}'::jsonb WHERE id = $1`, [id]);
      expect(await ref(id)).toBe(`FIJO${sfx}`);
    });
  });
});
