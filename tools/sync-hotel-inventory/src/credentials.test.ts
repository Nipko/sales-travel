import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  chooseCredentials,
  platformAccounts,
  type Queryable,
  type VaultAccountRow,
} from './credentials.js';

/**
 * El sync toma la clave de la cuenta de Despegar que el superadmin cargó en la plataforma. Se cifra
 * con el módulo del api (no con una copia): si el api cambia de formato, falla aquí y no el sync.
 * Se importa por ruta en tiempo de ejecución porque una herramienta no depende de `apps/api`.
 */
const API_SRC = new URL('../../../apps/api/src/', import.meta.url);

interface ApiCredentialsCipher {
  encryptCredentials(plaintext: string, key?: Buffer): Buffer;
}

const MASTER = randomBytes(32);
const ENV = { PROVIDER_CREDENTIALS_KEY: MASTER.toString('base64') };
let api: ApiCredentialsCipher;

beforeAll(async () => {
  api = (await import(
    new URL('provider-credentials/credentials-cipher.ts', API_SRC).href
  )) as ApiCredentialsCipher;
});

function account(credentials: object, config: object = {}, label = 'Despegar'): VaultAccountRow {
  return {
    label,
    credentials_enc: api.encryptCredentials(JSON.stringify(credentials), MASTER),
    config,
  };
}

describe('chooseCredentials', () => {
  it('abre la cuenta de la plataforma y usa su apiKey y su baseUrl', () => {
    const got = chooseCredentials(ENV, {
      platforms: 1,
      accounts: [account({ apiKey: 'k-cuenta' }, { baseUrl: 'https://apis-uat.despegar.com/v3/' })],
    });
    expect(got).toEqual({
      kind: 'chosen',
      source: 'vault',
      apiKey: 'k-cuenta',
      baseUrl: 'https://apis-uat.despegar.com/v3',
      label: 'Despegar',
    });
  });

  it('sin baseUrl en la cuenta, el sandbox', () => {
    const got = chooseCredentials(ENV, { platforms: 1, accounts: [account({ apiKey: 'k' })] });
    expect(got).toMatchObject({ kind: 'chosen', baseUrl: DEFAULT_BASE_URL });
  });

  it('una baseUrl que no es https no recibe la clave', () => {
    const got = chooseCredentials(ENV, {
      platforms: 1,
      accounts: [account({ apiKey: 'k' }, { baseUrl: 'http://evil.example' })],
    });
    expect(got).toMatchObject({ baseUrl: DEFAULT_BASE_URL });
  });

  it('DESPEGAR_API_KEY manda sobre la bóveda; vacía, no cuenta', () => {
    const vault = { platforms: 1, accounts: [account({ apiKey: 'k-cuenta' })] };
    expect(chooseCredentials({ ...ENV, DESPEGAR_API_KEY: 'k-env' }, vault)).toMatchObject({
      source: 'env',
      apiKey: 'k-env',
    });
    expect(chooseCredentials({ ...ENV, DESPEGAR_API_KEY: '' }, vault)).toMatchObject({
      source: 'vault',
      apiKey: 'k-cuenta',
    });
  });

  it('sin cuenta activa o sin una única plataforma, no hay sync (sin error)', () => {
    expect(chooseCredentials(ENV, { platforms: 1, accounts: [] })).toMatchObject({ kind: 'none' });
    expect(chooseCredentials(ENV, { platforms: 0, accounts: [] })).toMatchObject({ kind: 'none' });
    expect(chooseCredentials(ENV, { platforms: 2, accounts: [] })).toMatchObject({ kind: 'none' });
  });

  it('con cuenta pero sin la clave maestra correcta, falla visible y sin mostrar la apiKey', () => {
    const vault = { platforms: 1, accounts: [account({ apiKey: 'secreto-123' })] };
    expect(() => chooseCredentials({}, vault)).toThrow(/PROVIDER_CREDENTIALS_KEY/);
    const otra = { PROVIDER_CREDENTIALS_KEY: randomBytes(32).toString('base64') };
    expect(() => chooseCredentials(otra, vault)).toThrow(/cannot be opened/);
    try {
      chooseCredentials(otra, vault);
    } catch (err) {
      expect(String(err)).not.toContain('secreto-123');
    }
  });

  it('una cuenta sin apiKey o sin credenciales falla visible', () => {
    expect(() =>
      chooseCredentials(ENV, { platforms: 1, accounts: [account({ otra: 'x' })] }),
    ).toThrow(/no apiKey/);
    expect(() =>
      chooseCredentials(ENV, {
        platforms: 1,
        accounts: [{ label: 'D', credentials_enc: null, config: {} }],
      }),
    ).toThrow(/no stored credentials/);
  });
});

describe('platformAccounts', () => {
  it('lee sólo las cuentas activas del tenant raíz de la plataforma', async () => {
    const calls: { text: string; values?: unknown[] }[] = [];
    const db: Queryable = {
      query: <R>(text: string, values?: unknown[]) => {
        calls.push({ text, ...(values === undefined ? {} : { values }) });
        const rows = text.includes('FROM tenants') ? [{ id: 'root' }] : [{ label: 'D' }];
        return Promise.resolve({ rows: rows as R[] });
      },
    };
    const got = await platformAccounts(db, 'despegar-hotels');
    expect(got.platforms).toBe(1);
    expect(got.accounts).toHaveLength(1);
    expect(calls[1]?.values).toEqual(['root', 'despegar-hotels']);
    expect(calls[1]?.text).toContain("status = 'active'");
  });

  it('con dos plataformas raíz no elige ninguna', async () => {
    const db: Queryable = {
      query: <R>() => Promise.resolve({ rows: [{ id: 'a' }, { id: 'b' }] as R[] }),
    };
    expect(await platformAccounts(db, 'despegar-hotels')).toEqual({ platforms: 2, accounts: [] });
  });
});
