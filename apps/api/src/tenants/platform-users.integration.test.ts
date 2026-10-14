import { randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import { AdminController } from './admin.controller.js';
import { ListPlatformUsersQuerySchema, type ListPlatformUsersQuery } from './dto.js';
import { InvitationsService } from './invitations.service.js';
import { PlatformUsersService, type PlatformUser } from './platform-users.service.js';
import type { SeatsService } from './seats.service.js';
import type { TenantsService } from './tenants.service.js';

/**
 * El directorio de usuarios de la plataforma y la suspensión de una cuenta, contra Postgres:
 *
 *   - el superadmin ve a las personas de todas las redes, una fila por persona con todos sus nodos,
 *     también a quien no tiene ninguno; un admin de red recibe 403;
 *   - los filtros (búsqueda escapada, estado, rol y nodo con su subárbol, 2FA, bloqueo, nunca
 *     ingresaron) y el cursor, que no salta filas creadas en el mismo milisegundo;
 *   - las sesiones vivas y el último acceso salen de `platform_user_session_stats` (0063), que sólo
 *     ejecuta `app_user`;
 *   - 404 a una cuenta que no existe, 409 al suspender al último superadmin activo, y el impacto de
 *     suspender sin escribir nada.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Cuelga todo de la raíz `platform` compartida. Los usuarios llevan el sufijo del test en el correo y
 * cada consulta del directorio lo busca: la base la comparten otros tests. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

/** `DatabaseService` que entra como `app_user`, el rol de la API. */
class ComoAppUser extends DatabaseService {
  override async withRequestContext<T>(
    ctx: { userId?: string; tenantId?: string },
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE app_user`.execute(trx);
      if (ctx.userId) {
        await sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`.execute(trx);
      }
      if (ctx.tenantId) {
        await sql`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`.execute(trx);
      }
      return fn(trx);
    });
  }
}

/** Deshace la transacción de un test devolviendo lo que se quiso mirar. */
class Rollback extends Error {
  constructor(readonly result: unknown) {
    super('rollback');
  }
}

/** `código HTTP/motivo` del error con que falla `p`. Falla el test si `p` no falla. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    if (typeof http.getStatus !== 'function') throw err;
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
  throw new Error('esperaba un error HTTP');
}

d('directorio de usuarios de la plataforma y suspensión de la cuenta, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
  } as unknown as PasswordService;
  const mailer = { sendToTenant: vi.fn(() => Promise.resolve(true)) };

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const sessions = new SessionService(database, audit);
  const invitations = new InvitationsService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
  );
  const platformUsers = new PlatformUsersService(database);
  const notices = { notify: vi.fn() };
  const admin = new AdminController(
    database,
    network,
    audit,
    sessions,
    {} as TenantsService,
    {} as SeatsService,
    invitations,
    platformUsers,
    notices as unknown as SecurityNoticeService,
  );

  let platform: string;
  let consNorte: string;
  let agenciaNorte: string;
  let subNorte: string;
  let consSur: string;
  let agenciaSur: string;

  let root: string;
  let otroRoot: string;
  let adminNorte: string;
  let ana: string;
  let beto: string;
  let cami: string;
  let solo: string;
  let suspendido: string;

  const slug = (label: string) => `pu-${label}-${sfx}`;
  const email = (label: string) => `pu-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: TenantType, parent: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [slug(label), `Nodo ${label}`, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(
    label: string,
    patch: {
      name?: string;
      status?: string;
      mfa?: boolean;
      lastLogin?: boolean;
      lockedMinutes?: number;
      verified?: boolean;
      createdAt?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, status, mfa_enabled_at, last_login_at,
                          locked_until, email_verified_at, created_at)
       VALUES ($1, 'hash-original', $2, $3,
               CASE WHEN $4 THEN now() END,
               CASE WHEN $5 THEN now() - interval '1 day' END,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(mins => $6::int) END,
               CASE WHEN $7 THEN now() END,
               COALESCE($8::timestamptz, now()))
       RETURNING id`,
      [
        email(label),
        patch.name ?? null,
        patch.status ?? 'active',
        patch.mfa ?? false,
        patch.lastLogin ?? false,
        patch.lockedMinutes ?? null,
        patch.verified ?? true,
        patch.createdAt ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: Role, status = 'active') {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  async function session(
    userId: string,
    tenantId: string,
    state: 'live' | 'revoked' | 'idle',
    lastSeen = 'now()',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO sessions (user_id, tenant_id, expires_at, last_seen_at, revoked_at)
       VALUES ($1, $2, now() + interval '8 hours',
               ${state === 'idle' ? "now() - interval '2 hours'" : lastSeen},
               ${state === 'revoked' ? 'now()' : 'NULL'})`,
      [userId, tenantId],
    );
  }

  /** El directorio como lo pide el panel, siempre acotado a los usuarios de este test. */
  function list(raw: Record<string, unknown> = {}, actor = root) {
    const query: ListPlatformUsersQuery = ListPlatformUsersQuerySchema.parse({ q: sfx, ...raw });
    return admin.listUsers(actor, query);
  }

  function ids(users: readonly PlatformUser[]): string[] {
    return users.map((u) => u.id);
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    consNorte = await tenant('cons-norte', 'consolidator', platform);
    agenciaNorte = await tenant('agencia-norte', 'agency', consNorte);
    subNorte = await tenant('sub-norte', 'subagency', agenciaNorte);
    consSur = await tenant('cons-sur', 'consolidator', platform);
    agenciaSur = await tenant('agencia-sur', 'agency', consSur);

    root = await user('root', { name: 'Root', mfa: true, lastLogin: true });
    otroRoot = await user('otro-root', { mfa: true, lastLogin: true });
    await member(platform, root, 'superadmin');
    await member(platform, otroRoot, 'superadmin');

    adminNorte = await user('admin-norte', { mfa: true, lastLogin: true });
    await member(consNorte, adminNorte, 'consolidator_admin');

    // Ana vende en las dos redes; Beto sólo en el sur; Cami en la sub-agencia del norte.
    ana = await user('ana', { name: 'Ana Pérez', mfa: true, lastLogin: true, lockedMinutes: 30 });
    await member(agenciaNorte, ana, 'vendedor');
    await member(agenciaSur, ana, 'admin', 'suspended');
    beto = await user('beto', { name: 'Beto_Ruiz', verified: false });
    await member(agenciaSur, beto, 'vendedor');
    cami = await user('cami', { lastLogin: true });
    await member(subNorte, cami, 'vendedor');
    solo = await user('sin-nodos');
    suspendido = await user('suspendido', { status: 'suspended', lastLogin: true });
    await member(agenciaNorte, suspendido, 'admin');

    await session(ana, agenciaNorte, 'live', "now() - interval '5 minutes'");
    await session(ana, agenciaNorte, 'live', "now() - interval '1 minute'");
    await session(ana, agenciaNorte, 'revoked');
    await session(ana, agenciaNorte, 'idle');
    await session(cami, subNorte, 'idle');
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`pu-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('quién lo ve', () => {
    it('el superadmin ve a las personas de todas las redes, una fila por persona, y a quien no tiene nodos', async () => {
      const page = await list();

      expect(ids(page.users).sort()).toEqual(
        [root, otroRoot, adminNorte, ana, beto, cami, solo, suspendido].sort(),
      );
      expect(page.nextCursor).toBeNull();

      const filaAna = page.users.find((u) => u.id === ana)!;
      expect(filaAna).toMatchObject({
        email: email('ana'),
        name: 'Ana Pérez',
        status: 'active',
        emailVerified: true,
        mfaEnabled: true,
        activeSessions: 2,
      });
      expect(filaAna.lockedUntil).not.toBeNull();
      expect(filaAna.lastLoginAt).not.toBeNull();
      // Primero el acceso activo; el suspendido del sur también figura.
      expect(filaAna.memberships).toEqual([
        {
          tenantId: agenciaNorte,
          tenantName: 'Nodo agencia-norte',
          tenantType: 'agency',
          isBranch: false,
          role: 'vendedor',
          status: 'active',
        },
        {
          tenantId: agenciaSur,
          tenantName: 'Nodo agencia-sur',
          tenantType: 'agency',
          isBranch: false,
          role: 'admin',
          status: 'suspended',
        },
      ]);

      expect(page.users.find((u) => u.id === solo)).toMatchObject({
        memberships: [],
        activeSessions: 0,
        lastSeenAt: null,
        lastLoginAt: null,
      });
      expect(page.users.find((u) => u.id === beto)).toMatchObject({ emailVerified: false });
    });

    it('el último acceso real es la sesión más reciente, revocadas incluidas; una vencida por inactividad no está en línea', async () => {
      const page = await list();
      const filaAna = page.users.find((u) => u.id === ana)!;
      const filaCami = page.users.find((u) => u.id === cami)!;

      const { rows } = await pool.query<{ last: Date }>(
        'SELECT max(last_seen_at) AS last FROM sessions WHERE user_id = $1',
        [ana],
      );
      expect(filaAna.lastSeenAt).toBe(rows[0]!.last.toISOString());
      expect(filaCami).toMatchObject({ activeSessions: 0 });
      expect(filaCami.lastSeenAt).not.toBeNull();
    });

    it('un admin de red recibe 403 y no lee nada; sin sesión, 401', async () => {
      expect(await rejection(list({}, adminNorte))).toBe('403/?');
      expect(await rejection(admin.listUsers(undefined, { q: sfx }))).toBe('401/?');
    });

    it('la función de sesiones no la ejecuta cualquiera: sólo app_user', async () => {
      const { rows } = await pool.query<{ public: boolean; app: boolean; definer: boolean }>(
        `SELECT has_function_privilege('public', 'platform_user_session_stats(uuid[])', 'EXECUTE') AS public,
                has_function_privilege('app_user', 'platform_user_session_stats(uuid[])', 'EXECUTE') AS app,
                (SELECT prosecdef FROM pg_proc WHERE proname = 'platform_user_session_stats') AS definer`,
      );
      expect(rows[0]).toEqual({ public: false, app: true, definer: true });
    });

    it('la función no le devuelve nada a quien no es superadmin, aunque la llame directo', async () => {
      const stats = (actor: string | undefined) =>
        database.withRequestContext({ userId: actor }, async (trx) => {
          const { rows } = await sql<{ user_id: string; active_sessions: number }>`
            SELECT user_id, active_sessions FROM platform_user_session_stats(${[ana]}::uuid[])
          `.execute(trx);
          return rows;
        });

      expect(await stats(root)).toEqual([{ user_id: ana, active_sessions: 2 }]);
      expect(await stats(adminNorte)).toEqual([]);
      expect(await stats(ana)).toEqual([]);
      expect(await stats(undefined)).toEqual([]);
    });
  });

  describe('filtros', () => {
    it('la búsqueda va por nombre o correo y escapa los comodines', async () => {
      // `q` reemplaza al sufijo: busca en toda la base, así que se mira lo que trae de este test.
      const porNombre = ids((await list({ q: 'ana pérez', limit: '100' })).users);
      expect(porNombre).toContain(ana);
      expect(porNombre).not.toContain(beto);
      expect(ids((await list({ q: email('beto') })).users)).toEqual([beto]);
      // "_" es literal: "Beto_Ruiz" sí; "otro-root" también coincidiría si fuera un comodín.
      const literal = ids((await list({ q: 'o_r', limit: '100' })).users);
      expect(literal).toContain(beto);
      expect(literal).not.toContain(otroRoot);
      // "%" también: ningún correo del test tiene "<sufijo>%".
      expect(ids((await list({ q: `${sfx}%` })).users)).toEqual([]);
    });

    it('estado de la cuenta', async () => {
      expect(ids((await list({ status: 'suspended' })).users)).toEqual([suspendido]);
      expect(ids((await list({ status: 'active' })).users)).not.toContain(suspendido);
    });

    it('rol y nodo: una membership con ese rol en el subárbol del nodo', async () => {
      const norte = ids((await list({ tenantId: consNorte })).users).sort();
      expect(norte).toEqual([adminNorte, ana, cami, suspendido].sort());

      expect(ids((await list({ tenantId: consNorte, role: 'vendedor' })).users).sort()).toEqual(
        [ana, cami].sort(),
      );
      // Ana es admin en el sur, pero esa membership no está en el norte.
      expect(ids((await list({ tenantId: consNorte, role: 'admin' })).users)).toEqual([suspendido]);
      expect(ids((await list({ role: 'superadmin' })).users).sort()).toEqual(
        [root, otroRoot].sort(),
      );
      expect(ids((await list({ tenantId: agenciaSur })).users).sort()).toEqual([ana, beto].sort());
    });

    it('2FA, bloqueo y nunca ingresaron', async () => {
      expect(ids((await list({ mfa: 'on' })).users).sort()).toEqual(
        [root, otroRoot, adminNorte, ana].sort(),
      );
      expect(ids((await list({ mfa: 'off' })).users).sort()).toEqual(
        [beto, cami, solo, suspendido].sort(),
      );
      expect(ids((await list({ locked: 'true' })).users)).toEqual([ana]);
      expect(ids((await list({ neverLoggedIn: 'true' })).users).sort()).toEqual(
        [beto, solo].sort(),
      );
    });
  });

  describe('cursor', () => {
    it('recorre todo de a una página sin repetir ni saltar, aun con altas del mismo milisegundo', async () => {
      const tag = `mismo-ms-${sfx}`;
      const a = await user(`${tag}-a`, { createdAt: '2026-10-11T12:00:00.123456Z' });
      const b = await user(`${tag}-b`, { createdAt: '2026-10-11T12:00:00.123455Z' });
      const c = await user(`${tag}-c`, { createdAt: '2026-10-11T12:00:00.123454Z' });

      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await list({ q: tag, limit: '1', ...(cursor ? { cursor } : {}) });
        seen.push(...ids(page.users));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual([a, b, c]);
    });

    it('páginas de 3 sobre los usuarios del test: las mismas que sin paginar, en el mismo orden', async () => {
      const all = ids((await list({ limit: '100' })).users);
      const paged: string[] = [];
      let cursor: string | null | undefined;
      for (let i = 0; i < 20; i += 1) {
        const page = await list({ limit: '3', ...(cursor ? { cursor } : {}) });
        paged.push(...ids(page.users));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(paged).toEqual(all);
    });
  });

  describe('suspender la cuenta en toda la plataforma', () => {
    it('una cuenta que no existe: 404 sin evento, en el impacto y en la suspensión', async () => {
      const nadie = '00000000-0000-4000-8000-000000000000';
      expect(await rejection(admin.userImpact(root, nadie))).toBe('404/USER_NOT_FOUND');
      expect(
        await rejection(admin.setUserStatus(root, { userId: nadie, status: 'suspended' })),
      ).toBe('404/USER_NOT_FOUND');
      expect(notices.notify).not.toHaveBeenCalledWith(expect.anything(), {
        userId: nadie,
        tenantId: null,
      });
      const { rows } = await pool.query(
        `SELECT 1 FROM domain_events WHERE event_type = 'UserStatusChanged' AND aggregate_id = $1`,
        [nadie],
      );
      expect(rows).toEqual([]);
    });

    it('el impacto cuenta accesos activos, sesiones vivas e invitaciones que se revocarían, sin tocar nada', async () => {
      const inviter = await user('invitador');
      await member(agenciaNorte, inviter, 'admin');
      await member(agenciaSur, inviter, 'admin');
      await member(subNorte, inviter, 'vendedor', 'suspended');
      await session(inviter, agenciaNorte, 'live');
      await session(inviter, agenciaSur, 'live');
      await session(inviter, agenciaSur, 'revoked');
      const i1 = await invitations.invite({
        actorUserId: inviter,
        tenantId: agenciaNorte,
        email: email('invitado-norte'),
        role: 'vendedor',
      });
      const i2 = await invitations.invite({
        actorUserId: inviter,
        tenantId: agenciaSur,
        email: email('invitado-sur'),
        role: 'vendedor',
      });

      await expect(admin.userImpact(root, inviter)).resolves.toEqual({
        activeMemberships: 2,
        liveSessions: 2,
        invitationsToRevoke: 2,
      });

      const { rows: state } = await pool.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1',
        [inviter],
      );
      expect(state[0]!.status).toBe('active');
      const { rows: pending } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM user_invitations
          WHERE id IN ($1, $2) AND revoked_at IS NULL AND accepted_at IS NULL`,
        [i1.id, i2.id],
      );
      expect(Number(pending[0]!.n)).toBe(2);

      // Y la suspensión revoca exactamente eso.
      await expect(
        admin.setUserStatus(root, { userId: inviter, status: 'suspended' }),
      ).resolves.toMatchObject({ revokedSessions: 2, revokedInvitations: 2 });
    });

    it('el impacto sobre uno mismo es 403; el de un admin de red, 403', async () => {
      expect(await rejection(admin.userImpact(root, root))).toBe('403/?');
      expect(await rejection(admin.userImpact(adminNorte, ana))).toBe('403/?');
    });

    it('a otro superadmin se lo suspende si queda uno activo (quien suspende), y se lo reactiva', async () => {
      const tercero = await user('tercer-root', { mfa: true });
      await member(platform, tercero, 'superadmin');

      await expect(
        admin.setUserStatus(root, { userId: tercero, status: 'suspended' }),
      ).resolves.toMatchObject({ status: 'suspended' });
      await expect(
        admin.setUserStatus(root, { userId: tercero, status: 'active' }),
      ).resolves.toMatchObject({ status: 'active' });
    });

    it('la persona recibe un aviso por cada cambio real de su cuenta, no por repetir el mismo', async () => {
      const dani = await user('dani-aviso');
      await member(agenciaNorte, dani, 'vendedor');
      notices.notify.mockClear();

      await admin.setUserStatus(root, { userId: dani, status: 'suspended' });
      await admin.setUserStatus(root, { userId: dani, status: 'suspended' });
      await admin.setUserStatus(root, { userId: dani, status: 'active' });
      await admin.setUserStatus(root, { userId: dani, status: 'active' });

      expect(notices.notify.mock.calls).toEqual([
        ['account_suspended', { userId: dani, tenantId: null }],
        ['account_reactivated', { userId: dani, tenantId: null }],
      ]);
      // Los cuatro quedan en la auditoría: el aviso es lo único que cuida no repetirse.
      const { rows } = await pool.query(
        `SELECT 1 FROM domain_events WHERE event_type = 'UserStatusChanged' AND aggregate_id = $1`,
        [dani],
      );
      expect(rows).toHaveLength(4);
    });

    it('al último superadmin activo no se lo suspende: 409 (la carrera en que el otro ya cayó)', async () => {
      // En una transacción que se deshace: los superadmins de otros tests y quien suspende quedan
      // inactivos sólo acá adentro, como si otra suspensión simultánea hubiera ganado. Lo que corre
      // la guarda, como app_user y con el contexto del actor.
      const result = await database.db
        .transaction()
        .execute(async (trx) => {
          await sql`SET LOCAL lock_timeout = '10s'`.execute(trx);
          await sql`
            UPDATE memberships SET status = 'suspended'
             WHERE role = 'superadmin' AND status = 'active'
               AND user_id NOT IN (${root}::uuid, ${otroRoot}::uuid)
          `.execute(trx);
          await sql`UPDATE users SET status = 'suspended' WHERE id = ${root}::uuid`.execute(trx);
          await sql`SET LOCAL ROLE app_user`.execute(trx);
          await sql`SELECT set_config('app.current_user_id', ${root}, true)`.execute(trx);

          const last = await rejection(platformUsers.assertNotLastSuperadmin(trx, otroRoot));
          // Quien no es superadmin no la dispara aunque no quede ninguno más.
          await platformUsers.assertNotLastSuperadmin(trx, ana);
          throw new Rollback(last);
        })
        .catch((err: unknown) => {
          if (err instanceof Rollback) return err.result;
          throw err;
        });

      expect(result).toBe('409/LAST_SUPERADMIN');
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1',
        [root],
      );
      expect(rows[0]!.status).toBe('active');
    });
  });
});
