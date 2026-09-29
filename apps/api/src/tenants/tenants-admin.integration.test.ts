import { randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyTenant, platformRootId } from '../__fixtures__/platform-root.js';
import { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, TenantType } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import { NetworkService } from '../network/network.service.js';
import type { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import { CreateTenantSchema } from './dto.js';
import { InvitationsService } from './invitations.service.js';
import { childTenantType, CREATABLE_TENANT_TYPES } from './tenant-admin.policy.js';
import { TenantsService } from './tenants.service.js';

/**
 * El alta y la corrección de nodos por la API contra Postgres (G-05, G-06, G-07, G-09; D4 A, D6 A):
 * lo que el doble del controlador no puede probar. Que el tipo derivado entra por el trigger de 0050,
 * que el admin inicial queda con el rol que corresponde y un email existente se invita en vez de
 * vincularse, que el PATCH deja su evento con el antes y el después en la misma transacción, que
 * suspender un nodo corta el rol de su red, que mover llama a `move_tenant_subtree` con el actor y
 * no escribe un segundo evento, y que el rango se mide sobre el nodo destino.
 *
 * Lo que la API ejecuta corre como `app_user` (NOBYPASSRLS); el superusuario sólo siembra y mira.
 * Es `SET ROLE`, así que `session_user` sigue siendo el superusuario: el rechazo de
 * `move_tenant_subtree` a quien no es superadmin lo prueba tenant-hierarchy.integration.test.ts con
 * `SESSION AUTHORIZATION`. Cuelga todo de la raíz `platform` compartida (`platformRootId`). Se SALTA
 * sin PGHOST.
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

d('alta y corrección de nodos por la API, contra Postgres', () => {
  const pool = new pg.Pool();
  const database = new ComoAppUser();
  const sfx = randomBytes(4).toString('hex');
  const users: string[] = [];
  const password = {
    hash: (p: string) => Promise.resolve(`hash-de-prueba-${p.length}`),
  } as unknown as PasswordService;
  const mailer = { sendToTenant: vi.fn(() => Promise.resolve(true)) };
  const enablement = { invalidate: vi.fn() };

  const network = new NetworkService(database);
  const audit = new AuditService(database);
  const invitations = new InvitationsService(
    database,
    password,
    mailer as unknown as MailerService,
    audit,
  );
  const service = new TenantsService(
    database,
    network,
    password,
    invitations,
    audit,
    enablement as unknown as ProviderEnablementStore,
  );
  const sessions = new SessionService(database);

  let platform: string;
  let cons: string;
  let agency: string;
  let otherAgency: string;
  let superadmin: string;
  let platformAdmin: string;
  let consAdmin: string;
  let agencyAdmin: string;
  let agencyPlainAdmin: string;
  let crossNetwork: string;
  let seq = 0;

  const slug = (label: string) => `ta-${label}-${sfx}`;

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
      [`ta-${label}-${sfx}@test.local`],
    );
    users.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: string, status = 'active') {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  /** El cuerpo del alta como lo deja pasar Zod. */
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

  async function row(id: string) {
    const { rows } = await pool.query<{
      tenant_type: string;
      is_branch: boolean;
      parent_tenant_id: string | null;
      status: string;
      depth: number;
    }>(
      `SELECT tenant_type, is_branch, parent_tenant_id, status, nlevel(path) AS depth
         FROM tenants WHERE id = $1`,
      [id],
    );
    return rows[0];
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

  async function membershipRole(tenantId: string, email: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ role: string }>(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email = $2`,
      [tenantId, email],
    );
    return rows[0]?.role;
  }

  async function slugExists(value: string): Promise<boolean> {
    const { rows } = await pool.query('SELECT 1 FROM tenants WHERE slug = $1', [value]);
    return rows.length > 0;
  }

  beforeAll(async () => {
    database.onModuleInit();
    platform = await platformRootId(pool);
    cons = await tenant('cons', 'consolidator', platform);
    agency = await tenant('agency', 'agency', cons);
    otherAgency = await tenant('other', 'agency', platform);

    superadmin = await user('root');
    platformAdmin = await user('planetour');
    consAdmin = await user('cons-admin');
    agencyAdmin = await user('agency-admin');
    agencyPlainAdmin = await user('agency-plain');
    crossNetwork = await user('cross');
    await member(platform, superadmin, 'superadmin');
    // Como el founder en producción: admin de Planetour, no superadmin.
    await member(platform, platformAdmin, 'consolidator_admin');
    await member(cons, consAdmin, 'consolidator_admin');
    await member(agency, agencyAdmin, 'tenant_admin');
    await member(agency, agencyPlainAdmin, 'admin');
    await member(cons, crossNetwork, 'consolidator_admin');
    await member(otherAgency, crossNetwork, 'admin');
  });

  beforeEach(() => {
    mailer.sendToTenant.mockClear();
    enablement.invalidate.mockClear();
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY nlevel(path) DESC`,
      [`ta-%-${sfx}`],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    await database.onModuleDestroy();
    await pool.end();
  });

  describe('alta: el tipo se deriva del padre (D4 A, G-05, G-07)', () => {
    it('el superadmin sin padre cuelga una agencia de la plataforma, auditada', async () => {
      const { tenant: created, admin } = await service.create(superadmin, alta('suelta'));

      expect(created).toMatchObject({
        tenantType: 'agency',
        isBranch: false,
        parentTenantId: platform,
        status: 'active',
        depth: 2,
      });
      expect(admin).toBeUndefined();
      expect(await events('TenantCreated', created.id)).toEqual([
        {
          actor_user_id: superadmin,
          tenant_id: created.id,
          payload: {
            slug: created.slug,
            tenantType: 'agency',
            isBranch: false,
            parentTenantId: platform,
          },
        },
      ]);
    });

    it('el superadmin crea un consolidador y una sucursal bajo la plataforma', async () => {
      const consolidator = await service.create(
        superadmin,
        alta('c', { tenantType: 'consolidator' }),
      );
      const branch = await service.create(superadmin, alta('b', { isBranch: true }));

      expect(await row(consolidator.tenant.id)).toMatchObject({
        tenant_type: 'consolidator',
        parent_tenant_id: platform,
      });
      expect(await row(branch.tenant.id)).toMatchObject({
        tenant_type: 'agency',
        is_branch: true,
        parent_tenant_id: platform,
      });
    });

    it('bajo un consolidador nace agencia; bajo una agencia, sub-agencia', async () => {
      const a = await service.create(consAdmin, alta('bajo-c', { parentTenantId: cons }));
      const s = await service.create(agencyAdmin, alta('bajo-a', { parentTenantId: agency }));

      expect(a.tenant).toMatchObject({ tenantType: 'agency', parentTenantId: cons, depth: 3 });
      expect(s.tenant).toMatchObject({ tenantType: 'subagency', parentTenantId: agency, depth: 4 });
    });

    it('nada cuelga de una sub-agencia', async () => {
      const s = await service.create(superadmin, alta('hoja', { parentTenantId: agency }));
      expect(
        await rejection(service.create(superadmin, alta('x', { parentTenantId: s.tenant.id }))),
      ).toBe('409/TENANT_PARENT_TYPE');
    });

    it('un tipo pedido distinto del derivado es 409 y no crea nada', async () => {
      const body = alta('mal-tipo', { tenantType: 'subagency' });
      expect(await rejection(service.create(superadmin, body))).toBe('409/TENANT_PARENT_TYPE');
      expect(await slugExists(body.slug)).toBe(false);
    });

    it('consolidador y sucursal son sólo del superadmin, y sólo bajo la plataforma', async () => {
      expect(
        await rejection(
          service.create(
            platformAdmin,
            alta('pc', { tenantType: 'consolidator', parentTenantId: platform }),
          ),
        ),
      ).toBe('403/TENANT_SUPERADMIN_ONLY');
      expect(
        await rejection(
          service.create(consAdmin, alta('cb', { isBranch: true, parentTenantId: cons })),
        ),
      ).toBe('403/TENANT_SUPERADMIN_ONLY');
      expect(
        await rejection(
          service.create(
            superadmin,
            alta('sc', { tenantType: 'consolidator', parentTenantId: cons }),
          ),
        ),
      ).toBe('409/TENANT_PARENT_TYPE');
      expect(
        await rejection(
          service.create(superadmin, alta('sb', { isBranch: true, parentTenantId: cons })),
        ),
      ).toBe('409/TENANT_BRANCH_PARENT');
    });

    it('el admin de Planetour (consolidator_admin) crea agencias bajo la plataforma', async () => {
      const { tenant: created } = await service.create(
        platformAdmin,
        alta('founder', { parentTenantId: platform }),
      );
      expect(created).toMatchObject({ tenantType: 'agency', parentTenantId: platform });
    });

    it('quien no es superadmin tiene que indicar el padre, y administrarlo', async () => {
      expect(await rejection(service.create(consAdmin, alta('sin-padre')))).toBe(
        '400/TENANT_PARENT_REQUIRED',
      );
      expect(
        await rejection(service.create(consAdmin, alta('ajena', { parentTenantId: otherAgency }))),
      ).toBe('403/?');
      expect(
        await rejection(
          service.create(
            consAdmin,
            alta('inexistente', { parentTenantId: '00000000-0000-4000-8000-000000000000' }),
          ),
        ),
      ).toBe('403/?');
      expect(
        await rejection(
          service.create(
            superadmin,
            alta('inexistente', { parentTenantId: '00000000-0000-4000-8000-000000000000' }),
          ),
        ),
      ).toBe('404/TENANT_PARENT_NOT_FOUND');
    });

    it('bajo una agencia raíz de antes de 0050 (Amazon) nace una sub-agencia', async () => {
      const c = await pool.connect();
      let amazon: string;
      try {
        amazon = await legacyTenant(c, slug('amazon'), 'agency');
      } finally {
        c.release();
      }
      const { tenant: created } = await service.create(
        superadmin,
        alta('am', { parentTenantId: amazon }),
      );
      expect(created).toMatchObject({ tenantType: 'subagency', parentTenantId: amazon, depth: 2 });
    });

    it('un slug repetido es 409 con motivo', async () => {
      const body = alta('dup');
      await service.create(superadmin, body);
      expect(await rejection(service.create(superadmin, { ...body, name: 'Otra' }))).toBe(
        '409/TENANT_SLUG_TAKEN',
      );
    });

    it('la derivación de la API coincide con la matriz de la base en todas las combinaciones', async () => {
      const types: TenantType[] = ['platform', 'consolidator', 'agency', 'subagency'];
      for (const parentType of types) {
        for (const type of CREATABLE_TENANT_TYPES) {
          for (const isBranch of [false, true]) {
            const { rows } = await pool.query<{ rule: string | null }>(
              'SELECT tenant_hierarchy_rule($1, $2, $3) AS rule',
              [type, isBranch, parentType],
            );
            const expected =
              rows[0]!.rule === null ? `ok:${type}` : `409/${rows[0]!.rule.toUpperCase()}`;
            let got: string;
            try {
              got = `ok:${childTenantType({ parentType, requestedType: type, isBranch, superadmin: true })}`;
            } catch (err) {
              got = `${(err as HttpException).getStatus()}/${(err as { reason: string }).reason}`;
            }
            expect(`${type}${isBranch ? ' (sucursal)' : ''} bajo ${parentType}: ${got}`).toBe(
              `${type}${isBranch ? ' (sucursal)' : ''} bajo ${parentType}: ${expected}`,
            );
          }
        }
      }
    });
  });

  describe('admin inicial: nunca un rol superior al propio, y a una cuenta existente se la invita (G-06)', () => {
    const clave = 'una-clave-larga-de-prueba';

    it('el superadmin da el rol del tipo de nodo; el admin nuevo se crea con su membership', async () => {
      const email = `ta-nuevo-c-${sfx}@test.local`;
      const res = await service.create(
        superadmin,
        alta('c-admin', {
          tenantType: 'consolidator',
          adminEmail: email,
          adminName: 'Ana',
          adminPassword: clave,
        }),
      );

      expect(res.admin).toEqual({ email, role: 'consolidator_admin', status: 'created' });
      expect(await membershipRole(res.tenant.id, email)).toBe('consolidator_admin');
      const [evento] = await events('TenantCreated', res.tenant.id);
      expect(evento!.payload).toMatchObject({ adminRole: 'consolidator_admin', admin: 'created' });
      expect(JSON.stringify(evento!.payload)).not.toContain(email);
    });

    it('un consolidator_admin da tenant_admin; un tenant_admin, agency_admin', async () => {
      const e1 = `ta-nuevo-a-${sfx}@test.local`;
      const e2 = `ta-nuevo-s-${sfx}@test.local`;
      const a = await service.create(
        consAdmin,
        alta('a-admin', { parentTenantId: cons, adminEmail: e1, adminPassword: clave }),
      );
      const s = await service.create(
        agencyAdmin,
        alta('s-admin', { parentTenantId: agency, adminEmail: e2, adminPassword: clave }),
      );

      expect(a.admin?.role).toBe('tenant_admin');
      expect(await membershipRole(a.tenant.id, e1)).toBe('tenant_admin');
      expect(s.admin?.role).toBe('agency_admin');
      expect(await membershipRole(s.tenant.id, e2)).toBe('agency_admin');
    });

    it('un `admin` no puede darle admin al nodo nuevo: 403 y no se crea nada', async () => {
      const body = alta('plain', {
        parentTenantId: agency,
        adminEmail: `ta-nadie-${sfx}@test.local`,
        adminPassword: clave,
      });
      expect(await rejection(service.create(agencyPlainAdmin, body))).toBe(
        '403/ROLE_NOT_GRANTABLE',
      );
      expect(await slugExists(body.slug)).toBe(false);

      const sinAdmin = await service.create(
        agencyPlainAdmin,
        alta('plain-ok', { parentTenantId: agency }),
      );
      expect(sinAdmin.tenant.tenantType).toBe('subagency');
    });

    it('un email que ya tiene cuenta no se vincula: se le invita y su contraseña no se toca', async () => {
      const email = `ta-agency-admin-${sfx}@test.local`;
      const res = await service.create(
        superadmin,
        alta('existente', { adminEmail: email, adminName: 'Otro nombre', adminPassword: clave }),
      );

      expect(res.admin).toEqual({ email, role: 'tenant_admin', status: 'invited' });
      expect(await membershipRole(res.tenant.id, email)).toBeUndefined();
      const { rows: inv } = await pool.query<{ role: string; accepted_at: Date | null }>(
        'SELECT role, accepted_at FROM user_invitations WHERE tenant_id = $1 AND email = $2',
        [res.tenant.id, email],
      );
      expect(inv).toEqual([{ role: 'tenant_admin', accepted_at: null }]);
      const { rows: u } = await pool.query<{ password_hash: string; name: string | null }>(
        'SELECT password_hash, name FROM users WHERE email = $1',
        [email],
      );
      expect(u[0]).toEqual({ password_hash: 'hash-original', name: null });
      expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
      expect((await events('TenantCreated', res.tenant.id))[0]!.payload).toMatchObject({
        admin: 'invited',
      });
    });

    it('sin contraseña, el admin nuevo también se invita', async () => {
      const email = `ta-sin-clave-${sfx}@test.local`;
      const res = await service.create(
        consAdmin,
        alta('sin-clave', { parentTenantId: cons, adminEmail: email }),
      );

      expect(res.admin).toEqual({ email, role: 'tenant_admin', status: 'invited' });
      const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
      expect(rows).toHaveLength(0);
    });
  });

  describe('roleOver: el rango se mide sobre el nodo destino (G-06)', () => {
    it('el de más rango entre las memberships que administran el destino o un ancestro', async () => {
      const sub = await tenant('ro-sub', 'subagency', otherAgency);

      expect(await network.roleOver(crossNetwork, agency)).toBe('consolidator_admin');
      // En la otra red es `admin`, aunque en su tenant activo sea consolidator_admin.
      expect(await network.roleOver(crossNetwork, sub)).toBe('admin');
      expect(await network.roleOver(crossNetwork, platform)).toBeUndefined();
      expect(await network.roleOver(superadmin, sub)).toBe('superadmin');
      expect(await network.roleOver(agencyAdmin, cons)).toBeUndefined();
    });

    it('una membership suspendida no cuenta', async () => {
      const u = await user('ro-susp');
      await member(agency, u, 'tenant_admin', 'suspended');
      expect(await network.roleOver(u, agency)).toBeUndefined();
    });

    it('una membership en un nodo suspendido (o bajo uno suspendido) no da potestad; su ancestro sí', async () => {
      const a = await tenant('ro-na', 'agency', platform);
      const s = await tenant('ro-ns', 'subagency', a);
      const adminA = await user('ro-na-admin');
      await member(a, adminA, 'tenant_admin');
      // Opera además en otra red: su tenant activo puede estar sano aunque `a` esté suspendido.
      await member(otherAgency, adminA, 'vendedor');

      expect(await network.roleOver(adminA, s)).toBe('tenant_admin');
      expect(await network.canManageTenant(adminA, s)).toBe(true);

      await pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [a]);
      expect(await network.roleOver(adminA, a)).toBeUndefined();
      expect(await network.roleOver(adminA, s)).toBeUndefined();
      expect(await network.canManageTenant(adminA, s)).toBe(false);
      expect(await network.roleOver(platformAdmin, a)).toBe('consolidator_admin');
      expect(await network.canManageTenant(platformAdmin, s)).toBe(true);

      await pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [a]);
      expect(await network.roleOver(adminA, s)).toBe('tenant_admin');
    });
  });

  describe('corrección de un nodo (PATCH)', () => {
    it('suspender corta el rol del nodo y de su red; reactivar lo devuelve; todo auditado', async () => {
      const a = await tenant('susp-a', 'agency', platform);
      const s = await tenant('susp-s', 'subagency', a);
      const vendedor = await user('susp-v');
      await member(s, vendedor, 'vendedor');
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, tenant_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')
         RETURNING id`,
        [vendedor, s],
      );
      const sesion = { sessionId: rows[0]!.id, userId: vendedor, tenantId: s };
      expect(await sessions.validate(sesion)).toEqual({ role: 'vendedor' });

      const suspended = await service.update(superadmin, a, { status: 'suspended' });
      expect(suspended).toMatchObject({ id: a, status: 'suspended' });
      expect(await sessions.validate(sesion)).toEqual({});

      await service.update(superadmin, a, { status: 'active' });
      expect(await sessions.validate(sesion)).toEqual({ role: 'vendedor' });

      const log = await events('tenant.updated', a);
      expect(log).toEqual([
        {
          actor_user_id: superadmin,
          tenant_id: a,
          payload: {
            changed: ['status'],
            before: { status: 'active' },
            after: { status: 'suspended' },
          },
        },
        {
          actor_user_id: superadmin,
          tenant_id: a,
          payload: {
            changed: ['status'],
            before: { status: 'suspended' },
            after: { status: 'active' },
          },
        },
      ]);
    });

    it('sucursal y tipo, dentro de D4; lo que la viola es 409 y no deja evento', async () => {
      const a = await tenant('fix-a', 'agency', platform);
      const deCons = await tenant('fix-c', 'agency', cons);

      expect(await service.update(superadmin, a, { isBranch: true })).toMatchObject({
        isBranch: true,
      });
      expect(await rejection(service.update(superadmin, deCons, { isBranch: true }))).toBe(
        '409/TENANT_BRANCH_PARENT',
      );
      expect(await rejection(service.update(superadmin, a, { tenantType: 'consolidator' }))).toBe(
        '409/TENANT_BRANCH_TYPE',
      );
      expect(
        await service.update(superadmin, a, { isBranch: false, tenantType: 'consolidator' }),
      ).toMatchObject({ isBranch: false, tenantType: 'consolidator' });
      expect(await events('tenant.updated', deCons)).toEqual([]);

      const conHija = await tenant('fix-h', 'agency', platform);
      await tenant('fix-hs', 'subagency', conHija);
      expect(
        await rejection(service.update(superadmin, conHija, { tenantType: 'consolidator' })),
      ).toBe('409/TENANT_CHILDREN_TYPE');
      expect((await row(conHija))!.tenant_type).toBe('agency');

      const log = await events('tenant.updated', a);
      expect(log.map((e) => e.payload)).toEqual([
        { changed: ['isBranch'], before: { isBranch: false }, after: { isBranch: true } },
        {
          changed: ['isBranch', 'tenantType'],
          before: { isBranch: true, tenantType: 'agency' },
          after: { isBranch: false, tenantType: 'consolidator' },
        },
      ]);
    });

    it('un consolidador con reservas abiertas hechas con sus credenciales no deja de serlo', async () => {
      const c = await tenant('fix-tbo', 'consolidator', platform);
      const { rows: acc } = await pool.query<{ id: string }>(
        `INSERT INTO provider_accounts (tenant_id, provider_code, credentials_enc, is_inheritable, status)
         VALUES ($1, 'tbo-hotels', '\\x00'::bytea, true, 'active') RETURNING id`,
        [c],
      );
      const accountId = acc[0]!.id;
      const { rows: ord } = await pool.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                             contact_info, total_amount, order_number, status, provider_account_id)
         VALUES ($1, $2, 'tbo-hotels', '{}'::jsonb, '{}', '[]', '{}', 100, 1, 'confirmed', $3)
         RETURNING id`,
        [c, superadmin, accountId],
      );
      const orderId = ord[0]!.id;

      try {
        expect(await rejection(service.update(superadmin, c, { tenantType: 'agency' }))).toBe(
          '409/TENANT_TYPE_OPEN_BOOKINGS',
        );
        expect((await row(c))!.tenant_type).toBe('consolidator');
        expect(await events('tenant.updated', c)).toEqual([]);
        // Suspenderlo no toca su post-venta: pasa.
        expect(await service.update(superadmin, c, { status: 'suspended' })).toMatchObject({
          status: 'suspended',
        });

        await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
        expect(
          await service.update(superadmin, c, { tenantType: 'agency', status: 'active' }),
        ).toMatchObject({ tenantType: 'agency', status: 'active' });
      } finally {
        await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        await pool.query('DELETE FROM provider_accounts WHERE id = $1', [accountId]);
      }
    });

    it('la plataforma no se suspende ni cambia de tipo', async () => {
      expect(await rejection(service.update(superadmin, platform, { status: 'suspended' }))).toBe(
        '409/TENANT_PLATFORM_LOCKED',
      );
      expect(await rejection(service.update(superadmin, platform, { tenantType: 'agency' }))).toBe(
        '409/TENANT_ROOT_MUST_BE_PLATFORM',
      );
      expect(await row(platform)).toMatchObject({ tenant_type: 'platform', status: 'active' });
    });

    it('sin cambios no hay evento; un nodo que no existe es 404', async () => {
      const a = await tenant('noop', 'agency', platform);
      expect(
        await service.update(superadmin, a, { status: 'active', isBranch: false }),
      ).toMatchObject({
        status: 'active',
      });
      expect(await events('tenant.updated', a)).toEqual([]);
      expect(
        await rejection(
          service.update(superadmin, '00000000-0000-4000-8000-000000000000', { status: 'active' }),
        ),
      ).toBe('404/TENANT_NOT_FOUND');
    });
  });

  describe('mover un nodo (D6 A)', () => {
    it('Amazon, agencia raíz suelta, pasa bajo la plataforma: un solo evento, con el actor', async () => {
      const c = await pool.connect();
      let amazon: string;
      try {
        amazon = await legacyTenant(c, slug('amazon-move'), 'agency');
      } finally {
        c.release();
      }
      const hija = await tenant('amazon-hija', 'subagency', amazon);

      const res = await service.move(superadmin, amazon, platform);

      expect(res).toEqual({
        moved: 2,
        tenant: expect.objectContaining({
          id: amazon,
          parentTenantId: platform,
          depth: 2,
        }) as unknown,
      });
      expect((await row(hija))!.depth).toBe(3);
      expect(await events('tenant.moved', amazon)).toEqual([
        {
          actor_user_id: superadmin,
          tenant_id: amazon,
          payload: {
            fromParentId: null,
            toParentId: platform,
            movedTenants: 2,
            source: 'move_tenant_subtree',
          },
        },
      ]);
      expect(enablement.invalidate).toHaveBeenCalledTimes(1);
    });

    it('al padre que ya tiene no hace nada ni olvida la caché', async () => {
      const a = await tenant('mv-noop', 'agency', platform);
      expect((await service.move(superadmin, a, platform)).moved).toBe(0);
      expect(enablement.invalidate).not.toHaveBeenCalled();
    });

    it('los errores de la base salen con su motivo', async () => {
      const c1 = await tenant('mv-c1', 'consolidator', platform);
      const a = await tenant('mv-a', 'agency', c1);

      expect(await rejection(service.move(superadmin, c1, a))).toBe('409/TENANT_MOVE_CYCLE');
      expect(await rejection(service.move(superadmin, a, otherAgency))).toBe(
        '409/TENANT_PARENT_TYPE',
      );
      expect(
        await rejection(service.move(superadmin, '00000000-0000-4000-8000-000000000000', platform)),
      ).toBe('404/TENANT_NOT_FOUND');
      expect((await row(a))!.parent_tenant_id).toBe(c1);
      expect(enablement.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('la red para el superadmin', () => {
    it('trae tipo, sucursal, padre, su nombre y profundidad', async () => {
      const branch = await tenant('list-b', 'agency', platform);
      await pool.query('UPDATE tenants SET is_branch = true WHERE id = $1', [branch]);

      const nodes = await service.listNetwork(superadmin);
      const byId = new Map(nodes.map((n) => [n.id, n]));

      expect(byId.get(platform)).toMatchObject({
        tenantType: 'platform',
        parentTenantId: null,
        depth: 1,
      });
      expect(byId.get(branch)).toMatchObject({
        tenantType: 'agency',
        isBranch: true,
        parentTenantId: platform,
        depth: 2,
      });
      expect(byId.get(agency)).toMatchObject({
        tenantType: 'agency',
        parentTenantId: cons,
        parentName: slug('cons'),
        depth: 3,
      });
      expect(byId.get(agency)!.userCount).toBeGreaterThanOrEqual(2);

      const mine = await network.listNetwork(superadmin);
      expect(mine.find((n) => n.id === branch)).toMatchObject({ isBranch: true });
    });
  });
});
