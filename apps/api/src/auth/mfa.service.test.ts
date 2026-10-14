import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { AuditEvent, AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { encryptCredentials } from '../provider-credentials/credentials-cipher.js';
import {
  MfaCodeRejectedError,
  MfaNotEnabledError,
  MfaPasswordInvalidError,
  MfaPasswordRequiredError,
  MfaReauthInvalidError,
  MfaReauthLockedError,
  SessionInvalidError,
} from './auth-errors.js';
import {
  LOCKOUT_THRESHOLD,
  type LoginAttemptsService,
  type ReservedAttempt,
} from './login-attempts.service.js';
import { MfaService } from './mfa.service.js';
import type { PasswordService } from './password.service.js';
import type { TotpService } from './totp.service.js';

// Valor de prueba en una constante y no escrito en cada llamada: el detector de secretos de
// GitGuardian marcaba el texto literal junto al campo de contraseña como una contraseña real.
const INCORRECTA = 'mala';
const CORRECTA = 'la-buena';

/**
 * Cada forma de código se prueba sólo como lo que es. Antes, todo código de 6 dígitos que fallaba
 * como TOTP caía en los códigos de recuperación y corría hasta 10 bcrypt (~2,5 s de threadpool por
 * intento): con un solo desafío se degradaba la API entera.
 */
function service() {
  const password = {
    verify: vi.fn(() => Promise.resolve(false)),
    hash: vi.fn(() => Promise.resolve('hash')),
  };
  // Nada de base: cualquier acceso real rompe el test.
  const db = {
    get db(): never {
      throw new Error('no debería consultar la base');
    },
    withRequestContext: () => {
      throw new Error('no debería consultar la base');
    },
  } as unknown as DatabaseService;
  const mfa = new MfaService(
    db,
    {} as TotpService,
    password as unknown as PasswordService,
    { emit: vi.fn() } as unknown as AuditService,
    {} as LoginAttemptsService,
    { notify: vi.fn() } as unknown as SecurityNoticeService,
  );
  const verifyTotp = vi.spyOn(mfa, 'verifyTotp').mockResolvedValue(false);
  const consumeRecoveryCode = vi.spyOn(mfa, 'consumeRecoveryCode').mockResolvedValue(false);
  return { mfa, password, verifyTotp, consumeRecoveryCode };
}

describe('MfaService.verifyCode', () => {
  it('un código de 6 dígitos que falla como TOTP nunca dispara bcrypt', async () => {
    const { mfa, password, verifyTotp, consumeRecoveryCode } = service();
    expect(await mfa.verifyCode('u-1', '123456')).toBe(false);
    expect(verifyTotp).toHaveBeenCalledWith('u-1', '123456');
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
    expect(password.verify).not.toHaveBeenCalled();
  });

  it('un código con forma de recuperación se prueba sólo como recuperación, sin guion', async () => {
    const { mfa, verifyTotp, consumeRecoveryCode } = service();
    consumeRecoveryCode.mockResolvedValue(true);
    expect(await mfa.verifyCode('u-1', 'abcde-12345')).toBe(true);
    expect(consumeRecoveryCode).toHaveBeenCalledWith('u-1', 'ABCDE12345');
    expect(verifyTotp).not.toHaveBeenCalled();
  });

  it('lo que no tiene ninguna forma no prueba nada', async () => {
    const { mfa, password, verifyTotp, consumeRecoveryCode } = service();
    for (const junk of ['12345', '1234567', 'hola-mundo', 'ZZZZZ-ZZZZZ']) {
      expect(await mfa.verifyCode('u-1', junk)).toBe(false);
    }
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
    expect(password.verify).not.toHaveBeenCalled();
  });
});

/** Consulta de Kysely de mentira: cualquier cadena de métodos termina en `rows`. */
function query(rows: unknown[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'execute') return () => Promise.resolve(rows);
        if (prop === 'executeTakeFirst') return () => Promise.resolve(rows[0]);
        return () => proxy;
      },
    },
  );
  return proxy;
}

/** El contador de la cuenta con la semántica de LoginAttemptsService.reserve (0019). */
class FakeLockout {
  failed = 0;
  locked = false;

  reserve(): Promise<ReservedAttempt | null> {
    if (this.locked) return Promise.resolve(null);
    this.failed += 1;
    if (this.failed >= LOCKOUT_THRESHOLD) {
      this.failed = 0;
      this.locked = true;
      return Promise.resolve({ locked: true, attemptsLeft: 0 });
    }
    return Promise.resolve({ locked: false, attemptsLeft: LOCKOUT_THRESHOLD - this.failed });
  }

  clearFailures(): Promise<void> {
    this.failed = 0;
    this.locked = false;
    return Promise.resolve();
  }
}

/**
 * Regenerar códigos, cambiar de teléfono y desactivar prueban el segundo factor DENTRO de una
 * sesión. Antes no sumaban al bloqueo: con una sesión robada eran un oráculo del TOTP limitado sólo
 * por el throttle por IP. Ahora cuentan contra la cuenta igual que el login.
 */
describe('MfaService: el bloqueo de la cuenta dentro de una sesión', () => {
  const USER = 'u-reauth';
  let lockout: FakeLockout;
  let events: AuditEvent[];
  let password: { verify: ReturnType<typeof vi.fn>; hash: ReturnType<typeof vi.fn> };

  function build() {
    const db = {
      db: query([{ mfa_enabled_at: new Date('2026-01-01T00:00:00Z'), password_hash: 'hash' }]),
      withRequestContext: (_ctx: unknown, fn: (trx: unknown) => Promise<unknown>) => fn(query([])),
    } as unknown as DatabaseService;
    const audit = {
      emit: vi.fn((e: AuditEvent) => {
        events.push(e);
        return Promise.resolve();
      }),
    } as unknown as AuditService;
    const mfa = new MfaService(
      db,
      { generateSecret: () => 'SECRETO', buildUri: () => 'otpauth://x' } as unknown as TotpService,
      password as unknown as PasswordService,
      audit,
      lockout as unknown as LoginAttemptsService,
      { notify: vi.fn() } as unknown as SecurityNoticeService,
    );
    const verifyTotp = vi.spyOn(mfa, 'verifyTotp').mockResolvedValue(false);
    return { mfa, verifyTotp };
  }

  async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('se esperaba un rechazo');
  }

  beforeEach(() => {
    lockout = new FakeLockout();
    events = [];
    password = {
      verify: vi.fn(() => Promise.resolve(true)),
      hash: vi.fn(() => Promise.resolve('hash')),
    };
  });

  it('regenerar códigos: cada código malo cuenta y el que llega al umbral bloquea', async () => {
    const { mfa, verifyTotp } = build();
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
      expect(await rejection(mfa.regenerateRecoveryCodes(USER, '000000'))).toBeInstanceOf(
        MfaCodeRejectedError,
      );
    }
    const locking = await rejection(mfa.regenerateRecoveryCodes(USER, '000000'));
    expect(locking).toBeInstanceOf(MfaReauthLockedError);
    expect((locking as MfaReauthLockedError).getStatus()).toBe(429);
    expect((locking as MfaReauthLockedError).reason).toBe('MFA_ACCOUNT_LOCKED');

    // Bloqueada: ni el código bueno se prueba.
    verifyTotp.mockResolvedValue(true);
    expect(await rejection(mfa.regenerateRecoveryCodes(USER, '123456'))).toBeInstanceOf(
      MfaReauthLockedError,
    );
    expect(verifyTotp).toHaveBeenCalledTimes(LOCKOUT_THRESHOLD);
    expect(events.filter((e) => e.eventType === 'auth.mfa.reauth_failed')).toHaveLength(
      LOCKOUT_THRESHOLD,
    );
  });

  it('lo que no tiene forma de TOTP se rechaza sin contar', async () => {
    const { mfa, verifyTotp } = build();
    expect(await rejection(mfa.regenerateRecoveryCodes(USER, 'ABCDE-12345'))).toBeInstanceOf(
      MfaCodeRejectedError,
    );
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(lockout.failed).toBe(0);
  });

  it('un acierto limpia el contador', async () => {
    const { mfa, verifyTotp } = build();
    await rejection(mfa.regenerateRecoveryCodes(USER, '000000'));
    await rejection(mfa.regenerateRecoveryCodes(USER, '000000'));
    verifyTotp.mockResolvedValue(true);

    const { recoveryCodes } = await mfa.regenerateRecoveryCodes(USER, '123456');

    expect(recoveryCodes).toHaveLength(10);
    expect(lockout).toMatchObject({ failed: 0, locked: false });
  });

  it('cambiar de teléfono: la contraseña mala también cuenta, sin gastar el paso TOTP', async () => {
    const { mfa, verifyTotp } = build();
    password.verify.mockResolvedValue(false);
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
      expect(
        await rejection(
          mfa.beginEnrollment(USER, 'a@test.local', {
            currentPassword: INCORRECTA,
            code: '123456',
          }),
        ),
      ).toBeInstanceOf(MfaReauthInvalidError);
    }
    expect(
      await rejection(
        mfa.beginEnrollment(USER, 'a@test.local', { currentPassword: INCORRECTA, code: '123456' }),
      ),
    ).toBeInstanceOf(MfaReauthLockedError);
    expect(verifyTotp).not.toHaveBeenCalled();
  });

  it('desactivar con la cuenta bloqueada no prueba ni la contraseña', async () => {
    const { mfa } = build();
    vi.spyOn(mfa, 'isRequiredFor').mockResolvedValue(false);
    lockout.locked = true;
    expect(await rejection(mfa.disable(USER, undefined, 'x', '123456'))).toBeInstanceOf(
      MfaReauthLockedError,
    );
    expect(password.verify).not.toHaveBeenCalled();
  });
});

/**
 * Reconfirmar el 2FA de la sesión (POST /auth/step-up, USR-13): sólo con un TOTP vigente, cada
 * intento suma al bloqueo de la cuenta y un acierto pone `mfa_verified_at` de ESTA sesión en ahora.
 */
describe('MfaService.stepUp', () => {
  const USER = 'u-step-up';
  const SESSION = '5e551011-0000-4000-8000-000000000001';
  const VERIFIED = new Date('2026-10-13T15:00:00.000Z');
  let lockout: FakeLockout;
  let events: AuditEvent[];

  function build(opts: { mfaEnabled?: boolean; sessionRows?: unknown[] } = {}) {
    const k = scriptedKysely((q) =>
      q.sql.startsWith('update "sessions"')
        ? (opts.sessionRows ?? [{ mfa_verified_at: VERIFIED }])
        : [],
    );
    const db = {
      db: query([{ mfa_enabled_at: opts.mfaEnabled === false ? null : new Date('2026-01-01') }]),
      withRequestContext: (_ctx: unknown, fn: (trx: unknown) => Promise<unknown>) =>
        k.db.transaction().execute(fn),
    } as unknown as DatabaseService;
    const audit = {
      emit: vi.fn((e: AuditEvent) => {
        events.push(e);
        return Promise.resolve();
      }),
    } as unknown as AuditService;
    const mfa = new MfaService(
      db,
      {} as TotpService,
      {} as PasswordService,
      audit,
      lockout as unknown as LoginAttemptsService,
      { notify: vi.fn() } as unknown as SecurityNoticeService,
    );
    const verifyTotp = vi.spyOn(mfa, 'verifyTotp').mockResolvedValue(false);
    return { mfa, verifyTotp, k };
  }

  async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('se esperaba un rechazo');
  }

  beforeEach(() => {
    lockout = new FakeLockout();
    events = [];
  });

  it('con un TOTP vigente pone en ahora el 2FA de ESTA sesión y lo audita', async () => {
    const { mfa, verifyTotp, k } = build();
    verifyTotp.mockResolvedValue(true);

    expect(await mfa.stepUp(USER, SESSION, '123456')).toEqual({ verifiedAt: VERIFIED });

    expect(verifyTotp).toHaveBeenCalledWith(USER, '123456');
    const update = k.queries.find((q) => q.sql.startsWith('update "sessions"'));
    expect(update?.sql).toContain('"mfa_verified_at" = now()');
    expect(update?.sql).toContain('"revoked_at" is null');
    expect(update?.parameters).toEqual([SESSION, USER]);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: 'auth.mfa.step_up',
        actorUserId: USER,
        aggregateId: USER,
        payload: { sessionId: SESSION },
      }),
    ]);
    expect(lockout).toMatchObject({ failed: 0, locked: false });
  });

  it('cada código malo cuenta contra la cuenta y el que llega al umbral bloquea (429)', async () => {
    const { mfa, verifyTotp, k } = build();
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
      const err = await rejection(mfa.stepUp(USER, SESSION, '000000'));
      expect(err).toBeInstanceOf(MfaCodeRejectedError);
      expect((err as MfaCodeRejectedError).getStatus()).toBe(400);
    }
    const locking = await rejection(mfa.stepUp(USER, SESSION, '000000'));
    expect(locking).toBeInstanceOf(MfaReauthLockedError);
    expect((locking as MfaReauthLockedError).getStatus()).toBe(429);

    // Bloqueada: ni el código bueno se prueba, y la sesión no se toca.
    verifyTotp.mockResolvedValue(true);
    expect(await rejection(mfa.stepUp(USER, SESSION, '123456'))).toBeInstanceOf(
      MfaReauthLockedError,
    );
    expect(verifyTotp).toHaveBeenCalledTimes(LOCKOUT_THRESHOLD);
    expect(k.queries).toEqual([]);
    expect(
      events.filter(
        (e) =>
          e.eventType === 'auth.mfa.reauth_failed' &&
          (e.payload as { action?: string }).action === 'step_up',
      ),
    ).toHaveLength(LOCKOUT_THRESHOLD);
  });

  it('un código de recuperación no sirve para reconfirmar, y no cuenta', async () => {
    const { mfa, verifyTotp } = build();
    expect(await rejection(mfa.stepUp(USER, SESSION, 'ABCDE-12345'))).toBeInstanceOf(
      MfaCodeRejectedError,
    );
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(lockout.failed).toBe(0);
  });

  it('sin 2FA activo: 409 MFA_NOT_ENABLED, sin probar nada', async () => {
    const { mfa, verifyTotp } = build({ mfaEnabled: false });
    const err = await rejection(mfa.stepUp(USER, SESSION, '123456'));
    expect(err).toBeInstanceOf(MfaNotEnabledError);
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(lockout.failed).toBe(0);
  });

  it('si la sesión se cerró en el medio: 401 SESSION_REVOKED y sin evento de éxito', async () => {
    const { mfa, verifyTotp } = build({ sessionRows: [] });
    verifyTotp.mockResolvedValue(true);
    const err = await rejection(mfa.stepUp(USER, SESSION, '123456'));
    expect(err).toBeInstanceOf(SessionInvalidError);
    expect((err as SessionInvalidError).reason).toBe('SESSION_REVOKED');
    expect(events.some((e) => e.eventType === 'auth.mfa.step_up')).toBe(false);
  });
});

/**
 * Activar el 2FA por primera vez pide la contraseña (USR-13b): en una cuenta sin 2FA, una sesión
 * robada lo activaba con su propio teléfono, quedaba reconfirmada para las acciones de alto impacto
 * y la persona no se enteraba. Se prueba como en el login y cada intento suma al bloqueo.
 */
describe('MfaService.confirmEnrollment: la contraseña de la primera activación', () => {
  const USER = 'u-enroll';
  const ENABLED_AT = new Date('2026-10-13T15:42:00.000Z');
  let lockout: FakeLockout;
  let events: AuditEvent[];

  function build(
    opts: { enabled?: boolean; passwordHash?: string | null; movedRows?: unknown[] } = {},
  ) {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
    const pending = encryptCredentials('SECRETOPENDIENTE').toString('base64');
    const k = scriptedKysely((q) => {
      if (q.sql.includes('UPDATE users')) {
        return opts.movedRows ?? [{ id: USER, mfa_enabled_at: ENABLED_AT }];
      }
      return [];
    });
    const db = {
      db: query([
        {
          mfa_pending_secret: pending,
          mfa_enabled_at: opts.enabled ? new Date('2026-01-01T00:00:00Z') : null,
          mfa_last_used_step: null,
          password_hash: 'passwordHash' in opts ? opts.passwordHash : 'hash-real',
        },
      ]),
      withRequestContext: (_ctx: unknown, fn: (trx: unknown) => Promise<unknown>) =>
        k.db.transaction().execute(fn),
    } as unknown as DatabaseService;
    const audit = {
      emit: vi.fn((e: AuditEvent) => {
        events.push(e);
        return Promise.resolve();
      }),
    } as unknown as AuditService;
    const totp = { verify: vi.fn(() => 58_000_000) };
    const password = {
      verify: vi.fn((_candidate: string, _hash: string) => Promise.resolve(true)),
      hash: vi.fn(() => Promise.resolve('hash-de-relleno')),
    };
    const notices = { notify: vi.fn() };
    const mfa = new MfaService(
      db,
      totp as unknown as TotpService,
      password as unknown as PasswordService,
      audit,
      lockout as unknown as LoginAttemptsService,
      notices as unknown as SecurityNoticeService,
    );
    return { mfa, k, totp, password, notices };
  }

  async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('se esperaba un rechazo');
  }

  beforeEach(() => {
    lockout = new FakeLockout();
    events = [];
  });

  it('sin contraseña: 400 MFA_PASSWORD_REQUIRED, sin probar nada ni contar un intento', async () => {
    const { mfa, k, totp, password, notices } = build();

    const err = await rejection(mfa.confirmEnrollment(USER, 'sesion', '123456'));

    expect(err).toBeInstanceOf(MfaPasswordRequiredError);
    expect((err as MfaPasswordRequiredError).getStatus()).toBe(400);
    expect((err as MfaPasswordRequiredError).reason).toBe('MFA_PASSWORD_REQUIRED');
    expect(password.verify).not.toHaveBeenCalled();
    expect(totp.verify).not.toHaveBeenCalled();
    expect(lockout.failed).toBe(0);
    expect(k.queries).toEqual([]);
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('contraseña mala: cuenta como en el login, la quinta bloquea (429) y bloqueada ni se prueba', async () => {
    const { mfa, k, totp, password, notices } = build();
    password.verify.mockResolvedValue(false);

    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
      const err = await rejection(mfa.confirmEnrollment(USER, 'sesion', '123456', INCORRECTA));
      expect(err).toBeInstanceOf(MfaPasswordInvalidError);
      expect((err as MfaPasswordInvalidError).getStatus()).toBe(400);
      expect((err as MfaPasswordInvalidError).reason).toBe('MFA_PASSWORD_INVALID');
    }
    const locking = await rejection(mfa.confirmEnrollment(USER, 'sesion', '123456', INCORRECTA));
    expect(locking).toBeInstanceOf(MfaReauthLockedError);
    expect((locking as MfaReauthLockedError).getStatus()).toBe(429);

    // Bloqueada: ni la contraseña buena se prueba.
    password.verify.mockResolvedValue(true);
    expect(
      await rejection(mfa.confirmEnrollment(USER, 'sesion', '123456', CORRECTA)),
    ).toBeInstanceOf(MfaReauthLockedError);
    expect(password.verify).toHaveBeenCalledTimes(LOCKOUT_THRESHOLD);
    expect(password.verify).toHaveBeenCalledWith(INCORRECTA, 'hash-real');

    // La contraseña va antes que el código: nada se activó ni se tocó.
    expect(totp.verify).not.toHaveBeenCalled();
    expect(k.queries).toEqual([]);
    expect(notices.notify).not.toHaveBeenCalled();
    expect(
      events.filter(
        (e) =>
          e.eventType === 'auth.mfa.reauth_failed' &&
          (e.payload as { action?: string }).action === 'enroll',
      ),
    ).toHaveLength(LOCKOUT_THRESHOLD);
  });

  it('sin contraseña guardada igual corre un bcrypt (contra uno de relleno) y rechaza', async () => {
    const { mfa, password } = build({ passwordHash: null });

    for (let i = 0; i < 2; i++) {
      expect(
        await rejection(mfa.confirmEnrollment(USER, 'sesion', '123456', CORRECTA)),
      ).toBeInstanceOf(MfaPasswordInvalidError);
    }
    expect(password.verify).toHaveBeenCalledTimes(2);
    expect(password.verify).toHaveBeenCalledWith(CORRECTA, 'hash-de-relleno');
    // El de relleno se calcula una sola vez.
    expect(password.hash).toHaveBeenCalledTimes(1);
    expect(lockout.failed).toBe(2);
  });

  it('un código con otra forma se rechaza antes de probar la contraseña, sin contar', async () => {
    const { mfa, password } = build();
    expect(
      await rejection(mfa.confirmEnrollment(USER, 'sesion', 'ABCDE-12345', CORRECTA)),
    ).toBeInstanceOf(MfaCodeRejectedError);
    expect(password.verify).not.toHaveBeenCalled();
    expect(lockout.failed).toBe(0);
  });

  it('contraseña buena: activa, limpia el contador, audita y le avisa a la persona con la hora', async () => {
    const { mfa, k, password, notices } = build();
    lockout.failed = 2;

    const { recoveryCodes } = await mfa.confirmEnrollment(USER, 'sesion', '123456', CORRECTA);

    expect(recoveryCodes).toHaveLength(10);
    expect(password.verify).toHaveBeenCalledWith(CORRECTA, 'hash-real');
    expect(lockout).toMatchObject({ failed: 0, locked: false });
    // El UPDATE exige que la cuenta siga sin 2FA, que es lo que decidió pedir la contraseña.
    const moved = k.queries.find((q) => q.sql.includes('UPDATE users'));
    expect(moved?.sql).toContain('(mfa_enabled_at IS NOT NULL) = ');
    expect(moved?.parameters).toContain(false);
    const enabled = events.find((e) => e.eventType === 'auth.mfa.enabled');
    expect(enabled?.actorUserId).toBe(USER);
    expect(enabled?.payload).toMatchObject({ rotation: false });
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith('mfa_enabled', {
      userId: USER,
      tenantId: null,
      at: ENABLED_AT,
    });
  });

  it('si la cuenta cambió entre la lectura y el UPDATE: 400 y ningún aviso', async () => {
    const { mfa, notices } = build({ movedRows: [] });
    expect(
      await rejection(mfa.confirmEnrollment(USER, 'sesion', '123456', CORRECTA)),
    ).toBeInstanceOf(MfaCodeRejectedError);
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('cambiar de teléfono (ya tiene 2FA): no pide la contraseña ni cuenta, y avisa del cambio', async () => {
    const { mfa, k, password, notices } = build({ enabled: true });

    const { recoveryCodes } = await mfa.confirmEnrollment(USER, 'sesion', '123456');

    expect(recoveryCodes).toHaveLength(10);
    expect(password.verify).not.toHaveBeenCalled();
    expect(lockout.failed).toBe(0);
    expect(k.queries.find((q) => q.sql.includes('UPDATE users'))?.parameters).toContain(true);
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith('mfa_changed', {
      userId: USER,
      tenantId: null,
      at: ENABLED_AT,
    });
  });
});
