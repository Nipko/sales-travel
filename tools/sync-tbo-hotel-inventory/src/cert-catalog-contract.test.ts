import { TBO_BASE_URLS } from '@sales-travel/tbo-hotels';
import { beforeAll, describe, expect, it } from 'vitest';
import { DB_ENV_VARIABLES } from './cli.js';
import { resolveSyncEnv, SYNC_ENV_VARIABLES, type SyncEnv } from './env.js';

/**
 * Contrato entre esta herramienta y el `catalog.env` que escribe
 * infrastructure/hostinger/render-cert-env.mjs para el stack de certificación (docs/tbo/07 §7.3
 * punto 6; infrastructure/hostinger/README.md §9.4). El render no puede importar este Zod (es un
 * `.mjs` suelto que corre en el runner), así que aquí se le pasa su salida a `resolveSyncEnv`: una
 * variable con otro nombre, o un valor que el Zod no acepta, se ve antes de desplegar y no en el
 * VPS con la cuenta de TBO ya copiada.
 *
 * Lo que el render garantiza del lado del stack (lista cerrada, ninguna `TBO_SYNC_*` de producción,
 * el paso del job) lo prueba tools/seed-tbo-cert-tenant/src/stack-contract.test.ts.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);

interface RenderModule {
  renderCertEnv(source: Readonly<Record<string, string | undefined>>): {
    catalog: string | null;
    catalogNames: string[];
  };
}

let render: RenderModule;

beforeAll(async () => {
  render = (await import(
    new URL('infrastructure/hostinger/render-cert-env.mjs', REPO_ROOT).href
  )) as RenderModule;
});

// Con forma reconocible. No son credenciales.
const PASSWORD = ` pa$$ #"cat'\\ `;
const VALID: Readonly<Record<string, string>> = {
  IMAGE_TAG: '4d651ac0123456789abcdef',
  CERT_POSTGRES_ADMIN_PASSWORD: 'c0ffee0000000000000000000000000000000000000000000000000000000001',
  CERT_APP_USER_PASSWORD: 'c0ffee0000000000000000000000000000000000000000000000000000000002',
  CERT_REDIS_PASSWORD: 'c0ffee0000000000000000000000000000000000000000000000000000000003',
  CERT_JWT_SECRET:
    'c0ffee00000000000000000000000000000000000000000000000000000000000000000000000004',
  CERT_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 5).toString('base64'),
  CERT_PROVIDER_PAYLOADS_KEY: Buffer.alloc(32, 6).toString('base64'),
  CERT_TBO_USERNAME: 'tbo-test-user',
  CERT_TBO_PASSWORD: PASSWORD,
  CERT_VENDEDOR_PASSWORD: 'vendedor-Cert-2026!',
  CERT_CATALOG_COUNTRIES: 'co, pe',
  CERT_CATALOG_CITIES: '130443, 150184',
};

/** Como lo lee `docker create --env-file`: el valor, literal, hasta el fin de línea. */
function envFile(text: string | null): SyncEnv {
  if (text === null) throw new Error('el render no escribió catalog.env');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function resolvedFor(mode: string, extra: Readonly<Record<string, string>> = {}) {
  const env = envFile(
    render.renderCertEnv({ ...VALID, CERT_CATALOG_MODE: mode, ...extra }).catalog,
  );
  const resolution = resolveSyncEnv(env);
  if (resolution.kind !== 'run') throw new Error(`esperaba run, fue ${resolution.reason}`);
  return { env, ...resolution };
}

describe('catalog.env del stack de certificación → resolveSyncEnv', () => {
  it('sólo nombra variables que esta herramienta lee', () => {
    for (const mode of ['cities', 'hotels']) {
      const names = Object.keys(resolvedFor(mode).env);
      const known = new Set([...SYNC_ENV_VARIABLES, ...DB_ENV_VARIABLES]);
      expect(names.filter((name) => !known.has(name))).toEqual([]);
    }
  });

  it('cities: E1 y E2 de los países de la lista, sin hoteles', () => {
    const { settings } = resolvedFor('cities');
    expect([...settings.stages]).toEqual(['E1', 'E2']);
    expect(settings.countries).toEqual(['CO', 'PE']);
  });

  it('hotels: E3 y E4 sólo de las ciudades de la lista, con contenido en español para todas', () => {
    const { settings } = resolvedFor('hotels');
    expect([...settings.stages]).toEqual(['E3', 'E4']);
    expect(settings.countries).toEqual(['CO', 'PE']);
    expect(settings.cities).toEqual(['130443', '150184']);
    // Las búsquedas del stack no son demanda para el sync (05 §8.5): con `demand` E4 no pediría nada.
    expect(settings.content).toMatchObject({
      scope: 'all',
      demandLangs: ['es'],
      regularLangs: ['es'],
    });
  });

  it('una corrida corta: 500 llamadas y 20 minutos si no se configura otra cosa', () => {
    const { settings } = resolvedFor('hotels');
    expect(settings.maxCalls).toBe(500);
    expect(settings.maxDurationMs).toBe(20 * 60_000);
    expect(resolvedFor('hotels', { CERT_CATALOG_MAX_CALLS: '120' }).settings.maxCalls).toBe(120);
  });

  it('la cuenta de test del stack, literal, contra el entorno de test de TBO', () => {
    const { tbo } = resolvedFor('hotels');
    expect(tbo.environment).toBe('test');
    expect(tbo.baseUrl).toBe(TBO_BASE_URLS.test);
    expect(tbo.username?.reveal()).toBe(VALID['CERT_TBO_USERNAME']);
    expect(tbo.password?.reveal()).toBe(PASSWORD);

    const custom = resolvedFor('hotels', { CERT_TBO_BASE_URL: `${TBO_BASE_URLS.test}/` }).tbo;
    expect(custom.baseUrl).toBe(TBO_BASE_URLS.test);
  });

  it('la conexión es la base del stack, con su superusuario', () => {
    const { env } = resolvedFor('cities');
    expect(env).toMatchObject({
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGUSER: 'postgres',
      PGDATABASE: 'sales_travel_cert',
      PGPASSWORD: VALID['CERT_POSTGRES_ADMIN_PASSWORD'],
    });
  });
});
