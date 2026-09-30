import { ForbiddenException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { TenantNotOperableError } from './auth-errors.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import type { LoginAttemptsService } from './login-attempts.service.js';
import type { MfaChallengeService } from './mfa-challenge.service.js';
import type { MfaService } from './mfa.service.js';
import type { PasswordService } from './password.service.js';
import type { SeatService } from './seat.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';

/**
 * Con qué agencia se abre la sesión (login) y el cambio de agencia, con dobles: la última con la
 * que operó gana si sigue operando, un nodo suspendido no se ofrece ni se abre, y la elección
 * queda recordada. Contra Postgres lo cubre tenant-switch.integration.test.ts.
 */

type Call = readonly [method: string, args: readonly unknown[]];

/** Consulta de Kysely de mentira que anota cada método llamado; cualquier cadena termina en `rows`. */
function query(rows: unknown[], calls: Call[], failOn?: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'execute') return () => Promise.resolve(rows);
        if (prop === 'executeTakeFirst') return () => Promise.resolve(rows[0]);
        return (...args: unknown[]) => {
          calls.push([String(prop), args]);
          if (failOn && prop === failOn) throw new Error(`falla simulada en ${failOn}`);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

interface MembershipFixture {
  tenant_id: string;
  role: string;
  operable: boolean;
}

const USER = 'user-1';
const jwt = new JwtService();

let memberships: MembershipFixture[];
let lastTenantId: string | null;
let userCalls: Call[];
let failUserUpdate: boolean;
let issue: ReturnType<typeof vi.fn>;

function build(): AuthService {
  const db = {
    get db() {
      return query(
        [
          {
            id: USER,
            password_hash: 'hash',
            status: 'active',
            locked_until: null,
            mfa_enabled_at: null,
            last_tenant_id: lastTenantId,
          },
        ],
        userCalls,
        failUserUpdate ? 'set' : undefined,
      );
    },
    withRequestContext: (_ctx: unknown, fn: (trx: unknown) => Promise<unknown>) =>
      fn(query(memberships, [])),
  } as unknown as DatabaseService;
  return new AuthService(
    db,
    jwt,
    { verify: vi.fn(() => Promise.resolve(true)) } as unknown as PasswordService,
    { emit: vi.fn(() => Promise.resolve()) } as unknown as AuditService,
    {} as MailerService,
    { snapshot: vi.fn(() => Promise.resolve({ mfaVerified: true })) } as unknown as SessionService,
    {} as MfaService,
    { issue } as unknown as SeatService,
    {} as MfaChallengeService,
    {} as TrustedDeviceService,
    {
      registerSuccess: vi.fn(() => Promise.resolve()),
      registerFailure: vi.fn(() => Promise.resolve({ locked: false })),
    } as unknown as LoginAttemptsService,
  );
}

/** El `last_tenant_id` que se escribió en `users`, o `undefined` si no se tocó. */
function rememberedTenant(): unknown {
  const set = userCalls.find(([method]) => method === 'set');
  return (set?.[1][0] as { last_tenant_id?: unknown } | undefined)?.last_tenant_id;
}

async function login(): Promise<AuthResult> {
  return (await build().login({ email: 'a@b.co', password: 'x'.repeat(12) })) as AuthResult;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

beforeAll(() => {
  process.env['JWT_SECRET'] ??= 'j'.repeat(40);
  jwt.onModuleInit();
});

beforeEach(() => {
  memberships = [
    { tenant_id: 't-oldest', role: 'vendedor', operable: true },
    { tenant_id: 't-newest', role: 'admin', operable: true },
  ];
  lastTenantId = null;
  userCalls = [];
  failUserUpdate = false;
  issue = vi.fn(() =>
    Promise.resolve({
      sessionId: '00000000-0000-4000-8000-000000000001',
      expiresAt: new Date(Date.now() + 60_000),
      idleTimeoutSeconds: 1800,
      seatTenantId: null,
    }),
  );
});

describe('AuthService: agencia con la que abre el login', () => {
  it('sin agencia recordada, la más antigua que opera', async () => {
    const res = await login();
    expect(res.tenantId).toBe('t-oldest');
    expect(res.role).toBe('vendedor');
  });

  it('la última con la que operó, aunque no sea la más antigua', async () => {
    lastTenantId = 't-newest';
    const res = await login();
    expect(res.tenantId).toBe('t-newest');
    expect(res.role).toBe('admin');
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-newest' }));
  });

  it('si la última quedó suspendida, la más antigua que opera', async () => {
    memberships = [
      { tenant_id: 't-suspended', role: 'admin', operable: false },
      { tenant_id: 't-ok', role: 'vendedor', operable: true },
    ];
    lastTenantId = 't-suspended';
    expect((await login()).tenantId).toBe('t-ok');
  });

  it('recuerda la agencia con la que abrió la sesión', async () => {
    lastTenantId = 't-newest';
    await login();
    expect(rememberedTenant()).toBe('t-newest');
    expect(userCalls.some(([m, args]) => m === 'updateTable' && args[0] === 'users')).toBe(true);
  });

  it('si recordar falla, el ingreso sigue', async () => {
    failUserUpdate = true;
    const res = await login();
    expect(res.token).toEqual(expect.any(String));
    expect(res.tenantId).toBe('t-oldest');
  });

  it('sin memberships activas, sesión sin tenant y nada que recordar', async () => {
    memberships = [];
    const res = await login();
    expect(res.tenantId).toBeUndefined();
    expect(rememberedTenant()).toBeUndefined();
  });
});

describe('AuthService.switchTenant', () => {
  const CURRENT_SESSION = '00000000-0000-4000-8000-0000000000aa';

  it('cambia, reemplaza la sesión actual con su segundo factor y recuerda el destino', async () => {
    memberships = [{ tenant_id: 't-dest', role: 'admin', operable: true }];
    const res = await build().switchTenant(USER, 't-dest', CURRENT_SESSION);

    expect(res).toMatchObject({ tenantId: 't-dest', role: 'admin', userId: USER });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't-dest',
        mfaVerified: true,
        current: { sessionId: CURRENT_SESSION, reason: 'tenant_switched' },
      }),
    );
    expect(rememberedTenant()).toBe('t-dest');
  });

  it('a una agencia suspendida (ella o un ancestro): 403 TENANT_SUSPENDED sin tocar la sesión', async () => {
    memberships = [{ tenant_id: 't-dest', role: 'admin', operable: false }];
    const err = await rejection(build().switchTenant(USER, 't-dest', CURRENT_SESSION));

    expect(err).toBeInstanceOf(TenantNotOperableError);
    expect((err as TenantNotOperableError).getStatus()).toBe(403);
    expect((err as TenantNotOperableError).reason).toBe('TENANT_SUSPENDED');
    expect(issue).not.toHaveBeenCalled();
    expect(rememberedTenant()).toBeUndefined();
  });

  it('sin membership activa en el destino: 403 sin emitir nada', async () => {
    memberships = [];
    const err = await rejection(build().switchTenant(USER, 't-ajeno', CURRENT_SESSION));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(TenantNotOperableError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('con el cupo del destino lleno, el 409 sube tal cual y no se recuerda el destino', async () => {
    memberships = [{ tenant_id: 't-dest', role: 'admin', operable: true }];
    const full = Object.assign(new Error('Los 3 puestos de Destino están en uso.'), {
      reason: 'SEATS_FULL',
    });
    issue.mockRejectedValueOnce(full);

    await expect(build().switchTenant(USER, 't-dest', CURRENT_SESSION)).rejects.toBe(full);
    expect(rememberedTenant()).toBeUndefined();
  });
});
