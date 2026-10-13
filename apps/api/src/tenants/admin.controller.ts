import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import type { Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ChangeRoleSchema,
  CreateTenantSchema,
  ListPlatformUsersQuerySchema,
  MembershipImpactQuerySchema,
  MoveTenantSchema,
  SetMembershipStatusSchema,
  SetUserStatusSchema,
  TenantIdParamSchema,
  UpdateSeatsSchema,
  UpdateTenantSchema,
  UuidParamSchema,
  type ChangeRoleDto,
  type CreateTenantDto,
  type ListPlatformUsersQuery,
  type MembershipImpactQuery,
  type MoveTenantDto,
  type SetMembershipStatusDto,
  type SetUserStatusDto,
  type UpdateSeatsDto,
  type UpdateTenantDto,
} from './dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ADMIN_ROLES, AGENCY_ADMIN_ROLES, isAdminRole } from '../auth/roles.js';
import { InvitationsService } from './invitations.service.js';
import { UserNotFoundError } from './platform-users.errors.js';
import {
  PlatformUsersService,
  type PlatformUsersPage,
  type UserFootprint,
} from './platform-users.service.js';
import { TenantSeatsSuperadminOnlyError, type SeatsView } from './seats.policy.js';
import { SeatsService } from './seats.service.js';
import { UserCreationRetiredError } from './onboarding.errors.js';
import { assertCanGrant } from './tenant-admin.policy.js';
import {
  TenantsService,
  type CreatedTenant,
  type MovedTenant,
  type NetworkNode,
  type TenantState,
} from './tenants.service.js';

/** Una membership del nodo destino, leída con la RLS del actor. */
interface TargetMembership {
  id: string;
  role: Role;
}

/** Lo que arrastró un cambio sobre una membership o un usuario, además del cambio mismo. */
interface ChangeEffects {
  revokedSessions: number;
  revokedInvitations: number;
}

/** Lo que arrastraría suspender una cuenta en toda la plataforma, para decirlo antes. */
interface UserSuspensionImpact extends UserFootprint {
  invitationsToRevoke: number;
}

/** Deshace la transacción de una simulación devolviendo lo que calculó. */
class DryRunRollback<T> extends Error {
  constructor(readonly result: T) {
    super('dry run');
    this.name = 'DryRunRollback';
  }
}

/**
 * Hasta dónde pudo respaldar invitaciones una membership: su subárbol, o toda la red si es de
 * superadmin, que administra cualquier nodo (también los que no cuelgan de la plataforma).
 */
function invitationScope(role: Role, tenantId: string): string | undefined {
  return role === 'superadmin' ? undefined : tenantId;
}

@Roles(...AGENCY_ADMIN_ROLES)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly tenants: TenantsService,
    private readonly seats: SeatsService,
    private readonly invitations: InvitationsService,
    private readonly platformUsers: PlatformUsersService,
  ) {}

  /**
   * Cambia el rol de un usuario en un tenant. Sólo si el solicitante administra ese tenant.
   *
   * Una degradación puede dejar invitaciones que el usuario emitió y ya no podría emitir (un
   * tenant_admin que invitó a un admin y queda como admin): se revocan en la misma transacción que
   * el cambio y su evento.
   */
  @Patch('memberships/role')
  async changeRole(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ChangeRoleSchema)) body: ChangeRoleDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    // Sin esto, un `admin` podía promoverse a consolidator_admin dentro de su propio nodo.
    if (body.userId === userId) {
      throw new ForbiddenException('no puedes cambiar tu propio rol');
    }

    const actorRole = await this.actorRoleOver(userId, body.tenantId);
    const current = await this.targetMembership(userId, body.userId, body.tenantId);

    // Hay que superar en rango tanto al rol actual del objetivo (para poder tocarlo) como
    // al rol que se le quiere dar (para no conceder más autoridad de la propia).
    this.assertOutranks(actorRole, current.role);
    this.assertOutranks(actorRole, body.role);

    // Degradar al último admin dejaría el nodo sin quien lo administre.
    if (isAdminRole(current.role) && !isAdminRole(body.role)) {
      await this.assertNotLastAdmin(userId, body.tenantId, body.userId);
    }

    const effects = await this.db.withRequestContext(
      { userId, tenantId: body.tenantId },
      async (trx) => {
        await this.writeRole(trx, current.id, body.role);
        const revoked = await this.invitations.revokeOrphaned(trx, {
          inviterUserId: body.userId,
          rootTenantId: invitationScope(current.role, body.tenantId),
          actorUserId: userId,
          cause: 'role_changed',
        });
        await this.audit.emitWithin(trx, {
          eventType: 'MembershipRoleChanged',
          tenantId: body.tenantId,
          actorUserId: userId,
          aggregateType: 'membership',
          aggregateId: current.id,
          payload: {
            targetUserId: body.userId,
            previousRole: current.role,
            newRole: body.role,
            revokedInvitations: revoked.length,
          },
        });
        return { revokedInvitations: revoked.length };
      },
    );
    return { id: current.id, role: body.role, ...effects };
  }

  /**
   * Qué arrastraría suspender la membership o cambiarle el rol, para que la confirmación de Equipo
   * lo diga antes de aplicarlo ("Se revocarán N invitaciones que envió"). Mismas validaciones que el
   * cambio. Lo aplica en una transacción que se deshace: el número sale de la misma consulta que usa
   * el cambio, no de una copia de la regla.
   */
  @Get('memberships/impact')
  async membershipImpact(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(MembershipImpactQuerySchema)) query: MembershipImpactQuery,
  ): Promise<{ invitationsToRevoke: number }> {
    if (!userId) throw new UnauthorizedException();
    if (query.userId === userId) {
      throw new ForbiddenException('no puedes cambiar tu propia membresía');
    }

    const actorRole = await this.actorRoleOver(userId, query.tenantId);
    const target = await this.targetMembership(userId, query.userId, query.tenantId);
    this.assertOutranks(actorRole, target.role);
    if (query.role !== undefined) this.assertOutranks(actorRole, query.role);

    // Reactivar no le quita potestad a nadie.
    if (query.status === 'active') return { invitationsToRevoke: 0 };

    const orphaned = await this.dryRun({ userId, tenantId: query.tenantId }, async (trx) => {
      if (query.role !== undefined) await this.writeRole(trx, target.id, query.role);
      else await this.writeStatus(trx, target.id, 'suspended');
      return this.invitations.orphanedInvitations(trx, {
        inviterUserId: query.userId,
        rootTenantId: invitationScope(target.role, query.tenantId),
      });
    });
    return { invitationsToRevoke: orphaned.length };
  }

  /**
   * Toda la red para el panel de la plataforma, con tipo, sucursal, padre y profundidad. Sólo
   * superadmin: un admin de red ve la suya con /tenants/network.
   */
  @Get('tenants')
  async listTenants(
    @CurrentUser() userId: string | undefined,
  ): Promise<{ tenants: NetworkNode[] }> {
    const actor = await this.assertSuperadmin(userId);
    return { tenants: await this.tenants.listNetwork(actor) };
  }

  /**
   * El directorio de personas de toda la red (Plataforma → Usuarios): una fila por persona con todos
   * sus nodos y roles, búsqueda por nombre o correo, filtros y paginado por cursor. Sólo
   * superadmin: lista usuarios de TODOS los tenants. Ver PlatformUsersService.list.
   */
  @Get('users')
  async listUsers(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(ListPlatformUsersQuerySchema)) query: ListPlatformUsersQuery,
  ): Promise<PlatformUsersPage> {
    const actor = await this.assertSuperadmin(userId);
    return this.platformUsers.list(actor, query);
  }

  /**
   * Qué arrastraría suspender la cuenta en toda la plataforma, para que la confirmación lo diga
   * antes: sus accesos activos, sus sesiones vivas y las invitaciones que se revocarían. Las
   * invitaciones salen de la misma consulta que usa la suspensión, en una transacción que se deshace.
   * Sólo superadmin; nunca sobre uno mismo; 404 si la cuenta no existe.
   */
  @Get('users/:userId/impact')
  async userImpact(
    @CurrentUser() userId: string | undefined,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<UserSuspensionImpact> {
    const actor = await this.assertSuperadmin(userId);
    if (targetUserId === actor) {
      throw new ForbiddenException('no puedes suspender tu propio usuario');
    }

    const footprint = await this.platformUsers.footprint(actor, targetUserId);
    const orphaned = await this.dryRun({ userId: actor }, async (trx) => {
      await trx
        .updateTable('users')
        .set({ status: 'suspended' })
        .where('id', '=', targetUserId)
        .execute();
      return this.invitations.orphanedInvitations(trx, { inviterUserId: targetUserId });
    });
    return { ...footprint, invitationsToRevoke: orphaned.length };
  }

  /**
   * Alta de un nodo de la red: el superadmin en cualquier lugar (sin padre, bajo la plataforma);
   * un admin de red, bajo un nodo que administre. Tipo, sucursal y admin inicial: ver
   * TenantsService.create.
   */
  @Post('tenants')
  async createTenant(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateTenantSchema)) body: CreateTenantDto,
  ): Promise<CreatedTenant> {
    if (!userId) throw new UnauthorizedException();
    return this.tenants.create(userId, body);
  }

  /** Corrige estado, sucursal o tipo de un nodo (dentro de D4). Sólo superadmin, auditado. */
  @Patch('tenants/:id')
  async updateTenant(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(UpdateTenantSchema)) body: UpdateTenantDto,
  ): Promise<{ tenant: TenantState }> {
    const actor = await this.assertSuperadmin(userId);
    return { tenant: await this.tenants.update(actor, tenantId, body) };
  }

  /**
   * Puestos simultáneos e inactividad de un nodo (`null` = heredar). Sólo superadmin (decisión del
   * founder: los fija al crear el nodo y los amplía después; nadie más los toca). Auditado con el
   * antes y el después; devuelve la vista de puestos actualizada. Qué pasa con las sesiones
   * abiertas: ver SeatsService.updatePolicy.
   */
  @Patch('tenants/:id/seats')
  async updateSeats(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(UpdateSeatsSchema)) body: UpdateSeatsDto,
  ): Promise<SeatsView> {
    // El mismo 403 con motivo que el alta con puestos (TenantsService.create): el panel distingue
    // "no es superadmin" de cualquier otro 403 sin leer el mensaje.
    const actor = await this.assertSuperadmin(userId, () => new TenantSeatsSuperadminOnlyError());
    return this.seats.updatePolicy(actor, tenantId, body);
  }

  /** Mueve un nodo con su subárbol bajo otro padre (D6 A). Sólo superadmin, auditado. */
  @Post('tenants/:id/move')
  async moveTenant(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(MoveTenantSchema)) body: MoveTenantDto,
  ): Promise<MovedTenant> {
    const actor = await this.assertSuperadmin(userId);
    return this.tenants.move(actor, tenantId, body.parentTenantId);
  }

  /**
   * Retirado (docs/platform/14): un usuario se suma a un nodo sólo aceptando una invitación
   * (POST /invitations). Sigue la ruta para que un panel viejo reciba un 410 con motivo y no un 404.
   * No lee el body ni la base: la respuesta no cambia exista o no el email.
   */
  @Post('users')
  createUser(): never {
    throw new UserCreationRetiredError();
  }

  /**
   * Suspende o reactiva una membership. Es la baja de un vendedor o de una agencia dentro de la red.
   *
   * La suspensión corta ESE nodo, no a la persona: SessionService.validate lee el estado de la
   * membership en cada request, así que el nodo deja de operar en el acto. Se revocan sólo las
   * sesiones del subárbol del nodo, para liberar su puesto y decirle por qué quedó afuera; las que
   * tiene en otros nodos siguen (antes se cerraban todas, y un vendedor de dos agencias quedaba
   * afuera de las dos). También se revocan las invitaciones que emitió y ya no podría emitir. Todo
   * en una transacción, con su evento.
   */
  @Patch('memberships/status')
  async setMembershipStatus(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SetMembershipStatusSchema)) body: SetMembershipStatusDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    if (body.userId === userId) {
      throw new ForbiddenException('no puedes cambiar el estado de tu propia membresía');
    }

    const actorRole = await this.actorRoleOver(userId, body.tenantId);
    const target = await this.targetMembership(userId, body.userId, body.tenantId);

    this.assertOutranks(actorRole, target.role);

    // No dejar el nodo sin ningún admin activo: quedaría inadministrable salvo por soporte.
    if (body.status === 'suspended' && isAdminRole(target.role)) {
      await this.assertNotLastAdmin(userId, body.tenantId, body.userId);
    }

    const effects = await this.db.withRequestContext(
      { userId, tenantId: body.tenantId },
      async (trx): Promise<ChangeEffects> => {
        await this.writeStatus(trx, target.id, body.status);

        let revokedSessions = 0;
        let revokedInvitations = 0;
        if (body.status === 'suspended') {
          revokedSessions = await this.sessions.revokeForTenant(
            body.userId,
            body.tenantId,
            'membership_suspended',
            trx,
          );
          const revoked = await this.invitations.revokeOrphaned(trx, {
            inviterUserId: body.userId,
            rootTenantId: invitationScope(target.role, body.tenantId),
            actorUserId: userId,
            cause: 'membership_suspended',
          });
          revokedInvitations = revoked.length;
        }

        await this.audit.emitWithin(trx, {
          eventType: 'MembershipStatusChanged',
          tenantId: body.tenantId,
          actorUserId: userId,
          aggregateType: 'membership',
          aggregateId: target.id,
          payload: {
            targetUserId: body.userId,
            status: body.status,
            role: target.role,
            revokedSessions,
            revokedInvitations,
          },
        });
        return { revokedSessions, revokedInvitations };
      },
    );

    return { id: target.id, status: body.status, ...effects };
  }

  /**
   * Suspende o reactiva un usuario a nivel plataforma (todas sus memberships a la vez).
   * Sólo superadmin: `users` es cross-tenant, así que un admin de red no debe poder
   * desactivar una identidad que quizá también opera en otra red.
   *
   * Suspender cierra TODAS sus sesiones y revoca todas las invitaciones pendientes que emitió, en la
   * misma transacción que el cambio y su evento. 404 si la cuenta no existe (antes respondía como si
   * la hubiera suspendido y dejaba el evento); 409 si es el último superadmin activo.
   */
  @Patch('users/status')
  async setUserStatus(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SetUserStatusSchema)) body: SetUserStatusDto,
  ) {
    const actor = await this.assertSuperadmin(userId);
    if (body.userId === actor) {
      throw new ForbiddenException('no puedes suspender tu propio usuario');
    }

    const effects = await this.db.withRequestContext(
      { userId: actor },
      async (trx): Promise<ChangeEffects> => {
        if (body.status === 'suspended') {
          await this.platformUsers.assertNotLastSuperadmin(trx, body.userId);
        }
        const written = await trx
          .updateTable('users')
          .set({ status: body.status })
          .where('id', '=', body.userId)
          .executeTakeFirstOrThrow();
        if (written.numUpdatedRows === 0n) throw new UserNotFoundError();

        let revokedSessions = 0;
        let revokedInvitations = 0;
        if (body.status === 'suspended') {
          revokedSessions = await this.sessions.revokeAllForUser(
            body.userId,
            'user_suspended',
            trx,
          );
          const revoked = await this.invitations.revokeOrphaned(trx, {
            inviterUserId: body.userId,
            actorUserId: actor,
            cause: 'user_suspended',
          });
          revokedInvitations = revoked.length;
        }

        await this.audit.emitWithin(trx, {
          eventType: 'UserStatusChanged',
          actorUserId: actor,
          aggregateType: 'user',
          aggregateId: body.userId,
          payload: { status: body.status, revokedSessions, revokedInvitations },
        });
        return { revokedSessions, revokedInvitations };
      },
    );

    return { id: body.userId, status: body.status, ...effects };
  }

  /** La membership de `targetUserId` en `tenantId`, vista por el actor. 403 si no existe. */
  private async targetMembership(
    actorUserId: string,
    targetUserId: string,
    tenantId: string,
  ): Promise<TargetMembership> {
    const target = await this.db.withRequestContext({ userId: actorUserId, tenantId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['id', 'role'])
        .where('user_id', '=', targetUserId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    );
    if (!target) throw new ForbiddenException('Ese usuario no es miembro de este nodo.');
    return target;
  }

  /**
   * Un UPDATE que la RLS filtra no falla: toca cero filas. Sin esto se revocarían sesiones e
   * invitaciones, y quedaría el evento, de un cambio que no ocurrió.
   */
  private static assertWritten(result: { numUpdatedRows: bigint }): void {
    if (result.numUpdatedRows === 0n) {
      throw new ForbiddenException('Ese usuario no es miembro de este nodo.');
    }
  }

  private async writeRole(trx: Transaction<DB>, membershipId: string, role: Role): Promise<void> {
    AdminController.assertWritten(
      await trx
        .updateTable('memberships')
        .set({ role })
        .where('id', '=', membershipId)
        .executeTakeFirstOrThrow(),
    );
  }

  private async writeStatus(
    trx: Transaction<DB>,
    membershipId: string,
    status: SetMembershipStatusDto['status'],
  ): Promise<void> {
    AdminController.assertWritten(
      await trx
        .updateTable('memberships')
        .set({ status })
        .where('id', '=', membershipId)
        .executeTakeFirstOrThrow(),
    );
  }

  /**
   * Corre `fn` en una transacción con el contexto del request y la deshace: lo que `fn` escribió no
   * queda, lo que devolvió sí.
   */
  private async dryRun<T>(
    ctx: { userId: string; tenantId?: string },
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    try {
      await this.db.withRequestContext(ctx, async (trx) => {
        throw new DryRunRollback(await fn(trx));
      });
    } catch (err) {
      if (err instanceof DryRunRollback) return err.result as T;
      throw err;
    }
    throw new Error('dryRun: la transacción no se deshizo');
  }

  /**
   * El rol con que el actor administra `tenantId` (el de más rango sobre ese nodo o un ancestro;
   * `superadmin` si lo es). 403 si no lo administra.
   */
  private async actorRoleOver(
    actorUserId: string,
    tenantId: string,
    outsideMessage = 'No administras este nodo.',
  ): Promise<Role> {
    const role = await this.network.roleOver(actorUserId, tenantId);
    if (role === undefined) throw new ForbiddenException(outsideMessage);
    return role;
  }

  /**
   * El actor debe superar estrictamente en rango al rol que toca, medido sobre el nodo destino
   * (G-06) y no sobre el tenant activo del request. Impide la auto-promoción y que un `admin`
   * degrade o suspenda a un `tenant_admin` por encima suyo. El superadmin toca cualquier rol;
   * darlo, sólo los asignables (Zod).
   */
  private assertOutranks(actorRole: Role, targetRole: Role): void {
    if (actorRole === 'superadmin') return;
    assertCanGrant(actorRole, targetRole);
  }

  private async assertNotLastAdmin(
    actorUserId: string,
    tenantId: string,
    excludeUserId: string,
  ): Promise<void> {
    const remaining = await this.db.withRequestContext(
      { userId: actorUserId, tenantId },
      async (trx) =>
        trx
          .selectFrom('memberships')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('tenant_id', '=', tenantId)
          .where('status', '=', 'active')
          .where('user_id', '!=', excludeUserId)
          .where('role', 'in', [...ADMIN_ROLES])
          .executeTakeFirst(),
    );
    if (Number(remaining?.count ?? 0) === 0) {
      throw new ForbiddenException(
        'Es el último administrador activo del nodo: asigna otro antes de suspenderlo.',
      );
    }
  }

  /**
   * El id del actor si es superadmin. 401 sin sesión; si no lo es, 403: el de `denied` o, si no se
   * indica, el genérico de siempre.
   */
  private async assertSuperadmin(
    userId: string | undefined,
    denied: () => ForbiddenException = () =>
      new ForbiddenException('Esta acción es sólo para el superadmin.'),
  ): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) throw denied();
    return userId;
  }
}
