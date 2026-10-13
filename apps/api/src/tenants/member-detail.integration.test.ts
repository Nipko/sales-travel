import { createHash, randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { MemberDetailService, type MemberDetail } from './member-detail.service.js';

/**
 * La ficha de un usuario y el cierre de una sesión puntual, contra Postgres:
 *
 *   - un admin de nodo ve las sesiones del subárbol de su nodo y nunca las de un nodo hermano o
 *     del padre; sus nodos, los que administra; el superadmin ve todo;
 *   - las funciones de 0064 sólo las ejecuta `app_user` y, llamadas directo, no le responden a quien
 *     no administra la raíz (o, sin raíz, a quien no es superadmin);
 *   - los códigos de recuperación sin usar y los equipos de confianza que de verdad valen;
 *   - quién lo invitó y sus invitaciones pendientes, acotadas al subárbol;
 *   - cerrar una sesión deja el evento en la misma transacción (si el evento no entra, la sesión
 *     sigue abierta), no se puede cerrar dos veces, y pide superar en rango sobre el nodo de la
 *     sesión salvo al superadmin;
 *   - la respuesta no trae hashes ni contraseñas.
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

/** Una auditoría cuyo evento de "sesión cerrada" no entra: para ver que el cierre se deshace con él. */
class AuditoriaQueFalla extends AuditService {
  override async emitWithin(trx: Transaction<DB>, event: AuditEvent): Promise<void> {
    if (event.eventType === 'auth.session.revoked_by_admin') {
      throw new Error('el evento no entró');
    }
    return super.emitWithin(trx, event);
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

d('ficha del usuario y cierre de una sesión, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const detail = new MemberDetailService(database, network, audit);

  let cons: string;
  let norte: string;
  let sub: string;
  let sur: string;
  let otra: string;

  let root: string;
  let adminCons: string;
  let adminNorte: string;
  let pareja: string;
  let adminSur: string;
  let ajeno: string;
  let ana: string;
  let beto: string;

  const slug = (label: string) => `mdet-${label}-${sfx}`;
  const email = (label: string) => `mdet-${label}-${sfx}@test.local`;
  /** Hashes que la ficha nunca puede devolver. */
  const secrets: string[] = [];

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
      `INSERT INTO users (email, password_hash, name, email_verified_at, last_login_at)
       VALUES ($1, 'hash-original', $2, now(), now() - interval '1 hour') RETURNING id`,
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

  /** Una sesión de `userId` en `tenantId`; las que no están vivas, cada una por su motivo. */
  async function session(
    userId: string,
    tenantId: string,
    state: 'live' | 'revoked' | 'expired' | 'idle' = 'live',
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, issued_at, expires_at, last_seen_at, revoked_at,
                             revoked_reason, ip, user_agent, mfa_verified_at)
       VALUES ($1, $2, now() - interval '3 hours',
               CASE WHEN $3 = 'expired' THEN now() - interval '1 minute'
                    ELSE now() + interval '8 hours' END,
               CASE WHEN $3 = 'idle' THEN now() - interval '2 hours' ELSE now() END,
               CASE WHEN $3 = 'revoked' THEN now() END,
               CASE WHEN $3 = 'revoked' THEN 'logout' END,
               '203.0.113.7', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', now())
       RETURNING id`,
      [userId, tenantId, state],
    );
    return rows[0]!.id;
  }

  async function invitation(
    tenantId: string,
    to: string,
    invitedBy: string,
    state: 'pending' | 'accepted' | 'revoked',
    ageDays = 0,
  ): Promise<string> {
    const hash = sha256(`inv-${randomBytes(8).toString('hex')}`);
    secrets.push(hash);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at,
                                     created_at, accepted_at, revoked_at)
       VALUES ($1, $2, 'vendedor', $3, $4, now() + interval '7 days',
               now() - make_interval(days => $5::int + 1),
               CASE WHEN $6 = 'accepted' THEN now() - make_interval(days => $5::int) END,
               CASE WHEN $6 = 'revoked' THEN now() END)
       RETURNING id`,
      [tenantId, to, hash, invitedBy, ageDays, state],
    );
    return rows[0]!.id;
  }

  async function sessionState(id: string) {
    const { rows } = await pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      'SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async function revokedEvents(sessionId: string) {
    const { rows } = await pool.query<{
      tenant_id: string | null;
      actor_user_id: string | null;
      aggregate_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT tenant_id, actor_user_id, aggregate_type, payload FROM domain_events
        WHERE event_type = 'auth.session.revoked_by_admin' AND aggregate_id = $1`,
      [sessionId],
    );
    return rows;
  }

  const sessionIds = (view: MemberDetail) => view.sessions.map((s) => s.id).sort();
  const tenantIds = (view: MemberDetail) => view.memberships.map((m) => m.tenantId).sort();

  let anaNorte: string;
  let anaSur: string;
  let anaCons: string;
  let betoSub: string;

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
    pareja = await user('pareja');
    await member(norte, pareja, 'tenant_admin');
    adminSur = await user('admin-sur');
    await member(sur, adminSur, 'tenant_admin');
    ajeno = await user('ajeno');
    await member(otra, ajeno, 'tenant_admin');

    // Ana vende en el consolidador, en Norte y en Sur (hermana de Norte); Beto, en la sub-agencia.
    ana = await user('ana');
    await member(cons, ana, 'vendedor');
    await member(norte, ana, 'vendedor');
    await member(sur, ana, 'vendedor');
    beto = await user('beto');
    await member(sub, beto, 'vendedor');

    anaNorte = await session(ana, norte);
    anaSur = await session(ana, sur);
    anaCons = await session(ana, cons);
    await session(ana, norte, 'revoked');
    await session(ana, norte, 'expired');
    await session(ana, norte, 'idle');
    betoSub = await session(beto, sub);

    // Seguridad de Ana: 2FA de hace 10 días, contraseña cambiada hace 5, bloqueada 10 minutos.
    await pool.query(
      `UPDATE users SET mfa_enabled_at = now() - interval '10 days',
                        password_changed_at = now() - interval '5 days',
                        failed_login_attempts = 4,
                        locked_until = now() + interval '10 minutes'
        WHERE id = $1`,
      [ana],
    );
    for (const used of [false, false, true]) {
      const hash = `codigo-${randomBytes(6).toString('hex')}`;
      secrets.push(hash);
      await pool.query(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash, used_at)
         VALUES ($1, $2, CASE WHEN $3 THEN now() END)`,
        [ana, hash, used],
      );
    }
    // Vale sólo el primero: revocado, vencido y anterior al cambio de contraseña no cuentan.
    for (const [created, expires, revoked] of [
      ["now() - interval '1 day'", "now() + interval '29 days'", false],
      ["now() - interval '1 day'", "now() + interval '29 days'", true],
      ["now() - interval '31 days'", "now() - interval '1 day'", false],
      ["now() - interval '6 days'", "now() + interval '24 days'", false],
    ] as const) {
      const hash = sha256(randomBytes(32).toString('hex'));
      secrets.push(hash);
      await pool.query(
        `INSERT INTO trusted_devices (user_id, token_hash, created_at, expires_at, revoked_at)
         VALUES ($1, $2, ${created}, ${expires}, CASE WHEN $3 THEN now() END)`,
        [ana, hash, revoked],
      );
    }

    // A Ana la invitaron a Norte (hace 2 días) y a Sur (ayer).
    await invitation(norte, email('ana'), adminNorte, 'accepted', 2);
    await invitation(sur, email('ana'), adminSur, 'accepted', 1);
    // Ana invitó: una pendiente en Norte, otra en Sur, una revocada y una aceptada.
    await invitation(norte, email('x1'), ana, 'pending');
    await invitation(sur, email('x2'), ana, 'pending');
    await invitation(norte, email('x3'), ana, 'revoked');
    await invitation(norte, email('x4'), ana, 'accepted');
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`mdet-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('qué ve cada uno', () => {
    it('un admin de nodo no ve sesiones ni nodos de un hermano o del padre', async () => {
      const view = await detail.detail(adminNorte, norte, ana);

      expect(sessionIds(view)).toEqual([anaNorte]);
      expect(tenantIds(view)).toEqual([norte]);
      expect(view.sessions[0]).toMatchObject({
        tenantId: norte,
        tenantName: 'Nodo norte',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
        mfaVerified: true,
        current: false,
      });
    });

    it('el admin del consolidador ve todo su subárbol; desde un nodo, las sesiones de ese nodo', async () => {
      const desdeCons = await detail.detail(adminCons, cons, ana);
      expect(sessionIds(desdeCons)).toEqual([anaNorte, anaSur, anaCons].sort());
      expect(tenantIds(desdeCons)).toEqual([cons, norte, sur].sort());

      const desdeNorte = await detail.detail(adminCons, norte, ana);
      expect(sessionIds(desdeNorte)).toEqual([anaNorte]);
      // Sus nodos son los que administra, no sólo los del nodo de la ruta.
      expect(tenantIds(desdeNorte)).toEqual([cons, norte, sur].sort());
    });

    it('las sesiones de una sub-agencia cuentan para el admin de su agencia', async () => {
      const view = await detail.detail(adminNorte, norte, beto);
      expect(sessionIds(view)).toEqual([betoSub]);
      expect(tenantIds(view)).toEqual([sub]);
    });

    it('fuera de su red: 403 si no administra el nodo, 404 si la persona no está en su subárbol', async () => {
      expect(await rejection(detail.detail(ajeno, norte, ana))).toBe('403/TENANT_NOT_MANAGED');
      expect(await rejection(detail.detail(ajeno, otra, ana))).toBe('404/MEMBER_NOT_FOUND');
      expect(await rejection(detail.detail(adminNorte, norte, adminSur))).toBe(
        '404/MEMBER_NOT_FOUND',
      );
    });

    it('el superadmin ve todos sus nodos y todas sus sesiones; un admin de red recibe 403', async () => {
      const view = await detail.platformDetail(root, ana);
      expect(sessionIds(view)).toEqual([anaNorte, anaSur, anaCons].sort());
      expect(tenantIds(view)).toEqual([cons, norte, sur].sort());

      expect(await rejection(detail.platformDetail(adminCons, ana))).toBe('403/SUPERADMIN_ONLY');
      expect(
        await rejection(detail.platformDetail(root, '00000000-0000-4000-8000-000000000000')),
      ).toBe('404/USER_NOT_FOUND');
    });

    it('uno mismo puede verse', async () => {
      const view = await detail.detail(adminNorte, norte, adminNorte);
      expect(view.user.id).toBe(adminNorte);
      expect(tenantIds(view)).toEqual([norte]);
    });
  });

  describe('seguridad, invitaciones y lo que nunca sale', () => {
    it('cuenta los códigos sin usar y sólo los equipos de confianza que valen', async () => {
      const view = await detail.detail(adminNorte, norte, ana);

      expect(view.security).toMatchObject({
        mfaEnabled: true,
        recoveryCodesLeft: 2,
        trustedDevices: 1,
        failedLoginAttempts: 4,
      });
      expect(view.security.lockedUntil).not.toBeNull();
      expect(view.security.mfaEnabledAt).not.toBeNull();
      expect(view.user).toMatchObject({
        email: email('ana'),
        name: 'Persona ana',
        status: 'active',
        emailVerified: true,
        passwordResetRequired: false,
      });
      expect(view.user.passwordChangedAt).not.toBeNull();
      expect(view.user.lastLoginAt).not.toBeNull();
    });

    it('quién lo invitó y lo que invitó, acotados al subárbol', async () => {
      const norteView = await detail.detail(adminNorte, norte, ana);
      expect(norteView.invitedBy?.email).toBe(email('admin-norte'));
      expect(norteView.invitationsSent.pending).toBe(1);
      expect(norteView.invitationsSent.items).toEqual([
        expect.objectContaining({ email: email('x1'), role: 'vendedor', tenantName: 'Nodo norte' }),
      ]);

      // Desde el consolidador, la invitación más reciente (Sur) y las pendientes de los dos nodos.
      const consView = await detail.detail(adminCons, cons, ana);
      expect(consView.invitedBy?.email).toBe(email('admin-sur'));
      expect(consView.invitationsSent.pending).toBe(2);
      expect(consView.invitationsSent.items.map((i) => i.email).sort()).toEqual(
        [email('x1'), email('x2')].sort(),
      );

      expect((await detail.detail(adminNorte, norte, beto)).invitedBy).toBeNull();
    });

    it('la ficha no trae la contraseña ni ningún hash', async () => {
      const json = JSON.stringify([
        await detail.detail(adminNorte, norte, ana),
        await detail.platformDetail(root, ana),
      ]);
      expect(json).not.toContain('hash-original');
      for (const secret of secrets) expect(json).not.toContain(secret);
    });
  });

  describe('las funciones de 0064', () => {
    it('sólo las ejecuta app_user, y son SECURITY DEFINER', async () => {
      const { rows } = await pool.query<Record<string, boolean>>(
        `SELECT has_function_privilege('public', 'admin_user_sessions(uuid, uuid)', 'EXECUTE') AS s_public,
                has_function_privilege('app_user', 'admin_user_sessions(uuid, uuid)', 'EXECUTE') AS s_app,
                has_function_privilege('public', 'admin_user_security(uuid)', 'EXECUTE') AS c_public,
                has_function_privilege('app_user', 'admin_user_security(uuid)', 'EXECUTE') AS c_app,
                bool_and(prosecdef) AS definer
           FROM pg_proc WHERE proname IN ('admin_user_sessions', 'admin_user_security')`,
      );
      expect(rows[0]).toEqual({
        s_public: false,
        s_app: true,
        c_public: false,
        c_app: true,
        definer: true,
      });
    });

    it('llamadas directo, no le responden a quien no podría verlo', async () => {
      const sessionsOf = (actor: string, rootId: string | null) =>
        database.withRequestContext({ userId: actor }, async (trx) => {
          const { rows } = await sql<{ id: string }>`
            SELECT id FROM admin_user_sessions(${ana}::uuid, ${rootId}::uuid)
          `.execute(trx);
          return rows.map((r) => r.id).sort();
        });
      const securityOf = (actor: string) =>
        database.withRequestContext({ userId: actor }, async (trx) => {
          const { rows } = await sql<{ recovery_codes_left: number }>`
            SELECT recovery_codes_left FROM admin_user_security(${ana}::uuid)
          `.execute(trx);
          return rows.length;
        });

      expect(await sessionsOf(adminNorte, sur)).toEqual([]);
      expect(await sessionsOf(adminNorte, null)).toEqual([]);
      expect(await sessionsOf(adminNorte, norte)).toEqual([anaNorte]);
      expect(await sessionsOf(root, null)).toEqual([anaNorte, anaSur, anaCons].sort());

      expect(await securityOf(ajeno)).toBe(0);
      expect(await securityOf(adminSur)).toBe(1);
      expect(await securityOf(ana)).toBe(1);
      expect(await securityOf(root)).toBe(1);
    });
  });

  describe('cerrar una sesión', () => {
    it('la cierra con su evento en la misma transacción, y no se puede cerrar dos veces', async () => {
      const id = await session(ana, norte);

      expect(await detail.revokeSession(adminNorte, norte, ana, id)).toEqual({ ok: true });

      expect(await sessionState(id)).toMatchObject({ revoked_reason: 'revoked_by_admin' });
      expect((await sessionState(id))?.revoked_at).not.toBeNull();
      expect(await revokedEvents(id)).toEqual([
        {
          tenant_id: norte,
          actor_user_id: adminNorte,
          aggregate_type: 'session',
          payload: { targetUserId: ana, sessionId: id, viaTenantId: norte },
        },
      ]);
      // Las demás siguen abiertas.
      expect((await sessionState(anaNorte))?.revoked_at).toBeNull();

      expect(await rejection(detail.revokeSession(adminNorte, norte, ana, id))).toBe(
        '404/SESSION_NOT_FOUND',
      );
      expect(await revokedEvents(id)).toHaveLength(1);
    });

    it('si el evento no entra, la sesión sigue abierta', async () => {
      const id = await session(ana, norte);
      const conFalla = new MemberDetailService(database, network, new AuditoriaQueFalla(database));

      await expect(conFalla.revokeSession(adminNorte, norte, ana, id)).rejects.toThrow(
        'el evento no entró',
      );

      expect((await sessionState(id))?.revoked_at).toBeNull();
      expect(await revokedEvents(id)).toEqual([]);
    });

    it('una sesión de un nodo hermano es 404 desde su nodo y 403 desde el hermano', async () => {
      expect(await rejection(detail.revokeSession(adminNorte, norte, ana, anaSur))).toBe(
        '404/SESSION_NOT_FOUND',
      );
      expect(await rejection(detail.revokeSession(adminNorte, sur, ana, anaSur))).toBe(
        '403/TENANT_NOT_MANAGED',
      );
      // Una sesión de otra persona, con el id de la ruta cambiado, tampoco.
      expect(await rejection(detail.revokeSession(adminNorte, norte, beto, anaNorte))).toBe(
        '404/SESSION_NOT_FOUND',
      );
      expect((await sessionState(anaSur))?.revoked_at).toBeNull();
    });

    it('pide superar en rango sobre el nodo de la sesión; el superadmin no', async () => {
      const deLaPareja = await session(pareja, norte);
      // El admin del consolidador operando en Norte: ahí es consolidator_admin, por el ancestro.
      const delConsolidador = await session(adminCons, norte);

      expect(await rejection(detail.revokeSession(adminNorte, norte, pareja, deLaPareja))).toBe(
        '403/ROLE_NOT_GRANTABLE',
      );
      expect(
        await rejection(detail.revokeSession(adminNorte, norte, adminCons, delConsolidador)),
      ).toBe('403/ROLE_NOT_GRANTABLE');
      expect((await sessionState(deLaPareja))?.revoked_at).toBeNull();

      expect(await detail.revokeSession(adminCons, norte, pareja, deLaPareja)).toEqual({
        ok: true,
      });
      expect(await detail.revokeSession(root, norte, adminCons, delConsolidador)).toEqual({
        ok: true,
      });
    });

    it('las propias, no: 403', async () => {
      const propia = await session(adminNorte, norte);
      expect(await rejection(detail.revokeSession(adminNorte, norte, adminNorte, propia))).toBe(
        '403/MEMBER_SELF_ACTION',
      );
      expect((await sessionState(propia))?.revoked_at).toBeNull();
    });
  });
});
