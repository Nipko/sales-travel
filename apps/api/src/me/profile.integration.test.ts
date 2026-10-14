import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { ProfileService } from './profile.service.js';

/**
 * Editar tu nombre contra Postgres (USR-18, 0069):
 *
 *   - por la API (ProfileService): cambia sólo la cuenta de la sesión, deja `UserProfileUpdated` con
 *     el antes y el después en la misma transacción, y repetir el mismo nombre no escribe nada;
 *   - por la base, aunque un endpoint futuro use el id equivocado: `app_user` no cambia el nombre de
 *     otra cuenta (42501 `users_name_self_only`), ni sin contexto, ni con un contexto que no es un
 *     UUID, ni en un UPDATE de varias filas que incluya la propia; el resto de las columnas de otra
 *     cuenta (lo que tocan el login y el soporte de un admin) se sigue pudiendo actualizar; y
 *     `app_user` no puede apagar el trigger. Un rol que se salta la RLS (migraciones, la consola del
 *     operador) sí cambia cualquier nombre.
 *
 * `users` no tiene RLS (identidad global, 0001): la regla es el trigger. Todo lo de la API corre
 * como `app_user` (NOSUPERUSER, NOBYPASSRLS); el superusuario sólo siembra y mira. Se SALTA sin
 * PGHOST o sin APP_USER_PASSWORD.
 */
const hasDb = Boolean(
  process.env['PGHOST'] &&
    process.env['PGUSER'] &&
    process.env['PGPASSWORD'] &&
    process.env['APP_USER_PASSWORD'],
);
const d = hasDb ? describe : describe.skip;

function appUserPool(): pg.Pool {
  return new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
    max: 3,
  });
}

/** `DatabaseService` conectado como `app_user`, el rol de la API en producción. */
class ComoAppUser extends DatabaseService {
  override onModuleInit(): void {
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: appUserPool() }) });
  }
}

interface PgError {
  code?: string;
  constraint?: string;
}

d('editar tu nombre, contra Postgres', () => {
  const pool = new pg.Pool();
  const appUser = appUserPool();
  const database = new ComoAppUser();
  const profile = new ProfileService(database, new AuditService(database));
  const sfx = randomBytes(4).toString('hex');

  let ana: string;
  let beto: string;

  const email = (label: string) => `pf-${label}-${sfx}@test.local`;

  async function user(label: string, name: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'hash') RETURNING id`,
      [email(label), name],
    );
    return rows[0]!.id;
  }

  async function nameOf(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ name: string | null }>(
      'SELECT name FROM users WHERE id = $1',
      [id],
    );
    return rows[0]!.name;
  }

  async function setName(id: string, name: string | null): Promise<void> {
    await pool.query('UPDATE users SET name = $2 WHERE id = $1', [id, name]);
  }

  async function profileEvents(id: string) {
    const { rows } = await pool.query<{
      actor_user_id: string | null;
      aggregate_type: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, aggregate_type, payload FROM domain_events
        WHERE event_type = 'UserProfileUpdated' AND aggregate_id = $1 ORDER BY occurred_at, id`,
      [id],
    );
    return rows;
  }

  /**
   * Corre `statement` como `app_user` en una transacción con `actor` en `app.current_user_id` (como
   * DatabaseService.withRequestContext), y devuelve el error de Postgres o `null` si pasó.
   */
  async function asAppUser(
    actor: string | null,
    statement: string,
    params: unknown[],
  ): Promise<PgError | null> {
    const client = await appUser.connect();
    try {
      await client.query('BEGIN');
      if (actor !== null) {
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [actor]);
      }
      await client.query(statement, params);
      await client.query('COMMIT');
      return null;
    } catch (err) {
      await client.query('ROLLBACK');
      return err as PgError;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    database.onModuleInit();
    ana = await user('ana', 'Ana Ruiz');
    beto = await user('beto', 'Beto Díaz');
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await appUser.end();
    await pool.end();
  });

  describe('por la API', () => {
    it('cambia sólo la cuenta de la sesión y deja el evento con el antes y el después', async () => {
      await expect(profile.updateName(ana, 'Ana María Ruiz')).resolves.toEqual({
        name: 'Ana María Ruiz',
      });

      expect(await nameOf(ana)).toBe('Ana María Ruiz');
      expect(await nameOf(beto)).toBe('Beto Díaz');
      expect(await profileEvents(ana)).toEqual([
        {
          actor_user_id: ana,
          aggregate_type: 'user',
          payload: {
            changed: ['name'],
            before: { name: 'Ana Ruiz' },
            after: { name: 'Ana María Ruiz' },
          },
        },
      ]);
      expect(await profileEvents(beto)).toEqual([]);
    });

    it('con el mismo nombre no escribe ni deja otro evento', async () => {
      const before = (await profileEvents(ana)).length;
      await profile.updateName(ana, 'Ana María Ruiz');
      expect(await profileEvents(ana)).toHaveLength(before);
    });

    it('una cuenta sin nombre lo pone, con el antes vacío', async () => {
      const sinNombre = await user('sin-nombre', null);
      await profile.updateName(sinNombre, 'Carla');
      expect(await nameOf(sinNombre)).toBe('Carla');
      expect((await profileEvents(sinNombre))[0]?.payload).toEqual({
        changed: ['name'],
        before: { name: null },
        after: { name: 'Carla' },
      });
    });
  });

  describe('por la base (trigger users_name_self_only)', () => {
    it('app_user con la sesión de Ana no cambia el nombre de Beto', async () => {
      const err = await asAppUser(ana, 'UPDATE users SET name = $2 WHERE id = $1', [
        beto,
        'Soporte PlaneTour',
      ]);
      expect(err).toMatchObject({ code: '42501', constraint: 'users_name_self_only' });
      expect(await nameOf(beto)).toBe('Beto Díaz');
    });

    it('sin contexto, o con uno que no es un UUID, tampoco (ni el propio)', async () => {
      for (const actor of [null, '', 'no-es-un-uuid']) {
        const err = await asAppUser(actor, 'UPDATE users SET name = $2 WHERE id = $1', [
          ana,
          'Otro nombre',
        ]);
        expect(err, String(actor)).toMatchObject({
          code: '42501',
          constraint: 'users_name_self_only',
        });
      }
      expect(await nameOf(ana)).toBe('Ana María Ruiz');
    });

    it('un UPDATE de varias filas que incluye la propia falla entero', async () => {
      const err = await asAppUser(ana, 'UPDATE users SET name = $3 WHERE id IN ($1, $2)', [
        ana,
        beto,
        'Mismo nombre',
      ]);
      expect(err).toMatchObject({ code: '42501', constraint: 'users_name_self_only' });
      expect(await nameOf(ana)).toBe('Ana María Ruiz');
      expect(await nameOf(beto)).toBe('Beto Díaz');
    });

    it('con su propia sesión, app_user sí cambia el propio', async () => {
      expect(
        await asAppUser(ana, 'UPDATE users SET name = $2 WHERE id = $1', [ana, 'Ana R.']),
      ).toBeNull();
      expect(await nameOf(ana)).toBe('Ana R.');
      await setName(ana, 'Ana María Ruiz');
    });

    it('el resto de las columnas de otra cuenta se sigue actualizando (login, soporte)', async () => {
      expect(
        await asAppUser(
          ana,
          `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, status = 'active'
            WHERE id = $1`,
          [beto],
        ),
      ).toBeNull();
      // Repetir el nombre que ya tiene no es cambiarlo: no dispara.
      expect(
        await asAppUser(null, 'UPDATE users SET name = name, last_login_at = now() WHERE id = $1', [
          beto,
        ]),
      ).toBeNull();
      expect(await nameOf(beto)).toBe('Beto Díaz');
    });

    it('app_user no puede apagar el trigger', async () => {
      const disable = await asAppUser(
        ana,
        'ALTER TABLE users DISABLE TRIGGER users_name_self_only',
        [],
      );
      expect(disable?.code).toBe('42501');
      const replica = await asAppUser(ana, `SET LOCAL session_replication_role = 'replica'`, []);
      expect(replica?.code).toBe('42501');
    });

    it('un rol que se salta la RLS (migraciones, consola del operador) cambia cualquier nombre', async () => {
      await setName(beto, 'Roberto Díaz');
      expect(await nameOf(beto)).toBe('Roberto Díaz');
      await setName(beto, 'Beto Díaz');
    });

    it('el trigger existe y sólo mira el nombre cuando cambia', async () => {
      const { rows } = await pool.query<{ def: string }>(
        `SELECT pg_get_triggerdef(t.oid) AS def
           FROM pg_trigger t
          WHERE t.tgrelid = 'public.users'::regclass AND t.tgname = 'users_name_self_only'
            AND NOT t.tgisinternal AND t.tgenabled = 'O'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.def).toContain('BEFORE UPDATE OF name ON public.users');
      expect(rows[0]!.def).toContain('(new.name IS DISTINCT FROM old.name)');
    });
  });
});
