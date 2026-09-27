import { inspect } from 'node:util';
import { TBO_BASE_URLS } from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import {
  CERT_DATABASE,
  CERT_TENANT_SLUG,
  SEED_DEFAULTS,
  resolveSeedEnv,
  type SeedEnv,
} from './env.js';
import { SeedConfigError } from './errors.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const TBO_PASSWORD = ' Tb0-pa$$ #word ';
const VENDEDOR_PASSWORD = 'vendedor-Cert-2026!';

function env(overrides: Record<string, string | undefined> = {}): SeedEnv {
  return {
    PGHOST: 'postgres',
    PGUSER: 'postgres',
    PGPASSWORD: 'pg-admin-password',
    PROVIDER_CREDENTIALS_KEY: KEY,
    CERT_TBO_USERNAME: 'tbo-test-user',
    CERT_TBO_PASSWORD: TBO_PASSWORD,
    CERT_VENDEDOR_PASSWORD: VENDEDOR_PASSWORD,
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
  it('con lo mínimo usa los valores por defecto y la URL de test del ACL', () => {
    const s = resolveSeedEnv(env());
    expect(s.database).toEqual({ expectedName: CERT_DATABASE, dedicated: true });
    expect(s.tenant).toEqual({
      slug: CERT_TENANT_SLUG,
      name: SEED_DEFAULTS.tenantName,
      countryCode: SEED_DEFAULTS.country,
      currency: SEED_DEFAULTS.currency,
    });
    expect(s.vendedor.email).toBe(SEED_DEFAULTS.vendedorEmail);
    expect(s.vendedor.status).toBe('active');
    expect(s.tboAccount.environment).toBe('test');
    expect(s.tboAccount.baseUrl).toBe(TBO_BASE_URLS.test);
    expect(s.wallet.balanceMinor).toBe(SEED_DEFAULTS.walletBalanceMajor * 100);
    expect(s.hotelMarkupBasisPoints).toBe(500);
    expect(s.credentialsKey.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('la contraseña de TBO llega tal cual, con espacios y símbolos (TBO no la recorta)', () => {
    expect(resolveSeedEnv(env()).tboAccount.password.reveal()).toBe(TBO_PASSWORD);
  });

  it('vacío es "no configurado": el render deja fuera las opcionales, GitHub las manda vacías', () => {
    const s = resolveSeedEnv(
      env({ CERT_CURRENCY: '', CERT_VENDEDOR_EMAIL: '', CERT_HOTEL_MARKUP_PERCENT: '' }),
    );
    expect(s.tenant.currency).toBe('USD');
    expect(s.vendedor.email).toBe(SEED_DEFAULTS.vendedorEmail);
    expect(s.hotelMarkupBasisPoints).toBe(500);
  });

  it('lee cada opcional', () => {
    const s = resolveSeedEnv(
      env({
        CERT_VENDEDOR_EMAIL: '  QA.Tester@Example.com ',
        CERT_VENDEDOR_NAME: 'QA Tester',
        CERT_VENDEDOR_STATUS: 'suspended',
        CERT_TENANT_NAME: 'Portal de certificación',
        CERT_COUNTRY: 'PE',
        CERT_CURRENCY: 'EUR',
        CERT_WALLET_BALANCE: '12345',
        CERT_HOTEL_MARKUP_PERCENT: '2.5',
        CERT_TBO_BASE_URL: 'https://api.tbotechnology.in/TBOHolidays_HotelAPI/',
      }),
    );
    expect(s.vendedor.email).toBe('qa.tester@example.com');
    expect(s.vendedor.name).toBe('QA Tester');
    expect(s.vendedor.status).toBe('suspended');
    expect(s.tenant).toMatchObject({
      name: 'Portal de certificación',
      countryCode: 'PE',
      currency: 'EUR',
    });
    expect(s.wallet.balanceMinor).toBe(1_234_500);
    expect(s.hotelMarkupBasisPoints).toBe(250);
    // Normalizada por el ACL, sin barra final.
    expect(s.tboAccount.baseUrl).toBe('https://api.tbotechnology.in/TBOHolidays_HotelAPI');
  });

  it('exige las credenciales de TBO, la contraseña del vendedor, la clave y la conexión', () => {
    expect(
      issuesOf({
        CERT_TBO_USERNAME: undefined,
        CERT_TBO_PASSWORD: '',
        CERT_VENDEDOR_PASSWORD: undefined,
        PROVIDER_CREDENTIALS_KEY: undefined,
        PGPASSWORD: undefined,
      }),
    ).toEqual(
      expect.arrayContaining([
        'CERT_TBO_USERNAME:invalid_type',
        'CERT_TBO_PASSWORD:too_small',
        'CERT_VENDEDOR_PASSWORD:invalid_type',
        'PROVIDER_CREDENTIALS_KEY:invalid_type',
        'PGPASSWORD:invalid_type',
      ]),
    );
  });

  it('sólo acepta el host de test de TBO: este stack nunca guarda una cuenta live', () => {
    expect(issuesOf({ CERT_TBO_BASE_URL: 'https://live.example.com/HotelAPI' })).toEqual([
      'CERT_TBO_BASE_URL:not_tbo_test_host',
    ]);
  });

  it('aplica las reglas de transporte del ACL (http sólo en el host de test)', () => {
    expect(issuesOf({ CERT_TBO_BASE_URL: 'http://evil.example.com/TBOHolidays_HotelAPI' })).toEqual(
      ['CERT_TBO_BASE_URL:http_only_on_test_host'],
    );
  });

  it('rechaza un usuario de TBO con `:` como lo rechazaría el factory del api', () => {
    expect(issuesOf({ CERT_TBO_USERNAME: 'user:name' })).toEqual([
      'CERT_TBO_USERNAME:colon_in_username',
    ]);
  });

  it.each([
    ['CERT_VENDEDOR_PASSWORD', 'corta', 'CERT_VENDEDOR_PASSWORD:too_small'],
    ['CERT_VENDEDOR_PASSWORD', 'ñ'.repeat(37), 'CERT_VENDEDOR_PASSWORD:longer_than_72_bytes'],
    ['CERT_VENDEDOR_EMAIL', 'no-es-un-correo', 'CERT_VENDEDOR_EMAIL:invalid_string'],
    ['CERT_VENDEDOR_STATUS', 'disabled', 'CERT_VENDEDOR_STATUS:invalid_enum_value'],
    ['CERT_CURRENCY', 'usd', 'CERT_CURRENCY:invalid_string'],
    ['CERT_CURRENCY', 'CLP', 'CERT_CURRENCY:not_two_decimals'],
    ['CERT_COUNTRY', 'COL', 'CERT_COUNTRY:invalid_string'],
    ['CERT_WALLET_BALANCE', '0', 'CERT_WALLET_BALANCE:invalid_string'],
    ['CERT_WALLET_BALANCE', '100.50', 'CERT_WALLET_BALANCE:invalid_string'],
    ['CERT_HOTEL_MARKUP_PERCENT', '0', 'CERT_HOTEL_MARKUP_PERCENT:out_of_range'],
    ['CERT_HOTEL_MARKUP_PERCENT', '75', 'CERT_HOTEL_MARKUP_PERCENT:out_of_range'],
    [
      'PROVIDER_CREDENTIALS_KEY',
      Buffer.alloc(16).toString('base64'),
      'PROVIDER_CREDENTIALS_KEY:not_base64_32_bytes',
    ],
    ['CERT_TBO_BASE_URL', 'no es una url', 'CERT_TBO_BASE_URL:invalid_string'],
  ])('%s=%j → %s', (name, value, issue) => {
    expect(issuesOf({ [name]: value })).toEqual([issue]);
  });

  it('los errores nombran la variable y el motivo, nunca el valor', () => {
    const secret = 'no-es-un-estado-secreto';
    const err = (() => {
      try {
        resolveSeedEnv(env({ CERT_VENDEDOR_STATUS: secret, CERT_TBO_USERNAME: 'x:y' }));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(SeedConfigError);
    expect(
      JSON.stringify({ message: (err as Error).message, issues: (err as SeedConfigError).issues }),
    ).not.toContain(secret);
  });

  it('ninguna serialización de la configuración vuelca una contraseña', () => {
    const s = resolveSeedEnv(env());
    const dumps = [JSON.stringify(s), inspect(s, { depth: 5 }), String(s.vendedor.password)];
    for (const dump of dumps) {
      expect(dump).not.toContain(TBO_PASSWORD.trim());
      expect(dump).not.toContain(VENDEDOR_PASSWORD);
      expect(dump).not.toContain('tbo-test-user');
    }
  });
});
