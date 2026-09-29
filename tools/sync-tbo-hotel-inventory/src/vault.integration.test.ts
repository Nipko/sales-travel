import { randomBytes } from 'node:crypto';
import type { TboRateLimiter } from '@sales-travel/tbo-hotels';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type DbSession } from './cli.js';
import type { SyncEnv } from './env.js';
import { fakeTbo, type FakeTboWorld } from './testing/fake-tbo.js';
import { MemoryCatalogStore } from './testing/memory-catalog-store.js';

/**
 * La cuenta de TBO de Planetour en `provider_accounts` (0012), cifrada por el MÓDULO del api, y el
 * sync arrancando con ella contra un TBO falso (D-TBO-04, decisión del founder del 2026-09-29).
 *
 * Se SALTA sin `PGHOST`/`PGUSER`/`PGPASSWORD`, como los demás `*.integration.test.ts`; en CI corre
 * contra la base migrada y con el superusuario, que es como corre el sync en el VPS.
 *
 * La base de CI la comparten los tests de `apps/api` y de `tools/`, en paralelo, y a la raíz
 * `platform` no se le cuelgan cuentas (apps/api/src/__fixtures__/platform-root.ts): la heredaría la
 * red de cualquier otro test. Por eso cada caso siembra su cuenta DENTRO de una transacción que se
 * deshace siempre, y el sync consulta por esa misma conexión. El catálogo va a un almacén en
 * memoria: aquí se prueba de dónde sale la credencial, no el escritor (writer.integration.test.ts).
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const API_SRC = new URL('../../../apps/api/src/', import.meta.url);

interface ApiCredentialsCipher {
  encryptCredentials(plaintext: string, key?: Buffer): Buffer;
}

// Con forma reconocible para buscarlas en la salida. No son credenciales.
const USERNAME = 'planetour-boveda-it';
const PASSWORD = ` Pa55-it-${randomBytes(3).toString('hex')} `;
const BASIC = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
const KEY = randomBytes(32);

const WORLD: FakeTboWorld = {
  countries: ['AR'],
  cities: { AR: [{ code: '900001', name: 'Buenos Aires' }] },
  hotels: { '900001': [{ code: '1000001', lat: -34.6, lng: -58.38 }] },
  codelist: ['1000001'],
};

const immediateLimiter: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

// Sin las `PG*` del proceso: la conexión la pone el test, y así la clave de CI
// (`PROVIDER_CREDENTIALS_KEY` del job) tampoco se cuela.
const ENV: SyncEnv = {
  PROVIDER_CREDENTIALS_KEY: KEY.toString('base64'),
  TBO_SYNC_COUNTRIES: 'AR',
  TBO_SYNC_STAGES: 'E1,E2,E3',
  TBO_SYNC_LOG_LEVEL: 'debug',
};

d('la bóveda de la raíz platform en Postgres → el sync', () => {
  let db: pg.Client;
  let api: ApiCredentialsCipher;
  let platform: { id: string; slug: string };

  beforeAll(async () => {
    api = (await import(
      new URL('provider-credentials/credentials-cipher.ts', API_SRC).href
    )) as ApiCredentialsCipher;
    db = new pg.Client();
    await db.connect();
    // La raíz común de la base de pruebas, como platformRootId(): buscar o crear, nunca borrar.
    await db.query(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type)
       VALUES ('it-platform', 'Plataforma de pruebas', 'CO', 'COP', 'platform')
       ON CONFLICT DO NOTHING`,
    );
    const { rows } = await db.query<{ id: string; slug: string }>(
      `SELECT id::text AS id, slug::text AS slug FROM tenants WHERE tenant_type = 'platform'`,
    );
    if (rows[0] === undefined) throw new Error('la base de pruebas no tiene raíz platform');
    platform = rows[0];
  });

  afterAll(async () => {
    await db?.end();
  });

  /** Siembra y corre dentro de una transacción que se deshace: nadie más ve la cuenta. */
  async function sandbox<T>(fn: (session: DbSession) => Promise<T>): Promise<T> {
    await db.query('BEGIN');
    try {
      await db.query(
        'DELETE FROM provider_accounts WHERE tenant_id = $1::uuid AND provider_code = $2',
        [platform.id, 'tbo-hotels'],
      );
      return await fn({
        query: (text, values) => db.query(text, values),
        end: () => Promise.resolve(),
      });
    } finally {
      await db.query('ROLLBACK');
    }
  }

  async function seedAccount(
    status: 'active' | 'sandbox',
    credentials: Readonly<Record<string, unknown>>,
    owner: { readonly tenantId?: string; readonly label?: string } = {},
  ): Promise<void> {
    await db.query(
      `INSERT INTO provider_accounts
         (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1::uuid, 'tbo-hotels', $2, $3, $4::jsonb, true, $5)`,
      [
        owner.tenantId ?? platform.id,
        owner.label ?? 'default',
        api.encryptCredentials(JSON.stringify(credentials), KEY),
        JSON.stringify({ environment: 'test' }),
        status,
      ],
    );
  }

  /** Un consolidador bajo la raíz, dueño de su propia cuenta de TBO (D-TBO-03 A). */
  async function seedConsolidator(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ('it-sync-vault-consolidator', 'Consolidador de pruebas', 'CO', 'COP', 'consolidator', $1::uuid)
       RETURNING id::text AS id`,
      [platform.id],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('no se creó el consolidador');
    return id;
  }

  async function run(session: DbSession) {
    const raw: string[] = [];
    const tbo = fakeTbo(WORLD);
    const store = new MemoryCatalogStore('tbo-hotels');
    const code = await runCli({
      env: ENV,
      connect: () => Promise.resolve(session),
      store,
      fetch: tbo.fetch,
      sleep: () => Promise.resolve(),
      limiter: immediateLimiter,
      sink: (line) => raw.push(line),
    });
    const lines = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
    return {
      code,
      raw: raw.join('\n'),
      store,
      tbo,
      line: (msg: string) => lines.find((entry) => entry['msg'] === msg),
    };
  }

  it('la cuenta activa que cifró el api: el sync llama a TBO con ella y el log no la muestra', async () => {
    const result = await sandbox(async (session) => {
      await seedAccount('active', { username: USERNAME, password: PASSWORD });
      return run(session);
    });

    expect(result.code).toBe(0);
    const auth = new Set(result.tbo.calls.map((call) => call.headers['authorization']));
    expect([...auth]).toEqual([`Basic ${BASIC}`]);
    expect(result.store.hotel('1000001')?.active).toBe(true);
    const source = `vault:${platform.slug}/default`;
    expect(result.line('tbo.sync.credentials')).toMatchObject({
      credentialSource: source,
      environment: 'test',
    });
    expect(result.line('tbo.sync.result')).toMatchObject({ ok: true, credentialSource: source });

    expect(result.raw).not.toMatch(/authorization/i);
    for (const secret of [BASIC, USERNAME, PASSWORD.trim(), KEY.toString('base64')]) {
      expect(result.raw).not.toContain(secret);
    }
  });

  it('una cuenta en Sandbox no se usa: "sin credenciales" con salida 0, sin llamar a TBO', async () => {
    const result = await sandbox(async (session) => {
      await seedAccount('sandbox', { username: USERNAME, password: PASSWORD });
      return run(session);
    });

    expect(result.code).toBe(0);
    expect(result.tbo.calls).toHaveLength(0);
    expect(result.line('tbo.sync.result')).toMatchObject({
      action: 'skip',
      reason: `TBO_SYNC_USERNAME, TBO_SYNC_PASSWORD not set and no active tbo-hotels account in the vault of '${platform.slug}' (inactive: default=sandbox)`,
    });
  });

  it('la cuenta activa de un consolidador de la red nunca es la del sync, aunque sea `catalogo`', async () => {
    const consolidator = { username: 'consolidador-it', password: 'Pa55-consolidador-it' };

    // Sin cuenta en la raíz: "sin credenciales", no la del consolidador.
    const alone = await sandbox(async (session) => {
      await seedAccount('active', consolidator, { tenantId: await seedConsolidator() });
      return run(session);
    });
    expect(alone.code).toBe(0);
    expect(alone.tbo.calls).toHaveLength(0);
    expect(alone.line('tbo.sync.result')).toMatchObject({
      action: 'skip',
      reason: `TBO_SYNC_USERNAME, TBO_SYNC_PASSWORD not set and no active tbo-hotels account in the vault of '${platform.slug}'`,
    });

    // Con la `default` de la raíz y una `catalogo` del consolidador: la de la raíz.
    const both = await sandbox(async (session) => {
      await seedAccount('active', consolidator, {
        tenantId: await seedConsolidator(),
        label: 'catalogo',
      });
      await seedAccount('active', { username: USERNAME, password: PASSWORD });
      return run(session);
    });
    expect(both.code).toBe(0);
    const auth = new Set(both.tbo.calls.map((call) => call.headers['authorization']));
    expect([...auth]).toEqual([`Basic ${BASIC}`]);
    expect(both.line('tbo.sync.credentials')).toMatchObject({
      credentialSource: `vault:${platform.slug}/default`,
    });
    for (const secret of [consolidator.username, consolidator.password]) {
      expect(alone.raw).not.toContain(secret);
      expect(both.raw).not.toContain(secret);
    }
  });

  it('la cuenta existe pero la clave es otra: salida 1 nombrando la cuenta, no la credencial', async () => {
    const result = await sandbox(async (session) => {
      await seedAccount('active', { username: USERNAME, password: PASSWORD });
      const raw: string[] = [];
      const code = await runCli({
        env: { ...ENV, PROVIDER_CREDENTIALS_KEY: randomBytes(32).toString('base64') },
        connect: () => Promise.resolve(session),
        store: new MemoryCatalogStore('tbo-hotels'),
        fetch: fakeTbo(WORLD).fetch,
        sink: (line) => raw.push(line),
      });
      return { code, raw: raw.join('\n') };
    });

    expect(result.code).toBe(1);
    expect(result.raw).toContain('"code":"undecryptable"');
    expect(result.raw).toContain(`"account":"${platform.slug}/default"`);
    expect(result.raw).not.toContain(USERNAME);
  });
});
