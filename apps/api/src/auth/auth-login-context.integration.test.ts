import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { NetworkService } from '../network/network.service.js';
import { AuthService, type AuthResult, type LoginResult } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import type { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { PgSeatRepository } from './seat.repository.js';
import { SeatService } from './seat.service.js';
import { SessionService } from './session.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

/**
 * El login resuelve el tenant por defecto y si hay que enrolar MFA leyendo `memberships`, que tiene
 * RLS. La API corre como `app_user`: sin el GUC del usuario, la policy memberships_self no dejaba ver
 * ninguna fila, el token salía sin tenant y el login nunca pedía enrolar MFA, ni al superadmin
 * (docs/platform/13 §5, paso 3). Los tests de CI corren como `postgres`, que se salta la RLS, y por
 * eso no se veía: aquí TODA consulta de la API sale como `app_user`. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const PASSWORD = 'contraseña-de-prueba-login';

d('AuthService.login como app_user: tenant por defecto y MFA', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();
  // Cada conexión de la API asume `app_user` antes de la primera consulta, como en producción.
  const comoApp = new pg.Pool();
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });

  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const password = new PasswordService();
  const jwt = new JwtService();
  const audit = new AuditService(database);
  const auth = new AuthService(
    database,
    jwt,
    password,
    audit,
    {} as MailerService,
    new SessionService(database, audit),
    {} as MfaService,
    new SeatService(new PgSeatRepository(database), audit, new NetworkService(database), jwt),
    new MfaChallengeService(database, new LoginAttemptsService(database)),
    new TrustedDeviceService(database),
    new LoginAttemptsService(database),
  );

  let platform: string;
  let branch: string;
  let passwordHash: string;

  async function user(label: string): Promise<{ id: string; email: string }> {
    const email = `alc-${label}-${sfx}@test.local`;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
      [email, passwordHash],
    );
    return { id: rows[0]!.id, email };
  }

  /** `created_at` explícito: el tenant por defecto es la membership más antigua. */
  async function member(tenantId: string, userId: string, role: string, minutesAgo: number) {
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'active', now() - make_interval(mins => $4))`,
      [tenantId, userId, role, minutesAgo],
    );
  }

  function session(result: LoginResult): AuthResult {
    expect('token' in result).toBe(true);
    return result as AuthResult;
  }

  async function sessionTenant(token: string): Promise<string | null> {
    const { jti } = await jwt.verify(token);
    const { rows } = await admin.query<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM sessions WHERE id = $1`,
      [jti],
    );
    return rows[0]?.tenant_id ?? null;
  }

  beforeAll(async () => {
    process.env['JWT_SECRET'] ??= randomBytes(32).toString('hex');
    jwt.onModuleInit();
    passwordHash = await password.hash(PASSWORD);
    platform = await platformRootId(admin);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, is_branch,
                            parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', true, $2) RETURNING id`,
      [`alc-sucursal-${sfx}`, platform],
    );
    branch = rows[0]!.id;
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [branch]);
    await database.db.destroy();
    await admin.end();
  });

  it('el superadmin sin MFA entra en la plataforma y el login pide enrolarlo', async () => {
    const root = await user('root');
    await member(platform, root.id, 'superadmin', 10);

    const result = session(await auth.login({ email: root.email, password: PASSWORD }));

    expect(result).toMatchObject({
      tenantId: platform,
      role: 'superadmin',
      mfaEnrollmentRequired: true,
    });
    expect(await sessionTenant(result.token)).toBe(platform);
    // El token vence con su sesión: el panel alinea la cookie con este instante.
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('un vendedor entra en su sucursal, sin enrolamiento', async () => {
    const seller = await user('seller');
    await member(branch, seller.id, 'vendedor', 10);

    const result = session(await auth.login({ email: seller.email, password: PASSWORD }));

    expect(result).toMatchObject({ tenantId: branch, role: 'vendedor' });
    expect(result.mfaEnrollmentRequired).toBeUndefined();
    expect(await sessionTenant(result.token)).toBe(branch);
  });

  it('el MFA sigue a la persona: basta un rol que lo exija en otro nodo', async () => {
    const both = await user('both');
    await member(branch, both.id, 'vendedor', 20);
    await member(platform, both.id, 'tenant_admin', 10);

    const result = session(await auth.login({ email: both.email, password: PASSWORD }));

    // El tenant por defecto es la membership más antigua; el MFA, el de cualquiera de ellas.
    expect(result).toMatchObject({
      tenantId: branch,
      role: 'vendedor',
      mfaEnrollmentRequired: true,
    });
  });
});
