import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import {
  MfaCodeRejectedError,
  MfaReauthInvalidError,
  MfaReauthLockedError,
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
