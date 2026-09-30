import { randomBytes } from 'node:crypto';
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
      expect(Object.keys(nuevo).sort()).toEqual(['expiresAt', 'id']);
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
      await invitations.revoke(agencyAdminB, agencyB, id);
      expect(await rejection(invitations.resend({ ...base, tenantId: agencyB }))).toBe(
        '404/INVITATION_NOT_PENDING',
      );
    });
  });
});
