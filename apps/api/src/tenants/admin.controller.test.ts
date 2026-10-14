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
import type { MembershipStatus, Role, UserStatus } from '../database/database.types.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AdminController } from './admin.controller.js';
import {
  ChangeRoleSchema,
  CreateTenantSchema,
  decodePlatformUsersCursor,
  encodePlatformUsersCursor,
  InviteUserSchema,
  ListPlatformUsersQuerySchema,
  MembershipImpactQuerySchema,
  MoveTenantSchema,
  RemoveMembershipSchema,
  SetUserStatusSchema,
  TenantIdParamSchema,
  UpdateSeatsSchema,
  UpdateTenantSchema,
  UuidParamSchema,
} from './dto.js';
import { InvitationsController } from './invitations.controller.js';
import type { InvitationsService } from './invitations.service.js';
import { MemberSupportController } from './member-support.controller.js';
import type { MemberSupportService } from './member-support.service.js';
import { LastSuperadminError, UserNotFoundError } from './platform-users.errors.js';
import type { PlatformUsersService } from './platform-users.service.js';
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
  const platformUsers = {
    list: vi.fn(() => Promise.resolve({ users: [], nextCursor: null })),
    footprint: vi.fn(() => Promise.resolve({ activeMemberships: 0, liveSessions: 0 })),
    assertNotLastSuperadmin: vi.fn(() => Promise.resolve()),
  };
  const notices = { notify: vi.fn() };
  const controller = new AdminController(
    db as unknown as DatabaseService,
    network as unknown as NetworkService,
    { emit: vi.fn() } as unknown as AuditService,
    {} as SessionService,
    tenants as unknown as TenantsService,
    seats as unknown as SeatsService,
    invitations as unknown as InvitationsService,
    platformUsers as unknown as PlatformUsersService,
    notices as unknown as SecurityNoticeService,
  );
  return { controller, network, tenants, db, seats, invitations, platformUsers, notices };
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

/**
 * El cambio de rol o de estado de una membership con su transacción de verdad (fila tomada, cambio,
 * evento, commit): la membership destino es `membresia` y el actor la administra como `roleOver`.
 * `bloqueada` es lo que encuentra la transacción al tomar la fila, si otro admin la cambió después
 * de la primera lectura.
 */
function bancoMembresia(
  membresia: { id: string; role: Role; status: MembershipStatus },
  roleOver: Role = 'tenant_admin',
  bloqueada: { role: Role; status: MembershipStatus } = membresia,
) {
  const orden: string[] = [];
  const select = {
    select: vi.fn(() => select),
    where: vi.fn(() => select),
    forNoKeyUpdate: vi.fn(() => select),
    executeTakeFirst: vi.fn((): Promise<{ role: Role; status: MembershipStatus } | undefined> => {
      orden.push('fila');
      return Promise.resolve({ role: bloqueada.role, status: bloqueada.status });
    }),
  };
  const update = {
    set: vi.fn(() => update),
    where: vi.fn(() => update),
    executeTakeFirstOrThrow: vi.fn(() => {
      orden.push('update');
      return Promise.resolve({ numUpdatedRows: 1n });
    }),
  };
  const trx = { selectFrom: vi.fn(() => select), updateTable: vi.fn(() => update) };
  const db = {
    withRequestContext: vi
      .fn()
      // 1ª: la membership destino, leída con la RLS del actor.
      .mockResolvedValueOnce(membresia)
      .mockImplementation(async (_ctx: unknown, fn: (t: unknown) => Promise<unknown>) => {
        const result = await fn(trx);
        orden.push('commit');
        return result;
      }),
  };
  const sessions = {
    revokeForTenant: vi.fn(() => {
      orden.push('sesiones');
      return Promise.resolve(1);
    }),
  };
  const invitations = {
    revokeOrphaned: vi.fn(() => Promise.resolve([])),
    orphanedInvitations: vi.fn(() => Promise.resolve([])),
  };
  const audit = {
    emitWithin: vi.fn(() => {
      orden.push('evento');
      return Promise.resolve();
    }),
  };
  const notices = {
    notify: vi.fn(() => {
      orden.push('aviso');
    }),
  };
  const controller = new AdminController(
    db as unknown as DatabaseService,
    { roleOver: vi.fn(() => Promise.resolve(roleOver)) } as unknown as NetworkService,
    audit as unknown as AuditService,
    sessions as unknown as SessionService,
    {} as TenantsService,
    {} as SeatsService,
    invitations as unknown as InvitationsService,
    {} as PlatformUsersService,
    notices as unknown as SecurityNoticeService,
  );
  return { controller, orden, audit, notices, select, update, sessions, invitations, db };
}

describe('AdminController: la persona se entera por su correo de su rol y su acceso', () => {
  const VENDEDOR = { id: 'm-7', role: 'vendedor' as Role, status: 'active' as MembershipStatus };

  it('cambiar el rol: UN aviso con el rol nuevo, por el nodo destino, después del commit', async () => {
    const { controller, orden, notices } = bancoMembresia(VENDEDOR);

    await controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'admin' });

    expect(orden).toEqual(['fila', 'update', 'evento', 'commit', 'aviso']);
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith('role_changed', {
      userId: OTRO,
      tenantId: NODO,
      role: 'admin',
    });
  });

  it('el mismo rol que ya tenía no es un cambio: sin aviso', async () => {
    const { controller, audit, notices } = bancoMembresia(VENDEDOR);

    await controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'vendedor' });

    expect(audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('suspender su acceso al nodo: el aviso sale después del commit', async () => {
    const { controller, orden, notices } = bancoMembresia(VENDEDOR);

    await controller.setMembershipStatus(ACTOR, {
      userId: OTRO,
      tenantId: NODO,
      status: 'suspended',
    });

    expect(orden).toEqual(['fila', 'update', 'sesiones', 'evento', 'commit', 'aviso']);
    expect(notices.notify).toHaveBeenCalledWith('membership_suspended', {
      userId: OTRO,
      tenantId: NODO,
    });
  });

  it('reactivarlo: el aviso de reactivado; si ya estaba en ese estado, ninguno', async () => {
    const reactivar = bancoMembresia({ ...VENDEDOR, status: 'suspended' });
    await reactivar.controller.setMembershipStatus(ACTOR, {
      userId: OTRO,
      tenantId: NODO,
      status: 'active',
    });
    expect(reactivar.notices.notify).toHaveBeenCalledTimes(1);
    expect(reactivar.notices.notify).toHaveBeenCalledWith('membership_reactivated', {
      userId: OTRO,
      tenantId: NODO,
    });

    const igual = bancoMembresia(VENDEDOR);
    await igual.controller.setMembershipStatus(ACTOR, {
      userId: OTRO,
      tenantId: NODO,
      status: 'active',
    });
    expect(igual.audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(igual.notices.notify).not.toHaveBeenCalled();
  });

  it('compara con la fila tomada en la transacción, no con la lectura de antes', async () => {
    // Otro admin lo suspendió entre la primera lectura y este cambio: suspenderlo otra vez no avisa.
    const yaSuspendido = bancoMembresia(VENDEDOR, 'tenant_admin', {
      role: 'vendedor',
      status: 'suspended',
    });
    await yaSuspendido.controller.setMembershipStatus(ACTOR, {
      userId: OTRO,
      tenantId: NODO,
      status: 'suspended',
    });
    expect(yaSuspendido.select.forNoKeyUpdate).toHaveBeenCalledTimes(1);
    expect(yaSuspendido.notices.notify).not.toHaveBeenCalled();

    // Reactivarlo sí cambia lo que había, aunque la primera lectura dijera activo.
    const reactivado = bancoMembresia(VENDEDOR, 'tenant_admin', {
      role: 'vendedor',
      status: 'suspended',
    });
    await reactivado.controller.setMembershipStatus(ACTOR, {
      userId: OTRO,
      tenantId: NODO,
      status: 'active',
    });
    expect(reactivado.notices.notify).toHaveBeenCalledWith('membership_reactivated', {
      userId: OTRO,
      tenantId: NODO,
    });

    // Lo mismo con el rol: otro admin ya le dio el que se pide.
    const yaManager = bancoMembresia(VENDEDOR, 'tenant_admin', { role: 'admin', status: 'active' });
    await yaManager.controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'admin' });
    expect(yaManager.select.forNoKeyUpdate).toHaveBeenCalledTimes(1);
    expect(yaManager.notices.notify).not.toHaveBeenCalled();
  });

  it('si la RLS ya no deja tomar la fila: 403, sin cambio ni aviso', async () => {
    const { controller, select, orden, notices } = bancoMembresia(VENDEDOR);
    select.executeTakeFirst.mockResolvedValueOnce(undefined);

    await expect(
      controller.setMembershipStatus(ACTOR, { userId: OTRO, tenantId: NODO, status: 'suspended' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(orden).not.toContain('update');
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('si algo falla dentro de la transacción, no hay aviso', async () => {
    const { controller, audit, notices } = bancoMembresia(VENDEDOR);
    audit.emitWithin.mockImplementationOnce(() => Promise.reject(new Error('el evento no entró')));

    await expect(
      controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'admin' }),
    ).rejects.toThrow('el evento no entró');
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('ningún rechazo avisa: uno mismo, fuera de la red o sin rango', async () => {
    const yo = bancoMembresia(VENDEDOR);
    await expect(
      yo.controller.changeRole(ACTOR, { userId: ACTOR, tenantId: NODO, role: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      yo.controller.setMembershipStatus(ACTOR, {
        userId: ACTOR,
        tenantId: NODO,
        status: 'suspended',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const fuera = banco({ roleOver: undefined });
    await expect(
      fuera.controller.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'vendedor' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      fuera.controller.setMembershipStatus(ACTOR, {
        userId: OTRO,
        tenantId: NODO,
        status: 'suspended',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const superior = bancoMembresia({ ...VENDEDOR, role: 'tenant_admin' }, 'admin');
    await expect(
      superior.controller.setMembershipStatus(ACTOR, {
        userId: OTRO,
        tenantId: NODO,
        status: 'suspended',
      }),
    ).rejects.toMatchObject({ reason: 'ROLE_NOT_GRANTABLE' });

    for (const n of [yo.notices, fuera.notices, superior.notices]) {
      expect(n.notify).not.toHaveBeenCalled();
    }
  });
});

/** Quien quita: un tenant_admin con el 2FA de hace `minutos` (o sin 2FA reciente, `null`). */
function conDosPasos(minutos: number | null): RequestContext {
  return {
    userId: ACTOR,
    role: 'tenant_admin',
    mfaRequired: true,
    mfaEnabled: true,
    mfaVerified: minutos !== null,
    ...(minutos !== null ? { mfaVerifiedAt: new Date(Date.now() - minutos * 60_000) } : {}),
  };
}

describe('AdminController.removeMembership: quitar a una persona de un nodo (USR-11)', () => {
  const VENDEDOR = { id: 'm-20', role: 'vendedor' as Role, status: 'active' as MembershipStatus };
  const quitar = (c: AdminController, actor: string | undefined, userId = OTRO) =>
    c.removeMembership(actor, { userId, tenantId: NODO });

  it('baja blanda en una transacción: fila, cambio, sesiones, invitaciones, evento; después el aviso', async () => {
    const { controller, orden, update, sessions, invitations, audit, notices } =
      bancoMembresia(VENDEDOR);
    invitations.revokeOrphaned.mockResolvedValueOnce([
      { id: 'inv-1', tenantId: NODO, defect: 'inviter_inactive' },
    ] as never);

    const res = await quitar(controller, ACTOR);

    expect(res).toEqual({
      id: 'm-20',
      status: 'removed',
      revokedSessions: 1,
      revokedInvitations: 1,
    });
    expect(orden).toEqual(['fila', 'update', 'sesiones', 'evento', 'commit', 'aviso']);
    // Queda con quién y cuándo, y sólo si no estaba quitada ya.
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'removed', removed_by: ACTOR }),
    );
    expect(update.where).toHaveBeenCalledWith('status', '!=', 'removed');
    expect(sessions.revokeForTenant).toHaveBeenCalledWith(
      OTRO,
      NODO,
      'membership_removed',
      expect.anything(),
    );
    expect(invitations.revokeOrphaned).toHaveBeenCalledWith(expect.anything(), {
      inviterUserId: OTRO,
      rootTenantId: NODO,
      actorUserId: ACTOR,
      cause: 'membership_removed',
    });
    expect(audit.emitWithin).toHaveBeenCalledWith(expect.anything(), {
      eventType: 'MembershipRemoved',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'membership',
      aggregateId: 'm-20',
      payload: {
        targetUserId: OTRO,
        role: 'vendedor',
        previousStatus: 'active',
        revokedSessions: 1,
        revokedInvitations: 1,
      },
    });
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith('membership_removed', {
      userId: OTRO,
      tenantId: NODO,
    });
  });

  it('a alguien suspendido también se lo quita: el evento dice de qué estado venía', async () => {
    const { controller, audit } = bancoMembresia({ ...VENDEDOR, status: 'suspended' });

    await quitar(controller, ACTOR);

    expect(audit.emitWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ previousStatus: 'suspended' }) as unknown,
      }),
    );
  });

  it('sin sesión 401; a uno mismo 403, sin leer nada', async () => {
    const { controller, db } = bancoMembresia(VENDEDOR);

    await expect(quitar(controller, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(quitar(controller, ACTOR, ACTOR)).rejects.toThrow(
      'no puedes quitarte a ti mismo de un nodo',
    );
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('fuera de la red 403 antes de leer nada; sin rango, ROLE_NOT_GRANTABLE; nada cambia ni avisa', async () => {
    const fuera = banco({ roleOver: undefined });
    await expect(quitar(fuera.controller, ACTOR)).rejects.toThrow('No administras este nodo.');
    expect(fuera.db.withRequestContext).not.toHaveBeenCalled();

    const superior = bancoMembresia({ ...VENDEDOR, role: 'tenant_admin' }, 'admin');
    await expect(quitar(superior.controller, ACTOR)).rejects.toMatchObject({
      reason: 'ROLE_NOT_GRANTABLE',
    });
    expect(superior.orden).toEqual([]);

    const par = bancoMembresia({ ...VENDEDOR, role: 'tenant_admin' }, 'tenant_admin');
    await expect(quitar(par.controller, ACTOR)).rejects.toMatchObject({
      reason: 'ROLE_NOT_GRANTABLE',
    });
    for (const n of [fuera.notices, superior.notices, par.notices]) {
      expect(n.notify).not.toHaveBeenCalled();
    }
  });

  it('el último administrador activo del nodo no se quita', async () => {
    // La misma lectura doble devuelve la membership y el conteo de admins restantes (cero).
    const { controller } = banco({
      roleOver: 'tenant_admin',
      membresia: { id: 'm-21', role: 'admin', status: 'active', count: '0' } as {
        id: string;
        role: Role;
      },
    });

    await expect(
      requestContextStorage.run(conDosPasos(1), () => quitar(controller, ACTOR)),
    ).rejects.toThrow('Es el último administrador activo del nodo: asigna otro antes de quitarlo.');
  });

  it('ya quitada: 409 MEMBERSHIP_REMOVED, también si otro admin la quitó en el medio', async () => {
    const ya = bancoMembresia({ ...VENDEDOR, status: 'removed' });
    const err = quitar(ya.controller, ACTOR);
    await expect(err).rejects.toMatchObject({
      reason: 'MEMBERSHIP_REMOVED',
      message: 'Esta persona ya no forma parte de este nodo: para que vuelva, invítala de nuevo.',
    });
    expect(ya.orden).toEqual([]);

    const carrera = bancoMembresia(VENDEDOR, 'tenant_admin', {
      role: 'vendedor',
      status: 'removed',
    });
    await expect(quitar(carrera.controller, ACTOR)).rejects.toMatchObject({
      reason: 'MEMBERSHIP_REMOVED',
    });
    expect(carrera.orden).toEqual(['fila']);
    expect(carrera.notices.notify).not.toHaveBeenCalled();
  });

  it('quitar a un admin pide el 2FA de los últimos minutos (D1 = C); a un vendedor, no', async () => {
    const ADMIN = { ...VENDEDOR, role: 'admin' as Role };
    // Sin 2FA reciente: 403 antes de tocar nada.
    const viejo = bancoMembresia(ADMIN);
    // La 1ª lectura es la membership; la 2ª, cuántos admins activos le quedan al nodo.
    viejo.db.withRequestContext.mockResolvedValueOnce({ count: '1' });
    await expect(
      requestContextStorage.run(conDosPasos(11), () => quitar(viejo.controller, ACTOR)),
    ).rejects.toMatchObject({ reason: 'MFA_RECENT_REQUIRED' });
    expect(viejo.orden).toEqual([]);

    const reciente = bancoMembresia(ADMIN);
    reciente.db.withRequestContext.mockResolvedValueOnce({ count: '1' });
    await expect(
      requestContextStorage.run(conDosPasos(2), () => quitar(reciente.controller, ACTOR)),
    ).resolves.toMatchObject({ status: 'removed' });

    // Un vendedor: sin contexto de 2FA alcanza.
    const vendedor = bancoMembresia(VENDEDOR);
    await expect(quitar(vendedor.controller, ACTOR)).resolves.toMatchObject({ status: 'removed' });
  });

  it('el 2FA se pide después de autorizar: sin rango, el motivo es el rango y no el código', async () => {
    const superior = bancoMembresia({ ...VENDEDOR, role: 'tenant_admin' }, 'admin');
    await expect(
      requestContextStorage.run(conDosPasos(30), () => quitar(superior.controller, ACTOR)),
    ).rejects.toMatchObject({ reason: 'ROLE_NOT_GRANTABLE' });
  });

  it('si algo falla dentro de la transacción, no hay aviso', async () => {
    const { controller, audit, notices } = bancoMembresia(VENDEDOR);
    audit.emitWithin.mockImplementationOnce(() => Promise.reject(new Error('el evento no entró')));

    await expect(quitar(controller, ACTOR)).rejects.toThrow('el evento no entró');
    expect(notices.notify).not.toHaveBeenCalled();
  });
});

describe('AdminController: una membership quitada no se reactiva ni cambia de rol', () => {
  const QUITADA = { id: 'm-30', role: 'vendedor' as Role, status: 'removed' as MembershipStatus };

  it('reactivar, suspender o cambiarle el rol: 409 MEMBERSHIP_REMOVED, sin tocar nada', async () => {
    for (const cambio of [
      (c: AdminController) =>
        c.setMembershipStatus(ACTOR, { userId: OTRO, tenantId: NODO, status: 'active' }),
      (c: AdminController) =>
        c.setMembershipStatus(ACTOR, { userId: OTRO, tenantId: NODO, status: 'suspended' }),
      (c: AdminController) => c.changeRole(ACTOR, { userId: OTRO, tenantId: NODO, role: 'admin' }),
    ]) {
      const { controller, orden, notices } = bancoMembresia(QUITADA);
      await expect(cambio(controller)).rejects.toMatchObject({ reason: 'MEMBERSHIP_REMOVED' });
      expect(orden).toEqual([]);
      expect(notices.notify).not.toHaveBeenCalled();
    }
  });

  it('si otro admin la quitó entre la lectura y el cambio, la fila tomada lo dice', async () => {
    const vigente = { ...QUITADA, status: 'active' as MembershipStatus };
    const { controller, orden } = bancoMembresia(vigente, 'tenant_admin', {
      role: 'vendedor',
      status: 'removed',
    });
    await expect(
      controller.setMembershipStatus(ACTOR, { userId: OTRO, tenantId: NODO, status: 'active' }),
    ).rejects.toMatchObject({ reason: 'MEMBERSHIP_REMOVED' });
    expect(orden).toEqual(['fila']);
  });

  it('el impacto de una ya quitada es 409; el de quitarla simula la baja con quién y cuándo', async () => {
    const quitada = banco({ roleOver: 'tenant_admin', membresia: QUITADA });
    await expect(
      quitada.controller.membershipImpact(ACTOR, {
        userId: OTRO,
        tenantId: NODO,
        status: 'removed',
      }),
    ).rejects.toMatchObject({ reason: 'MEMBERSHIP_REMOVED' });
    expect(quitada.invitations.orphanedInvitations).not.toHaveBeenCalled();

    const { controller, update, invitations } = bancoMembresia({ ...QUITADA, status: 'active' });
    await expect(
      controller.membershipImpact(ACTOR, { userId: OTRO, tenantId: NODO, status: 'removed' }),
    ).resolves.toEqual({ invitationsToRevoke: 0 });
    expect(invitations.orphanedInvitations).toHaveBeenCalledTimes(1);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'removed', removed_by: ACTOR }),
    );
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
    await expect(invitar(controller, 'vendedor')).rejects.toThrow('Ese nodo no está en tu red.');
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

describe('InvitationsController.revoke: el rango se mide sobre el nodo de la invitación', () => {
  const INVITACION = '44444444-4444-4444-8444-444444444444';

  function revocar(roleOver: Role | undefined) {
    const service = { revoke: vi.fn(() => Promise.resolve({ ok: true as const })) };
    const network = { roleOver: vi.fn(() => Promise.resolve(roleOver)) };
    const controller = new InvitationsController(
      service as unknown as InvitationsService,
      network as unknown as NetworkService,
    );
    return { controller, service, network };
  }

  it('fuera de la red, 403 sin llegar al servicio', async () => {
    const { controller, service } = revocar(undefined);
    await expect(controller.revoke(ACTOR, INVITACION, NODO)).rejects.toThrow(
      'Ese nodo no está en tu red.',
    );
    expect(service.revoke).not.toHaveBeenCalled();
  });

  it('le pasa al servicio el rol con que administra el nodo', async () => {
    const { controller, service, network } = revocar('admin');
    await controller.revoke(ACTOR, INVITACION, NODO);
    expect(network.roleOver).toHaveBeenCalledWith(ACTOR, NODO);
    expect(service.revoke).toHaveBeenCalledWith(ACTOR, 'admin', NODO, INVITACION);
  });

  it('sin sesión, 401', async () => {
    const { controller } = revocar('admin');
    await expect(controller.revoke(undefined, INVITACION, NODO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('los rechazos llegan a Equipo tal cual: en tú y en castellano', () => {
  it('sobre sí mismo', async () => {
    const { controller } = banco({ roleOver: 'tenant_admin' });
    const yo = { userId: ACTOR, tenantId: NODO };

    await expect(controller.changeRole(ACTOR, { ...yo, role: 'vendedor' })).rejects.toThrow(
      'no puedes cambiar tu propio rol',
    );
    await expect(
      controller.setMembershipStatus(ACTOR, { ...yo, status: 'suspended' }),
    ).rejects.toThrow('no puedes cambiar el estado de tu propia membresía');
    await expect(
      controller.membershipImpact(ACTOR, { ...yo, status: 'suspended' }),
    ).rejects.toThrow('no puedes cambiar tu propia membresía');
    const plataforma = banco({ superadmin: true });
    await expect(
      plataforma.controller.setUserStatus(ACTOR, { userId: ACTOR, status: 'suspended' }),
    ).rejects.toThrow('no puedes suspender tu propio usuario');
  });

  it('fuera de la red, sin membresía en el nodo o sin ser superadmin', async () => {
    const cambio = { userId: OTRO, tenantId: NODO, role: 'vendedor' as const };

    await expect(
      banco({ roleOver: undefined }).controller.changeRole(ACTOR, cambio),
    ).rejects.toThrow('No administras este nodo.');
    await expect(
      banco({ roleOver: 'tenant_admin', membresia: undefined }).controller.changeRole(
        ACTOR,
        cambio,
      ),
    ).rejects.toThrow('Ese usuario no es miembro de este nodo.');
    await expect(banco({ superadmin: false }).controller.listTenants(ACTOR)).rejects.toThrow(
      'Esta acción es sólo para el superadmin.',
    );
  });

  it('el último administrador activo del nodo', async () => {
    // La misma lectura doble devuelve la membership y el conteo de admins restantes (cero).
    const { controller } = banco({
      roleOver: 'tenant_admin',
      membresia: { id: 'm-9', role: 'admin', count: '0' } as { id: string; role: Role },
    });

    await expect(
      controller.setMembershipStatus(ACTOR, { userId: OTRO, tenantId: NODO, status: 'suspended' }),
    ).rejects.toThrow(
      'Es el último administrador activo del nodo: asigna otro antes de suspenderlo.',
    );
  });

  it('invitaciones: rango y nodo', async () => {
    const network = {
      roleOver: vi.fn(() => Promise.resolve('admin' as Role)),
      isSuperadmin: vi.fn(() => Promise.resolve(false)),
    };
    const controller = new InvitationsController(
      { invite: vi.fn() } as unknown as InvitationsService,
      network as unknown as NetworkService,
    );

    await expect(
      controller.invite(ACTOR, { email: 'x@example.com', tenantId: NODO, role: 'admin' }),
    ).rejects.toThrow('no puedes invitar con un rol igual o superior al tuyo');
  });
});

/**
 * Una base que corre lo que le pasan: la cuenta estaba en `previo` (`null` = no existe) y el
 * UPDATE de `users` toca `filas` filas. Para seguir el orden de la suspensión de una cuenta (guarda,
 * estado anterior, cambio, sesiones, invitaciones, evento, commit y aviso) sin Postgres.
 */
function bancoCuenta({
  filas = 1n,
  superadmin = true,
  previo = 'active',
}: { filas?: bigint; superadmin?: boolean; previo?: UserStatus | null } = {}) {
  const orden: string[] = [];
  const select = {
    select: vi.fn(() => select),
    where: vi.fn(() => select),
    forNoKeyUpdate: vi.fn(() => select),
    executeTakeFirst: vi.fn(() => {
      orden.push('previo');
      return Promise.resolve(previo === null ? undefined : { status: previo });
    }),
  };
  const update = {
    set: vi.fn(() => update),
    where: vi.fn(() => update),
    execute: vi.fn(() => {
      orden.push('update');
      return Promise.resolve([]);
    }),
    executeTakeFirstOrThrow: vi.fn(() => {
      orden.push('update');
      return Promise.resolve({ numUpdatedRows: filas });
    }),
  };
  const trx = { updateTable: vi.fn(() => update), selectFrom: vi.fn(() => select) };
  const db = {
    withRequestContext: vi.fn(async (_ctx: unknown, fn: (t: unknown) => Promise<unknown>) => {
      const result = await fn(trx);
      orden.push('commit');
      return result;
    }),
  };
  const sessions = {
    revokeAllForUser: vi.fn(() => {
      orden.push('sesiones');
      return Promise.resolve(2);
    }),
  };
  const invitations = {
    orphanedInvitations: vi.fn(() => {
      orden.push('huérfanas');
      return Promise.resolve([{ id: 'i-1' }, { id: 'i-2' }, { id: 'i-3' }]);
    }),
    revokeOrphaned: vi.fn(() => {
      orden.push('invitaciones');
      return Promise.resolve([{ id: 'i-1' }]);
    }),
  };
  const audit = {
    emitWithin: vi.fn(() => {
      orden.push('evento');
      return Promise.resolve();
    }),
  };
  const platformUsers = {
    list: vi.fn(() => Promise.resolve({ users: [], nextCursor: null })),
    footprint: vi.fn(() => Promise.resolve({ activeMemberships: 2, liveSessions: 1 })),
    assertNotLastSuperadmin: vi.fn(() => {
      orden.push('guarda');
      return Promise.resolve();
    }),
  };
  const notices = {
    notify: vi.fn(() => {
      orden.push('aviso');
    }),
  };
  const controller = new AdminController(
    db as unknown as DatabaseService,
    { isSuperadmin: vi.fn(() => Promise.resolve(superadmin)) } as unknown as NetworkService,
    audit as unknown as AuditService,
    sessions as unknown as SessionService,
    {} as TenantsService,
    {} as SeatsService,
    invitations as unknown as InvitationsService,
    platformUsers as unknown as PlatformUsersService,
    notices as unknown as SecurityNoticeService,
  );
  return {
    controller,
    orden,
    update,
    select,
    sessions,
    invitations,
    audit,
    platformUsers,
    notices,
  };
}

describe('Plataforma → Usuarios: directorio y cuenta en toda la plataforma, sólo superadmin', () => {
  it.each([
    ['el directorio', (c: AdminController, u?: string) => c.listUsers(u, { q: 'ana' })],
    ['el impacto de suspender', (c: AdminController, u?: string) => c.userImpact(u, OTRO)],
    [
      'suspender la cuenta',
      (c: AdminController, u?: string) => c.setUserStatus(u, { userId: OTRO, status: 'suspended' }),
    ],
  ])('%s: 401 sin sesión y 403 a un admin de red; el servicio no se entera', async (_q, call) => {
    const { controller, platformUsers, db } = banco({
      superadmin: false,
      roleOver: 'consolidator_admin',
    });

    await expect(call(controller, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(call(controller, ACTOR)).rejects.toThrow(
      'Esta acción es sólo para el superadmin.',
    );
    for (const fn of Object.values(platformUsers)) expect(fn).not.toHaveBeenCalled();
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('el directorio le pasa al servicio el actor y los filtros tal cual', async () => {
    const { controller, platformUsers } = banco({ superadmin: true });
    const query = { q: 'ana', status: 'active' as const, limit: 20 };

    await expect(controller.listUsers(ACTOR, query)).resolves.toEqual({
      users: [],
      nextCursor: null,
    });
    expect(platformUsers.list).toHaveBeenCalledWith(ACTOR, query);
  });

  it('impacto: nodos y sesiones de la cuenta, y las invitaciones que revocaría sin escribir nada', async () => {
    const { controller, platformUsers, invitations, update, orden } = bancoCuenta();

    await expect(controller.userImpact(ACTOR, OTRO)).resolves.toEqual({
      activeMemberships: 2,
      liveSessions: 1,
      invitationsToRevoke: 3,
    });
    expect(platformUsers.footprint).toHaveBeenCalledWith(ACTOR, OTRO);
    // Simula la suspensión y pregunta por TODAS sus invitaciones, sin acotar a un nodo.
    expect(update.set).toHaveBeenCalledWith({ status: 'suspended' });
    expect(invitations.orphanedInvitations).toHaveBeenCalledWith(expect.anything(), {
      inviterUserId: OTRO,
    });
    expect(orden).toEqual(['update', 'huérfanas']);
    expect(invitations.revokeOrphaned).not.toHaveBeenCalled();
  });

  it('impacto: sobre uno mismo es 403 sin mirar nada; una cuenta que no existe, 404', async () => {
    const yo = bancoCuenta();
    await expect(yo.controller.userImpact(ACTOR, ACTOR)).rejects.toThrow(
      'no puedes suspender tu propio usuario',
    );
    expect(yo.platformUsers.footprint).not.toHaveBeenCalled();

    const nadie = bancoCuenta();
    nadie.platformUsers.footprint.mockRejectedValueOnce(new UserNotFoundError());
    await expect(nadie.controller.userImpact(ACTOR, OTRO)).rejects.toMatchObject({
      reason: 'USER_NOT_FOUND',
      message: 'Ese usuario no existe.',
    });
    expect(nadie.invitations.orphanedInvitations).not.toHaveBeenCalled();
  });

  it('suspender: guarda, estado anterior, cambio, sesiones, invitaciones, evento y, tras el commit, el aviso', async () => {
    const { controller, orden, platformUsers, notices, select } = bancoCuenta();

    await expect(
      controller.setUserStatus(ACTOR, { userId: OTRO, status: 'suspended' }),
    ).resolves.toEqual({
      id: OTRO,
      status: 'suspended',
      revokedSessions: 2,
      revokedInvitations: 1,
    });
    expect(platformUsers.assertNotLastSuperadmin).toHaveBeenCalledWith(expect.anything(), OTRO);
    // El estado anterior se lee con la fila tomada, para no avisar de un cambio que no hubo.
    expect(select.forNoKeyUpdate).toHaveBeenCalledTimes(1);
    expect(orden).toEqual([
      'guarda',
      'previo',
      'update',
      'sesiones',
      'invitaciones',
      'evento',
      'commit',
      'aviso',
    ]);
    // Sin nodo de por medio: sale por el correo de su nodo y no nombra ninguno.
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith('account_suspended', {
      userId: OTRO,
      tenantId: null,
    });
  });

  it('suspender al último superadmin activo: 409 con motivo y no cambia nada', async () => {
    const { controller, platformUsers, update, sessions, audit, notices } = bancoCuenta();
    platformUsers.assertNotLastSuperadmin.mockRejectedValueOnce(new LastSuperadminError());

    const res = controller.setUserStatus(ACTOR, { userId: OTRO, status: 'suspended' });
    await expect(res).rejects.toBeInstanceOf(LastSuperadminError);
    await expect(res).rejects.toMatchObject({
      reason: 'LAST_SUPERADMIN',
      message: 'Es el último superadmin activo: no se puede suspender.',
    });
    expect(update.executeTakeFirstOrThrow).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.emitWithin).not.toHaveBeenCalled();
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('una cuenta que no existe: 404 con motivo, sin revocar nada, dejar evento ni avisar', async () => {
    for (const b of [bancoCuenta({ previo: null }), bancoCuenta({ filas: 0n })]) {
      await expect(
        b.controller.setUserStatus(ACTOR, { userId: OTRO, status: 'suspended' }),
      ).rejects.toMatchObject({ reason: 'USER_NOT_FOUND', message: 'Ese usuario no existe.' });
      expect(b.sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(b.invitations.revokeOrphaned).not.toHaveBeenCalled();
      expect(b.audit.emitWithin).not.toHaveBeenCalled();
      expect(b.notices.notify).not.toHaveBeenCalled();
    }
    // Sin la fila, ni se intenta el cambio.
    const nadie = bancoCuenta({ previo: null });
    await expect(
      nadie.controller.setUserStatus(ACTOR, { userId: OTRO, status: 'active' }),
    ).rejects.toMatchObject({ reason: 'USER_NOT_FOUND' });
    expect(nadie.update.executeTakeFirstOrThrow).not.toHaveBeenCalled();
  });

  it('reactivar no pasa por la guarda ni revoca nada; queda el evento y, tras el commit, el aviso', async () => {
    const { controller, orden, platformUsers, notices } = bancoCuenta({ previo: 'suspended' });

    await expect(
      controller.setUserStatus(ACTOR, { userId: OTRO, status: 'active' }),
    ).resolves.toEqual({ id: OTRO, status: 'active', revokedSessions: 0, revokedInvitations: 0 });
    expect(platformUsers.assertNotLastSuperadmin).not.toHaveBeenCalled();
    expect(orden).toEqual(['previo', 'update', 'evento', 'commit', 'aviso']);
    expect(notices.notify).toHaveBeenCalledWith('account_reactivated', {
      userId: OTRO,
      tenantId: null,
    });
  });

  it('si el estado ya era ése, el cambio y el evento quedan pero no hay aviso', async () => {
    const reactivar = bancoCuenta({ previo: 'active' });
    await reactivar.controller.setUserStatus(ACTOR, { userId: OTRO, status: 'active' });
    expect(reactivar.audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(reactivar.notices.notify).not.toHaveBeenCalled();

    const suspender = bancoCuenta({ previo: 'suspended' });
    await suspender.controller.setUserStatus(ACTOR, { userId: OTRO, status: 'suspended' });
    expect(suspender.audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(suspender.notices.notify).not.toHaveBeenCalled();
  });

  it('si algo falla dentro de la transacción, no hay aviso', async () => {
    const { controller, audit, notices } = bancoCuenta();
    audit.emitWithin.mockImplementationOnce(() => Promise.reject(new Error('el evento no entró')));

    await expect(
      controller.setUserStatus(ACTOR, { userId: OTRO, status: 'suspended' }),
    ).rejects.toThrow('el evento no entró');
    expect(notices.notify).not.toHaveBeenCalled();
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
    const support = {
      resetMfa: vi.fn(),
      revokeSessions: vi.fn(),
      sendPasswordReset: vi.fn(),
      unlock: vi.fn(),
    };
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
    await expect(supportCtl.sendPasswordReset(undefined, NODO, OTRO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(supportCtl.unlock(undefined, NODO, OTRO)).rejects.toBeInstanceOf(
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

  it('enviar el enlace y desbloquear: el actor y los ids llegan tal cual, la respuesta también', async () => {
    const support = {
      sendPasswordReset: vi.fn(() =>
        Promise.resolve({ sent: true, expiresAt: '2026-10-11T13:00:00.000Z' }),
      ),
      unlock: vi.fn(() => Promise.resolve({ unlocked: false })),
    };
    const supportCtl = new MemberSupportController(support as unknown as MemberSupportService);

    expect(await supportCtl.sendPasswordReset(ACTOR, NODO, OTRO)).toEqual({
      sent: true,
      expiresAt: '2026-10-11T13:00:00.000Z',
    });
    expect(await supportCtl.unlock(ACTOR, NODO, OTRO)).toEqual({ unlocked: false });
    expect(support.sendPasswordReset).toHaveBeenCalledWith(ACTOR, NODO, OTRO);
    expect(support.unlock).toHaveBeenCalledWith(ACTOR, NODO, OTRO);
  });

  it('enviar el enlace tiene su propio límite por minuto', () => {
    const handler = Object.getOwnPropertyDescriptor(
      MemberSupportController.prototype,
      'sendPasswordReset',
    )?.value as unknown;
    expect(typeof handler).toBe('function');
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', handler as object) as unknown;
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', handler as object) as unknown;
    expect(limit).toBe(10);
    expect(ttl).toBe(60_000);
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

  describe('quitar a una persona de un nodo', () => {
    const quitar = new ZodValidationPipe(RemoveMembershipSchema);

    it('los dos ids, en minúsculas', () => {
      expect(
        quitar.transform({ userId: OTRO.toUpperCase(), tenantId: NODO.toUpperCase() }),
      ).toEqual({ userId: OTRO, tenantId: NODO });
    });

    it.each([
      ['sin el nodo', { userId: OTRO }],
      ['un id que no es uuid', { userId: 'ana', tenantId: NODO }],
      ['campos de más', { userId: OTRO, tenantId: NODO, status: 'removed' }],
    ])('rechaza: %s', (_q, body) => {
      expect(() => quitar.transform(body)).toThrow(BadRequestException);
    });

    it('el impacto de quitarla se pregunta con status=removed', () => {
      const impacto = new ZodValidationPipe(MembershipImpactQuerySchema);
      expect(impacto.transform({ userId: OTRO, tenantId: NODO, status: 'removed' })).toEqual({
        userId: OTRO,
        tenantId: NODO,
        status: 'removed',
      });
    });
  });

  describe('directorio de usuarios de la plataforma', () => {
    const directorio = new ZodValidationPipe(ListPlatformUsersQuerySchema);

    it('sin filtros; los filtros que vienen, con la búsqueda recortada, el nodo en minúsculas y el tamaño como texto', () => {
      expect(directorio.transform({})).toEqual({});
      expect(
        directorio.transform({
          q: '  ana  ',
          status: 'suspended',
          role: 'superadmin',
          tenantId: NODO.toUpperCase(),
          mfa: 'off',
          locked: 'true',
          neverLoggedIn: 'true',
          limit: '20',
        }),
      ).toEqual({
        q: 'ana',
        status: 'suspended',
        role: 'superadmin',
        tenantId: NODO,
        mfa: 'off',
        locked: 'true',
        neverLoggedIn: 'true',
        limit: 20,
      });
    });

    it('el cursor va y vuelve igual, con microsegundos y el id en minúsculas', () => {
      const cursor = encodePlatformUsersCursor({
        createdAt: '2026-10-11T12:00:00.123456Z',
        id: OTRO,
      });
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(directorio.transform({ cursor })).toEqual({ cursor });
      expect(decodePlatformUsersCursor(cursor)).toEqual({
        createdAt: '2026-10-11T12:00:00.123456Z',
        id: OTRO,
      });
      const mayusculas = encodePlatformUsersCursor({
        createdAt: '2026-10-11T12:00:00Z',
        id: OTRO.toUpperCase(),
      });
      expect(decodePlatformUsersCursor(mayusculas)?.id).toBe(OTRO);
    });

    it.each([
      ['una búsqueda vacía', { q: '   ' }],
      ['una búsqueda de más de 100', { q: 'a'.repeat(101) }],
      ['un estado desconocido', { status: 'invited' }],
      ['un rol retirado', { role: 'platform_admin' }],
      ['un rol inventado', { role: 'jefe' }],
      ['un nodo que no es uuid', { tenantId: 'planetour' }],
      ['2FA que no es on/off', { mfa: 'yes' }],
      ['un filtro de bandera en false', { locked: 'false' }],
      ['tamaño 0', { limit: '0' }],
      ['tamaño 101', { limit: '101' }],
      ['tamaño con decimales', { limit: '5.5' }],
      ['un cursor que no es base64url', { cursor: 'no es un cursor' }],
      [
        'un cursor sin instante válido',
        {
          cursor: Buffer.from(JSON.stringify({ createdAt: 'ayer', id: OTRO })).toString(
            'base64url',
          ),
        },
      ],
      [
        'un cursor sin uuid',
        {
          cursor: Buffer.from(
            JSON.stringify({ createdAt: '2026-10-11T12:00:00Z', id: '1' }),
          ).toString('base64url'),
        },
      ],
      ['parámetros de más', { q: 'ana', page: '2' }],
    ])('rechaza: %s', (_q, query) => {
      expect(() => directorio.transform(query)).toThrow(BadRequestException);
    });

    it('un cursor que no es JSON o no es objeto no se lee', () => {
      expect(decodePlatformUsersCursor(Buffer.from('{').toString('base64url'))).toBeUndefined();
      expect(decodePlatformUsersCursor(Buffer.from('7').toString('base64url'))).toBeUndefined();
      expect(
        decodePlatformUsersCursor(
          Buffer.from(JSON.stringify({ createdAt: '2026-13-45T99:99:99Z', id: OTRO })).toString(
            'base64url',
          ),
        ),
      ).toBeUndefined();
    });

    it('un cursor con un día u hora que no existe no se lee: Postgres lo rechazaba con un 500', () => {
      const cursorAt = (createdAt: string) =>
        decodePlatformUsersCursor(
          Buffer.from(JSON.stringify({ createdAt, id: OTRO })).toString('base64url'),
        );
      expect(cursorAt('2026-02-30T00:00:00Z')).toBeUndefined();
      expect(cursorAt('2026-01-01T24:00:00.5Z')).toBeUndefined();
      expect(cursorAt('2026-01-01T23:60:00Z')).toBeUndefined();
      expect(cursorAt('0000-01-01T00:00:00Z')).toBeUndefined();
      expect(cursorAt('2024-02-29T23:59:59.999999Z')).toEqual({
        createdAt: '2024-02-29T23:59:59.999999Z',
        id: OTRO,
      });
    });

    it('una búsqueda con NUL es 400: Postgres no la admite en un texto y respondía 500', () => {
      expect(() => directorio.transform({ q: 'ana\u0000' })).toThrow(BadRequestException);
      expect(directorio.transform({ q: 'ana_50%' })).toEqual({ q: 'ana_50%' });
    });

    it('suspender una cuenta: el id en minúsculas, para reconocer el propio', () => {
      expect(
        new ZodValidationPipe(SetUserStatusSchema).transform({
          userId: OTRO.toUpperCase(),
          status: 'suspended',
        }),
      ).toEqual({ userId: OTRO, status: 'suspended' });
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
