import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AdminAuditQuerySchema } from '../audit/admin-audit.schemas.js';
import { AdminAuditService } from '../audit/admin-audit.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { PLATFORM_ADMIN_CHANGE_KINDS } from './platform-admins.controller.js';
import {
  ChangeRequestPendingError,
  SelfPlatformAdminChangeError,
} from './platform-admins.errors.js';
import { GrantInputSchema } from './platform-admins.schemas.js';
import { PLATFORM_ADMIN_EVENTS, PlatformAdminsService } from './platform-admins.service.js';
import { CHANGE_REQUEST_EVENTS, SupervisionService } from './supervision.service.js';
import type { SessionService } from '../auth/session.service.js';

/**
 * Superadmins plenos y supervisados contra Postgres (0092, docs/platform/16):
 *
 *   - la RLS de platform_change_requests: un admin de nodo no la lee ni la escribe; un supervisado
 *     pide a su nombre pero no decide; un pleno decide;
 *   - el ciclo entero: el supervisado pide dar acceso, queda pendiente sin aplicarse; un pleno lo
 *     aprueba, se aplica, y el evento del cambio lleva quién lo pidió y quién lo aprobó;
 *   - un cambio directo en la base (psql, fuera de la API) deja db.direct_change con el antes y el
 *     después y sin el secreto; uno de la API, no;
 *   - aislamiento: la Actividad de una red no muestra los cambios directos; "Sólo superadmins" no la
 *     puede pedir quien no es superadmin y no trae lo que hizo un admin de nodo.
 *
 * Lo que la API ejecuta corre como `app_user`; el superusuario siembra y hace de "consola psql". Se
 * SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

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

/** Las sesiones no importan acá: quitar el acceso las cierra, y eso lo prueban los de auth. */
const sessions = { revokeForTenant: () => Promise.resolve(0) } as unknown as SessionService;

d('Superadmins plenos y supervisados (0092) contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const audit = new AuditService(database);
  const supervision = new SupervisionService(database, audit);
  const admins = new PlatformAdminsService(database, audit, sessions);
  const adminAudit = new AdminAuditService(database, audit);
  const sfx = randomBytes(4).toString('hex');

  let platform: string;
  let consA: string;
  let pleno: string;
  let supervisado: string;
  let adminConsA: string;
  let candidata: string;
  let account: string;

  async function user(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`sup-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    return rows[0]!.id;
  }

  /** Una consulta como app_user con ese usuario en el contexto: 'ok:<filas>' o el SQLSTATE. */
  async function ensayo(userId: string, text: string, values: unknown[] = []): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const res = await c.query(text, values);
      return `ok:${res.rowCount ?? 0}`;
    } catch (err) {
      return String((err as { code?: string }).code ?? 'error');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'consolidator', $2) RETURNING id`,
      [`sup-ca-${sfx}`, platform],
    );
    consA = rows[0]!.id;

    pleno = await user('pleno');
    supervisado = await user('supervisado');
    adminConsA = await user('admin-ca');
    candidata = await user('candidata');
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status, platform_supervised)
       VALUES ($1, $2, 'superadmin', 'active', false), ($1, $3, 'superadmin', 'active', true),
              ($4, $5, 'consolidator_admin', 'active', false)`,
      [platform, pleno, supervisado, consA, adminConsA],
    );
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, status)
       VALUES ($1, 'sabre', 'default', '\\x00'::bytea, '{"pcc":"AAA1","bookOnTicketingPcc":false}', 'sandbox')
       RETURNING id`,
      [consA],
    );
    account = acc.rows[0]!.id;

    supervision.register(PLATFORM_ADMIN_CHANGE_KINDS.grant, {
      schema: GrantInputSchema,
      summary: (i) => `Superadmins: dar acceso a ${i.email}`,
      execute: (actor, i) => admins.grant(actor, i),
    });
  });

  afterAll(async () => {
    const users = [pleno, supervisado, adminConsA, candidata].filter(Boolean);
    await pool.query(`DELETE FROM platform_change_requests WHERE requested_by = ANY($1::uuid[])`, [
      users,
    ]);
    await pool.query(
      `DELETE FROM domain_events
        WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = $2
           OR (event_type = 'db.direct_change' AND aggregate_id = $3)`,
      [users, consA, account],
    );
    await pool.query('DELETE FROM tenants WHERE id = $1', [consA]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await pool.end();
  });

  it('RLS: un admin de nodo no lee ni pide; un supervisado pide pero no decide', async () => {
    expect(await ensayo(adminConsA, 'SELECT * FROM platform_change_requests')).toBe('ok:0');
    expect(
      await ensayo(
        adminConsA,
        `INSERT INTO platform_change_requests (kind, summary, requested_by) VALUES ('x.y', 's', $1)`,
        [adminConsA],
      ),
    ).toBe('42501');
    // A nombre de otro, tampoco.
    expect(
      await ensayo(
        supervisado,
        `INSERT INTO platform_change_requests (kind, summary, requested_by) VALUES ('x.y', 's', $1)`,
        [pleno],
      ),
    ).toBe('42501');

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO platform_change_requests (kind, summary, requested_by)
       VALUES ('x.y', 'prueba RLS', $1) RETURNING id`,
      [supervisado],
    );
    const id = rows[0]!.id;
    const decide = `UPDATE platform_change_requests
                       SET status = 'approved', decided_by = $2, decided_at = now()
                     WHERE id = $1`;
    expect(await ensayo(supervisado, decide, [id, supervisado])).not.toBe('ok:1');
    expect(await ensayo(adminConsA, decide, [id, adminConsA])).toBe('ok:0');
    expect(await ensayo(pleno, decide, [id, pleno])).toBe('ok:1');
  });

  it('el supervisado pide, nada cambia; el pleno aprueba y el cambio lleva a los dos', async () => {
    const email = `sup-candidata-${sfx}@test.local`;
    const input = GrantInputSchema.parse({
      email,
      supervised: true,
      reason: 'apoyo de operaciones',
    });

    const pending = await supervision
      .gate(supervisado, PLATFORM_ADMIN_CHANGE_KINDS.grant, input)
      .catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(ChangeRequestPendingError);
    const requestId = (pending as ChangeRequestPendingError).publicDetails.changeRequestId;

    const antes = await pool.query(
      `SELECT 1 FROM memberships WHERE user_id = $1 AND role = 'superadmin'`,
      [candidata],
    );
    expect(antes.rowCount).toBe(0);

    const view = await supervision.approve(pleno, requestId, 'de acuerdo');
    expect(view).toMatchObject({ status: 'approved', decidedBy: { id: pleno } });

    const despues = await pool.query<{ platform_supervised: boolean; status: string }>(
      `SELECT platform_supervised, status FROM memberships
        WHERE user_id = $1 AND role = 'superadmin' AND tenant_id = $2`,
      [candidata, platform],
    );
    expect(despues.rows).toEqual([{ platform_supervised: true, status: 'active' }]);

    const ev = await pool.query<{
      event_type: string;
      actor_user_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_user_id, payload FROM domain_events
        WHERE (aggregate_type = 'change_request' AND aggregate_id = $1)
           OR (event_type = $2 AND payload ->> 'targetUserId' = $3)
        ORDER BY occurred_at, id`,
      [requestId, PLATFORM_ADMIN_EVENTS.granted, candidata],
    );
    expect(ev.rows.map((r) => [r.event_type, r.actor_user_id])).toEqual([
      [CHANGE_REQUEST_EVENTS.created, supervisado],
      [CHANGE_REQUEST_EVENTS.approved, pleno],
      [PLATFORM_ADMIN_EVENTS.granted, supervisado],
    ]);
    expect(ev.rows[2]!.payload).toMatchObject({
      before: null,
      after: { role: 'superadmin', status: 'active', supervised: true },
      reason: 'apoyo de operaciones',
      approval: { changeRequestId: requestId, requestedBy: supervisado, approvedBy: pleno },
    });
  });

  it('nadie se da ni se quita acceso a sí mismo', async () => {
    await expect(
      admins.grant(pleno, {
        email: `sup-pleno-${sfx}@test.local`,
        supervised: false,
        reason: null,
      }),
    ).rejects.toBeInstanceOf(SelfPlatformAdminChangeError);
    await expect(admins.revoke(pleno, { userId: pleno, reason: null })).rejects.toBeInstanceOf(
      SelfPlatformAdminChangeError,
    );
  });

  it('un cambio directo en la base deja db.direct_change con antes y después, sin el secreto', async () => {
    await pool.query(
      `UPDATE provider_accounts
          SET config = config || '{"bookOnTicketingPcc":true}'::jsonb, credentials_enc = '\\x01'::bytea
        WHERE id = $1`,
      [account],
    );
    const { rows } = await pool.query<{
      tenant_id: string;
      actor_user_id: string | null;
      aggregate_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT tenant_id, actor_user_id, aggregate_type, payload FROM domain_events
        WHERE event_type = 'db.direct_change' AND aggregate_id = $1 ORDER BY occurred_at DESC, id DESC`,
      [account],
    );
    const [ultimo] = rows;
    expect(ultimo).toMatchObject({
      tenant_id: consA,
      actor_user_id: null,
      aggregate_type: 'provider_accounts',
    });
    expect(ultimo!.payload).toMatchObject({
      table: 'provider_accounts',
      operation: 'update',
      changes: {
        config: {
          before: { pcc: 'AAA1', bookOnTicketingPcc: false },
          after: { pcc: 'AAA1', bookOnTicketingPcc: true },
        },
      },
      secretColumnsChanged: ['credentials_enc'],
    });
    expect(JSON.stringify(ultimo!.payload)).not.toContain('credentials_enc":');
    expect(JSON.stringify(ultimo!.payload)).not.toMatch(/\\\\x0[01]/);

    // El mismo cambio desde la API (app_user) no deja evento directo: la API deja el suyo.
    const contar = async () =>
      (
        await pool.query(
          `SELECT 1 FROM domain_events WHERE event_type = 'db.direct_change' AND aggregate_id = $1`,
          [account],
        )
      ).rowCount;
    const antes = await contar();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [consA]);
      await c.query(`UPDATE provider_accounts SET config = '{"pcc":"AAA1"}' WHERE id = $1`, [
        account,
      ]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await contar()).toBe(antes);
  });

  it('aislamiento: la red no ve los cambios directos; "Sólo superadmins" es del superadmin', async () => {
    const red = await audit.networkAudit(adminConsA, consA, { limit: 200 });
    expect(red.events.map((e) => e.eventType)).not.toContain('db.direct_change');

    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    await expect(
      adminAudit.list(
        adminConsA,
        AdminAuditQuerySchema.parse({ platformOnly: 'true', from: hoy, to: hoy }),
      ),
    ).rejects.toMatchObject({ reason: 'SUPERADMIN_REQUIRED' });

    await audit.emit({
      eventType: 'MarkupRuleCreated',
      tenantId: consA,
      actorUserId: adminConsA,
      payload: { probe: sfx },
    });
    const soloSuper = await adminAudit.list(
      pleno,
      AdminAuditQuerySchema.parse({
        platformOnly: 'true',
        tenantId: consA,
        from: hoy,
        to: hoy,
        limit: '200',
      }),
    );
    const tipos = soloSuper.events.map((e) => e.eventType);
    expect(tipos).toContain('db.direct_change');
    expect(
      soloSuper.events.filter((e) => e.actorEmail === `sup-admin-ca-${sfx}@test.local`),
    ).toEqual([]);

    // Y "Todo" (sin el filtro) no trae los directos: se buscan en "Superadmins".
    const todo = await adminAudit.list(
      pleno,
      AdminAuditQuerySchema.parse({ tenantId: consA, from: hoy, to: hoy, limit: '200' }),
    );
    expect(todo.events.map((e) => e.eventType)).not.toContain('db.direct_change');
    expect(todo.events.map((e) => e.eventType)).toContain('MarkupRuleCreated');
  });
});
