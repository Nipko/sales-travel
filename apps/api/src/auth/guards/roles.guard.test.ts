import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { Role } from '../../database/database.types.js';
import {
  requestContextStorage,
  type RequestContext,
} from '../../request-context/request-context.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../roles.js';
import { RolesGuard } from './roles.guard.js';

/** Reflector de mentira: devuelve la metadata que el test declare, sin Nest de por medio. */
function reflectorWith(meta: { roles?: Role[]; isPublic?: boolean }): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return meta.isPublic;
      if (key === ROLES_KEY) return meta.roles;
      return undefined;
    },
  } as unknown as Reflector;
}

const ctx = {
  getHandler: () => () => undefined,
  getClass: () => class {},
} as unknown as ExecutionContext;

function runAs(context: RequestContext, fn: () => boolean): boolean {
  return requestContextStorage.run(context, fn);
}

describe('RolesGuard', () => {
  it('deja pasar las rutas públicas sin mirar roles', () => {
    const guard = new RolesGuard(reflectorWith({ isPublic: true, roles: [...AGENCY_ADMIN_ROLES] }));
    expect(runAs({}, () => guard.canActivate(ctx))).toBe(true);
  });

  it('no opina cuando el handler no declara @Roles', () => {
    const guard = new RolesGuard(reflectorWith({}));
    expect(runAs({ userId: 'u1', role: 'cliente_final' }, () => guard.canActivate(ctx))).toBe(true);
  });

  it('rechaza sin usuario autenticado', () => {
    const guard = new RolesGuard(reflectorWith({ roles: [...SELLING_ROLES] }));
    expect(() => runAs({}, () => guard.canActivate(ctx))).toThrow(UnauthorizedException);
  });

  it('rechaza a un autenticado sin membership activa en el tenant del request', () => {
    const guard = new RolesGuard(reflectorWith({ roles: [...SELLING_ROLES] }));
    expect(() => runAs({ userId: 'u1' }, () => guard.canActivate(ctx))).toThrow(ForbiddenException);
  });

  it('permite al rol listado', () => {
    const guard = new RolesGuard(reflectorWith({ roles: [...SELLING_ROLES] }));
    expect(runAs({ userId: 'u1', role: 'vendedor' }, () => guard.canActivate(ctx))).toBe(true);
  });

  it('rechaza al rol no listado', () => {
    const guard = new RolesGuard(reflectorWith({ roles: [...AGENCY_ADMIN_ROLES] }));
    expect(() => runAs({ userId: 'u1', role: 'vendedor' }, () => guard.canActivate(ctx))).toThrow(
      ForbiddenException,
    );
  });

  it('cliente_final no alcanza ningún endpoint de gestión', () => {
    for (const roles of [SELLING_ROLES, AGENCY_ADMIN_ROLES]) {
      const guard = new RolesGuard(reflectorWith({ roles: [...roles] }));
      expect(() =>
        runAs({ userId: 'u1', role: 'cliente_final' }, () => guard.canActivate(ctx)),
      ).toThrow(ForbiddenException);
    }
  });

  it('los roles de plataforma pasan aunque no estén listados: su alcance es global', () => {
    const guard = new RolesGuard(reflectorWith({ roles: ['vendedor'] }));
    for (const role of ['superadmin', 'platform_admin'] as Role[]) {
      expect(runAs({ userId: 'u1', role }, () => guard.canActivate(ctx))).toBe(true);
    }
  });

  it('usa el rol EFECTIVO del contexto, no el del token', () => {
    // Un tenant_admin en su agencia que entra como vendedor a otra: el contexto resuelve
    // `vendedor` contra la base y el guard debe negarle la gestión en ESE tenant.
    const guard = new RolesGuard(reflectorWith({ roles: [...AGENCY_ADMIN_ROLES] }));
    expect(() =>
      runAs({ userId: 'u1', tenantId: 't2', role: 'vendedor' }, () => guard.canActivate(ctx)),
    ).toThrow(ForbiddenException);
  });
});
