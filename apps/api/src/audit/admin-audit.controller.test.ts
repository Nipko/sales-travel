import { type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { MfaRecentRequiredError } from '../auth/auth-errors.js';
import { REQUIRE_RECENT_MFA_KEY } from '../auth/decorators/require-recent-mfa.decorator.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RecentMfaGuard } from '../auth/guards/recent-mfa.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import {
  AdminAuditController,
  EXPORT_ROWS_HEADER,
  EXPORT_TRUNCATED_HEADER,
} from './admin-audit.controller.js';
import { AdminAuditExportQuerySchema, AdminAuditQuerySchema } from './admin-audit.schemas.js';
import type { AdminAuditService } from './admin-audit.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const MIN = 60_000;

type Handler = (...args: never[]) => unknown;
const proto = AdminAuditController.prototype as unknown as Record<'list' | 'export', Handler>;

function contextFor(handler: Handler = proto.list): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => AdminAuditController,
  } as unknown as ExecutionContext;
}

describe('AdminAuditController: GET /admin/audit y /admin/audit/export, sólo el superadmin', () => {
  it('la ruta y la guarda de la clase entera', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminAuditController)).toBe('admin/audit');
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAuditController)).toEqual([SuperadminGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminAuditController)).toEqual([...PLATFORM_ROLES]);
    expect(Reflect.getMetadata(PATH_METADATA, proto.export)).toBe('export');
  });

  it('un rol de nodo no llega; platform_admin pasa RolesGuard pero SuperadminGuard lo frena', async () => {
    const roles = new RolesGuard(new Reflector());
    const allowed = (role: Role) =>
      requestContextStorage.run({ userId: USUARIO, role }, () => {
        try {
          return roles.canActivate(contextFor());
        } catch {
          return false;
        }
      });
    expect(allowed('tenant_admin')).toBe(false);
    expect(allowed('consolidator_admin')).toBe(false);
    expect(allowed('agency_admin')).toBe(false);
    expect(allowed('superadmin')).toBe(true);

    const network = { isSuperadmin: vi.fn(() => Promise.resolve(false)) };
    const superadmin = new SuperadminGuard(network as unknown as NetworkService);
    await requestContextStorage.run({ userId: USUARIO, role: 'platform_admin' }, async () => {
      expect(roles.canActivate(contextFor())).toBe(true);
      await expect(superadmin.canActivate(contextFor())).rejects.toBeInstanceOf(
        SuperadminRequiredError,
      );
    });
  });

  it('exportar pide el 2FA de los últimos 10 minutos; listar no', () => {
    const reflector = new Reflector();
    expect(reflector.get(REQUIRE_RECENT_MFA_KEY, proto.export)).toBe(10);
    expect(reflector.get(REQUIRE_RECENT_MFA_KEY, proto.list)).toBeUndefined();

    const guard = new RecentMfaGuard(reflector);
    const superadmin = (minutes: number): RequestContext => ({
      userId: USUARIO,
      role: 'superadmin',
      mfaRequired: true,
      mfaEnabled: true,
      mfaVerified: true,
      mfaVerifiedAt: new Date(Date.now() - minutes * MIN),
    });
    const run = (handler: Handler, ctx: RequestContext) =>
      requestContextStorage.run(ctx, () => {
        try {
          return guard.canActivate(contextFor(handler));
        } catch (err) {
          return err;
        }
      });
    expect(run(proto.export, superadmin(30))).toBeInstanceOf(MfaRecentRequiredError);
    expect(run(proto.export, superadmin(2))).toBe(true);
    expect(run(proto.list, superadmin(30))).toBe(true);
  });

  it('listar: la página del servicio, con su id como actor', async () => {
    const audit = { list: vi.fn(() => Promise.resolve({ events: [], nextCursor: null })) };
    const controller = new AdminAuditController(audit as unknown as AdminAuditService);
    const query = AdminAuditQuerySchema.parse({ category: 'orders' });
    await expect(controller.list(USUARIO, query)).resolves.toEqual({
      events: [],
      nextCursor: null,
    });
    expect(audit.list).toHaveBeenCalledWith(USUARIO, query);
  });

  it('exportar: el CSV con su nombre, cuántas filas y si se cortó', async () => {
    const audit = {
      exportCsv: vi.fn(() =>
        Promise.resolve({
          csv: '\uFEFFfecha\r\n',
          filename: 'actividad-2026-10-07-a-2026-10-13.csv',
          rows: 5000,
          truncated: true,
        }),
      ),
    };
    const headers = new Map<string, string>();
    const res = { setHeader: (k: string, v: string) => headers.set(k, v) };
    const controller = new AdminAuditController(audit as unknown as AdminAuditService);
    const query = AdminAuditExportQuerySchema.parse({});
    await expect(controller.export(USUARIO, query, res as never)).resolves.toBe('\uFEFFfecha\r\n');
    expect(audit.exportCsv).toHaveBeenCalledWith(USUARIO, query);
    expect(Object.fromEntries(headers)).toEqual({
      'Content-Disposition': 'attachment; filename="actividad-2026-10-07-a-2026-10-13.csv"',
      [EXPORT_ROWS_HEADER]: '5000',
      [EXPORT_TRUNCATED_HEADER]: 'true',
    });
  });
});
