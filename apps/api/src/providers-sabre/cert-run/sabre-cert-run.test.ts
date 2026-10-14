import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { SABRE_HOSTS } from '@sales-travel/sabre';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformRootId } from '../../__fixtures__/platform-root.js';
import { DatabaseService } from '../../database/database.service.js';
import { encryptCredentials } from '../../provider-credentials/credentials-cipher.js';
import { ProviderCredentialsService } from '../../provider-credentials/provider-credentials.service.js';
import { SABRE_PROVIDER_CODE, SabreProviderFactory } from '../sabre.factory.js';
import { main, type CertRunContext, type CertRunHooks } from './sabre-cert-run.js';
import { CERT_EXIT } from './summary.js';

/**
 * El CLI del arnés por su puerta pública (`main`), con la bóveda de verdad: lo que se prueba es el
 * cableado —que la guarda corre antes de la primera llamada y que el `fetch` del proceso es el de
 * CERT— y no cada pieza por separado, que ya tiene su test.
 *
 * El `fetch` de abajo es el cable: el arnés lo envuelve con su transporte, así que lo que llega aquí
 * es lo que habría salido a la red. El contexto son los mismos tres servicios de `CertRunModule`
 * armados a mano: Vitest compila sin los metadatos con los que Nest inyecta por tipo. La parte con
 * base se SALTA sin PGHOST.
 */

/** `CertRunModule` a mano: la base, la bóveda y el factory, construidos cuando el arnés lo pide. */
const CONTEXTO: CertRunHooks = {
  createContext: () => {
    const db = new DatabaseService();
    db.onModuleInit();
    const creds = new ProviderCredentialsService(db);
    // Se construye aquí, después de que el arnés fija su `SABRE_OPERATIONS`, como en Nest.
    const factory = new SabreProviderFactory(creds);
    const context = {
      get: (token: unknown) => {
        if (token === ProviderCredentialsService) return creds;
        if (token === SabreProviderFactory) return factory;
        throw new Error('el arnés pidió algo que CertRunModule no tiene');
      },
      close: () => db.onModuleDestroy(),
    };
    return Promise.resolve(context as unknown as CertRunContext);
  },
};

const EPR = 'EPR-ARNES-CERT';
const PASSWORD = 'clave-de-la-oficina-cert';
const HOME_PCC = 'Z9XY';
const ACCESS_TOKEN = 'T1RLAQ-token-del-arnes-0123456789abcdef';

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sabre-cert-run — antes de tocar nada', () => {
  it('--plan imprime el plan y sale con 0: ni base ni red', async () => {
    const contexto = vi.spyOn(NestFactory, 'createApplicationContext');
    const cable = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', cable);

    const code = await main(['--plan', '--scenarios', 'sab-12']);

    expect(code).toBe(CERT_EXIT.OK);
    expect(contexto).not.toHaveBeenCalled();
    expect(cable).not.toHaveBeenCalled();
    expect(stdout.join('')).toContain('Plan de la corrida contra Sabre CERT');
  });

  it('lo que mueve dinero sin --allow-money se niega (3) antes de abrir la base', async () => {
    const contexto = vi.spyOn(NestFactory, 'createApplicationContext');
    const code = await main([
      '--owner-tenant',
      '11111111-1111-4111-8111-111111111111',
      '--scenarios',
      'sab-13',
    ]);
    expect(code).toBe(CERT_EXIT.REFUSED);
    expect(contexto).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('--allow-money');
  });
});

const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('sabre-cert-run — con la cuenta de la bóveda (Postgres)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  // `--out` es una ruta absoluta POSIX; en Windows cae en la unidad actual.
  const OUT = `/tmp/st-cert-run-test-${sfx}`;
  const operaciones = process.env['SABRE_OPERATIONS'];
  let cert: string;
  let produccion: string;

  async function tenantConCuenta(slug: string, config: Record<string, unknown>): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', 'consolidator', $2) RETURNING id`,
      [slug, await platformRootId(pool)],
    );
    const id = rows[0]!.id;
    await pool.query(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1, $2, 'default', $3, $4::jsonb, false, 'active')`,
      [
        id,
        SABRE_PROVIDER_CODE,
        encryptCredentials(JSON.stringify({ epr: EPR, password: PASSWORD, homePcc: HOME_PCC })),
        JSON.stringify(config),
      ],
    );
    return id;
  }

  async function evidencia(runId: string): Promise<Map<string, string>> {
    const dir = join(OUT, runId);
    const files = new Map<string, string>();
    for (const name of await readdir(dir)) files.set(name, await readFile(join(dir, name), 'utf8'));
    return files;
  }

  beforeAll(async () => {
    cert = await tenantConCuenta(`cert-run-c-${sfx}`, { environment: 'cert' });
    produccion = await tenantConCuenta(`cert-run-p-${sfx}`, {
      environment: 'cert',
      host: SABRE_HOSTS.prod.rest,
    });
  });

  afterAll(async () => {
    for (const id of [cert, produccion]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await pool.end();
    await rm(OUT, { recursive: true, force: true });
    if (operaciones === undefined) delete process.env['SABRE_OPERATIONS'];
    else process.env['SABRE_OPERATIONS'] = operaciones;
  });

  it('una cuenta marcada CERT con el host de producción no corre (3) y no sale ni una llamada', async () => {
    const cable = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', cable);

    const code = await main(
      ['--owner-tenant', produccion, '--scenarios', 'auth', '--out', OUT, '--run-id', 'prod-host'],
      CONTEXTO,
    );

    expect(code).toBe(CERT_EXIT.REFUSED);
    expect(cable).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('NO SE CORRE');
    const files = await evidencia('prod-host');
    expect(JSON.parse(files.get('summary.json') ?? '{}')).toMatchObject({ outcome: 'refused' });
  });

  it('la cuenta CERT corre por el transporte de CERT, y la evidencia no lleva la credencial', async () => {
    const cable = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 604800 }),
      ),
    );
    vi.stubGlobal('fetch', cable);

    const code = await main(
      ['--owner-tenant', cert, '--scenarios', 'auth', '--out', OUT, '--run-id', 'cert-auth'],
      CONTEXTO,
    );

    expect(code).toBe(CERT_EXIT.OK);
    // Una sola llamada, al token de CERT, y sin seguir redirecciones: es el transporte del arnés,
    // no el `fetch` pelado.
    expect(cable).toHaveBeenCalledTimes(1);
    const [url, init] = cable.mock.calls[0]!;
    expect(url).toBe(`${SABRE_HOSTS.cert.rest}/v2/auth/token`);
    expect(init?.redirect).toBe('error');

    const files = await evidencia('cert-auth');
    expect([...files.keys()].sort()).toEqual(['01-auth-token.json', 'summary.json', 'summary.md']);
    const texto = [...files.values(), stdout.join(''), stderr.join('')].join('\n');
    for (const testigo of [EPR, PASSWORD, HOME_PCC, ACCESS_TOKEN]) {
      expect(texto, `se filtró ${testigo}`).not.toContain(testigo);
    }
    expect(JSON.parse(files.get('summary.json') ?? '{}')).toMatchObject({
      outcome: 'ok',
      account: { environment: 'cert', providerEnvironment: 'test' },
      steps: [{ scenario: 'auth', step: 'token', outcome: 'ok', calls: 1 }],
    });
  });
});
