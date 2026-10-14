import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireRecentMfa } from '../auth/decorators/require-recent-mfa.decorator.js';
import { assertRecentMfa } from '../auth/recent-mfa.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, MembershipStatus, Role } from '../database/database.types.js';
import { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ChangeRoleSchema,
  CreateTenantSchema,
  ListPlatformUsersQuerySchema,
  MembershipImpactQuerySchema,
  MoveTenantSchema,
  RemoveMembershipSchema,
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
  type RemoveMembershipDto,
  type SetMembershipStatusDto,
  type SetUserStatusDto,
  type UpdateSeatsDto,
  type UpdateTenantDto,
} from './dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ADMIN_ROLES, AGENCY_ADMIN_ROLES, isAdminRole, isPlatformRole } from '../auth/roles.js';
import { InvitationsService } from './invitations.service.js';
import { MembershipRemovedError, PlatformRoleNotRemovableError } from './membership.errors.js';
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
  status: MembershipStatus;
}

/** Lo que arrastró un cambio sobre una membership o un usuario, además del cambio mismo. */
interface ChangeEffects {
  revokedSessions: number;
  revokedInvitations: number;
}

/** Lo que devuelve quitar a alguien de un nodo. */
interface RemovedMembership extends ChangeEffects {
  id: string;
  status: 'removed';
}

/** Qué le haría al último admin del nodo el cambio que se rechaza: va en el mensaje del 403. */
type LastAdminChange = 'suspenderlo' | 'quitarlo' | 'cambiarle el rol';

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
    private readonly notices: SecurityNoticeService,
  ) {}

  /**
   * Cambia el rol de un usuario en un tenant. Sólo si el solicitante administra ese tenant.
   *
   * Una degradación puede dejar invitaciones que el usuario emitió y ya no podría emitir (un
   * tenant_admin que invitó a un admin y queda como admin): se revocan en la misma transacción que
   * el cambio y su evento. Después del commit, si el rol de verdad cambió (contra el que había al
   * tomar la fila, `lockMembership`), la persona recibe el aviso `role_changed` con el rol nuevo.
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
    // Quitada del nodo: un rol nuevo sólo llega con una invitación nueva.
    if (current.status === 'removed') throw new MembershipRemovedError();

    // Hay que superar en rango tanto al rol actual del objetivo (para poder tocarlo) como
    // al rol que se le quiere dar (para no conceder más autoridad de la propia).
    this.assertOutranks(actorRole, current.role);
    this.assertOutranks(actorRole, body.role);

    // Degradar al último admin dejaría el nodo sin quien lo administre.
    if (isAdminRole(current.role) && !isAdminRole(body.role)) {
      await this.assertNotLastAdmin(userId, body.tenantId, body.userId, 'cambiarle el rol');
    }

    const { changed, ...effects } = await this.db.withRequestContext(
      { userId, tenantId: body.tenantId },
      async (trx) => {
        await AdminController.lockNodeAdmins(trx, body.tenantId);
        const previous = await this.lockMembership(trx, current.id);
        if (previous.status === 'removed') throw new MembershipRemovedError();
        // Con la fila tomada, otra vez: otro admin pudo cambiarle el rol entre la lectura y acá.
        this.assertOutranks(actorRole, previous.role);
        if (isAdminRole(previous.role) && !isAdminRole(body.role)) {
          await this.assertNotLastAdmin(
            userId,
            body.tenantId,
            body.userId,
            'cambiarle el rol',
            trx,
          );
        }
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
        return { revokedInvitations: revoked.length, changed: previous.role !== body.role };
      },
    );
    if (changed) {
      this.notices.notify('role_changed', {
        userId: body.userId,
        tenantId: body.tenantId,
        role: body.role,
      });
    }
    return { id: current.id, role: body.role, ...effects };
  }

  /**
   * Qué arrastraría suspender la membership, quitarla del nodo o cambiarle el rol, para que la
   * confirmación de Equipo lo diga antes de aplicarlo ("Se revocarán N invitaciones que envió").
   * Mismas validaciones que el cambio (una membership ya quitada es 409). Lo aplica en una
   * transacción que se deshace: el número sale de la misma consulta que usa el cambio, no de una
   * copia de la regla.
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
    if (target.status === 'removed') throw new MembershipRemovedError();
    this.assertOutranks(actorRole, target.role);
    if (query.role !== undefined) this.assertOutranks(actorRole, query.role);

    // Reactivar no le quita potestad a nadie.
    if (query.status === 'active') return { invitationsToRevoke: 0 };

    const orphaned = await this.dryRun({ userId, tenantId: query.tenantId }, async (trx) => {
      if (query.role !== undefined) await this.writeRole(trx, target.id, query.role);
      else if (query.status === 'removed') await this.writeRemoval(trx, target.id, userId);
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
   * en una transacción, con su evento. Después del commit, si el estado de verdad cambió (contra el
   * que había al tomar la fila, `lockMembership`), la persona recibe el aviso de que su acceso a ese
   * nodo fue suspendido o reactivado.
   *
   * Una membership quitada del nodo (USR-11) no se reactiva por acá: 409 MEMBERSHIP_REMOVED, la vuelta
   * es una invitación nueva.
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
    if (target.status === 'removed') throw new MembershipRemovedError();

    this.assertOutranks(actorRole, target.role);

    // No dejar el nodo sin ningún admin activo: quedaría inadministrable salvo por soporte.
    if (body.status === 'suspended' && isAdminRole(target.role)) {
      await this.assertNotLastAdmin(userId, body.tenantId, body.userId, 'suspenderlo');
    }

    const { changed, ...effects } = await this.db.withRequestContext(
      { userId, tenantId: body.tenantId },
      async (trx): Promise<ChangeEffects & { changed: boolean }> => {
        await AdminController.lockNodeAdmins(trx, body.tenantId);
        const previous = await this.lockMembership(trx, target.id);
        if (previous.status === 'removed') throw new MembershipRemovedError();
        // Con la fila tomada, otra vez: otro admin pudo cambiarle el rol entre la lectura y acá.
        this.assertOutranks(actorRole, previous.role);
        if (body.status === 'suspended' && isAdminRole(previous.role)) {
          await this.assertNotLastAdmin(userId, body.tenantId, body.userId, 'suspenderlo', trx);
        }
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
        return { revokedSessions, revokedInvitations, changed: previous.status !== body.status };
      },
    );

    if (changed) {
      this.notices.notify(
        body.status === 'suspended' ? 'membership_suspended' : 'membership_reactivated',
        { userId: body.userId, tenantId: body.tenantId },
      );
    }
    return { id: target.id, status: body.status, ...effects };
  }

  /**
   * Quita a una persona de un nodo (USR-11, founder D2 = A): baja blanda. La membership pasa a
   * `removed` con quién y cuándo (0067), desaparece de Equipo y deja de dar acceso en el acto (todo lo
   * que da acceso o potestad mira `status = 'active'`), pero la fila queda: sus reservas, sus
   * movimientos y su rastro en la auditoría siguen como estaban. Para volver, sólo una invitación
   * nueva, que al aceptarse reactiva esta misma fila con el rol de la invitación.
   *
   * Las reglas de suspender: nunca uno mismo; administrar el nodo y superar su rol en él (o ser
   * superadmin); nunca el último admin activo del nodo. Ya quitada, 409 MEMBERSHIP_REMOVED. Además,
   * un rol de plataforma no se quita (403 PLATFORM_ROLE_NOT_REMOVABLE): ninguna invitación lo
   * devuelve. Las reglas se vuelven a mirar dentro de la transacción, con el nodo en fila
   * (`lockNodeAdmins`) y la fila tomada.
   *
   * Quitar a alguien es el trabajo de todos los días y no pide el 2FA reciente, salvo que su rol en
   * el nodo sea de admin (D1 = C): sacarle el gobierno del nodo a un admin pesa como enviarle el
   * enlace a uno, y con una sesión robada alcanzaría para ir sacando a los demás admins. Se pide
   * después de autorizar, para no pedirle el código a quien igual no podía hacerlo.
   *
   * En una transacción, con la fila tomada: el cambio, el cierre de sus sesiones en el subárbol del
   * nodo (las que no respalda otra membership activa suya, como al suspender), la revocación de las
   * invitaciones que emitió y ya no podría emitir, y el evento `MembershipRemoved`. Después del
   * commit, el aviso `membership_removed` a su correo.
   */
  @Post('memberships/remove')
  @HttpCode(200)
  async removeMembership(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(RemoveMembershipSchema)) body: RemoveMembershipDto,
  ): Promise<RemovedMembership> {
    if (!userId) throw new UnauthorizedException();
    if (body.userId === userId.toLowerCase()) {
      throw new ForbiddenException('no puedes quitarte a ti mismo de un nodo');
    }

    const actorRole = await this.actorRoleOver(userId, body.tenantId);
    const target = await this.targetMembership(userId, body.userId, body.tenantId);
    if (target.status === 'removed') throw new MembershipRemovedError();
    this.assertRemovable(actorRole, target.role);

    if (isAdminRole(target.role)) {
      // Un admin suspendido ya no cuenta entre los activos: quitarlo no le deja menos al nodo.
      if (target.status === 'active') {
        await this.assertNotLastAdmin(userId, body.tenantId, body.userId, 'quitarlo');
      }
      assertRecentMfa();
    }

    const effects = await this.db.withRequestContext(
      { userId, tenantId: body.tenantId },
      async (trx): Promise<ChangeEffects> => {
        await AdminController.lockNodeAdmins(trx, body.tenantId);
        const previous = await this.lockMembership(trx, target.id);
        if (previous.status === 'removed') throw new MembershipRemovedError();
        // Lo de arriba, otra vez con la fila tomada y el nodo en fila: otro admin pudo ascenderla o
        // quitar a otro admin entre la lectura y acá (dos que quitan a los dos últimos a la vez).
        this.assertRemovable(actorRole, previous.role);
        if (isAdminRole(previous.role)) {
          if (previous.status === 'active') {
            await this.assertNotLastAdmin(userId, body.tenantId, body.userId, 'quitarlo', trx);
          }
          assertRecentMfa();
        }
        await this.writeRemoval(trx, target.id, userId);

        const revokedSessions = await this.sessions.revokeForTenant(
          body.userId,
          body.tenantId,
          'membership_removed',
          trx,
        );
        const revoked = await this.invitations.revokeOrphaned(trx, {
          inviterUserId: body.userId,
          rootTenantId: invitationScope(previous.role, body.tenantId),
          actorUserId: userId,
          cause: 'membership_removed',
        });

        await this.audit.emitWithin(trx, {
          eventType: 'MembershipRemoved',
          tenantId: body.tenantId,
          actorUserId: userId,
          aggregateType: 'membership',
          aggregateId: target.id,
          payload: {
            targetUserId: body.userId,
            role: previous.role,
            previousStatus: previous.status,
            revokedSessions,
            revokedInvitations: revoked.length,
          },
        });
        return { revokedSessions, revokedInvitations: revoked.length };
      },
    );

    this.notices.notify('membership_removed', { userId: body.userId, tenantId: body.tenantId });
    return { id: target.id, status: 'removed', ...effects };
  }

  /**
   * Suspende o reactiva un usuario a nivel plataforma (todas sus memberships a la vez).
   * Sólo superadmin: `users` es cross-tenant, así que un admin de red no debe poder
   * desactivar una identidad que quizá también opera en otra red.
   *
   * Suspender cierra TODAS sus sesiones y revoca todas las invitaciones pendientes que emitió, en la
   * misma transacción que el cambio y su evento. 404 si la cuenta no existe (antes respondía como si
   * la hubiera suspendido y dejaba el evento); 409 si es el último superadmin activo.
   *
   * El estado anterior se lee con la fila tomada: después del commit, si de verdad cambió, la persona
   * recibe el aviso de que su cuenta fue suspendida o reactivada (por el correo de su nodo, aunque
   * quede suspendida: es a quien más le importa saberlo).
   *
   * Alto impacto: pide el 2FA de los últimos minutos (`@RequireRecentMfa`, USR-13, D1 = C).
   */
  @RequireRecentMfa()
  @Patch('users/status')
  async setUserStatus(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SetUserStatusSchema)) body: SetUserStatusDto,
  ) {
    const actor = await this.assertSuperadmin(userId);
    if (body.userId === actor) {
      throw new ForbiddenException('no puedes suspender tu propio usuario');
    }

    const { changed, ...effects } = await this.db.withRequestContext(
      { userId: actor },
      async (trx): Promise<ChangeEffects & { changed: boolean }> => {
        if (body.status === 'suspended') {
          await this.platformUsers.assertNotLastSuperadmin(trx, body.userId);
        }
        const previous = await trx
          .selectFrom('users')
          .select('status')
          .where('id', '=', body.userId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (previous === undefined) throw new UserNotFoundError();
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
        return { revokedSessions, revokedInvitations, changed: previous.status !== body.status };
      },
    );

    if (changed) {
      this.notices.notify(
        body.status === 'suspended' ? 'account_suspended' : 'account_reactivated',
        { userId: body.userId, tenantId: null },
      );
    }
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
        .select(['id', 'role', 'status'])
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

  /**
   * El rol y el estado de la membership con la fila tomada, dentro de la transacción del cambio: el
   * aviso a la persona compara con esto y no con la lectura de antes, que otro admin pudo dejar vieja
   * (dos cambios en paralelo darían dos avisos, o uno que no es el último). 403 si la RLS no la deja
   * ver, como el UPDATE que sigue.
   */
  private async lockMembership(
    trx: Transaction<DB>,
    membershipId: string,
  ): Promise<{ role: Role; status: MembershipStatus }> {
    const row = await trx
      .selectFrom('memberships')
      .select(['role', 'status'])
      .where('id', '=', membershipId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new ForbiddenException('Ese usuario no es miembro de este nodo.');
    return row;
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

  /** La deja quitada del nodo, con quién y cuándo (el CHECK de 0067 ata `removed_at` al estado). */
  private async writeRemoval(
    trx: Transaction<DB>,
    membershipId: string,
    actorUserId: string,
  ): Promise<void> {
    AdminController.assertWritten(
      await trx
        .updateTable('memberships')
        .set({ status: 'removed', removed_at: sql<Date>`now()`, removed_by: actorUserId })
        .where('id', '=', membershipId)
        .where('status', '!=', 'removed')
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

  /**
   * Quitar del nodo: superarla en rango, como suspender, y que su rol no sea de plataforma, que
   * ninguna invitación devuelve.
   */
  private assertRemovable(actorRole: Role, targetRole: Role): void {
    this.assertOutranks(actorRole, targetRole);
    if (isPlatformRole(targetRole)) throw new PlatformRoleNotRemovableError();
  }

  /**
   * Pone en fila, hasta el fin de la transacción, los cambios sobre las memberships de un nodo que
   * pueden dejarlo sin admin activo (degradar, suspender, quitar). El chequeo de "último admin" de
   * afuera lee sin tomar nada: dos admins que sacaban a la vez a los dos últimos del nodo lo pasaban
   * los dos y el nodo quedaba sin ninguno. Con esto, el segundo cuenta de nuevo después del commit
   * del primero. Va antes de tomar la fila de la membership, siempre en ese orden.
   */
  private static async lockNodeAdmins(trx: Transaction<DB>, tenantId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('node-admins:' || ${tenantId}::uuid::text, 0))`.execute(
      trx,
    );
  }

  /**
   * 403 si `excludeUserId` es el último admin activo de `tenantId`. Con `trx`, cuenta dentro de la
   * transacción del cambio, ya con `lockNodeAdmins`: ése es el chequeo que vale; el de afuera sólo
   * responde antes (y antes de pedir el 2FA).
   */
  private async assertNotLastAdmin(
    actorUserId: string,
    tenantId: string,
    excludeUserId: string,
    change: LastAdminChange,
    trx?: Transaction<DB>,
  ): Promise<void> {
    const count = (t: Transaction<DB>) =>
      t
        .selectFrom('memberships')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .where('user_id', '!=', excludeUserId)
        .where('role', 'in', [...ADMIN_ROLES])
        .executeTakeFirst();
    const remaining =
      trx === undefined
        ? await this.db.withRequestContext({ userId: actorUserId, tenantId }, count)
        : await count(trx);
    if (Number(remaining?.count ?? 0) === 0) {
      throw new ForbiddenException(
        `Es el último administrador activo del nodo: asigna otro antes de ${change}.`,
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
