import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { MeController } from '../me/me.controller.js';
import { NetworkService } from '../network/network.service.js';
import { SeatsFullError, TenantNotOperableError } from './auth-errors.js';
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
 * Cambiar de agencia y la agencia por defecto del login, contra Postgres y con TODA consulta de la
 * API como `app_user` (NOBYPASSRLS): `memberships` y `sessions` tienen RLS por usuario.
 *
 * Lo que se prueba acá y no con dobles: la columna de 0061, el SQL de "el nodo y sus ancestros
 * están activos", el de GET /me/memberships (logo heredado, bloqueante, `isDefault`) y que el login
 * y el panel queden de acuerdo. Se SALTA sin PGHOST.
 *
 * Red, colgada de la plataforma:
 *   Consolidador (logo propio, sin cupo)
 *     ├── Agencia Alfa        (hereda el logo)
 *     ├── Agencia Beta
 *     └── Agencia Suspendida  (status suspended)
 *   Consolidador Cerrado (suspended)
 *     └── Agencia Colgada     (activa, pero bajo un nodo suspendido)
 *   Consolidador Libre (sin cupo)
 *     └── Agencia Libre
 *   Consolidador Lleno (1 puesto)
 *     ├── Agencia Ocupada
 *     └── Agencia Destino
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const PASSWORD = 'contraseña-de-prueba-cambio-agencia';
const CONS_LOGO = 'https://cdn.test/consolidador.png';

d('cambiar de agencia y agencia por defecto, contra Postgres como app_user', () => {
  const sfx = randomBytes(4).toString('hex');
  const admin = new pg.Pool();
  const comoApp = new pg.Pool({ max: 8 });
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });

  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const password = new PasswordService();
  const jwt = new JwtService();
  const audit = new AuditService(database);
  const sessions = new SessionService(database, audit);
  const auth = new AuthService(
    database,
    jwt,
    password,
    audit,
    {} as MailerService,
    sessions,
    {} as MfaService,
    new SeatService(new PgSeatRepository(database), audit, new NetworkService(database), jwt),
    new MfaChallengeService(database),
    new TrustedDeviceService(database),
    new LoginAttemptsService(database),
  );
  const me = new MeController(database);

  const created: string[] = [];
  let passwordHash: string;
  let cons: string;
  let alfa: string;
  let beta: string;
  let suspended: string;
  let closedCons: string;
  let hanging: string;
  let freeAgency: string;
  let taken: string;
  let target: string;

  async function tenant(
    label: string,
    type: 'consolidator' | 'agency',
    parent: string,
    opts: { status?: 'active' | 'suspended'; seats?: number; logo?: string } = {},
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type,
                            parent_tenant_id, status, concurrent_seats, logo_url)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4, $5, $6, $7) RETURNING id`,
      [
        `ts-${label.toLowerCase().replace(/\s+/g, '-')}-${sfx}`,
        `${label} ${sfx}`,
        type,
        parent,
        opts.status ?? 'active',
        opts.seats ?? null,
        opts.logo ?? null,
      ],
    );
    created.unshift(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string): Promise<{ id: string; email: string }> {
    const email = `ts-${label}-${sfx}@test.local`;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
      [email, `Persona ${label}`, passwordHash],
    );
    return { id: rows[0]!.id, email };
  }

  /** `created_at` explícito: sin agencia recordada, gana la membership más antigua que opera. */
  async function member(tenantId: string, userId: string, role: string, minutesAgo: number) {
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'active', now() - make_interval(mins => $4))`,
      [tenantId, userId, role, minutesAgo],
    );
  }

  async function login(email: string): Promise<AuthResult> {
    const result: LoginResult = await auth.login({ email, password: PASSWORD });
    expect('token' in result).toBe(true);
    return result as AuthResult;
  }

  async function lastTenant(userId: string): Promise<string | null> {
    const { rows } = await admin.query<{ last_tenant_id: string | null }>(
      'SELECT last_tenant_id FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.last_tenant_id ?? null;
  }

  async function sessionOf(token: string) {
    const { jti } = await jwt.verify(token);
    const { rows } = await admin.query<{
      id: string;
      tenant_id: string | null;
      revoked_reason: string | null;
    }>('SELECT id, tenant_id, revoked_reason FROM sessions WHERE id = $1', [jti]);
    return rows[0]!;
  }

  async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('se esperaba un rechazo');
  }

  beforeAll(async () => {
    process.env['JWT_SECRET'] ??= randomBytes(32).toString('hex');
    jwt.onModuleInit();
    passwordHash = await password.hash(PASSWORD);
    const platform = await platformRootId(admin);
    cons = await tenant('Consolidador', 'consolidator', platform, { logo: CONS_LOGO });
    alfa = await tenant('Agencia Alfa', 'agency', cons);
    beta = await tenant('Agencia Beta', 'agency', cons);
    suspended = await tenant('Agencia Suspendida', 'agency', cons, { status: 'suspended' });
    closedCons = await tenant('Consolidador Cerrado', 'consolidator', platform, {
      status: 'suspended',
    });
    hanging = await tenant('Agencia Colgada', 'agency', closedCons);
    const freeCons = await tenant('Consolidador Libre', 'consolidator', platform);
    freeAgency = await tenant('Agencia Libre', 'agency', freeCons);
    const fullCons = await tenant('Consolidador Lleno', 'consolidator', platform, { seats: 1 });
    taken = await tenant('Agencia Ocupada', 'agency', fullCons);
    target = await tenant('Agencia Destino', 'agency', fullCons);
  });

  afterAll(async () => {
    // Primero los usuarios: se llevan sus sesiones y memberships.
    await admin.query('DELETE FROM users WHERE email LIKE $1', [`ts-%-${sfx}@test.local`]);
    for (const id of created) await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
    await database.db.destroy();
    await admin.end();
  });

  it('login, cambio y próximo login: la última agencia elegida pasa a ser la por defecto', async () => {
    const u = await user('viajero');
    await member(suspended, u.id, 'vendedor', 50); // la más antigua, pero no opera
    await member(freeAgency, u.id, 'vendedor', 40);
    await member(hanging, u.id, 'vendedor', 30);
    await member(beta, u.id, 'admin', 20);

    // Sin agencia recordada: la más antigua que opera, no la suspendida.
    const first = await login(u.email);
    expect(first.tenantId).toBe(freeAgency);
    expect(await lastTenant(u.id)).toBe(freeAgency);

    const { id: firstSession } = await sessionOf(first.token);
    const switched = await auth.switchTenant(u.id, beta, firstSession);
    expect(switched).toMatchObject({ tenantId: beta, role: 'admin' });
    expect((await sessionOf(switched.token)).tenant_id).toBe(beta);
    expect((await sessionOf(first.token)).revoked_reason).toBe('tenant_switched');
    expect(await lastTenant(u.id)).toBe(beta);

    // El panel y el login están de acuerdo en cuál es la por defecto.
    const views = await me.memberships(u.id);
    expect(views.filter((v) => v.isDefault).map((v) => v.tenantId)).toEqual([beta]);

    const next = await login(u.email);
    expect(next.tenantId).toBe(beta);
  });

  it('no deja cambiar a una agencia suspendida ni a una colgada de un nodo suspendido', async () => {
    const u = await user('bloqueado');
    await member(freeAgency, u.id, 'vendedor', 30);
    await member(suspended, u.id, 'vendedor', 20);
    await member(hanging, u.id, 'vendedor', 10);
    const current = await login(u.email);
    const { id: currentSession } = await sessionOf(current.token);

    for (const target of [suspended, hanging]) {
      const err = await rejection(auth.switchTenant(u.id, target, currentSession));
      expect(err).toBeInstanceOf(TenantNotOperableError);
    }
    // La sesión actual sigue viva y la agencia recordada no cambió.
    expect((await sessionOf(current.token)).revoked_reason).toBeNull();
    expect(await lastTenant(u.id)).toBe(freeAgency);
  });

  it('GET /me/memberships: alfabético, logo heredado y motivo de cada bloqueo', async () => {
    const u = await user('selector');
    await member(alfa, u.id, 'vendedor', 40);
    await member(suspended, u.id, 'vendedor', 30);
    await member(hanging, u.id, 'admin', 20);

    const views = await me.memberships(u.id);
    expect(views.map((v) => v.tenantId)).toEqual([alfa, hanging, suspended]);

    const byId = new Map(views.map((v) => [v.tenantId, v]));
    expect(byId.get(alfa)).toMatchObject({
      operable: true,
      unavailableReason: null,
      logoUrl: CONS_LOGO,
      tenantType: 'agency',
      isDefault: true,
    });
    expect(byId.get(suspended)).toMatchObject({
      operable: false,
      unavailableReason: 'tenant_suspended',
      blockedByName: null,
      isDefault: false,
    });
    expect(byId.get(hanging)).toMatchObject({
      operable: false,
      unavailableReason: 'ancestor_suspended',
      blockedByName: `Consolidador Cerrado ${sfx}`,
      isDefault: false,
    });
  });

  it('si la última agencia queda suspendida, el login vuelve a la más antigua que opera', async () => {
    const own = await tenant('Agencia Efimera', 'agency', cons);
    const u = await user('efimero');
    await member(freeAgency, u.id, 'vendedor', 30);
    await member(own, u.id, 'vendedor', 20);
    await admin.query('UPDATE users SET last_tenant_id = $2 WHERE id = $1', [u.id, own]);

    expect((await login(u.email)).tenantId).toBe(own);

    await admin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [own]);
    expect((await login(u.email)).tenantId).toBe(freeAgency);
  });

  it('con el cupo del destino lleno: 409 SEATS_FULL y la sesión actual sigue', async () => {
    // El consolidador lleno tiene 1 puesto: alguien de la agencia ocupada lo usa.
    const holder = await user('ocupa');
    await member(taken, holder.id, 'vendedor', 10);
    await login(holder.email);

    const u = await user('rebotado');
    await member(freeAgency, u.id, 'vendedor', 20);
    await member(target, u.id, 'vendedor', 10);
    const current = await login(u.email);
    expect(current.tenantId).toBe(freeAgency);
    const { id: currentSession } = await sessionOf(current.token);

    const err = await rejection(auth.switchTenant(u.id, target, currentSession));
    expect(err).toBeInstanceOf(SeatsFullError);
    expect((await sessionOf(current.token)).revoked_reason).toBeNull();
    expect(await lastTenant(u.id)).toBe(freeAgency);
  });
});
