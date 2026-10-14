import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
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
import { AdminAnnouncementsController } from './admin-announcements.controller.js';
import { AnnouncementsController } from './announcements.controller.js';
import type { AnnouncementsService } from './announcements.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const ANUNCIO = '22222222-2222-4222-8222-222222222222';

function contextFor(controller: abstract new (...args: never[]) => unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

describe('GET /announcements/active: cualquiera con sesión, en su nodo activo', () => {
  it('sin @Roles ni guardas propias: RolesGuard no opina, para ningún rol', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AnnouncementsController)).toBe('announcements');
    expect(Reflect.getMetadata(GUARDS_METADATA, AnnouncementsController)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, AnnouncementsController)).toBeUndefined();
    const roles = new RolesGuard(new Reflector());
    for (const role of ['vendedor', 'cliente_final', 'agency_admin', 'superadmin'] as Role[]) {
      const ok = requestContextStorage.run({ userId: USUARIO, role }, () =>
        roles.canActivate(contextFor(AnnouncementsController)),
      );
      expect(ok, role).toBe(true);
    }
  });

  it('lee con el usuario y el nodo activo del request', async () => {
    const service = { active: vi.fn(() => Promise.resolve([])) };
    const controller = new AnnouncementsController(service as unknown as AnnouncementsService);
    await requestContextStorage.run({ userId: USUARIO, tenantId: NODO }, () =>
      expect(controller.active(USUARIO)).resolves.toEqual({ announcements: [] }),
    );
    expect(service.active).toHaveBeenCalledWith(USUARIO, NODO);
    await expect(controller.active(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AdminAnnouncementsController: /admin/announcements, sólo el superadmin', () => {
  it('la ruta y la guarda de la clase entera', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminAnnouncementsController)).toBe(
      'admin/announcements',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAnnouncementsController)).toEqual([
      SuperadminGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminAnnouncementsController)).toEqual([
      ...PLATFORM_ROLES,
    ]);
  });

  it('un rol de nodo no llega; platform_admin pasa RolesGuard pero SuperadminGuard lo frena', async () => {
    const roles = new RolesGuard(new Reflector());
    const ctx = contextFor(AdminAnnouncementsController);
    const allowed = (role: Role) =>
      requestContextStorage.run({ userId: USUARIO, role }, () => {
        try {
          return roles.canActivate(ctx);
        } catch {
          return false;
        }
      });
    expect(allowed('consolidator_admin')).toBe(false);
    expect(allowed('agency_admin')).toBe(false);
    expect(allowed('superadmin')).toBe(true);

    const network = { isSuperadmin: vi.fn(() => Promise.resolve(false)) };
    const superadmin = new SuperadminGuard(network as unknown as NetworkService);
    await requestContextStorage.run({ userId: USUARIO, role: 'platform_admin' }, async () => {
      expect(roles.canActivate(ctx)).toBe(true);
      await expect(superadmin.canActivate(ctx)).rejects.toBeInstanceOf(SuperadminRequiredError);
    });
  });

  it('cada acción va al servicio con el superadmin como actor', async () => {
    const service = {
      list: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.resolve({ id: ANUNCIO })),
      update: vi.fn(() => Promise.resolve({ id: ANUNCIO })),
      archive: vi.fn(() => Promise.resolve({ id: ANUNCIO })),
    };
    const controller = new AdminAnnouncementsController(service as unknown as AnnouncementsService);
    await expect(controller.list(USUARIO)).resolves.toEqual({ announcements: [] });
    const body = {
      severity: 'info' as const,
      title: 'Hola',
      body: '',
      audience: { rootTenantId: null, adminsOnly: false },
      endsAt: new Date('2026-10-20T00:00:00Z'),
    };
    await controller.create(USUARIO, body);
    await controller.update(USUARIO, ANUNCIO, { title: 'Otro' });
    await controller.archive(USUARIO, ANUNCIO);
    expect(service.list).toHaveBeenCalledWith(USUARIO);
    expect(service.create).toHaveBeenCalledWith(USUARIO, body);
    expect(service.update).toHaveBeenCalledWith(USUARIO, ANUNCIO, { title: 'Otro' });
    expect(service.archive).toHaveBeenCalledWith(USUARIO, ANUNCIO);
  });
});
