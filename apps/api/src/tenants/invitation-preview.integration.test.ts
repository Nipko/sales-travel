import { createHash, randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { InvitationPreviewService } from './invitation-preview.service.js';
import { InvitationsService } from './invitations.service.js';

/**
 * La página de la invitación contra Postgres (USR-17, 0068):
 *
 *   - la vista previa dice nodo, rol, quién invitó, vencimiento y si el correo ya tiene cuenta, y
 *     nada más (ni ids ni correos); no gasta la invitación; y un token que no existe, vencido,
 *     revocado, usado o que su invitador ya no respalda da la misma respuesta neutral;
 *   - quien ya tiene cuenta no la canjea con el formulario de cuenta nueva (409, queda pendiente):
 *     acepta con su sesión, y sólo si la sesión es de la cuenta dueña del correo invitado (403 si no,
 *     queda pendiente y auditado); el correo se compara sin distinguir mayúsculas;
 *   - con la sesión, los tokens vencidos, revocados o usados son 400, y una membership quitada del
 *     nodo (USR-11) vuelve en la misma fila.
 *
 * Todo lo que la API ejecuta corre como `app_user` (NOSUPERUSER, NOBYPASSRLS): la vista previa y los
 * canjes pasan por las funciones SECURITY DEFINER y la RLS de memberships como en producción. El
 * superusuario sólo siembra y mira. Se SALTA sin PGHOST o sin APP_USER_PASSWORD.
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

d('la página de la invitación, contra Postgres', () => {
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
  const audit = new AuditService(database);
  const invitations = new InvitationsService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
  );
  const previews = new InvitationPreviewService(database);

  let cons: string;
  let agency: string;
  let otherAgency: string;
  let admin: string;

  const slug = (label: string) => `ip-${label}-${sfx}`;
  const email = (label: string) => `ip-${label}-${sfx}@test.local`;

  async function tenant(label: string, type: TenantType, parent: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2, 'CO', 'COP', $3, $4) RETURNING id`,
      [slug(label), `Viajes ${label}`, type, parent],
    );
    return rows[0]!.id;
  }

  async function user(label: string, opts: { name?: string; address?: string } = {}) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'hash-original') RETURNING id`,
      [opts.address ?? email(label), opts.name ?? null],
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

  async function membership(tenantId: string, userId: string) {
    const { rows } = await pool.query<{
      id: string;
      role: string;
      status: string;
      removed_at: Date | null;
    }>(
      `SELECT id, role, status, removed_at FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    return rows[0];
  }

  /** Invita como el admin del nodo y devuelve el id y el token en claro (sacado del correo). */
  async function invite(
    tenantId: string,
    label: string,
    role: Role = 'vendedor',
    inviter = admin,
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

  beforeAll(async () => {
    database.onModuleInit();
    const platform = await platformRootId(pool);
    cons = await tenant('cons', 'consolidator', platform);
    agency = await tenant('norte', 'agency', cons);
    otherAgency = await tenant('sur', 'agency', cons);
    admin = await user('admin', { name: '  Laura Gómez  ' });
    await member(agency, admin, 'tenant_admin');
    await member(otherAgency, admin, 'tenant_admin');
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`ip-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('vista previa', () => {
    it('dice nodo, rol, quién invitó, vencimiento y que no hay cuenta; nada más, y no la gasta', async () => {
      const sent = await invite(agency, 'nueva', 'admin');

      const preview = await previews.preview(sent.token, undefined);

      expect(preview).toEqual({
        valid: true,
        tenantName: 'Viajes norte',
        role: 'admin',
        inviterName: 'Laura Gómez',
        expiresAt: expect.any(String) as unknown,
        existingAccount: false,
        viewer: 'anonymous',
      });
      expect(Date.parse((preview as { expiresAt: string }).expiresAt)).toBeGreaterThan(
        Date.now() + 6 * 24 * 60 * 60_000,
      );
      // Ni ids, ni el correo invitado, ni el de quien invitó.
      const json = JSON.stringify(preview);
      expect(json).not.toContain(sent.id);
      expect(json).not.toContain(agency);
      expect(json).not.toContain(admin);
      expect(json).not.toContain('@');
      // Mirarla no la gasta: sigue pendiente y se canjea.
      await previews.preview(sent.token, undefined);
      expect(await invitationState(sent.id)).toEqual({ accepted: false, revoked: false });
      await expect(
        invitations.accept({ token: sent.token, name: 'Nueva', password: 'una-clave-larga-123' }),
      ).resolves.toMatchObject({ tenantId: agency });
    });

    it('con cuenta: lo dice, y con sesión distingue a la cuenta invitada de otra', async () => {
      const owner = await user('con-cuenta');
      const stranger = await user('otra-cuenta');
      const sent = await invite(agency, 'con-cuenta');

      expect(await previews.preview(sent.token, undefined)).toMatchObject({
        valid: true,
        existingAccount: true,
        viewer: 'anonymous',
      });
      expect(await previews.preview(sent.token, owner)).toMatchObject({ viewer: 'invitee' });
      expect(await previews.preview(sent.token, stranger)).toMatchObject({ viewer: 'other' });
    });

    it('quien invitó sin nombre: inviterName null, nunca su correo', async () => {
      const nameless = await user('sin-nombre');
      await member(agency, nameless, 'admin');
      const sent = await invite(agency, 'de-sin-nombre', 'vendedor', nameless);

      expect(await previews.preview(sent.token, undefined)).toMatchObject({
        valid: true,
        inviterName: null,
      });
    });

    it('neutral: inexistente, vencida, revocada, usada o que su invitador ya no respalda', async () => {
      expect(await previews.preview(randomBytes(32).toString('base64url'), undefined)).toEqual({
        valid: false,
      });

      const expired = await invite(agency, 'vencida');
      await pool.query(
        `UPDATE user_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [expired.id],
      );
      expect(await previews.preview(expired.token, undefined)).toEqual({ valid: false });

      const revoked = await invite(agency, 'revocada');
      await invitations.revoke(admin, 'tenant_admin', agency, revoked.id);
      expect(await previews.preview(revoked.token, undefined)).toEqual({ valid: false });

      const used = await invite(agency, 'usada');
      await invitations.accept({
        token: used.token,
        name: 'Usada',
        password: 'una-clave-larga-123',
      });
      expect(await previews.preview(used.token, undefined)).toEqual({ valid: false });

      // Su invitador perdió el acceso al nodo sin pasar por el endpoint que revoca.
      const orphanInviter = await user('invitador-suspendido');
      await member(agency, orphanInviter, 'admin');
      const orphan = await invite(agency, 'huerfana', 'vendedor', orphanInviter);
      await pool.query(`UPDATE memberships SET status = 'suspended' WHERE user_id = $1`, [
        orphanInviter,
      ]);
      expect(await previews.preview(orphan.token, undefined)).toEqual({ valid: false });
      expect(await invitationState(orphan.id)).toEqual({ accepted: false, revoked: false });
    });
  });

  describe('quien ya tiene cuenta', () => {
    it('el formulario de cuenta nueva no la canjea: 409, queda pendiente y su contraseña intacta', async () => {
      const owner = await user('no-por-formulario');
      const sent = await invite(agency, 'no-por-formulario');

      expect(
        await rejection(
          invitations.accept({ token: sent.token, name: 'Otro', password: 'una-clave-larga-123' }),
        ),
      ).toBe('409/INVITATION_SIGN_IN_REQUIRED');

      expect(await invitationState(sent.id)).toEqual({ accepted: false, revoked: false });
      expect(await membership(agency, owner)).toBeUndefined();
      const { rows } = await pool.query<{ name: string | null; password_hash: string }>(
        'SELECT name, password_hash FROM users WHERE id = $1',
        [owner],
      );
      expect(rows[0]).toEqual({ name: null, password_hash: 'hash-original' });
    });

    it('acepta con su sesión: la membership, el evento y el token gastado', async () => {
      const owner = await user('con-sesion');
      const sent = await invite(agency, 'con-sesion', 'admin');

      expect(await invitations.acceptSignedIn({ token: sent.token, userId: owner })).toEqual({
        userId: owner,
        tenantId: agency,
      });

      expect(await membership(agency, owner)).toMatchObject({ role: 'admin', status: 'active' });
      expect(await invitationState(sent.id)).toEqual({ accepted: true, revoked: false });
      expect(await events('UserInvitationAccepted', sent.id)).toEqual([
        {
          actor_user_id: owner,
          tenant_id: agency,
          payload: { email: email('con-sesion'), role: 'admin', existingAccount: true },
        },
      ]);
      expect(
        await rejection(invitations.acceptSignedIn({ token: sent.token, userId: owner })),
      ).toBe('400/?');
    });

    it('el correo se compara sin distinguir mayúsculas', async () => {
      const owner = await user('mayusculas', { address: email('MAYUSCULAS').toUpperCase() });
      const sent = await invite(agency, 'mayusculas');

      expect(await previews.preview(sent.token, owner)).toMatchObject({
        existingAccount: true,
        viewer: 'invitee',
      });
      await expect(
        invitations.acceptSignedIn({ token: sent.token, userId: owner }),
      ).resolves.toEqual({ userId: owner, tenantId: agency });
    });

    it('con la sesión de otra cuenta: 403, queda pendiente para su dueño y el intento auditado', async () => {
      const owner = await user('duena');
      const stranger = await user('ajena');
      await member(otherAgency, stranger, 'vendedor');
      const sent = await invite(agency, 'duena', 'admin');

      expect(
        await rejection(invitations.acceptSignedIn({ token: sent.token, userId: stranger })),
      ).toBe('403/INVITATION_ACCOUNT_MISMATCH');

      expect(await invitationState(sent.id)).toEqual({ accepted: false, revoked: false });
      expect(await membership(agency, stranger)).toBeUndefined();
      expect(await membership(agency, owner)).toBeUndefined();
      expect(await events('UserInvitationAccountMismatch', sent.id)).toEqual([
        { actor_user_id: stranger, tenant_id: agency, payload: {} },
      ]);
      expect(await events('UserInvitationAccepted', sent.id)).toEqual([]);

      // Para una invitación de alguien sin cuenta, ninguna sesión es la dueña.
      const fresh = await invite(agency, 'sin-cuenta-todavia');
      expect(
        await rejection(invitations.acceptSignedIn({ token: fresh.token, userId: stranger })),
      ).toBe('403/INVITATION_ACCOUNT_MISMATCH');

      // La dueña sí la acepta después.
      await expect(
        invitations.acceptSignedIn({ token: sent.token, userId: owner }),
      ).resolves.toEqual({ userId: owner, tenantId: agency });
    });

    it('vencida, revocada o usada: 400 y sin membership', async () => {
      const owner = await user('tardia');

      const expired = await invite(agency, 'tardia');
      await pool.query(
        `UPDATE user_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [expired.id],
      );
      expect(
        await rejection(invitations.acceptSignedIn({ token: expired.token, userId: owner })),
      ).toBe('400/?');

      const revoked = await invite(otherAgency, 'tardia');
      await invitations.revoke(admin, 'tenant_admin', otherAgency, revoked.id);
      expect(
        await rejection(invitations.acceptSignedIn({ token: revoked.token, userId: owner })),
      ).toBe('400/?');

      expect(await membership(agency, owner)).toBeUndefined();
      expect(await membership(otherAgency, owner)).toBeUndefined();

      // Una de antes, ya canjeada por su dueña: no vuelve a valer.
      const token = randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at, accepted_at)
         VALUES ($1, $2, 'vendedor', $3, $4, now() + interval '7 days', now())`,
        [cons, email('tardia'), createHash('sha256').update(token).digest('hex'), admin],
      );
      expect(await rejection(invitations.acceptSignedIn({ token, userId: owner }))).toBe('400/?');
      expect(await membership(cons, owner)).toBeUndefined();
    });

    it('su invitador ya no la respalda: 400 con motivo y el rastro con quién lo intentó', async () => {
      const owner = await user('respaldo');
      const inviter = await user('invitador-degradado');
      await member(agency, inviter, 'admin');
      const sent = await invite(agency, 'respaldo', 'vendedor', inviter);
      await pool.query(`UPDATE memberships SET status = 'suspended' WHERE user_id = $1`, [inviter]);

      expect(
        await rejection(invitations.acceptSignedIn({ token: sent.token, userId: owner })),
      ).toBe('400/INVITATION_NO_LONGER_VALID');
      expect(await invitationState(sent.id)).toEqual({ accepted: false, revoked: false });
      expect(await events('UserInvitationRejected', sent.id)).toEqual([
        { actor_user_id: owner, tenant_id: agency, payload: { defect: 'inviter_outranked' } },
      ]);
    });

    it('quitada del nodo (USR-11): vuelve con su sesión en la misma fila, con el rol nuevo', async () => {
      const back = await user('vuelve');
      const membershipId = await member(agency, back, 'vendedor');
      await pool.query(
        `UPDATE memberships SET status = 'removed', removed_at = now(), removed_by = $3
          WHERE tenant_id = $1 AND user_id = $2`,
        [agency, back, admin],
      );
      const sent = await invite(agency, 'vuelve', 'admin');

      expect(await previews.preview(sent.token, back)).toMatchObject({
        existingAccount: true,
        viewer: 'invitee',
      });
      await invitations.acceptSignedIn({ token: sent.token, userId: back });

      expect(await membership(agency, back)).toEqual({
        id: membershipId,
        role: 'admin',
        status: 'active',
        removed_at: null,
      });
      expect(await events('UserInvitationAccepted', sent.id)).toMatchObject([
        { payload: { existingAccount: true, rejoined: true } },
      ]);
    });
  });
});
