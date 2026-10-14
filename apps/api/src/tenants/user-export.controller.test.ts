import { HttpStatus, type ExecutionContext, type HttpException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { EXPORT_ROWS_HEADER, EXPORT_TRUNCATED_HEADER } from '../audit/admin-audit.controller.js';
import { MfaRecentRequiredError, MfaRequiredForActionError } from '../auth/auth-errors.js';
import { REQUIRE_RECENT_MFA_KEY } from '../auth/decorators/require-recent-mfa.decorator.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RecentMfaGuard } from '../auth/guards/recent-mfa.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { IpThrottlerGuard } from '../throttler/ip-throttler.guard.js';
import { PlatformUsersExportQuerySchema } from './dto.js';
import { TenantNotManagedError } from './tenant-admin.policy.js';
import { EXPORT_USERS_HEADER, UserExportController } from './user-export.controller.js';
import type { UserExportService, UsersExport } from './user-export.service.js';

/*
 * El borde de la exportación de usuarios (USR-16): quién llega a cada ruta, que las dos piden el 2FA
 * de los últimos 10 minutos y un tope de 5 por minuto, y qué cabeceras salen. Lo que sale en el
 * archivo lo prueban user-export.service.test.ts y, contra Postgres, user-export.integration.test.ts.
 */

const USUARIO = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const MIN = 60_000;

type Handler = (...args: never[]) => unknown;
const proto = UserExportController.prototype as unknown as Record<
  'exportPlatform' | 'exportTeam',
  Handler
>;

function contextFor(handler: Handler, req: unknown = {}, res: unknown = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => UserExportController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const FILE: UsersExport = {
  csv: '﻿Correo\r\n',
  filename: 'usuarios-2026-10-13.csv',
  users: 3,
  rows: 4,
  truncated: true,
};

function controller(opts: { superadmin?: boolean; manages?: boolean } = {}) {
  const network = {
    isSuperadmin: vi.fn(() => Promise.resolve(opts.superadmin ?? true)),
    canManageTenant: vi.fn(() => Promise.resolve(opts.manages ?? true)),
  };
  const exports = {
    exportPlatform: vi.fn(() => Promise.resolve(FILE)),
    exportTeam: vi.fn(() =>
      Promise.resolve({ ...FILE, filename: 'equipo-norte-2026-10-13.csv', truncated: false }),
    ),
  };
  const headers = new Map<string, string>();
  const res = { setHeader: (k: string, v: string) => headers.set(k, v) };
  const ctrl = new UserExportController(
    exports as unknown as UserExportService,
    network as unknown as NetworkService,
  );
  return { ctrl, network, exports, headers, res: res as never };
}

describe('las rutas y quién llega', () => {
  it('no terminan en .csv ni chocan con la ficha de una persona', () => {
    expect(Reflect.getMetadata(PATH_METADATA, UserExportController)).toBe('/');
    expect(Reflect.getMetadata(PATH_METADATA, proto.exportPlatform)).toBe('admin/exports/users');
    expect(Reflect.getMetadata(PATH_METADATA, proto.exportTeam)).toBe('tenants/:id/members-export');
    expect(Reflect.getMetadata(ROLES_KEY, UserExportController)).toEqual([...AGENCY_ADMIN_ROLES]);
  });

  it('un vendedor o un cliente no llegan; un admin de nodo y la plataforma sí (después decide la ruta)', () => {
    const roles = new RolesGuard(new Reflector());
    const allowed = (role: Role, handler: Handler) =>
      requestContextStorage.run({ userId: USUARIO, role }, () => {
        try {
          return roles.canActivate(contextFor(handler));
        } catch {
          return false;
        }
      });
    for (const handler of [proto.exportPlatform, proto.exportTeam]) {
      expect(allowed('vendedor', handler)).toBe(false);
      expect(allowed('cliente_final', handler)).toBe(false);
      expect(allowed('agency_admin', handler)).toBe(true);
      expect(allowed('superadmin', handler)).toBe(true);
    }
  });
});

describe('alto impacto: el 2FA de los últimos 10 minutos (D1 = C)', () => {
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

  it.each([
    ['exportPlatform', proto.exportPlatform],
    ['exportTeam', proto.exportTeam],
  ])('%s pide el código si pasaron más de 10 minutos', (_name, handler) => {
    expect(reflector.get(REQUIRE_RECENT_MFA_KEY, handler)).toBe(10);
    expect(run(handler, admin(30))).toBeInstanceOf(MfaRecentRequiredError);
    expect(run(handler, admin(11))).toBeInstanceOf(MfaRecentRequiredError);
    expect(run(handler, admin(2))).toBe(true);
    // Sin el 2FA activo no hay código que pedirle: tiene que activarlo.
    expect(run(handler, admin(null, false))).toBeInstanceOf(MfaRequiredForActionError);
  });
});

describe('como mucho 5 exportaciones por minuto', () => {
  it.each([
    ['exportPlatform', proto.exportPlatform],
    ['exportTeam', proto.exportTeam],
  ])('%s: la sexta en el minuto es 429', async (_name, handler) => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);

    // El guard de la app, con el tope global de app.module (300) y la marca de la ruta.
    const guard = new IpThrottlerGuard(
      { throttlers: [{ ttl: 60_000, limit: 300 }] },
      new ThrottlerStorageService(),
      new Reflector(),
    );
    await guard.onModuleInit();
    const req = { ip: '172.18.0.2', headers: { 'x-edge-peer-ip': '190.24.8.9' } };
    const res = { header: vi.fn() };
    for (let i = 0; i < 5; i += 1) {
      await expect(guard.canActivate(contextFor(handler, req, res))).resolves.toBe(true);
    }
    const sixth = await guard.canActivate(contextFor(handler, req, res)).catch((e: unknown) => e);
    expect(sixth).toBeInstanceOf(ThrottlerException);
    expect((sixth as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });
});

describe('GET /admin/exports/users: el directorio, sólo el superadmin', () => {
  it('el archivo con su nombre, cuántas personas y filas, y si se cortó', async () => {
    const { ctrl, exports, headers, res } = controller();
    const query = PlatformUsersExportQuerySchema.parse({ role: 'vendedor' });
    await expect(ctrl.exportPlatform(USUARIO, query, res)).resolves.toBe(FILE.csv);
    expect(exports.exportPlatform).toHaveBeenCalledWith(USUARIO, query);
    expect(Object.fromEntries(headers)).toEqual({
      // El tipo sólo en éxito: un 403 del handler sale como JSON, no rotulado como CSV.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="usuarios-2026-10-13.csv"',
      [EXPORT_USERS_HEADER]: '3',
      [EXPORT_ROWS_HEADER]: '4',
      [EXPORT_TRUNCATED_HEADER]: 'true',
    });
  });

  it('quien no es superadmin recibe 403 y no se lee nada; sin sesión, 401', async () => {
    const { ctrl, exports, headers, res } = controller({ superadmin: false });
    const query = PlatformUsersExportQuerySchema.parse({});
    await expect(ctrl.exportPlatform(USUARIO, query, res)).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
    await expect(ctrl.exportPlatform(undefined, query, res)).rejects.toMatchObject({
      status: 401,
    });
    expect(exports.exportPlatform).not.toHaveBeenCalled();
    // Ninguna cabecera de la descarga: el error sale como JSON.
    expect(headers.size).toBe(0);
  });
});

describe('GET /tenants/:id/members-export: el equipo, para quien administra el nodo', () => {
  it('el archivo del equipo', async () => {
    const { ctrl, exports, network, headers, res } = controller();
    await expect(ctrl.exportTeam(USUARIO, NODO, res)).resolves.toBe(FILE.csv);
    expect(network.canManageTenant).toHaveBeenCalledWith(USUARIO, NODO);
    expect(exports.exportTeam).toHaveBeenCalledWith(USUARIO, NODO);
    expect(headers.get('Content-Disposition')).toBe(
      'attachment; filename="equipo-norte-2026-10-13.csv"',
    );
    expect(headers.get(EXPORT_TRUNCATED_HEADER)).toBe('false');
  });

  it('un nodo fuera de su subárbol: 403 TENANT_NOT_MANAGED sin leer nada; sin sesión, 401', async () => {
    const { ctrl, exports, res } = controller({ manages: false });
    await expect(ctrl.exportTeam(USUARIO, NODO, res)).rejects.toBeInstanceOf(TenantNotManagedError);
    await expect(ctrl.exportTeam(undefined, NODO, res)).rejects.toMatchObject({ status: 401 });
    expect(exports.exportTeam).not.toHaveBeenCalled();
  });
});
