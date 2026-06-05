import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { RegisterDto, LoginDto } from './dto.js';
import { JwtService } from './jwt.service.js';
import { PasswordService } from './password.service.js';

export interface AuthResult {
  token: string;
  userId: string;
  tenantId?: string;
  role?: string;
}

/** Tras este número de fallos consecutivos la cuenta se bloquea temporalmente. */
const LOCKOUT_THRESHOLD = 5;
/** Minutos de bloqueo al alcanzar el umbral. */
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  /** Hash bcrypt dummy (memoizado) para igualar el tiempo de respuesta cuando el usuario no existe. */
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /** Garantiza un bcrypt.compare aunque no haya usuario: evita oracle de timing por enumeración. */
  private getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.password.hash('timing-guard-not-a-real-credential');
    return this.dummyHashPromise;
  }

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

    await this.audit.emit({
      eventType: 'auth.register',
      tenantId,
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
    });

    const token = await this.jwt.sign({ sub: userId, tid: tenantId, role: 'tenant_admin' });
    return { token, userId, tenantId, role: 'tenant_admin' };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['id', 'password_hash', 'status', 'failed_login_attempts', 'locked_until'])
      .where('email', '=', dto.email)
      .executeTakeFirst();

    // Lockout: si la cuenta está bloqueada, ni siquiera verificamos el password.
    if (user?.locked_until && user.locked_until.getTime() > Date.now()) {
      await this.audit.emit({
        eventType: 'auth.login.blocked',
        actorUserId: user.id,
        aggregateType: 'user',
        aggregateId: user.id,
      });
      throw new UnauthorizedException('invalid credentials');
    }

    // Timing-guard: siempre corremos un bcrypt.compare (contra hash real o dummy) para
    // que la respuesta tarde lo mismo exista o no el usuario (anti-enumeración).
    const hashToCheck = user?.password_hash ?? (await this.getDummyHash());
    const passwordOk = await this.password.verify(dto.password, hashToCheck);
    const valid = Boolean(user && user.password_hash && user.status === 'active' && passwordOk);

    if (!valid) {
      if (user) {
        await this.registerFailedAttempt(user.id, user.failed_login_attempts);
        await this.audit.emit({
          eventType: 'auth.login.failed',
          actorUserId: user.id,
          aggregateType: 'user',
          aggregateId: user.id,
          payload: { reason: user.status !== 'active' ? 'inactive' : 'bad_password' },
        });
      } else {
        await this.audit.emit({
          eventType: 'auth.login.failed',
          payload: { reason: 'unknown_user' },
        });
      }
      throw new UnauthorizedException('invalid credentials');
    }

    // Éxito: limpiamos contadores y registramos el último login.
    await this.onLoginSuccess(user!.id);

    const membership = await this.db.db
      .selectFrom('memberships')
      .select(['tenant_id', 'role'])
      .where('user_id', '=', user!.id)
      .where('status', '=', 'active')
      .orderBy('created_at')
      .executeTakeFirst();

    const token = await this.jwt.sign({
      sub: user!.id,
      tid: membership?.tenant_id,
      role: membership?.role,
    });
    await this.audit.emit({
      eventType: 'auth.login.success',
      tenantId: membership?.tenant_id ?? null,
      actorUserId: user!.id,
      aggregateType: 'user',
      aggregateId: user!.id,
    });
    return {
      token,
      userId: user!.id,
      tenantId: membership?.tenant_id,
      role: membership?.role,
    };
  }

  /**
   * Incrementa el contador de fallos. Al alcanzar el umbral bloquea la cuenta por
   * LOCKOUT_MINUTES y resetea el contador (tras expirar el bloqueo, vuelve a tener
   * LOCKOUT_THRESHOLD intentos). `users` no tiene RLS (cross-tenant), seguro por id.
   */
  private async registerFailedAttempt(userId: string, current: number): Promise<void> {
    const willLock = current + 1 >= LOCKOUT_THRESHOLD;
    await this.db.db
      .updateTable('users')
      .set({
        failed_login_attempts: willLock ? 0 : current + 1,
        locked_until: willLock
          ? sql<Date>`now() + make_interval(mins => ${LOCKOUT_MINUTES})`
          : null,
      })
      .where('id', '=', userId)
      .execute();
  }

  private async onLoginSuccess(userId: string): Promise<void> {
    await this.db.db
      .updateTable('users')
      .set({ failed_login_attempts: 0, locked_until: null, last_login_at: sql<Date>`now()` })
      .where('id', '=', userId)
      .execute();
  }

  /**
   * Cambia el tenant activo del usuario: valida que tenga una membership ACTIVA en el
   * tenant destino y emite un token nuevo con ese `tid` (firmado, no falsificable).
   * Base para que el tenant venga del JWT en vez del header `x-tenant-id`.
   */
  async switchTenant(userId: string, targetTenantId: string): Promise<AuthResult> {
    const membership = await this.db.withRequestContext({ userId }, async (trx) =>
      trx
        .selectFrom('memberships')
        .select(['tenant_id', 'role'])
        .where('user_id', '=', userId)
        .where('tenant_id', '=', targetTenantId)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );

    if (!membership) {
      throw new ForbiddenException('no active membership in target tenant');
    }

    const token = await this.jwt.sign({
      sub: userId,
      tid: membership.tenant_id,
      role: membership.role,
    });
    await this.audit.emit({
      eventType: 'auth.switch_tenant',
      tenantId: membership.tenant_id,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: membership.tenant_id,
    });
    return { token, userId, tenantId: membership.tenant_id, role: membership.role };
  }
}
