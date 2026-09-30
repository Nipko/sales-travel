import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CERT_DATABASE,
  SEED_DEFAULTS,
  SEED_ENV_VARIABLES,
  SEED_SECRET_VARIABLES,
  resolveSeedEnv,
} from './env.js';

/**
 * Contrato del stack de certificación de TBO (docs/tbo/07 §7.2 A; D-TBO-35 A; 08 RC-07; 09 PR-7.2)
 * entre sus cinco piezas: el render del `.env`, docker-compose.cert.yml, el Caddyfile, el job
 * `deploy-cert` y el README. Ninguna la ejerce el CI de otra forma: los workflows no corren en un
 * PR y el stack no se levanta en los tests.
 *
 * La garantía central es RC-07: el entorno que ve el tester de TBO no tiene ninguna credencial de
 * otro proveedor. Se prueba ejecutando el render con un entorno ENVENENADO —todas las variables
 * que producción escribe en su `.env`, más las de Sabre y las del arnés— y mirando la salida.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);

function repoFile(path: string): string {
  return readFileSync(new URL(path, REPO_ROOT), 'utf8').replace(/\r\n/g, '\n');
}

const CERT_COMPOSE_TEXT = repoFile('infrastructure/hostinger/docker-compose.cert.yml');
const PROD_COMPOSE_TEXT = repoFile('infrastructure/hostinger/docker-compose.prod.yml');
const CADDYFILE = repoFile('infrastructure/hostinger/Caddyfile');
const DEPLOY_TEXT = repoFile('.github/workflows/deploy.yml');
const README = repoFile('infrastructure/hostinger/README.md');

/** Prefijos de variables de proveedor que el stack no puede recibir (RC-07). */
const OTHER_PROVIDER_VARIABLE =
  /^(DESPEGAR|LATAM|SABRE|AGENT_CARS|AMADEUS|TRAVELPORT|HOTELDO|HOTELBEDS|RATEHAWK|STRIPE|MERCADOPAGO|TBO_SYNC)_/;
const OTHER_PROVIDER_MENTION = /DESPEGAR_|LATAM_|SABRE_|AGENT_CARS_|TBO_SYNC_/;

const CERT_HOST = 'cert-app.planetour.cloud';
const INGRESS_NETWORK = 'sales-travel-cert-ingress';
const SEED_IMAGE_SUFFIX = 'seed-tbo-cert-tenant';
const SYNC_IMAGE_SUFFIX = 'sync-tbo-hotel-inventory';
const CATALOG_STEP = 'Sync TBO catalog';
const CLEANUP_STEP = 'Remove seed.env and catalog.env';

// ───────────────────────── Tipos de lo que se lee ─────────────────────────

interface EnvRule {
  readonly name: string;
  readonly from: string;
  readonly kind: string;
  readonly optional?: boolean;
  readonly fallback?: string;
}

interface RenderModule {
  renderCertEnv(source: Readonly<Record<string, string | undefined>>): {
    stack: string;
    seed: string;
    catalog: string | null;
    stackNames: string[];
    seedNames: string[];
    catalogNames: string[];
  };
  readonly STACK_ENV: readonly EnvRule[];
  readonly STACK_DERIVED: readonly { readonly name: string; readonly from: string }[];
  internalProxySecret(jwtSecret: string): string;
  readonly SEED_ENV: readonly EnvRule[];
  readonly SEED_CONNECTION: Readonly<Record<string, string>>;
  readonly CATALOG_ENV: readonly EnvRule[];
  readonly CATALOG_CONNECTION: Readonly<Record<string, string>>;
  readonly CATALOG_FIXED: Readonly<Record<string, string>>;
  readonly CATALOG_STAGES: Readonly<Record<string, string | null>>;
  readonly CATALOG_LIMITS: Readonly<{ countries: number; cities: number; calls: number }>;
  readonly CATALOG_MODE_VARIABLE: string;
  readonly CERT_DATABASE: string;
  readonly CERT_INTERNAL_NETWORK: string;
  readonly CERT_EGRESS_NETWORK: string;
}

interface ComposeService {
  readonly image?: string;
  readonly environment?: Readonly<Record<string, unknown>>;
  readonly networks?: readonly string[];
  readonly ports?: unknown;
  readonly env_file?: unknown;
}

interface ComposeNetwork {
  readonly external?: boolean;
  readonly name?: string;
  readonly internal?: boolean;
}

interface ComposeFile {
  readonly name?: string;
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly networks?: Readonly<Record<string, ComposeNetwork | null>>;
}

interface WorkflowStep {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly 'timeout-minutes'?: number;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: unknown;
  readonly environment?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly 'timeout-minutes'?: number;
  readonly steps: readonly WorkflowStep[];
  readonly strategy?: {
    readonly matrix?: { readonly app?: readonly { name: string; dockerfile: string }[] };
  };
}

interface WorkflowInput {
  readonly type?: string;
  readonly options?: readonly string[];
  readonly default?: string;
}

interface Workflow {
  readonly on?: {
    readonly workflow_dispatch?: { readonly inputs?: Readonly<Record<string, WorkflowInput>> };
  };
  readonly env: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function composeOf(text: string): ComposeFile {
  const doc = load(text);
  if (!isRecord(doc) || !isRecord(doc['services'])) throw new Error('compose sin services');
  return doc as unknown as ComposeFile;
}

function workflowOf(text: string): Workflow {
  const doc = load(text);
  if (!isRecord(doc) || !isRecord(doc['jobs'])) throw new Error('workflow sin jobs');
  return doc as unknown as Workflow;
}

const CERT = composeOf(CERT_COMPOSE_TEXT);
const PROD = composeOf(PROD_COMPOSE_TEXT);
const WORKFLOW = workflowOf(DEPLOY_TEXT);

function service(compose: ComposeFile, name: string): ComposeService {
  const found = compose.services[name];
  if (found === undefined) throw new Error(`no existe el servicio ${name}`);
  return found;
}

function envOf(svc: ComposeService): Record<string, string> {
  return Object.fromEntries(Object.entries(svc.environment ?? {}).map(([k, v]) => [k, String(v)]));
}

function job(name: string): WorkflowJob {
  const found = WORKFLOW.jobs[name];
  if (found === undefined) throw new Error(`deploy.yml no tiene el job ${name}`);
  return found;
}

function step(jobName: string, stepName: string): WorkflowStep {
  const found = job(jobName).steps.find((s) => s.name === stepName);
  if (found === undefined) throw new Error(`${jobName} no tiene el paso "${stepName}"`);
  return found;
}

/** `NOMBRE=valor` de un archivo renderizado, sin comentarios. */
function entriesOf(rendered: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of rendered.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

/** Los nombres que escribe el `.env` de producción (el heredoc de deploy.yml). */
function prodEnvNames(): string[] {
  const block = /cat > \.env <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(DEPLOY_TEXT)?.[1];
  if (block === undefined) throw new Error('deploy.yml ya no renderiza el .env de producción');
  return [...block.matchAll(/^\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? '');
}

// ───────────────────────── Entradas del render ─────────────────────────

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
  CERT_TBO_PASSWORD: ` pa$$ #"w0rd'\\ `,
  CERT_VENDEDOR_PASSWORD: 'vendedor-Cert-2026!',
};

/**
 * Lo que un runner de este repo puede tener en su entorno y el stack no puede recibir: todo lo que
 * producción escribe en su `.env`, las credenciales de Sabre y las del arnés de TBO (`.env.tbo`).
 */
function poisoned(): Record<string, string> {
  const names = [
    ...prodEnvNames(),
    'SABRE_CLIENT_ID',
    'SABRE_CLIENT_SECRET',
    'SABRE_PCC',
    'SABRE_USERNAME',
    'SABRE_PASSWORD',
    'TBO_USERNAME',
    'TBO_PASSWORD',
    'TBO_BASE_URL',
    'HOSTINGER_SSH_KEY',
  ].filter((name) => name !== 'IMAGE_TAG');
  return Object.fromEntries(names.map((name) => [name, `poison-${name.toLowerCase()}-value`]));
}

let render: RenderModule;

beforeAll(async () => {
  render = (await import(
    new URL('infrastructure/hostinger/render-cert-env.mjs', REPO_ROOT).href
  )) as RenderModule;
});

function renderIssues(source: Readonly<Record<string, string | undefined>>): {
  issues: readonly string[];
  message: string;
} {
  try {
    render.renderCertEnv(source);
  } catch (err) {
    const issues = (err as { issues?: unknown }).issues;
    if (Array.isArray(issues))
      return { issues: issues as string[], message: (err as Error).message };
    throw err;
  }
  throw new Error('esperaba CertEnvError');
}

// ───────────────────────── RC-07: el render ─────────────────────────

describe('render del .env del stack (RC-07)', () => {
  it('no contiene variables de ningún otro proveedor aunque el runner las tenga en su entorno', () => {
    const poison = poisoned();
    expect(
      Object.keys(poison).filter((n) => OTHER_PROVIDER_VARIABLE.test(n)).length,
    ).toBeGreaterThan(20);

    const out = render.renderCertEnv({ ...poison, ...VALID });
    for (const file of [out.stack, out.seed]) {
      const names = [...entriesOf(file).keys()];
      expect(names.filter((n) => OTHER_PROVIDER_VARIABLE.test(n))).toEqual([]);
      // Ni el valor de producción de una variable que el stack también usa (JWT_SECRET, claves).
      for (const value of Object.values(poison)) expect(file).not.toContain(value);
    }
  });

  it('escribe sólo la lista cerrada', () => {
    const out = render.renderCertEnv({ ...poisoned(), ...VALID });
    expect([...entriesOf(out.stack).keys()].sort()).toEqual(
      [
        ...render.STACK_ENV.filter((r) => !r.optional).map((r) => r.name),
        ...render.STACK_DERIVED.map((d) => d.name),
      ].sort(),
    );
    expect([...entriesOf(out.seed).keys()].sort()).toEqual(
      [
        ...Object.keys(render.SEED_CONNECTION),
        ...render.SEED_ENV.filter((r) => !r.optional).map((r) => r.name),
      ].sort(),
    );
  });

  it('las opcionales vacías no se escriben: el stack y el seed aplican su valor por defecto', () => {
    const out = render.renderCertEnv({
      ...VALID,
      CERT_PROVIDERS_DISABLED: '',
      CERT_CURRENCY: '',
      CERT_VENDEDOR_EMAIL: 'qa@example.com',
      CERT_PROVIDER_PAYLOADS_RETENTION_DAYS: '14',
    });
    const stack = entriesOf(out.stack);
    const seed = entriesOf(out.seed);
    expect(stack.has('PROVIDERS_DISABLED')).toBe(false);
    expect(stack.get('PROVIDER_PAYLOADS_RETENTION_DAYS')).toBe('14');
    expect(seed.has('CERT_CURRENCY')).toBe(false);
    expect(seed.get('CERT_VENDEDOR_EMAIL')).toBe('qa@example.com');
  });

  it('el contacto de soporte llega al seed tal cual, con los espacios del teléfono', () => {
    const seedOf = (source: Readonly<Record<string, string>>): Record<string, string> =>
      Object.fromEntries(entriesOf(render.renderCertEnv(source).seed));

    const configured = seedOf({
      ...VALID,
      CERT_SUPPORT_EMAIL: 'reservas@example.com',
      CERT_SUPPORT_PHONE: '+57 (601) 000-0000',
    });
    expect(resolveSeedEnv(configured).tenant).toMatchObject({
      supportEmail: 'reservas@example.com',
      supportPhone: '+57 (601) 000-0000',
    });

    // Sin las variables, el seed pone el buzón de rol y el teléfono ficticio: el Book nunca queda
    // sin contacto.
    const unset = seedOf({ ...VALID, CERT_SUPPORT_EMAIL: '', CERT_SUPPORT_PHONE: '' });
    expect(unset['CERT_SUPPORT_EMAIL']).toBeUndefined();
    expect(unset['CERT_SUPPORT_PHONE']).toBeUndefined();
    expect(resolveSeedEnv(unset).tenant).toMatchObject({
      supportEmail: SEED_DEFAULTS.supportEmail,
      supportPhone: SEED_DEFAULTS.supportPhone,
    });
  });

  it('el .env del stack lleva las claves PROPIAS y el seed la misma de credenciales que el api', () => {
    const out = render.renderCertEnv(VALID);
    const stack = entriesOf(out.stack);
    const seed = entriesOf(out.seed);
    expect(stack.get('JWT_SECRET')).toBe(VALID['CERT_JWT_SECRET']);
    expect(stack.get('PROVIDER_CREDENTIALS_KEY')).toBe(VALID['CERT_PROVIDER_CREDENTIALS_KEY']);
    expect(seed.get('PROVIDER_CREDENTIALS_KEY')).toBe(stack.get('PROVIDER_CREDENTIALS_KEY'));
    expect(seed.get('PGPASSWORD')).toBe(stack.get('POSTGRES_ADMIN_PASSWORD'));
  });

  it('INTERNAL_PROXY_SECRET sale del JWT_SECRET del stack, con la cuenta de producción', () => {
    const stack = entriesOf(render.renderCertEnv(VALID).stack);
    const secret = stack.get('INTERNAL_PROXY_SECRET') ?? '';
    // sha256 hex de `internal-proxy:` + JWT_SECRET, como el paso `Render .env` de producción.
    expect(DEPLOY_TEXT).toContain(`printf 'internal-proxy:%s'`);
    expect(secret).toBe(render.internalProxySecret(VALID['CERT_JWT_SECRET'] ?? ''));
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toContain(VALID['CERT_JWT_SECRET'] ?? '');
  });

  it('INTERNAL_PROXY_SECRET no se escribe si el JWT_SECRET no pasa su regla', () => {
    expect(renderIssues({ ...VALID, CERT_JWT_SECRET: 'corto' }).issues).toEqual([
      'CERT_JWT_SECRET:too_short',
    ]);
  });

  it('seed.env conserva literal la contraseña de TBO (`$`, `#`, comillas, espacios)', () => {
    const out = render.renderCertEnv(VALID);
    expect(out.seed.split('\n')).toContain(`CERT_TBO_PASSWORD=${VALID['CERT_TBO_PASSWORD']}`);
  });

  it('rechaza lo que rompería el .env de compose o el env-file, sin repetir el valor', () => {
    const jwt = `${'x'.repeat(40)}$HOME`;
    const { issues, message } = renderIssues({
      ...VALID,
      CERT_JWT_SECRET: jwt,
      CERT_TBO_PASSWORD: 'dos\nlíneas',
      CERT_PROVIDER_PAYLOADS_KEY: Buffer.alloc(16).toString('base64'),
      CERT_PROVIDERS_DISABLED: 'tbo-hotels;rm -rf',
      IMAGE_TAG: 'latest && curl evil',
    });
    expect([...issues].sort()).toEqual(
      [
        'CERT_JWT_SECRET:unsafe_characters',
        'CERT_TBO_PASSWORD:line_break',
        'CERT_PROVIDER_PAYLOADS_KEY:not_base64_32_bytes',
        'CERT_PROVIDERS_DISABLED:invalid_provider_list',
        'IMAGE_TAG:invalid_tag',
      ].sort(),
    );
    expect(message).not.toContain(jwt);
    expect(message).not.toContain('líneas');
  });

  it('no deja que el api apague la bóveda de RQ/RS en silencio (D-TBO-31 A)', () => {
    // El api la apaga, sin fallar, con la clave de credenciales repetida o una retención fuera de
    // 1 a 90 días (provider-payloads.config.ts). Aquí el despliegue falla antes.
    expect(
      renderIssues({
        ...VALID,
        CERT_PROVIDER_PAYLOADS_KEY: VALID['CERT_PROVIDER_CREDENTIALS_KEY'],
        CERT_PROVIDER_PAYLOADS_RETENTION_DAYS: '91',
      }).issues,
    ).toEqual([
      'CERT_PROVIDER_PAYLOADS_RETENTION_DAYS:not_1_to_90_days',
      'CERT_PROVIDER_PAYLOADS_KEY:same_as_credentials_key',
    ]);
    for (const days of ['0', '100', '7.5']) {
      expect(
        renderIssues({ ...VALID, CERT_PROVIDER_PAYLOADS_RETENTION_DAYS: days }).issues,
      ).toEqual(['CERT_PROVIDER_PAYLOADS_RETENTION_DAYS:not_1_to_90_days']);
    }
    for (const days of ['1', '30', '90']) {
      expect(() =>
        render.renderCertEnv({ ...VALID, CERT_PROVIDER_PAYLOADS_RETENTION_DAYS: days }),
      ).not.toThrow();
    }
  });

  it('exige cada secret del stack y del seed', () => {
    const { issues } = renderIssues({ IMAGE_TAG: VALID['IMAGE_TAG'] });
    const required = [...render.STACK_ENV, ...render.SEED_ENV]
      .filter((r) => !r.optional && r.from !== 'IMAGE_TAG')
      .map((r) => `${r.from}:required`);
    expect([...new Set(issues)].sort()).toEqual([...new Set(required)].sort());
  });
});

// ───────────────────────── catalog.env ─────────────────────────

describe('catalog.env: sync del catálogo de TBO (07 §7.3 punto 6)', () => {
  const CATALOG: Readonly<Record<string, string>> = {
    ...VALID,
    CERT_CATALOG_COUNTRIES: 'CO,PE',
    CERT_CATALOG_CITIES: '130443,150184',
  };

  it('sin pedirlo no se escribe, aunque las variables del catálogo estén cargadas', () => {
    for (const mode of [undefined, '', 'none']) {
      const out = render.renderCertEnv({ ...CATALOG, CERT_CATALOG_MODE: mode });
      expect(out.catalog).toBeNull();
      expect(out.catalogNames).toEqual([]);
    }
  });

  it('la cuenta es la de test del stack aunque el runner tenga la de catálogo de producción', () => {
    // Las `TBO_SYNC_*` de producción son la cuenta de catálogo de plataforma (D-TBO-04 A), que
    // puede ser la live: en el stack no pueden llegar ni por el nombre ni por el valor.
    const poison = poisoned();
    expect(Object.keys(poison)).toEqual(
      expect.arrayContaining(['TBO_SYNC_USERNAME', 'TBO_SYNC_PASSWORD', 'TBO_SYNC_BASE_URL']),
    );
    const out = render.renderCertEnv({ ...poison, ...CATALOG, CERT_CATALOG_MODE: 'hotels' });
    for (const value of Object.values(poison)) expect(out.catalog).not.toContain(value);
    const catalog = entriesOf(out.catalog ?? '');
    expect(catalog.get('TBO_SYNC_USERNAME')).toBe(VALID['CERT_TBO_USERNAME']);
    expect(catalog.get('TBO_SYNC_PASSWORD')).toBe(VALID['CERT_TBO_PASSWORD']);
    expect(catalog.get('TBO_SYNC_ENVIRONMENT')).toBe('test');
    // Sin CERT_TBO_BASE_URL no se escribe: el sync usa la de test del ACL, como el seed.
    expect(catalog.has('TBO_SYNC_BASE_URL')).toBe(false);
    expect(catalog.get('PGPASSWORD')).toBe(VALID['CERT_POSTGRES_ADMIN_PASSWORD']);
    expect(
      [...catalog.keys()].filter((n) => OTHER_PROVIDER_VARIABLE.test(n) && !/^TBO_SYNC_/.test(n)),
    ).toEqual([]);
  });

  it('escribe sólo la lista cerrada, con las etapas de cada modo', () => {
    for (const [mode, stages] of [
      ['cities', 'E1,E2'],
      ['hotels', 'E3,E4'],
    ] as const) {
      const out = render.renderCertEnv({ ...poisoned(), ...CATALOG, CERT_CATALOG_MODE: mode });
      const catalog = entriesOf(out.catalog ?? '');
      const written = render.CATALOG_ENV.filter(
        (r) => !r.optional || r.fallback !== undefined || (CATALOG[r.from] ?? '') !== '',
      ).map((r) => r.name);
      expect([...catalog.keys()].sort()).toEqual(
        [
          ...Object.keys(render.CATALOG_CONNECTION),
          ...Object.keys(render.CATALOG_FIXED),
          'TBO_SYNC_STAGES',
          ...written,
        ].sort(),
      );
      expect(catalog.get('TBO_SYNC_STAGES')).toBe(stages);
      expect(render.CATALOG_STAGES[mode]).toBe(stages);
      expect(out.catalogNames).toEqual([...catalog.keys()]);
    }
  });

  it('la base es la del stack y la contraseña de TBO llega literal', () => {
    const out = render.renderCertEnv({ ...CATALOG, CERT_CATALOG_MODE: 'cities' });
    const catalog = entriesOf(out.catalog ?? '');
    expect(render.CATALOG_CONNECTION).toEqual(render.SEED_CONNECTION);
    expect(catalog.get('PGDATABASE')).toBe(CERT_DATABASE);
    expect(out.catalog?.split('\n')).toContain(`TBO_SYNC_PASSWORD=${VALID['CERT_TBO_PASSWORD']}`);
    expect(catalog.get('TBO_SYNC_MAX_CALLS')).toBe('500');
  });

  it('hotels exige la lista de ciudades: sin ella recorrería el país entero', () => {
    const countriesOnly = { ...VALID, CERT_CATALOG_COUNTRIES: 'CO' };
    expect(renderIssues({ ...countriesOnly, CERT_CATALOG_MODE: 'hotels' }).issues).toEqual([
      'CERT_CATALOG_CITIES:required',
    ]);
    expect(
      render.renderCertEnv({ ...countriesOnly, CERT_CATALOG_MODE: 'cities' }).catalog,
    ).not.toBeNull();
    expect(renderIssues({ ...VALID, CERT_CATALOG_MODE: 'cities' }).issues).toEqual([
      'CERT_CATALOG_COUNTRIES:required',
    ]);
  });

  it('rechaza listas abiertas o raras antes de tocar el VPS, sin repetir el valor', () => {
    const tooManyCities = Array.from({ length: render.CATALOG_LIMITS.cities + 1 }, (_, i) =>
      String(100_000 + i),
    ).join(',');
    const { issues, message } = renderIssues({
      ...VALID,
      CERT_CATALOG_MODE: 'hotels',
      CERT_CATALOG_COUNTRIES: 'CO,COL',
      CERT_CATALOG_CITIES: tooManyCities,
      CERT_CATALOG_MAX_CALLS: '100000',
    });
    expect([...issues].sort()).toEqual(
      [
        'CERT_CATALOG_CITIES:too_many',
        'CERT_CATALOG_COUNTRIES:not_iso2_list',
        'CERT_CATALOG_MAX_CALLS:not_1_to_5000_calls',
      ].sort(),
    );
    expect(message).not.toContain('100000');
    const hotels = { ...CATALOG, CERT_CATALOG_MODE: 'hotels' };
    expect(renderIssues({ ...hotels, CERT_CATALOG_CITIES: '130443,Bogota' }).issues).toEqual([
      'CERT_CATALOG_CITIES:not_city_code_list',
    ]);
    expect(renderIssues({ ...hotels, CERT_CATALOG_COUNTRIES: 'CO,PE,BR,US,MX,AR' }).issues).toEqual(
      ['CERT_CATALOG_COUNTRIES:too_many'],
    );
    expect(renderIssues({ ...hotels, CERT_CATALOG_MAX_CALLS: '0' }).issues).toEqual([
      'CERT_CATALOG_MAX_CALLS:not_1_to_5000_calls',
    ]);
    expect(renderIssues({ ...CATALOG, CERT_CATALOG_MODE: 'all' }).issues).toEqual([
      'CERT_CATALOG_MODE:invalid_mode',
    ]);
  });
});

// ───────────────────────── docker-compose.cert.yml ─────────────────────────

describe('docker-compose.cert.yml', () => {
  it('ningún servicio recibe variables de otro proveedor ni un env_file', () => {
    for (const [name, svc] of Object.entries(CERT.services)) {
      expect(svc.env_file, `${name} con env_file`).toBeUndefined();
      expect(Object.keys(envOf(svc)).filter((k) => OTHER_PROVIDER_VARIABLE.test(k))).toEqual([]);
    }
    expect(CERT_COMPOSE_TEXT).not.toMatch(OTHER_PROVIDER_MENTION);
  });

  it('sólo interpola lo que escribe el render, y lo obligatorio corta el `up` si falta', () => {
    const refs = [...CERT_COMPOSE_TEXT.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:[?-])?[^}]*\}/g)];
    // Las derivadas las escribe siempre el render: cuentan como obligatorias.
    const rules = new Map<string, { readonly optional?: boolean }>([
      ...render.STACK_ENV.map((r): [string, EnvRule] => [r.name, r]),
      ...render.STACK_DERIVED.map((d): [string, { optional: false }] => [
        d.name,
        { optional: false },
      ]),
    ]);
    for (const [, name = '', operator] of refs) {
      const rule = rules.get(name);
      expect(rule, `el compose lee ${name}, que el render no escribe`).toBeDefined();
      if (operator === ':?') expect(rule?.optional, `${name} obligatoria`).not.toBe(true);
    }
    for (const rule of render.STACK_ENV.filter((r) => !r.optional)) {
      expect(CERT_COMPOSE_TEXT).toContain(`\${${rule.name}:?`);
    }
  });

  it('el api tiene la cuenta de TBO sólo por la bóveda: ninguna variable TBO_* ni CERT_*', () => {
    const env = envOf(service(CERT, 'cert-api'));
    expect(Object.keys(env).filter((k) => /^(TBO|CERT)_/.test(k))).toEqual([]);
    // Lista exacta: una variable nueva en el api del stack se revisa aquí contra RC-07.
    expect(Object.keys(env).sort()).toEqual(
      [
        'APP_VERSION',
        'APP_WEB_URL',
        'FLIGHT_PROVIDERS_OPT_IN',
        'FLIGHT_PROVIDER_CALL_POLICIES',
        'HOTEL_PROVIDERS_OPT_IN',
        'HOTEL_PROVIDER_CALL_POLICIES',
        'INTERNAL_PROXY_SECRET',
        'JWT_SECRET',
        'NODE_ENV',
        'PGDATABASE',
        'PGHOST',
        'PGPASSWORD',
        'PGPORT',
        'PGUSER',
        'PLATFORM_DEFAULT_FLIGHT_PROVIDERS',
        'PLATFORM_DEFAULT_HOTEL_PROVIDERS',
        'PORT',
        'PROVIDERS_DISABLED',
        'PROVIDER_CREDENTIALS_KEY',
        'PROVIDER_PAYLOADS_KEY',
        'PROVIDER_PAYLOADS_RETENTION_DAYS',
        'REDIS_HOST',
        'REDIS_PASSWORD',
        'REDIS_PORT',
        'SHUTDOWN_DRAIN_TIMEOUT_MS',
      ].sort(),
    );
  });

  it('el api y el panel reciben el mismo INTERNAL_PROXY_SECRET, el que escribe el render', () => {
    const interpolation = '${INTERNAL_PROXY_SECRET:?falta INTERNAL_PROXY_SECRET}';
    expect(envOf(service(CERT, 'cert-api'))['INTERNAL_PROXY_SECRET']).toBe(interpolation);
    expect(envOf(service(CERT, 'cert-web-b2b'))['INTERNAL_PROXY_SECRET']).toBe(interpolation);
  });

  it('TBO encendido para el tenant del stack; nadie con credenciales de plataforma', () => {
    const env = envOf(service(CERT, 'cert-api'));
    expect(env['HOTEL_PROVIDERS_OPT_IN']).toBe('tbo-hotels');
    expect(env['PLATFORM_DEFAULT_HOTEL_PROVIDERS']).toBe('');
    expect(env['PLATFORM_DEFAULT_FLIGHT_PROVIDERS']).toBe('');
    expect(env['HOTEL_PROVIDER_CALL_POLICIES']).toBe('despegar-hotels:opt-in');
    expect(env['FLIGHT_PROVIDER_CALL_POLICIES']).toBe('latam-ndc:opt-in,sabre:opt-in');
    expect(env['FLIGHT_PROVIDERS_OPT_IN']).toBe('');
    expect(env['APP_WEB_URL']).toBe(`https://${CERT_HOST}`);
  });

  it('corre las mismas imágenes que producción, con el tag explícito y sin `latest`', () => {
    const prodImages = new Set(
      Object.values(PROD.services).map((s) =>
        (s.image ?? '').replace(/:\$\{IMAGE_TAG[^}]*\}$/, ''),
      ),
    );
    for (const [name, svc] of Object.entries(CERT.services)) {
      const image = svc.image ?? '';
      if (image.startsWith('ghcr.io/')) {
        expect(image, name).toMatch(/:\$\{IMAGE_TAG:\?[^}]*\}$/);
        expect(prodImages.has(image.replace(/:\$\{IMAGE_TAG[^}]*\}$/, '')), name).toBe(true);
      } else {
        expect(prodImages.has(image), `${name}: ${image} no es la imagen de producción`).toBe(true);
      }
    }
  });

  it('no publica puertos: sólo se entra por el Caddy de producción', () => {
    for (const [name, svc] of Object.entries(CERT.services)) {
      expect(svc.ports, name).toBeUndefined();
    }
  });

  it('la única red compartida la usan el Caddy y el panel, con nombres que no chocan', () => {
    const certNets = CERT.networks ?? {};
    const ingressKey = Object.keys(certNets).find((k) => certNets[k]?.name === INGRESS_NETWORK);
    expect(ingressKey).toBeDefined();
    expect(certNets[ingressKey ?? '']?.external).toBe(true);

    const onIngress = Object.entries(CERT.services)
      .filter(([, s]) => (s.networks ?? []).includes(ingressKey ?? ''))
      .map(([n]) => n);
    expect(onIngress).toEqual(['cert-web-b2b']);
    const prodNames = new Set(Object.keys(PROD.services));
    for (const name of onIngress) {
      // Docker publica el nombre del servicio como alias en la red: `web-b2b` aquí repartiría el
      // tráfico de app.planetour.cloud entre los dos stacks.
      expect(name.startsWith('cert-')).toBe(true);
      expect(prodNames.has(name)).toBe(false);
    }

    const prodNets = PROD.networks ?? {};
    const prodIngressKey = Object.keys(prodNets).find((k) => prodNets[k]?.name === INGRESS_NETWORK);
    expect(prodNets[prodIngressKey ?? '']?.external).toBe(true);
    const prodOnIngress = Object.entries(PROD.services)
      .filter(([, s]) => (s.networks ?? []).includes(prodIngressKey ?? ''))
      .map(([n]) => n);
    expect(prodOnIngress).toEqual(['caddy']);
  });

  it('las redes internas no salen a internet y el api del stack no está en la compartida', () => {
    expect(CERT.networks?.['internal']?.internal).toBe(true);
    expect(service(CERT, 'postgres').networks).toEqual(['internal']);
    expect(service(CERT, 'redis').networks).toEqual(['internal']);
    expect(service(CERT, 'cert-api').networks).toEqual(['internal', 'egress']);
  });

  it('el sync del catálogo entra por las redes del api: la interna y la de salida, no la compartida', () => {
    expect(render.CERT_EGRESS_NETWORK).toBe(`${CERT.name ?? ''}_egress`);
    // Con un `name:` propio la red dejaría de llamarse `<proyecto>_egress` y el `connect` fallaría.
    expect(CERT.networks?.['egress']?.name).toBeUndefined();
    expect(CERT.networks?.['egress']?.internal).not.toBe(true);
    expect(CERT.networks?.['egress']?.external).not.toBe(true);
  });

  it('la base, la red y el host del seed son los del compose', () => {
    expect(render.CERT_DATABASE).toBe(CERT_DATABASE);
    expect(envOf(service(CERT, 'postgres'))['POSTGRES_DB']).toBe(CERT_DATABASE);
    expect(envOf(service(CERT, 'migrate'))['PGDATABASE']).toBe(CERT_DATABASE);
    expect(envOf(service(CERT, 'cert-api'))['PGDATABASE']).toBe(CERT_DATABASE);
    expect(render.SEED_CONNECTION['PGDATABASE']).toBe(CERT_DATABASE);
    expect(Object.keys(CERT.services)).toContain(render.SEED_CONNECTION['PGHOST']);
    expect(render.SEED_CONNECTION['PGUSER']).toBe(
      envOf(service(CERT, 'postgres'))['POSTGRES_USER'],
    );
    expect(render.CERT_INTERNAL_NETWORK).toBe(`${CERT.name ?? ''}_internal`);
    expect(CERT.name).toBe('sales-travel-cert');
  });

  it('el panel llama al api del stack por la red interna', () => {
    const apiPort = envOf(service(CERT, 'cert-api'))['PORT'];
    expect(envOf(service(CERT, 'cert-web-b2b'))['INTERNAL_API_URL']).toBe(
      `http://cert-api:${apiPort ?? ''}`,
    );
  });
});

// ───────────────────────── Caddyfile ─────────────────────────

/** Sitio → upstreams de sus `reverse_proxy`. Sólo bloques de primer nivel, no snippets. */
function caddySites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of CADDYFILE.split('\n')) {
    const open = /^([a-z0-9*][a-z0-9.,* -]*?)\s*\{$/.exec(line);
    if (open?.[1] !== undefined) {
      current = open[1];
      sites.set(current, []);
      continue;
    }
    if (line === '}') {
      current = undefined;
      continue;
    }
    const proxy = /^\s+reverse_proxy (\S+)/.exec(line);
    if (current !== undefined && proxy?.[1] !== undefined) sites.get(current)?.push(proxy[1]);
  }
  return sites;
}

describe('Caddyfile', () => {
  it('cert-app lleva al panel del stack, por su nombre y su puerto', () => {
    const port = envOf(service(CERT, 'cert-web-b2b'))['PORT'];
    expect(caddySites().get(CERT_HOST)).toEqual([`cert-web-b2b:${port ?? ''}`]);
  });

  it('ningún sitio de producción apunta al stack ni el de certificación a producción', () => {
    for (const [site, upstreams] of caddySites()) {
      for (const upstream of upstreams) {
        expect(upstream.startsWith('cert-'), `${site} → ${upstream}`).toBe(site === CERT_HOST);
      }
    }
  });

  it('no publica un subdominio para el api del stack', () => {
    expect([...caddySites().values()].flat().some((u) => u.startsWith('cert-api'))).toBe(false);
  });
});

// ───────────────────────── deploy.yml ─────────────────────────

describe('deploy.yml: job deploy-cert', () => {
  const certJob = (): WorkflowJob => job('deploy-cert');
  const certJobText = (): string => JSON.stringify(certJob());

  it('sólo corre a mano con target = cert, y el despliegue de producción no', () => {
    expect(certJob().if).toMatch(
      /github\.event_name == 'workflow_dispatch' && inputs\.target == 'cert'/,
    );
    expect(certJob().needs).toBeUndefined();
    expect(job('deploy').if).toContain("inputs.target != 'cert'");
    expect(job('build').if).toContain("inputs.target != 'cert'");
  });

  it('no lee secrets ni variables de producción o de otro proveedor', () => {
    const text = certJobText();
    const secrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1] ?? '');
    const vars = [...text.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1] ?? '');
    const sshAccess = new Set(['HOSTINGER_SSH_KEY', 'HOSTINGER_HOST', 'HOSTINGER_USER']);
    expect(secrets.filter((n) => !n.startsWith('CERT_') && !sshAccess.has(n))).toEqual([]);
    expect(vars.filter((n) => !n.startsWith('CERT_') && n !== 'HOSTINGER_SSH_PORT')).toEqual([]);
    expect(text).not.toMatch(OTHER_PROVIDER_MENTION);
    // Un heredoc como el de producción no tendría lista cerrada.
    expect(text).not.toContain('cat > .env');
  });

  it('pasa al render cada variable que lee, de secrets o de vars según lo que es', () => {
    const render_ = step('deploy-cert', 'Render .env');
    expect(render_.run).toContain(
      'node infrastructure/hostinger/render-cert-env.mjs "$RUNNER_TEMP/cert-env"',
    );
    const env = render_.env ?? {};
    const rules = [...render.STACK_ENV, ...render.SEED_ENV, ...render.CATALOG_ENV];
    const wanted = new Set([...rules.map((r) => r.from), render.CATALOG_MODE_VARIABLE]);
    expect(Object.keys(env).sort()).toEqual([...wanted].sort());

    const secretKinds = new Set(['secret', 'key32']);
    for (const rule of rules) {
      const expression = env[rule.from] ?? '';
      if (rule.from === 'IMAGE_TAG') {
        expect(expression).toBe('${{ steps.img.outputs.tag }}');
      } else if (secretKinds.has(rule.kind) || SEED_SECRET_VARIABLES.includes(rule.from)) {
        expect(expression, rule.from).toBe(`\${{ secrets.${rule.from} }}`);
      } else {
        expect(expression, rule.from).toBe(`\${{ vars.${rule.from} }}`);
      }
    }
    expect(env[render.CATALOG_MODE_VARIABLE]).toBe('${{ inputs.cert_catalog }}');
  });

  it('siembra con docker run en la red interna del stack y borra seed.env pase lo que pase', () => {
    const run = step('deploy-cert', 'Pull, up & seed').run ?? '';
    expect(run).toContain("trap 'rm -f seed.env' EXIT");
    expect(run).toContain(
      `docker run --rm --network ${render.CERT_INTERNAL_NETWORK} --env-file seed.env`,
    );
    expect(run).toContain(`docker network create --internal ${INGRESS_NETWORK}`);
    expect(run).toContain(`grep -q '${CERT_HOST}' /etc/caddy/Caddyfile`);
    const sync = step('deploy-cert', 'Sync stack files').run ?? '';
    for (const file of [
      'docker-compose.cert.yml',
      'postgres-init',
      '"$RUNNER_TEMP/cert-env/.env"',
      '"$RUNNER_TEMP/cert-env/seed.env"',
    ]) {
      expect(sync).toContain(file);
    }
    // El heredoc no ve `env.CERT_DIR`: el directorio va escrito a mano y tiene que ser el mismo.
    expect(run).toContain(`cd ${certJob().env?.['CERT_DIR'] ?? '<sin CERT_DIR>'}\n`);
  });

  it('borra seed.env y catalog.env también si el paso que los usa no llega a correr', () => {
    // Los `trap` sólo cubren su propio paso: un rsync a medias o un job cancelado entre pasos los
    // saltan y dejarían la cuenta de TBO en claro en el VPS.
    const cleanup = step('deploy-cert', CLEANUP_STEP);
    expect(cleanup.if).toBe('always()');
    expect(cleanup.run).toContain(
      '"rm -f ${{ env.CERT_DIR }}/seed.env ${{ env.CERT_DIR }}/catalog.env"',
    );
    const names = certJob().steps.map((s) => s.name);
    expect(names.indexOf(CLEANUP_STEP)).toBeGreaterThan(names.indexOf('Sync stack files'));
    expect(names.indexOf(CLEANUP_STEP)).toBeGreaterThan(names.indexOf(CATALOG_STEP));
  });

  it('comprueba la imagen del seed antes de levantar el stack', () => {
    const run = step('deploy-cert', 'Pull, up & seed').run ?? '';
    const pull = run.indexOf('docker pull -q "$SEED_IMAGE"');
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(run.indexOf('$COMPOSE up -d'));
  });

  it('la imagen del seed es la que construye la matriz', () => {
    const { REGISTRY, IMAGE_OWNER, IMAGE_PREFIX } = WORKFLOW.env;
    const run = step('deploy-cert', 'Pull, up & seed').run ?? '';
    expect(run).toContain(
      `${REGISTRY ?? ''}/${IMAGE_OWNER ?? ''}/${IMAGE_PREFIX ?? ''}-${SEED_IMAGE_SUFFIX}:$TAG`,
    );
    const row = job('build').strategy?.matrix?.app?.find((a) => a.name === SEED_IMAGE_SUFFIX);
    expect(row?.dockerfile).toBe(`tools/${SEED_IMAGE_SUFFIX}/Dockerfile`);
    expect(existsSync(new URL(row?.dockerfile ?? '', REPO_ROOT))).toBe(true);
  });

  it('el catálogo es opcional y por despacho: none por defecto, un modo por cada uno del render', () => {
    const input = WORKFLOW.on?.workflow_dispatch?.inputs?.['cert_catalog'];
    expect(input).toMatchObject({ type: 'choice', default: 'none' });
    expect([...(input?.options ?? [])].sort()).toEqual(Object.keys(render.CATALOG_STAGES).sort());
    const runs = Object.entries(render.CATALOG_STAGES)
      .filter(([, stages]) => stages !== null)
      .map(([mode]) => `inputs.cert_catalog == '${mode}'`);
    expect(step('deploy-cert', CATALOG_STEP).if).toBe(runs.join(' || '));
  });

  it('el sync corre después del seed, en las redes del stack y con catalog.env de vida corta', () => {
    const names = certJob().steps.map((s) => s.name);
    // Después del seed: el seed rechaza una CERT_TBO_BASE_URL que no sea la de test de TBO.
    expect(names.indexOf(CATALOG_STEP)).toBeGreaterThan(names.indexOf('Pull, up & seed'));
    const run = step('deploy-cert', CATALOG_STEP).run ?? '';
    expect(run).toContain('"$RUNNER_TEMP/cert-env/catalog.env"');
    expect(run).toContain(`cd ${certJob().env?.['CERT_DIR'] ?? '<sin CERT_DIR>'}\n`);
    // El `trap` se pone antes de lo primero que puede fallar, y su limpieza borra catalog.env.
    const trap = run.indexOf('trap cleanup EXIT');
    expect(trap).toBeGreaterThan(-1);
    expect(trap).toBeLessThan(run.indexOf('docker pull'));
    const cleanupBody = /cleanup\(\) \{\n([\s\S]*?)\n\s*\}\n/.exec(run)?.[1] ?? '';
    expect(cleanupBody).toContain('rm -f catalog.env');
    const create = run.indexOf(
      `docker create --name "$NAME" --network ${render.CERT_INTERNAL_NETWORK} --env-file catalog.env "$IMAGE"`,
    );
    expect(create).toBeGreaterThan(-1);
    // Docker lee el env-file al crear el contenedor: el archivo no espera a las llamadas a TBO.
    const removed = run.indexOf('rm -f catalog.env', create);
    expect(removed).toBeGreaterThan(create);
    expect(removed).toBeLessThan(run.indexOf('docker start -a "$CID"'));
    expect(run).toContain(`docker network connect ${render.CERT_EGRESS_NETWORK} "$CID"`);
  });

  it('la imagen del sync es la del tag del stack y la construye la matriz', () => {
    const { REGISTRY, IMAGE_OWNER, IMAGE_PREFIX } = WORKFLOW.env;
    const run = step('deploy-cert', CATALOG_STEP).run ?? '';
    expect(run).toContain(
      `IMAGE="${REGISTRY ?? ''}/${IMAGE_OWNER ?? ''}/${IMAGE_PREFIX ?? ''}-${SYNC_IMAGE_SUFFIX}:$TAG"`,
    );
    const pull = run.indexOf('docker pull -q "$IMAGE"');
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(run.indexOf('docker create'));
    const row = job('build').strategy?.matrix?.app?.find((a) => a.name === SYNC_IMAGE_SUFFIX);
    expect(row?.dockerfile).toBe(`tools/${SYNC_IMAGE_SUFFIX}/Dockerfile`);
  });

  it('la corrida se detiene sola antes que el tope del VPS, y el tope antes que GitHub', () => {
    const catalogStep = step('deploy-cert', CATALOG_STEP);
    const budget = Number(render.CATALOG_FIXED['TBO_SYNC_MAX_MINUTES']);
    const guard = Number(/RUN_GUARD_MINUTES=(\d+)/.exec(catalogStep.run ?? '')?.[1]);
    const stepTimeout = catalogStep['timeout-minutes'] ?? Number.POSITIVE_INFINITY;
    const jobTimeout = certJob()['timeout-minutes'] ?? Number.POSITIVE_INFINITY;
    expect(guard).toBeGreaterThan(budget);
    // Descarga de la imagen, `--kill-after=90s` y `docker stop --time 60`.
    expect(guard + 4).toBeLessThanOrEqual(stepTimeout);
    // Más los 15 minutos del despliegue.
    expect(stepTimeout + 15).toBeLessThanOrEqual(jobTimeout);
  });

  it('el smoke test pega al host que sirve Caddy', () => {
    expect(step('deploy-cert', 'Smoke test').run).toContain(`https://${CERT_HOST}/login`);
  });

  it('producción crea la red compartida antes de levantar su compose, que la declara external', () => {
    const run = step('deploy', 'Pull & up').run ?? '';
    const create = run.indexOf(`docker network create --internal ${INGRESS_NETWORK}`);
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeLessThan(run.indexOf('docker compose --env-file .env pull'));
  });
});

// ───────────────────────── seed ↔ render ↔ README ─────────────────────────

describe('seed, render y README', () => {
  it('el render escribe en seed.env exactamente lo que lee el seed', () => {
    const fromRender = render.SEED_ENV.map((r) => r.name).filter(
      (n) => n !== 'PGPASSWORD' && n !== 'PROVIDER_CREDENTIALS_KEY',
    );
    expect([...fromRender].sort()).toEqual([...SEED_ENV_VARIABLES].sort());
  });

  it('las credenciales del seed son obligatorias en el render', () => {
    for (const name of SEED_SECRET_VARIABLES) {
      expect(render.SEED_ENV.find((r) => r.name === name)?.optional, name).not.toBe(true);
    }
  });

  it('el README documenta cada secret y variable del job, y el registro DNS', () => {
    const names = new Set([...certJobNames()].filter((n) => n.startsWith('CERT_')));
    expect(names.size).toBeGreaterThan(15);
    for (const name of names) expect(README, name).toContain(`\`${name}\``);
    expect(README).toContain('`cert-app`');
    expect(README).toContain(INGRESS_NETWORK);
  });
});

function certJobNames(): Set<string> {
  const text = JSON.stringify(job('deploy-cert'));
  return new Set([...text.matchAll(/(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((m) => m[1] ?? ''));
}
