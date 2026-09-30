import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { NetworkService } from '../network/network.service.js';
import { SeatReleaseExpiredError, SeatsFullError } from './auth-errors.js';
import { AuthService, type AuthResult, type LoginResult } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { LOCKOUT_THRESHOLD, LoginAttemptsService } from './login-attempts.service.js';
import { MFA_MAX_ATTEMPTS, MfaChallengeService } from './mfa-challenge.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { PgSeatRepository } from './seat.repository.js';
import { SeatService } from './seat.service.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

/**
 * Puestos simultáneos, una sesión por usuario, inactividad, liberar un puesto al entrar, equipos de
 * confianza y el desafío MFA con estado, contra Postgres y con TODA consulta de la API como
 * `app_user` (NOBYPASSRLS): `sessions`, `trusted_devices` y `mfa_challenges` tienen RLS por usuario
 * y las funciones de 0055 son SECURITY DEFINER. Se SALTA sin PGHOST.
 *
 * Red: plataforma → consolidador (2 puestos, 15 min) → agencia (hereda los dos); y un consolidador
 * sin cupo para lo que no es de puestos.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const PASSWORD = 'contraseña-de-prueba-puestos';

d('auth premium contra Postgres, como app_user', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();
  const comoApp = new pg.Pool({ max: 12 });
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });

  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const password = new PasswordService();
  const jwt = new JwtService();
  const audit = new AuditService(database);
  const sessions = new SessionService(database, audit);
  const seats = new SeatService(
    new PgSeatRepository(database),
    audit,
    new NetworkService(database),
    jwt,
  );
  const attempts = new LoginAttemptsService(database);
  const challenges = new MfaChallengeService(database, attempts);
  const trusted = new TrustedDeviceService(database);
  const mfa = new MfaService(database, new TotpService(), password, audit, attempts);
  const mailer = { sendToTenant: () => Promise.resolve() } as unknown as MailerService;
  const auth = new AuthService(
    database,
    jwt,
    password,
    audit,
    mailer,
    sessions,
    mfa,
    seats,
    challenges,
    trusted,
    attempts,
  );
  const reset = new PasswordResetService(database, password, mailer, audit, sessions);

  let platform: string;
  let cons: string;
  let agency: string;
  let free: string;
  const created: string[] = [];
  let passwordHash: string;

  async function tenant(
    label: string,
    type: 'consolidator' | 'agency',
    parent: string,
    config: { seats?: number; idle?: number } = {},
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type,
                            parent_tenant_id, concurrent_seats, idle_timeout_minutes)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4, $5, $6) RETURNING id`,
      [
        `ap-${label}-${sfx}`,
        `Nodo ${label}`,
        type,
        parent,
        config.seats ?? null,
        config.idle ?? null,
      ],
    );
    created.unshift(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string) {
    const email = `ap-${label}-${sfx}@test.local`;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
      [email, `Persona ${label}`, passwordHash],
    );
    const id = rows[0]!.id;
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, id, role],
    );
    return { id, email };
  }

  async function member(tenantId: string, userId: string, role: string): Promise<void> {
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, userId, role],
    );
  }

  /** Emite una sesión directo con SeatService: la carrera y el cupo, sin el camino del login. */
  function issueFor(userId: string, tenantId: string) {
    return seats.issue({
      userId,
      tenantId,
      mfaVerified: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
  }

  function session(result: LoginResult): AuthResult {
    expect('token' in result).toBe(true);
    return result as AuthResult;
  }

  async function sessionRow(token: string) {
    const { jti, sub, iat } = await jwt.verify(token);
    const { rows } = await admin.query<{
      id: string;
      seat_tenant_id: string | null;
      idle_timeout_seconds: number;
      revoked_reason: string | null;
      mfa_verified_at: Date | null;
    }>(
      `SELECT id, seat_tenant_id, idle_timeout_seconds, revoked_reason, mfa_verified_at
         FROM sessions WHERE id = $1`,
      [jti],
    );
    return { ...rows[0]!, userId: sub, iat: iat ? new Date(iat * 1000) : undefined };
  }

  async function validate(token: string, tenantId: string = agency) {
    const row = await sessionRow(token);
    return sessions.validate({
      sessionId: row.id,
      userId: row.userId,
      tenantId,
      tokenIssuedAt: row.iat,
    });
  }

  async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('se esperaba un rechazo');
  }

  beforeAll(async () => {
    process.env['JWT_SECRET'] ??= randomBytes(32).toString('hex');
    jwt.onModuleInit();
    passwordHash = await password.hash(PASSWORD);
    platform = await platformRootId(admin);
    cons = await tenant('cons', 'consolidator', platform, { seats: 2, idle: 15 });
    agency = await tenant('agency', 'agency', cons);
    free = await tenant('free', 'consolidator', platform);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    for (const id of created) await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
    await database.db.destroy();
    await admin.end();
  });

  describe('puestos y una sesión por usuario', () => {
    let v1: { id: string; email: string };
    let v2: { id: string; email: string };
    let first: AuthResult;

    beforeAll(async () => {
      v1 = await user('v1', agency, 'vendedor');
      v2 = await user('v2', agency, 'vendedor');
    });

    it('el login consume un puesto del cupo heredado, con la inactividad del nodo', async () => {
      first = session(await auth.login({ email: v1.email, password: PASSWORD }));
      const row = await sessionRow(first.token);
      expect(row).toMatchObject({ seat_tenant_id: cons, idle_timeout_seconds: 900 });
      expect(await validate(first.token)).toMatchObject({ ok: true, role: 'vendedor' });
    });

    it('entrar en otro equipo cierra la sesión anterior con "otro dispositivo"', async () => {
      const second = session(await auth.login({ email: v1.email, password: PASSWORD }));
      expect((await sessionRow(first.token)).revoked_reason).toBe('replaced');
      expect(await validate(first.token)).toEqual({ ok: false, reason: 'SESSION_REPLACED' });
      expect(await validate(second.token)).toMatchObject({ ok: true });
      first = second;
    });

    it('cupo lleno: 409 para quien no administra el nodo, sin lista ni permiso', async () => {
      session(await auth.login({ email: v2.email, password: PASSWORD }));
      const v3 = await user('v3', agency, 'vendedor');

      const err = await rejection(auth.login({ email: v3.email, password: PASSWORD }));

      expect(err).toBeInstanceOf(SeatsFullError);
      expect((err as SeatsFullError).publicDetails).toEqual({
        tenantName: 'Nodo cons',
        limit: 2,
        inUse: 2,
      });
      // Quedar afuera no le cierra la sesión a nadie.
      expect(await validate(first.token)).toMatchObject({ ok: true });
    });

    it('quien administra el nodo del cupo libera un puesto y entra; el permiso sirve una vez', async () => {
      const boss = await user('boss', cons, 'agency_admin');

      const err = (await rejection(
        auth.login({ email: boss.email, password: PASSWORD }),
      )) as SeatsFullError;
      const release = err.publicDetails.release;
      expect(release?.sessions.map((s) => s.email).sort()).toEqual([v1.email, v2.email].sort());
      const victim = release!.sessions.find((s) => s.email === v1.email)!;

      const result = await auth.releaseSeat(release!.token, victim.sessionId);

      expect(result).toMatchObject({ userId: boss.id, tenantId: cons });
      expect((await sessionRow(result.token)).seat_tenant_id).toBe(cons);
      expect(await validate(first.token)).toEqual({ ok: false, reason: 'SESSION_RELEASED' });
      expect(await rejection(auth.releaseSeat(release!.token, victim.sessionId))).toBeInstanceOf(
        SeatReleaseExpiredError,
      );
    });

    it('el usuario de plataforma no consume puesto aunque el cupo esté lleno', async () => {
      const root = await user('root', platform, 'superadmin');
      const issued = await seats.issue({
        userId: root.id,
        tenantId: agency,
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      expect(issued.seatTenantId).toBeNull();
    });

    it('dos ingresos por el último puesto: el advisory lock deja entrar a uno solo', async () => {
      const solo = await tenant('solo', 'consolidator', platform, { seats: 1 });
      const a = await user('race-a', solo, 'vendedor');
      const b = await user('race-b', solo, 'vendedor');
      const issue = (userId: string) =>
        seats.issue({
          userId,
          tenantId: solo,
          mfaVerified: false,
          expiresAt: new Date(Date.now() + 3600_000),
        });

      const results = await Promise.allSettled([issue(a.id), issue(b.id)]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(SeatsFullError);
    });
  });

  describe('inactividad', () => {
    it('una sesión que superó su tope se revoca con idle_timeout y libera el puesto', async () => {
      const idle = await user('idle', agency, 'vendedor');
      const issued = await seats.issue({
        userId: idle.id,
        tenantId: agency,
        mfaVerified: false,
        expiresAt: new Date(Date.now() + 3600_000),
        enforceSeatLimit: false,
      });
      // 15 min del consolidador: 16 sin actividad la pasan.
      await admin.query(
        `UPDATE sessions SET last_seen_at = now() - interval '16 minutes' WHERE id = $1`,
        [issued.sessionId],
      );

      expect(
        await sessions.validate({ sessionId: issued.sessionId, userId: idle.id, tenantId: agency }),
      ).toEqual({ ok: false, reason: 'SESSION_IDLE' });
      const { rows } = await admin.query<{ revoked_reason: string | null }>(
        'SELECT revoked_reason FROM sessions WHERE id = $1',
        [issued.sessionId],
      );
      expect(rows[0]!.revoked_reason).toBe('idle_timeout');
    });

    it('el ping pasivo valida sin contar como actividad; un request normal sí la cuenta', async () => {
      const u = await user('ping', agency, 'vendedor');
      const issued = await seats.issue({
        userId: u.id,
        tenantId: agency,
        mfaVerified: false,
        expiresAt: new Date(Date.now() + 3600_000),
        enforceSeatLimit: false,
      });
      await admin.query(
        `UPDATE sessions SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`,
        [issued.sessionId],
      );
      const lastSeen = async () =>
        (
          await admin.query<{ last_seen_at: Date }>(
            'SELECT last_seen_at FROM sessions WHERE id = $1',
            [issued.sessionId],
          )
        ).rows[0]!.last_seen_at.getTime();

      const before = await lastSeen();
      const passive = await sessions.validate({
        sessionId: issued.sessionId,
        userId: u.id,
        tenantId: agency,
        activity: 'passive',
      });
      expect(passive).toMatchObject({ ok: true, idleTimeoutSeconds: 900 });
      expect(await lastSeen()).toBe(before);

      await sessions.validate({ sessionId: issued.sessionId, userId: u.id, tenantId: agency });
      expect(await lastSeen()).toBeGreaterThan(before);
    });
  });

  describe('cambio de contraseña', () => {
    it('cierra todas las sesiones pero el dispositivo actual sigue con una nueva', async () => {
      const u = await user('pwd', free, 'vendedor');
      const current = session(await auth.login({ email: u.email, password: PASSWORD }));
      const currentRow = await sessionRow(current.token);

      await reset.change(u.id, PASSWORD, 'otra-contraseña-segura-123');
      const next = await auth.reissueAfterPasswordChange(u.id, currentRow.id);

      expect(await validate(current.token, free)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
      expect(await validate(next.token, free)).toMatchObject({ ok: true, role: 'vendedor' });
    });
  });

  describe('equipos de confianza', () => {
    it('sirven sólo a su dueño y un cambio de contraseña los invalida', async () => {
      const owner = await user('td-owner', free, 'vendedor');
      const other = await user('td-other', free, 'vendedor');
      const device = await trusted.create(owner.id, {
        ip: '190.24.8.9',
        userAgent: 'Mozilla/5.0 Firefox',
      });

      expect(await trusted.use(owner.id, device.token)).toBe(true);
      expect(await trusted.use(other.id, device.token)).toBe(false);
      expect(await trusted.list(owner.id, device.token)).toEqual([
        expect.objectContaining({ current: true, ip: '190.24.8.9' }),
      ]);

      await admin.query(`UPDATE users SET password_changed_at = now() WHERE id = $1`, [owner.id]);
      expect(await trusted.use(owner.id, device.token)).toBe(false);
      expect(await trusted.list(owner.id)).toEqual([]);
    });

    it('quitar uno es revocarlo', async () => {
      const owner = await user('td-revoke', free, 'vendedor');
      const device = await trusted.create(owner.id, {});
      const [view] = await trusted.list(owner.id);
      expect(await trusted.revoke(owner.id, view!.id)).toBe(true);
      expect(await trusted.revoke(owner.id, view!.id)).toBe(false);
      expect(await trusted.use(owner.id, device.token)).toBe(false);
    });
  });

  describe('desafío MFA con estado', () => {
    async function failedAttempts(userId: string) {
      const { rows } = await admin.query<{ failed: number; locked: boolean }>(
        `SELECT failed_login_attempts AS failed, COALESCE(locked_until > now(), false) AS locked
           FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0]!;
    }

    it('cinco intentos y un solo canje; cada intento cuenta también contra la cuenta', async () => {
      const u = await user('challenge', free, 'vendedor');
      const c = await challenges.create(u.id);
      for (let i = 1; i <= MFA_MAX_ATTEMPTS; i++) {
        expect(await challenges.reserveAttempt(u.id, c.id)).toMatchObject({
          kind: 'reserved',
          attempt: i,
          attemptsLeft: MFA_MAX_ATTEMPTS - i,
          locksAccount: i === MFA_MAX_ATTEMPTS,
        });
      }
      // Los cinco del desafío bloquearon la cuenta: el sexto ni se prueba.
      expect(await challenges.reserveAttempt(u.id, c.id)).toEqual({ kind: 'locked' });
      await attempts.clearFailures(u.id);
      expect(await challenges.reserveAttempt(u.id, c.id)).toEqual({ kind: 'unavailable' });
      // Un desafío que ya no sirve no le gasta el intento a la cuenta.
      expect(await failedAttempts(u.id)).toEqual({ failed: 0, locked: false });

      const fresh = await challenges.create(u.id);
      expect(await challenges.reserveAttempt(u.id, fresh.id)).toMatchObject({ attempt: 1 });
      expect(await challenges.consume(u.id, fresh.id, true)).toBe(true);
      expect(await challenges.consume(u.id, fresh.id, true)).toBe(false);
      expect(await challenges.reserveAttempt(u.id, fresh.id)).toEqual({ kind: 'unavailable' });
    });

    it('el desafío de otro usuario no se puede gastar, ni le cuesta un intento', async () => {
      const owner = await user('ch-owner', free, 'vendedor');
      const thief = await user('ch-thief', free, 'vendedor');
      const c = await challenges.create(owner.id);
      expect(await challenges.reserveAttempt(thief.id, c.id)).toEqual({ kind: 'unavailable' });
      expect(await failedAttempts(thief.id)).toEqual({ failed: 0, locked: false });
    });

    it('muchos desafíos en paralelo: 5 intentos por ventana de bloqueo, no 5 por desafío', async () => {
      const u = await user('ch-burst', free, 'vendedor');
      const created = await Promise.all(Array.from({ length: 4 }, () => challenges.create(u.id)));

      const burst = await Promise.all(
        created.flatMap((c) =>
          Array.from({ length: MFA_MAX_ATTEMPTS }, () => challenges.reserveAttempt(u.id, c.id)),
        ),
      );

      expect(burst.filter((r) => r.kind === 'reserved')).toHaveLength(LOCKOUT_THRESHOLD);
      expect(burst.filter((r) => r.kind === 'locked')).toHaveLength(
        MFA_MAX_ATTEMPTS * created.length - LOCKOUT_THRESHOLD,
      );
      expect(await failedAttempts(u.id)).toMatchObject({ locked: true });
    });
  });

  describe('una sesión por usuario, sin carreras', () => {
    async function liveSessions(userId: string): Promise<number> {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [userId],
      );
      return rows[0]!.n;
    }

    it('ingresos simultáneos en un nodo sin cupo dejan una sola sesión viva', async () => {
      const u = await user('race-free', free, 'vendedor');
      await Promise.all([issueFor(u.id, free), issueFor(u.id, free), issueFor(u.id, free)]);
      expect(await liveSessions(u.id)).toBe(1);
    });

    it('y en nodos de cupos distintos también: no ocupa un puesto en cada uno', async () => {
      const other = await tenant('race-pool', 'consolidator', platform, { seats: 5 });
      const u = await user('race-pools', free, 'vendedor');
      await member(other, u.id, 'vendedor');
      await Promise.all([issueFor(u.id, free), issueFor(u.id, other)]);
      expect(await liveSessions(u.id)).toBe(1);
    });
  });

  describe('tenant pedido por header (x-tenant-id)', () => {
    it('un nodo de otro cupo no se adopta aunque sea miembro; uno del mismo cupo, sí', async () => {
      const own = await tenant('hdr-own', 'consolidator', platform, { seats: 5 });
      const branch = await tenant('hdr-branch', 'agency', own);
      const full = await tenant('hdr-full', 'consolidator', platform, { seats: 1 });
      const u = await user('hdr', own, 'vendedor');
      await member(branch, u.id, 'agency_admin');
      await member(full, u.id, 'agency_admin');
      const issued = await issueFor(u.id, own);
      const base = { sessionId: issued.sessionId, userId: u.id, tenantId: own };

      // Otro cupo: se queda en el tid firmado, con el rol de ahí.
      expect(await sessions.validate({ ...base, requestedTenantId: full })).toMatchObject({
        ok: true,
        role: 'vendedor',
        requestedTenantRejected: true,
      });
      // Hija que consume del mismo cupo: se adopta, con el rol de la hija.
      const sameSeat = await sessions.validate({ ...base, requestedTenantId: branch });
      expect(sameSeat).toMatchObject({ ok: true, role: 'agency_admin' });
      expect(sameSeat).not.toHaveProperty('requestedTenantRejected');
    });

    it('el admin de un ancestro opera un nodo con cupo propio donde no es miembro: sin rol', async () => {
      const top = await tenant('hdr-top', 'consolidator', platform, { seats: 5 });
      const child = await tenant('hdr-child', 'agency', top, { seats: 2 });
      const boss = await user('hdr-boss', top, 'consolidator_admin');
      const issued = await issueFor(boss.id, top);

      const actAs = await sessions.validate({
        sessionId: issued.sessionId,
        userId: boss.id,
        tenantId: top,
        requestedTenantId: child,
      });
      expect(actAs).toMatchObject({ ok: true });
      expect(actAs).not.toHaveProperty('role');
      expect(actAs).not.toHaveProperty('requestedTenantRejected');
    });
  });
});
