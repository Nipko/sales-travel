import { createHash, randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { MemberSupportService } from './member-support.service.js';

/**
 * Enviarle a un miembro el enlace para restablecer su contraseña y desbloquearle la cuenta, contra
 * Postgres:
 *
 *   - el enlace y su evento quedan en la misma transacción (si el evento no entra, tampoco el enlace
 *     ni la invalidación de los anteriores), y el token en claro sólo viaja en el correo;
 *   - el enlace del correo es el único que sirve: los anteriores quedan usados y la persona elige su
 *     contraseña con él;
 *   - 409 si la cuenta o su acceso al nodo están suspendidos, 429 con 3 enlaces en 15 minutos;
 *   - desbloquear limpia `locked_until` y el contador sin tocar contraseña ni 2FA, y sólo audita
 *     cuando había un bloqueo vigente.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Cuelga todo de la raíz `platform` compartida. Se SALTA sin PGHOST.
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

/** Una auditoría cuyo evento de "enlace enviado" no entra: para ver que el enlace se deshace con él. */
class AuditoriaQueFalla extends AuditService {
  override async emitWithin(trx: Transaction<DB>, event: AuditEvent): Promise<void> {
    if (event.eventType === 'auth.password_reset.sent_by_admin') {
      throw new Error('el evento no entró');
    }
    return super.emitWithin(trx, event);
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

d('enlace para restablecer la contraseña y desbloqueo desde Equipo, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');

  const mailer = {
    sendToTenant: vi.fn((_tenantId: string | null, _mail: { to: string; text: string }) =>
      Promise.resolve(true),
    ),
  };
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
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
  const support = new MemberSupportService(database, network, audit, resets, notices);

  let agency: string;
  let admin: string;

  const slug = (label: string) => `msup-${label}-${sfx}`;
  const email = (label: string) => `msup-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: 'consolidator' | 'agency', parent: string) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [slug(label), `Agencia ${label}`, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(label: string, status = 'active'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, status, mfa_enabled_at)
       VALUES ($1, 'hash-original', $2, now()) RETURNING id`,
      [email(label), status],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: Role, status = 'active') {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  async function seller(label: string): Promise<string> {
    const id = await user(label);
    await member(agency, id, 'vendedor');
    return id;
  }

  async function tokens(userId: string) {
    const { rows } = await pool.query<{
      token_hash: string;
      used: boolean;
      created_at: Date;
      ttl_minutes: number;
    }>(
      `SELECT token_hash, used_at IS NOT NULL AS used, created_at,
              round(extract(epoch FROM expires_at - created_at) / 60)::int AS ttl_minutes
         FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows;
  }

  async function events(type: string, aggregateId: string) {
    const { rows } = await pool.query<{
      actor_user_id: string | null;
      tenant_id: string | null;
      occurred_at: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, tenant_id, occurred_at, payload FROM domain_events
        WHERE event_type = $1 AND aggregate_id = $2 ORDER BY occurred_at`,
      [type, aggregateId],
    );
    return rows;
  }

  /** El token en claro del último correo enviado. */
  function lastMailedToken(): string {
    const call = mailer.sendToTenant.mock.calls.at(-1);
    if (call === undefined) throw new Error('no salió ningún correo');
    return decodeURIComponent(/token=([^\s]+)/.exec(call[1].text)![1]!);
  }

  beforeAll(async () => {
    database.onModuleInit();
    const platform = await platformRootId(pool);
    const cons = await tenant('cons', 'consolidator', platform);
    agency = await tenant('norte', 'agency', cons);
    admin = await user('admin');
    await member(agency, admin, 'tenant_admin');
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
    mailer.sendToTenant.mockImplementation(() => Promise.resolve(true));
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`msup-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('enviar el enlace para restablecer la contraseña', () => {
    it('el enlace y su evento quedan en la misma transacción; la respuesta no trae el token', async () => {
      const target = await seller('ana');

      const res = await support.sendPasswordReset(admin, agency, target);

      expect(res.sent).toBe(true);
      expect(Object.keys(res).sort()).toEqual(['expiresAt', 'sent']);
      const [row] = await tokens(target);
      expect(row).toBeDefined();
      expect(row!.used).toBe(false);
      expect(row!.ttl_minutes).toBe(60);

      const token = lastMailedToken();
      expect(row!.token_hash).toBe(sha256(token));
      expect(JSON.stringify(res)).not.toContain(token);
      expect(mailer.sendToTenant).toHaveBeenCalledWith(
        agency,
        expect.objectContaining({
          to: email('ana'),
          text: expect.stringContaining(
            'Un administrador de Agencia norte te envió este enlace',
          ) as unknown,
        }),
      );

      const [event] = await events('auth.password_reset.sent_by_admin', target);
      expect(event).toMatchObject({
        actor_user_id: admin,
        tenant_id: agency,
        payload: { targetUserId: target, expiresAt: res.expiresAt },
      });
      // now() es el inicio de la transacción: el mismo instante prueba que fue la misma.
      expect(event!.occurred_at.getTime()).toBe(row!.created_at.getTime());
      expect(JSON.stringify(event!.payload)).not.toContain(token);
    });

    it('si el evento no entra, no queda el enlace ni se invalidan los anteriores', async () => {
      const target = await seller('beto');
      await support.sendPasswordReset(admin, agency, target);
      const before = await tokens(target);
      mailer.sendToTenant.mockClear();

      const failing = new MemberSupportService(
        database,
        network,
        new AuditoriaQueFalla(database),
        resets,
        notices,
      );
      await expect(failing.sendPasswordReset(admin, agency, target)).rejects.toThrow(
        'el evento no entró',
      );

      expect(await tokens(target)).toEqual(before);
      expect(before.every((t) => !t.used)).toBe(true);
      expect(mailer.sendToTenant).not.toHaveBeenCalled();
    });

    it('sólo vale el último enlace, y con él la persona elige su contraseña', async () => {
      const target = await seller('carla');
      await support.sendPasswordReset(admin, agency, target);
      const first = lastMailedToken();
      await support.sendPasswordReset(admin, agency, target);
      const second = lastMailedToken();

      const rows = await tokens(target);
      expect(rows.map((r) => r.used)).toEqual([true, false]);

      await expect(resets.reset(first, 'una-contraseña-nueva-larga')).rejects.toThrow(
        /inválido o venció/,
      );
      expect(await resets.reset(second, 'una-contraseña-nueva-larga')).toEqual({ ok: true });
      const { rows: users } = await pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [target],
      );
      expect(users[0]!.password_hash).toBe('hash-de-prueba-26');
    });

    it('si el correo no sale: sent:false, el enlace existe y el fallo queda auditado', async () => {
      const target = await seller('dario');
      mailer.sendToTenant.mockImplementation(() => Promise.resolve(false));

      const res = await support.sendPasswordReset(admin, agency, target);

      expect(res.sent).toBe(false);
      expect(await tokens(target)).toHaveLength(1);
      expect(await events('auth.password_reset.email_failed', target)).toEqual([
        expect.objectContaining({
          actor_user_id: admin,
          tenant_id: agency,
          payload: { targetUserId: target, via: 'admin' },
        }),
      ]);
    });

    it('cuenta suspendida en la plataforma o acceso al nodo suspendido: 409, sin enlace', async () => {
      const suspendedAccount = await user('eva', 'suspended');
      await member(agency, suspendedAccount, 'vendedor');
      const suspendedHere = await user('fede');
      await member(agency, suspendedHere, 'vendedor', 'suspended');

      expect(await rejection(support.sendPasswordReset(admin, agency, suspendedAccount))).toBe(
        '409/MEMBER_ACCOUNT_SUSPENDED',
      );
      expect(await rejection(support.sendPasswordReset(admin, agency, suspendedHere))).toBe(
        '409/MEMBERSHIP_SUSPENDED',
      );
      expect(await tokens(suspendedAccount)).toEqual([]);
      expect(await tokens(suspendedHere)).toEqual([]);
      expect(mailer.sendToTenant).not.toHaveBeenCalled();
    });

    it('con 3 enlaces en 15 minutos (los pedidos por la persona cuentan) el cuarto es 429', async () => {
      const target = await seller('gabi');
      await resets.issueToken(database.db, target, { invalidatePrevious: false });
      await support.sendPasswordReset(admin, agency, target);
      await support.sendPasswordReset(admin, agency, target);
      mailer.sendToTenant.mockClear();

      expect(await rejection(support.sendPasswordReset(admin, agency, target))).toBe(
        '429/PASSWORD_RESET_RATE_LIMITED',
      );
      expect(await tokens(target)).toHaveLength(3);
      expect(mailer.sendToTenant).not.toHaveBeenCalled();

      // Los de hace más de 15 minutos ya no cuentan.
      await pool.query(
        `UPDATE password_reset_tokens SET created_at = now() - interval '16 minutes'
          WHERE user_id = $1`,
        [target],
      );
      expect((await support.sendPasswordReset(admin, agency, target)).sent).toBe(true);
    });

    it('a un par o a alguien de otra red no: la autorización es la de restablecer el 2FA', async () => {
      const peer = await user('par');
      await member(agency, peer, 'tenant_admin');

      expect(await rejection(support.sendPasswordReset(admin, agency, peer))).toBe(
        '403/ROLE_NOT_GRANTABLE',
      );
      expect(await rejection(support.sendPasswordReset(admin, agency, admin))).toBe(
        '403/MEMBER_SELF_ACTION',
      );
      expect(await tokens(peer)).toEqual([]);
    });
  });

  describe('enviar el enlace a alguien con un rol de admin (USR-13)', () => {
    /** El admin con 2FA activo que lo pasó hace `minutes` minutos, como lo deja el middleware. */
    const asAdmin = <T>(minutes: number, fn: () => Promise<T>) =>
      requestContextStorage.run(
        {
          userId: admin,
          mfaEnabled: true,
          mfaVerified: true,
          mfaVerifiedAt: new Date(Date.now() - minutes * 60_000),
        },
        fn,
      );

    it('pide el 2FA de los últimos 10 minutos: sin él no deja ningún enlace', async () => {
      const manager = await user('manager');
      await member(agency, manager, 'admin');

      expect(
        await rejection(asAdmin(15, () => support.sendPasswordReset(admin, agency, manager))),
      ).toBe('403/MFA_RECENT_REQUIRED');
      expect(await tokens(manager)).toEqual([]);
      expect(mailer.sendToTenant).not.toHaveBeenCalled();

      expect((await asAdmin(2, () => support.sendPasswordReset(admin, agency, manager))).sent).toBe(
        true,
      );
      expect(await tokens(manager)).toHaveLength(1);
    });

    it('a un vendedor no: es el soporte de todos los días', async () => {
      const target = await seller('sin-reconfirmar');
      expect((await asAdmin(60, () => support.sendPasswordReset(admin, agency, target))).sent).toBe(
        true,
      );
    });
  });

  describe('desbloquear la cuenta', () => {
    async function account(userId: string) {
      const { rows } = await pool.query<{
        locked_until: Date | null;
        failed_login_attempts: number;
        password_hash: string;
        has_mfa: boolean;
        status: string;
      }>(
        `SELECT locked_until, failed_login_attempts, password_hash,
                mfa_enabled_at IS NOT NULL AS has_mfa, status
           FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0]!;
    }

    it('con un bloqueo vigente lo levanta y lo audita, sin tocar contraseña ni 2FA', async () => {
      const target = await seller('hugo');
      const { rows } = await pool.query<{ locked_until: Date }>(
        `UPDATE users SET locked_until = now() + interval '10 minutes', failed_login_attempts = 2
          WHERE id = $1 RETURNING locked_until`,
        [target],
      );
      const lockedUntil = rows[0]!.locked_until;

      expect(await support.unlock(admin, agency, target)).toEqual({ unlocked: true });

      expect(await account(target)).toEqual({
        locked_until: null,
        failed_login_attempts: 0,
        password_hash: 'hash-original',
        has_mfa: true,
        status: 'active',
      });
      expect(await events('auth.lockout.cleared_by_admin', target)).toEqual([
        expect.objectContaining({
          actor_user_id: admin,
          tenant_id: agency,
          payload: { targetUserId: target, lockedUntil: lockedUntil.toISOString() },
        }),
      ]);

      // Otra vez: ya no estaba bloqueado, y no se audita de nuevo.
      expect(await support.unlock(admin, agency, target)).toEqual({ unlocked: false });
      expect(await events('auth.lockout.cleared_by_admin', target)).toHaveLength(1);
    });

    it('con un bloqueo vencido no cambia nada: unlocked:false', async () => {
      const target = await seller('ines');
      await pool.query(
        `UPDATE users SET locked_until = now() - interval '1 minute', failed_login_attempts = 3
          WHERE id = $1`,
        [target],
      );

      expect(await support.unlock(admin, agency, target)).toEqual({ unlocked: false });
      const after = await account(target);
      expect(after.locked_until).not.toBeNull();
      expect(after.failed_login_attempts).toBe(3);
      expect(await events('auth.lockout.cleared_by_admin', target)).toEqual([]);
    });
  });
});
