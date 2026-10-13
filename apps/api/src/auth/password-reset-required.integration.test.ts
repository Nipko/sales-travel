import { createHash, randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import { MemberSupportService } from '../tenants/member-support.service.js';
import { AuthService, type AuthResult, type LoginResult } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { PgSeatRepository } from './seat.repository.js';
import { SeatService } from './seat.service.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

/**
 * Forzar el cambio de contraseña (0062) de punta a punta, contra Postgres y con TODA consulta de la
 * API como `app_user` (NOBYPASSRLS):
 *
 *   - el admin lo fuerza desde Equipo: marca, sesiones cerradas, un solo enlace vigente y su evento;
 *   - el login con la contraseña vieja (correcta) responde 403 sin sesión, sin puesto y sin sumar al
 *     bloqueo; con 2FA, sin desafío; suspendida, el 401 de siempre;
 *   - intentar entrar reenvía el enlace sólo si no hay uno de los últimos 10 minutos;
 *   - el canje del enlace (el del admin o el de "Olvidé mi contraseña") levanta la marca y el login
 *     con la contraseña nueva entra;
 *   - mientras la marca está, ninguna sesión vale, aunque se haya emitido después de cerrarlas;
 *   - user_admin_overview devuelve la columna nueva.
 *
 * Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const PASSWORD = 'contraseña-vieja-de-prueba';
const NEW_PASSWORD = 'contraseña-nueva-de-prueba';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

d('forzar el cambio de contraseña, contra Postgres como app_user', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();
  const comoApp = new pg.Pool({ max: 8 });
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });

  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const password = new PasswordService();
  const jwt = new JwtService();
  const audit = new AuditService(database);
  const sessions = new SessionService(database, audit);
  const network = new NetworkService(database);
  const seats = new SeatService(new PgSeatRepository(database), audit, network, jwt);
  const attempts = new LoginAttemptsService(database);
  const mailer = {
    sendToTenant: vi.fn(
      (_tenantId: string | null, _mail: { to: string; subject: string; text: string }) =>
        Promise.resolve(true),
    ),
  };
  const notices = { notify: vi.fn() } as unknown as SecurityNoticeService;
  const resets = new PasswordResetService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
    sessions,
    notices,
  );
  const auth = new AuthService(
    database,
    jwt,
    password,
    audit,
    mailer as unknown as MailerService,
    sessions,
    new MfaService(database, new TotpService(), password, audit, attempts),
    seats,
    new MfaChallengeService(database, attempts),
    new TrustedDeviceService(database),
    attempts,
    resets,
  );
  const support = new MemberSupportService(database, network, audit, resets, notices);

  let agency: string;
  let adminId: string;
  let passwordHash: string;
  const created: string[] = [];

  const email = (label: string) => `prr-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: 'consolidator' | 'agency', parent: string) {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [`prr-${label}-${sfx}`, `Agencia ${label}`, type, parent],
    );
    created.unshift(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, role: string, opts: { mfa?: boolean } = {}) {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, status, mfa_enabled_at)
       VALUES ($1, $2, $3, 'active', CASE WHEN $4 THEN now() END) RETURNING id`,
      [email(label), `Persona ${label}`, passwordHash, opts.mfa === true],
    );
    const id = rows[0]!.id;
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [agency, id, role],
    );
    return id;
  }

  function session(result: LoginResult): AuthResult {
    expect('token' in result).toBe(true);
    return result as AuthResult;
  }

  async function validate(token: string) {
    const { jti, sub, iat } = await jwt.verify(token);
    return sessions.validate({
      sessionId: jti!,
      userId: sub,
      tenantId: agency,
      tokenIssuedAt: iat ? new Date(iat * 1000) : undefined,
    });
  }

  async function account(userId: string) {
    const { rows } = await admin.query<{
      required: boolean;
      failed: number;
      live_sessions: number;
      challenges: number;
    }>(
      `SELECT u.password_reset_required_at IS NOT NULL AS required,
              u.failed_login_attempts AS failed,
              (SELECT count(*)::int FROM sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS live_sessions,
              (SELECT count(*)::int FROM mfa_challenges c WHERE c.user_id = u.id) AS challenges
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    return rows[0]!;
  }

  async function tokens(userId: string) {
    const { rows } = await admin.query<{ token_hash: string; used: boolean }>(
      `SELECT token_hash, used_at IS NOT NULL AS used
         FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows;
  }

  async function events(type: string, aggregateId: string) {
    const { rows } = await admin.query<{
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

  /** El token en claro del último correo enviado. */
  function lastMailedToken(): string {
    const call = mailer.sendToTenant.mock.calls.at(-1);
    if (call === undefined) throw new Error('no salió ningún correo');
    return decodeURIComponent(/token=([^\s]+)/.exec(call[1].text)![1]!);
  }

  /** Hace como si los enlaces del usuario se hubieran emitido hace `minutes` minutos. */
  async function ageTokens(userId: string, minutes: number) {
    await admin.query(
      `UPDATE password_reset_tokens
          SET created_at = created_at - make_interval(mins => $2),
              expires_at = expires_at - make_interval(mins => $2)
        WHERE user_id = $1`,
      [userId, minutes],
    );
  }

  beforeAll(async () => {
    process.env['JWT_SECRET'] ??= randomBytes(32).toString('hex');
    jwt.onModuleInit();
    passwordHash = await password.hash(PASSWORD);
    const platform = await platformRootId(admin);
    const cons = await tenant('cons', 'consolidator', platform);
    agency = await tenant('norte', 'agency', cons);
    adminId = await user('admin', 'tenant_admin');
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
    mailer.sendToTenant.mockImplementation(() => Promise.resolve(true));
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    for (const id of created) await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
    await database.db.destroy();
    await admin.end();
  });

  it('forzar → login 403 → canjear el enlace → login con la nueva entra', async () => {
    const ana = await user('ana', 'vendedor');
    const before = session(await auth.login({ email: email('ana'), password: PASSWORD }));
    expect(await validate(before.token)).toMatchObject({ ok: true });

    const res = await support.requirePasswordReset(adminId, agency, ana);

    expect(res).toEqual({ sent: true, revokedSessions: 1 });
    expect(await validate(before.token)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    expect(await account(ana)).toMatchObject({ required: true, live_sessions: 0 });
    const mailed = lastMailedToken();
    const [only] = await tokens(ana);
    expect(only).toEqual({ token_hash: sha256(mailed), used: false });
    expect(mailer.sendToTenant).toHaveBeenCalledWith(
      agency,
      expect.objectContaining({
        to: email('ana'),
        subject: 'Elige una contraseña nueva · PlaneTour',
        text: expect.stringContaining('Un administrador de Agencia norte te pidió') as unknown,
      }),
    );
    expect(await events('auth.password_reset.required_by_admin', ana)).toEqual([
      {
        actor_user_id: adminId,
        tenant_id: agency,
        payload: { targetUserId: ana, revokedSessions: 1 },
      },
    ]);

    // La contraseña vieja es correcta, pero no abre sesión ni cuenta como fallo. El enlace es de
    // hace segundos: no sale otro correo.
    mailer.sendToTenant.mockClear();
    expect(await rejection(auth.login({ email: email('ana'), password: PASSWORD }))).toBe(
      '403/PASSWORD_RESET_REQUIRED',
    );
    expect(await account(ana)).toMatchObject({ required: true, failed: 0, live_sessions: 0 });
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
    expect(await events('auth.login.password_reset_required', ana)).toEqual([
      expect.objectContaining({ actor_user_id: ana, payload: { linkSent: false } }),
    ]);

    await resets.reset(mailed, NEW_PASSWORD);
    expect(await account(ana)).toMatchObject({ required: false });

    expect(await rejection(auth.login({ email: email('ana'), password: PASSWORD }))).toBe('401/?');
    const after = session(await auth.login({ email: email('ana'), password: NEW_PASSWORD }));
    expect(await validate(after.token)).toMatchObject({ ok: true, role: 'vendedor' });
  });

  it('intentar entrar reenvía el enlace sólo si el último tiene más de 10 minutos', async () => {
    const beto = await user('beto', 'vendedor');
    await support.requirePasswordReset(adminId, agency, beto);
    const first = lastMailedToken();

    await ageTokens(beto, 11);
    mailer.sendToTenant.mockClear();
    expect(await rejection(auth.login({ email: email('beto'), password: PASSWORD }))).toBe(
      '403/PASSWORD_RESET_REQUIRED',
    );
    expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    expect(mailer.sendToTenant).toHaveBeenCalledWith(
      agency,
      expect.objectContaining({ subject: 'Elige una contraseña nueva · PlaneTour' }),
    );
    const second = lastMailedToken();
    expect(second).not.toBe(first);

    // Repetir el login no llena el buzón.
    for (let i = 0; i < 3; i++) {
      expect(await rejection(auth.login({ email: email('beto'), password: PASSWORD }))).toBe(
        '403/PASSWORD_RESET_REQUIRED',
      );
    }
    expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    expect(
      (await events('auth.login.password_reset_required', beto)).map((e) => e.payload),
    ).toEqual([{ linkSent: true }, { linkSent: false }, { linkSent: false }, { linkSent: false }]);

    // Reenviar no invalida el anterior (puede ser el que la persona tiene a mano): los dos sirven
    // hasta que uno se canjea.
    expect(await tokens(beto)).toHaveLength(2);
    await resets.reset(second, NEW_PASSWORD);
    expect(await account(beto)).toMatchObject({ required: false });
  });

  it('con 2FA nunca llega al desafío; suspendida, el 401 de siempre', async () => {
    const caro = await user('caro', 'vendedor', { mfa: true });
    await support.requirePasswordReset(adminId, agency, caro);

    expect(
      await rejection(
        auth.login({
          email: email('caro'),
          password: PASSWORD,
          trustedDeviceToken: 'x'.repeat(43),
        }),
      ),
    ).toBe('403/PASSWORD_RESET_REQUIRED');
    expect(await account(caro)).toMatchObject({ challenges: 0, live_sessions: 0 });

    await admin.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [caro]);
    expect(await rejection(auth.login({ email: email('caro'), password: PASSWORD }))).toBe('401/?');
  });

  it('mientras la marca está, ninguna sesión vale, aunque se haya emitido después', async () => {
    const dani = await user('dani', 'vendedor');
    await support.requirePasswordReset(adminId, agency, dani);

    // Un login que pasó la contraseña justo antes de la marca y emite su sesión después.
    const late = await seats.issue({
      userId: dani,
      tenantId: agency,
      mfaVerified: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(
      await sessions.validate({ sessionId: late.sessionId, userId: dani, tenantId: agency }),
    ).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
  });

  it('"Olvidé mi contraseña" también levanta la marca', async () => {
    const eli = await user('eli', 'vendedor');
    await support.requirePasswordReset(adminId, agency, eli);

    mailer.sendToTenant.mockClear();
    await resets.request(email('eli'));
    // Sale por el correo de su nodo: la membership se lee con su id en el contexto.
    expect(mailer.sendToTenant).toHaveBeenCalledWith(agency, expect.anything());
    await resets.reset(lastMailedToken(), NEW_PASSWORD);

    expect(await account(eli)).toMatchObject({ required: false });
    session(await auth.login({ email: email('eli'), password: NEW_PASSWORD }));
  });

  it('con el cambio forzado, la misma contraseña de antes no sirve y el enlace sigue vigente', async () => {
    const iris = await user('iris', 'vendedor');
    await support.requirePasswordReset(adminId, agency, iris);
    const link = lastMailedToken();

    expect(await rejection(resets.reset(link, PASSWORD))).toBe('400/PASSWORD_REUSED');
    expect(await account(iris)).toMatchObject({ required: true });
    expect(await tokens(iris)).toEqual([{ token_hash: sha256(link), used: false }]);
    expect(await rejection(auth.login({ email: email('iris'), password: PASSWORD }))).toBe(
      '403/PASSWORD_RESET_REQUIRED',
    );

    await resets.reset(link, NEW_PASSWORD);
    expect(await account(iris)).toMatchObject({ required: false });
    session(await auth.login({ email: email('iris'), password: NEW_PASSWORD }));
  });

  it('canjear el enlace mientras otro lo fuerza no se traba: la fila del usuario va primero', async () => {
    const juan = await user('juan', 'vendedor');
    await resets.request(email('juan'));
    const link = lastMailedToken();

    // Lo que hace forzar el cambio (y enviar el enlace desde Equipo): primero toma la fila del
    // usuario y después da por usados sus enlaces.
    const forcing = await admin.connect();
    try {
      await forcing.query('BEGIN');
      await forcing.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [juan]);

      // `rejection` relanza lo que no es un error HTTP (un deadlock, por ejemplo): queda en `err`.
      const redeem = rejection(resets.reset(link, NEW_PASSWORD)).then(
        (outcome) => ({ outcome }),
        (err: unknown) => ({ err }),
      );
      // El canje queda esperando la fila del usuario...
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()
              AND query ILIKE '%"users"%'`,
        );
        if (rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      // ...sin haber tomado su enlace: si lo hubiera tomado antes, esto sería un deadlock y uno de
      // los dos terminaría con error.
      await forcing.query(
        `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
        [juan],
      );
      await forcing.query('COMMIT');

      // El enlace quedó sin efecto antes del canje: el 400 de siempre, no un error de la base.
      expect(await redeem).toEqual({ outcome: '400/?' });
    } finally {
      forcing.release();
    }
    // La contraseña no cambió.
    session(await auth.login({ email: email('juan'), password: PASSWORD }));
  });

  it('volver a forzarlo con 3 enlaces recientes es 429; la primera vez, nunca', async () => {
    const fede = await user('fede', 'vendedor');
    for (let i = 0; i < 3; i++) await resets.request(email('fede'));

    // Tres enlaces pedidos por ella (o por quien conoce su correo) no impiden cortarle el acceso.
    expect(await support.requirePasswordReset(adminId, agency, fede)).toMatchObject({
      sent: true,
    });
    expect(await rejection(support.requirePasswordReset(adminId, agency, fede))).toBe(
      '429/PASSWORD_RESET_RATE_LIMITED',
    );
  });

  it('user_admin_overview dice quién tiene el cambio pendiente', async () => {
    const gabi = await user('gabi', 'vendedor');
    const overview = async () => {
      // Como app_user, el rol de la API: la función conserva su GRANT al recrearla.
      const { rows } = await comoApp.query<{ user_id: string; password_reset_required: boolean }>(
        `SELECT user_id, password_reset_required FROM user_admin_overview($1::uuid)`,
        [agency],
      );
      return new Map(rows.map((r) => [r.user_id, r.password_reset_required]));
    };

    expect((await overview()).get(gabi)).toBe(false);
    await support.requirePasswordReset(adminId, agency, gabi);
    expect((await overview()).get(gabi)).toBe(true);

    const team = await network.listTenantUsers(adminId, agency);
    expect(team.find((m) => m.userId === gabi)).toMatchObject({ passwordResetRequired: true });
    expect(team.find((m) => m.userId === adminId)).toMatchObject({ passwordResetRequired: false });
  });
});
