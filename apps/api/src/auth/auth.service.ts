import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { RegisterDto, LoginDto } from './dto.js';
import { JwtService } from './jwt.service.js';
import { PasswordService } from './password.service.js';

export interface AuthResult {
  token: string;
  userId: string;
  tenantId?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly password: PasswordService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existingUser = await this.db.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', dto.email)
      .executeTakeFirst();
    if (existingUser) {
      throw new ConflictException('email already in use');
    }

    const existingTenant = await this.db.db
      .selectFrom('tenants')
      .select('id')
      .where('slug', '=', dto.tenant.slug)
      .executeTakeFirst();
    if (existingTenant) {
      throw new ConflictException('tenant slug already in use');
    }

    const passwordHash = await this.password.hash(dto.password);

    const { userId, tenantId } = await this.db.db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({
          email: dto.email,
          password_hash: passwordHash,
          name: dto.name,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const tenant = await trx
        .insertInto('tenants')
        .values({
          slug: dto.tenant.slug,
          name: dto.tenant.name,
          country_code: dto.tenant.countryCode,
          default_currency: dto.tenant.defaultCurrency,
          default_language: dto.tenant.defaultLanguage,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Set GUC para que la INSERT en memberships pase la policy WITH CHECK.
      await sql`SELECT set_config('app.current_user_id', ${user.id}, true)`.execute(trx);

      await trx
        .insertInto('memberships')
        .values({
          tenant_id: tenant.id,
          user_id: user.id,
          role: 'tenant_admin',
        })
        .execute();

      return { userId: user.id, tenantId: tenant.id };
    });

    const token = await this.jwt.sign({ sub: userId });
    return { token, userId, tenantId };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['id', 'password_hash', 'status'])
      .where('email', '=', dto.email)
      .executeTakeFirst();

    if (!user || !user.password_hash || user.status !== 'active') {
      throw new UnauthorizedException('invalid credentials');
    }

    const ok = await this.password.verify(dto.password, user.password_hash);
    if (!ok) {
      throw new UnauthorizedException('invalid credentials');
    }

    const token = await this.jwt.sign({ sub: user.id });
    return { token, userId: user.id };
  }
}
