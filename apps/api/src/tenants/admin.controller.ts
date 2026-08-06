import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { ADMIN_ROLES, canGrantRole, isAdminRole } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { currentRole } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ChangeRoleSchema,
  CreateTenantSchema,
  CreateUserSchema,
  SetMembershipStatusSchema,
  SetUserStatusSchema,
  type ChangeRoleDto,
  type CreateTenantDto,
  type CreateUserDto,
  type SetMembershipStatusDto,
  type SetUserStatusDto,
} from './dto.js';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
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

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, body.tenantId))) {
      throw new ForbiddenException('not authorized to manage this tenant');
    }

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
    this.assertOutranks(current.role, superadmin);
    this.assertOutranks(body.role, superadmin);

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

  @Get('tenants')
  async listTenants(@CurrentUser() userId: string | undefined) {
    // Panel de plataforma: lista TODOS los tenants ⇒ sólo superadmin (un consolidador usa
    // /tenants/network para ver su propia red).
    await this.assertSuperadmin(userId);

    const rows = await this.db.db
      .selectFrom('tenants')
      .select([
        'tenants.id',
        'tenants.slug',
        'tenants.name',
        'tenants.country_code',
        'tenants.default_currency',
        'tenants.status',
        'tenants.created_at',
      ])
      .orderBy('tenants.created_at', 'desc')
      .execute();

    const tenantIds = rows.map((r) => r.id);
    const counts =
      tenantIds.length > 0
        ? await this.db.withRequestContext({ userId }, async (trx) => {
            return trx
              .selectFrom('memberships')
              .select(['tenant_id'])
              .select((eb) => eb.fn.countAll<number>().as('count'))
              .where('tenant_id', 'in', tenantIds)
              .groupBy('tenant_id')
              .execute();
          })
        : [];

    const countMap = new Map(counts.map((c) => [c.tenant_id, Number(c.count)]));

    return {
      tenants: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        countryCode: r.country_code,
        defaultCurrency: r.default_currency,
        status: r.status,
        userCount: countMap.get(r.id) ?? 0,
        createdAt: r.created_at,
      })),
    };
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
        lastLoginAt: null,
      })),
    };
  }

  @Post('tenants')
  async createTenant(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateTenantSchema)) body: CreateTenantDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

    // Jerarquía: crear un tenant RAÍZ (sin padre) es sólo para superadmin. Un admin de
    // red puede crear sub-agencias, pero sólo bajo un nodo que administre (su subárbol).
    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin) {
      if (!body.parentTenantId) {
        throw new ForbiddenException('only superadmin can create root tenants');
      }
      const canManageParent = await this.network.canManageTenant(userId, body.parentTenantId);
      if (!canManageParent) {
        throw new ForbiddenException('parent tenant is outside your network');
      }
    }

    const existing = await this.db.db
      .selectFrom('tenants')
      .select('id')
      .where('slug', '=', body.slug)
      .executeTakeFirst();
    if (existing) throw new ConflictException('slug already in use');

    const result = await this.db.db.transaction().execute(async (trx) => {
      const tenantType = body.tenantType ?? (body.parentTenantId ? 'subagency' : 'agency');
      const tenant = await trx
        .insertInto('tenants')
        .values({
          slug: body.slug,
          name: body.name,
          country_code: body.countryCode,
          default_currency: body.defaultCurrency,
          default_language: body.defaultLanguage ?? 'es',
          parent_tenant_id: body.parentTenantId ?? null,
          tenant_type: tenantType,
        })
        .returning(['id', 'slug', 'name'])
        .executeTakeFirstOrThrow();

      // El admin de un consolidador es consolidator_admin; el resto, tenant_admin.
      const adminRole = tenantType === 'consolidator' ? 'consolidator_admin' : 'tenant_admin';

      if (body.adminEmail && body.adminPassword) {
        const existingUser = await trx
          .selectFrom('users')
          .select('id')
          .where('email', '=', body.adminEmail)
          .executeTakeFirst();

        let adminUserId: string;
        if (existingUser) {
          adminUserId = existingUser.id;
        } else {
          const hash = await this.password.hash(body.adminPassword);
          const newUser = await trx
            .insertInto('users')
            .values({
              email: body.adminEmail,
              name: body.adminName ?? null,
              password_hash: hash,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          adminUserId = newUser.id;
        }

        await sql`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`.execute(trx);
        await trx
          .insertInto('memberships')
          .values({
            tenant_id: tenant.id,
            user_id: adminUserId,
            role: adminRole,
            invited_by: userId,
          })
          .execute();
      }

      return tenant;
    });

    await this.audit.emit({
      eventType: 'TenantCreated',
      tenantId: result.id,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: result.id,
      payload: {
        slug: body.slug,
        tenantType: body.tenantType,
        parentTenantId: body.parentTenantId,
      },
    });

    return { tenant: result };
  }

  @Post('users')
  async createUser(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, body.tenantId))) {
      throw new ForbiddenException('target tenant is outside your network');
    }

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

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, body.tenantId))) {
      throw new ForbiddenException('not authorized to manage this tenant');
    }

    const target = await this.db.withRequestContext({ userId, tenantId: body.tenantId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['id', 'role'])
        .where('user_id', '=', body.userId)
        .where('tenant_id', '=', body.tenantId)
        .executeTakeFirst(),
    );
    if (!target) throw new ForbiddenException('membership not found in this tenant');

    this.assertOutranks(target.role, superadmin);

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
   * El actor debe superar estrictamente en rango al rol que toca. Impide auto-promoción
   * y que un `admin` degrade o suspenda a un `tenant_admin` por encima suyo.
   *
   * Se apoya en el rol efectivo del tenant activo del request (lo resuelve
   * RequestContextMiddleware contra la base). Si el actor opera desde un nodo ancestro
   * distinto del tenant destino, ese rol es igualmente el que le da la potestad.
   */
  private assertOutranks(targetRole: Role, isSuperadmin: boolean): void {
    if (isSuperadmin) return;
    const actorRole = currentRole();
    if (!actorRole || !canGrantRole(actorRole, targetRole)) {
      throw new ForbiddenException('no podés modificar a un usuario de rango igual o superior');
    }
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

  private async assertAdmin(userId: string): Promise<void> {
    const row = await this.db.withRequestContext({ userId }, async (trx) => {
      return trx
        .selectFrom('memberships')
        .select('role')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where('role', 'in', [
          'superadmin',
          'platform_admin',
          'consolidator_admin',
          'tenant_admin',
          'agency_admin',
          'admin',
        ])
        .executeTakeFirst();
    });
    if (!row) throw new ForbiddenException('admin access required');
  }

  private async assertSuperadmin(userId: string | undefined): Promise<void> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) {
      throw new ForbiddenException('superadmin access required');
    }
  }
}
