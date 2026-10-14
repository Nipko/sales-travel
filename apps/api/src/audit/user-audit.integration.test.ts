import { createHash, randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { MemberSupportService } from '../tenants/member-support.service.js';
import { decodeAuditCursor, type AuditCategory } from './audit.schemas.js';
import { AuditService, type AuditEntry, type AuditPage } from './audit.service.js';
import { UserAuditController } from './user-audit.controller.js';

/**
 * El historial de una persona y la Actividad de la red, contra Postgres:
 *
 *   - un admin de nodo ve lo que la persona hizo y lo que le hicieron en su subárbol, y nunca un
 *     evento sin nodo (login fallido) ni uno de otra red o de un nodo hermano;
 *   - el superadmin ve todo, eventos sin nodo incluidos, por la función de 0065, que no le responde
 *     a nadie más ni la puede ejecutar PUBLIC;
 *   - 404 desde Equipo si la persona no tiene membership en el subárbol; 403 en /admin a quien no es
 *     superadmin;
 *   - el cursor (occurred_at, id) no salta ni repite los eventos de una misma transacción;
 *   - los filtros de la Actividad de la red y el "a quién" de cada evento;
 *   - lo que sale no trae el enlace de restablecer (ni su hash), contraseñas ni `meta` (IP).
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Cuelga todo de la raíz `platform` compartida. Se SALTA sin PGHOST.
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const types = (page: AuditPage | undefined) => (page?.events ?? []).map((e) => e.eventType);

d('historial por usuario y Actividad de la red, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');

  const mailer = {
    sendToTenant: vi.fn((_tenantId: string | null, _mail: { to: string; text: string }) =>
      Promise.resolve(true),
    ),
  };
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
  } as unknown as PasswordService;
  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const sessions = new SessionService(database, audit);
  const notices = { notify: vi.fn() } as unknown as SecurityNoticeService;
  const resets = new PasswordResetService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
    sessions,
    notices,
  );
  const support = new MemberSupportService(database, network, audit, resets, notices);
  const controller = new UserAuditController(audit, network);

  let cons: string;
  let norte: string;
  let sub: string;
  let sur: string;
  let otra: string;

  let root: string;
  let adminCons: string;
  let adminNorte: string;
  let ajeno: string;
  let ana: string;
  let beto: string;
  let carla: string;
  let dana: string;

  /** El enlace que se le mandó a Ana: nunca puede salir en un historial. */
  let mailedToken: string;
  /** Lo que tampoco: contraseñas, la IP y el navegador de `meta`. */
  const forbidden = ['hash-original', '203.0.113.9', 'Navegador-de-prueba'];

  const slug = (label: string) => `uaud-${label}-${sfx}`;
  const email = (label: string) => `uaud-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: TenantType, parent: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [slug(label), `Nodo ${label}`, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, email_verified_at)
       VALUES ($1, 'hash-original', $2, now()) RETURNING id`,
      [email(label), `Persona ${label}`],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: Role) {
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [
      tenantId,
      userId,
      role,
    ]);
  }

  /** Todas las páginas de `read`, de a `limit`, siguiendo `nextBefore`. */
  async function allPages(
    read: (before: string | undefined) => Promise<AuditPage | undefined>,
  ): Promise<AuditPage[]> {
    const pages: AuditPage[] = [];
    let before: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await read(before);
      if (page === undefined) throw new Error('sin página');
      pages.push(page);
      if (page.nextBefore === null) return pages;
      before = page.nextBefore;
    }
    throw new Error('el cursor no termina');
  }

  const cursor = (raw: string | undefined) =>
    raw === undefined ? undefined : decodeAuditCursor(raw);

  beforeAll(async () => {
    database.onModuleInit();
    const platform = await platformRootId(pool);
    cons = await tenant('cons', 'consolidator', platform);
    norte = await tenant('norte', 'agency', cons);
    sub = await tenant('sub', 'subagency', norte);
    sur = await tenant('sur', 'agency', cons);
    const cons2 = await tenant('cons2', 'consolidator', platform);
    otra = await tenant('otra', 'agency', cons2);

    root = await user('root');
    await member(platform, root, 'superadmin');
    adminCons = await user('admin-cons');
    await member(cons, adminCons, 'consolidator_admin');
    adminNorte = await user('admin-norte');
    await member(norte, adminNorte, 'tenant_admin');
    ajeno = await user('ajeno');
    await member(otra, ajeno, 'tenant_admin');

    // Ana vende en Norte, en Sur (hermana de Norte) y en otra red. Beto sólo en Sur, Carla sólo en
    // la otra red, Dana en la sub-agencia de Norte.
    ana = await user('ana');
    await member(norte, ana, 'vendedor');
    await member(sur, ana, 'vendedor');
    await member(otra, ana, 'vendedor');
    beto = await user('beto');
    await member(sur, beto, 'vendedor');
    carla = await user('carla');
    await member(otra, carla, 'vendedor');
    dana = await user('dana');
    await member(sub, dana, 'vendedor');

    // Lo que hizo Ana en Norte, y un login fallido sin nodo (con IP y navegador en `meta`).
    await audit.emit({
      eventType: 'auth.login.success',
      tenantId: norte,
      actorUserId: ana,
      aggregateType: 'user',
      aggregateId: ana,
      payload: { mfa: false, method: 'password', rememberedDevice: false },
    });
    await requestContextStorage.run({ ip: '203.0.113.9', userAgent: 'Navegador-de-prueba' }, () =>
      audit.emit({
        eventType: 'auth.login.failed',
        actorUserId: ana,
        aggregateType: 'user',
        aggregateId: ana,
        payload: { reason: 'bad_password' },
      }),
    );
    await audit.emit({
      eventType: 'auth.password_reset.requested',
      actorUserId: ana,
      aggregateType: 'user',
      aggregateId: ana,
    });
    await audit.emit({
      eventType: 'UserInvited',
      tenantId: norte,
      actorUserId: ana,
      aggregateType: 'invitation',
      aggregateId: '00000000-0000-4000-8000-000000000001',
      payload: { email: 'nuevo@test.local', role: 'vendedor' },
    });

    // Lo que le hicieron: el superadmin le manda el enlace desde Norte (el servicio real), el
    // consolidador le cambia el rol en Sur (el id en mayúsculas, como lo guarda un borde viejo) y en
    // la otra red le cambian el rol también.
    await support.sendPasswordReset(root, norte, ana);
    const call = mailer.sendToTenant.mock.calls.at(-1);
    mailedToken = decodeURIComponent(/token=([^\s]+)/.exec(call![1].text)![1]!);
    await audit.emit({
      eventType: 'MembershipRoleChanged',
      tenantId: sur,
      actorUserId: adminCons,
      aggregateType: 'membership',
      aggregateId: '00000000-0000-4000-8000-000000000002',
      payload: { targetUserId: ana.toUpperCase(), previousRole: 'vendedor', newRole: 'admin' },
    });
    await audit.emit({
      eventType: 'MembershipRoleChanged',
      tenantId: otra,
      actorUserId: ajeno,
      aggregateType: 'membership',
      aggregateId: '00000000-0000-4000-8000-000000000003',
      payload: { targetUserId: ana, previousRole: 'vendedor', newRole: 'admin' },
    });
    await audit.emit({
      eventType: 'auth.login.success',
      tenantId: otra,
      actorUserId: ana,
      aggregateType: 'user',
      aggregateId: ana,
    });
    // Suspendida en toda la plataforma: la cuenta es el agregado, sin targetUserId ni nodo.
    await audit.emit({
      eventType: 'UserStatusChanged',
      actorUserId: root,
      aggregateType: 'user',
      aggregateId: ana,
      payload: { status: 'suspended', revokedSessions: 0, revokedInvitations: 0 },
    });

    // Lo demás de Norte, para los filtros de la Actividad.
    await audit.emit({
      eventType: 'ProviderCredentialsUpdated',
      tenantId: norte,
      actorUserId: adminNorte,
      aggregateType: 'provider_account',
      aggregateId: '00000000-0000-4000-8000-000000000004',
      payload: { providerCode: 'tbo-hotels', label: 'default', status: 'sandbox' },
    });
    await audit.emit({
      eventType: 'MarkupRuleCreated',
      tenantId: norte,
      actorUserId: adminNorte,
      aggregateType: 'markup_rule',
      aggregateId: '00000000-0000-4000-8000-000000000005',
      payload: { vertical: 'hotels', ruleType: 'percentage', valueMinor: 500 },
    });
    await audit.emit({
      eventType: 'TenantCreated',
      tenantId: sub,
      actorUserId: adminNorte,
      aggregateType: 'tenant',
      aggregateId: sub,
      payload: { slug: slug('sub'), tenantType: 'subagency' },
    });
    await audit.emit({
      eventType: 'tenant.branding.updated',
      tenantId: norte,
      actorUserId: adminNorte,
      aggregateType: 'tenant',
      aggregateId: norte,
    });

    // Cinco ingresos de Dana en UNA sentencia: comparten occurred_at (now() de la transacción).
    await pool.query(
      `INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id)
       SELECT $1::uuid, $2::uuid, 'auth.login.success', 'user', $2::text FROM generate_series(1, 5)`,
      [sub, dana],
    );
  });

  afterAll(async () => {
    const ids = [root, adminCons, adminNorte, ajeno, ana, beto, carla, dana].filter(Boolean);
    await pool.query(
      `DELETE FROM domain_events
        WHERE actor_user_id = ANY($1::uuid[]) OR aggregate_id = ANY($2::text[])
           OR lower(payload ->> 'targetUserId') = ANY($2::text[])`,
      [ids, ids],
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`uaud-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('historial desde Equipo', () => {
    it('el admin de Norte ve lo de Ana en su subárbol y nunca un evento sin nodo ni de otra red', async () => {
      const page = await controller.memberAudit(adminNorte, norte, ana, {});

      expect(types(page).sort()).toEqual(
        ['UserInvited', 'auth.login.success', 'auth.password_reset.sent_by_admin'].sort(),
      );
      expect(page.events.every((e) => e.tenantId === norte)).toBe(true);
      expect(page.nextBefore).toBeNull();

      const sent = page.events.find((e) => e.eventType === 'auth.password_reset.sent_by_admin');
      expect(sent).toMatchObject({
        tenantName: 'Nodo norte',
        actorEmail: email('root'),
        targetEmail: email('ana'),
      });
      // Lo que hizo ella misma no tiene "a quién".
      const own = page.events.find((e) => e.eventType === 'auth.login.success');
      expect(own).toMatchObject({ actorEmail: email('ana'), targetEmail: null });
    });

    it('el consolidador ve también lo del nodo hermano, con el id en mayúsculas', async () => {
      const page = await controller.memberAudit(adminCons, cons, ana, {});

      expect(types(page).sort()).toEqual(
        [
          'MembershipRoleChanged',
          'UserInvited',
          'auth.login.success',
          'auth.password_reset.sent_by_admin',
        ].sort(),
      );
      const changed = page.events.find((e) => e.eventType === 'MembershipRoleChanged');
      expect(changed).toMatchObject({ tenantId: sur, targetEmail: email('ana') });
    });

    it('404 si la persona no tiene membership en el subárbol: hermano u otra red', async () => {
      expect(await rejection(controller.memberAudit(adminNorte, norte, beto, {}))).toBe(
        '404/MEMBER_NOT_FOUND',
      );
      expect(await rejection(controller.memberAudit(adminNorte, norte, carla, {}))).toBe(
        '404/MEMBER_NOT_FOUND',
      );
      expect(await audit.userAuditTrail(adminCons, cons, carla)).toBeUndefined();
    });

    it('403 a quien no administra el nodo de la ruta, aunque la persona esté ahí', async () => {
      expect(await rejection(controller.memberAudit(adminNorte, sur, ana, {}))).toBe(
        '403/TENANT_NOT_MANAGED',
      );
      expect(await rejection(controller.memberAudit(ajeno, norte, ana, {}))).toBe(
        '403/TENANT_NOT_MANAGED',
      );
    });

    it('el cursor no salta ni repite los eventos de una misma transacción', async () => {
      const pages = await allPages((before) =>
        audit.userAuditTrail(adminNorte, norte, dana, { before: cursor(before), limit: 2 }),
      );

      expect(pages.map((p) => p.events.length)).toEqual([2, 2, 1]);
      const ids = pages.flatMap((p) => p.events.map((e) => e.id));
      expect(new Set(ids).size).toBe(5);
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM domain_events WHERE actor_user_id = $1 ORDER BY occurred_at DESC, id DESC`,
        [dana],
      );
      expect(ids).toEqual(rows.map((r) => r.id));
    });
  });

  describe('historial desde Plataforma → Usuarios', () => {
    it('el superadmin ve todo, también lo que no tiene nodo y lo de otras redes', async () => {
      const page = await controller.platformUserAudit(root, ana, {});

      expect(types(page).sort()).toEqual(
        [
          'MembershipRoleChanged',
          'MembershipRoleChanged',
          'UserInvited',
          'UserStatusChanged',
          'auth.login.failed',
          'auth.login.success',
          'auth.login.success',
          'auth.password_reset.requested',
          'auth.password_reset.sent_by_admin',
        ].sort(),
      );
      const failed = page.events.find((e) => e.eventType === 'auth.login.failed');
      expect(failed).toMatchObject({
        tenantId: null,
        tenantName: null,
        actorEmail: email('ana'),
        targetEmail: null,
        payload: { reason: 'bad_password' },
      });
      const suspended = page.events.find((e) => e.eventType === 'UserStatusChanged');
      expect(suspended).toMatchObject({ actorEmail: email('root'), targetEmail: email('ana') });

      const at = page.events.map((e) => e.occurredAt.getTime());
      expect(at).toEqual([...at].sort((a, b) => b - a));
    });

    it('el cursor de la función tampoco salta ni repite', async () => {
      const pages = await allPages((before) =>
        audit.platformUserAuditTrail(root, dana, { before: cursor(before), limit: 2 }),
      );
      expect(pages.map((p) => p.events.length)).toEqual([2, 2, 1]);
      expect(new Set(pages.flatMap((p) => p.events.map((e) => e.id))).size).toBe(5);
    });

    it('403 a quien no es superadmin; 404 si la cuenta no existe', async () => {
      expect(await rejection(controller.platformUserAudit(adminCons, ana, {}))).toBe(
        '403/SUPERADMIN_ONLY',
      );
      expect(
        await rejection(
          controller.platformUserAudit(root, '00000000-0000-4000-8000-0000000000ff', {}),
        ),
      ).toBe('404/USER_NOT_FOUND');
    });

    it('la función no le responde a quien no es superadmin, ni la ejecuta PUBLIC', async () => {
      const rows = await database.withRequestContext({ userId: adminCons }, async (trx) => {
        const res = await sql<{ id: string }>`
          SELECT id FROM platform_user_audit_trail(${ana}::uuid, NULL, NULL, 100)
        `.execute(trx);
        return res.rows;
      });
      expect(rows).toEqual([]);

      const { rows: acl } = await pool.query<{ acl: string | null }>(
        `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'platform_user_audit_trail'`,
      );
      expect(acl[0]?.acl).not.toMatch(/(^|[{,])=X/);
      expect(acl[0]?.acl).toContain('app_user=X');
    });
  });

  it('nada de lo que sale trae el enlace, su hash, contraseñas ni meta', async () => {
    const dumps = JSON.stringify([
      await controller.memberAudit(adminNorte, norte, ana, {}),
      await controller.platformUserAudit(root, ana, {}),
      await audit.networkAudit(adminNorte, norte),
    ]);

    expect(mailedToken.length).toBeGreaterThan(10);
    expect(dumps).not.toContain(mailedToken);
    expect(dumps).not.toContain(sha256(mailedToken));
    for (const text of forbidden) expect(dumps).not.toContain(text);
    expect(dumps).not.toContain('"meta"');
  });

  describe('Actividad de la red', () => {
    const ofNorte = (category?: AuditCategory, actorUserId?: string) =>
      audit.networkAudit(adminNorte, norte, {
        ...(category === undefined ? {} : { category }),
        ...(actorUserId === undefined ? {} : { actorUserId }),
      });

    it('sin filtro: todo el subárbol de Norte, nada sin nodo ni de un hermano', async () => {
      const page = await ofNorte();
      const tenants = new Set(page.events.map((e) => e.tenantId));
      expect([...tenants].sort()).toEqual([norte, sub].sort());
      expect(types(page)).not.toContain('auth.login.failed');
      expect(types(page)).not.toContain('UserStatusChanged');
      expect(types(page)).not.toContain('MembershipRoleChanged');
    });

    it('cada filtro deja sólo lo suyo', async () => {
      const users = await ofNorte('users');
      expect([...new Set(types(users))].sort()).toEqual(
        ['UserInvited', 'auth.login.success', 'auth.password_reset.sent_by_admin'].sort(),
      );
      expect(types(await ofNorte('credentials'))).toEqual(['ProviderCredentialsUpdated']);
      expect(types(await ofNorte('pricing'))).toEqual(['MarkupRuleCreated']);
      expect(types(await ofNorte('network')).sort()).toEqual(
        ['TenantCreated', 'tenant.branding.updated'].sort(),
      );
    });

    it('por persona: sólo lo que hizo ella, con el "a quién" resuelto', async () => {
      const byAna = await ofNorte(undefined, ana);
      expect(types(byAna).sort()).toEqual(['UserInvited', 'auth.login.success'].sort());

      const byRoot = await ofNorte('users', root);
      expect(byRoot.events).toHaveLength(1);
      expect(byRoot.events[0]).toMatchObject<Partial<AuditEntry>>({
        eventType: 'auth.password_reset.sent_by_admin',
        actorEmail: email('root'),
        targetEmail: email('ana'),
      });
    });

    it('el "a quién" no nombra a alguien de otra red aunque el evento quede en este subárbol', async () => {
      // La suspensión global se guarda con el nodo de la sesión del superadmin: si opera en Sur,
      // queda en Sur aunque la cuenta sea de otra red.
      await audit.emit({
        eventType: 'UserStatusChanged',
        tenantId: sur,
        actorUserId: root,
        aggregateType: 'user',
        aggregateId: carla,
        payload: { status: 'suspended', revokedSessions: 0, revokedInvitations: 0 },
      });
      await audit.emit({
        eventType: 'UserStatusChanged',
        tenantId: sur,
        actorUserId: root,
        aggregateType: 'user',
        aggregateId: beto,
        payload: { status: 'suspended', revokedSessions: 0, revokedInvitations: 0 },
      });

      const page = await audit.networkAudit(adminCons, cons, { actorUserId: root });
      const byTarget = page.events
        .filter((e) => e.eventType === 'UserStatusChanged')
        .map((e) => e.targetEmail);
      expect(byTarget.sort()).toEqual([email('beto'), null].sort());
      expect(JSON.stringify(page)).not.toContain(email('carla'));

      // El superadmin sí la ve, con su correo.
      const platform = await audit.platformUserAuditTrail(root, carla);
      expect(platform?.events.find((e) => e.eventType === 'UserStatusChanged')).toMatchObject({
        targetEmail: email('carla'),
      });
    });

    it('paginada sin repetir: lo mismo de a 3 que de una vez', async () => {
      const once = await ofNorte();
      const pages = await allPages((before) =>
        audit.networkAudit(adminNorte, norte, { before: cursor(before), limit: 3 }),
      );
      expect(pages.flatMap((p) => p.events.map((e) => e.id))).toEqual(once.events.map((e) => e.id));
    });
  });
});
