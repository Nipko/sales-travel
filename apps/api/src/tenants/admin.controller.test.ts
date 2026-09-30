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
  InviteUserSchema,
  MembershipImpactQuerySchema,
  MoveTenantSchema,
  TenantIdParamSchema,
  UpdateSeatsSchema,
  UpdateTenantSchema,
  UuidParamSchema,
} from './dto.js';
import { InvitationsController } from './invitations.controller.js';
import type { InvitationsService } from './invitations.service.js';
import { MemberSupportController } from './member-support.controller.js';
import type { MemberSupportService } from './member-support.service.js';
import { SeatsController } from './seats.controller.js';
import { TenantSeatsSuperadminOnlyError } from './seats.policy.js';
import type { SeatsService } from './seats.service.js';
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
  const seats = {
    updatePolicy: vi.fn(() => Promise.resolve({ poolTenantId: NODO })),
  };
  const invitations = {
    orphanedInvitations: vi.fn(() => Promise.resolve([])),
    revokeOrphaned: vi.fn(() => Promise.resolve([])),
  };
  const controller = new AdminController(
    db as unknown as DatabaseService,
    network as unknown as NetworkService,
    { emit: vi.fn() } as unknown as AuditService,
    {} as SessionService,
    tenants as unknown as TenantsService,
    seats as unknown as SeatsService,
    invitations as unknown as InvitationsService,
  );
  return { controller, network, tenants, db, seats, invitations };
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

  it('puestos e inactividad: 401 sin sesión, 403 con motivo a un admin de red aunque administre el nodo', async () => {
    const { controller, seats } = banco({ superadmin: false, roleOver: 'consolidator_admin' });
    const body = { concurrentSeats: 10 };

    await expect(controller.updateSeats(undefined, NODO, body)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // El mismo motivo y mensaje que el alta con puestos, no el genérico en inglés.
    const denied = controller.updateSeats(ACTOR, NODO, body);
    await expect(denied).rejects.toBeInstanceOf(TenantSeatsSuperadminOnlyError);
    await expect(denied).rejects.toMatchObject({
      reason: 'TENANT_SEATS_SUPERADMIN_ONLY',
      message: 'Sólo el superadmin fija los puestos simultáneos y la inactividad de un nodo.',
    });
    expect(seats.updatePolicy).not.toHaveBeenCalled();
  });

  it('puestos e inactividad: el superadmin los fija', async () => {
    const { controller, seats } = banco({ superadmin: true });

    await controller.updateSeats(ACTOR, NODO, { concurrentSeats: 5, idleTimeoutMinutes: null });
    expect(seats.updatePolicy).toHaveBeenCalledWith(ACTOR, NODO, {
      concurrentSeats: 5,
      idleTimeoutMinutes: null,
    });
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

  it('impacto: mismas barreras que el cambio, y no simula nada si no pasan', async () => {
    const pedir = (c: AdminController, u: string | undefined, extra: object) =>
      c.membershipImpact(u, { userId: OTRO, tenantId: NODO, ...extra });

    const fuera = banco({ roleOver: undefined });
    await expect(
      pedir(fuera.controller, undefined, { status: 'suspended' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      fuera.controller.membershipImpact(ACTOR, {
        userId: ACTOR,
        tenantId: NODO,
        status: 'suspended',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(pedir(fuera.controller, ACTOR, { status: 'suspended' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(fuera.db.withRequestContext).not.toHaveBeenCalled();

    const superior = banco({ roleOver: 'admin', membresia: { id: 'm-4', role: 'tenant_admin' } });
    await expect(pedir(superior.controller, ACTOR, { status: 'suspended' })).rejects.toMatchObject({
      reason: 'ROLE_NOT_GRANTABLE',
    });
    const subir = banco({ roleOver: 'admin', membresia: { id: 'm-5', role: 'vendedor' } });
    await expect(pedir(subir.controller, ACTOR, { role: 'tenant_admin' })).rejects.toMatchObject({
      reason: 'ROLE_NOT_GRANTABLE',
    });
    for (const b of [superior, subir]) {
      expect(b.invitations.orphanedInvitations).not.toHaveBeenCalled();
    }
  });

  it('impacto: reactivar no revoca nada y no abre la simulación', async () => {
    const { controller, db, invitations } = banco({
      roleOver: 'tenant_admin',
      membresia: { id: 'm-6', role: 'admin' },
    });

    await expect(
      controller.membershipImpact(ACTOR, { userId: OTRO, tenantId: NODO, status: 'active' }),
    ).resolves.toEqual({ invitationsToRevoke: 0 });
    // Sólo la lectura de la membership destino.
    expect(db.withRequestContext).toHaveBeenCalledTimes(1);
    expect(invitations.orphanedInvitations).not.toHaveBeenCalled();
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
  const ctxOf = (controller: unknown) =>
    ({
      getHandler: () => () => undefined,
      getClass: () => controller,
    }) as unknown as ExecutionContext;

  it.each([
    ['AdminController', AdminController],
    ['SeatsController', SeatsController],
    ['MemberSupportController', MemberSupportController],
  ])('%s: ni vendedor ni cliente_final llegan a ningún handler', (_n, controller) => {
    for (const role of ['vendedor', 'cliente_final'] as Role[]) {
      expect(() =>
        requestContextStorage.run({ userId: ACTOR, role }, () =>
          guard.canActivate(ctxOf(controller)),
        ),
      ).toThrow(ForbiddenException);
    }
    expect(
      requestContextStorage.run({ userId: ACTOR, role: 'admin' }, () =>
        guard.canActivate(ctxOf(controller)),
      ),
    ).toBe(true);
  });
});

describe('SeatsController y MemberSupportController: sin sesión no llegan al servicio', () => {
  it('401 y el servicio no se entera', async () => {
    const seats = { view: vi.fn(), release: vi.fn() };
    const support = { resetMfa: vi.fn(), revokeSessions: vi.fn() };
    const seatsCtl = new SeatsController(seats as unknown as SeatsService);
    const supportCtl = new MemberSupportController(support as unknown as MemberSupportService);

    await expect(seatsCtl.view(undefined, NODO)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(seatsCtl.release(undefined, NODO, OTRO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(supportCtl.resetMfa(undefined, NODO, OTRO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(supportCtl.revokeSessions(undefined, NODO, OTRO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    for (const fn of [...Object.values(seats), ...Object.values(support)]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('con sesión, el actor y los ids de la ruta llegan tal cual', async () => {
    const seats = {
      view: vi.fn(() => Promise.resolve({})),
      release: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const seatsCtl = new SeatsController(seats as unknown as SeatsService);

    await seatsCtl.view(ACTOR, NODO);
    await seatsCtl.release(ACTOR, NODO, OTRO);
    expect(seats.view).toHaveBeenCalledWith(ACTOR, NODO);
    expect(seats.release).toHaveBeenCalledWith(ACTOR, NODO, OTRO);
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
          isBranch: true,
        }),
      ).toEqual({
        ...base,
        parentTenantId: PADRE,
        adminEmail: 'ana@example.com',
        isBranch: true,
      });
    });

    it.each([
      ['la plataforma no se crea por API', { tenantType: 'platform' }],
      ['un tipo desconocido', { tenantType: 'sucursal' }],
      [
        'contraseña del admin (se invita)',
        { adminEmail: 'a@example.com', adminPassword: 'x'.repeat(16) },
      ],
      ['contraseña sin email', { adminPassword: 'una-clave-larga' }],
      ['email inválido', { adminEmail: 'no-es-email' }],
      ['padre que no es uuid', { parentTenantId: 'platform' }],
      ['isBranch no booleano', { isBranch: 'si' }],
      ['0 puestos', { concurrentSeats: 0 }],
      ['más de 10000 puestos', { concurrentSeats: 10_001 }],
      ['puestos con decimales', { concurrentSeats: 2.5 }],
      ['puestos como texto libre', { concurrentSeats: '5 puestos' }],
      ['inactividad de 4 minutos', { idleTimeoutMinutes: 4 }],
      ['inactividad de más de 8 h', { idleTimeoutMinutes: 481 }],
    ])('rechaza: %s', (_q, extra) => {
      expect(() => alta.transform({ ...base, ...extra })).toThrow(BadRequestException);
    });

    it('puestos e inactividad: opcionales; vacío o null es heredar; admite el número como texto', () => {
      expect(alta.transform({ ...base, concurrentSeats: 5, idleTimeoutMinutes: 30 })).toEqual({
        ...base,
        concurrentSeats: 5,
        idleTimeoutMinutes: 30,
      });
      expect(
        alta.transform({ ...base, concurrentSeats: ' 12 ', idleTimeoutMinutes: '480' }),
      ).toEqual({ ...base, concurrentSeats: 12, idleTimeoutMinutes: 480 });
      expect(alta.transform({ ...base, concurrentSeats: '', idleTimeoutMinutes: null })).toEqual(
        base,
      );
      expect(alta.transform({ ...base, concurrentSeats: 1, idleTimeoutMinutes: 5 })).toMatchObject({
        concurrentSeats: 1,
        idleTimeoutMinutes: 5,
      });
      expect(alta.transform({ ...base, concurrentSeats: 10_000 })).toMatchObject({
        concurrentSeats: 10_000,
      });
    });
  });

  describe('puestos e inactividad de un nodo (PATCH)', () => {
    const puestos = new ZodValidationPipe(UpdateSeatsSchema);

    it('número, null (heredar) o ausente (no tocar)', () => {
      expect(puestos.transform({ concurrentSeats: 3, idleTimeoutMinutes: 15 })).toEqual({
        concurrentSeats: 3,
        idleTimeoutMinutes: 15,
      });
      expect(puestos.transform({ concurrentSeats: null, idleTimeoutMinutes: null })).toEqual({
        concurrentSeats: null,
        idleTimeoutMinutes: null,
      });
      expect(puestos.transform({ idleTimeoutMinutes: '60' })).toEqual({ idleTimeoutMinutes: 60 });
      expect(puestos.transform({ concurrentSeats: 10_000 })).toEqual({ concurrentSeats: 10_000 });
    });

    it.each([
      ['vacío', {}],
      ['0 puestos', { concurrentSeats: 0 }],
      ['puestos negativos', { concurrentSeats: -1 }],
      ['más de 10000 puestos', { concurrentSeats: 10_001 }],
      ['puestos con decimales', { concurrentSeats: 1.5 }],
      ['inactividad de 4 minutos', { idleTimeoutMinutes: 4 }],
      ['inactividad de 481 minutos', { idleTimeoutMinutes: 481 }],
      ['inactividad en segundos (1800)', { idleTimeoutMinutes: 1800 }],
      ['texto vacío (heredar es null)', { concurrentSeats: '' }],
      ['booleano', { concurrentSeats: true }],
      ['campos de más', { concurrentSeats: 3, tenantId: NODO }],
    ])('rechaza: %s', (_q, body) => {
      expect(() => puestos.transform(body)).toThrow(BadRequestException);
    });

    it('los otros ids de la ruta son uuid en minúsculas', () => {
      const id = new ZodValidationPipe(UuidParamSchema);
      expect(id.transform(OTRO.toUpperCase())).toBe(OTRO);
      expect(() => id.transform('mi-sesion')).toThrow(BadRequestException);
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

  describe('impacto de un cambio sobre una membership', () => {
    const impacto = new ZodValidationPipe(MembershipImpactQuerySchema);
    const ids = { userId: OTRO, tenantId: NODO };

    it('suspender o un rol asignable', () => {
      expect(impacto.transform({ ...ids, status: 'suspended' })).toEqual({
        ...ids,
        status: 'suspended',
      });
      expect(impacto.transform({ ...ids, role: 'vendedor' })).toEqual({ ...ids, role: 'vendedor' });
    });

    it.each([
      ['ni estado ni rol', ids],
      ['los dos', { ...ids, status: 'suspended', role: 'vendedor' }],
      ['un rol de plataforma', { ...ids, role: 'superadmin' }],
      ['un estado desconocido', { ...ids, status: 'archived' }],
      ['sin el nodo', { userId: OTRO, status: 'suspended' }],
      ['campos de más', { ...ids, status: 'suspended', dryRun: 'false' }],
    ])('rechaza: %s', (_q, query) => {
      expect(() => impacto.transform(query)).toThrow(BadRequestException);
    });
  });

  describe('D7 B: ni superadmin ni platform_admin se asignan por API', () => {
    it.each(['superadmin', 'platform_admin'])('%s', (role) => {
      const ids = { userId: OTRO, tenantId: NODO };
      expect(() => new ZodValidationPipe(ChangeRoleSchema).transform({ ...ids, role })).toThrow(
        BadRequestException,
      );
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
