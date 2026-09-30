import { randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { NetworkService } from '../network/network.service.js';
import { AdminController } from './admin.controller.js';
import { InvitationsService } from './invitations.service.js';
import type { SeatsService } from './seats.service.js';
import type { TenantsService } from './tenants.service.js';

/**
 * Suspender o degradar una membership contra Postgres (brechas de la auditoría del 2026-09-29):
 *
 *   - suspender a alguien en un nodo cierra sus sesiones de ESE subárbol y nada más: quien opera en
 *     dos agencias sigue operando en la otra, y el admin de una sucursal no le cierra todo al
 *     superadmin que es miembro de ella;
 *   - las invitaciones que el suspendido o degradado emitió y ya no podría emitir se revocan en la
 *     misma transacción, con su evento; las que sigue respaldando (por otro rol suyo) quedan;
 *   - el canje revalida invitador y nodo, y deja la invitación pendiente si no pasa;
 *   - un admin no toca memberships ni invitaciones fuera de su red (aislamiento cross-tenant).
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

d('suspender o degradar una membership, contra Postgres', () => {
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
  const admin = new AdminController(
    database,
    network,
    audit,
    sessions,
    {} as TenantsService,
    {} as SeatsService,
    invitations,
  );

  let platform: string;
  let cons: string;
  let agencyA: string;
  let subA: string;
  let agencyB: string;
  let branch: string;

  let superadmin: string;
  let consAdmin: string;
  let adminA: string;
  let adminB: string;
  let branchAdmin: string;

  const slug = (label: string) => `mr-${label}-${sfx}`;
  const email = (label: string) => `mr-${label}-${sfx}@test.local`;

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

  async function member(tenantId: string, userId: string, role: Role) {
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [
      tenantId,
      userId,
      role,
    ]);
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

  async function membershipStatus(tenantId: string, userId: string) {
    const { rows } = await pool.query<{ id: string; status: string; role: string }>(
      'SELECT id, status, role FROM memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    cons = await tenant('cons', 'consolidator', platform);
    agencyA = await tenant('a', 'agency', cons);
    subA = await tenant('sub-a', 'subagency', agencyA);
    agencyB = await tenant('b', 'agency', cons);
    branch = await tenant('sucursal', 'agency', platform);

    superadmin = await user('root');
    consAdmin = await user('cons-admin');
    adminA = await user('admin-a');
    adminB = await user('admin-b');
    branchAdmin = await user('admin-sucursal');
    await member(platform, superadmin, 'superadmin');
    await member(cons, consAdmin, 'consolidator_admin');
    await member(agencyA, adminA, 'tenant_admin');
    await member(agencyB, adminB, 'tenant_admin');
    await member(branch, branchAdmin, 'tenant_admin');
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`mr-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('sesiones: suspender corta el nodo, no a la persona', () => {
    it('un vendedor de dos agencias suspendido en A sigue operando en B', async () => {
      const seller = await user('vendedor-dos');
      await member(agencyA, seller, 'vendedor');
      await member(agencyB, seller, 'vendedor');
      const inA = await session(seller, agencyA);
      const inB = await session(seller, agencyB);

      const res = await admin.setMembershipStatus(adminA, {
        userId: seller,
        tenantId: agencyA,
        status: 'suspended',
      });

      expect(res).toMatchObject({ status: 'suspended', revokedSessions: 1, revokedInvitations: 0 });
      expect(await revokedReason(inA)).toBe('membership_suspended');
      expect(await revokedReason(inB)).toBeNull();
      expect(
        await sessions.validate({ sessionId: inB, userId: seller, tenantId: agencyB }),
      ).toMatchObject({ ok: true, role: 'vendedor' });
      expect(
        await sessions.validate({ sessionId: inA, userId: seller, tenantId: agencyA }),
      ).toEqual({ ok: false, reason: 'SESSION_REVOKED' });

      const [event] = await events('MembershipStatusChanged', res.id);
      expect(event).toMatchObject({
        actor_user_id: adminA,
        tenant_id: agencyA,
        payload: {
          targetUserId: seller,
          status: 'suspended',
          role: 'vendedor',
          revokedSessions: 1,
          revokedInvitations: 0,
        },
      });
    });

    it('el admin de una sucursal no le cierra al superadmin sus sesiones de otros nodos', async () => {
      await member(branch, superadmin, 'vendedor');
      const atPlatform = await session(superadmin, platform);
      const atBranch = await session(superadmin, branch);

      await admin.setMembershipStatus(branchAdmin, {
        userId: superadmin,
        tenantId: branch,
        status: 'suspended',
      });

      expect(await revokedReason(atBranch)).toBe('membership_suspended');
      expect(await revokedReason(atPlatform)).toBeNull();
      expect(
        await sessions.validate({ sessionId: atPlatform, userId: superadmin, tenantId: platform }),
      ).toMatchObject({ ok: true, role: 'superadmin' });
    });

    it('en el subárbol sólo cae lo que dependía del nodo: su sesión de la sub-agencia sigue', async () => {
      const mixed = await user('mixto');
      await member(agencyA, mixed, 'admin');
      await member(subA, mixed, 'vendedor');
      const inA = await session(mixed, agencyA);
      const inSub = await session(mixed, subA);

      await admin.setMembershipStatus(adminA, {
        userId: mixed,
        tenantId: agencyA,
        status: 'suspended',
      });

      expect(await revokedReason(inA)).toBe('membership_suspended');
      expect(await revokedReason(inSub)).toBeNull();
      expect(
        await sessions.validate({ sessionId: inSub, userId: mixed, tenantId: subA }),
      ).toMatchObject({ ok: true, role: 'vendedor' });
      // Las potestades que le daba la agencia sobre la sub-agencia se cortaron solas.
      expect(await network.roleOver(mixed, subA)).toBeUndefined();
    });

    it('reactivar no toca sesiones', async () => {
      const back = await user('vuelve');
      await member(agencyA, back, 'vendedor');
      await admin.setMembershipStatus(adminA, {
        userId: back,
        tenantId: agencyA,
        status: 'suspended',
      });
      const fresh = await session(back, agencyA);

      const res = await admin.setMembershipStatus(adminA, {
        userId: back,
        tenantId: agencyA,
        status: 'active',
      });

      expect(res).toMatchObject({ status: 'active', revokedSessions: 0, revokedInvitations: 0 });
      expect(await revokedReason(fresh)).toBeNull();
    });
  });

  describe('invitaciones: valen mientras su invitador las pueda volver a emitir', () => {
    it('suspender al invitador revoca las que emitió en ese subárbol, con evento; las de otra agencia quedan', async () => {
      const leaver = await user('se-va');
      await member(agencyA, leaver, 'tenant_admin');
      await member(agencyB, leaver, 'tenant_admin');
      const manager = await invite(leaver, agencyA, 'gmail-manager', 'admin');
      const inSub = await invite(leaver, subA, 'gmail-sub', 'vendedor');
      const inB = await invite(leaver, agencyB, 'gmail-b', 'vendedor');
      const inB2 = await session(leaver, agencyB);

      // La confirmación de Equipo pregunta antes, y preguntar no cambia nada.
      expect(
        await admin.membershipImpact(consAdmin, {
          userId: leaver,
          tenantId: agencyA,
          status: 'suspended',
        }),
      ).toEqual({ invitationsToRevoke: 2 });
      expect(await membershipStatus(agencyA, leaver)).toMatchObject({ status: 'active' });
      expect(await invitationState(manager.id)).toEqual({ accepted: false, revoked: false });

      const res = await admin.setMembershipStatus(consAdmin, {
        userId: leaver,
        tenantId: agencyA,
        status: 'suspended',
      });

      expect(res.revokedInvitations).toBe(2);
      expect(await invitationState(manager.id)).toEqual({ accepted: false, revoked: true });
      expect(await invitationState(inSub.id)).toEqual({ accepted: false, revoked: true });
      expect(await invitationState(inB.id)).toEqual({ accepted: false, revoked: false });
      expect(await revokedReason(inB2)).toBeNull();
      expect(await events('UserInvitationRevoked', manager.id)).toEqual([
        {
          actor_user_id: consAdmin,
          tenant_id: agencyA,
          payload: {
            cause: 'membership_suspended',
            defect: 'inviter_outranked',
            invitedBy: leaver,
          },
        },
      ]);
      expect(await events('UserInvitationRevoked', inSub.id)).toHaveLength(1);

      // El caso de la auditoría: el gmail acepta dentro de los 7 días.
      expect(
        await rejection(invitations.accept({ token: manager.token, name: 'Yo', password: 'x' })),
      ).toBe('400/?');
      const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [
        email('gmail-manager'),
      ]);
      expect(rows).toHaveLength(0);
    });

    it('degradar revoca sólo las que ya no podría emitir', async () => {
      const demoted = await user('degradado');
      await member(agencyA, demoted, 'tenant_admin');
      const asAdmin = await invite(demoted, agencyA, 'inv-admin', 'admin');
      const asSeller = await invite(demoted, agencyA, 'inv-vendedor', 'vendedor');
      const inSub = await invite(demoted, subA, 'inv-sub-vendedor', 'vendedor');

      expect(
        await admin.membershipImpact(consAdmin, {
          userId: demoted,
          tenantId: agencyA,
          role: 'admin',
        }),
      ).toEqual({ invitationsToRevoke: 1 });
      expect(await membershipStatus(agencyA, demoted)).toMatchObject({ role: 'tenant_admin' });

      const res = await admin.changeRole(consAdmin, {
        userId: demoted,
        tenantId: agencyA,
        role: 'admin',
      });

      expect(res).toMatchObject({ role: 'admin', revokedInvitations: 1 });
      expect(await invitationState(asAdmin.id)).toEqual({ accepted: false, revoked: true });
      expect(await invitationState(asSeller.id)).toEqual({ accepted: false, revoked: false });
      expect(await invitationState(inSub.id)).toEqual({ accepted: false, revoked: false });
      expect(await events('UserInvitationRevoked', asAdmin.id)).toMatchObject([
        { payload: { cause: 'role_changed', defect: 'inviter_outranked' } },
      ]);
      expect(await events('MembershipRoleChanged', res.id)).toMatchObject([
        {
          actor_user_id: consAdmin,
          payload: { previousRole: 'tenant_admin', newRole: 'admin', revokedInvitations: 1 },
        },
      ]);
    });

    it('si otro rol suyo la sigue respaldando, suspenderlo en el nodo no la revoca', async () => {
      const dual = await user('dual');
      await member(cons, dual, 'consolidator_admin');
      await member(agencyA, dual, 'admin');
      const pending = await invite(dual, agencyA, 'respaldada', 'vendedor');

      expect(
        await admin.membershipImpact(consAdmin, {
          userId: dual,
          tenantId: agencyA,
          status: 'suspended',
        }),
      ).toEqual({ invitationsToRevoke: 0 });
      const res = await admin.setMembershipStatus(consAdmin, {
        userId: dual,
        tenantId: agencyA,
        status: 'suspended',
      });

      expect(res.revokedInvitations).toBe(0);
      expect(await invitationState(pending.id)).toEqual({ accepted: false, revoked: false });
      await expect(
        invitations.accept({ token: pending.token, name: 'Nueva', password: 'x' }),
      ).resolves.toMatchObject({ tenantId: agencyA });
    });

    it('suspender al usuario en la plataforma cierra todas sus sesiones y revoca todas sus invitaciones', async () => {
      const goner = await user('suspendido');
      await member(agencyA, goner, 'admin');
      await member(agencyB, goner, 'admin');
      const s1 = await session(goner, agencyA);
      const s2 = await session(goner, agencyB);
      const i1 = await invite(goner, agencyA, 'del-suspendido-a', 'vendedor');
      const i2 = await invite(goner, agencyB, 'del-suspendido-b', 'vendedor');

      const res = await admin.setUserStatus(superadmin, { userId: goner, status: 'suspended' });

      expect(res).toMatchObject({ revokedSessions: 2, revokedInvitations: 2 });
      expect(await revokedReason(s1)).toBe('user_suspended');
      expect(await revokedReason(s2)).toBe('user_suspended');
      expect(await invitationState(i1.id)).toEqual({ accepted: false, revoked: true });
      expect(await invitationState(i2.id)).toEqual({ accepted: false, revoked: true });
      expect(await events('UserInvitationRevoked', i2.id)).toMatchObject([
        {
          actor_user_id: superadmin,
          tenant_id: agencyB,
          payload: { cause: 'user_suspended', defect: 'inviter_inactive' },
        },
      ]);
      expect(await events('UserStatusChanged', goner)).toMatchObject([
        { payload: { status: 'suspended', revokedSessions: 2, revokedInvitations: 2 } },
      ]);
    });
  });

  describe('canje: revalida invitador y nodo', () => {
    it('el invitador perdió el rango por otro camino: 400 con motivo, la invitación queda pendiente y queda el rastro', async () => {
      const ghost = await user('fantasma');
      await member(agencyA, ghost, 'tenant_admin');
      const pending = await invite(ghost, agencyA, 'de-fantasma', 'vendedor');
      // Sin pasar por el endpoint (un nodo movido, un dato viejo): nadie revocó la invitación.
      await pool.query(`UPDATE memberships SET status = 'suspended' WHERE user_id = $1`, [ghost]);

      expect(
        await rejection(invitations.accept({ token: pending.token, name: 'X', password: 'x' })),
      ).toBe('400/INVITATION_NO_LONGER_VALID');
      expect(await invitationState(pending.id)).toEqual({ accepted: false, revoked: false });
      const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [
        email('de-fantasma'),
      ]);
      expect(rows).toHaveLength(0);
      expect(await events('UserInvitationRejected', pending.id)).toEqual([
        { actor_user_id: null, tenant_id: agencyA, payload: { defect: 'inviter_outranked' } },
      ]);
    });

    it('nodo suspendido: no se canjea; reactivado, sí, una sola vez', async () => {
      const pending = await invite(adminA, subA, 'nodo-suspendido', 'vendedor');
      await pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [subA]);
      try {
        expect(
          await rejection(invitations.accept({ token: pending.token, name: 'X', password: 'x' })),
        ).toBe('400/INVITATION_NO_LONGER_VALID');
        expect(await events('UserInvitationRejected', pending.id)).toMatchObject([
          { payload: { defect: 'tenant_inactive' } },
        ]);
      } finally {
        await pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [subA]);
      }

      const accepted = await invitations.accept({
        token: pending.token,
        name: 'Ana',
        password: 'una-clave-larga',
      });

      expect(accepted.tenantId).toBe(subA);
      expect(await membershipStatus(subA, accepted.userId)).toMatchObject({
        status: 'active',
        role: 'vendedor',
      });
      expect(await invitationState(pending.id)).toEqual({ accepted: true, revoked: false });
      expect(
        await rejection(invitations.accept({ token: pending.token, name: 'Ana', password: 'x' })),
      ).toBe('400/?');
    });
  });

  describe('aislamiento cross-tenant', () => {
    it('el admin de B no suspende ni simula sobre una membership de A, y no toca nada', async () => {
      const seller = await user('de-a');
      await member(agencyA, seller, 'vendedor');
      const inA = await session(seller, agencyA);

      expect(
        await rejection(
          admin.setMembershipStatus(adminB, {
            userId: seller,
            tenantId: agencyA,
            status: 'suspended',
          }),
        ),
      ).toBe('403/?');
      expect(
        await rejection(
          admin.membershipImpact(adminB, {
            userId: seller,
            tenantId: agencyA,
            status: 'suspended',
          }),
        ),
      ).toBe('403/?');
      expect(await membershipStatus(agencyA, seller)).toMatchObject({ status: 'active' });
      expect(await revokedReason(inA)).toBeNull();
    });

    it('las invitaciones del suspendido fuera de la red del actor no se tocan ni se cuentan', async () => {
      // Admin en A (red del consolidador) y en la sucursal (otra red).
      const cross = await user('entre-redes');
      await member(agencyA, cross, 'admin');
      await member(branch, cross, 'admin');
      const inBranch = await invite(cross, branch, 'de-la-sucursal', 'vendedor');
      const inA = await invite(cross, agencyA, 'de-la-agencia', 'vendedor');

      const res = await admin.setMembershipStatus(adminA, {
        userId: cross,
        tenantId: agencyA,
        status: 'suspended',
      });

      expect(res.revokedInvitations).toBe(1);
      expect(await invitationState(inA.id)).toEqual({ accepted: false, revoked: true });
      expect(await invitationState(inBranch.id)).toEqual({ accepted: false, revoked: false });
    });
  });
});
