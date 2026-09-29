import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SEED_DEFAULTS, SeedSecret, resolveSeedEnv, type SeedEnv } from './env.js';
import { SeedConfigError } from './errors.js';

const PASSWORD = ' Sup3r-admin pa$$ ';

function env(overrides: Record<string, string | undefined> = {}): SeedEnv {
  return {
    PGHOST: 'postgres',
    PGUSER: 'postgres',
    PGPASSWORD: 'pg-admin-password',
    PGDATABASE: 'sales_travel',
    SUPERADMIN_EMAIL: 'root@example.com',
    ...overrides,
  };
}

function issuesOf(overrides: Record<string, string | undefined>): readonly string[] {
  try {
    resolveSeedEnv(env(overrides));
  } catch (err) {
    if (err instanceof SeedConfigError) return err.issues;
    throw err;
  }
  throw new Error('esperaba SeedConfigError');
}

describe('resolveSeedEnv', () => {
  it('con sólo el correo apunta a la plataforma `platform` y no trae ni contraseña ni nombres', () => {
    const s = resolveSeedEnv(env());
    expect(s.superadmin).toEqual({
      email: 'root@example.com',
      name: undefined,
      password: undefined,
    });
    expect(s.tenant).toEqual({
      slug: SEED_DEFAULTS.tenantSlug,
      name: undefined,
      countryCode: SEED_DEFAULTS.country,
      currency: SEED_DEFAULTS.currency,
    });
    expect(SEED_DEFAULTS.tenantSlug).toBe('platform');
  });

  it('normaliza correo y slug, y guarda la contraseña tal cual, espacios incluidos', () => {
    const s = resolveSeedEnv(
      env({
        SUPERADMIN_EMAIL: '  Root@Example.COM ',
        SUPERADMIN_PASSWORD: PASSWORD,
        SUPERADMIN_NAME: ' Operador ',
        SUPERADMIN_TENANT_SLUG: ' Mayorista-1 ',
        SUPERADMIN_TENANT_NAME: ' Mayorista S.A.S ',
        SUPERADMIN_TENANT_COUNTRY: 'PE',
        SUPERADMIN_TENANT_CURRENCY: 'PEN',
      }),
    );
    expect(s.superadmin.email).toBe('root@example.com');
    expect(s.superadmin.name).toBe('Operador');
    expect(s.superadmin.password?.reveal()).toBe(PASSWORD);
    expect(s.tenant).toEqual({
      slug: 'mayorista-1',
      name: 'Mayorista S.A.S',
      countryCode: 'PE',
      currency: 'PEN',
    });
  });

  it('una variable vacía (`-e X=`) cuenta como no enviada', () => {
    const s = resolveSeedEnv(
      env({
        SUPERADMIN_PASSWORD: '',
        SUPERADMIN_NAME: '   ',
        SUPERADMIN_TENANT_SLUG: '',
        SUPERADMIN_TENANT_NAME: '',
        SUPERADMIN_TENANT_COUNTRY: '',
      }),
    );
    expect(s.superadmin.password).toBeUndefined();
    expect(s.superadmin.name).toBeUndefined();
    expect(s.tenant.slug).toBe('platform');
    expect(s.tenant.name).toBeUndefined();
    expect(s.tenant.countryCode).toBe('CO');
  });

  it('exige la conexión completa y el correo, por nombre', () => {
    expect(issuesOf({ PGHOST: undefined, PGDATABASE: '', SUPERADMIN_EMAIL: undefined })).toEqual([
      'PGHOST:invalid_type',
      'PGDATABASE:too_small',
      'SUPERADMIN_EMAIL:invalid_type',
    ]);
  });

  it('rechaza una contraseña corta o de más de 72 bytes sin repetirla', () => {
    const corta = 'corta-123';
    const larga = 'ñ'.repeat(37); // 74 bytes en UTF-8
    expect(issuesOf({ SUPERADMIN_PASSWORD: corta })).toEqual(['SUPERADMIN_PASSWORD:too_small']);
    const issues = issuesOf({ SUPERADMIN_PASSWORD: larga });
    expect(issues).toEqual(['SUPERADMIN_PASSWORD:longer_than_72_bytes']);
    expect(issues.join()).not.toContain(larga);
  });

  it('rechaza correo, slug, país y moneda mal formados', () => {
    expect(
      issuesOf({
        SUPERADMIN_EMAIL: 'no-es-correo',
        SUPERADMIN_TENANT_SLUG: 'con espacios',
        SUPERADMIN_TENANT_COUNTRY: 'col',
        SUPERADMIN_TENANT_CURRENCY: 'usd',
      }),
    ).toEqual([
      'SUPERADMIN_EMAIL:invalid_string',
      'SUPERADMIN_TENANT_SLUG:invalid_string',
      'SUPERADMIN_TENANT_COUNTRY:invalid_string',
      'SUPERADMIN_TENANT_CURRENCY:invalid_string',
    ]);
  });
});

describe('SeedSecret', () => {
  it('no se vuelca por JSON, String ni inspect', () => {
    const secret = new SeedSecret(PASSWORD);
    const dumped = [
      JSON.stringify({ secret }),
      String(secret),
      `${secret.toString()}`,
      inspect({ secret }),
    ];
    for (const text of dumped) expect(text).not.toContain(PASSWORD.trim());
    expect(secret.reveal()).toBe(PASSWORD);
  });
});
