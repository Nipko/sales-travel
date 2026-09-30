import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import {
  MfaAccountLockedError,
  MfaChallengeExpiredError,
  MfaCodeInvalidError,
  SeatsFullError,
} from './auth-errors.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { LOCKOUT_THRESHOLD, type LoginAttemptsService } from './login-attempts.service.js';
import {
  MFA_MAX_ATTEMPTS,
  type MfaAttemptReservation,
  type MfaChallengeService,
} from './mfa-challenge.service.js';
import type { MfaService } from './mfa.service.js';
import type { PasswordService } from './password.service.js';
import type { SeatService } from './seat.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';

/**
 * El paso MFA del login con dobles: intentos por desafío, vencimiento, un solo uso, el bloqueo de
 * la cuenta compartido con la contraseña y que el contador no se limpie antes del segundo factor.
 * Contra Postgres lo cubren auth-premium.integration.test.ts y auth-lockout.integration.test.ts.
 */

/** Consulta de Kysely de mentira: cualquier cadena de métodos termina en `rows`. */
function query(rows: unknown[]): unknown {
  const target = {};
  const proxy: unknown = new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'execute') return () => Promise.resolve(rows);
      if (prop === 'executeTakeFirst') return () => Promise.resolve(rows[0]);
      return () => proxy;
    },
  });
  return proxy;
}

interface ChallengeRow {
  userId: string;
  attempts: number;
  expiresAt: Date;
  consumed: boolean;
}

/** El contador de la cuenta (users.failed_login_attempts / locked_until), el de la contraseña. */
class FakeAccount {
  failed = 0;
  locked = false;
}

/**
 * La reserva como la hace MfaChallengeService: cuenta y desafío juntos y de una vez (en la base, una
 * transacción bajo el lock de la fila de users). Si el desafío no sirve, la cuenta no pierde nada.
 */
class FakeChallenges {
  readonly rows = new Map<string, ChallengeRow>();

  constructor(private readonly account: FakeAccount) {}

  create(userId: string): Promise<{ id: string; expiresAt: Date }> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    this.rows.set(id, { userId, attempts: 0, expiresAt, consumed: false });
    return Promise.resolve({ id, expiresAt });
  }

  reserveAttempt(userId: string, id: string): Promise<MfaAttemptReservation> {
    if (this.account.locked) return Promise.resolve({ kind: 'locked' });
    const r = this.rows.get(id);
    if (
      !r ||
      r.userId !== userId ||
      r.consumed ||
      r.attempts >= MFA_MAX_ATTEMPTS ||
      r.expiresAt.getTime() <= Date.now()
    ) {
      return Promise.resolve({ kind: 'unavailable' });
    }
    r.attempts += 1;
    this.account.failed += 1;
    const locksAccount = this.account.failed >= LOCKOUT_THRESHOLD;
    if (locksAccount) {
      this.account.failed = 0;
      this.account.locked = true;
    }
    const accountLeft = locksAccount ? 0 : LOCKOUT_THRESHOLD - this.account.failed;
    return Promise.resolve({
      kind: 'reserved',
      attempt: r.attempts,
      attemptsLeft: Math.min(MFA_MAX_ATTEMPTS - r.attempts, accountLeft),
      locksAccount,
    });
  }

  consume(userId: string, id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId || r.consumed) return Promise.resolve(false);
    r.consumed = true;
    return Promise.resolve(true);
  }
}

const USER = 'user-mfa';
const jwt = new JwtService();

let account: FakeAccount;
let challenges: FakeChallenges;
let verifyCode: ReturnType<typeof vi.fn>;
let registerFailure: ReturnType<typeof vi.fn>;
let registerSuccess: ReturnType<typeof vi.fn>;
let clearFailures: ReturnType<typeof vi.fn>;
let issue: ReturnType<typeof vi.fn>;
let createDevice: ReturnType<typeof vi.fn>;
let useDevice: ReturnType<typeof vi.fn>;
let events: AuditEvent[];
let auth: AuthService;

function build(user: Record<string, unknown> | undefined = undefined): AuthService {
  const db = {
    db: query(user ? [user] : []),
    withRequestContext: (_ctx: unknown, fn: (trx: unknown) => Promise<unknown>) =>
      fn(query([{ tenant_id: 'tenant-1', role: 'tenant_admin' }])),
  } as unknown as DatabaseService;
  const audit = {
    emit: vi.fn((e: AuditEvent) => {
      events.push(e);
      return Promise.resolve();
    }),
  } as unknown as AuditService;
  const password = {
    verify: vi.fn(() => Promise.resolve(true)),
    hash: vi.fn(() => Promise.resolve('hash')),
  } as unknown as PasswordService;
  return new AuthService(
    db,
    jwt,
    password,
    audit,
    {} as MailerService,
    {} as SessionService,
    { verifyCode } as unknown as MfaService,
    { issue } as unknown as SeatService,
    challenges as unknown as MfaChallengeService,
    { create: createDevice, use: useDevice } as unknown as TrustedDeviceService,
    { registerFailure, registerSuccess, clearFailures } as unknown as LoginAttemptsService,
  );
}

async function newChallenge(): Promise<string> {
  const c = await challenges.create(USER);
  return jwt.signMfaChallenge(USER, c.id, c.expiresAt);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

describe('AuthService: paso MFA del login', () => {
  beforeAll(() => {
    process.env['JWT_SECRET'] ??= 'j'.repeat(40);
    jwt.onModuleInit();
  });

  beforeEach(() => {
    account = new FakeAccount();
    challenges = new FakeChallenges(account);
    verifyCode = vi.fn(() => Promise.resolve(false));
    registerFailure = vi.fn(() => Promise.resolve({ locked: false }));
    registerSuccess = vi.fn(() => Promise.resolve());
    clearFailures = vi.fn(() => {
      account.failed = 0;
      account.locked = false;
      return Promise.resolve();
    });
    issue = vi.fn(() =>
      Promise.resolve({
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
        idleTimeoutSeconds: 1800,
        seatTenantId: null,
      }),
    );
    createDevice = vi.fn(() =>
      Promise.resolve({ token: 'equipo', expiresAt: new Date('2026-10-29T00:00:00Z') }),
    );
    useDevice = vi.fn(() => Promise.resolve(false));
    events = [];
    auth = build();
  });

  it('cada fallo descuenta un intento, suma al bloqueo y dice cuántos quedan', async () => {
    const token = await newChallenge();
    for (let left = MFA_MAX_ATTEMPTS - 1; left >= 1; left--) {
      const err = await rejection(auth.completeMfa(token, '000000'));
      expect(err).toBeInstanceOf(MfaCodeInvalidError);
      expect((err as MfaCodeInvalidError).getStatus()).toBe(401);
      expect((err as MfaCodeInvalidError).publicDetails).toEqual({ attemptsLeft: left });
    }
    // El fallo se cuenta al reservar el intento, antes de verificar: no hay otro registro después.
    expect(account.failed).toBe(MFA_MAX_ATTEMPTS - 1);
    expect(registerFailure).not.toHaveBeenCalled();
  });

  it('el quinto fallo bloquea la cuenta: MFA_ACCOUNT_LOCKED y vuelta a la contraseña', async () => {
    const token = await newChallenge();
    for (let i = 1; i < MFA_MAX_ATTEMPTS; i++) await rejection(auth.completeMfa(token, '000000'));

    const locked = await rejection(auth.completeMfa(token, '000000'));
    expect(locked).toBeInstanceOf(MfaAccountLockedError);
    expect((locked as MfaAccountLockedError).getStatus()).toBe(401);
    expect((locked as MfaAccountLockedError).reason).toBe('MFA_ACCOUNT_LOCKED');
    // Ya bloqueada: ni siquiera se verifica el código (ni con uno correcto).
    verifyCode.mockResolvedValue(true);
    expect(await rejection(auth.completeMfa(token, '123456'))).toBeInstanceOf(
      MfaAccountLockedError,
    );
    expect(verifyCode).toHaveBeenCalledTimes(MFA_MAX_ATTEMPTS);
    expect(issue).not.toHaveBeenCalled();
  });

  it('los intentos que quedan son los de la cuenta si se acaban antes que los del desafío', async () => {
    account.failed = 2; // dos contraseñas malas antes de esta
    const token = await newChallenge();
    const err = await rejection(auth.completeMfa(token, '000000'));
    expect((err as MfaCodeInvalidError).publicDetails).toEqual({ attemptsLeft: 2 });
  });

  it('con la cuenta bloqueada no se prueba el código', async () => {
    account.locked = true;
    verifyCode.mockResolvedValue(true);
    const token = await newChallenge();
    expect(await rejection(auth.completeMfa(token, '123456'))).toBeInstanceOf(
      MfaAccountLockedError,
    );
    expect(verifyCode).not.toHaveBeenCalled();
  });

  it('muchos desafíos en paralelo no prueban más de 5 códigos por ventana de bloqueo', async () => {
    // El código tarda: si el bloqueo se mirara aparte y el fallo se sumara después de verificar,
    // toda la ráfaga pasaría el chequeo antes de que el quinto fallo lo grabara.
    verifyCode.mockImplementation(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5)),
    );
    const tokens = await Promise.all(Array.from({ length: 4 }, () => newChallenge()));

    const outcomes = await Promise.all(
      tokens.flatMap((t) =>
        Array.from({ length: MFA_MAX_ATTEMPTS }, () => rejection(auth.completeMfa(t, '000000'))),
      ),
    );

    expect(verifyCode).toHaveBeenCalledTimes(LOCKOUT_THRESHOLD);
    expect(outcomes.filter((e) => e instanceof MfaAccountLockedError)).toHaveLength(
      outcomes.length - (LOCKOUT_THRESHOLD - 1),
    );
    expect(account.locked).toBe(true);
    expect(issue).not.toHaveBeenCalled();
  });

  it('un mfaToken vencido o ajeno: MFA_CHALLENGE_EXPIRED', async () => {
    const c = await challenges.create(USER);
    const expired = await jwt.signMfaChallenge(USER, c.id, new Date(Date.now() - 1000));
    expect(await rejection(auth.completeMfa(expired, '123456'))).toBeInstanceOf(
      MfaChallengeExpiredError,
    );
    expect(await rejection(auth.completeMfa('no-es-un-jwt', '123456'))).toBeInstanceOf(
      MfaChallengeExpiredError,
    );
    expect(verifyCode).not.toHaveBeenCalled();
  });

  it('una fila vencida también cierra el desafío, aunque el JWT siga vivo', async () => {
    const token = await newChallenge();
    for (const row of challenges.rows.values()) row.expiresAt = new Date(Date.now() - 1);
    expect(await rejection(auth.completeMfa(token, '123456'))).toBeInstanceOf(
      MfaChallengeExpiredError,
    );
  });

  it('un código correcto emite la sesión verificada, una sola vez', async () => {
    verifyCode.mockResolvedValue(true);
    const token = await newChallenge();

    const result = await auth.completeMfa(token, '123456');

    expect(result).toMatchObject({ userId: USER, tenantId: 'tenant-1', role: 'tenant_admin' });
    expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.trustedDevice).toBeUndefined();
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, mfaVerified: true, remember: false }),
    );
    expect(registerSuccess).toHaveBeenCalledWith(USER);
    // El mismo desafío no emite otra sesión.
    expect(await rejection(auth.completeMfa(token, '123456'))).toBeInstanceOf(
      MfaChallengeExpiredError,
    );
  });

  it('un código correcto limpia el contador aunque el cupo lleno no deje emitir la sesión', async () => {
    const token = await newChallenge();
    for (let i = 1; i < MFA_MAX_ATTEMPTS - 1; i++) {
      await rejection(auth.completeMfa(token, '000000'));
    }
    verifyCode.mockResolvedValue(true);
    issue.mockRejectedValue(new SeatsFullError({ tenantName: 'Agencia', limit: 1, inUse: 1 }));

    expect(await rejection(auth.completeMfa(token, '123456'))).toBeInstanceOf(SeatsFullError);

    // Si no, el código bueno quedaba contando como fallo: unos intentos contra un cupo lleno y la
    // cuenta se bloqueaba.
    expect(clearFailures).toHaveBeenCalledWith(USER);
    expect(account).toMatchObject({ failed: 0, locked: false });
    expect(registerSuccess).not.toHaveBeenCalled();
  });

  it('"recordar este equipo" devuelve el equipo de confianza', async () => {
    verifyCode.mockResolvedValue(true);
    const token = await newChallenge();
    const result: AuthResult = await auth.completeMfa(token, '123456', true);
    expect(result.trustedDevice).toEqual({
      token: 'equipo',
      expiresAt: '2026-10-29T00:00:00.000Z',
    });
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ remember: true }));
  });
});

describe('AuthService.login con MFA activo', () => {
  const USER_ROW = {
    id: USER,
    password_hash: 'hash',
    status: 'active',
    locked_until: null,
    mfa_enabled_at: new Date('2026-01-01T00:00:00Z'),
  };

  beforeAll(() => {
    process.env['JWT_SECRET'] ??= 'j'.repeat(40);
    jwt.onModuleInit();
  });

  beforeEach(() => {
    account = new FakeAccount();
    challenges = new FakeChallenges(account);
    registerFailure = vi.fn(() => Promise.resolve({ locked: false }));
    registerSuccess = vi.fn(() => Promise.resolve());
    clearFailures = vi.fn(() => Promise.resolve());
    issue = vi.fn(() =>
      Promise.resolve({
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
        idleTimeoutSeconds: 1800,
        seatTenantId: null,
      }),
    );
    useDevice = vi.fn(() => Promise.resolve(false));
    events = [];
    auth = build(USER_ROW);
  });

  it('la contraseña correcta NO limpia el contador de fallos: falta el segundo factor', async () => {
    const result = await auth.login({ email: 'a@test.local', password: 'x' });
    expect(result).toMatchObject({ mfaRequired: true });
    expect(registerSuccess).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(challenges.rows.size).toBe(1);
  });

  it('un equipo de confianza válido del usuario reemplaza al código', async () => {
    useDevice.mockResolvedValue(true);
    const result = await auth.login({
      email: 'a@test.local',
      password: 'x',
      trustedDeviceToken: 'token-del-equipo',
    });
    expect(useDevice).toHaveBeenCalledWith(USER, 'token-del-equipo');
    expect(result).toMatchObject({ userId: USER });
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ mfaVerified: true }));
    expect(challenges.rows.size).toBe(0);
    expect(registerSuccess).toHaveBeenCalledWith(USER);
  });

  it('un equipo que ya no vale pide el código como siempre', async () => {
    const result = await auth.login({
      email: 'a@test.local',
      password: 'x',
      trustedDeviceToken: 'token-viejo',
    });
    expect(result).toMatchObject({ mfaRequired: true });
    expect(issue).not.toHaveBeenCalled();
  });
});
