import { HttpStatus, type ExecutionContext, type HttpException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { MfaRecentRequiredError, MfaRequiredForActionError } from '../auth/auth-errors.js';
import { REQUIRE_RECENT_MFA_KEY } from '../auth/decorators/require-recent-mfa.decorator.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RecentMfaGuard } from '../auth/guards/recent-mfa.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { IpThrottlerGuard } from '../throttler/ip-throttler.guard.js';
import { LEGACY_RESET_BATCH_MAX, RequireLegacyResetSchema } from './dto.js';
import {
  LEGACY_RESET_BATCHES_PER_MINUTE,
  LegacyPasswordsController,
} from './legacy-passwords.controller.js';
import type { LegacyPasswordsService } from './legacy-passwords.service.js';

/*
 * El borde de las cuentas heredadas (USR-14): las rutas, quién llega, que forzar pide el 2FA de los
 * últimos 10 minutos y un tope por minuto, y el cuerpo. Lo que hace cada una lo prueban
 * legacy-passwords.service.test.ts y, contra Postgres, legacy-passwords.integration.test.ts.
 */

const USUARIO = '99999999-9999-4999-8999-999999999999';
const ANA = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const MIN = 60_000;

type Handler = (...args: never[]) => unknown;
const proto = LegacyPasswordsController.prototype as unknown as Record<
  'list' | 'requireReset',
  Handler
>;

function contextFor(handler: Handler, req: unknown = {}, res: unknown = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => LegacyPasswordsController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function controller() {
  const legacy = {
    list: vi.fn(() => Promise.resolve({ users: [], truncated: false })),
    requireReset: vi.fn(() =>
      Promise.resolve({
        results: [],
        counts: { sent: 0, emailFailed: 0, skipped: 0, failed: 0 },
      }),
    ),
  };
  return {
    ctrl: new LegacyPasswordsController(legacy as unknown as LegacyPasswordsService),
    legacy,
  };
}

describe('las rutas y quién llega', () => {
  it('cuelgan de /admin/legacy-passwords, no de la ficha de una persona; forzar responde 200', () => {
    expect(Reflect.getMetadata(PATH_METADATA, LegacyPasswordsController)).toBe(
      'admin/legacy-passwords',
    );
    expect(Reflect.getMetadata(PATH_METADATA, proto.list)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.list)).toBe(0); // GET
    expect(Reflect.getMetadata(PATH_METADATA, proto.requireReset)).toBe('require-reset');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.requireReset)).toBe(1); // POST
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.requireReset)).toBe(200);
    expect(Reflect.getMetadata(ROLES_KEY, LegacyPasswordsController)).toEqual([
      ...AGENCY_ADMIN_ROLES,
    ]);
  });

  it('un vendedor o un cliente no llegan; un admin de nodo y la plataforma sí (después decide el servicio)', () => {
    const roles = new RolesGuard(new Reflector());
    const allowed = (role: Role, handler: Handler) =>
      requestContextStorage.run({ userId: USUARIO, role }, () => {
        try {
          return roles.canActivate(contextFor(handler));
        } catch {
          return false;
        }
      });
    for (const handler of [proto.list, proto.requireReset]) {
      expect(allowed('vendedor', handler)).toBe(false);
      expect(allowed('cliente_final', handler)).toBe(false);
      expect(allowed('agency_admin', handler)).toBe(true);
      expect(allowed('superadmin', handler)).toBe(true);
    }
  });

  it('sin sesión, 401 sin llegar al servicio', async () => {
    const { ctrl, legacy } = controller();
    await expect(ctrl.list(undefined)).rejects.toMatchObject({ status: 401 });
    await expect(ctrl.requireReset(undefined, { userIds: [USUARIO] })).rejects.toMatchObject({
      status: 401,
    });
    expect(legacy.list).not.toHaveBeenCalled();
    expect(legacy.requireReset).not.toHaveBeenCalled();
  });

  it('pasa quién pide y los ids al servicio', async () => {
    const { ctrl, legacy } = controller();
    await ctrl.list(USUARIO);
    expect(legacy.list).toHaveBeenCalledWith(USUARIO);
    await ctrl.requireReset(USUARIO, { userIds: [ANA.toLowerCase()] });
    expect(legacy.requireReset).toHaveBeenCalledWith(USUARIO, [ANA.toLowerCase()]);
  });
});

describe('alto impacto: forzar pide el 2FA de los últimos 10 minutos (D1 = C)', () => {
  const reflector = new Reflector();
  const guard = new RecentMfaGuard(reflector);
  const admin = (minutes: number | null, mfaEnabled = true): RequestContext => ({
    userId: USUARIO,
    role: 'superadmin',
    mfaRequired: true,
    mfaEnabled,
    mfaVerified: minutes !== null,
    ...(minutes === null ? {} : { mfaVerifiedAt: new Date(Date.now() - minutes * MIN) }),
  });
  const run = (handler: Handler, ctx: RequestContext) =>
    requestContextStorage.run(ctx, () => {
      try {
        return guard.canActivate(contextFor(handler));
      } catch (err) {
        return err;
      }
    });

  it('forzar: con más de 10 minutos pide el código; sin 2FA activo, que lo active', () => {
    expect(reflector.get(REQUIRE_RECENT_MFA_KEY, proto.requireReset)).toBe(10);
    expect(run(proto.requireReset, admin(30))).toBeInstanceOf(MfaRecentRequiredError);
    expect(run(proto.requireReset, admin(11))).toBeInstanceOf(MfaRecentRequiredError);
    expect(run(proto.requireReset, admin(2))).toBe(true);
    expect(run(proto.requireReset, admin(null, false))).toBeInstanceOf(MfaRequiredForActionError);
  });

  it('ver la lista no lo pide: sólo lee', () => {
    expect(reflector.get(REQUIRE_RECENT_MFA_KEY, proto.list)).toBeUndefined();
    expect(run(proto.list, admin(30))).toBe(true);
  });
});

describe('como mucho 12 lotes por minuto', () => {
  it('alcanzan para la lista entera aunque el primero lo frene el 2FA; el decimotercero es 429', async () => {
    // 500 cuentas en lotes de 50 son 10 pedidos, más el que frena el 2FA y se repite tras el código.
    expect(LEGACY_RESET_BATCHES_PER_MINUTE).toBe(12);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.requireReset)).toBe(12);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto.requireReset)).toBe(60_000);

    const guard = new IpThrottlerGuard(
      { throttlers: [{ ttl: 60_000, limit: 300 }] },
      new ThrottlerStorageService(),
      new Reflector(),
    );
    await guard.onModuleInit();
    const req = { ip: '172.18.0.2', headers: { 'x-edge-peer-ip': '190.24.8.9' } };
    const res = { header: vi.fn() };
    for (let i = 0; i < 12; i += 1) {
      await expect(guard.canActivate(contextFor(proto.requireReset, req, res))).resolves.toBe(true);
    }
    const thirteenth = await guard
      .canActivate(contextFor(proto.requireReset, req, res))
      .catch((e: unknown) => e);
    expect(thirteenth).toBeInstanceOf(ThrottlerException);
    expect((thirteenth as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });
});

describe('el cuerpo: RequireLegacyResetSchema', () => {
  it('ids en minúsculas', () => {
    expect(RequireLegacyResetSchema.parse({ userIds: [ANA] })).toEqual({
      userIds: [ANA.toLowerCase()],
    });
  });

  it(`de 1 a ${LEGACY_RESET_BATCH_MAX}; otra cosa o campos de más, 400`, () => {
    const ids = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      );
    expect(
      RequireLegacyResetSchema.safeParse({ userIds: ids(LEGACY_RESET_BATCH_MAX) }).success,
    ).toBe(true);
    expect(
      RequireLegacyResetSchema.safeParse({ userIds: ids(LEGACY_RESET_BATCH_MAX + 1) }).success,
    ).toBe(false);
    expect(RequireLegacyResetSchema.safeParse({ userIds: [] }).success).toBe(false);
    expect(RequireLegacyResetSchema.safeParse({ userIds: ['no-es-un-id'] }).success).toBe(false);
    expect(RequireLegacyResetSchema.safeParse({}).success).toBe(false);
    expect(RequireLegacyResetSchema.safeParse({ userIds: [ANA], password: 'x' }).success).toBe(
      false,
    );
  });
});
