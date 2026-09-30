import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import { MailerService } from '../mail/mailer.service.js';
import { currentContext } from '../request-context/request-context.js';
import {
  CurrentSessionRevokeError,
  MfaAccountLockedError,
  MfaChallengeExpiredError,
  MfaCodeInvalidError,
  SeatReleaseExpiredError,
  SeatReleaseForbiddenError,
  SessionNotFoundError,
} from './auth-errors.js';
import type { RegisterDto, LoginDto } from './dto.js';
import { ACCESS_TTL_MS, JwtService, type SeatReleaseClaims } from './jwt.service.js';
import { LOCKOUT_MINUTES, LoginAttemptsService } from './login-attempts.service.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { requiresMfa } from './roles.js';
import { SeatService, type IssueSessionParams } from './seat.service.js';
import {
  REVOKED_IDLE_TIMEOUT,
  REVOKED_RELEASED_AT_LOGIN,
  REVOKED_TENANT_SWITCHED,
} from './session-revocation.js';
import { SessionService } from './session.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

export interface AuthResult {
  token: string;
  /** ISO del vencimiento absoluto del token, el mismo que el de su sesión. */
  expiresAt: string;
  userId: string;
  tenantId?: string;
  role?: string;
  /**
   * El rol exige MFA pero el usuario todavía no lo enroló. La sesión se emite igual, pero
   * MfaEnforcementGuard sólo le deja enrolarse (o salir) hasta que lo active.
   */
  mfaEnrollmentRequired?: boolean;
  /** Se pidió "recordar este equipo": el token va a la cookie `st_trusted` del panel. */
  trustedDevice?: { token: string; expiresAt: string };
}

/** La contraseña era correcta pero falta el segundo factor. No es una sesión todavía. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

export type LoginResult = AuthResult | MfaChallenge;

/** GET /auth/session: lo que el panel necesita para su cuenta regresiva de inactividad. */
export interface SessionInfo {
  sessionId: string;
  idleTimeoutSeconds: number;
  lastSeenAt: string;
  expiresAt: string;
  serverNow: string;
  /** El rol exige 2FA (MFA_REQUIRED_ROLES en alguna membership activa). */
  mfaRequired: boolean;
  /** El usuario tiene el 2FA activo. */
  mfaEnabled: boolean;
  /** Esta sesión pasó el segundo factor. */
  mfaVerified: boolean;
}

interface ActiveMembership {
  tenant_id: string;
  role: Role;
}

/** Cómo se completó el ingreso, para la auditoría. */
type LoginMethod = 'password' | 'mfa' | 'trusted_device' | 'seat_release';

interface FinishLoginOptions {
  mfaVerified: boolean;
  mfaEnabled: boolean;
  method: LoginMethod;
  remember?: boolean;
  /** Tenant con que emitir la sesión; si ya no hay membership activa allí, el por defecto. */
  tenantId?: string | null;
}

@Injectable()
export class AuthService {
  /** Hash bcrypt dummy (memoizado) para igualar el tiempo de respuesta cuando el usuario no existe. */
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly seats: SeatService,
    private readonly challenges: MfaChallengeService,
    private readonly trustedDevices: TrustedDeviceService,
    private readonly attempts: LoginAttemptsService,
  ) {}

  /**
   * Emite un access token respaldado por una fila en `sessions`, para que el token sea
   * revocable. El `jti` del token es el id de esa sesión; RequestContextMiddleware la
   * valida en cada request.
   *
   * La sesión la crea SeatService: cupo de puestos del nodo y una sesión por usuario, en la misma
   * transacción. Con el cupo lleno lanza el 409 SEATS_FULL y no se emite nada. El token vence
   * junto con su sesión (mismo instante), no 12 h después de firmarlo.
   */
  private async issueToken(
    params: Omit<IssueSessionParams, 'expiresAt'> & { role?: string },
  ): Promise<{ token: string; expiresAt: Date }> {
    const { role, ...seat } = params;
    const session = await this.seats.issue({
      ...seat,
      expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
    });
    const token = await this.jwt.sign(
      {
        sub: params.userId,
        tid: params.tenantId ?? undefined,
        role,
        jti: session.sessionId,
      },
      session.expiresAt,
    );
    return { token, expiresAt: session.expiresAt };
  }

  /** Garantiza un bcrypt.compare aunque no haya usuario: evita oracle de timing por enumeración. */
  private getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.password.hash('timing-guard-not-a-real-credential');
    return this.dummyHashPromise;
  }

  async register(dto: RegisterDto): Promise<AuthResult> {
    // El alta pública crea un tenant RAÍZ, es decir un nodo fuera de la jerarquía de
    // cualquier consolidador y con su autor como tenant_admin. En una plataforma
    // consolidadora eso no es autoservicio legítimo: las agencias entran por invitación
    // de su red (POST /invitations) o las crea un admin bajo un padre que administre
    // (POST /admin/tenants, que ya exige parentTenantId salvo para superadmin).
    //
    // Se desactiva por defecto y queda tras un flag explícito, para no romper entornos
    // de demo que dependan del alta abierta.
    if (process.env['ALLOW_PUBLIC_SIGNUP'] !== 'true') {
      throw new ForbiddenException(
        'el alta pública está deshabilitada: pedí una invitación a tu agencia',
      );
    }

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

      // GUCs para que el INSERT en memberships pase memberships_tenant_isolation.
      // El tenant es obligatorio desde 0029_rls_hardening: memberships_self pasó a ser
      // FOR SELECT, así que este INSERT ya no puede apoyarse en su WITH CHECK.
      await sql`SELECT set_config('app.current_user_id', ${user.id}, true)`.execute(trx);
      await sql`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`.execute(trx);

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

    // Verificación de email (best-effort: no debe bloquear/romper el registro).
    await this.sendVerificationEmail(userId, dto.email, tenantId);

    const { token, expiresAt } = await this.issueToken({
      userId,
      tenantId,
      role: 'tenant_admin',
      mfaVerified: false,
    });
    // tenant_admin exige MFA: la sesión nace sin él y el panel lo manda a enrolarse.
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      userId,
      tenantId,
      role: 'tenant_admin',
      mfaEnrollmentRequired: true,
    };
  }

  /** Envía el correo de verificación. Best-effort: cualquier fallo se traga (no rompe el flujo). */
  private async sendVerificationEmail(
    userId: string,
    email: string,
    tenantId: string | null,
  ): Promise<void> {
    try {
      const token = await this.jwt.signEmailToken(userId);
      const base = process.env['APP_WEB_URL'] ?? 'https://app.planetour.cloud';
      const link = `${base}/verificar?token=${encodeURIComponent(token)}`;
      await this.mailer.sendToTenant(tenantId, {
        to: email,
        subject: 'Verificá tu correo · PlaneTour',
        html: verificationEmailHtml(link),
        text: `Verificá tu correo entrando a este enlace: ${link}`,
      });
    } catch {
      // Best-effort: el envío de verificación nunca debe tumbar la operación principal.
    }
  }

  /** Marca el email del usuario como verificado a partir de un token válido (idempotente). */
  async verifyEmail(token: string): Promise<{ verified: boolean }> {
    let userId: string;
    try {
      userId = await this.jwt.verifyEmailToken(token);
    } catch {
      throw new UnauthorizedException('invalid or expired verification token');
    }
    await this.db.db
      .updateTable('users')
      .set({ email_verified_at: sql<Date>`now()` })
      .where('id', '=', userId)
      .where('email_verified_at', 'is', null)
      .execute();
    await this.audit.emit({
      eventType: 'auth.email_verified',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
    });
    return { verified: true };
  }

  /** Reenvía el correo de verificación al usuario autenticado (si aún no está verificado). */
  async resendVerification(userId: string): Promise<{ sent: boolean; alreadyVerified: boolean }> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['email', 'email_verified_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedException();
    if (user.email_verified_at) return { sent: false, alreadyVerified: true };

    const membership = await this.db.db
      .selectFrom('memberships')
      .select('tenant_id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .orderBy('created_at')
      .executeTakeFirst();

    await this.sendVerificationEmail(userId, user.email, membership?.tenant_id ?? null);
    return { sent: true, alreadyVerified: false };
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['id', 'password_hash', 'status', 'locked_until', 'mfa_enabled_at'])
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

    if (!user || !user.password_hash || user.status !== 'active' || !passwordOk) {
      if (user) {
        await this.attempts.registerFailure(user.id);
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

    // Con MFA activo la contraseña sola NO emite sesión. El contador de fallos NO se limpia
    // acá: si se limpiara, quien tiene la contraseña volvería a cero antes de cada tanda de
    // códigos. Se limpia al emitir la sesión (finishLogin).
    if (user.mfa_enabled_at) {
      // "Recordar este equipo": un equipo de confianza válido de ESTE usuario reemplaza al código.
      if (
        dto.trustedDeviceToken &&
        (await this.trustedDevices.use(user.id, dto.trustedDeviceToken).catch(() => false))
      ) {
        return this.finishLogin(user.id, {
          mfaVerified: true,
          mfaEnabled: true,
          method: 'trusted_device',
        });
      }

      // El desafío tiene estado (intentos, un solo uso) y audiencia propia: no sirve como bearer.
      const challenge = await this.challenges.create(user.id);
      await this.audit.emit({
        eventType: 'auth.mfa.challenged',
        actorUserId: user.id,
        aggregateType: 'user',
        aggregateId: user.id,
      });
      return {
        mfaRequired: true,
        mfaToken: await this.jwt.signMfaChallenge(user.id, challenge.id, challenge.expiresAt),
      };
    }

    return this.finishLogin(user.id, { mfaVerified: false, mfaEnabled: false, method: 'password' });
  }

  /**
   * Canjea el desafío MFA por una sesión real.
   *
   * Cada desafío admite 5 intentos y cada uno cuenta además contra el bloqueo de la cuenta, el mismo
   * de la contraseña. Los dos se reservan juntos ANTES de verificar (ver MfaChallengeService): así
   * ni una ráfaga en paralelo con muchos desafíos prueba más de 5 códigos por ventana de bloqueo.
   * Vencido, consumido o sin intentos: MFA_CHALLENGE_EXPIRED. Cuenta bloqueada (de antes o por este
   * fallo): MFA_ACCOUNT_LOCKED. En ambos casos se vuelve a la contraseña.
   */
  async completeMfa(mfaToken: string, code: string, rememberDevice = false): Promise<AuthResult> {
    let userId: string;
    let challengeId: string;
    try {
      ({ userId, challengeId } = await this.jwt.verifyMfaChallenge(mfaToken));
    } catch {
      throw new MfaChallengeExpiredError();
    }

    const reservation = await this.challenges.reserveAttempt(userId, challengeId);
    if (reservation.kind === 'locked') throw new MfaAccountLockedError(LOCKOUT_MINUTES);
    if (reservation.kind === 'unavailable') throw new MfaChallengeExpiredError();
    const { attempt, attemptsLeft, locksAccount } = reservation;

    if (!(await this.mfa.verifyCode(userId, code))) {
      // El fallo ya quedó contado al reservar el intento.
      await this.audit.emit({
        eventType: 'auth.mfa.failed',
        actorUserId: userId,
        aggregateType: 'user',
        aggregateId: userId,
        payload: { attempt, attemptsLeft, locked: locksAccount },
      });
      if (locksAccount) throw new MfaAccountLockedError(LOCKOUT_MINUTES);
      if (attemptsLeft === 0) throw new MfaChallengeExpiredError();
      throw new MfaCodeInvalidError(attemptsLeft);
    }

    // Un solo uso: si otro request con el mismo desafío ya lo canjeó, éste no emite otra sesión.
    if (!(await this.challenges.consume(userId, challengeId, rememberDevice))) {
      throw new MfaChallengeExpiredError();
    }

    // Pasó los dos factores: el intento reservado no era un fallo. Se limpia ya y no recién al
    // emitir la sesión, porque con el cupo lleno (409) la sesión no se emite y el código correcto
    // quedaría contando: cinco intentos contra un cupo lleno bloqueaban la cuenta.
    await this.attempts.clearFailures(userId);

    return this.finishLogin(userId, {
      mfaVerified: true,
      mfaEnabled: true,
      method: 'mfa',
      remember: rememberDevice,
    });
  }

  /**
   * Libera un puesto y completa el ingreso que quedó afuera por cupo lleno.
   *
   * El permiso lo emitió el 409 SEATS_FULL a quien administra el nodo del cupo, después de la
   * contraseña (y el MFA): es de un solo uso, vence a los 5 min, y se vuelve a comprobar que el
   * usuario siga activo y siga administrando el nodo. La sesión a liberar tiene que ocupar ESE
   * cupo: revoke_session puede revocar cualquier sesión, así que el id no se toma a ciegas. Si ya
   * no ocupa el cupo (se desconectó sola), se intenta entrar igual.
   */
  async releaseSeat(releaseToken: string, sessionId: string): Promise<AuthResult> {
    let claims: SeatReleaseClaims;
    try {
      claims = await this.jwt.verifySeatRelease(releaseToken);
    } catch {
      throw new SeatReleaseExpiredError();
    }
    if (!(await this.seats.consumeReleaseToken(claims.jti, claims.expiresAt))) {
      throw new SeatReleaseExpiredError();
    }

    const user = await this.db.db
      .selectFrom('users')
      .select(['status', 'password_changed_at', 'mfa_enabled_at'])
      .where('id', '=', claims.userId)
      .executeTakeFirst();
    if (
      !user ||
      user.status !== 'active' ||
      (user.password_changed_at !== null &&
        claims.issuedAt.getTime() < Math.floor(user.password_changed_at.getTime() / 1000) * 1000)
    ) {
      throw new SeatReleaseExpiredError();
    }
    if (!(await this.seats.canRelease(claims.userId, claims.poolTenantId))) {
      throw new SeatReleaseForbiddenError();
    }

    const holder = (await this.seats.poolSessions(claims.poolTenantId)).find(
      (s) => s.sessionId === sessionId && s.userId !== claims.userId,
    );
    if (holder && (await this.seats.releaseSession(sessionId, REVOKED_RELEASED_AT_LOGIN))) {
      await this.audit.emit({
        eventType: 'auth.seat.released_at_login',
        tenantId: claims.poolTenantId,
        actorUserId: claims.userId,
        aggregateType: 'session',
        aggregateId: sessionId,
        payload: {
          releasedUserId: holder.userId,
          releasedTenantId: holder.tenantId,
          poolTenantId: claims.poolTenantId,
        },
      });
    }

    return this.finishLogin(claims.userId, {
      mfaVerified: claims.mfa,
      mfaEnabled: user.mfa_enabled_at !== null,
      method: 'seat_release',
      remember: claims.remember,
      tenantId: claims.tenantId,
    });
  }

  /**
   * Resuelve el tenant por defecto y emite la sesión. Compartido por login, completeMfa y
   * releaseSeat. Con la sesión emitida se limpia el contador de fallos (el paso MFA ya lo limpió al
   * aceptar el código) y se registra el acceso.
   */
  private async finishLogin(userId: string, opts: FinishLoginOptions): Promise<AuthResult> {
    const memberships = await this.activeMemberships(userId);
    const membership =
      (opts.tenantId ? memberships.find((m) => m.tenant_id === opts.tenantId) : undefined) ??
      memberships[0];
    // Un equipo de confianza sólo tiene sentido si esta sesión pasó el segundo factor.
    const remember = opts.remember === true && opts.mfaVerified;

    const { token, expiresAt } = await this.issueToken({
      userId,
      tenantId: membership?.tenant_id ?? null,
      role: membership?.role,
      mfaVerified: opts.mfaVerified,
      remember,
    });
    await this.attempts.registerSuccess(userId);

    let trustedDevice: AuthResult['trustedDevice'];
    if (remember) {
      const ctx = currentContext();
      try {
        const created = await this.trustedDevices.create(userId, {
          ...(ctx?.ip ? { ip: ctx.ip } : {}),
          ...(ctx?.userAgent ? { userAgent: ctx.userAgent } : {}),
        });
        trustedDevice = { token: created.token, expiresAt: created.expiresAt.toISOString() };
      } catch {
        // Sin equipo de confianza el ingreso sigue valiendo: la próxima vez pedirá el código.
      }
    }

    await this.audit.emit({
      eventType: 'auth.login.success',
      tenantId: membership?.tenant_id ?? null,
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
      payload: {
        mfa: opts.mfaVerified,
        method: opts.method,
        rememberedDevice: trustedDevice !== undefined,
      },
    });

    // El MFA sigue a la persona, no al tenant por defecto: basta un rol que lo exija en cualquier
    // nodo (el superadmin que además es miembro de otro nodo creado antes, por ejemplo).
    const enrollmentRequired = !opts.mfaEnabled && memberships.some((m) => requiresMfa(m.role));

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      userId,
      tenantId: membership?.tenant_id,
      role: membership?.role,
      ...(enrollmentRequired ? { mfaEnrollmentRequired: true } : {}),
      ...(trustedDevice ? { trustedDevice } : {}),
    };
  }

  /**
   * Con el GUC del usuario: la API corre como app_user y `memberships` tiene RLS. Sin él la policy
   * memberships_self no deja ver ninguna fila, el token salía sin tenant y el login nunca pedía
   * enrolar MFA, ni al superadmin.
   */
  private activeMemberships(userId: string): Promise<ActiveMembership[]> {
    return this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select(['tenant_id', 'role'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at')
        .execute(),
    );
  }

  /**
   * Cambia el tenant activo del usuario: valida que tenga una membership ACTIVA en el
   * tenant destino y emite un token nuevo con ese `tid` (firmado, no falsificable).
   * Base para que el tenant venga del JWT en vez del header `x-tenant-id`.
   *
   * La sesión nueva hereda el segundo factor de la actual (ya lo pasó) y la reemplaza. Si el
   * destino consume de otro cupo y está lleno, 409 SEATS_FULL y la sesión actual sigue.
   */
  async switchTenant(
    userId: string,
    targetTenantId: string,
    currentSessionId?: string,
  ): Promise<AuthResult> {
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

    const current = currentSessionId
      ? await this.sessions.snapshot(currentSessionId, userId)
      : null;

    // Sesión nueva por tenant: así el listado de dispositivos muestra bajo qué nodo se
    // está operando.
    const { token, expiresAt } = await this.issueToken({
      userId,
      tenantId: membership.tenant_id,
      role: membership.role,
      mfaVerified: current?.mfaVerified === true,
      ...(currentSessionId
        ? { current: { sessionId: currentSessionId, reason: REVOKED_TENANT_SWITCHED } }
        : {}),
    });
    await this.audit.emit({
      eventType: 'auth.switch_tenant',
      tenantId: membership.tenant_id,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: membership.tenant_id,
    });
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      userId,
      tenantId: membership.tenant_id,
      role: membership.role,
    };
  }

  /**
   * Después de un cambio de contraseña (que revoca TODAS las sesiones): sesión nueva para el
   * dispositivo actual, con su tenant y su segundo factor. Antes el cambio también mataba la
   * sesión actual aunque la pantalla prometía lo contrario. No se le niega por cupo: renueva el
   * puesto que ya ocupaba.
   */
  async reissueAfterPasswordChange(
    userId: string,
    sessionId: string | undefined,
  ): Promise<{ token: string; expiresAt: string }> {
    const snapshot = sessionId ? await this.sessions.snapshot(sessionId, userId) : null;
    const memberships = await this.activeMemberships(userId);
    const membership =
      memberships.find((m) => m.tenant_id === snapshot?.tenantId) ?? memberships[0];
    const { token, expiresAt } = await this.issueToken({
      userId,
      tenantId: snapshot?.tenantId ?? membership?.tenant_id ?? null,
      role: membership?.role,
      mfaVerified: snapshot?.mfaVerified === true,
      replaceReason: 'password_changed',
      enforceSeatLimit: false,
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Cierra la sesión actual revocándola en la base. `idle`: la cerró la cuenta regresiva de
   * inactividad del panel, y así queda registrado (el usuario verá "por inactividad").
   */
  async logout(userId: string, sessionId: string, reason?: 'idle'): Promise<{ ok: true }> {
    const idle = reason === 'idle';
    await this.sessions.revoke(sessionId, userId, idle ? REVOKED_IDLE_TIMEOUT : 'logout');
    await this.audit.emit({
      eventType: idle ? 'auth.session.idle_timeout' : 'auth.logout',
      actorUserId: userId,
      aggregateType: 'session',
      aggregateId: sessionId,
      ...(idle ? { payload: { source: 'client' } } : {}),
    });
    return { ok: true };
  }

  /** "Cerrar sesión en todos los dispositivos". */
  async logoutAll(userId: string): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeAllForUser(userId, 'logout_all');
    await this.audit.emit({
      eventType: 'auth.logout_all',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { revoked },
    });
    return { revoked };
  }

  /** Cierra UNA sesión propia desde el listado de dispositivos. La actual, no: para eso está logout. */
  async revokeOwnSession(
    userId: string,
    currentSessionId: string | undefined,
    targetSessionId: string,
  ): Promise<{ ok: true }> {
    if (targetSessionId === currentSessionId) throw new CurrentSessionRevokeError();
    if (!(await this.sessions.revoke(targetSessionId, userId, 'revoked_by_user'))) {
      throw new SessionNotFoundError();
    }
    await this.audit.emit({
      eventType: 'auth.session.revoked',
      actorUserId: userId,
      aggregateType: 'session',
      aggregateId: targetSessionId,
    });
    return { ok: true };
  }

  /** Los tiempos de la sesión actual, ya validados por RequestContextMiddleware. */
  sessionInfo(): SessionInfo {
    const ctx = currentContext();
    if (!ctx?.sessionId || !ctx.session) throw new UnauthorizedException();
    return {
      sessionId: ctx.sessionId,
      idleTimeoutSeconds: ctx.session.idleTimeoutSeconds,
      lastSeenAt: ctx.session.lastSeenAt.toISOString(),
      expiresAt: ctx.session.expiresAt.toISOString(),
      serverNow: new Date().toISOString(),
      // Lo mismo que mira MfaEnforcementGuard, ya resuelto por SessionService.validate: con esto la
      // guardia del panel se entera en el ping de que el rol pasó a exigir 2FA en plena sesión.
      mfaRequired: ctx.mfaRequired === true,
      mfaEnabled: ctx.mfaEnabled === true,
      mfaVerified: ctx.mfaVerified === true,
    };
  }

  async listSessions(userId: string, currentSessionId?: string) {
    return this.sessions.listActive(userId, currentSessionId);
  }

  /** Email del usuario, para etiquetar la entrada en el authenticator. */
  async emailOf(userId: string): Promise<string> {
    const user = await this.db.db
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedException();
    return user.email;
  }
}

/** HTML simple y sobrio del correo de verificación (sin imágenes externas). */
function verificationEmailHtml(link: string): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px">
        <tr><td>
          <h1 style="margin:0 0 8px;font-size:18px;color:#18181b">Verificá tu correo</h1>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#52525b">
            Confirmá tu dirección de correo para activar tu cuenta en PlaneTour.
          </p>
          <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px">
            Verificar correo
          </a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#a1a1aa">
            Si el botón no funciona, copiá y pegá este enlace en tu navegador:<br>
            <span style="color:#4f46e5;word-break:break-all">${link}</span>
          </p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#a1a1aa">PlaneTour · planetour.cloud</p>
    </td></tr>
  </table>
</body></html>`;
}
