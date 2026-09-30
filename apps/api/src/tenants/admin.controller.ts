import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ChangeRoleSchema,
  CreateTenantSchema,
  CreateUserSchema,
  MoveTenantSchema,
  SetMembershipStatusSchema,
  SetUserStatusSchema,
  TenantIdParamSchema,
  UpdateSeatsSchema,
  UpdateTenantSchema,
  type ChangeRoleDto,
  type CreateTenantDto,
  type CreateUserDto,
  type MoveTenantDto,
  type SetMembershipStatusDto,
  type SetUserStatusDto,
  type UpdateSeatsDto,
  type UpdateTenantDto,
} from './dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ADMIN_ROLES, AGENCY_ADMIN_ROLES, isAdminRole } from '../auth/roles.js';
import { TenantSeatsSuperadminOnlyError, type SeatsView } from './seats.policy.js';
import { SeatsService } from './seats.service.js';
import { assertCanGrant } from './tenant-admin.policy.js';
import {
  TenantsService,
  type CreatedTenant,
  type MovedTenant,
  type NetworkNode,
  type TenantState,
} from './tenants.service.js';

@Roles(...AGENCY_ADMIN_ROLES)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly tenants: TenantsService,
    private readonly seats: SeatsService,
  ) {}

  /** Cambia el rol de un usuario en un tenant. Sólo si el solicitante administra ese tenant. */
  @Patch('memberships/role')
  async changeRole(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ChangeRoleSchema)) body: ChangeRoleDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    // Sin esto, un `admin` podía promoverse a consolidator_admin dentro de su propio nodo.
    if (body.userId === userId) {
      throw new ForbiddenException('no podés cambiar tu propio rol');
    }

    const actorRole = await this.actorRoleOver(userId, body.tenantId);

    const current = await this.db.withRequestContext({ userId, tenantId: body.tenantId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['id', 'role'])
        .where('user_id', '=', body.userId)
        .where('tenant_id', '=', body.tenantId)
        .executeTakeFirst(),
    );
    if (!current) throw new ForbiddenException('membership not found in this tenant');

    // Hay que superar en rango tanto al rol actual del objetivo (para poder tocarlo) como
    // al rol que se le quiere dar (para no conceder más autoridad de la propia).
    this.assertOutranks(actorRole, current.role);
    this.assertOutranks(actorRole, body.role);

    // Degradar al último admin dejaría el nodo sin quien lo administre.
    if (isAdminRole(current.role) && !isAdminRole(body.role)) {
      await this.assertNotLastAdmin(userId, body.tenantId, body.userId);
    }

    const updated = await this.db.withRequestContext({ userId, tenantId: body.tenantId }, (trx) =>
      trx
        .updateTable('memberships')
        .set({ role: body.role })
        .where('user_id', '=', body.userId)
        .where('tenant_id', '=', body.tenantId)
        .returning(['id', 'role'])
        .executeTakeFirst(),
    );
    if (!updated) throw new ForbiddenException('membership not found in this tenant');

    await this.audit.emit({
      eventType: 'MembershipRoleChanged',
      tenantId: body.tenantId,
      actorUserId: userId,
      aggregateType: 'membership',
      aggregateId: updated.id,
      payload: { targetUserId: body.userId, newRole: body.role },
    });
    return { id: updated.id, role: updated.role };
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

  @Get('users')
  async listUsers(@CurrentUser() userId: string | undefined) {
    // Panel de plataforma: lista usuarios de TODOS los tenants ⇒ sólo superadmin.
    await this.assertSuperadmin(userId);

    const rows = await this.db.withRequestContext({ userId }, async (trx) => {
      return trx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
        .select([
          'users.id',
          'users.email',
          'users.name',
          'users.status',
          'memberships.role',
          'tenants.name as tenantName',
          'users.created_at',
          'users.last_login_at',
        ])
        .orderBy('users.created_at', 'desc')
        .execute();
    });

    return {
      users: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        status: r.status,
        role: r.role,
        tenantName: r.tenantName,
        createdAt: r.created_at,
        // Antes iba `null` fijo aunque la columna existe.
        lastLoginAt: r.last_login_at,
      })),
    };
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

  @Post('users')
  async createUser(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    // G-06: el rango se mide sobre el nodo DESTINO. Antes no se medía: un `admin` creaba un
    // consolidator_admin o un tenant_admin, incluso con su propio email en un nodo hijo.
    const actorRole = await this.actorRoleOver(
      userId,
      body.tenantId,
      'target tenant is outside your network',
    );
    this.assertOutranks(actorRole, body.role);

    const existingUser = await this.db.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', body.email)
      .executeTakeFirst();
    if (existingUser) {
      const existingMembership = await this.db.withRequestContext({ userId }, async (trx) => {
        return trx
          .selectFrom('memberships')
          .select('id')
          .where('user_id', '=', existingUser.id)
          .where('tenant_id', '=', body.tenantId)
          .executeTakeFirst();
      });
      if (existingMembership) throw new ConflictException('user already belongs to this tenant');
    }

    const result = await this.db.db.transaction().execute(async (trx) => {
      let newUserId: string;

      if (existingUser) {
        newUserId = existingUser.id;
      } else {
        const hash = await this.password.hash(body.password);
        const user = await trx
          .insertInto('users')
          .values({
            email: body.email,
            name: body.name,
            password_hash: hash,
          })
          .returning(['id', 'email', 'name'])
          .executeTakeFirstOrThrow();
        newUserId = user.id;
      }

      await sql`SELECT set_config('app.current_tenant_id', ${body.tenantId}, true)`.execute(trx);
      await trx
        .insertInto('memberships')
        .values({
          tenant_id: body.tenantId,
          user_id: newUserId,
          role: body.role,
          invited_by: userId,
        })
        .execute();

      const user = await trx
        .selectFrom('users')
        .select(['id', 'email', 'name', 'status'])
        .where('id', '=', newUserId)
        .executeTakeFirstOrThrow();

      return user;
    });

    await this.audit.emit({
      eventType: 'UserCreated',
      tenantId: body.tenantId,
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: result.id,
      payload: { email: body.email, role: body.role, existingUserLinked: Boolean(existingUser) },
    });

    return { user: result };
  }

  /**
   * Suspende o reactiva una membership. Es la baja de un vendedor o de una agencia dentro
   * de la red: al suspender se revocan sus sesiones, así que el acceso corta en el acto
   * en lugar de sobrevivir hasta que expire el token.
   */
  @Patch('memberships/status')
  async setMembershipStatus(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SetMembershipStatusSchema)) body: SetMembershipStatusDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    if (body.userId === userId) {
      throw new ForbiddenException('no podés cambiar el estado de tu propia membership');
    }

    const actorRole = await this.actorRoleOver(userId, body.tenantId);

    const target = await this.db.withRequestContext({ userId, tenantId: body.tenantId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['id', 'role'])
        .where('user_id', '=', body.userId)
        .where('tenant_id', '=', body.tenantId)
        .executeTakeFirst(),
    );
    if (!target) throw new ForbiddenException('membership not found in this tenant');

    this.assertOutranks(actorRole, target.role);

    // No dejar el nodo sin ningún admin activo: quedaría inadministrable salvo por soporte.
    if (body.status === 'suspended' && isAdminRole(target.role)) {
      await this.assertNotLastAdmin(userId, body.tenantId, body.userId);
    }

    await this.db.withRequestContext({ userId, tenantId: body.tenantId }, (trx) =>
      trx
        .updateTable('memberships')
        .set({ status: body.status })
        .where('id', '=', target.id)
        .execute(),
    );

    if (body.status === 'suspended') {
      await this.sessions.revokeAllForUser(body.userId, 'membership_suspended');
    }

    await this.audit.emit({
      eventType: 'MembershipStatusChanged',
      tenantId: body.tenantId,
      actorUserId: userId,
      aggregateType: 'membership',
      aggregateId: target.id,
      payload: { targetUserId: body.userId, status: body.status, role: target.role },
    });

    return { id: target.id, status: body.status };
  }

  /**
   * Suspende o reactiva un usuario a nivel plataforma (todas sus memberships a la vez).
   * Sólo superadmin: `users` es cross-tenant, así que un admin de red no debe poder
   * desactivar una identidad que quizá también opera en otra red.
   */
  @Patch('users/status')
  async setUserStatus(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SetUserStatusSchema)) body: SetUserStatusDto,
  ) {
    await this.assertSuperadmin(userId);
    if (body.userId === userId) {
      throw new ForbiddenException('no podés suspender tu propio usuario');
    }

    await this.db.db
      .updateTable('users')
      .set({ status: body.status })
      .where('id', '=', body.userId)
      .execute();

    if (body.status === 'suspended') {
      await this.sessions.revokeAllForUser(body.userId, 'user_suspended');
    }

    await this.audit.emit({
      eventType: 'UserStatusChanged',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: body.userId,
      payload: { status: body.status },
    });

    return { id: body.userId, status: body.status };
  }

  /**
   * El rol con que el actor administra `tenantId` (el de más rango sobre ese nodo o un ancestro;
   * `superadmin` si lo es). 403 si no lo administra.
   */
  private async actorRoleOver(
    actorUserId: string,
    tenantId: string,
    outsideMessage = 'not authorized to manage this tenant',
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
        'es el último administrador activo del tenant: asigná otro antes de suspenderlo',
      );
    }
  }

  /**
   * El id del actor si es superadmin. 401 sin sesión; si no lo es, 403: el de `denied` o, si no se
   * indica, el genérico de siempre.
   */
  private async assertSuperadmin(
    userId: string | undefined,
    denied: () => ForbiddenException = () => new ForbiddenException('superadmin access required'),
  ): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) throw denied();
    return userId;
  }
}
