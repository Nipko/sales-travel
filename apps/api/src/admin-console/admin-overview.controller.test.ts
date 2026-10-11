import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import {
  PLATFORM_CONSOLE_DB_DENIAL,
  PlatformConsoleScopeNotFoundError,
  PlatformConsoleSuperadminOnlyError,
  platformConsoleDbError,
} from './admin-console.errors.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewQuerySchema } from './admin-overview.schemas.js';
import type { AdminOverviewService } from './admin-overview.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';

function banco({ esSuperadmin = true } = {}) {
  const overview = { overview: vi.fn(() => Promise.resolve({ generatedAt: 'ahora' })) };
  const network = { isSuperadmin: vi.fn(() => Promise.resolve(esSuperadmin)) };
  const controller = new AdminOverviewController(
    overview as unknown as AdminOverviewService,
    network as unknown as NetworkService,
  );
  return { controller, overview, network };
}

const QUERY = AdminOverviewQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' });

describe('AdminOverviewController: sólo el superadmin', () => {
  it('sin usuario, 401 y el servicio no se entera', async () => {
    const { controller, overview, network } = banco();
    await expect(controller.get(undefined, QUERY)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(network.isSuperadmin).not.toHaveBeenCalled();
    expect(overview.overview).not.toHaveBeenCalled();
  });

  it('quien no es superadmin (platform_admin incluido) recibe 403 con motivo', async () => {
    const { controller, overview, network } = banco({ esSuperadmin: false });
    const error = await controller.get(USUARIO, QUERY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformConsoleSuperadminOnlyError);
    expect((error as PlatformConsoleSuperadminOnlyError).getStatus()).toBe(403);
    expect((error as PlatformConsoleSuperadminOnlyError).reason).toBe(
      'PLATFORM_CONSOLE_SUPERADMIN_ONLY',
    );
    expect(network.isSuperadmin).toHaveBeenCalledWith(USUARIO);
    expect(overview.overview).not.toHaveBeenCalled();
  });

  it('el superadmin pasa, con su id como actor y la query ya validada', async () => {
    const { controller, overview } = banco();
    await expect(controller.get(USUARIO, QUERY)).resolves.toEqual({ generatedAt: 'ahora' });
    expect(overview.overview).toHaveBeenCalledWith(USUARIO, QUERY);
  });
});

describe('AdminOverviewController: RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  function contextFor(): ExecutionContext {
    return {
      getHandler: () => () => undefined,
      getClass: () => AdminOverviewController,
    } as unknown as ExecutionContext;
  }

  function allowed(role: Role | undefined): boolean {
    return requestContextStorage.run({ userId: USUARIO, role }, () => {
      try {
        return guard.canActivate(contextFor());
      } catch {
        return false;
      }
    });
  }

  it('declara los roles de plataforma', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOverviewController)).toEqual([...PLATFORM_ROLES]);
  });

  it('un rol de nodo no llega al controller; el superadmin sí', () => {
    expect(allowed('superadmin')).toBe(true);
    for (const role of [
      'consolidator_admin',
      'tenant_admin',
      'agency_admin',
      'admin',
      'vendedor',
    ] as const) {
      expect(allowed(role)).toBe(false);
    }
    expect(allowed(undefined)).toBe(false);
  });
});

describe('errores de la consola', () => {
  it('el rechazo de la base (0075) es el mismo 403 que da el controlador', () => {
    expect(
      platformConsoleDbError({ code: '42501', message: PLATFORM_CONSOLE_DB_DENIAL }),
    ).toBeInstanceOf(PlatformConsoleSuperadminOnlyError);
  });

  it.each([
    ['otro 42501 (una policy)', { code: '42501', message: 'new row violates row-level security' }],
    ['otro código', { code: '22023', message: PLATFORM_CONSOLE_DB_DENIAL }],
    ['algo que no es un objeto', 'boom'],
    ['null', null],
  ])('%s no se traduce', (_caso, err) => {
    expect(platformConsoleDbError(err)).toBeUndefined();
  });

  it('el nodo que no existe es un 404 con motivo', () => {
    const error = new PlatformConsoleScopeNotFoundError();
    expect(error.getStatus()).toBe(404);
    expect(error.reason).toBe('PLATFORM_CONSOLE_SCOPE_NOT_FOUND');
  });
});
