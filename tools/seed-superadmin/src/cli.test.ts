import { describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { PasswordHasher } from './seed.js';
import { fakeSession, type FakeSession, type FakeState } from './testing/fake-session.js';

const EMAIL = 'founder@example.com';
const PASSWORD = 'superadmin-secret-value';
const PG_PASSWORD = 'pg-secret-value';

const ENV = {
  PGHOST: 'postgres',
  PGUSER: 'postgres',
  PGPASSWORD: PG_PASSWORD,
  PGDATABASE: 'sales_travel',
  SUPERADMIN_EMAIL: EMAIL,
};

const fakeHasher: PasswordHasher = { hash: () => Promise.resolve('hashed') };

async function run(
  env: Record<string, string | undefined>,
  session?: FakeSession,
): Promise<{ code: number; lines: string[]; connected: boolean }> {
  const lines: string[] = [];
  let connected = false;
  const code = await runCli({
    env,
    out: (line) => lines.push(line),
    hasher: fakeHasher,
    connect: () => {
      connected = true;
      return session === undefined
        ? Promise.reject(new Error('connect ECONNREFUSED 10.0.0.2:5432'))
        : Promise.resolve(session);
    },
  });
  return { code, lines, connected };
}

function assertNoSecrets(lines: string[]): void {
  for (const value of [EMAIL, PASSWORD, PG_PASSWORD]) {
    for (const line of lines) expect(line).not.toContain(value);
  }
}

const PRODUCTION: FakeState = {
  tenant: { id: 'planetour', tenant_type: 'agency', parent_tenant_id: null, status: 'active' },
  user: { id: 'founder', status: 'active' },
  membership: { id: 'm-founder', role: 'consolidator_admin', status: 'active' },
};

describe('runCli', () => {
  it('con la configuración inválida sale 1, nombra las variables, no repite valores ni conecta', async () => {
    const { code, lines, connected } = await run({
      ...ENV,
      SUPERADMIN_EMAIL: undefined,
      SUPERADMIN_PASSWORD: 'corta',
    });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      ok: false,
      error: 'SeedConfigError',
      issues: ['SUPERADMIN_EMAIL:invalid_type', 'SUPERADMIN_PASSWORD:too_small'],
    });
    expect(connected).toBe(false);
    for (const value of ['corta', PG_PASSWORD]) expect(lines[0]).not.toContain(value);
  });

  it('hecho: sale 0 con el informe en una línea, sin correo ni contraseñas, y cierra la sesión', async () => {
    const session = fakeSession(PRODUCTION);
    const { code, lines } = await run({ ...ENV, SUPERADMIN_PASSWORD: PASSWORD }, session);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      ok: true,
      tenantSlug: 'platform',
      tenant: 'promoted',
      membership: 'updated',
      previousRole: 'consolidator_admin',
      passwordIgnored: true,
    });
    assertNoSecrets(lines);
    expect(session.sql.at(-1)).toBe('COMMIT');
    expect(session.ended).toBe(true);
  });

  it('negado: sale 1 con el motivo, deshace y cierra la sesión', async () => {
    const session = fakeSession({ ...PRODUCTION, otherPlatform: 'otra-raiz' });
    const { code, lines } = await run(ENV, session);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      ok: false,
      error: 'SeedRefusedError',
      reason: 'another_platform',
    });
    assertNoSecrets(lines);
    expect(session.sql.at(-1)).toBe('ROLLBACK');
    expect(session.ended).toBe(true);
  });

  it('falta lo necesario para crear el usuario: lo dice por nombre', async () => {
    const session = fakeSession({ ...PRODUCTION, user: undefined, membership: undefined });
    const { code, lines } = await run(ENV, session);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      ok: false,
      error: 'SeedConfigError',
      issues: [
        'SUPERADMIN_PASSWORD:required_to_create_user',
        'SUPERADMIN_NAME:required_to_create_user',
      ],
    });
    expect(session.sql.at(-1)).toBe('ROLLBACK');
  });

  it('sin base: sale 1 con el error de conexión', async () => {
    const { code, lines } = await run(ENV);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ ok: false, error: 'Error' });
    assertNoSecrets(lines);
  });
});
