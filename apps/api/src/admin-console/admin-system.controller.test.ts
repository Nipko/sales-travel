import { type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
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
import { AdminSystemController } from './admin-system.controller.js';
import type { AdminSystemService } from './admin-system.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';

function contextFor(): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => AdminSystemController,
  } as unknown as ExecutionContext;
}

describe('AdminSystemController: GET /admin/system/jobs, sólo el superadmin', () => {
  it('la ruta y la guarda de la clase entera', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminSystemController)).toBe('admin/system');
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminSystemController)).toEqual([SuperadminGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminSystemController)).toEqual([...PLATFORM_ROLES]);
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

  it('el superadmin lee los procesos con su id como actor', async () => {
    const system = { jobs: vi.fn(() => Promise.resolve({ generatedAt: 'ahora' })) };
    const controller = new AdminSystemController(system as unknown as AdminSystemService);
    await expect(controller.jobs(USUARIO)).resolves.toEqual({ generatedAt: 'ahora' });
    expect(system.jobs).toHaveBeenCalledWith(USUARIO);
  });
});
