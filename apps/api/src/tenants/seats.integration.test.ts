import { createHash, randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { NetworkService } from '../network/network.service.js';
import type { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import { CreateTenantSchema } from './dto.js';
import { InvitationsService } from './invitations.service.js';
import { MemberSupportService } from './member-support.service.js';
import { SeatsService } from './seats.service.js';
import { TenantsService } from './tenants.service.js';

/**
 * Puestos simultáneos, Equipo y soporte a miembros contra Postgres (0055): lo que los dobles no
 * pueden probar. Que la vista acota las sesiones al subárbol pero cuenta el cupo entero, que
 * liberar un puesto revoca con `admin_released` y deja su evento, que no se desconecta a una
 * agencia hermana ni a uno mismo, que el PATCH del superadmin deja el antes y el después y aplica
 * la baja de inactividad a las sesiones abiertas (sin subirle nunca el tope a ninguna), que el alta
 * con puestos es sólo del superadmin, que mover un nodo cierra las sesiones que quedarían en el cupo
 * de la red vieja, y que restablecer el 2FA o cerrar sesiones exige administrar TODOS los nodos del
 * usuario.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Red: plataforma → consolidador (3 puestos, 15 min) → agencia (hereda) → sub-agencia; bajo el
 * mismo consolidador una agencia hermana (hereda) y otra con cupo propio; y otro consolidador sin
 * cupo (otra red). Se SALTA sin PGHOST.
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

const NO_EXISTE = '00000000-0000-4000-8000-000000000000';

d('puestos, Equipo y soporte a miembros, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const seats = new SeatsService(database, network, audit);
  const support = new MemberSupportService(database, network, audit);
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
  } as unknown as PasswordService;
  const invitations = new InvitationsService(
    database,
    password,
    { sendToTenant: vi.fn(() => Promise.resolve(true)) } as unknown as MailerService,
    audit,
  );
  const tenants = new TenantsService(database, network, invitations, audit, {
    invalidate: vi.fn(),
  } as unknown as ProviderEnablementStore);

  let platform: string;
  let cons: string;
  let agency: string;
  let sub: string;
  let sister: string;
  let own: string;
  let otherCons: string;

  let superadmin: string;
  let consAdmin: string;
  let agencyAdmin: string;
  let agencyPeer: string;
  let seller: string;
  let subSeller: string;
  let sisterSeller: string;
  let ownSeller: string;

  let sConsAdmin: string;
  let sAgencyAdmin: string;
  let sSeller: string;
  let sSub: string;
  let sSister: string;
  let sOwn: string;
  let sDead: string;
  let sRevoked: string;

  let seq = 0;
  const slug = (label: string) => `seatapi-${label}-${sfx}`;

  async function tenant(
    label: string,
    type: 'consolidator' | 'agency' | 'subagency',
    parent: string,
    config: { seats?: number; idle?: number } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type,
                            parent_tenant_id, concurrent_seats, idle_timeout_minutes)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4, $5, $6) RETURNING id`,
      [slug(label), `Nodo ${label}`, type, parent, config.seats ?? null, config.idle ?? null],
    );
    return rows[0]!.id;
  }

  async function user(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'hash-original') RETURNING id`,
      [`seatapi-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: string, status = 'active') {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  /** Una sesión como la dejaría `issueToken`, con la antigüedad que haga falta. */
  async function session(opts: {
    userId: string;
    tenantId: string;
    seat: string | null;
    idleSeconds?: number;
    lastSeenSecondsAgo?: number;
    revoked?: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, seat_tenant_id, idle_timeout_seconds, issued_at,
                             last_seen_at, expires_at, revoked_at, revoked_reason, ip, user_agent)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour',
               now() - make_interval(secs => $5), now() + interval '1 hour',
               CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN 'logout' END,
               $7::inet, $8)
       RETURNING id`,
      [
        opts.userId,
        opts.tenantId,
        opts.seat,
        opts.idleSeconds ?? 900,
        opts.lastSeenSecondsAgo ?? 5,
        opts.revoked ?? false,
        opts.ip ?? null,
        opts.userAgent ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async function sessionRow(id: string) {
    const { rows } = await pool.query<{
      revoked_at: Date | null;
      revoked_reason: string | null;
      idle_timeout_seconds: number;
    }>(`SELECT revoked_at, revoked_reason, idle_timeout_seconds FROM sessions WHERE id = $1`, [id]);
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

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    cons = await tenant('cons', 'consolidator', platform, { seats: 3, idle: 15 });
    agency = await tenant('agency', 'agency', cons);
    sub = await tenant('sub', 'subagency', agency);
    sister = await tenant('sister', 'agency', cons);
    own = await tenant('own', 'agency', cons, { seats: 2 });
    otherCons = await tenant('other', 'consolidator', platform);

    superadmin = await user('root');
    consAdmin = await user('cons-admin');
    agencyAdmin = await user('agency-admin');
    agencyPeer = await user('agency-peer');
    seller = await user('seller');
    subSeller = await user('sub-seller');
    sisterSeller = await user('sister-seller');
    ownSeller = await user('own-seller');

    await member(platform, superadmin, 'superadmin');
    await member(cons, consAdmin, 'consolidator_admin');
    await member(agency, agencyAdmin, 'tenant_admin');
    await member(agency, agencyPeer, 'tenant_admin');
    await member(agency, seller, 'vendedor');
    await member(sub, subSeller, 'vendedor');
    await member(sister, sisterSeller, 'vendedor');
    await member(own, ownSeller, 'vendedor');

    sConsAdmin = await session({ userId: consAdmin, tenantId: cons, seat: cons });
    sAgencyAdmin = await session({ userId: agencyAdmin, tenantId: agency, seat: cons });
    sSeller = await session({
      userId: seller,
      tenantId: agency,
      seat: cons,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
    });
    sSub = await session({ userId: subSeller, tenantId: sub, seat: cons });
    sSister = await session({ userId: sisterSeller, tenantId: sister, seat: cons });
    sOwn = await session({ userId: ownSeller, tenantId: own, seat: own });
    // Superó su inactividad sin que nadie la revocara: ya no ocupa puesto.
    sDead = await session({
      userId: seller,
      tenantId: agency,
      seat: cons,
      idleSeconds: 1800,
      lastSeenSecondsAgo: 31 * 60,
    });
    sRevoked = await session({ userId: subSeller, tenantId: sub, seat: cons, revoked: true });
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`seatapi-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`seatapi-%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('vista de puestos (GET /tenants/:id/seats)', () => {
    it('el admin del nodo del cupo ve a todos los que lo ocupan; los vencidos y cerrados no', async () => {
      const v = await seats.view(consAdmin, cons);

      expect(v).toMatchObject({
        poolTenantId: cons,
        poolTenantName: 'Nodo cons',
        inherited: false,
        limit: 3,
        idleTimeoutMinutes: 15,
        idleInherited: false,
        ownSeats: 3,
        ownIdleTimeoutMinutes: 15,
      });
      const ids = v.sessions.map((s) => s.sessionId);
      expect(ids).toEqual(
        expect.arrayContaining([sConsAdmin, sAgencyAdmin, sSeller, sSub, sSister]),
      );
      expect(ids).not.toContain(sOwn);
      expect(ids).not.toContain(sDead);
      expect(ids).not.toContain(sRevoked);
      expect(v.inUse).toBe(v.sessions.length);
      expect(v.sessions.find((s) => s.sessionId === sSeller)).toMatchObject({
        userId: seller,
        email: `seatapi-seller-${sfx}@test.local`,
        name: 'Usuario seller',
        tenantId: agency,
        tenantName: 'Nodo agency',
        ip: '203.0.113.7',
        device: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
      });
    });

    it('una agencia que hereda: el conteo es el del cupo entero; las sesiones, sólo las de su subárbol', async () => {
      const deCons = await seats.view(consAdmin, cons);
      const v = await seats.view(agencyAdmin, agency);

      expect(v).toMatchObject({
        poolTenantId: cons,
        poolTenantName: 'Nodo cons',
        inherited: true,
        limit: 3,
        inUse: deCons.inUse,
        idleTimeoutMinutes: 15,
        idleInherited: true,
        ownSeats: null,
        ownIdleTimeoutMinutes: null,
      });
      const ids = v.sessions.map((s) => s.sessionId);
      expect(ids).toEqual(expect.arrayContaining([sAgencyAdmin, sSeller, sSub]));
      expect(ids).not.toContain(sConsAdmin);
      expect(ids).not.toContain(sSister);
    });

    it('un nodo con cupo propio cuenta el suyo', async () => {
      const v = await seats.view(consAdmin, own);
      expect(v).toMatchObject({ poolTenantId: own, inherited: false, limit: 2, inUse: 1 });
      expect(v.sessions.map((s) => s.sessionId)).toEqual([sOwn]);
    });

    it('sin cupo en la cadena, sin límite y sin sesiones que mostrar', async () => {
      const { rows } = await pool.query<{ pool: string | null }>(
        'SELECT seat_pool_of($1::uuid) AS pool',
        [otherCons],
      );
      const v = await seats.view(superadmin, otherCons);
      expect(v.poolTenantId).toBe(rows[0]!.pool);
      // La raíz compartida no debería tener cupo; si otro test se lo puso, lo que sigue no aplica.
      if (rows[0]!.pool === null) {
        expect(v).toMatchObject({ limit: null, inUse: 0, sessions: [], inherited: false });
      }
    });

    it('quien no administra el nodo recibe 403', async () => {
      expect(await rejection(seats.view(agencyAdmin, cons))).toBe('403/TENANT_NOT_MANAGED');
      expect(await rejection(seats.view(agencyAdmin, sister))).toBe('403/TENANT_NOT_MANAGED');
      expect(await rejection(seats.view(seller, agency))).toBe('403/TENANT_NOT_MANAGED');
    });
  });

  describe('liberar un puesto (POST /tenants/:id/seats/sessions/:sessionId/release)', () => {
    it('el admin de la agencia desconecta a un vendedor de su sub-agencia: revocada, auditada, el puesto vuelve', async () => {
      const u = await user('release-me');
      await member(sub, u, 'vendedor');
      const s = await session({ userId: u, tenantId: sub, seat: cons });
      const before = await seats.view(agencyAdmin, agency);

      expect(await seats.release(agencyAdmin, agency, s)).toEqual({ ok: true });

      expect(await sessionRow(s)).toMatchObject({ revoked_reason: 'admin_released' });
      expect((await sessionRow(s)).revoked_at).not.toBeNull();
      const after = await seats.view(agencyAdmin, agency);
      expect(after.inUse).toBe(before.inUse - 1);
      expect(after.sessions.map((x) => x.sessionId)).not.toContain(s);
      expect(await events('auth.session.released_by_admin', s)).toEqual([
        {
          actor_user_id: agencyAdmin,
          tenant_id: sub,
          payload: { targetUserId: u, poolTenantId: cons, viaTenantId: agency },
        },
      ]);

      expect(await rejection(seats.release(agencyAdmin, agency, s))).toBe(
        '404/SEAT_SESSION_NOT_FOUND',
      );
    });

    it('no desconecta a una hermana aunque compartan el cupo, ni a otro cupo', async () => {
      expect(await rejection(seats.release(agencyAdmin, agency, sSister))).toBe(
        '404/SEAT_SESSION_NOT_FOUND',
      );
      expect(await rejection(seats.release(consAdmin, cons, sOwn))).toBe(
        '404/SEAT_SESSION_NOT_FOUND',
      );
      expect((await sessionRow(sSister)).revoked_at).toBeNull();
      expect((await sessionRow(sOwn)).revoked_at).toBeNull();
    });

    it('lo que ya no ocupa puesto (inactiva, cerrada o inexistente) es 404', async () => {
      expect(await rejection(seats.release(consAdmin, cons, sDead))).toBe(
        '404/SEAT_SESSION_NOT_FOUND',
      );
      expect(await rejection(seats.release(consAdmin, cons, sRevoked))).toBe(
        '404/SEAT_SESSION_NOT_FOUND',
      );
      expect(await rejection(seats.release(consAdmin, cons, NO_EXISTE))).toBe(
        '404/SEAT_SESSION_NOT_FOUND',
      );
      expect((await sessionRow(sDead)).revoked_at).toBeNull();
    });

    it('no se libera el propio puesto', async () => {
      expect(await rejection(seats.release(agencyAdmin, agency, sAgencyAdmin))).toBe(
        '403/SEAT_RELEASE_SELF',
      );
      expect((await sessionRow(sAgencyAdmin)).revoked_at).toBeNull();
    });

    it('fuera de la red: 403 antes de mirar la sesión', async () => {
      expect(await rejection(seats.release(agencyAdmin, sister, sSister))).toBe(
        '403/TENANT_NOT_MANAGED',
      );
      expect((await sessionRow(sSister)).revoked_at).toBeNull();
    });
  });

  describe('puestos e inactividad del superadmin (PATCH /admin/tenants/:id/seats)', () => {
    it('un cupo propio deja de compartir el del consolidador; las sesiones abiertas conservan el suyo', async () => {
      const a = await tenant('patch-a', 'agency', cons);
      const u = await user('patch-a-seller');
      await member(a, u, 'vendedor');
      const s = await session({ userId: u, tenantId: a, seat: cons });

      const v = await seats.updatePolicy(superadmin, a, { concurrentSeats: 4 });

      expect(v).toMatchObject({
        poolTenantId: a,
        inherited: false,
        limit: 4,
        ownSeats: 4,
        inUse: 0,
        sessions: [],
      });
      expect((await seats.view(consAdmin, cons)).sessions.map((x) => x.sessionId)).toContain(s);
      expect(await events('tenant.seats.updated', a)).toEqual([
        {
          actor_user_id: superadmin,
          tenant_id: a,
          payload: {
            changed: ['concurrentSeats'],
            before: { concurrentSeats: null },
            after: { concurrentSeats: 4 },
            effectiveIdleTimeoutMinutes: { before: 15, after: 15 },
            sessionsRefreshed: 0,
          },
        },
      ]);

      const heredado = await seats.updatePolicy(superadmin, a, { concurrentSeats: null });
      expect(heredado).toMatchObject({ poolTenantId: cons, inherited: true, ownSeats: null });
    });

    it('bajar la inactividad alcanza a las sesiones abiertas (salvo override más profundo); subirla, sólo a las nuevas', async () => {
      const b = await tenant('patch-b', 'agency', cons);
      const bs = await tenant('patch-bs', 'subagency', b, { idle: 45 });
      const u1 = await user('patch-b-1');
      const u2 = await user('patch-b-2');
      await member(b, u1, 'vendedor');
      await member(bs, u2, 'vendedor');
      const s1 = await session({ userId: u1, tenantId: b, seat: cons, idleSeconds: 900 });
      const s2 = await session({ userId: u2, tenantId: bs, seat: cons, idleSeconds: 2700 });

      const bajada = await seats.updatePolicy(superadmin, b, { idleTimeoutMinutes: 10 });
      expect(bajada).toMatchObject({
        idleTimeoutMinutes: 10,
        idleInherited: false,
        ownIdleTimeoutMinutes: 10,
      });
      expect((await sessionRow(s1)).idle_timeout_seconds).toBe(600);
      expect((await sessionRow(s2)).idle_timeout_seconds).toBe(2700);

      await seats.updatePolicy(superadmin, b, { idleTimeoutMinutes: 60 });
      expect((await sessionRow(s1)).idle_timeout_seconds).toBe(600);

      const log = await events('tenant.seats.updated', b);
      expect(log.map((e) => e.payload)).toEqual([
        {
          changed: ['idleTimeoutMinutes'],
          before: { idleTimeoutMinutes: null },
          after: { idleTimeoutMinutes: 10 },
          effectiveIdleTimeoutMinutes: { before: 15, after: 10 },
          sessionsRefreshed: 1,
        },
        {
          changed: ['idleTimeoutMinutes'],
          before: { idleTimeoutMinutes: 10 },
          after: { idleTimeoutMinutes: 60 },
          effectiveIdleTimeoutMinutes: { before: 10, after: 60 },
          sessionsRefreshed: 0,
        },
      ]);
    });

    it('bajar la inactividad nunca le SUBE el tope a una sesión abierta', async () => {
      const f = await tenant('patch-f', 'agency', cons);
      const fs = await tenant('patch-fs', 'subagency', f);
      const u1 = await user('patch-f-1');
      const u2 = await user('patch-f-2');
      await member(f, u1, 'vendedor');
      await member(fs, u2, 'vendedor');

      // Entró cuando regían los 15 del consolidador; después su sub-agencia pasó a 45 (una subida:
      // rige para las sesiones nuevas, ésta conserva sus 15).
      const sDeep = await session({ userId: u2, tenantId: fs, seat: cons, idleSeconds: 900 });
      await seats.updatePolicy(superadmin, fs, { idleTimeoutMinutes: 45 });
      expect((await sessionRow(sDeep)).idle_timeout_seconds).toBe(900);

      // Entró con 15; el nodo sube a 60 (sólo las nuevas) y después baja a 30.
      const sOwn = await session({ userId: u1, tenantId: f, seat: cons, idleSeconds: 900 });
      await seats.updatePolicy(superadmin, f, { idleTimeoutMinutes: 60 });
      await seats.updatePolicy(superadmin, f, { idleTimeoutMinutes: 30 });

      // Una bajada no le da 30 (ni los 45 de su sub-agencia) a quien tenía 15.
      expect((await sessionRow(sOwn)).idle_timeout_seconds).toBe(900);
      expect((await sessionRow(sDeep)).idle_timeout_seconds).toBe(900);
      expect((await events('tenant.seats.updated', f)).at(-1)!.payload).toMatchObject({
        effectiveIdleTimeoutMinutes: { before: 60, after: 30 },
        sessionsRefreshed: 0,
      });

      // Una bajada por debajo de su tope sí la alcanza; el override más profundo sigue mandando.
      await seats.updatePolicy(superadmin, f, { idleTimeoutMinutes: 10 });
      expect((await sessionRow(sOwn)).idle_timeout_seconds).toBe(600);
      expect((await sessionRow(sDeep)).idle_timeout_seconds).toBe(900);
      expect((await events('tenant.seats.updated', f)).at(-1)!.payload).toMatchObject({
        effectiveIdleTimeoutMinutes: { before: 30, after: 10 },
        sessionsRefreshed: 1,
      });
    });

    it('mientras dura el PATCH, un ingreso del mismo cupo inserta su sesión sin esperarlo', async () => {
      const g = await tenant('patch-g', 'agency', cons, { seats: 3 });
      const u = await user('patch-g-seller');
      await member(g, u, 'vendedor');

      // El evento se emite dentro de la transacción del PATCH, con el nodo ya bloqueado y
      // actualizado: ahí entra un login concurrente (otra conexión) cuya sesión tiene FK hacia el
      // nodo. Con FOR UPDATE esa FK esperaría al PATCH y el lock_timeout la haría fallar (55P03).
      let inserted: string | undefined;
      const concurrentLogin = {
        emitWithin: async (trx: Transaction<DB>, event: Parameters<AuditService['emit']>[0]) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL lock_timeout = '1s'`);
            const { rows } = await client.query<{ id: string }>(
              `INSERT INTO sessions (user_id, tenant_id, seat_tenant_id, idle_timeout_seconds, expires_at)
               VALUES ($1, $2, $2, 900, now() + interval '1 hour') RETURNING id`,
              [u, g],
            );
            await client.query('COMMIT');
            inserted = rows[0]!.id;
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
          return audit.emitWithin(trx, event);
        },
      } as unknown as AuditService;
      const patching = new SeatsService(database, network, concurrentLogin);

      const v = await patching.updatePolicy(superadmin, g, { idleTimeoutMinutes: 10 });

      expect(v).toMatchObject({ ownIdleTimeoutMinutes: 10 });
      expect(inserted).toBeDefined();
      expect((await sessionRow(inserted!)).revoked_at).toBeNull();
    });

    it('sin cambios no hay evento; un nodo que no existe es 404', async () => {
      const c = await tenant('patch-c', 'agency', cons, { seats: 5 });
      await seats.updatePolicy(superadmin, c, { concurrentSeats: 5 });
      expect(await events('tenant.seats.updated', c)).toEqual([]);
      expect(
        await rejection(seats.updatePolicy(superadmin, NO_EXISTE, { concurrentSeats: 2 })),
      ).toBe('404/TENANT_NOT_FOUND');
    });

    it('la base sigue siendo la última palabra sobre el rango', async () => {
      const e = await tenant('patch-e', 'agency', cons);
      // Sin pasar por Zod: el CHECK de 0055 lo rechaza igual.
      await expect(seats.updatePolicy(superadmin, e, { concurrentSeats: 0 })).rejects.toMatchObject(
        { code: '23514' },
      );
      const { rows } = await pool.query<{ concurrent_seats: number | null }>(
        'SELECT concurrent_seats FROM tenants WHERE id = $1',
        [e],
      );
      expect(rows[0]!.concurrent_seats).toBeNull();
    });
  });

  describe('mover un nodo con sesiones abiertas (POST /admin/tenants/:id/move)', () => {
    it('las que ocupan el cupo de la red vieja se cierran y lo liberan; las de un cupo propio del subárbol, no', async () => {
      const c1 = await tenant('mv-c1', 'consolidator', platform, { seats: 5 });
      const c2 = await tenant('mv-c2', 'consolidator', platform, { seats: 5 });
      const a = await tenant('mv-a', 'agency', c1);
      const aSub = await tenant('mv-as', 'subagency', a, { seats: 2 });
      const stay = await tenant('mv-stay', 'agency', c1);
      const c1Admin = await user('mv-c1-admin');
      const c2Admin = await user('mv-c2-admin');
      const ua = await user('mv-a-seller');
      const uaSub = await user('mv-as-seller');
      const ustay = await user('mv-stay-seller');
      await member(c1, c1Admin, 'consolidator_admin');
      await member(c2, c2Admin, 'consolidator_admin');
      await member(a, ua, 'vendedor');
      await member(aSub, uaSub, 'vendedor');
      await member(stay, ustay, 'vendedor');
      const sA = await session({ userId: ua, tenantId: a, seat: c1 });
      const sASub = await session({ userId: uaSub, tenantId: aSub, seat: aSub });
      const sStay = await session({ userId: ustay, tenantId: stay, seat: c1 });
      expect((await seats.view(c1Admin, c1)).inUse).toBe(2);

      expect((await tenants.move(superadmin, a, c2)).moved).toBe(2);

      expect(await sessionRow(sA)).toMatchObject({ revoked_reason: 'tenant_moved' });
      expect((await sessionRow(sA)).revoked_at).not.toBeNull();
      expect((await sessionRow(sASub)).revoked_at).toBeNull();
      expect((await sessionRow(sStay)).revoked_at).toBeNull();

      // C1 recupera el puesto y su admin sólo ve a los suyos; C2 no hereda sesiones de otra red.
      const deC1 = await seats.view(c1Admin, c1);
      expect(deC1).toMatchObject({ poolTenantId: c1, inUse: 1 });
      expect(deC1.sessions.map((x) => x.sessionId)).toEqual([sStay]);
      expect(await rejection(seats.release(c1Admin, c1, sA))).toBe('404/SEAT_SESSION_NOT_FOUND');
      expect((await seats.view(c2Admin, a)).poolTenantId).toBe(c2);
      expect((await seats.view(c2Admin, aSub)).sessions.map((x) => x.sessionId)).toEqual([sASub]);

      expect(await events('auth.sessions.revoked_by_tenant_move', a)).toEqual([
        {
          actor_user_id: superadmin,
          tenant_id: a,
          payload: {
            toParentId: c2,
            sessions: [{ sessionId: sA, userId: ua, tenantId: a, poolTenantId: c1 }],
          },
        },
      ]);
      expect(await events('tenant.moved', a)).toHaveLength(1);
    });

    it('dentro de la misma red el cupo sigue por encima: no se cierra nada', async () => {
      const c = await tenant('mv-net', 'consolidator', platform, { seats: 5 });
      const a1 = await tenant('mv-net-a1', 'agency', c);
      const a2 = await tenant('mv-net-a2', 'agency', c);
      const sa = await tenant('mv-net-s', 'subagency', a1);
      const u = await user('mv-net-seller');
      await member(sa, u, 'vendedor');
      const s = await session({ userId: u, tenantId: sa, seat: c });

      expect((await tenants.move(superadmin, sa, a2)).moved).toBe(1);

      expect((await sessionRow(s)).revoked_at).toBeNull();
      expect(await events('auth.sessions.revoked_by_tenant_move', sa)).toEqual([]);
    });

    it('si la base rechaza el movimiento, ninguna sesión queda cerrada', async () => {
      const c1 = await tenant('mv-rb-c1', 'consolidator', platform, { seats: 5 });
      const a = await tenant('mv-rb-a', 'agency', c1);
      const otherAgency = await tenant('mv-rb-other', 'agency', platform);
      const u = await user('mv-rb-seller');
      await member(a, u, 'vendedor');
      const s = await session({ userId: u, tenantId: a, seat: c1 });

      // Una agencia no cuelga de otra agencia (D4): la base lo rechaza después de revocar.
      expect(await rejection(tenants.move(superadmin, a, otherAgency))).toBe(
        '409/TENANT_PARENT_TYPE',
      );

      expect((await sessionRow(s)).revoked_at).toBeNull();
      expect(await events('auth.sessions.revoked_by_tenant_move', a)).toEqual([]);
    });
  });

  describe('alta de un nodo con puestos (POST /admin/tenants)', () => {
    function alta(label: string, extra: Record<string, unknown> = {}) {
      seq += 1;
      return CreateTenantSchema.parse({
        name: `Nodo ${label}`,
        slug: slug(`${label}-${seq}`),
        countryCode: 'CO',
        defaultCurrency: 'COP',
        ...extra,
      });
    }

    it('el superadmin los fija al crear y quedan en el evento', async () => {
      const { tenant: created } = await tenants.create(
        superadmin,
        alta('con-puestos', {
          tenantType: 'consolidator',
          concurrentSeats: 5,
          idleTimeoutMinutes: 20,
        }),
      );

      const { rows } = await pool.query<{ concurrent_seats: number; idle_timeout_minutes: number }>(
        'SELECT concurrent_seats, idle_timeout_minutes FROM tenants WHERE id = $1',
        [created.id],
      );
      expect(rows[0]).toEqual({ concurrent_seats: 5, idle_timeout_minutes: 20 });
      expect((await events('TenantCreated', created.id))[0]!.payload).toMatchObject({
        concurrentSeats: 5,
        idleTimeoutMinutes: 20,
      });
    });

    it('un admin de red que los manda recibe 403 y no se crea nada', async () => {
      const body = alta('sin-permiso', { parentTenantId: cons, concurrentSeats: 50 });
      expect(await rejection(tenants.create(consAdmin, body))).toBe(
        '403/TENANT_SEATS_SUPERADMIN_ONLY',
      );
      const { rows } = await pool.query('SELECT 1 FROM tenants WHERE slug = $1', [body.slug]);
      expect(rows).toHaveLength(0);

      const sinPuestos = await tenants.create(consAdmin, alta('ok', { parentTenantId: cons }));
      expect(sinPuestos.tenant.parentTenantId).toBe(cons);
    });
  });

  describe('Equipo: último ingreso, 2FA, bloqueo y sesiones (GET /tenants/network/users)', () => {
    it('suma lo que hace falta para dar soporte, de cada miembro del nodo', async () => {
      const u = await user('team');
      const locked = await user('team-locked-before');
      await member(agency, u, 'vendedor');
      await member(agency, locked, 'vendedor');
      await pool.query(
        `UPDATE users SET last_login_at = '2026-09-01T12:00:00Z', mfa_secret = 'cifrado',
                          mfa_enabled_at = now(), locked_until = now() + interval '1 hour'
          WHERE id = $1`,
        [u],
      );
      await pool.query(`UPDATE users SET locked_until = now() - interval '1 hour' WHERE id = $1`, [
        locked,
      ]);
      await session({ userId: u, tenantId: agency, seat: cons });
      await session({ userId: u, tenantId: agency, seat: cons, revoked: true });

      const users = await network.listTenantUsers(agencyAdmin, agency);
      const fila = users.find((x) => x.userId === u);
      expect(fila).toMatchObject({
        role: 'vendedor',
        lastLoginAt: new Date('2026-09-01T12:00:00Z'),
        mfaEnabled: true,
        activeSessions: 1,
      });
      expect(fila!.lockedUntil).toBeInstanceOf(Date);
      expect(users.find((x) => x.userId === locked)).toMatchObject({
        lastLoginAt: null,
        mfaEnabled: false,
        lockedUntil: null,
        activeSessions: 0,
      });
      // Sólo miembros del nodo, como antes.
      expect(users.map((x) => x.userId)).not.toContain(subSeller);
    });
  });

  describe('soporte a un miembro (reset-mfa y revoke-sessions)', () => {
    it('restablecer el 2FA: sin factor, sin códigos, sin equipos de confianza, sin sesiones; auditado', async () => {
      const u = await user('mfa-reset');
      await member(agency, u, 'vendedor');
      await pool.query(
        `UPDATE users SET mfa_secret = 'cifrado', mfa_pending_secret = 'otro', mfa_enabled_at = now(),
                          mfa_last_used_step = 1 WHERE id = $1`,
        [u],
      );
      await pool.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, 'h')`, [u]);
      const tokenHash = createHash('sha256').update(`token-${sfx}`).digest('hex');
      await pool.query(
        `INSERT INTO trusted_devices (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [u, tokenHash],
      );
      const s = await session({ userId: u, tenantId: agency, seat: cons });

      expect(await support.resetMfa(agencyAdmin, agency, u)).toEqual({ ok: true });

      const { rows: usr } = await pool.query(
        `SELECT mfa_secret, mfa_pending_secret, mfa_enabled_at, mfa_last_used_step
           FROM users WHERE id = $1`,
        [u],
      );
      expect(usr[0]).toEqual({
        mfa_secret: null,
        mfa_pending_secret: null,
        mfa_enabled_at: null,
        mfa_last_used_step: null,
      });
      const { rows: codes } = await pool.query(
        'SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1',
        [u],
      );
      expect(codes).toHaveLength(0);
      const { rows: devices } = await pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM trusted_devices WHERE user_id = $1',
        [u],
      );
      expect(devices[0]!.revoked_at).not.toBeNull();
      expect(await sessionRow(s)).toMatchObject({ revoked_reason: 'mfa_reset' });
      expect(await events('auth.mfa.reset_by_admin', u)).toEqual([
        {
          actor_user_id: agencyAdmin,
          tenant_id: agency,
          payload: { targetUserId: u, hadMfa: true },
        },
      ]);
    });

    it('si también trabaja en otra red, sólo el superadmin', async () => {
      const u = await user('cross');
      await member(agency, u, 'vendedor');
      await member(otherCons, u, 'vendedor');

      expect(await rejection(support.resetMfa(agencyAdmin, agency, u))).toBe(
        '403/MEMBER_OUTSIDE_NETWORK',
      );
      expect(await rejection(support.revokeSessions(consAdmin, agency, u))).toBe(
        '403/MEMBER_OUTSIDE_NETWORK',
      );
      expect(await events('auth.mfa.reset_by_admin', u)).toEqual([]);

      expect(await support.resetMfa(superadmin, agency, u)).toEqual({ ok: true });
    });

    it('una membership suspendida en otra red no cuenta', async () => {
      const u = await user('cross-suspended');
      await member(agency, u, 'vendedor');
      await member(otherCons, u, 'vendedor', 'suspended');

      expect(await support.revokeSessions(agencyAdmin, agency, u)).toEqual({ revoked: 0 });
    });

    it('a un par del mismo rango no; su superior sí', async () => {
      expect(await rejection(support.resetMfa(agencyAdmin, agency, agencyPeer))).toBe(
        '403/ROLE_NOT_GRANTABLE',
      );
      expect(await support.revokeSessions(consAdmin, agency, agencyPeer)).toEqual({ revoked: 0 });
    });

    it('nunca sobre uno mismo; quien no es miembro del nodo es 404; fuera de la red, 403', async () => {
      expect(await rejection(support.resetMfa(agencyAdmin, agency, agencyAdmin))).toBe(
        '403/MEMBER_SELF_ACTION',
      );
      expect(await rejection(support.resetMfa(agencyAdmin, agency, sisterSeller))).toBe(
        '404/MEMBER_NOT_FOUND',
      );
      expect(await rejection(support.resetMfa(agencyAdmin, sister, sisterSeller))).toBe(
        '403/TENANT_NOT_MANAGED',
      );
    });

    it('cerrar sus sesiones: todas, con motivo, sin tocar la membership; auditado', async () => {
      const u = await user('revoke');
      await member(agency, u, 'vendedor');
      const s1 = await session({ userId: u, tenantId: agency, seat: cons });
      const s2 = await session({ userId: u, tenantId: agency, seat: null });

      expect(await support.revokeSessions(agencyAdmin, agency, u)).toEqual({ revoked: 2 });

      expect(await sessionRow(s1)).toMatchObject({ revoked_reason: 'revoked_by_admin' });
      expect(await sessionRow(s2)).toMatchObject({ revoked_reason: 'revoked_by_admin' });
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM memberships WHERE user_id = $1 AND tenant_id = $2',
        [u, agency],
      );
      expect(rows[0]!.status).toBe('active');
      expect(await events('auth.sessions.revoked_by_admin', u)).toEqual([
        { actor_user_id: agencyAdmin, tenant_id: agency, payload: { targetUserId: u, revoked: 2 } },
      ]);
    });
  });
});
