import { createHash, randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordResetService } from '../auth/password-reset.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { MeController } from '../me/me.controller.js';
import { NetworkService } from '../network/network.service.js';
import type { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { AdminController } from './admin.controller.js';
import { InvitationsService } from './invitations.service.js';
import { MemberDetailService } from './member-detail.service.js';
import { MemberSupportService } from './member-support.service.js';
import { PlatformUsersService } from './platform-users.service.js';
import type { SeatsService } from './seats.service.js';
import { TenantsService } from './tenants.service.js';

/**
 * Quitar a una persona de un nodo contra Postgres (USR-11, founder D2 = A): baja blanda.
 *
 *   - la membership queda como `removed` con quién y cuándo, sale de Equipo y de su selector de
 *     agencia, y pierde el acceso en el acto: sus sesiones de ese subárbol se cierran y nada de lo que
 *     da acceso la cuenta; lo que tiene en otros nodos sigue;
 *   - el cambio, las sesiones, las invitaciones que ya no puede respaldar y el evento van juntos: si
 *     el evento no entra, no queda nada;
 *   - reactivarla o cambiarle el rol es 409: la vuelta es una invitación nueva, que al aceptarse
 *     reactiva la MISMA fila;
 *   - las reglas: uno mismo, fuera de la red, el último admin y el 2FA reciente para quitar a un admin.
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOSUPERUSER, NOBYPASSRLS), también el canje de la
 * invitación, que usa la conexión sin contexto: el `ON CONFLICT` que reactiva la fila pasa por la RLS
 * de memberships como en producción. El superusuario sólo siembra y mira. Se SALTA sin PGHOST o sin
 * APP_USER_PASSWORD.
 */
const hasDb = Boolean(
  process.env['PGHOST'] &&
    process.env['PGUSER'] &&
    process.env['PGPASSWORD'] &&
    process.env['APP_USER_PASSWORD'],
);
const d = hasDb ? describe : describe.skip;

/** `DatabaseService` conectado como `app_user`, el rol de la API en producción. */
class ComoAppUser extends DatabaseService {
  override onModuleInit(): void {
    this.db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          user: 'app_user',
          password: process.env['APP_USER_PASSWORD'],
          host: process.env['PGHOST'],
          port: Number(process.env['PGPORT'] ?? 5432),
          database: process.env['PGDATABASE'],
          max: 5,
        }),
      }),
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

/** Quien actúa con el 2FA de hace `minutes` minutos. */
function withMfa(userId: string, minutes: number): RequestContext {
  return {
    userId,
    mfaRequired: true,
    mfaEnabled: true,
    mfaVerified: true,
    mfaVerifiedAt: new Date(Date.now() - minutes * 60_000),
  };
}

d('quitar a una persona de un nodo, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
  } as unknown as PasswordService;
  const mailer = {
    sendToTenant: vi.fn((_tenantId: string, _mail: { to: string; text: string }) =>
      Promise.resolve(true),
    ),
  };

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const sessions = new SessionService(database, audit);
  const invitations = new InvitationsService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
  );
  const notices = { notify: vi.fn() };
  const asNotices = notices as unknown as SecurityNoticeService;

  function adminWith(auditService: AuditService): AdminController {
    return new AdminController(
      database,
      network,
      auditService,
      sessions,
      {} as TenantsService,
      {} as SeatsService,
      invitations,
      new PlatformUsersService(database),
      asNotices,
    );
  }
  const admin = adminWith(audit);
  const tenantsService = new TenantsService(
    database,
    network,
    invitations,
    audit,
    {} as ProviderEnablementStore,
  );
  const me = new MeController(database);
  const detail = new MemberDetailService(database, network, audit, asNotices);
  const support = new MemberSupportService(
    database,
    network,
    audit,
    {} as PasswordResetService,
    asNotices,
  );

  let cons: string;
  let agencyA: string;
  let subA: string;
  let agencyB: string;

  let consAdmin: string;
  let adminA: string;
  let adminB: string;

  const slug = (label: string) => `rm-${label}-${sfx}`;
  const email = (label: string) => `rm-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: TenantType, parent: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug(label), type, parent],
    );
    return rows[0]!.id;
  }

  async function user(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'hash-original') RETURNING id`,
      [email(label)],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: Role): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, userId, role],
    );
    return rows[0]!.id;
  }

  /** Una sesión viva del usuario en ese nodo, como las emite el login. */
  async function session(userId: string, tenantId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, expires_at)
       VALUES ($1, $2, now() + interval '8 hours') RETURNING id`,
      [userId, tenantId],
    );
    return rows[0]!.id;
  }

  async function revokedReason(sessionId: string): Promise<string | null> {
    const { rows } = await pool.query<{ revoked_reason: string | null }>(
      'SELECT revoked_reason FROM sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0]!.revoked_reason;
  }

  async function membership(tenantId: string, userId: string) {
    const { rows } = await pool.query<{
      id: string;
      role: string;
      status: string;
      removed_at: Date | null;
      removed_by: string | null;
    }>(
      `SELECT id, role, status, removed_at, removed_by
         FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    return rows[0];
  }

  /** Invita como `inviter` y devuelve el id y el token en claro (sacado del correo). */
  async function invite(
    inviter: string,
    tenantId: string,
    label: string,
    role: Role,
  ): Promise<{ id: string; token: string }> {
    mailer.sendToTenant.mockClear();
    const { id } = await invitations.invite({
      actorUserId: inviter,
      tenantId,
      email: email(label),
      role,
    });
    const text = mailer.sendToTenant.mock.calls[0]![1].text;
    const token = decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);
    return { id, token };
  }

  async function invitationState(id: string) {
    const { rows } = await pool.query<{ accepted: boolean; revoked: boolean }>(
      `SELECT accepted_at IS NOT NULL AS accepted, revoked_at IS NOT NULL AS revoked
         FROM user_invitations WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function events(type: string, aggregateId: string) {
    const { rows } = await pool.query<{
      actor_user_id: string | null;
      tenant_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, tenant_id, payload FROM domain_events
        WHERE event_type = $1 AND aggregate_id = $2 ORDER BY occurred_at`,
      [type, aggregateId],
    );
    return rows;
  }

  /** Quiénes ve Equipo en ese nodo. */
  async function team(actor: string, tenantId: string): Promise<string[]> {
    return (await network.listTenantUsers(actor, tenantId)).map((u) => u.userId);
  }

  /** `user_admin_overview` como `app_user`: el equipo del subárbol que cuenta Equipo. */
  async function overview(actor: string, tenantId: string): Promise<string[]> {
    return database.withRequestContext({ userId: actor, tenantId }, async (trx) => {
      const res = await sql<{
        user_id: string;
      }>`SELECT user_id FROM user_admin_overview(${tenantId}::uuid)`.execute(trx);
      return res.rows.map((r) => r.user_id);
    });
  }

  beforeAll(async () => {
    database.onModuleInit();
    const platform = await platformRootId(pool);
    cons = await tenant('cons', 'consolidator', platform);
    agencyA = await tenant('a', 'agency', cons);
    subA = await tenant('sub-a', 'subagency', agencyA);
    agencyB = await tenant('b', 'agency', cons);

    consAdmin = await user('cons-admin');
    adminA = await user('admin-a');
    adminB = await user('admin-b');
    await member(cons, consAdmin, 'consolidator_admin');
    await member(agencyA, adminA, 'tenant_admin');
    await member(agencyB, adminB, 'tenant_admin');
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
    notices.notify.mockClear();
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`rm-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('sale de Equipo y de su selector, pierde el acceso en el acto y la fila queda con quién y cuándo', async () => {
    const seller = await user('vendedor');
    const membershipId = await member(agencyA, seller, 'vendedor');
    await member(agencyB, seller, 'vendedor');
    const inA = await session(seller, agencyA);
    const inB = await session(seller, agencyB);
    expect(await team(adminA, agencyA)).toContain(seller);
    const before = await tenantsService.listNetwork(consAdmin);
    const teamSizeA = before.find((n) => n.id === agencyA)!.userCount;
    const teamSizeB = before.find((n) => n.id === agencyB)!.userCount;

    const res = await admin.removeMembership(adminA, { userId: seller, tenantId: agencyA });

    expect(res).toEqual({
      id: membershipId,
      status: 'removed',
      revokedSessions: 1,
      revokedInvitations: 0,
    });
    // Baja blanda: la misma fila, con quién y cuándo.
    expect(await membership(agencyA, seller)).toMatchObject({
      id: membershipId,
      status: 'removed',
      removed_by: adminA,
      removed_at: expect.any(Date) as unknown,
    });

    // Equipo ya no la muestra; en el consolidador sigue, por su agencia B.
    expect(await team(adminA, agencyA)).not.toContain(seller);
    expect(await overview(adminA, agencyA)).not.toContain(seller);
    expect(await overview(consAdmin, cons)).toContain(seller);

    // Pierde el acceso a A en el acto; B sigue como estaba.
    expect(await revokedReason(inA)).toBe('membership_removed');
    expect(await revokedReason(inB)).toBeNull();
    expect(await sessions.validate({ sessionId: inA, userId: seller, tenantId: agencyA })).toEqual({
      ok: false,
      reason: 'SESSION_REVOKED',
    });
    expect(
      await sessions.validate({ sessionId: inB, userId: seller, tenantId: agencyB }),
    ).toMatchObject({ ok: true, role: 'vendedor' });
    expect(await network.canAccessTenant(seller, agencyA)).toBe(false);

    // Su selector de agencia ya no ofrece A, ni deshabilitada.
    const mine = await me.memberships(seller);
    expect(mine.map((m) => m.tenantId)).toEqual([agencyB]);

    // Desde el consolidador su ficha se abre por B, y ya no lista A entre sus nodos.
    const card = await detail.detail(consAdmin, cons, seller);
    expect(card.memberships.map((m) => m.tenantId)).toEqual([agencyB]);

    // Gestión de Agencias no la cuenta entre los usuarios de A.
    const nodes = await tenantsService.listNetwork(consAdmin);
    const countOf = (id: string) => nodes.find((n) => n.id === id)?.userCount;
    expect(countOf(agencyA)).toBe(teamSizeA - 1);
    expect(countOf(agencyB)).toBe(teamSizeB);

    // El rastro: el evento en la misma transacción y el aviso a su correo.
    expect(await events('MembershipRemoved', membershipId)).toEqual([
      {
        actor_user_id: adminA,
        tenant_id: agencyA,
        payload: {
          targetUserId: seller,
          role: 'vendedor',
          previousStatus: 'active',
          revokedSessions: 1,
          revokedInvitations: 0,
        },
      },
    ]);
    expect(notices.notify.mock.calls).toEqual([
      ['membership_removed', { userId: seller, tenantId: agencyA }],
    ]);
  });

  it('si el evento no entra, no queda nada: ni la baja ni las sesiones cerradas ni el aviso', async () => {
    const seller = await user('sin-evento');
    await member(agencyA, seller, 'vendedor');
    const inA = await session(seller, agencyA);
    const failing = Object.create(audit) as AuditService;
    failing.emitWithin = () => Promise.reject(new Error('el evento no entró'));

    await expect(
      adminWith(failing).removeMembership(adminA, { userId: seller, tenantId: agencyA }),
    ).rejects.toThrow('el evento no entró');

    expect(await membership(agencyA, seller)).toMatchObject({
      status: 'active',
      removed_at: null,
      removed_by: null,
    });
    expect(await revokedReason(inA)).toBeNull();
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('las invitaciones que emitió y ya no puede respaldar se revocan, con la causa; preguntar antes no cambia nada', async () => {
    const manager = await user('manager');
    await member(agencyA, manager, 'admin');
    const sent = await invite(manager, subA, 'invitado-sub', 'vendedor');

    expect(
      await admin.membershipImpact(adminA, {
        userId: manager,
        tenantId: agencyA,
        status: 'removed',
      }),
    ).toEqual({ invitationsToRevoke: 1 });
    expect(await membership(agencyA, manager)).toMatchObject({
      status: 'active',
      removed_at: null,
    });
    expect(await invitationState(sent.id)).toEqual({ accepted: false, revoked: false });

    // Es admin: quitarlo pide el 2FA reciente.
    const res = await requestContextStorage.run(withMfa(adminA, 1), () =>
      admin.removeMembership(adminA, { userId: manager, tenantId: agencyA }),
    );

    expect(res.revokedInvitations).toBe(1);
    expect(await invitationState(sent.id)).toEqual({ accepted: false, revoked: true });
    expect(await events('UserInvitationRevoked', sent.id)).toEqual([
      {
        actor_user_id: adminA,
        tenant_id: subA,
        payload: { cause: 'membership_removed', defect: 'inviter_outranked', invitedBy: manager },
      },
    ]);
  });

  it('reactivarla o cambiarle el rol es 409; la vuelta es una invitación nueva que reactiva la misma fila', async () => {
    const back = await user('vuelve');
    const membershipId = await member(agencyA, back, 'vendedor');
    await admin.removeMembership(adminA, { userId: back, tenantId: agencyA });

    expect(
      await rejection(
        admin.setMembershipStatus(adminA, { userId: back, tenantId: agencyA, status: 'active' }),
      ),
    ).toBe('409/MEMBERSHIP_REMOVED');
    expect(
      await rejection(admin.changeRole(adminA, { userId: back, tenantId: agencyA, role: 'admin' })),
    ).toBe('409/MEMBERSHIP_REMOVED');
    expect(
      await rejection(admin.removeMembership(adminA, { userId: back, tenantId: agencyA })),
    ).toBe('409/MEMBERSHIP_REMOVED');
    expect(await membership(agencyA, back)).toMatchObject({ status: 'removed', role: 'vendedor' });

    // Se la invita de nuevo, con otro rol: invitar ya no la cuenta como miembro.
    const again = await invite(adminA, agencyA, 'vuelve', 'admin');
    const accepted = await invitations.accept({
      token: again.token,
      name: 'Vuelve',
      password: 'una-clave-larga-123',
    });

    expect(accepted).toEqual({ userId: back, tenantId: agencyA });
    expect(await membership(agencyA, back)).toEqual({
      id: membershipId,
      role: 'admin',
      status: 'active',
      removed_at: null,
      removed_by: null,
    });
    expect(await invitationState(again.id)).toEqual({ accepted: true, revoked: false });
    expect(await events('UserInvitationAccepted', again.id)).toEqual([
      {
        actor_user_id: back,
        tenant_id: agencyA,
        payload: { email: email('vuelve'), role: 'admin', rejoined: true },
      },
    ]);
    expect(await team(adminA, agencyA)).toContain(back);
    expect(await network.canAccessTenant(back, agencyA)).toBe(true);
  });

  it('alguien nuevo entra como siempre: una membership nueva, sin `rejoined`', async () => {
    const fresh = await invite(adminA, agencyA, 'nuevo', 'vendedor');
    const { userId } = await invitations.accept({
      token: fresh.token,
      name: 'Nuevo',
      password: 'una-clave-larga-123',
    });

    expect(await membership(agencyA, userId)).toMatchObject({
      role: 'vendedor',
      status: 'active',
      removed_at: null,
    });
    expect(await events('UserInvitationAccepted', fresh.id)).toEqual([
      {
        actor_user_id: userId,
        tenant_id: agencyA,
        payload: { email: email('nuevo'), role: 'vendedor' },
      },
    ]);
  });

  it('a quien ya está no se lo invita, y una invitación vieja no lo duplica: 409 y queda pendiente', async () => {
    const here = await user('ya-esta');
    await member(agencyA, here, 'vendedor');

    expect(await rejection(invite(adminA, agencyA, 'ya-esta', 'vendedor'))).toBe('409/?');

    // Una invitación de antes de esa regla, para el mismo nodo.
    const token = randomBytes(32).toString('base64url');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'admin', $3, $4, now() + interval '7 days') RETURNING id`,
      [agencyA, email('ya-esta'), createHash('sha256').update(token).digest('hex'), adminA],
    );
    const legacy = rows[0]!.id;

    expect(
      await rejection(
        invitations.accept({ token, name: 'Ya está', password: 'una-clave-larga-123' }),
      ),
    ).toBe('409/ALREADY_MEMBER');
    expect(await invitationState(legacy)).toEqual({ accepted: false, revoked: false });
    expect(await membership(agencyA, here)).toMatchObject({ role: 'vendedor', status: 'active' });
  });

  it('una suspendida también se quita; la base no deja una quitada sin fecha', async () => {
    const paused = await user('suspendido');
    const membershipId = await member(agencyA, paused, 'vendedor');
    await admin.setMembershipStatus(adminA, {
      userId: paused,
      tenantId: agencyA,
      status: 'suspended',
    });

    await admin.removeMembership(adminA, { userId: paused, tenantId: agencyA });
    const [event] = await events('MembershipRemoved', membershipId);
    expect(event?.payload).toMatchObject({ previousStatus: 'suspended', revokedSessions: 0 });

    const other = await user('sin-fecha');
    await member(agencyA, other, 'vendedor');
    await expect(
      pool.query(
        `UPDATE memberships SET status = 'removed' WHERE tenant_id = $1 AND user_id = $2`,
        [agencyA, other],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'memberships_removed_consistent' });
  });

  it('las reglas: uno mismo, fuera de la red, el último admin y el 2FA reciente para quitar a un admin', async () => {
    expect(
      await rejection(admin.removeMembership(adminB, { userId: adminB, tenantId: agencyB })),
    ).toBe('403/?');

    const sellerA = await user('vendedor-a');
    await member(agencyA, sellerA, 'vendedor');
    expect(
      await rejection(admin.removeMembership(adminB, { userId: sellerA, tenantId: agencyA })),
    ).toBe('403/?');

    // adminB es el único admin activo de B.
    await expect(
      requestContextStorage.run(withMfa(consAdmin, 1), () =>
        admin.removeMembership(consAdmin, { userId: adminB, tenantId: agencyB }),
      ),
    ).rejects.toThrow('Es el último administrador activo del nodo: asigna otro antes de quitarlo.');

    // Con otro admin en B, quitarlo pide el 2FA de los últimos minutos.
    const second = await user('admin-b2');
    await member(agencyB, second, 'admin');
    expect(
      await requestContextStorage.run(withMfa(consAdmin, 11), () =>
        rejection(admin.removeMembership(consAdmin, { userId: second, tenantId: agencyB })),
      ),
    ).toBe('403/MFA_RECENT_REQUIRED');
    expect(await membership(agencyB, second)).toMatchObject({ status: 'active' });
    expect(await membership(agencyB, adminB)).toMatchObject({ status: 'active' });
  });

  it('dos admins de arriba quitan a la vez a los dos últimos admins del nodo: uno gana y el nodo no queda sin admin', async () => {
    const node = await tenant('duelo', 'agency', cons);
    const otherCons = await user('cons-admin-2');
    await member(cons, otherCons, 'consolidator_admin');
    const first = await user('duelo-1');
    const second = await user('duelo-2');
    await member(node, first, 'tenant_admin');
    await member(node, second, 'tenant_admin');

    // Cada uno ve al otro admin como el que queda: el chequeo de afuera pasa en los dos.
    const results = await Promise.allSettled([
      requestContextStorage.run(withMfa(consAdmin, 1), () =>
        admin.removeMembership(consAdmin, { userId: first, tenantId: node }),
      ),
      requestContextStorage.run(withMfa(otherCons, 1), () =>
        admin.removeMembership(otherCons, { userId: second, tenantId: node }),
      ),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect((lost?.reason as Error).message).toBe(
      'Es el último administrador activo del nodo: asigna otro antes de quitarlo.',
    );
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND status = 'active'`,
      [node],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('el rol se vuelve a mirar con la fila tomada: si lo ascendieron en el medio, valen las reglas de admin', async () => {
    const promoted = await user('ascendido');
    await member(agencyA, promoted, 'vendedor');
    // Lo leyó vendedor; antes de tomar la fila (la 2ª transacción del pedido), otro admin lo hace
    // tenant_admin de A.
    let calls = 0;
    const slow = Object.create(database) as DatabaseService;
    slow.withRequestContext = async <T>(
      ctx: { userId?: string; tenantId?: string },
      fn: (trx: Transaction<DB>) => Promise<T>,
    ): Promise<T> => {
      if (ctx.tenantId === agencyA && ++calls === 2) {
        await pool.query(
          `UPDATE memberships SET role = 'tenant_admin' WHERE tenant_id = $1 AND user_id = $2`,
          [agencyA, promoted],
        );
      }
      return database.withRequestContext(ctx, fn);
    };
    const racing = new AdminController(
      slow,
      network,
      audit,
      sessions,
      {} as TenantsService,
      {} as SeatsService,
      invitations,
      new PlatformUsersService(database),
      asNotices,
    );

    // adminA es tenant_admin: no supera a otro tenant_admin.
    expect(
      await rejection(racing.removeMembership(adminA, { userId: promoted, tenantId: agencyA })),
    ).toBe('403/ROLE_NOT_GRANTABLE');
    expect(await membership(agencyA, promoted)).toMatchObject({
      status: 'active',
      role: 'tenant_admin',
    });
  });

  it('un rol de plataforma no se quita: ninguna invitación lo devuelve', async () => {
    const platform = await platformRootId(pool);
    const superadmin = await user('super');
    const other = await user('super-2');
    await member(platform, superadmin, 'superadmin');
    await member(platform, other, 'superadmin');

    try {
      expect(
        await requestContextStorage.run(withMfa(superadmin, 1), () =>
          rejection(admin.removeMembership(superadmin, { userId: other, tenantId: platform })),
        ),
      ).toBe('403/PLATFORM_ROLE_NOT_REMOVABLE');
      expect(await membership(platform, other)).toMatchObject({ status: 'active' });
    } finally {
      // Otros archivos cuentan los superadmins de la plataforma: no dejarlos más de lo necesario.
      await pool.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = ANY($2)', [
        platform,
        [superadmin, other],
      ]);
    }
  });

  it('quien se quitó ya no es del equipo: ni su ficha ni el soporte ni su seguridad se abren desde el nodo', async () => {
    const gone = await user('ficha');
    await member(agencyA, gone, 'vendedor');
    await session(gone, agencyA);
    expect((await detail.detail(adminA, agencyA, gone)).user.id).toBe(gone);

    await admin.removeMembership(adminA, { userId: gone, tenantId: agencyA });

    expect(await rejection(detail.detail(adminA, agencyA, gone))).toBe('404/MEMBER_NOT_FOUND');
    expect(await rejection(support.revokeSessions(adminA, agencyA, gone))).toBe(
      '404/MEMBER_NOT_FOUND',
    );
    // El respaldo en la base: su seguridad no le responde al admin de un nodo donde ya no está.
    const security = await database.withRequestContext({ userId: adminA }, (trx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM admin_user_security(${gone}::uuid)`.execute(
        trx,
      ),
    );
    expect(security.rows[0]?.n).toBe(0);
  });
});
