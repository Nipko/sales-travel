import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { PasswordResetRequiredError } from './auth-errors.js';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import type { LoginAttemptsService } from './login-attempts.service.js';
import type { MfaChallengeService } from './mfa-challenge.service.js';
import type { MfaService } from './mfa.service.js';
import type { PasswordResetService } from './password-reset.service.js';
import type { PasswordService } from './password.service.js';
import type { SeatService } from './seat.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';

/**
 * El login de quien tiene que elegir una contraseña nueva (0062), con dobles: 403 tipado sólo
 * después de verificar la contraseña, sin contar un fallo, sin desafío MFA ni equipo de confianza,
 * sin sesión ni puesto, y el reenvío del enlace en manos de PasswordResetService (a lo sumo uno cada
 * 10 minutos: password-reset.service.test.ts). Contra Postgres, password-reset-required.integration.
 */

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

const USER = 'user-reset';
const OTHER_SESSION = 'sesion-de-otra-persona';
const jwt = new JwtService();

interface UserRow {
  id: string;
  password_hash: string;
  status: string;
  locked_until: Date | null;
  mfa_enabled_at: Date | null;
  password_reset_required_at: Date | null;
  password_changed_at: Date | null;
  last_tenant_id: string | null;
}

let user: UserRow;
let passwordOk: boolean;
let events: AuditEvent[];
let registerFailure: ReturnType<typeof vi.fn>;
let registerSuccess: ReturnType<typeof vi.fn>;
let clearFailures: ReturnType<typeof vi.fn>;
let issue: ReturnType<typeof vi.fn>;
let createChallenge: ReturnType<typeof vi.fn>;
let useDevice: ReturnType<typeof vi.fn>;
let remindRequiredReset: ReturnType<typeof vi.fn>;
let releaseSession: ReturnType<typeof vi.fn>;

function build(): AuthService {
  const db = {
    // Se lee en cada consulta: un test puede marcar la cuenta entre dos pasos del ingreso.
    get db() {
      return query([user]);
    },
    withRequestContext: (_ctx: unknown, fn: (trx: unknown) => Promise<unknown>) =>
      fn(query([{ tenant_id: 'tenant-1', role: 'vendedor', operable: true }])),
  } as unknown as DatabaseService;
  return new AuthService(
    db,
    jwt,
    { verify: vi.fn(() => Promise.resolve(passwordOk)) } as unknown as PasswordService,
    {
      emit: vi.fn((e: AuditEvent) => {
        events.push(e);
        return Promise.resolve();
      }),
    } as unknown as AuditService,
    {} as MailerService,
    {} as SessionService,
    { verifyCode: vi.fn(() => Promise.resolve(true)) } as unknown as MfaService,
    {
      issue,
      consumeReleaseToken: vi.fn(() => Promise.resolve(true)),
      canRelease: vi.fn(() => Promise.resolve(true)),
      poolSessions: vi.fn(() =>
        Promise.resolve([
          { sessionId: OTHER_SESSION, userId: 'otra-persona', tenantId: 'tenant-1' },
        ]),
      ),
      releaseSession,
    } as unknown as SeatService,
    {
      create: createChallenge,
      reserveAttempt: vi.fn(() =>
        Promise.resolve({ kind: 'reserved', attempt: 1, attemptsLeft: 4, locksAccount: false }),
      ),
      consume: vi.fn(() => Promise.resolve(true)),
    } as unknown as MfaChallengeService,
    { use: useDevice, create: vi.fn() } as unknown as TrustedDeviceService,
    { registerFailure, registerSuccess, clearFailures } as unknown as LoginAttemptsService,
    { remindRequiredReset } as unknown as PasswordResetService,
  );
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

const login = (extra: { trustedDeviceToken?: string } = {}) =>
  build().login({ email: 'ana@agencia.co', password: 'contraseña-vieja-12', ...extra });

describe('AuthService.login con el cambio de contraseña pendiente', () => {
  beforeAll(() => {
    process.env['JWT_SECRET'] ??= 'j'.repeat(40);
    jwt.onModuleInit();
  });

  beforeEach(() => {
    user = {
      id: USER,
      password_hash: 'hash',
      status: 'active',
      locked_until: null,
      mfa_enabled_at: null,
      password_reset_required_at: new Date('2026-10-13T10:00:00.000Z'),
      password_changed_at: null,
      last_tenant_id: null,
    };
    passwordOk = true;
    events = [];
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
    createChallenge = vi.fn(() =>
      Promise.resolve({ id: randomUUID(), expiresAt: new Date(Date.now() + 300_000) }),
    );
    useDevice = vi.fn(() => Promise.resolve(true));
    remindRequiredReset = vi.fn(() => Promise.resolve({ linkSent: true }));
    releaseSession = vi.fn(() => Promise.resolve(true));
  });

  it('con la contraseña correcta: 403 PASSWORD_RESET_REQUIRED, sin sesión ni puesto', async () => {
    const err = await rejection(login());

    expect(err).toBeInstanceOf(PasswordResetRequiredError);
    const typed = err as PasswordResetRequiredError;
    expect(typed.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(typed.reason).toBe('PASSWORD_RESET_REQUIRED');
    expect(typed.message).toBe(
      'Tienes que elegir una contraseña nueva: te enviamos un enlace a tu correo.',
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('no es un fallo: no suma al bloqueo ni lo limpia', async () => {
    await rejection(login());
    expect(registerFailure).not.toHaveBeenCalled();
    expect(registerSuccess).not.toHaveBeenCalled();
    expect(clearFailures).not.toHaveBeenCalled();
    expect(events.map((e) => e.eventType)).not.toContain('auth.login.failed');
  });

  it('pide el reenvío del enlace y deja el rastro con si salió', async () => {
    await rejection(login());
    expect(remindRequiredReset).toHaveBeenCalledWith(USER);
    expect(events).toEqual([
      {
        eventType: 'auth.login.password_reset_required',
        actorUserId: USER,
        aggregateType: 'user',
        aggregateId: USER,
        payload: { linkSent: true },
      },
    ]);

    remindRequiredReset.mockResolvedValue({ linkSent: false });
    events = [];
    await rejection(login());
    expect(events[0]?.payload).toEqual({ linkSent: false });
  });

  it('si el reenvío falla, el 403 sale igual', async () => {
    remindRequiredReset.mockRejectedValue(new Error('la base no contestó'));

    expect(await rejection(login())).toBeInstanceOf(PasswordResetRequiredError);
    expect(events[0]?.payload).toEqual({ linkSent: false });
  });

  it('con 2FA: nunca llega al desafío ni al equipo de confianza', async () => {
    user.mfa_enabled_at = new Date('2026-09-01T00:00:00.000Z');

    expect(await rejection(login({ trustedDeviceToken: 'equipo-de-confianza' }))).toBeInstanceOf(
      PasswordResetRequiredError,
    );
    expect(createChallenge).not.toHaveBeenCalled();
    expect(useDevice).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('con la contraseña incorrecta: el 401 de siempre, que cuenta, y no se le reenvía nada', async () => {
    passwordOk = false;

    const err = await rejection(login());
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(PasswordResetRequiredError);
    expect(registerFailure).toHaveBeenCalledWith(USER);
    expect(remindRequiredReset).not.toHaveBeenCalled();
  });

  it('suspendida: el 401 genérico (el estado se mira antes que la marca)', async () => {
    user.status = 'suspended';

    const err = await rejection(login());
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe('invalid credentials');
    expect(remindRequiredReset).not.toHaveBeenCalled();
  });

  it('bloqueada por intentos: el 401 de siempre, sin mirar la contraseña ni la marca', async () => {
    user.locked_until = new Date(Date.now() + 600_000);

    expect(await rejection(login())).toBeInstanceOf(UnauthorizedException);
    expect(remindRequiredReset).not.toHaveBeenCalled();
  });

  it('sin la marca, el ingreso sigue como siempre', async () => {
    user.password_reset_required_at = null;

    const res = await login();
    expect(res).toMatchObject({ userId: USER, tenantId: 'tenant-1' });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(remindRequiredReset).not.toHaveBeenCalled();
  });

  it('marcada en medio del paso del código: el desafío ya emitido tampoco abre sesión', async () => {
    user.password_reset_required_at = null;
    user.mfa_enabled_at = new Date('2026-09-01T00:00:00.000Z');
    const auth = build();
    const challenge = (await auth.login({
      email: 'ana@agencia.co',
      password: 'contraseña-vieja-12',
    })) as { mfaToken: string };
    expect(challenge.mfaToken).toBeTruthy();

    // El admin fuerza el cambio mientras la persona busca el código.
    user.password_reset_required_at = new Date();

    expect(await rejection(auth.completeMfa(challenge.mfaToken, '123456'))).toBeInstanceOf(
      PasswordResetRequiredError,
    );
    expect(issue).not.toHaveBeenCalled();
    expect(remindRequiredReset).toHaveBeenCalledWith(USER);
  });

  it('marcada antes de liberar un puesto: 403 sin desconectar a nadie ni abrir sesión', async () => {
    const { token } = await jwt.signSeatRelease({
      userId: USER,
      poolTenantId: 'tenant-1',
      tenantId: 'tenant-1',
      mfa: false,
      remember: false,
      jti: randomUUID(),
    });

    expect(await rejection(build().releaseSeat(token, OTHER_SESSION))).toBeInstanceOf(
      PasswordResetRequiredError,
    );
    expect(releaseSession).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(remindRequiredReset).toHaveBeenCalledWith(USER);
  });

  it('sin la marca, liberar un puesto desconecta a la otra persona y abre la sesión', async () => {
    user.password_reset_required_at = null;
    const { token } = await jwt.signSeatRelease({
      userId: USER,
      poolTenantId: 'tenant-1',
      tenantId: 'tenant-1',
      mfa: false,
      remember: false,
      jti: randomUUID(),
    });

    expect(await build().releaseSeat(token, OTHER_SESSION)).toMatchObject({ userId: USER });
    expect(releaseSession).toHaveBeenCalledWith(OTHER_SESSION, expect.any(String));
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
