import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { PasswordService } from '../auth/password.service.js';
import { DatabaseService } from '../database/database.service.js';

interface CreateTenantBody {
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  defaultLanguage?: 'es' | 'pt' | 'en';
  adminEmail?: string;
  adminName?: string;
  adminPassword?: string;
}

interface CreateUserBody {
  email: string;
  name: string;
  password: string;
  tenantId: string;
  role: 'tenant_admin' | 'admin' | 'vendedor' | 'cliente_final';
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
  ) {}

  @Get('tenants')
  async listTenants(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

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
        ? await this.db.db
            .selectFrom('memberships')
            .select(['tenant_id'])
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('tenant_id', 'in', tenantIds)
            .groupBy('tenant_id')
            .execute()
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
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

    const rows = await this.db.db
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
  async createTenant(@CurrentUser() userId: string | undefined, @Body() body: CreateTenantBody) {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

    const existing = await this.db.db
      .selectFrom('tenants')
      .select('id')
      .where('slug', '=', body.slug)
      .executeTakeFirst();
    if (existing) throw new ConflictException('slug already in use');

    const result = await this.db.db.transaction().execute(async (trx) => {
      const tenant = await trx
        .insertInto('tenants')
        .values({
          slug: body.slug,
          name: body.name,
          country_code: body.countryCode,
          default_currency: body.defaultCurrency,
          default_language: body.defaultLanguage ?? 'es',
        })
        .returning(['id', 'slug', 'name'])
        .executeTakeFirstOrThrow();

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
            role: 'tenant_admin',
            invited_by: userId,
          })
          .execute();
      }

      return tenant;
    });

    return { tenant: result };
  }

  @Post('users')
  async createUser(@CurrentUser() userId: string | undefined, @Body() body: CreateUserBody) {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

    const existingUser = await this.db.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', body.email)
      .executeTakeFirst();
    if (existingUser) {
      const existingMembership = await this.db.db
        .selectFrom('memberships')
        .select('id')
        .where('user_id', '=', existingUser.id)
        .where('tenant_id', '=', body.tenantId)
        .executeTakeFirst();
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

    return { user: result };
  }

  private async assertAdmin(userId: string): Promise<void> {
    const row = await this.db.db
      .selectFrom('memberships')
      .select('role')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('role', 'in', ['superadmin', 'tenant_admin', 'admin'])
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('admin access required');
  }
}
