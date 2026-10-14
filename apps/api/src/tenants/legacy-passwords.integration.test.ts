import { createHash, randomBytes } from 'node:crypto';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { MfaRecentRequiredError } from '../auth/auth-errors.js';
import { RecentMfaGuard } from '../auth/guards/recent-mfa.guard.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { LegacyPasswordsController } from './legacy-passwords.controller.js';
import {
  LEGACY_RESET_BATCH_EVENT,
  LegacyPasswordsService,
  type LegacyPasswordAccount,
} from './legacy-passwords.service.js';

/**
 * Forzar el cambio de contraseña a las cuentas heredadas (USR-14) contra Postgres:
 *
 *   - el criterio: aparecen las cuentas que nacieron como las creaban los caminos retirados
 *     (`POST /admin/users` con un correo nuevo y el admin inicial de `POST /admin/tenants` con
 *     contraseña: la cuenta y una membership con `invited_by` de otra cuenta, en una transacción),
 *     con o sin su evento; no aparecen las que aceptaron una invitación, se registraron solas, se
 *     vincularon ya existiendo, vienen de un seed, ya cambiaron su contraseña, ya tienen el cambio
 *     pendiente, están suspendidas o son de quien mira;
 *   - sólo el superadmin: un admin de red recibe 403 sin que nada cambie;
 *   - forzar: un resultado por cuenta, el cambio de USR-3 (marca, sesiones cerradas, un solo
 *     enlace), su rastro con el lote y el del lote; un correo que no sale queda dicho y auditado;
 *   - volver a correrlo no le escribe a nadie de nuevo;
 *   - forzar pide el 2FA de los últimos 10 minutos, medido con el reloj de la base.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Cuelga de la raíz `platform` compartida y cada lista se filtra por el sufijo del test. Se SALTA
 * sin PGHOST.
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

/** `código HTTP/motivo` del error con que falla `p`. Falla el test si `p` no falla. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    if (typeof http.getStatus !== 'function') throw err;
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
  throw new Error('esperaba un error HTTP');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

d('cuentas heredadas con una contraseña de un admin, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');

  /** Un correo a quien empiece así no sale. */
  const FAILS = 'lp-sinbuzon';
  const mailer = {
    sendToTenant: vi.fn((_tenantId: string | null, mail: { to: string; text: string }) =>
      Promise.resolve(!mail.to.startsWith(FAILS)),
    ),
  };
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
    // La contraseña nueva nunca es la que eligió el admin.
    verify: () => Promise.resolve(false),
  } as unknown as PasswordService;
  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const sessions = new SessionService(database, audit);
  const notices = { notify: vi.fn() } as unknown as SecurityNoticeService;
  const resets = new PasswordResetService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
    sessions,
    notices,
  );
  const legacy = new LegacyPasswordsService(database, network, audit, resets);
  const controller = new LegacyPasswordsController(legacy);

  let platform: string;
  let norte: string;
  let sur: string;
  /** Admin de Norte: crea cuentas como lo hacía el panel viejo. No es superadmin. */
  let adminNorte: string;
  /** El superadmin que mira. Él mismo nació con la contraseña de un admin. */
  let root: string;
  /** Otro superadmin, que sí lo ve en la lista. */
  let root2: string;

  const slug = (label: string) => `lp-${label}-${sfx}`;
  const email = (label: string) => `lp-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: TenantType, parent: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [slug(label), `Agencia ${label}`, type, parent],
    );
    return rows[0]!.id;
  }

  /** Una cuenta que eligió su propia contraseña (o la de un test), sin membership. */
  async function user(label: string, mail = email(label)): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, mfa_enabled_at)
       VALUES ($1, 'hash-propio', $2, now()) RETURNING id`,
      [mail, `Persona ${label}`],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: Role, invitedBy?: string) {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, invitedBy ?? null],
    );
  }

  async function inOneTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Como `POST /admin/users` con un correo nuevo, hasta 2026-09-30: la cuenta con la contraseña que
   * escribió el admin y su membership, en una transacción. Con `event`, también el `UserCreated` que
   * escribía desde 2026-08-06 (antes no había evento).
   */
  async function createdByAdmin(
    label: string,
    opts: { tenantId?: string; by?: string; role?: Role; event?: boolean; mail?: string } = {},
  ): Promise<string> {
    const tenantId = opts.tenantId ?? norte;
    const by = opts.by ?? adminNorte;
    const role = opts.role ?? 'vendedor';
    return inOneTransaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, 'hash-elegido-por-el-admin', $2) RETURNING id`,
        [opts.mail ?? email(label), `Persona ${label}`],
      );
      const id = rows[0]!.id;
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)`,
        [tenantId, id, role, by],
      );
      if (opts.event) {
        await c.query(
          `INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
           VALUES ($1, $2, 'UserCreated', 'user', $3, $4::jsonb)`,
          [tenantId, by, id, JSON.stringify({ role, existingUserLinked: false })],
        );
      }
      return id;
    });
  }

  /** Como `POST /admin/tenants` con `adminPassword`: el nodo, su admin inicial y TenantCreated. */
  async function initialAdmin(label: string): Promise<{ tenantId: string; userId: string }> {
    return inOneTransaction(async (c) => {
      const t = await c.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
         VALUES ($1::text, $2::text, 'CO', 'COP', 'subagency', $3) RETURNING id`,
        [slug(label), `Agencia ${label}`, sur],
      );
      const tenantId = t.rows[0]!.id;
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, 'hash-elegido-por-el-admin', NULL) RETURNING id`,
        [email(label)],
      );
      const userId = u.rows[0]!.id;
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role, invited_by) VALUES ($1, $2, 'tenant_admin', $3)`,
        [tenantId, userId, root2],
      );
      await c.query(
        `INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
         VALUES ($1::uuid, $2, 'TenantCreated', 'tenant', $1::text, $3::jsonb)`,
        [tenantId, root2, JSON.stringify({ adminRole: 'tenant_admin', admin: 'created' })],
      );
      return { tenantId, userId };
    });
  }

  /** La lista que ve `actor`, sólo con las cuentas de este test. */
  async function listed(actor = root): Promise<LegacyPasswordAccount[]> {
    const out = await controller.list(actor);
    return out.users.filter((u) => u.email.endsWith(`-${sfx}@test.local`));
  }

  async function listedEmails(actor = root): Promise<string[]> {
    return (await listed(actor)).map((u) => u.email).sort();
  }

  async function state(userId: string) {
    const { rows } = await pool.query<{
      required: boolean;
      hash: string | null;
      live_sessions: number;
      tokens: number;
      unused: number;
    }>(
      `SELECT u.password_reset_required_at IS NOT NULL AS required, u.password_hash AS hash,
              (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL)::int AS live_sessions,
              (SELECT count(*) FROM password_reset_tokens t WHERE t.user_id = u.id)::int AS tokens,
              (SELECT count(*) FROM password_reset_tokens t WHERE t.user_id = u.id AND t.used_at IS NULL)::int AS unused
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    return rows[0]!;
  }

  async function events(type: string, aggregateId: string) {
    const { rows } = await pool.query<{
      actor_user_id: string | null;
      tenant_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, tenant_id, payload FROM domain_events
        WHERE event_type = $1 AND aggregate_id = $2 ORDER BY occurred_at, id`,
      [type, aggregateId],
    );
    return rows;
  }

  async function batchEvents(batchId: string) {
    const { rows } = await pool.query<{
      actor_user_id: string | null;
      tenant_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, tenant_id, payload FROM domain_events
        WHERE event_type = $1 AND payload->>'batchId' = $2`,
      [LEGACY_RESET_BATCH_EVENT, batchId],
    );
    return rows;
  }

  async function liveSession(userId: string, tenantId: string) {
    await pool.query(
      `INSERT INTO sessions (user_id, tenant_id, expires_at, last_seen_at)
       VALUES ($1, $2, now() + interval '8 hours', now())`,
      [userId, tenantId],
    );
  }

  /** El token en claro del correo que salió a `to`. */
  function mailedToken(to: string): string {
    const call = mailer.sendToTenant.mock.calls.find((c) => c[1].to === to);
    if (call === undefined) throw new Error(`no salió ningún correo a ${to}`);
    return decodeURIComponent(/token=([^\s]+)/.exec(call[1].text)![1]!);
  }

  // Las cuentas del test.
  let heredada: string;
  let heredadaConEvento: string;
  let sinBuzon: string;
  let inicial: { tenantId: string; userId: string };
  let invitada: string;
  let registrada: string;
  let vinculada: string;
  let sembrada: string;
  let cambio: string;
  let pendiente: string;
  let suspendida: string;
  let huerfana: string;

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    const cons = await tenant('cons', 'consolidator', platform);
    norte = await tenant('norte', 'agency', cons);
    sur = await tenant('sur', 'agency', cons);

    adminNorte = await user('admin-norte');
    await member(norte, adminNorte, 'tenant_admin');

    // El superadmin que mira nació, él también, con la contraseña de un admin.
    root = await createdByAdmin('root', { role: 'admin' });
    await member(platform, root, 'superadmin');
    root2 = await user('root2');
    await member(platform, root2, 'superadmin');

    // Heredadas: de mayo a agosto no había evento; desde agosto, UserCreated; y un admin inicial.
    heredada = await createdByAdmin('heredada');
    heredadaConEvento = await createdByAdmin('con-evento', { event: true, tenantId: sur });
    sinBuzon = await createdByAdmin('sinbuzon', { mail: `${FAILS}-${sfx}@test.local` });
    inicial = await initialAdmin('inicial');

    // Aceptó una invitación: eligió su contraseña; la membership no lleva invited_by.
    invitada = await inOneTransaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, email_verified_at)
         VALUES ($1, 'hash-propio', now()) RETURNING id`,
        [email('invitada')],
      );
      const id = rows[0]!.id;
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'vendedor')`,
        [norte, id],
      );
      await c.query(
        `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at, accepted_at)
         VALUES ($1, $2, 'vendedor', $3, $4, now() + interval '7 days', now())`,
        [norte, email('invitada'), sha256(`inv-${sfx}`), adminNorte],
      );
      return id;
    });

    // Se registró sola (alta pública): su nodo y su membership sin invited_by.
    registrada = await inOneTransaction(async (c) => {
      const t = await c.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
         VALUES ($1::text, 'Agencia propia', 'CO', 'COP', 'subagency', $2) RETURNING id`,
        [slug('propia'), norte],
      );
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'hash-propio') RETURNING id`,
        [email('registrada')],
      );
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'tenant_admin')`,
        [t.rows[0]!.id, u.rows[0]!.id],
      );
      return u.rows[0]!.id;
    });

    // Ya tenía cuenta y el panel viejo la vinculó a otro nodo: la membership es de otra transacción.
    vinculada = await user('vinculada');
    await member(sur, vinculada, 'vendedor', adminNorte);

    // Del seed del superadmin: UserCreated con `source`, membership sin invited_by.
    sembrada = await inOneTransaction(async (c) => {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, email_verified_at)
         VALUES ($1, 'hash-del-seed', now()) RETURNING id`,
        [email('sembrada')],
      );
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'superadmin')`,
        [platform, u.rows[0]!.id],
      );
      await c.query(
        `INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
         VALUES ($1, NULL, 'UserCreated', 'user', $2, '{"role":"superadmin","existingUserLinked":false,"source":"seed-superadmin"}'::jsonb)`,
        [platform, u.rows[0]!.id],
      );
      return u.rows[0]!.id;
    });

    // Heredadas que ya no cuentan.
    cambio = await createdByAdmin('cambio');
    await pool.query(`UPDATE users SET password_changed_at = now() WHERE id = $1`, [cambio]);
    pendiente = await createdByAdmin('pendiente');
    await pool.query(`UPDATE users SET password_reset_required_at = now() WHERE id = $1`, [
      pendiente,
    ]);
    suspendida = await createdByAdmin('suspendida');
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspendida]);

    // Su admin creador ya no existe: invited_by quedó en NULL y no se puede reconocer.
    const creador = await user('creador');
    await member(norte, creador, 'admin');
    huerfana = await createdByAdmin('huerfana', { by: creador });
    await pool.query(`DELETE FROM users WHERE id = $1`, [creador]);
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`lp-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('el criterio: quién aparece en la lista', () => {
    it('las que nacieron con la contraseña de un admin y la conservan; ninguna otra', async () => {
      expect(await listedEmails(root)).toEqual(
        [
          email('heredada'),
          email('con-evento'),
          `${FAILS}-${sfx}@test.local`,
          email('inicial'),
        ].sort(),
      );
      // No están: invitada, registrada, vinculada, sembrada, cambio, pendiente, suspendida,
      // huérfana (su creador ya no existe) ni quien mira.
      const ids = (await listed(root)).map((u) => u.id);
      for (const id of [
        invitada,
        registrada,
        vinculada,
        sembrada,
        cambio,
        pendiente,
        suspendida,
        huerfana,
        root,
        adminNorte,
      ]) {
        expect(ids).not.toContain(id);
      }
    });

    it('quien mira no se ve a sí mismo; otro superadmin sí lo ve', async () => {
      expect(await listedEmails(root2)).toContain(email('root'));
      expect(await listedEmails(root)).not.toContain(email('root'));
    });

    it('cada una con dónde nació, quién eligió la contraseña y sus nodos activos', async () => {
      const rows = await listed(root);
      const byEmail = new Map(rows.map((u) => [u.email, u]));
      expect(byEmail.get(email('heredada'))).toMatchObject({
        id: heredada,
        name: 'Persona heredada',
        lastLoginAt: null,
        activeNodes: 1,
        origin: {
          tenantId: norte,
          tenantName: 'Agencia norte',
          createdByEmail: email('admin-norte'),
        },
      });
      expect(byEmail.get(email('inicial'))).toMatchObject({
        id: inicial.userId,
        name: null,
        origin: {
          tenantId: inicial.tenantId,
          tenantName: 'Agencia inicial',
          createdByEmail: email('root2'),
        },
      });
      // Las más recientes primero.
      const created = rows.map((u) => Date.parse(u.createdAt));
      expect([...created].sort((a, b) => b - a)).toEqual(created);
    });

    it('sólo el superadmin: un admin de red recibe 403', async () => {
      expect(await rejection(controller.list(adminNorte))).toBe('403/SUPERADMIN_REQUIRED');
    });
  });

  describe('forzar el cambio', () => {
    it('un admin de red recibe 403 y ninguna cuenta cambia', async () => {
      expect(await rejection(controller.requireReset(adminNorte, { userIds: [heredada] }))).toBe(
        '403/SUPERADMIN_REQUIRED',
      );
      expect(await state(heredada)).toMatchObject({ required: false, tokens: 0 });
      expect(mailer.sendToTenant).not.toHaveBeenCalled();
    });

    it('un resultado por cuenta: el cambio de USR-3, su rastro y el del lote; el correo que no sale, dicho', async () => {
      await liveSession(heredada, norte);
      await liveSession(heredada, norte);

      const out = await controller.requireReset(root, {
        userIds: [heredada, sinBuzon, heredadaConEvento, pendiente, cambio, invitada, root],
      });

      expect(out.results).toEqual([
        { userId: heredada, status: 'sent', revokedSessions: 2 },
        { userId: sinBuzon, status: 'email_failed', revokedSessions: 0 },
        { userId: heredadaConEvento, status: 'sent', revokedSessions: 0 },
        { userId: pendiente, status: 'skipped', reason: 'already_required' },
        { userId: cambio, status: 'skipped', reason: 'password_changed' },
        { userId: invitada, status: 'skipped', reason: 'not_candidate' },
        { userId: root, status: 'skipped', reason: 'self' },
      ]);
      expect(out.counts).toEqual({ sent: 2, emailFailed: 1, skipped: 4, failed: 0 });

      // Lo mismo que forzar desde Equipo: marcada, sin sesiones vivas, un solo enlace sin usar.
      for (const id of [heredada, sinBuzon, heredadaConEvento]) {
        expect(await state(id)).toMatchObject({
          required: true,
          hash: 'hash-elegido-por-el-admin',
          live_sessions: 0,
          tokens: 1,
          unused: 1,
        });
      }
      // Las omitidas no se tocaron.
      expect(await state(invitada)).toMatchObject({ required: false, tokens: 0 });
      expect(await state(cambio)).toMatchObject({ required: false, tokens: 0 });

      // El correo "legacy", por su nodo, con su propio enlace (el único que vale).
      expect(mailer.sendToTenant).toHaveBeenCalledTimes(3);
      expect(mailer.sendToTenant).toHaveBeenCalledWith(
        norte,
        expect.objectContaining({
          to: email('heredada'),
          subject: 'Elige una contraseña nueva · PlaneTour',
          text: expect.stringContaining(
            'Tu cuenta en Agencia norte se creó con una contraseña que eligió un administrador.',
          ) as unknown,
        }),
      );
      const { rows: hashes } = await pool.query<{ token_hash: string }>(
        `SELECT token_hash FROM password_reset_tokens WHERE user_id = $1`,
        [heredada],
      );
      expect(hashes[0]!.token_hash).toBe(sha256(mailedToken(email('heredada'))));
      expect(JSON.stringify(out)).not.toContain(mailedToken(email('heredada')));

      // El rastro de cada una, en su nodo, con el lote; el del correo que no salió.
      const [forced] = await events('auth.password_reset.required_by_admin', heredada);
      expect(forced).toMatchObject({
        actor_user_id: root,
        tenant_id: norte,
        payload: { targetUserId: heredada, revokedSessions: 2, bulk: true },
      });
      const batchId = forced!.payload['batchId'] as string;
      const [conEvento] = await events('auth.password_reset.required_by_admin', heredadaConEvento);
      expect(conEvento).toMatchObject({ tenant_id: sur, payload: { batchId } });
      expect(await events('auth.password_reset.email_failed', sinBuzon)).toMatchObject([
        { tenant_id: norte, payload: { targetUserId: sinBuzon, via: 'legacy', batchId } },
      ]);
      expect(await batchEvents(batchId)).toEqual([
        {
          actor_user_id: root,
          tenant_id: platform,
          payload: {
            batchId,
            requested: 7,
            sent: 2,
            emailFailed: 1,
            skipped: 4,
            failed: 0,
          },
        },
      ]);

      // Ya no son heredadas: salen de la lista.
      const after = await listedEmails(root);
      expect(after).not.toContain(email('heredada'));
      expect(after).not.toContain(email('con-evento'));
      expect(after).toContain(email('inicial'));
    });

    it('volver a correrlo no le escribe a nadie de nuevo', async () => {
      const before = await state(heredada);

      const out = await controller.requireReset(root, {
        userIds: [heredada, sinBuzon, heredadaConEvento],
      });

      expect(out.results.map((r) => r.status === 'skipped' && r.reason)).toEqual([
        'already_required',
        'already_required',
        'already_required',
      ]);
      expect(mailer.sendToTenant).not.toHaveBeenCalled();
      expect(await state(heredada)).toEqual(before);
      expect(await events('auth.password_reset.required_by_admin', heredada)).toHaveLength(1);
    });

    it('con el enlace, la persona elige su contraseña y deja de estar obligada', async () => {
      await controller.requireReset(root2, { userIds: [inicial.userId] });
      const token = mailedToken(email('inicial'));
      await resets.reset(token, 'una-contraseña-nueva-y-larga');
      expect(await state(inicial.userId)).toMatchObject({
        required: false,
        hash: 'hash-de-prueba-28',
        unused: 0,
      });
      // Ya no es heredada: eligió la suya.
      expect(await listedEmails(root2)).not.toContain(email('inicial'));
      const again = await controller.requireReset(root2, { userIds: [inicial.userId] });
      expect(again.results).toEqual([
        { userId: inicial.userId, status: 'skipped', reason: 'password_changed' },
      ]);
    });
  });

  describe('el 2FA de los últimos 10 minutos, con el reloj de la base', () => {
    const guard = new RecentMfaGuard(new Reflector());
    const proto = LegacyPasswordsController.prototype as unknown as Record<
      'requireReset',
      (...args: never[]) => unknown
    >;

    async function contextOf(minutesAgo: number): Promise<RequestContext> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, tenant_id, expires_at, last_seen_at, mfa_verified_at)
         VALUES ($1, $2, now() + interval '8 hours', now(), now() - make_interval(mins => $3))
         RETURNING id`,
        [root2, platform, minutesAgo],
      );
      const v = await sessions.validate({
        sessionId: rows[0]!.id,
        userId: root2,
        tenantId: platform,
      });
      if (!v.ok) throw new Error(`sesión inválida: ${v.reason}`);
      return {
        userId: root2,
        role: v.role,
        mfaRequired: v.mfaRequired,
        mfaEnabled: v.mfaEnabled,
        mfaVerified: v.mfaVerified,
        ...(v.mfaVerifiedAt ? { mfaVerifiedAt: v.mfaVerifiedAt } : {}),
      };
    }

    function check(ctx: RequestContext): unknown {
      return requestContextStorage.run(ctx, () => {
        try {
          return guard.canActivate({
            getHandler: () => proto.requireReset,
            getClass: () => LegacyPasswordsController,
          } as unknown as ExecutionContext);
        } catch (err) {
          return err;
        }
      });
    }

    it('con el código de hace 30 minutos se pide de nuevo; con el de hace 2, pasa', async () => {
      expect(check(await contextOf(30))).toBeInstanceOf(MfaRecentRequiredError);
      expect(check(await contextOf(2))).toBe(true);
    });
  });
});
