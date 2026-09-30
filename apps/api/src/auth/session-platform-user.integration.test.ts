import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { SessionService } from './session.service.js';

/**
 * El superadmin no vende (modelo Planetour, 2026-09-28) y es una identidad del USUARIO: la marca
 * `platformUser` de `SessionService.validate` sale de sus memberships en cualquier nodo, no del rol
 * en el tenant activo. Contra Postgres y como `app_user` (NOBYPASSRLS), porque la marca depende de
 * que la policy `memberships_self` le deje ver sus propias memberships de otros nodos. RolesGuard la
 * usa en las rutas `@SalesOperation()`. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

/** `DatabaseService` que entra como `app_user`, el rol de la API. */
class ComoAppUser extends DatabaseService {
  override async withRequestContext<T>(
    ctx: { userId?: string; tenantId?: string },
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx);
      if (ctx.userId) {
        await sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`.execute(trx);
      }
      if (ctx.tenantId) {
        await sql`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`.execute(trx);
      }
      return fn(trx);
    });
  }
}

d('SessionService.validate: la marca de usuario de plataforma, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sessions = new SessionService(database);
  const sfx = randomBytes(4).toString('hex');

  let platform: string;
  let branch: string;

  async function user(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'hash-de-prueba') RETURNING id`,
      [`spu-${label}-${sfx}@test.local`],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: string, status = 'active') {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  async function session(userId: string, tenantId: string) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
      [userId, tenantId],
    );
    return { sessionId: rows[0]!.id, userId, tenantId };
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, is_branch,
                            parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', true, $2) RETURNING id`,
      [`spu-sucursal-${sfx}`, platform],
    );
    branch = rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE id = $1', [branch]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('el superadmin lleva la marca en su nodo', async () => {
    const root = await user('root');
    await member(platform, root, 'superadmin');
    expect(await sessions.validate(await session(root, platform))).toMatchObject({
      ok: true,
      role: 'superadmin',
      platformUser: true,
    });
  });

  it('y la sigue llevando en la sucursal donde además es vendedor: ahí tampoco vende', async () => {
    const root = await user('root-seller');
    await member(platform, root, 'superadmin');
    await member(branch, root, 'vendedor');
    expect(await sessions.validate(await session(root, branch))).toMatchObject({
      ok: true,
      role: 'vendedor',
      platformUser: true,
    });
  });

  it('un vendedor de la sucursal no la lleva', async () => {
    const seller = await user('seller');
    await member(branch, seller, 'vendedor');
    const validated = await sessions.validate(await session(seller, branch));
    expect(validated).toMatchObject({ ok: true, role: 'vendedor' });
    expect(validated).not.toHaveProperty('platformUser');
  });

  it('el admin de Planetour que no es superadmin tampoco (el founder hoy, en producción)', async () => {
    const founder = await user('founder');
    await member(platform, founder, 'consolidator_admin');
    const validated = await sessions.validate(await session(founder, platform));
    expect(validated).toMatchObject({ ok: true, role: 'consolidator_admin' });
    expect(validated).not.toHaveProperty('platformUser');
  });

  it('una membership de superadmin suspendida no da la marca, igual que isSuperadmin()', async () => {
    const former = await user('former');
    await member(platform, former, 'superadmin', 'suspended');
    await member(branch, former, 'vendedor');
    const validated = await sessions.validate(await session(former, branch));
    expect(validated).toMatchObject({ ok: true, role: 'vendedor' });
    expect(validated).not.toHaveProperty('platformUser');
  });
});
