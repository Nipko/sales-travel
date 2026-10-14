import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role } from '../database/database.types.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import type { MailerService, MailMessage } from './mailer.service.js';
import { SecurityNoticeService } from './security-notice.service.js';

/**
 * Por qué correo sale cada aviso de seguridad, contra Postgres:
 *
 *   - desde un nodo, por el de ese nodo y nombrándolo;
 *   - sin nodo de por medio (su contraseña, su cuenta), por el de su membership ACTIVA más antigua,
 *     que la RLS de memberships sólo le deja ver a ella (como app_user, con su id en el contexto);
 *   - sin ninguna activa, por el del sistema.
 *
 * El correo es un doble: lo que se prueba es a qué nodo y a quién. Se SALTA sin PGHOST.
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

d('avisos de seguridad: por qué correo sale cada uno, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  const mailer = {
    sendToTenant: vi.fn((_tenantId: string | null, _msg: MailMessage) => Promise.resolve(true)),
  };
  const notices = new SecurityNoticeService(
    database,
    mailer as unknown as MailerService,
    new InflightWorkRegistry(),
  );

  let norte: string;
  let sur: string;

  const slug = (label: string) => `snot-${label}-${sfx}`;
  const email = (label: string) => `snot-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: 'consolidator' | 'agency', parent: string) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [slug(label), `Agencia ${label}`, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'hash') RETURNING id`,
      [email(label), `Persona ${label}`],
    );
    return rows[0]!.id;
  }

  async function member(
    tenantId: string,
    userId: string,
    role: Role,
    status: string,
    createdAt: string,
  ) {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [tenantId, userId, role, status, createdAt],
    );
  }

  function lastMail(): { tenantId: string | null; msg: MailMessage } {
    const call = mailer.sendToTenant.mock.calls.at(-1);
    if (call === undefined) throw new Error('no salió ningún correo');
    return { tenantId: call[0], msg: call[1] };
  }

  beforeAll(async () => {
    database.onModuleInit();
    const platform = await platformRootId(pool);
    const cons = await tenant('cons', 'consolidator', platform);
    norte = await tenant('norte', 'agency', cons);
    sur = await tenant('sur', 'agency', cons);
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`snot-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('desde un nodo: sale por el correo de ese nodo, a la persona, nombrándolo', async () => {
    const ana = await user('ana');
    await member(sur, ana, 'vendedor', 'active', '2026-01-01');

    expect(await notices.send('sessions_revoked', { userId: ana, tenantId: norte })).toBe(true);

    const { tenantId, msg } = lastMail();
    expect(tenantId).toBe(norte);
    expect(msg.to).toBe(email('ana'));
    expect(msg.text).toContain('Hola, Persona ana:');
    expect(msg.text).toContain('Un administrador de Agencia norte cerró tus sesiones.');
  });

  it('sin nodo de por medio: por el de su membership activa más antigua, que sólo ella ve', async () => {
    const beto = await user('beto');
    // La más antigua está suspendida: no cuenta.
    await member(norte, beto, 'vendedor', 'suspended', '2025-01-01');
    await member(sur, beto, 'vendedor', 'active', '2025-06-01');

    expect(await notices.send('password_changed', { userId: beto, tenantId: null })).toBe(true);

    const { tenantId, msg } = lastMail();
    expect(tenantId).toBe(sur);
    expect(msg.to).toBe(email('beto'));
    expect(msg.text).not.toContain('Agencia sur');
  });

  it('sin ninguna membership activa: por el correo del sistema', async () => {
    const cami = await user('cami');
    await member(norte, cami, 'vendedor', 'suspended', '2025-01-01');

    expect(await notices.send('account_suspended', { userId: cami, tenantId: null })).toBe(true);
    expect(lastMail().tenantId).toBeNull();
    expect(lastMail().msg.to).toBe(email('cami'));
  });

  it('una persona que no existe: false y ningún correo', async () => {
    expect(
      await notices.send('unlocked', {
        userId: '00000000-0000-4000-8000-000000000000',
        tenantId: norte,
      }),
    ).toBe(false);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
  });
});
