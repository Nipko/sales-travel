import { randomBytes } from 'node:crypto';
import { TBO_BASE_URLS, TBO_HOTELS_PROVIDER_CODE } from '@sales-travel/tbo-hotels';
import { describe, expect, it, vi } from 'vitest';
import { resolveSyncEnv, type SyncCredentialOverride, type SyncEnv } from './env.js';
import { SyncConfigError, SyncVaultError } from './errors.js';
import {
  MemoryCatalogVault,
  sealCredentials,
  type MemoryAccountInput,
} from './testing/memory-vault.js';
import {
  openCatalogAccount,
  resolveCatalogCredentials,
  selectCatalogAccount,
  type CatalogVault,
  type VaultAccount,
  type VaultSnapshot,
} from './vault.js';

/**
 * Qué cuenta usa el sync y cómo la abre (D-TBO-04, decisión del founder del 2026-09-29): el
 * override del entorno, si no la de la bóveda de la raíz `platform`, y si no, nada.
 */

// Con forma reconocible para buscarlas en cualquier mensaje. No son credenciales.
const USERNAME = 'planetour-boveda-demo';
const PASSWORD = ' Pa55-boveda:demo ';
const KEY = randomBytes(32);
const ENV: SyncEnv = { PROVIDER_CREDENTIALS_KEY: KEY.toString('base64') };
const PROVIDER = TBO_HOTELS_PROVIDER_CODE;

function account(label: string, status = 'active'): VaultAccount {
  return { id: `id-${label}`, label, status, credentialsEnc: null, config: {} };
}

function snapshot(accounts: readonly VaultAccount[]): VaultSnapshot {
  return { platforms: [{ id: 'root', slug: 'platform' }], accounts };
}

function chosenLabel(accounts: readonly VaultAccount[]): string {
  const selection = selectCatalogAccount(snapshot(accounts), PROVIDER);
  if (selection.kind !== 'chosen') throw new Error(`esperaba una cuenta, fue ${selection.reason}`);
  return selection.account.label;
}

function vaultError(fn: () => unknown): SyncVaultError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SyncVaultError);
    const message = (err as Error).message;
    expect(message).not.toContain(USERNAME);
    expect(message).not.toContain(PASSWORD.trim());
    return err as SyncVaultError;
  }
  throw new Error('esperaba SyncVaultError');
}

async function openWith(input: MemoryAccountInput, env: SyncEnv = ENV) {
  const vault = new MemoryCatalogVault(KEY, [input]);
  const selection = selectCatalogAccount(await vault.platformAccounts(PROVIDER), PROVIDER);
  if (selection.kind !== 'chosen') throw new Error('esperaba una cuenta');
  return () => openCatalogAccount(selection, env);
}

const CREDENTIALS = { username: USERNAME, password: PASSWORD };

describe('selectCatalogAccount: qué cuenta de la bóveda usa el sync', () => {
  it('sin raíz platform, o sin cuenta activa, no hay cuenta: es "todavía no", no un error', () => {
    expect(selectCatalogAccount({ platforms: [], accounts: [] }, PROVIDER)).toEqual({
      kind: 'none',
      reason: 'no platform tenant in the database',
    });
    expect(selectCatalogAccount(snapshot([]), PROVIDER)).toEqual({
      kind: 'none',
      reason: "no active tbo-hotels account in the vault of 'platform'",
    });
    // La cuenta en Sandbox existe pero no resuelve, igual que para el api (0012).
    expect(selectCatalogAccount(snapshot([account('default', 'sandbox')]), PROVIDER)).toEqual({
      kind: 'none',
      reason: "no active tbo-hotels account in the vault of 'platform' (inactive: default=sandbox)",
    });
  });

  it('una sola activa se usa, se llame como se llame', () => {
    expect(chosenLabel([account('default')])).toBe('default');
    expect(chosenLabel([account('reservas'), account('vieja', 'disabled')])).toBe('reservas');
  });

  it('con varias, primero la de catálogo (sin mayúsculas ni tildes) y después la default', () => {
    expect(chosenLabel([account('default'), account('catalogo')])).toBe('catalogo');
    expect(chosenLabel([account('default'), account(' Catálogo ')])).toBe(' Catálogo ');
    expect(chosenLabel([account('otra'), account('default')])).toBe('default');
    // Una `catalogo` en sandbox no cuenta: se usa la activa.
    expect(chosenLabel([account('default'), account('catalogo', 'sandbox')])).toBe('default');
  });

  it('varias activas sin una elección clara: error que nombra las etiquetas', () => {
    const err = vaultError(() =>
      selectCatalogAccount(snapshot([account('ventas'), account('pruebas')]), PROVIDER),
    );
    expect(err.toLogMeta()).toEqual({
      errorClass: 'SyncVaultError',
      code: 'ambiguous_accounts',
      account: 'platform',
      details: ['ventas', 'pruebas'],
    });
    expect(
      vaultError(() =>
        selectCatalogAccount(snapshot([account('catalogo'), account('Catálogo')]), PROVIDER),
      ).details,
    ).toEqual(['catalogo', 'Catálogo']);
  });

  it('dos raíces platform (0050 lo impide): error, no una elegida al azar', () => {
    const err = vaultError(() =>
      selectCatalogAccount(
        {
          platforms: [
            { id: 'a', slug: 'platform' },
            { id: 'b', slug: 'otra' },
          ],
          accounts: [],
        },
        PROVIDER,
      ),
    );
    expect(err.code).toBe('ambiguous_platform');
  });
});

describe('openCatalogAccount: la cuenta como la lee el api', () => {
  it('usuario y contraseña del blob, entorno y URL de config, sin recortar la contraseña', async () => {
    const opened = (
      await openWith({
        credentials: CREDENTIALS,
        config: { environment: 'test', baseUrl: `${TBO_BASE_URLS.test}/` },
      })
    )();
    expect(opened.source).toBe('vault:platform/default');
    expect(opened.context).toEqual({ ownerTenantId: '00000000-0000-4000-8000-000000000001' });
    expect(opened.tbo.environment).toBe('test');
    expect(opened.tbo.baseUrl).toBe(TBO_BASE_URLS.test);
    expect(opened.tbo.username?.reveal()).toBe(USERNAME);
    expect(opened.tbo.password?.reveal()).toBe(PASSWORD);
    expect(JSON.stringify(opened)).not.toContain(PASSWORD);
  });

  it('en test sin URL, la de test del ACL; en live, la URL https de la cuenta', async () => {
    expect((await openWith({ credentials: CREDENTIALS }))().tbo.baseUrl).toBe(TBO_BASE_URLS.test);
    const live = (
      await openWith({
        credentials: CREDENTIALS,
        config: { environment: 'live', baseUrl: 'https://live.example.test/HotelAPI' },
      })
    )();
    expect(live.tbo.environment).toBe('live');
    expect(live.tbo.baseUrl).toBe('https://live.example.test/HotelAPI');
  });

  it('sin clave o con una que no es base64 de 32 bytes: el despliegue está roto (salida 1)', async () => {
    const cases: readonly (readonly [SyncEnv, string])[] = [
      [{}, 'PROVIDER_CREDENTIALS_KEY:required'],
      [{ PROVIDER_CREDENTIALS_KEY: '  ' }, 'PROVIDER_CREDENTIALS_KEY:required'],
      [
        { PROVIDER_CREDENTIALS_KEY: randomBytes(16).toString('base64') },
        'PROVIDER_CREDENTIALS_KEY:not_base64_32_bytes',
      ],
    ];
    for (const [env, issue] of cases) {
      const open = await openWith({ credentials: CREDENTIALS }, env);
      let caught: unknown;
      try {
        open();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SyncConfigError);
      expect((caught as SyncConfigError).issues).toEqual([issue]);
    }
  });

  it('otra clave: la cuenta no se descifra y se dice cuál', async () => {
    const err = vaultError(await openWith({ credentials: CREDENTIALS, sealWith: randomBytes(32) }));
    expect(err.toLogMeta()).toEqual({
      errorClass: 'SyncVaultError',
      code: 'undecryptable',
      account: 'platform/default',
      details: [],
    });
  });

  it('un blob que no es un objeto JSON no se cita en el error', async () => {
    const array = vaultError(await openWith({ credentials: [USERNAME, PASSWORD] }));
    expect(array.code).toBe('unreadable_credentials');

    // Texto plano cifrado con la clave buena: se abre, pero `JSON.parse` citaría un trozo.
    const plain = selectCatalogAccount(
      snapshot([
        {
          ...account('default'),
          credentialsEnc: sealCredentials(`usuario ${USERNAME} clave ${PASSWORD}`, KEY),
          config: { environment: 'test' },
        },
      ]),
      PROVIDER,
    );
    if (plain.kind !== 'chosen') throw new Error('esperaba una cuenta');
    expect(vaultError(() => openCatalogAccount(plain, ENV)).code).toBe('unreadable_credentials');
  });

  it('las reglas del ACL, con `campo:código` y nunca el valor', async () => {
    expect(
      vaultError(await openWith({ credentials: CREDENTIALS, config: {} })).toLogMeta(),
    ).toEqual({
      errorClass: 'SyncVaultError',
      code: 'invalid_config',
      account: 'platform/default',
      details: ['environment:invalid_type'],
    });
    expect(
      vaultError(
        await openWith({
          credentials: CREDENTIALS,
          config: { environment: 'live', baseUrl: 'http://live.example.test/HotelAPI' },
        }),
      ).details,
    ).toEqual(['baseUrl:https_required']);
    expect(
      vaultError(
        await openWith({ credentials: { username: 'con:dos-puntos', password: PASSWORD } }),
      ).details,
    ).toEqual(['username:colon_in_username']);
  });

  it('una cuenta incompleta dice qué falta: la contraseña, o la URL en live', async () => {
    const noPassword = vaultError(await openWith({ credentials: { username: USERNAME } }));
    expect([noPassword.code, noPassword.details]).toEqual(['incomplete', ['password']]);
    const liveNoUrl = vaultError(
      await openWith({ credentials: CREDENTIALS, config: { environment: 'live' } }),
    );
    expect([liveNoUrl.code, liveNoUrl.details]).toEqual(['incomplete', ['baseUrl']]);
  });
});

describe('resolveCatalogCredentials: precedencia', () => {
  function overrideOf(env: SyncEnv): SyncCredentialOverride {
    const resolution = resolveSyncEnv(env);
    if (resolution.kind !== 'run') throw new Error('esperaba run');
    return resolution.override;
  }

  it('1. el override del entorno manda y la bóveda ni se abre', async () => {
    const vault = vi.fn<() => Promise<CatalogVault>>();
    const found = await resolveCatalogCredentials({
      override: overrideOf({ TBO_SYNC_USERNAME: 'catalogo-env', TBO_SYNC_PASSWORD: 'p' }),
      env: ENV,
      providerCode: PROVIDER,
      vault,
    });
    expect(found).toMatchObject({
      kind: 'found',
      source: 'env',
      context: { credentialSource: 'env' },
    });
    expect(vault).not.toHaveBeenCalled();
  });

  it('2. sin override, la cuenta de la bóveda de la raíz platform', async () => {
    const vault = new MemoryCatalogVault(KEY, [{ credentials: CREDENTIALS }]);
    const found = await resolveCatalogCredentials({
      override: overrideOf({}),
      env: ENV,
      providerCode: PROVIDER,
      vault: () => Promise.resolve(vault),
    });
    if (found.kind !== 'found') throw new Error('esperaba una cuenta');
    expect(found.source).toBe('vault:platform/default');
    expect(found.tbo.username?.reveal()).toBe(USERNAME);
    expect(vault.calls).toEqual([PROVIDER]);
  });

  it('3. sin ninguna: "sin credenciales", nombrando el entorno y la bóveda', async () => {
    const none = await resolveCatalogCredentials({
      override: overrideOf({}),
      env: ENV,
      providerCode: PROVIDER,
      vault: () => Promise.resolve(new MemoryCatalogVault(KEY)),
    });
    expect(none).toEqual({
      kind: 'none',
      reason:
        "TBO_SYNC_USERNAME, TBO_SYNC_PASSWORD not set and no active tbo-hotels account in the vault of 'platform'",
    });
  });
});
