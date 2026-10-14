import { randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { NetworkService } from '../network/network.service.js';
import { AdminInvitationsController } from './admin-invitations.controller.js';
import {
  AdminInvitationsService,
  type PlatformInvitation,
  type PlatformInvitationsPage,
} from './admin-invitations.service.js';
import { ListPlatformInvitationsQuerySchema } from './dto.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

/**
 * Las invitaciones sin aceptar de toda la red (GET /admin/invitations), contra Postgres:
 *
 *   - el superadmin ve las de todas las redes, con su nodo y quién las mandó; las aceptadas y las
 *     revocadas no salen; un admin de red recibe 403 aunque pida su propio subárbol;
 *   - pendientes, vencidas y todas; la búsqueda por correo y el nodo con su subárbol; los contadores
 *     del mismo alcance, sin importar el estado pedido;
 *   - el cursor no salta ni repite invitaciones creadas en el mismo instante;
 *   - reenviar y revocar desde la lista van por las rutas de un nodo con el nodo de la fila, y la lista
 *     lo refleja.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS): la RLS de user_invitations (0028) es la
 * que le deja leer todo al superadmin. El superusuario sólo siembra y mira. Cuelga todo de la raíz
 * `platform` compartida; cada consulta busca el sufijo del test en el correo, porque la base la
 * comparten otros tests. Se SALTA sin PGHOST.
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

d('invitaciones sin aceptar de toda la red, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
  } as unknown as PasswordService;
  const mailer = { sendToTenant: vi.fn(() => Promise.resolve(true)) };

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const controller = new AdminInvitationsController(new AdminInvitationsService(database, network));
  const nodeInvitations = new InvitationsController(
    new InvitationsService(database, password, mailer as unknown as MailerService, audit),
    network,
  );

  let consNorte: string;
  let agenciaNorte: string;
  let subNorte: string;
  let consSur: string;
  let agenciaSur: string;

  let root: string;
  let adminNorte: string;

  /** Id de cada invitación sembrada, por etiqueta. */
  const inv: Record<string, string> = {};

  const slug = (label: string) => `ai-${label}-${sfx}`;
  const email = (label: string) => `ai-${label}-${sfx}@test.local`;

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
      `INSERT INTO users (email, password_hash, status, mfa_enabled_at, email_verified_at)
       VALUES ($1, 'hash-original', 'active', now(), now()) RETURNING id`,
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

  /**
   * Una invitación de `label`. `createdAt` y `expiresAt` son expresiones SQL: dos invitaciones con la
   * misma `createdAt` literal comparten el instante hasta el microsegundo.
   */
  async function invitation(
    label: string,
    tenantId: string,
    opts: {
      role?: Role;
      invitedBy?: string | null;
      createdAt?: string;
      expiresAt?: string;
      state?: 'accepted' | 'revoked';
    } = {},
  ): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at,
                                     created_at, accepted_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, ${opts.expiresAt ?? "now() + interval '5 days'"},
               ${opts.createdAt ?? 'now()'},
               ${opts.state === 'accepted' ? 'now()' : 'NULL'},
               ${opts.state === 'revoked' ? 'now()' : 'NULL'})
       RETURNING id`,
      [
        tenantId,
        email(label),
        opts.role ?? 'vendedor',
        randomBytes(16).toString('hex'),
        opts.invitedBy === undefined ? adminNorte : opts.invitedBy,
      ],
    );
    inv[label] = rows[0]!.id;
  }

  /** La lista como la pide el panel, siempre acotada a las invitaciones de este test. */
  function list(raw: Record<string, unknown> = {}, actor = root): Promise<PlatformInvitationsPage> {
    return controller.list(actor, ListPlatformInvitationsQuerySchema.parse({ q: sfx, ...raw }));
  }

  function ids(invitations: readonly PlatformInvitation[]): string[] {
    return invitations.map((i) => i.id);
  }

  beforeAll(async () => {
    database.onModuleInit();
    const platform = await platformRootId(pool);
    consNorte = await tenant('cons-norte', 'consolidator', platform);
    agenciaNorte = await tenant('agencia-norte', 'agency', consNorte);
    subNorte = await tenant('sub-norte', 'subagency', agenciaNorte);
    consSur = await tenant('cons-sur', 'consolidator', platform);
    agenciaSur = await tenant('agencia-sur', 'agency', consSur);

    root = await user('root');
    await member(platform, root, 'superadmin');
    adminNorte = await user('admin-norte');
    await member(consNorte, adminNorte, 'consolidator_admin');

    await invitation('norte', agenciaNorte, { createdAt: "now() - interval '1 hour'" });
    await invitation('sub', subNorte, {
      role: 'admin',
      createdAt: "now() - interval '2 hours'",
    });
    // Dos en el mismo instante, hasta el microsegundo: el cursor no puede saltar ninguna.
    await invitation('sur-a', consSur, {
      role: 'tenant_admin',
      invitedBy: root,
      createdAt:
        "date_trunc('second', now()) - interval '3 hours' + interval '123456 microseconds'",
    });
    await invitation('sur-b', agenciaSur, {
      invitedBy: root,
      createdAt:
        "date_trunc('second', now()) - interval '3 hours' + interval '123456 microseconds'",
    });
    // Vencida, de alguien cuya cuenta ya no existe.
    await invitation('vencida', agenciaSur, {
      invitedBy: null,
      createdAt: "now() - interval '10 days'",
      expiresAt: "now() - interval '3 days'",
    });
    await invitation('aceptada', agenciaNorte, { state: 'accepted' });
    await invitation('revocada', agenciaSur, { state: 'revoked' });
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`ai-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('quién las ve', () => {
    it('el superadmin ve las pendientes de todas las redes, con su nodo y quién las mandó', async () => {
      const page = await list();

      // Las más recientes primero; entre las dos del mismo instante, la de id mayor.
      const [mismoInstanteA, mismoInstanteB] = [inv['sur-a']!, inv['sur-b']!].sort().reverse();
      expect(ids(page.invitations)).toEqual([
        inv['norte'],
        inv['sub'],
        mismoInstanteA,
        mismoInstanteB,
      ]);
      expect(page.nextCursor).toBeNull();
      expect(page.counts).toEqual({ pending: 4, expired: 1 });

      const { rows } = await pool.query<{ created_at: Date; expires_at: Date }>(
        'SELECT created_at, expires_at FROM user_invitations WHERE id = $1',
        [inv['norte']],
      );
      expect(page.invitations[0]).toEqual({
        id: inv['norte'],
        email: email('norte'),
        role: 'vendedor',
        tenantId: agenciaNorte,
        tenantName: 'Nodo agencia-norte',
        invitedByEmail: email('admin-norte'),
        createdAt: rows[0]!.created_at.toISOString(),
        expiresAt: rows[0]!.expires_at.toISOString(),
        expired: false,
      });
      expect(page.invitations.find((i) => i.id === inv['sur-a'])).toMatchObject({
        role: 'tenant_admin',
        tenantId: consSur,
        tenantName: 'Nodo cons-sur',
        invitedByEmail: email('root'),
      });
    });

    it('un admin de red recibe 403, también sobre su propio subárbol; sin sesión, 401', async () => {
      expect(await rejection(list({}, adminNorte))).toBe('403/SUPERADMIN_ONLY');
      expect(await rejection(list({ tenantId: consNorte }, adminNorte))).toBe(
        '403/SUPERADMIN_ONLY',
      );
      expect(await rejection(controller.list(undefined, { q: sfx }))).toBe('401/?');
    });
  });

  describe('estados, búsqueda y nodo', () => {
    it('vencidas: sólo las que ya no sirven, marcadas, aunque quien la mandó ya no exista', async () => {
      const page = await list({ state: 'expired' });

      expect(page.invitations).toEqual([
        expect.objectContaining({
          id: inv['vencida'],
          tenantId: agenciaSur,
          invitedByEmail: null,
          expired: true,
        }),
      ]);
      // Los contadores no dependen del estado pedido.
      expect(page.counts).toEqual({ pending: 4, expired: 1 });
    });

    it('todas: pendientes y vencidas; nunca las aceptadas ni las revocadas', async () => {
      const page = await list({ state: 'all' });

      expect(ids(page.invitations)).toHaveLength(5);
      expect(ids(page.invitations)).toContain(inv['vencida']);
      expect(ids(page.invitations)).not.toContain(inv['aceptada']);
      expect(ids(page.invitations)).not.toContain(inv['revocada']);
    });

    it('el nodo trae su subárbol, y los contadores son de ese alcance', async () => {
      const norte = await list({ tenantId: consNorte, state: 'all' });
      expect(ids(norte.invitations).sort()).toEqual([inv['norte'], inv['sub']].sort());
      expect(norte.counts).toEqual({ pending: 2, expired: 0 });

      const sur = await list({ tenantId: agenciaSur, state: 'all' });
      expect(ids(sur.invitations).sort()).toEqual([inv['sur-b'], inv['vencida']].sort());
      expect(sur.counts).toEqual({ pending: 1, expired: 1 });
    });

    it('la búsqueda va por el correo, sin distinguir mayúsculas, y sus comodines se buscan tal cual', async () => {
      const page = await list({ q: `AI-SUB-${sfx.toUpperCase()}` });
      expect(ids(page.invitations)).toEqual([inv['sub']]);
      expect(page.counts).toEqual({ pending: 1, expired: 0 });

      // "_" no es comodín: ningún correo del test tiene "ai_".
      expect((await list({ q: `ai_sub-${sfx}` })).invitations).toEqual([]);
    });
  });

  describe('el cursor', () => {
    it('de a una no salta ni repite, tampoco entre dos del mismo instante', async () => {
      const all = await list({ state: 'all' });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await list({ state: 'all', limit: '1', ...(cursor ? { cursor } : {}) });
        seen.push(...ids(page.invitations));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(ids(all.invitations));
    });
  });

  describe('reenviar y revocar desde la lista, por las rutas de un nodo', () => {
    it('el superadmin reenvía una vencida de otra red con el nodo de la fila: queda pendiente', async () => {
      const before = (await list({ state: 'expired' })).invitations[0]!;

      const issued = await nodeInvitations.resend(root, before.id, before.tenantId);
      expect(issued.emailSent).toBe(true);

      const after = await list({ state: 'all' });
      expect(after.invitations.find((i) => i.id === before.id)).toMatchObject({
        expired: false,
        invitedByEmail: email('root'),
      });
      expect(after.counts).toEqual({ pending: 5, expired: 0 });
    });

    it('revoca una pendiente con el nodo de la fila: deja de estar en la lista', async () => {
      const row = (await list()).invitations.find((i) => i.id === inv['sub'])!;

      await nodeInvitations.revoke(root, row.id, row.tenantId);

      const after = await list({ state: 'all' });
      expect(ids(after.invitations)).not.toContain(inv['sub']);
      expect(after.counts).toEqual({ pending: 4, expired: 0 });
    });

    it('con el nodo equivocado, la invitación no está pendiente ahí: 404 y sigue en la lista', async () => {
      expect(await rejection(nodeInvitations.revoke(root, inv['norte']!, consSur))).toBe(
        '404/INVITATION_NOT_PENDING',
      );
      expect(ids((await list()).invitations)).toContain(inv['norte']);
    });
  });
});
