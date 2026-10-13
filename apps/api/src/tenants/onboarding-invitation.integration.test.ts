import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { NetworkService } from '../network/network.service.js';
import type { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import { CreateTenantSchema } from './dto.js';
import { InvitationsService } from './invitations.service.js';
import { TenantsService } from './tenants.service.js';

/**
 * Alta sólo por invitación contra Postgres (docs/platform/14, auditoría del 2026-09-29).
 *
 * Lo que cerraba la brecha y el doble no puede probar: que el alta de un nodo no crea cuentas ni
 * memberships (sólo una invitación pendiente), que un email de otra red recibe la misma respuesta que
 * uno nuevo, que aceptar vincula sin tocar la contraseña de quien ya tenía cuenta y que reenviar deja
 * sin valor el enlace anterior. Que suspender a alguien en una red no lo desloguee de otra lo prueba
 * membership-revocation.integration.test.ts (0056).
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Cuelga todo de la raíz `platform` compartida. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

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

type HttpRejection = HttpException & { reason?: string; publicDetails?: unknown };

/** El error HTTP con que termina `p` (motivo y detalles incluidos). */
async function rejected(p: Promise<unknown>): Promise<HttpRejection> {
  try {
    await p;
  } catch (err) {
    if (typeof (err as HttpException).getStatus !== 'function') throw err;
    return err as HttpRejection;
  }
  throw new Error('esperaba un error HTTP');
}

d('alta sólo por invitación, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
  } as unknown as PasswordService;
  const mailer = {
    sendToTenant: vi.fn((_tenantId: string, _msg: { to: string; text: string }) =>
      Promise.resolve(true),
    ),
  };
  const enablement = { invalidate: vi.fn() };

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const invitations = new InvitationsService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
  );
  const tenants = new TenantsService(
    database,
    network,
    invitations,
    audit,
    enablement as unknown as ProviderEnablementStore,
  );

  let consA: string;
  let consB: string;
  let agencyB: string;
  let subB: string;
  let consAdminA: string;
  let consAdminB: string;
  let agencyAdminB: string;
  let plainAdminB: string;
  let seq = 0;

  const slug = (label: string) => `oi-${label}-${sfx}`;
  const email = (label: string) => `oi-${label}-${sfx}@test.local`;

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
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'hash-original') RETURNING id`,
      [email(label), `Nombre ${label}`],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: string) {
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [
      tenantId,
      userId,
      role,
    ]);
  }

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

  /** El token en claro del último correo a `to`: sólo viaja en el enlace. */
  function lastToken(to: string): string {
    const call = mailer.sendToTenant.mock.calls.filter(([, msg]) => msg.to === to).at(-1);
    const match = call?.[1].text.match(/token=([^\s&]+)/);
    if (!match?.[1]) throw new Error(`no salió ningún correo con enlace a ${to}`);
    return decodeURIComponent(match[1]);
  }

  async function userRow(address: string) {
    const { rows } = await pool.query<{ id: string; name: string | null; password_hash: string }>(
      'SELECT id, name, password_hash FROM users WHERE email = $1',
      [address],
    );
    return rows[0];
  }

  async function membershipsOf(tenantId: string, address: string) {
    const { rows } = await pool.query<{ role: string }>(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email = $2`,
      [tenantId, address],
    );
    return rows;
  }

  async function pendingInvitations(tenantId: string, address: string) {
    const { rows } = await pool.query<{ id: string; role: string; expires_at: Date }>(
      `SELECT id, role, expires_at FROM user_invitations
        WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [tenantId, address],
    );
    return rows;
  }

  beforeAll(async () => {
    database.onModuleInit();
    const platform = await platformRootId(pool);
    consA = await tenant('cons-a', 'consolidator', platform);
    consB = await tenant('cons-b', 'consolidator', platform);
    agencyB = await tenant('agency-b', 'agency', consB);
    subB = await tenant('sub-b', 'subagency', agencyB);

    consAdminA = await user('cons-admin-a');
    consAdminB = await user('cons-admin-b');
    agencyAdminB = await user('agency-admin-b');
    plainAdminB = await user('plain-admin-b');
    await member(consA, consAdminA, 'consolidator_admin');
    await member(consB, consAdminB, 'consolidator_admin');
    await member(agencyB, agencyAdminB, 'tenant_admin');
    await member(agencyB, plainAdminB, 'admin');
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`oi-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('alta de un nodo', () => {
    /** Lo único que devuelve sobre el admin, tenga o no cuenta: nada de la identidad existente. */
    const RESPONSE_KEYS = ['email', 'expiresAt', 'invitationId', 'role', 'status'];

    it('con un email nuevo: no crea la cuenta ni la membership, deja la invitación y manda el correo', async () => {
      const nuevo = email('nuevo-admin');

      const res = await tenants.create(
        consAdminB,
        alta('con-nuevo', { parentTenantId: consB, adminEmail: nuevo }),
      );

      expect(res.admin).toMatchObject({ email: nuevo, role: 'tenant_admin', status: 'invited' });
      expect(Object.keys(res.admin!).sort()).toEqual(RESPONSE_KEYS);
      expect(await userRow(nuevo)).toBeUndefined();
      expect(await membershipsOf(res.tenant.id, nuevo)).toEqual([]);
      const pending = await pendingInvitations(res.tenant.id, nuevo);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.role).toBe('tenant_admin');
      expect(mailer.sendToTenant).toHaveBeenCalledWith(
        res.tenant.id,
        expect.objectContaining({ to: nuevo }),
      );
    });

    it('con el email del admin de OTRA red: la misma respuesta, sin vincularlo ni tocar su cuenta', async () => {
      const ajeno = email('cons-admin-a');
      const antes = await userRow(ajeno);

      const res = await tenants.create(
        consAdminB,
        alta('con-ajeno', { parentTenantId: consB, adminEmail: ajeno }),
      );

      // Nada distingue un email conocido de uno nuevo: ni id, ni nombre, ni estado de la cuenta.
      expect(res.admin).toMatchObject({ email: ajeno, role: 'tenant_admin', status: 'invited' });
      expect(Object.keys(res.admin!).sort()).toEqual(RESPONSE_KEYS);
      expect(await membershipsOf(res.tenant.id, ajeno)).toEqual([]);
      expect(await pendingInvitations(res.tenant.id, ajeno)).toHaveLength(1);
      expect(await userRow(ajeno)).toEqual(antes);

      const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM domain_events WHERE event_type = 'TenantCreated' AND aggregate_id = $1`,
        [res.tenant.id],
      );
      expect(rows[0]!.payload).toMatchObject({ adminRole: 'tenant_admin', admin: 'invited' });
    });

    it('si el correo no sale: el nodo y la invitación quedan, y la respuesta lo dice', async () => {
      mailer.sendToTenant.mockResolvedValueOnce(false);
      const to = email('sin-correo');

      const res = await tenants.create(
        consAdminB,
        alta('sin-correo', { parentTenantId: consB, adminEmail: to }),
      );

      expect(res.admin).toMatchObject({
        email: to,
        role: 'tenant_admin',
        status: 'invited_email_failed',
      });
      expect(Object.keys(res.admin!).sort()).toEqual(RESPONSE_KEYS);
      const pending = await pendingInvitations(res.tenant.id, to);
      expect(pending).toHaveLength(1);
      expect(res.admin).toMatchObject({ invitationId: pending[0]!.id });
      // El fallo queda auditado con el id de la invitación, sin la dirección.
      const { rows } = await pool.query<{ payload: unknown }>(
        `SELECT payload FROM domain_events
          WHERE event_type = 'UserInvitationEmailFailed' AND aggregate_id = $1`,
        [pending[0]!.id],
      );
      expect(rows).toEqual([{ payload: { invitationId: pending[0]!.id, via: 'invite' } }]);
    });

    it('aceptar vincula a quien ya tenía cuenta sin cambiarle la contraseña ni el nombre', async () => {
      const ajeno = email('cons-admin-a');
      const res = await tenants.create(
        consAdminB,
        alta('acepta', { parentTenantId: consB, adminEmail: ajeno }),
      );

      const accepted = await invitations.accept({
        token: lastToken(ajeno),
        name: 'Otro nombre',
        password: 'una-clave-que-no-debe-usarse',
      });

      expect(accepted).toEqual({ userId: consAdminA, tenantId: res.tenant.id });
      expect(await membershipsOf(res.tenant.id, ajeno)).toEqual([{ role: 'tenant_admin' }]);
      expect(await userRow(ajeno)).toMatchObject({
        name: 'Nombre cons-admin-a',
        password_hash: 'hash-original',
      });
    });
  });

  describe('invitar directo: la respuesta no delata si el email existe', () => {
    it('mismas claves para un email de otra red y uno nuevo', async () => {
      const ajeno = await invitations.invite({
        actorUserId: agencyAdminB,
        tenantId: subB,
        email: email('cons-admin-a'),
        role: 'vendedor',
      });
      const nuevo = await invitations.invite({
        actorUserId: agencyAdminB,
        tenantId: subB,
        email: email('nadie'),
        role: 'vendedor',
      });

      expect(Object.keys(ajeno).sort()).toEqual(Object.keys(nuevo).sort());
      expect(Object.keys(nuevo).sort()).toEqual(['emailSent', 'expiresAt', 'id']);
      expect(await membershipsOf(subB, email('cons-admin-a'))).toEqual([]);
    });
  });

  describe('reenviar', () => {
    it('rota el enlace: el anterior deja de valer, el nuevo vale 7 días y queda auditado', async () => {
      const to = email('reenvio');
      // La emite el consolidador y la reenvía el admin de la agencia.
      const { id } = await invitations.invite({
        actorUserId: consAdminB,
        tenantId: agencyB,
        email: to,
        role: 'vendedor',
      });
      const viejo = lastToken(to);
      await pool.query(
        `UPDATE user_invitations SET expires_at = now() + interval '1 day' WHERE id = $1`,
        [id],
      );

      const res = await invitations.resend({
        actorUserId: agencyAdminB,
        actorRole: 'tenant_admin',
        tenantId: agencyB,
        invitationId: id,
      });
      const nuevo = lastToken(to);

      expect(nuevo).not.toBe(viejo);
      expect(res.id).toBe(id);
      // Quien reenvía la respalda desde ahora (lo revalida el canje); el anterior queda en el evento.
      const { rows: inv } = await pool.query<{ invited_by: string }>(
        'SELECT invited_by FROM user_invitations WHERE id = $1',
        [id],
      );
      expect(inv[0]!.invited_by).toBe(agencyAdminB);
      expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
      expect(
        await rejection(
          invitations.accept({ token: viejo, name: 'X', password: 'una-clave-larga' }),
        ),
      ).toMatch(/^400\//);
      await invitations.accept({ token: nuevo, name: 'Reenviado', password: 'una-clave-larga' });
      expect(await membershipsOf(agencyB, to)).toEqual([{ role: 'vendedor' }]);

      const { rows } = await pool.query(
        `SELECT actor_user_id, payload FROM domain_events
          WHERE event_type = 'UserInvitationResent' AND aggregate_id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: agencyAdminB,
        payload: { role: 'vendedor', previousInvitedBy: consAdminB },
      });
    });

    it('no reenvía una invitación de rango igual o superior al propio (403)', async () => {
      const { id } = await invitations.invite({
        actorUserId: agencyAdminB,
        tenantId: agencyB,
        email: email('reenvio-rango'),
        role: 'admin',
      });

      expect(
        await rejection(
          invitations.resend({
            actorUserId: plainAdminB,
            actorRole: 'admin',
            tenantId: agencyB,
            invitationId: id,
          }),
        ),
      ).toMatch(/^403\//);
    });

    it('404 si ya se aceptó, se revocó o es de otro nodo', async () => {
      const to = email('reenvio-cerrada');
      const { id } = await invitations.invite({
        actorUserId: agencyAdminB,
        tenantId: agencyB,
        email: to,
        role: 'vendedor',
      });
      const base = {
        actorUserId: agencyAdminB,
        actorRole: 'tenant_admin' as const,
        invitationId: id,
      };

      expect(await rejection(invitations.resend({ ...base, tenantId: subB }))).toBe(
        '404/INVITATION_NOT_PENDING',
      );
      await invitations.revoke(agencyAdminB, 'tenant_admin', agencyB, id);
      expect(await rejection(invitations.resend({ ...base, tenantId: agencyB }))).toBe(
        '404/INVITATION_NOT_PENDING',
      );
    });
  });

  /** Espera a que el insert de una invitación quede bloqueado por otra transacción (el índice de 0066). */
  async function insertWaitingOnLock(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE 'insert into "user_invitations"%'`,
      );
      if (Number(rows[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('el insert de la invitación nunca quedó esperando');
  }

  describe('revocar', () => {
    it('exige rango sobre el rol de la invitación y deja un solo UserInvitationRevoked', async () => {
      const to = email('revocar');
      const { id } = await invitations.invite({
        actorUserId: agencyAdminB,
        tenantId: agencyB,
        email: to,
        role: 'admin',
      });

      // Un admin no revoca la invitación de otro admin.
      const err = await rejected(invitations.revoke(plainAdminB, 'admin', agencyB, id));
      expect(`${err.getStatus()}/${err.reason}`).toBe('403/ROLE_NOT_GRANTABLE');
      expect(await pendingInvitations(agencyB, to)).toHaveLength(1);

      await invitations.revoke(agencyAdminB, 'tenant_admin', agencyB, id);
      expect(await pendingInvitations(agencyB, to)).toEqual([]);
      // La segunda vez ya no está pendiente: 404 y sin otro evento.
      const again = await rejected(invitations.revoke(agencyAdminB, 'tenant_admin', agencyB, id));
      expect(`${again.getStatus()}/${again.reason}`).toBe('404/INVITATION_NOT_PENDING');

      const { rows } = await pool.query(
        `SELECT actor_user_id, payload FROM domain_events
          WHERE event_type = 'UserInvitationRevoked' AND aggregate_id = $1`,
        [id],
      );
      expect(rows).toEqual([
        { actor_user_id: agencyAdminB, payload: { role: 'admin', cause: 'manual' } },
      ]);
    });
  });

  describe('una sola invitación pendiente por correo y nodo (0066)', () => {
    it('invitar otra vez al mismo correo es 409 con la pendiente, aunque esté vencida o cambie la mayúscula', async () => {
      const to = email('doble');
      const { id } = await invitations.invite({
        actorUserId: agencyAdminB,
        tenantId: agencyB,
        email: to,
        role: 'vendedor',
      });
      await pool.query(
        `UPDATE user_invitations SET expires_at = now() - interval '1 day' WHERE id = $1`,
        [id],
      );
      mailer.sendToTenant.mockClear();

      const err = await rejected(
        invitations.invite({
          actorUserId: agencyAdminB,
          tenantId: agencyB,
          email: to.toUpperCase(),
          role: 'admin',
        }),
      );

      expect(`${err.getStatus()}/${err.reason}`).toBe('409/INVITATION_ALREADY_PENDING');
      expect(err.publicDetails).toEqual({ invitationId: id });
      expect(await pendingInvitations(agencyB, to)).toHaveLength(1);
      expect(mailer.sendToTenant).not.toHaveBeenCalled();

      // En otro nodo, el mismo correo sí se invita.
      await invitations.invite({
        actorUserId: agencyAdminB,
        tenantId: subB,
        email: to,
        role: 'vendedor',
      });
      expect(await pendingInvitations(subB, to)).toHaveLength(1);
    });

    it('el índice frena la carrera: el insert que esperaba a otro sale como el mismo 409, con la que ganó', async () => {
      const to = email('carrera');
      const rival = await pool.connect();
      let winner: string;
      try {
        // Otro pedido ya insertó, sin confirmar: la lectura previa del servicio no lo ve.
        await rival.query('BEGIN');
        const { rows } = await rival.query<{ id: string }>(
          `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, 'vendedor', $3, $4, now() + interval '7 days') RETURNING id`,
          [agencyB, to, `rival-${sfx}`, agencyAdminB],
        );
        winner = rows[0]!.id;

        const loser = rejected(
          invitations.invite({
            actorUserId: agencyAdminB,
            tenantId: agencyB,
            email: to,
            role: 'vendedor',
          }),
        );
        await insertWaitingOnLock();
        await rival.query('COMMIT');

        const err = await loser;
        expect(`${err.getStatus()}/${err.reason}`).toBe('409/INVITATION_ALREADY_PENDING');
        expect(err.publicDetails).toEqual({ invitationId: winner });
      } finally {
        rival.release();
      }

      expect((await pendingInvitations(agencyB, to)).map((p) => p.id)).toEqual([winner]);
      // La transacción que perdió no dejó un UserInvited a medias.
      const { rows: invited } = await pool.query(
        `SELECT 1 FROM domain_events WHERE event_type = 'UserInvited' AND payload->>'email' = $1`,
        [to],
      );
      expect(invited).toEqual([]);
    });

    it('la limpieza de 0066 deja la del enlace más reciente y revoca las demás con su rastro', async () => {
      const to = email('duplicada');
      const client = await pool.connect();
      try {
        // Todo en una transacción que se deshace: sin el índice para poder sembrar duplicadas, la
        // migración tal cual y lo que deja. Nadie más escribe invitaciones mientras dura.
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '10s'`);
        await client.query('DROP INDEX uq_user_invitations_pending');

        const seed = async (
          label: string,
          tenantId: string,
          address: string,
          expires: string,
          created: string,
          accepted = false,
        ): Promise<string> => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO user_invitations
               (tenant_id, email, role, token_hash, invited_by, expires_at, created_at, accepted_at)
             VALUES ($1, $2, 'vendedor', $3, $4, now() + $5::interval, now() + $6::interval,
                     CASE WHEN $7::boolean THEN now() END)
             RETURNING id`,
            [tenantId, address, `dup-${label}-${sfx}`, agencyAdminB, expires, created, accepted],
          );
          return rows[0]!.id;
        };
        const vencida = await seed('vencida', agencyB, to, '-2 days', '-9 days');
        // La más vieja por alta, pero reenviada hace un día: su enlace es el último que salió.
        const reenviada = await seed('reenviada', agencyB, to, '6 days', '-8 days');
        const nueva = await seed('nueva', agencyB, to, '5 days', '-2 days');
        const mayuscula = await seed('mayuscula', agencyB, to.toUpperCase(), '1 day', '-1 day');
        const aceptada = await seed('aceptada', agencyB, to, '3 days', '-3 days', true);
        const otroNodo = await seed('otro-nodo', subB, to, '4 days', '-4 days');

        await client.query(
          readFileSync(
            join(
              __dirname,
              '..',
              '..',
              '..',
              '..',
              'db',
              'migrations',
              '0066_invitation_pending_unique.sql',
            ),
            'utf8',
          ),
        );

        const { rows: state } = await client.query<{ id: string; revoked: boolean }>(
          `SELECT id, revoked_at IS NOT NULL AS revoked FROM user_invitations WHERE id = ANY($1)`,
          [[vencida, reenviada, nueva, mayuscula, aceptada, otroNodo]],
        );
        const revokedIds = state.filter((r) => r.revoked).map((r) => r.id);
        expect(revokedIds.sort()).toEqual([vencida, nueva, mayuscula].sort());

        const { rows: events } = await client.query<{
          aggregate_id: string;
          tenant_id: string;
          actor_user_id: string | null;
          payload: Record<string, unknown>;
        }>(
          `SELECT aggregate_id, tenant_id, actor_user_id, payload FROM domain_events
            WHERE event_type = 'UserInvitationRevoked' AND aggregate_id = ANY($1)`,
          [[vencida, reenviada, nueva, mayuscula, aceptada, otroNodo]],
        );
        expect(events.map((e) => e.aggregate_id).sort()).toEqual(revokedIds.sort());
        for (const e of events) {
          expect(e).toMatchObject({
            tenant_id: agencyB,
            actor_user_id: null,
            payload: { cause: 'duplicate_cleanup', role: 'vendedor' },
          });
        }

        // El índice volvió y frena una segunda pendiente, también con otra mayúscula.
        await client.query('SAVEPOINT segunda');
        const second = await client
          .query(
            `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, 'vendedor', $3, $4, now() + interval '7 days')`,
            [agencyB, to.toUpperCase(), `dup-segunda-${sfx}`, agencyAdminB],
          )
          .then(
            () => undefined,
            (e: unknown) => e as { code?: string; constraint?: string },
          );
        expect(second).toMatchObject({ code: '23505', constraint: 'uq_user_invitations_pending' });
        await client.query('ROLLBACK TO SAVEPOINT segunda');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
