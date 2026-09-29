import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { PasswordService } from '../auth/password.service.js';
import type { SessionService } from '../auth/session.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AdminController } from './admin.controller.js';
import {
  ChangeRoleSchema,
  CreateTenantSchema,
  CreateUserSchema,
  InviteUserSchema,
  MoveTenantSchema,
  TenantIdParamSchema,
  UpdateTenantSchema,
} from './dto.js';
import { InvitationsController } from './invitations.controller.js';
import type { InvitationsService } from './invitations.service.js';
import type { TenantsService } from './tenants.service.js';

const ACTOR = '99999999-9999-4999-8999-999999999999';
const OTRO = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const PADRE = '22222222-2222-4222-8222-222222222222';

function banco({
  superadmin = false,
  roleOver = undefined as Role | undefined,
  membresia = undefined as { id: string; role: Role } | undefined,
} = {}) {
  const network = {
    isSuperadmin: vi.fn(() => Promise.resolve(superadmin)),
    roleOver: vi.fn(() => Promise.resolve(roleOver)),
  };
  const tenants = {
    create: vi.fn(() => Promise.resolve({ tenant: { id: NODO } })),
    update: vi.fn(() => Promise.resolve({ id: NODO })),
    move: vi.fn(() => Promise.resolve({ moved: 1, tenant: { id: NODO } })),
    listNetwork: vi.fn(() => Promise.resolve([])),
  };
  const db = {
    withRequestContext: vi.fn(() => Promise.resolve(membresia)),
  };
  const controller = new AdminController(
    db as unknown as DatabaseService,
    {} as PasswordService,
    network as unknown as NetworkService,
    { emit: vi.fn() } as unknown as AuditService,
    {} as SessionService,
    tenants as unknown as TenantsService,
  );
  return { controller, network, tenants, db };
}

describe('AdminController: corrección de la red, sólo superadmin', () => {
  it.each([
    ['listar la red', (c: AdminController, u?: string) => c.listTenants(u)],
    [
      'corregir un nodo',
      (c: AdminController, u?: string) => c.updateTenant(u, NODO, { status: 'suspended' }),
    ],
    [
      'mover un nodo',
      (c: AdminController, u?: string) => c.moveTenant(u, NODO, { parentTenantId: PADRE }),
    ],
  ])('%s: 401 sin sesión y 403 si no es superadmin; el servicio no se entera', async (_q, call) => {
    const { controller, tenants } = banco({ superadmin: false, roleOver: 'consolidator_admin' });

    await expect(call(controller, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(call(controller, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    for (const fn of Object.values(tenants)) expect(fn).not.toHaveBeenCalled();
  });

  it('el superadmin pasa y el actor que llega al servicio es él', async () => {
    const { controller, tenants } = banco({ superadmin: true });

    await controller.updateTenant(ACTOR, NODO, { isBranch: true });
    await controller.moveTenant(ACTOR, NODO, { parentTenantId: PADRE });
    await controller.listTenants(ACTOR);

    expect(tenants.update).toHaveBeenCalledWith(ACTOR, NODO, { isBranch: true });
    expect(tenants.move).toHaveBeenCalledWith(ACTOR, NODO, PADRE);
    expect(tenants.listNetwork).toHaveBeenCalledWith(ACTOR);
  });

  it('el alta la decide el servicio (padre, tipo y admin inicial), con el actor de la sesión', async () => {
    const { controller, tenants } = banco();
    const body = CreateTenantSchema.parse({
      name: 'Agencia Sur',
      slug: 'agencia-sur',
      countryCode: 'CO',
      defaultCurrency: 'COP',
    });

    await expect(controller.createTenant(undefined, body)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await controller.createTenant(ACTOR, body);
    expect(tenants.create).toHaveBeenCalledWith(ACTOR, body);
  });
});

describe('AdminController: el rango se mide sobre el nodo destino (G-06)', () => {
  const alta = {
    email: 'nuevo@example.com',
    name: 'Nuevo',
    password: 'una-clave-larga',
    tenantId: NODO,
  };

  it('createUser: quien no administra el destino recibe 403', async () => {
    const { controller, network } = banco({ roleOver: undefined });

    await expect(controller.createUser(ACTOR, { ...alta, role: 'vendedor' })).rejects.toThrow(
      'target tenant is outside your network',
    );
    expect(network.roleOver).toHaveBeenCalledWith(ACTOR, NODO);
  });

  it.each<[Role, Role]>([
    ['admin', 'tenant_admin'],
    ['admin', 'consolidator_admin'],
    ['admin', 'admin'],
    ['tenant_admin', 'tenant_admin'],
    ['tenant_admin', 'consolidator_admin'],
  ])('createUser: un %s sobre el destino no crea un %s', async (actor, role) => {
    const { controller, db } = banco({ roleOver: actor });

    await expect(
      controller.createUser(ACTOR, { ...alta, role: role as 'vendedor' }),
    ).rejects.toMatchObject({ reason: 'ROLE_NOT_GRANTABLE' });
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('el rol del tenant activo no cuenta: consolidator_admin en su red, admin en el destino', async () => {
    const { controller } = banco({ roleOver: 'admin' });

    await expect(
      requestContextStorage.run({ userId: ACTOR, role: 'consolidator_admin' }, () =>
        controller.createUser(ACTOR, { ...alta, role: 'tenant_admin' }),
      ),
    ).rejects.toMatchObject({ reason: 'ROLE_NOT_GRANTABLE' });
  });

  it('changeRole: hay que superar el rol actual y el nuevo, sobre el destino', async () => {
    const vendedor = { id: 'm-1', role: 'vendedor' as Role };

    const subir = banco({ roleOver: 'admin', membresia: vendedor });
    await expect(
      requestContextStorage.run({ userId: ACTOR, role: 'consolidator_admin' }, () =>
        subir.controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'tenant_admin' }),
      ),
    ).rejects.toMatchObject({ reason: 'ROLE_NOT_GRANTABLE' });
    expect(subir.network.roleOver).toHaveBeenCalledWith(ACTOR, NODO);

    const superior = banco({
      roleOver: 'tenant_admin',
      membresia: { id: 'm-2', role: 'consolidator_admin' },
    });
    await expect(
      superior.controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'vendedor' }),
    ).rejects.toMatchObject({ reason: 'ROLE_NOT_GRANTABLE' });
  });

  it('setMembershipStatus: no se suspende a alguien de rango igual o superior en el destino', async () => {
    const { controller } = banco({
      roleOver: 'admin',
      membresia: { id: 'm-3', role: 'tenant_admin' },
    });

    await expect(
      controller.setMembershipStatus(ACTOR, { userId: OTRO, tenantId: NODO, status: 'suspended' }),
    ).rejects.toMatchObject({ reason: 'ROLE_NOT_GRANTABLE' });
  });

  it('changeRole y setMembershipStatus: fuera de la red es 403 antes de leer nada', async () => {
    const { controller, db } = banco({ roleOver: undefined });

    await expect(
      controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'vendedor' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.setMembershipStatus(ACTOR, { userId: OTRO, tenantId: NODO, status: 'active' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });
});

describe('InvitationsController: el rango se mide sobre el nodo destino (G-06)', () => {
  function invitaciones(roleOver: Role | undefined) {
    const service = { invite: vi.fn(() => Promise.resolve({ id: 'inv', expiresAt: new Date() })) };
    const network = { roleOver: vi.fn(() => Promise.resolve(roleOver)) };
    const controller = new InvitationsController(
      service as unknown as InvitationsService,
      network as unknown as NetworkService,
    );
    return { controller, service, network };
  }
  const invitar = (c: InvitationsController, role: 'tenant_admin' | 'admin' | 'vendedor') =>
    c.invite(ACTOR, { email: 'x@example.com', tenantId: NODO, role });

  it('fuera de la red, 403', async () => {
    const { controller, service } = invitaciones(undefined);
    await expect(invitar(controller, 'vendedor')).rejects.toThrow(
      'target tenant is outside your network',
    );
    expect(service.invite).not.toHaveBeenCalled();
  });

  it('con el rol del tenant activo alto pero admin sobre el destino, no invita tenant_admins', async () => {
    const { controller, service, network } = invitaciones('admin');
    await expect(
      requestContextStorage.run({ userId: ACTOR, role: 'consolidator_admin' }, () =>
        invitar(controller, 'tenant_admin'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(network.roleOver).toHaveBeenCalledWith(ACTOR, NODO);
    expect(service.invite).not.toHaveBeenCalled();
  });

  it('por debajo de su rol sobre el destino, invita', async () => {
    const { controller, service } = invitaciones('tenant_admin');
    await invitar(controller, 'admin');
    expect(service.invite).toHaveBeenCalledWith({
      actorUserId: ACTOR,
      tenantId: NODO,
      email: 'x@example.com',
      role: 'admin',
    });
  });

  it('el superadmin invita cualquier rol asignable', async () => {
    const { controller, service } = invitaciones('superadmin');
    await invitar(controller, 'tenant_admin');
    expect(service.invite).toHaveBeenCalled();
  });
});

describe('RolesGuard con la metadata REAL del controlador', () => {
  const guard = new RolesGuard(new Reflector());
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => AdminController,
  } as unknown as ExecutionContext;

  it.each<Role>(['vendedor', 'cliente_final'])('%s no llega a ningún handler', (role) => {
    expect(() =>
      requestContextStorage.run({ userId: ACTOR, role }, () => guard.canActivate(ctx)),
    ).toThrow(ForbiddenException);
  });
});

describe('Zod en los bordes', () => {
  const alta = new ZodValidationPipe(CreateTenantSchema);
  const base = {
    name: 'Agencia Sur',
    slug: 'agencia-sur',
    countryCode: 'CO',
    defaultCurrency: 'COP',
  };

  describe('alta de un nodo', () => {
    it('los datos vacíos del admin inicial son "no enviados" (antes daban 400)', () => {
      expect(
        alta.transform({
          ...base,
          defaultLanguage: 'es',
          adminEmail: '',
          adminName: '  ',
          adminPassword: '',
          parentTenantId: '',
          tenantType: '',
        }),
      ).toEqual({ ...base, defaultLanguage: 'es' });
      expect(alta.transform({ ...base, parentTenantId: null, isBranch: null })).toEqual(base);
    });

    it('normaliza el padre y el email del admin', () => {
      expect(
        alta.transform({
          ...base,
          parentTenantId: PADRE.toUpperCase(),
          adminEmail: '  Ana@Example.com ',
          adminName: ' Ana ',
          adminPassword: 'una-clave-larga',
          isBranch: true,
        }),
      ).toEqual({
        ...base,
        parentTenantId: PADRE,
        adminEmail: 'ana@example.com',
        adminName: 'Ana',
        adminPassword: 'una-clave-larga',
        isBranch: true,
      });
    });

    it.each([
      ['la plataforma no se crea por API', { tenantType: 'platform' }],
      ['un tipo desconocido', { tenantType: 'sucursal' }],
      ['nombre o contraseña del admin sin su email', { adminName: 'Ana' }],
      ['contraseña sin email', { adminPassword: 'una-clave-larga' }],
      ['contraseña corta', { adminEmail: 'a@example.com', adminPassword: 'corta' }],
      ['email inválido', { adminEmail: 'no-es-email' }],
      ['padre que no es uuid', { parentTenantId: 'platform' }],
      ['isBranch no booleano', { isBranch: 'si' }],
    ])('rechaza: %s', (_q, extra) => {
      expect(() => alta.transform({ ...base, ...extra })).toThrow(BadRequestException);
    });
  });

  describe('corrección de un nodo', () => {
    const cambio = new ZodValidationPipe(UpdateTenantSchema);

    it('acepta estado, sucursal y tipo', () => {
      expect(
        cambio.transform({ status: 'suspended', isBranch: false, tenantType: 'consolidator' }),
      ).toEqual({ status: 'suspended', isBranch: false, tenantType: 'consolidator' });
    });

    it.each([
      ['vacío', {}],
      ['la plataforma', { tenantType: 'platform' }],
      ['archivar', { status: 'archived' }],
      ['cambiar el padre (eso es mover)', { parentTenantId: PADRE }],
      ['campos de más', { status: 'active', slug: 'otro' }],
    ])('rechaza: %s', (_q, body) => {
      expect(() => cambio.transform(body)).toThrow(BadRequestException);
    });
  });

  describe('mover un nodo', () => {
    const mover = new ZodValidationPipe(MoveTenantSchema);

    it('exige el nuevo padre y lo normaliza', () => {
      expect(mover.transform({ parentTenantId: PADRE.toUpperCase() })).toEqual({
        parentTenantId: PADRE,
      });
      for (const body of [{}, { parentTenantId: null }, { parentTenantId: 'raiz' }]) {
        expect(() => mover.transform(body)).toThrow(BadRequestException);
      }
      expect(() => mover.transform({ parentTenantId: PADRE, tenantType: 'agency' })).toThrow(
        BadRequestException,
      );
    });

    it('el id de la ruta es un uuid en minúsculas', () => {
      const id = new ZodValidationPipe(TenantIdParamSchema);
      expect(id.transform(NODO.toUpperCase())).toBe(NODO);
      expect(() => id.transform('platform')).toThrow(BadRequestException);
    });
  });

  describe('D7 B: ni superadmin ni platform_admin se asignan por API', () => {
    it.each(['superadmin', 'platform_admin'])('%s', (role) => {
      const ids = { userId: OTRO, tenantId: NODO };
      expect(() => new ZodValidationPipe(ChangeRoleSchema).transform({ ...ids, role })).toThrow(
        BadRequestException,
      );
      expect(() =>
        new ZodValidationPipe(CreateUserSchema).transform({
          email: 'a@example.com',
          name: 'A',
          password: 'una-clave-larga',
          tenantId: NODO,
          role,
        }),
      ).toThrow(BadRequestException);
      expect(() =>
        new ZodValidationPipe(InviteUserSchema).transform({
          email: 'a@example.com',
          tenantId: NODO,
          role,
        }),
      ).toThrow(BadRequestException);
    });
  });
});
