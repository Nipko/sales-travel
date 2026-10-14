import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import type { MailerService, MailMessage } from '../mail/mailer.service.js';
import { SecurityNoticeService } from '../mail/security-notice.service.js';
import { noticeTime } from '../mail/security-notices.js';
import {
  decryptCredentials,
  encryptCredentials,
} from '../provider-credentials/credentials-cipher.js';
import {
  MfaAlreadyEnabledError,
  MfaCodeRejectedError,
  MfaNoPendingEnrollmentError,
  MfaPasswordInvalidError,
  MfaPasswordRequiredError,
  MfaReauthInvalidError,
  MfaReauthLockedError,
  MfaRequiredByRoleError,
} from './auth-errors.js';
import { LOCKOUT_THRESHOLD, LoginAttemptsService } from './login-attempts.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { TotpService } from './totp.service.js';

// Valor de prueba en una constante y no escrito en cada llamada: el detector de secretos de
// GitGuardian marcaba el texto literal junto al campo de contraseña como una contraseña real.
const INCORRECTA = 'mala';

/**
 * El ciclo del MFA contra Postgres y como `app_user`: enrolar deja el secreto PENDIENTE sin tocar el
 * activo, confirmar sólo con pendiente, el anti-replay y el canje de códigos de recuperación son
 * atómicos (dos requests en paralelo con el mismo código: pasa uno), y un rol que lo exige no lo
 * puede desactivar. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const PASSWORD = 'contraseña-de-prueba-mfa';

// Cada enrolamiento hashea diez códigos de recuperación con bcrypt (costo 12) y cada código de
// recuperación que no coincide se compara contra los diez: en el runner de CI un caso llega a pasar
// los 5 s por defecto de Vitest sin que nada ande mal.
d('MfaService contra Postgres, como app_user', { timeout: 30_000 }, () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();
  const comoApp = new pg.Pool({ max: 8 });
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });
  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const totp = new TotpService();
  const password = new PasswordService();
  const mailer = {
    sendToTenant: vi.fn((_tenantId: string | null, _msg: MailMessage) => Promise.resolve(true)),
  };
  const work = new InflightWorkRegistry();
  const notices = new SecurityNoticeService(database, mailer as unknown as MailerService, work);
  const mfa = new MfaService(
    database,
    totp,
    password,
    new AuditService(database),
    new LoginAttemptsService(database),
    notices,
  );

  let platform: string;
  let branch: string;
  let passwordHash: string;

  async function user(label: string, role = 'vendedor'): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`mfa-${label}-${sfx}@test.local`, passwordHash],
    );
    const id = rows[0]!.id;
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [role === 'vendedor' ? branch : platform, id, role],
    );
    return id;
  }

  async function session(userId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
      [userId, branch],
    );
    return rows[0]!.id;
  }

  async function userRow(userId: string) {
    const { rows } = await admin.query<{
      mfa_secret: string | null;
      mfa_pending_secret: string | null;
      mfa_enabled_at: Date | null;
    }>('SELECT mfa_secret, mfa_pending_secret, mfa_enabled_at FROM users WHERE id = $1', [userId]);
    return rows[0]!;
  }

  /** El código del paso `offset` respecto del actual, con el secreto en claro. */
  function code(secret: string, offset = 0): string {
    return totp.generate(secret, totp.currentStep() + offset);
  }

  /**
   * Enrola y confirma con el paso anterior al actual: quedan el actual y el siguiente para usar. La
   * contraseña se prueba (un bcrypt) antes que el código: si en ese rato cambia el paso, el anterior
   * queda fuera de la ventana y se reintenta con el nuevo anterior, en vez de fallar al azar.
   */
  async function enrolled(label: string, role = 'vendedor') {
    const id = await user(label, role);
    const { secret } = await mfa.beginEnrollment(id, `${label}@test.local`);
    for (;;) {
      const step = totp.currentStep();
      try {
        const { recoveryCodes } = await mfa.confirmEnrollment(
          id,
          undefined,
          totp.generate(secret, step - 1),
          PASSWORD,
        );
        return { id, secret, recoveryCodes };
      } catch (err) {
        if (!(err instanceof MfaCodeRejectedError) || totp.currentStep() === step) throw err;
      }
    }
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
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    passwordHash = await password.hash(PASSWORD);
    platform = await platformRootId(admin);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, is_branch,
                            parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', true, $2) RETURNING id`,
      [`mfa-sucursal-${sfx}`, platform],
    );
    branch = rows[0]!.id;
  });

  // Cada primera activación deja un aviso saliendo de fondo: que termine antes de mirar el correo.
  beforeEach(async () => {
    await work.whenIdle();
    mailer.sendToTenant.mockClear();
  });

  afterAll(async () => {
    await work.whenIdle();
    await admin.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [branch]);
    await database.db.destroy();
    await admin.end();
  });

  it('confirmar activa el pendiente, verifica la sesión actual y cierra las demás', async () => {
    const id = await user('confirm');
    const current = await session(id);
    const other = await session(id);
    const { secret } = await mfa.beginEnrollment(id, 'confirm@test.local');

    const pending = await userRow(id);
    expect(pending.mfa_secret).toBeNull();
    expect(pending.mfa_enabled_at).toBeNull();
    expect(decryptCredentials(Buffer.from(pending.mfa_pending_secret!, 'base64'))).toBe(secret);

    const { recoveryCodes } = await mfa.confirmEnrollment(id, current, code(secret), PASSWORD);

    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    const active = await userRow(id);
    expect(active.mfa_pending_secret).toBeNull();
    expect(active.mfa_enabled_at).toBeInstanceOf(Date);
    expect(decryptCredentials(Buffer.from(active.mfa_secret!, 'base64'))).toBe(secret);

    const { rows } = await admin.query<{
      id: string;
      revoked_reason: string | null;
      mfa_verified_at: Date | null;
    }>('SELECT id, revoked_reason, mfa_verified_at FROM sessions WHERE user_id = $1', [id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(current)).toMatchObject({ revoked_reason: null });
    expect(byId.get(current)?.mfa_verified_at).toBeInstanceOf(Date);
    expect(byId.get(other)?.revoked_reason).toBe('mfa_enrolled');
  });

  it('confirmar sin enrolamiento en curso: 409, aunque el MFA esté activo', async () => {
    const { id, secret } = await enrolled('no-pending');
    expect(await rejection(mfa.confirmEnrollment(id, undefined, code(secret)))).toBeInstanceOf(
      MfaNoPendingEnrollmentError,
    );
  });

  it('con MFA activo, enrolar sin contraseña y código no pisa nada', async () => {
    const { id } = await enrolled('rotate-409');
    const before = await userRow(id);
    expect(await rejection(mfa.beginEnrollment(id, 'x@test.local'))).toBeInstanceOf(
      MfaAlreadyEnabledError,
    );
    expect(await userRow(id)).toEqual(before);
  });

  it('"cambiar de teléfono": con contraseña y código deja el nuevo pendiente y el activo intacto', async () => {
    const { id, secret } = await enrolled('rotate');
    const before = await userRow(id);

    const next = await mfa.beginEnrollment(id, 'x@test.local', {
      currentPassword: PASSWORD,
      code: code(secret),
    });

    const after = await userRow(id);
    expect(after.mfa_secret).toBe(before.mfa_secret);
    expect(after.mfa_enabled_at?.getTime()).toBe(before.mfa_enabled_at?.getTime());
    expect(decryptCredentials(Buffer.from(after.mfa_pending_secret!, 'base64'))).toBe(next.secret);
    // El viejo sigue sirviendo hasta confirmar el nuevo.
    expect(await mfa.verifyTotp(id, code(secret, 1))).toBe(true);
  });

  it('anti-replay atómico: el mismo código en paralelo pasa una sola vez', async () => {
    const { id, secret } = await enrolled('replay');
    const same = code(secret);
    const results = await Promise.all([
      mfa.verifyCode(id, same),
      mfa.verifyCode(id, same),
      mfa.verifyCode(id, same),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // Y después tampoco.
    expect(await mfa.verifyCode(id, same)).toBe(false);
  });

  it('un código de recuperación se canjea una vez, con o sin guion, aun en paralelo', async () => {
    const { id, recoveryCodes } = await enrolled('recovery');
    const shown = recoveryCodes[0]!;
    const results = await Promise.all([
      mfa.verifyCode(id, shown),
      mfa.verifyCode(id, shown.replace('-', '').toLowerCase()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await mfa.status(id)).recoveryCodesRemaining).toBe(9);
  });

  it('regenerar pide un TOTP vigente y reemplaza todos los códigos', async () => {
    const { id, secret, recoveryCodes } = await enrolled('regen');
    expect(await rejection(mfa.regenerateRecoveryCodes(id, recoveryCodes[0]!))).toBeInstanceOf(
      MfaCodeRejectedError,
    );
    const { recoveryCodes: fresh } = await mfa.regenerateRecoveryCodes(id, code(secret));
    expect(fresh).toHaveLength(10);
    expect(await mfa.verifyCode(id, recoveryCodes[1]!)).toBe(false);
    expect(await mfa.verifyCode(id, fresh[0]!)).toBe(true);
  });

  it('regenerar con códigos malos suma al bloqueo de la cuenta: no es un oráculo sin tope', async () => {
    const { id, secret } = await enrolled('regen-lock');
    // Nunca vigente: diez pasos atrás.
    const stale = code(secret, -10);
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
      expect(await rejection(mfa.regenerateRecoveryCodes(id, stale))).toBeInstanceOf(
        MfaCodeRejectedError,
      );
    }
    // El fallo que llega al umbral bloquea, y con la cuenta bloqueada ni el código bueno se prueba.
    expect(await rejection(mfa.regenerateRecoveryCodes(id, stale))).toBeInstanceOf(
      MfaReauthLockedError,
    );
    expect(await rejection(mfa.regenerateRecoveryCodes(id, code(secret)))).toBeInstanceOf(
      MfaReauthLockedError,
    );
    const { rows } = await admin.query<{ locked: boolean }>(
      'SELECT locked_until > now() AS locked FROM users WHERE id = $1',
      [id],
    );
    expect(rows[0]!.locked).toBe(true);
  });

  it('cambiar de teléfono con la contraseña mala también cuenta; un acierto limpia el contador', async () => {
    const { id, secret } = await enrolled('rotate-lock');
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
      expect(
        await rejection(
          mfa.beginEnrollment(id, 'x@test.local', {
            currentPassword: INCORRECTA,
            code: code(secret),
          }),
        ),
      ).toBeInstanceOf(MfaReauthInvalidError);
    }
    await mfa.beginEnrollment(id, 'x@test.local', {
      currentPassword: PASSWORD,
      code: code(secret),
    });
    const { rows } = await admin.query<{ failed: number; locked_until: Date | null }>(
      'SELECT failed_login_attempts AS failed, locked_until FROM users WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ failed: 0, locked_until: null });
  });

  it('un rol que exige MFA no lo puede desactivar; el status lo dice', async () => {
    const { id, secret } = await enrolled('required', 'tenant_admin');
    expect(await mfa.status(id)).toMatchObject({
      enabled: true,
      required: true,
      pendingEnrollment: false,
    });
    expect(await rejection(mfa.disable(id, undefined, PASSWORD, code(secret)))).toBeInstanceOf(
      MfaRequiredByRoleError,
    );
  });

  it('desactivar con contraseña y código limpia todo, conserva la sesión actual y avisa', async () => {
    const { id, secret } = await enrolled('disable');
    const current = await session(id);
    const other = await session(id);
    await work.whenIdle();
    mailer.sendToTenant.mockClear();

    await mfa.disable(id, current, PASSWORD, code(secret));

    await work.whenIdle();
    expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    const [tenantId, msg] = mailer.sendToTenant.mock.calls[0]!;
    expect(tenantId).toBe(branch);
    expect(msg.to).toBe(`mfa-disable-${sfx}@test.local`);
    expect(msg.subject).toBe('Desactivaste la verificación en dos pasos · PlaneTour');
    expect(msg.text).toContain('Si no fuiste tú');

    const row = await userRow(id);
    expect(row).toEqual({ mfa_secret: null, mfa_pending_secret: null, mfa_enabled_at: null });
    const { rows } = await admin.query<{ id: string; revoked_reason: string | null }>(
      'SELECT id, revoked_reason FROM sessions WHERE id = ANY($1::uuid[])',
      [[current, other]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.revoked_reason]));
    expect(byId.get(current)).toBeNull();
    expect(byId.get(other)).toBe('mfa_disabled');
  });

  describe('la contraseña de la primera activación (USR-13b)', () => {
    async function counters(userId: string) {
      const { rows } = await admin.query<{ failed: number; locked: boolean }>(
        `SELECT failed_login_attempts AS failed, COALESCE(locked_until > now(), false) AS locked
           FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0]!;
    }

    it('una sesión robada sin la contraseña no activa el 2FA con su teléfono ni queda reconfirmada', async () => {
      const id = await user('robada');
      const own = await session(id);
      const stolen = await session(id);
      // El secreto pendiente lo pide la sesión robada: el QR sería el de su teléfono.
      const { secret } = await mfa.beginEnrollment(id, 'robada@test.local');

      expect(await rejection(mfa.confirmEnrollment(id, stolen, code(secret)))).toBeInstanceOf(
        MfaPasswordRequiredError,
      );
      expect(
        await rejection(mfa.confirmEnrollment(id, stolen, code(secret), INCORRECTA)),
      ).toBeInstanceOf(MfaPasswordInvalidError);

      const row = await userRow(id);
      expect(row.mfa_secret).toBeNull();
      expect(row.mfa_enabled_at).toBeNull();
      // La sesión robada no cuenta como reconfirmada (USR-13) y la de la persona sigue abierta.
      const { rows } = await admin.query<{
        id: string;
        revoked_reason: string | null;
        mfa_verified_at: Date | null;
      }>('SELECT id, revoked_reason, mfa_verified_at FROM sessions WHERE user_id = $1', [id]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(own)).toMatchObject({ revoked_reason: null, mfa_verified_at: null });
      expect(byId.get(stolen)).toMatchObject({ revoked_reason: null, mfa_verified_at: null });
      await work.whenIdle();
      expect(mailer.sendToTenant).not.toHaveBeenCalled();
    });

    it('la contraseña mala suma al bloqueo de la cuenta, el mismo del login, y bloqueada ni la buena pasa', async () => {
      const id = await user('activar-bloqueo');
      const { secret } = await mfa.beginEnrollment(id, 'activar-bloqueo@test.local');

      for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
        expect(
          await rejection(mfa.confirmEnrollment(id, undefined, code(secret), INCORRECTA)),
        ).toBeInstanceOf(MfaPasswordInvalidError);
        expect(await counters(id)).toEqual({ failed: i, locked: false });
      }
      expect(
        await rejection(mfa.confirmEnrollment(id, undefined, code(secret), INCORRECTA)),
      ).toBeInstanceOf(MfaReauthLockedError);
      expect((await counters(id)).locked).toBe(true);

      expect(
        await rejection(mfa.confirmEnrollment(id, undefined, code(secret), PASSWORD)),
      ).toBeInstanceOf(MfaReauthLockedError);
      expect((await userRow(id)).mfa_enabled_at).toBeNull();
      // Y el login tampoco: el contador es el mismo.
      expect(await new LoginAttemptsService(database).reserve(id)).toBeNull();
    });

    it('con la contraseña buena se activa, limpia el contador y le avisa a la persona por correo con la hora', async () => {
      const id = await user('aviso');
      const current = await session(id);
      const { secret } = await mfa.beginEnrollment(id, 'aviso@test.local');
      await rejection(mfa.confirmEnrollment(id, current, code(secret), INCORRECTA));
      expect((await counters(id)).failed).toBe(1);

      const { recoveryCodes } = await mfa.confirmEnrollment(id, current, code(secret), PASSWORD);

      expect(recoveryCodes).toHaveLength(10);
      const row = await userRow(id);
      expect(row.mfa_enabled_at).toBeInstanceOf(Date);
      expect(await counters(id)).toEqual({ failed: 0, locked: false });

      await work.whenIdle();
      expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
      const [tenantId, msg] = mailer.sendToTenant.mock.calls[0]!;
      // Por el correo de su nodo (la sucursal, en Colombia), sin nombrarlo.
      expect(tenantId).toBe(branch);
      expect(msg.to).toBe(`mfa-aviso-${sfx}@test.local`);
      expect(msg.subject).toBe('Activaste la verificación en dos pasos · PlaneTour');
      expect(msg.text).toContain(`el ${noticeTime(row.mfa_enabled_at!, 'CO')}.`);
      expect(msg.text).toContain('Si no fuiste tú');
      expect(msg.text).not.toContain(`mfa-sucursal-${sfx}`);
    });

    it('volver a activarlo después de que un admin lo restableció también pide la contraseña', async () => {
      const { id } = await enrolled('restablecido');
      await work.whenIdle();
      mailer.sendToTenant.mockClear();
      await admin.query('SELECT admin_reset_user_mfa($1)', [id]);

      const { secret } = await mfa.beginEnrollment(id, 'restablecido@test.local');
      expect(await rejection(mfa.confirmEnrollment(id, undefined, code(secret)))).toBeInstanceOf(
        MfaPasswordRequiredError,
      );
      await mfa.confirmEnrollment(id, undefined, code(secret), PASSWORD);

      expect((await userRow(id)).mfa_enabled_at).toBeInstanceOf(Date);
      await work.whenIdle();
      expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    });

    it('con el 2FA ya activo: cambiar de teléfono confirma sin la contraseña y avisa del cambio', async () => {
      const { id, secret } = await enrolled('rotar-igual');
      await work.whenIdle();
      mailer.sendToTenant.mockClear();

      const next = await mfa.beginEnrollment(id, 'x@test.local', {
        currentPassword: PASSWORD,
        code: code(secret),
      });
      // El paso actual lo gastó el código de la app anterior: el nuevo confirma con el siguiente.
      await mfa.confirmEnrollment(id, undefined, code(next.secret, 1));

      const row = await userRow(id);
      expect(decryptCredentials(Buffer.from(row.mfa_secret!, 'base64'))).toBe(next.secret);
      expect(await counters(id)).toEqual({ failed: 0, locked: false });
      await work.whenIdle();
      expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
      const [, msg] = mailer.sendToTenant.mock.calls[0]!;
      expect(msg.subject).toBe('Cambiaste tu app de autenticación · PlaneTour');
      expect(msg.text).toContain(`el ${noticeTime(row.mfa_enabled_at!, 'CO')}.`);
    });

    /** Espera a que el UPDATE del paso 1 (el secreto pendiente) quede esperando el lock de la fila. */
    async function untilUpdateWaits(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const { rows } = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE 'update "users" set "mfa_pending_secret"%'`,
        );
        if (rows[0]!.n > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('el UPDATE del paso 1 nunca quedó esperando');
    }

    it('el paso 1 de una sesión robada no deja su secreto si la persona activó el 2FA en el medio', async () => {
      const id = await user('carrera');
      const victimSecret = totp.generateSecret();
      // La persona confirma su 2FA: el UPDATE de su confirmación tiene la fila y todavía no hizo commit.
      const victim = await admin.connect();
      try {
        await victim.query('BEGIN');
        await victim.query(
          `UPDATE users SET mfa_secret = $2, mfa_pending_secret = NULL, mfa_enabled_at = now()
            WHERE id = $1`,
          [id, encryptCredentials(victimSecret).toString('base64')],
        );
        // La sesión robada pide el paso 1 justo entonces: lee la cuenta sin 2FA (no pide nada) y su
        // escritura espera la fila. Si al soltarla escribiera igual, la cuenta quedaría con el 2FA
        // de la persona y el secreto del atacante pendiente: un "cambiar de teléfono" que nunca pidió
        // la contraseña ni el código de la app de la persona.
        const begin = mfa.beginEnrollment(id, 'carrera@test.local');
        await untilUpdateWaits();
        await victim.query('COMMIT');

        expect(await rejection(begin)).toBeInstanceOf(MfaAlreadyEnabledError);
      } finally {
        victim.release();
      }

      const row = await userRow(id);
      expect(row.mfa_pending_secret).toBeNull();
      expect(decryptCredentials(Buffer.from(row.mfa_secret!, 'base64'))).toBe(victimSecret);
      expect(await rejection(mfa.confirmEnrollment(id, undefined, '123456'))).toBeInstanceOf(
        MfaNoPendingEnrollmentError,
      );
    });
  });
});
