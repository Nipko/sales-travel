import { describe, expect, it } from 'vitest';
import { resolveSeedEnv, type SeedSettings } from './env.js';
import { SeedConfigError, SeedRefusedError } from './errors.js';
import { SEED_EVENTS, SEED_SOURCE, runSeed, seedSuperadmin, type PasswordHasher } from './seed.js';
import { fakeSession, writes, type FakeState } from './testing/fake-session.js';

const PASSWORD = 'contraseña-del-superadmin';

function settings(overrides: Record<string, string> = {}): SeedSettings {
  return resolveSeedEnv({
    PGHOST: 'postgres',
    PGUSER: 'postgres',
    PGPASSWORD: 'x',
    PGDATABASE: 'sales_travel',
    SUPERADMIN_EMAIL: 'root@example.com',
    ...overrides,
  });
}

function hasher(): PasswordHasher & { calls: number } {
  const h = {
    calls: 0,
    hash: (password: string) => {
      h.calls += 1;
      return Promise.resolve(`hash(${password.length})`);
    },
  };
  return h;
}

/** Producción al 2026-09-28: Planetour raíz `agency` y el founder `consolidator_admin` en ella. */
const PRODUCTION: FakeState = {
  tenant: { id: 'planetour', tenant_type: 'agency', parent_tenant_id: null, status: 'active' },
  user: { id: 'founder', status: 'active' },
  membership: { id: 'm-founder', role: 'consolidator_admin', status: 'active' },
};

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SeedRefusedError) return err.reason;
    throw err;
  }
  throw new Error('esperaba SeedRefusedError');
}

async function issuesOf(promise: Promise<unknown>): Promise<readonly string[]> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SeedConfigError) return err.issues;
    throw err;
  }
  throw new Error('esperaba SeedConfigError');
}

describe('seedSuperadmin', () => {
  it('con los datos de producción promueve la raíz sin renombrarla y da el rol sin tocar la cuenta', async () => {
    const db = fakeSession(PRODUCTION);
    const h = hasher();

    const report = await seedSuperadmin(db, settings({ SUPERADMIN_PASSWORD: PASSWORD }), h);

    expect(report).toEqual({
      tenantId: 'planetour',
      tenantSlug: 'platform',
      tenant: 'promoted',
      previousTenantType: 'agency',
      tenantStatus: 'active',
      userId: 'founder',
      user: 'existing',
      userStatus: 'active',
      membership: 'updated',
      previousRole: 'consolidator_admin',
      passwordIgnored: true,
    });
    // Sólo el tipo: ni nombre, ni estado, ni la contraseña del usuario.
    const promote = db.calls.find((c) => c.text.startsWith('UPDATE tenants'));
    expect(promote?.text).toBe(`UPDATE tenants SET tenant_type = 'platform' WHERE id = $1`);
    expect(writes(db)).toEqual([
      'UPDATE tenants',
      'INSERT INTO',
      'UPDATE memberships',
      'INSERT INTO',
    ]);
    expect(db.calls.some((c) => c.text.startsWith('INSERT INTO users'))).toBe(false);
    expect(h.calls).toBe(0);
    expect(db.events).toEqual([
      {
        type: SEED_EVENTS.tenantPromoted,
        payload: { from: 'agency', to: 'platform', source: SEED_SOURCE },
      },
      {
        type: SEED_EVENTS.roleGranted,
        payload: {
          targetUserId: 'founder',
          newRole: 'superadmin',
          before: { role: 'consolidator_admin', status: 'active' },
          after: { role: 'superadmin', status: 'active' },
          source: SEED_SOURCE,
        },
      },
    ]);
  });

  it('si ya está hecho no escribe nada', async () => {
    const db = fakeSession({
      tenant: { ...PRODUCTION.tenant!, tenant_type: 'platform' },
      user: PRODUCTION.user!,
      membership: { id: 'm-founder', role: 'superadmin', status: 'active' },
    });
    const report = await seedSuperadmin(db, settings(), hasher());
    expect(report).toMatchObject({
      tenant: 'unchanged',
      previousTenantType: null,
      user: 'existing',
      membership: 'unchanged',
      previousRole: 'superadmin',
      passwordIgnored: false,
    });
    expect(writes(db)).toEqual([]);
  });

  it('en una base vacía crea la plataforma y el usuario, sin el correo en la auditoría', async () => {
    const db = fakeSession({});
    const h = hasher();
    const report = await seedSuperadmin(
      db,
      settings({
        SUPERADMIN_PASSWORD: PASSWORD,
        SUPERADMIN_NAME: 'Operador',
        SUPERADMIN_TENANT_NAME: 'Mayorista de prueba',
      }),
      h,
    );
    expect(report).toMatchObject({ tenant: 'created', user: 'created', membership: 'created' });
    expect(h.calls).toBe(1);
    const insertUser = db.calls.find((c) => c.text.startsWith('INSERT INTO users'));
    expect(insertUser?.values).toEqual([
      'root@example.com',
      `hash(${PASSWORD.length})`,
      'Operador',
    ]);
    expect(db.events.map((e) => e.type)).toEqual([
      SEED_EVENTS.tenantCreated,
      SEED_EVENTS.userCreated,
      SEED_EVENTS.roleGranted,
    ]);
    const audit = JSON.stringify(db.events);
    expect(audit).not.toContain('root@example.com');
    expect(audit).not.toContain(PASSWORD);
  });

  it('pide de una vez todo lo que falta para crear, antes de escribir', async () => {
    const db = fakeSession({});
    expect(await issuesOf(seedSuperadmin(db, settings(), hasher()))).toEqual([
      'SUPERADMIN_TENANT_NAME:required_to_create_tenant',
      'SUPERADMIN_PASSWORD:required_to_create_user',
      'SUPERADMIN_NAME:required_to_create_user',
    ]);
    expect(writes(db)).toEqual([]);
  });

  it('no pide contraseña ni nombre si el usuario ya existe', async () => {
    const db = fakeSession({ ...PRODUCTION, membership: undefined });
    const report = await seedSuperadmin(db, settings(), hasher());
    expect(report).toMatchObject({ user: 'existing', membership: 'created', previousRole: null });
  });

  it('un superadmin suspendido no cuenta como hecho: lo reactiva y lo audita', async () => {
    const db = fakeSession({
      ...PRODUCTION,
      tenant: { ...PRODUCTION.tenant!, tenant_type: 'platform' },
      membership: { id: 'm-founder', role: 'superadmin', status: 'suspended' },
    });
    const report = await seedSuperadmin(db, settings(), hasher());
    expect(report).toMatchObject({ membership: 'updated', previousRole: 'superadmin' });
    const update = db.calls.find((c) => c.text.startsWith('UPDATE memberships'));
    expect(update?.text).toBe(
      `UPDATE memberships SET role = 'superadmin', status = 'active' WHERE id = $1 RETURNING id`,
    );
    expect(db.events).toEqual([
      {
        type: SEED_EVENTS.roleGranted,
        payload: {
          targetUserId: 'founder',
          newRole: 'superadmin',
          before: { role: 'superadmin', status: 'suspended' },
          after: { role: 'superadmin', status: 'active' },
          source: SEED_SOURCE,
        },
      },
    ]);
  });

  it('se niega, sin escribir, si el tenant cuelga de otro nodo', async () => {
    const db = fakeSession({
      ...PRODUCTION,
      tenant: { ...PRODUCTION.tenant!, parent_tenant_id: 'otro' },
    });
    expect(await reasonOf(seedSuperadmin(db, settings(), hasher()))).toBe('tenant_has_parent');
    expect(writes(db)).toEqual([]);
  });

  it('se niega, sin escribir, si la base ya tiene otra plataforma', async () => {
    const promote = fakeSession({ ...PRODUCTION, otherPlatform: 'otra-raiz' });
    expect(await reasonOf(seedSuperadmin(promote, settings(), hasher()))).toBe('another_platform');
    expect(writes(promote)).toEqual([]);

    const create = fakeSession({ otherPlatform: 'otra-raiz' });
    const refused = seedSuperadmin(
      create,
      settings({ SUPERADMIN_TENANT_NAME: 'X S.A.S' }),
      hasher(),
    );
    await expect(refused).rejects.toThrow(/SUPERADMIN_TENANT_SLUG=otra-raiz/);
    expect(writes(create)).toEqual([]);
  });

  it('traduce la negativa de la jerarquía al promover', async () => {
    const children = fakeSession({
      ...PRODUCTION,
      promoteError: {
        code: 'STH01',
        constraint: 'tenant_children_type',
        message: 'el nodo tiene hijos que no pueden colgar de uno de tipo platform',
      },
    });
    await expect(seedSuperadmin(children, settings(), hasher())).rejects.toMatchObject({
      reason: 'tenant_promotion_blocked',
      message: expect.stringContaining('tiene hijos') as unknown,
    });

    const raced = fakeSession({
      ...PRODUCTION,
      promoteError: {
        code: '23505',
        constraint: 'uq_tenants_single_platform',
        message: 'duplicate key',
      },
    });
    expect(await reasonOf(seedSuperadmin(raced, settings(), hasher()))).toBe('another_platform');

    const other = fakeSession({
      ...PRODUCTION,
      promoteError: { code: '57014', message: 'canceling statement due to statement timeout' },
    });
    await expect(seedSuperadmin(other, settings(), hasher())).rejects.toThrow(/statement timeout/);
  });

  it('sin superusuario no lee nada más', async () => {
    const db = fakeSession({ ...PRODUCTION, privileged: false });
    expect(await reasonOf(seedSuperadmin(db, settings(), hasher()))).toBe('not_privileged');
    expect(db.sql).toEqual(['SELECT (SELECT']);
  });
});

describe('runSeed', () => {
  it('confirma todo en una transacción', async () => {
    const db = fakeSession(PRODUCTION);
    await runSeed(db, settings(), hasher());
    expect(db.sql[0]).toBe('BEGIN');
    expect(db.sql.at(-1)).toBe('COMMIT');
    expect(db.sql).not.toContain('ROLLBACK');
  });

  it('deshace todo si algo falla a mitad', async () => {
    const db = fakeSession({
      ...PRODUCTION,
      membership: undefined,
      failOn: 'INSERT INTO memberships',
    });
    await expect(runSeed(db, settings(), hasher())).rejects.toThrow('boom');
    expect(db.sql).toContain('UPDATE tenants');
    expect(db.sql.at(-1)).toBe('ROLLBACK');
    expect(db.sql).not.toContain('COMMIT');
  });
});
