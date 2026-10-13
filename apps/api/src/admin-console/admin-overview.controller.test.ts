import { type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { PlatformConsoleScopeNotFoundError } from './admin-console.errors.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewQuerySchema } from './admin-overview.schemas.js';
import type { AdminOverviewService } from './admin-overview.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';

function banco() {
  const overview = { overview: vi.fn(() => Promise.resolve({ generatedAt: 'ahora' })) };
  const controller = new AdminOverviewController(overview as unknown as AdminOverviewService);
  return { controller, overview };
}

const QUERY = AdminOverviewQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' });

describe('AdminOverviewController: sólo el superadmin', () => {
  it('la clase entera pasa por SuperadminGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminOverviewController)).toEqual([
      SuperadminGuard,
    ]);
  });

  it('platform_admin pasa RolesGuard (rol de plataforma) pero SuperadminGuard lo frena: 403', async () => {
    const roles = new RolesGuard(new Reflector());
    const network = { isSuperadmin: vi.fn(() => Promise.resolve(false)) };
    const superadmin = new SuperadminGuard(network as unknown as NetworkService);
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => AdminOverviewController,
    } as unknown as ExecutionContext;
    await requestContextStorage.run({ userId: USUARIO, role: 'platform_admin' }, async () => {
      expect(roles.canActivate(ctx)).toBe(true);
      await expect(superadmin.canActivate(ctx)).rejects.toBeInstanceOf(SuperadminRequiredError);
    });
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
  it('el nodo que no existe es un 404 con motivo', () => {
    const error = new PlatformConsoleScopeNotFoundError();
    expect(error.getStatus()).toBe(404);
    expect(error.reason).toBe('PLATFORM_CONSOLE_SCOPE_NOT_FOUND');
  });
});
