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
import { SALES_OPERATION_KEY } from '../decorators/sales-operation.decorator.js';
import { AGENCY_ADMIN_ROLES, PLATFORM_ROLES, SELLING_ROLES, canSell } from '../roles.js';
import { PlatformRoleCannotSellError } from '../sales-operation-errors.js';
import { RolesGuard } from './roles.guard.js';

/** Reflector de mentira: devuelve la metadata que el test declare, sin Nest de por medio. */
function reflectorWith(meta: { roles?: Role[]; isPublic?: boolean; sale?: boolean }): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return meta.isPublic;
      if (key === ROLES_KEY) return meta.roles;
      if (key === SALES_OPERATION_KEY) return meta.sale;
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

describe('RolesGuard — operaciones de venta', () => {
  /** El error que lanza el guard, o `undefined` si deja pasar. */
  function rechazo(guard: RolesGuard, context: RequestContext): unknown {
    try {
      runAs(context, () => guard.canActivate(ctx));
      return undefined;
    } catch (err) {
      return err;
    }
  }

  it('SELLING_ROLES no tiene ningún rol de plataforma', () => {
    for (const role of PLATFORM_ROLES) {
      expect(SELLING_ROLES as readonly Role[]).not.toContain(role);
      expect(canSell(role)).toBe(false);
    }
    for (const role of SELLING_ROLES) expect(canSell(role)).toBe(true);
    expect(canSell('cliente_final')).toBe(false);
  });

  it.each<Role>(['superadmin', 'platform_admin'])(
    '%s recibe 403 con motivo y un mensaje que dice qué hacer',
    (role) => {
      const guard = new RolesGuard(reflectorWith({ sale: true, roles: [...SELLING_ROLES] }));
      const err = rechazo(guard, { userId: 'u1', role });

      expect(err).toBeInstanceOf(PlatformRoleCannotSellError);
      expect(err).toBeInstanceOf(ForbiddenException);
      const forbidden = err as PlatformRoleCannotSellError;
      expect(forbidden.getStatus()).toBe(403);
      expect(forbidden.reason).toBe('PLATFORM_ROLE_CANNOT_SELL');
      expect(forbidden.message).toBe(
        'El superadministrador no vende: usá un usuario de una sucursal',
      );
    },
  );

  it('ni listándolo en @Roles: en una venta no hay pase de plataforma', () => {
    const guard = new RolesGuard(
      reflectorWith({ sale: true, roles: ['superadmin', 'platform_admin', 'vendedor'] }),
    );
    for (const role of PLATFORM_ROLES) {
      expect(rechazo(guard, { userId: 'u1', role })).toBeInstanceOf(PlatformRoleCannotSellError);
    }
    expect(rechazo(guard, { userId: 'u1', role: 'vendedor' })).toBeUndefined();
  });

  it('sin @Roles, la venta exige igual un rol de SELLING_ROLES', () => {
    const guard = new RolesGuard(reflectorWith({ sale: true }));
    for (const role of SELLING_ROLES) {
      expect(rechazo(guard, { userId: 'u1', role })).toBeUndefined();
    }
    const cliente = rechazo(guard, { userId: 'u1', role: 'cliente_final' });
    expect(cliente).toBeInstanceOf(ForbiddenException);
    expect(cliente).not.toBeInstanceOf(PlatformRoleCannotSellError);
    expect(rechazo(guard, { userId: 'u1', role: 'superadmin' })).toBeInstanceOf(
      PlatformRoleCannotSellError,
    );
  });

  it('con @Roles, el rol tiene que estar en las dos listas', () => {
    const guard = new RolesGuard(reflectorWith({ sale: true, roles: [...AGENCY_ADMIN_ROLES] }));
    expect(rechazo(guard, { userId: 'u1', role: 'tenant_admin' })).toBeUndefined();
    const vendedor = rechazo(guard, { userId: 'u1', role: 'vendedor' });
    expect(vendedor).toBeInstanceOf(ForbiddenException);
    expect(vendedor).not.toBeInstanceOf(PlatformRoleCannotSellError);
  });

  it('una venta marcada además como pública no se abre: exige usuario y rol', () => {
    const guard = new RolesGuard(reflectorWith({ sale: true, isPublic: true }));
    expect(rechazo(guard, {})).toBeInstanceOf(UnauthorizedException);
    expect(rechazo(guard, { userId: 'u1', role: 'superadmin' })).toBeInstanceOf(
      PlatformRoleCannotSellError,
    );
    expect(rechazo(guard, { userId: 'u1', role: 'vendedor' })).toBeUndefined();
  });

  it('sin membership activa en el tenant, el 403 es el de siempre', () => {
    const guard = new RolesGuard(reflectorWith({ sale: true, roles: [...SELLING_ROLES] }));
    const err = rechazo(guard, { userId: 'u1' });
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(PlatformRoleCannotSellError);
  });

  it('el superadmin no vende ni con una membership de vendedor en una sucursal', () => {
    const guard = new RolesGuard(reflectorWith({ sale: true, roles: [...SELLING_ROLES] }));
    for (const role of SELLING_ROLES) {
      expect(rechazo(guard, { userId: 'u1', role, platformUser: true })).toBeInstanceOf(
        PlatformRoleCannotSellError,
      );
      expect(rechazo(guard, { userId: 'u1', role, platformUser: false })).toBeUndefined();
    }
  });

  it('el superadmin que entra a un nodo donde no es miembro recibe el 403 que dice qué hacer', () => {
    const guard = new RolesGuard(reflectorWith({ sale: true, roles: [...SELLING_ROLES] }));
    expect(rechazo(guard, { userId: 'u1', platformUser: true })).toBeInstanceOf(
      PlatformRoleCannotSellError,
    );
  });

  it('fuera de la venta, la marca de plataforma no cambia nada: la post-venta sigue abierta', () => {
    const guard = new RolesGuard(reflectorWith({ sale: false, roles: [...SELLING_ROLES] }));
    expect(rechazo(guard, { userId: 'u1', role: 'vendedor', platformUser: true })).toBeUndefined();
    const sinRol = rechazo(guard, { userId: 'u1', platformUser: true });
    expect(sinRol).toBeInstanceOf(ForbiddenException);
    expect(sinRol).not.toBeInstanceOf(PlatformRoleCannotSellError);
  });

  it('fuera de la venta, la plataforma sigue pasando los controles de administración', () => {
    const guard = new RolesGuard(reflectorWith({ sale: false, roles: [...AGENCY_ADMIN_ROLES] }));
    for (const role of PLATFORM_ROLES) {
      expect(rechazo(guard, { userId: 'u1', role })).toBeUndefined();
    }
  });
});
