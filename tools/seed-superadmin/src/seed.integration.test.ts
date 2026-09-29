import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSeedEnv, type SeedSettings } from './env.js';
import { SeedConfigError, SeedRefusedError } from './errors.js';
import { SEED_EVENTS, SEED_SOURCE, runSeed, seedSuperadmin, type PasswordHasher } from './seed.js';

/**
 * El seed contra Postgres con todas las migraciones, como corre en el VPS.
 *
 * Se SALTA sin `PGHOST`/`PGUSER`/`PGPASSWORD`, como los demás `*.integration.test.ts`; en CI corre
 * con el superusuario contra la base migrada que comparten, en paralelo, los tests de `apps/api` y
 * de los otros tools. Esa base tiene UNA plataforma (0050) y nadie puede tocarla, así que cada caso
 * corre en una transacción que se deshace al final (`sandbox`). Los que necesitan una base SIN
 * plataforma —la de producción antes de 0049, o una nueva— la ocultan dentro de su transacción. Sólo
 * el último caso confirma, para probar `runSeed` de punta a punta.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const SUFFIX = randomBytes(4).toString('hex');
const PASSWORD = 'contraseña-del-superadmin';

/** bcrypt de verdad costaría ~250 ms por llamada; el costo del api lo fija `bcryptHasher`. */
const fakeHasher: PasswordHasher = { hash: (password) => Promise.resolve(`fake$${password}`) };

let client: pg.Client;
const committedUsers: string[] = [];

function settings(
  overrides: {
    slug?: string;
    email?: string;
    password?: string;
    name?: string;
    tenantName?: string;
  } = {},
): SeedSettings {
  return resolveSeedEnv({
    PGHOST: 'x',
    PGUSER: 'x',
    PGPASSWORD: 'x',
    PGDATABASE: 'x',
    SUPERADMIN_EMAIL: overrides.email ?? `root-${SUFFIX}@example.com`,
    SUPERADMIN_PASSWORD: overrides.password ?? '',
    SUPERADMIN_NAME: overrides.name ?? '',
    SUPERADMIN_TENANT_SLUG: overrides.slug ?? `sa-it-${SUFFIX}`,
    SUPERADMIN_TENANT_NAME: overrides.tenantName ?? '',
  });
}

async function q<R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
  return (await client.query<R>(text, values)).rows;
}

/**
 * Una transacción que se deshace siempre. Con `withoutPlatform`, la plataforma de la base pasa a
 * 'agency' con los triggers apagados SÓLO para ese UPDATE (`session_replication_role`, superusuario):
 * dentro, la base se ve como producción antes de 0049. Quien quiera colgarle un hijo o crear otra
 * plataforma mientras tanto espera al ROLLBACK, que la deja como estaba.
 */
async function sandbox(fn: () => Promise<void>, opts: { withoutPlatform?: boolean } = {}) {
  await client.query('BEGIN');
  try {
    if (opts.withoutPlatform === true) {
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `UPDATE tenants SET tenant_type = 'agency' WHERE tenant_type = 'platform'`,
      );
      await client.query('SET LOCAL session_replication_role = origin');
    }
    await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/**
 * Un nodo que la matriz D4 (0050) ya no deja crear, como la raíz 'agency' de Planetour o de Amazon
 * Minimalist en producción: se inserta con los triggers apagados y el `path` que le ponía 0011.
 * Sólo dentro de `sandbox`.
 */
async function legacyRoot(slug: string, name = slug): Promise<string> {
  const id = randomUUID();
  await client.query('SET LOCAL session_replication_role = replica');
  await client.query(
    `INSERT INTO tenants (id, slug, name, country_code, default_currency, tenant_type, path)
     VALUES ($1::uuid, $2, $3, 'CO', 'COP', 'agency', replace($1::text, '-', '')::ltree)`,
    [id, slug, name],
  );
  await client.query('SET LOCAL session_replication_role = origin');
  return id;
}

async function child(slug: string, type: string, parentId: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
     VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
    [slug, type, parentId],
  );
  return row!.id;
}

async function user(email: string, hash: string, name: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id`,
    [email, hash, name],
  );
  return row!.id;
}

interface EventRow {
  event_type: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  aggregate_type: string;
  payload: Record<string, unknown>;
}

async function eventsOf(aggregateId: string): Promise<EventRow[]> {
  return q<EventRow>(
    `SELECT event_type, tenant_id, actor_user_id, aggregate_type, payload FROM domain_events
      WHERE aggregate_id = $1 ORDER BY event_type`,
    [aggregateId],
  );
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SeedRefusedError) return err.reason;
    throw err;
  }
  throw new Error('esperaba SeedRefusedError');
}

d('seed-superadmin contra Postgres', () => {
  beforeAll(async () => {
    client = new pg.Client();
    await client.connect();
    // La plataforma común de la base de pruebas, como apps/api/src/__fixtures__/platform-root.ts:
    // que exista antes de los casos evita una carrera con el primer test de la API que la crea.
    await client.query(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type)
       VALUES ('it-platform', 'Plataforma de pruebas', 'CO', 'COP', 'platform')
       ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    if (client === undefined) return;
    for (const id of committedUsers) {
      await client.query('DELETE FROM users WHERE id = $1', [id]).catch(() => undefined);
    }
    await client.end();
  });

  it('producción: promueve la raíz sin renombrarla y el consolidator_admin pasa a superadmin', async () => {
    await sandbox(
      async () => {
        const planetour = await legacyRoot(`sa-it-${SUFFIX}`, 'Mayorista de prueba S.A.S');
        const amazon = await legacyRoot(`sa-it-amazon-${SUFFIX}`);
        const founder = await user(`root-${SUFFIX}@example.com`, 'hash-previo', 'Nombre previo');
        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role, status)
           VALUES ($1, $2, 'consolidator_admin', 'active')`,
          [planetour, founder],
        );

        // La contraseña llega (como la mandaría un operador que no sabe si la cuenta existe) y no
        // se usa: la cuenta ya es de alguien.
        const report = await seedSuperadmin(client, settings({ password: PASSWORD }), fakeHasher);

        expect(report).toEqual({
          tenantId: planetour,
          tenantSlug: `sa-it-${SUFFIX}`,
          tenant: 'promoted',
          previousTenantType: 'agency',
          tenantStatus: 'active',
          userId: founder,
          user: 'existing',
          userStatus: 'active',
          membership: 'updated',
          previousRole: 'consolidator_admin',
          passwordIgnored: true,
        });
        expect(
          await q(
            `SELECT tenant_type, name, status, parent_tenant_id, nlevel(path) AS depth
               FROM tenants WHERE id = $1`,
            [planetour],
          ),
        ).toEqual([
          {
            tenant_type: 'platform',
            name: 'Mayorista de prueba S.A.S',
            status: 'active',
            parent_tenant_id: null,
            depth: 1,
          },
        ]);
        expect(await q('SELECT password_hash, name FROM users WHERE id = $1', [founder])).toEqual([
          { password_hash: 'hash-previo', name: 'Nombre previo' },
        ]);
        expect(
          await q('SELECT tenant_id, role, status FROM memberships WHERE user_id = $1', [founder]),
        ).toEqual([{ tenant_id: planetour, role: 'superadmin', status: 'active' }]);

        const [membershipId] = (
          await q<{ id: string }>('SELECT id FROM memberships WHERE user_id = $1', [founder])
        ).map((r) => r.id);
        expect(await eventsOf(planetour)).toEqual([
          {
            event_type: SEED_EVENTS.tenantPromoted,
            tenant_id: planetour,
            actor_user_id: null,
            aggregate_type: 'tenant',
            payload: { from: 'agency', to: 'platform', source: SEED_SOURCE },
          },
        ]);
        expect(await eventsOf(membershipId!)).toEqual([
          {
            event_type: SEED_EVENTS.roleGranted,
            tenant_id: planetour,
            actor_user_id: null,
            aggregate_type: 'membership',
            payload: {
              targetUserId: founder,
              newRole: 'superadmin',
              before: { role: 'consolidator_admin', status: 'active' },
              after: { role: 'superadmin', status: 'active' },
              source: SEED_SOURCE,
            },
          },
        ]);

        // Idempotente: la segunda corrida no escribe nada, tampoco auditoría.
        const again = await seedSuperadmin(client, settings({ password: PASSWORD }), fakeHasher);
        expect(again).toMatchObject({
          tenant: 'unchanged',
          previousTenantType: null,
          membership: 'unchanged',
          previousRole: 'superadmin',
        });
        expect(await eventsOf(planetour)).toHaveLength(1);
        expect(await eventsOf(membershipId!)).toHaveLength(1);

        // La otra raíz suelta no se toca; el paso siguiente (colgarla de Planetour, D6 A) ya se
        // puede dar porque ahora hay plataforma.
        expect(
          await q('SELECT tenant_type, parent_tenant_id FROM tenants WHERE id = $1', [amazon]),
        ).toEqual([{ tenant_type: 'agency', parent_tenant_id: null }]);
        await client.query('SELECT move_tenant_subtree($1::uuid, $2::uuid)', [amazon, planetour]);
        expect(await q('SELECT parent_tenant_id FROM tenants WHERE id = $1', [amazon])).toEqual([
          { parent_tenant_id: planetour },
        ]);
      },
      { withoutPlatform: true },
    );
  });

  it('base nueva: crea la plataforma y el usuario, y la segunda corrida no rota la contraseña', async () => {
    await sandbox(
      async () => {
        const s = settings({
          password: PASSWORD,
          name: 'Operador de prueba',
          tenantName: 'Plataforma nueva',
        });
        const report = await seedSuperadmin(client, s, fakeHasher);
        expect(report).toMatchObject({
          tenant: 'created',
          previousTenantType: null,
          tenantStatus: 'active',
          user: 'created',
          userStatus: 'active',
          membership: 'created',
          previousRole: null,
          passwordIgnored: false,
        });

        expect(
          await q(
            `SELECT slug::text AS slug, name, tenant_type, parent_tenant_id, country_code,
                    default_currency, is_branch
               FROM tenants WHERE id = $1`,
            [report.tenantId],
          ),
        ).toEqual([
          {
            slug: `sa-it-${SUFFIX}`,
            name: 'Plataforma nueva',
            tenant_type: 'platform',
            parent_tenant_id: null,
            country_code: 'CO',
            default_currency: 'USD',
            is_branch: false,
          },
        ]);
        expect(
          await q(
            `SELECT email::text AS email, password_hash, name, status,
                    email_verified_at IS NOT NULL AS verified
               FROM users WHERE id = $1`,
            [report.userId],
          ),
        ).toEqual([
          {
            email: `root-${SUFFIX}@example.com`,
            password_hash: `fake$${PASSWORD}`,
            name: 'Operador de prueba',
            status: 'active',
            verified: true,
          },
        ]);
        expect(
          await q('SELECT tenant_id, role, status FROM memberships WHERE user_id = $1', [
            report.userId,
          ]),
        ).toEqual([{ tenant_id: report.tenantId, role: 'superadmin', status: 'active' }]);

        const tenantEvents = await eventsOf(report.tenantId);
        expect(tenantEvents.map((e) => e.event_type)).toEqual([SEED_EVENTS.tenantCreated]);
        expect(tenantEvents[0]?.payload).toEqual({
          slug: `sa-it-${SUFFIX}`,
          tenantType: 'platform',
          isBranch: false,
          parentTenantId: null,
          source: SEED_SOURCE,
        });
        const userEvents = await eventsOf(report.userId);
        expect(userEvents).toEqual([
          {
            event_type: SEED_EVENTS.userCreated,
            tenant_id: report.tenantId,
            actor_user_id: null,
            aggregate_type: 'user',
            payload: { role: 'superadmin', existingUserLinked: false, source: SEED_SOURCE },
          },
        ]);
        // Ni el correo ni la contraseña en la auditoría del seed.
        const audit = JSON.stringify(
          await q(`SELECT payload FROM domain_events WHERE tenant_id = $1`, [report.tenantId]),
        );
        expect(audit).not.toContain(`root-${SUFFIX}@example.com`);
        expect(audit).not.toContain(PASSWORD);

        const again = await seedSuperadmin(
          client,
          settings({ password: 'otra-contraseña-larga', name: 'Otro nombre', tenantName: 'Otro' }),
          fakeHasher,
        );
        expect(again).toMatchObject({
          tenantId: report.tenantId,
          tenant: 'unchanged',
          userId: report.userId,
          user: 'existing',
          membership: 'unchanged',
          passwordIgnored: true,
        });
        expect(
          await q('SELECT password_hash, name FROM users WHERE id = $1', [report.userId]),
        ).toEqual([{ password_hash: `fake$${PASSWORD}`, name: 'Operador de prueba' }]);
        expect(await q('SELECT name FROM tenants WHERE id = $1', [report.tenantId])).toEqual([
          { name: 'Plataforma nueva' },
        ]);
      },
      { withoutPlatform: true },
    );
  });

  it('base nueva sin SUPERADMIN_TENANT_NAME ni datos del usuario: lo pide todo y no crea nada', async () => {
    await sandbox(
      async () => {
        let issues: readonly string[] = [];
        try {
          await seedSuperadmin(client, settings(), fakeHasher);
        } catch (err) {
          if (!(err instanceof SeedConfigError)) throw err;
          issues = err.issues;
        }
        expect(issues).toEqual([
          'SUPERADMIN_TENANT_NAME:required_to_create_tenant',
          'SUPERADMIN_PASSWORD:required_to_create_user',
          'SUPERADMIN_NAME:required_to_create_user',
        ]);
        expect(await q('SELECT 1 FROM tenants WHERE slug = $1', [`sa-it-${SUFFIX}`])).toEqual([]);
        expect(await q(`SELECT 1 FROM tenants WHERE tenant_type = 'platform'`)).toEqual([]);
      },
      { withoutPlatform: true },
    );
  });

  it('reactiva la membership superadmin suspendida y deja el antes y el después', async () => {
    await sandbox(async () => {
      const [platform] = await q<{ id: string; slug: string }>(
        `SELECT id, slug::text AS slug FROM tenants WHERE tenant_type = 'platform'`,
      );
      const operator = await user(`root-${SUFFIX}@example.com`, 'hash-previo', 'Nombre previo');
      const [membership] = await q<{ id: string }>(
        `INSERT INTO memberships (tenant_id, user_id, role, status)
         VALUES ($1, $2, 'superadmin', 'suspended') RETURNING id`,
        [platform!.id, operator],
      );

      const report = await seedSuperadmin(client, settings({ slug: platform!.slug }), fakeHasher);

      expect(report).toMatchObject({
        tenant: 'unchanged',
        user: 'existing',
        membership: 'updated',
        previousRole: 'superadmin',
      });
      expect(
        await q('SELECT role, status FROM memberships WHERE id = $1', [membership!.id]),
      ).toEqual([{ role: 'superadmin', status: 'active' }]);
      expect((await eventsOf(membership!.id)).map((e) => e.payload)).toEqual([
        {
          targetUserId: operator,
          newRole: 'superadmin',
          before: { role: 'superadmin', status: 'suspended' },
          after: { role: 'superadmin', status: 'active' },
          source: SEED_SOURCE,
        },
      ]);
    });
  });

  it('se niega si el tenant cuelga de otro nodo, sin tocarlo', async () => {
    await sandbox(async () => {
      const [platform] = await q<{ id: string }>(
        `SELECT id FROM tenants WHERE tenant_type = 'platform'`,
      );
      const agency = await child(`sa-it-${SUFFIX}`, 'agency', platform!.id);
      await user(`root-${SUFFIX}@example.com`, 'hash-previo', 'Nombre previo');
      expect(await reasonOf(seedSuperadmin(client, settings(), fakeHasher))).toBe(
        'tenant_has_parent',
      );
      expect(
        await q('SELECT tenant_type, parent_tenant_id FROM tenants WHERE id = $1', [agency]),
      ).toEqual([{ tenant_type: 'agency', parent_tenant_id: platform!.id }]);
    });
  });

  it('se niega si la base ya tiene otra plataforma, y dice cuál', async () => {
    await sandbox(async () => {
      const [platform] = await q<{ slug: string }>(
        `SELECT slug::text AS slug FROM tenants WHERE tenant_type = 'platform'`,
      );
      await user(`root-${SUFFIX}@example.com`, 'hash-previo', 'Nombre previo');

      // El slug no existe: no se crea una segunda raíz.
      await expect(
        seedSuperadmin(client, settings({ tenantName: 'Segunda raíz' }), fakeHasher),
      ).rejects.toMatchObject({
        reason: 'another_platform',
        message: expect.stringContaining(`SUPERADMIN_TENANT_SLUG=${platform!.slug}`) as unknown,
      });
      expect(await q('SELECT 1 FROM tenants WHERE slug = $1', [`sa-it-${SUFFIX}`])).toEqual([]);

      // El slug es una raíz suelta: no se promueve.
      const loose = await legacyRoot(`sa-it-${SUFFIX}`);
      expect(await reasonOf(seedSuperadmin(client, settings(), fakeHasher))).toBe(
        'another_platform',
      );
      expect(await q('SELECT tenant_type FROM tenants WHERE id = $1', [loose])).toEqual([
        { tenant_type: 'agency' },
      ]);
    });
  });

  it('se niega a promover una raíz con sub-agencias, que no pueden colgar de la plataforma', async () => {
    await sandbox(
      async () => {
        const root = await legacyRoot(`sa-it-${SUFFIX}`);
        await child(`sa-it-sub-${SUFFIX}`, 'subagency', root);
        await user(`root-${SUFFIX}@example.com`, 'hash-previo', 'Nombre previo');
        await expect(seedSuperadmin(client, settings(), fakeHasher)).rejects.toMatchObject({
          reason: 'tenant_promotion_blocked',
          message: expect.stringContaining('hijos') as unknown,
        });
      },
      { withoutPlatform: true },
    );
  });

  it('sin superusuario no lee ni escribe', async () => {
    await sandbox(async () => {
      await client.query('SET LOCAL ROLE app_user');
      expect(await reasonOf(seedSuperadmin(client, settings(), fakeHasher))).toBe('not_privileged');
    });
  });

  it('runSeed confirma en la plataforma de la base y una segunda corrida no cambia nada', async () => {
    const [platform] = await q<{ id: string; slug: string }>(
      `SELECT id, slug::text AS slug FROM tenants WHERE tenant_type = 'platform'`,
    );
    const email = `root-commit-${SUFFIX}@example.com`;
    const s = settings({ slug: platform!.slug, email, password: PASSWORD, name: 'Operador' });

    const report = await runSeed(client, s, fakeHasher);
    committedUsers.push(report.userId);
    expect(report).toMatchObject({
      tenantId: platform!.id,
      tenant: 'unchanged',
      user: 'created',
      membership: 'created',
    });
    expect(
      await q('SELECT role, status FROM memberships WHERE tenant_id = $1 AND user_id = $2', [
        platform!.id,
        report.userId,
      ]),
    ).toEqual([{ role: 'superadmin', status: 'active' }]);

    const again = await runSeed(client, s, fakeHasher);
    expect(again).toMatchObject({ tenant: 'unchanged', user: 'existing', membership: 'unchanged' });
    const [membership] = await q<{ id: string }>('SELECT id FROM memberships WHERE user_id = $1', [
      report.userId,
    ]);
    expect(await eventsOf(membership!.id)).toHaveLength(1);
  });
});
