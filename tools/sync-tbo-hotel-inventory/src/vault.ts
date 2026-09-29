import {
  TboConfigError,
  missingTboCredentials,
  parseTboConfig,
  type TboAccountContext,
  type TboHotelsConfig,
} from '@sales-travel/tbo-hotels';
import type { SyncCredentialOverride, SyncEnv } from './env.js';
import { SyncConfigError, SyncVaultError } from './errors.js';
import { openCredentials, parseCredentialsKey } from './vault-crypto.js';
import type { Queryable } from './writer.js';

/**
 * De dónde saca el sync la cuenta de TBO (D-TBO-04, decisión del founder del 2026-09-29): de la
 * bóveda de Planetour, la raíz `platform` de la red, donde el superadmin la carga desde el panel
 * (_Proveedores (GDS)_). Así la credencial se administra en un solo lugar, cifrada, y no como secret
 * de GitHub Actions copiado al `.env` del VPS.
 *
 * Precedencia:
 *
 * 1. `TBO_SYNC_USERNAME` y `TBO_SYNC_PASSWORD` en el entorno: override explícito (el stack de
 *    certificación, o una prueba puntual). La bóveda ni se lee.
 * 2. La cuenta `tbo-hotels` activa de la raíz `platform`. Con varias activas, la de etiqueta
 *    `catalogo` (una cuenta dedicada al sync, que no le quita cupo a la venta) y si no, `default`
 *    (la que carga el panel); cualquier otra combinación es ambigua y falla nombrando las etiquetas.
 * 3. Ninguna → `none`, que `cli.ts` convierte en salida 0 "sin credenciales".
 *
 * La cuenta se lee como la lee el api (`ProviderCredentialsService.resolve` y
 * `TboHotelsProviderFactory.toConfig`): el blob con el cifrado del api (`vault-crypto.ts`), usuario
 * y contraseña SÓLO del blob, `environment` y `baseUrl` de `config`, y todo por `parseTboConfig` del
 * ACL. Una cuenta que el api rechazaría, el sync también.
 */

/** Etiqueta de una cuenta dedicada al catálogo. Se compara sin mayúsculas ni tildes: `Catálogo`. */
export const CATALOG_ACCOUNT_LABEL = 'catalogo';

/** La etiqueta que pone el panel al conectar un proveedor. */
export const DEFAULT_ACCOUNT_LABEL = 'default';

export interface VaultPlatform {
  readonly id: string;
  readonly slug: string;
}

export interface VaultAccount {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  /** Sólo de las activas: una en `sandbox` o `disabled` no se lee ni se descifra. */
  readonly credentialsEnc: Uint8Array | null;
  readonly config: unknown;
}

export interface VaultSnapshot {
  /** Las raíces `platform`: una (0050 la hace única) o ninguna en una base sin red. */
  readonly platforms: readonly VaultPlatform[];
  /** Las cuentas del proveedor de esa raíz, activas o no. */
  readonly accounts: readonly VaultAccount[];
}

export interface CatalogVault {
  platformAccounts(providerCode: string): Promise<VaultSnapshot>;
}

interface PlatformRow {
  id: string;
  slug: string;
}

interface AccountRow {
  id: string;
  label: string;
  status: string;
  credentials_enc: Uint8Array | null;
  config: unknown;
}

/**
 * La bóveda en Postgres. Corre con el superusuario, como el resto del sync: `provider_accounts`
 * tiene RLS (0012) y `app_user` sólo vería las cuentas del tenant fijado, es decir, ninguna.
 */
export class PgCatalogVault implements CatalogVault {
  constructor(private readonly db: Queryable) {}

  async platformAccounts(providerCode: string): Promise<VaultSnapshot> {
    const platforms = (
      await this.db.query<PlatformRow>(
        `SELECT id::text AS id, slug::text AS slug
           FROM tenants
          WHERE tenant_type = 'platform' AND parent_tenant_id IS NULL
          ORDER BY slug
          LIMIT 2`,
      )
    ).rows;
    const root = platforms[0];
    if (root === undefined || platforms.length > 1) return { platforms, accounts: [] };

    const accounts = (
      await this.db.query<AccountRow>(
        `SELECT id::text AS id, label, status,
                CASE WHEN status = 'active' THEN credentials_enc END AS credentials_enc,
                config
           FROM provider_accounts
          WHERE tenant_id = $1::uuid AND provider_code = $2
          ORDER BY label`,
        [root.id, providerCode],
      )
    ).rows;
    return {
      platforms,
      accounts: accounts.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        credentialsEnc: row.credentials_enc,
        config: row.config,
      })),
    };
  }
}

export type VaultSelection =
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'chosen'; readonly platform: VaultPlatform; readonly account: VaultAccount };

/** `Catálogo ` → `catalogo`. */
function normalizeLabel(label: string): string {
  return label.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

/**
 * Qué cuenta usa el sync, sin descifrar nada. `none` es "todavía no hay cuenta" (salida 0); una
 * elección imposible es un error, porque elegir una al azar podría gastar el cupo de otra.
 */
export function selectCatalogAccount(
  snapshot: VaultSnapshot,
  providerCode: string,
): VaultSelection {
  const [platform, ...others] = snapshot.platforms;
  if (platform === undefined) return { kind: 'none', reason: 'no platform tenant in the database' };
  if (others.length > 0) {
    throw new SyncVaultError(
      'ambiguous_platform',
      'platform',
      snapshot.platforms.map((row) => row.slug),
    );
  }

  const active = snapshot.accounts.filter((account) => account.status === 'active');
  if (active.length === 0) {
    const inactive = snapshot.accounts.map((account) => `${account.label}=${account.status}`);
    return {
      kind: 'none',
      reason:
        `no active ${providerCode} account in the vault of '${platform.slug}'` +
        (inactive.length > 0 ? ` (inactive: ${inactive.join(', ')})` : ''),
    };
  }
  if (active.length === 1) return { kind: 'chosen', platform, account: active[0]! };

  for (const preferred of [CATALOG_ACCOUNT_LABEL, DEFAULT_ACCOUNT_LABEL]) {
    const matches = active.filter((account) => normalizeLabel(account.label) === preferred);
    if (matches.length === 1) return { kind: 'chosen', platform, account: matches[0]! };
    if (matches.length > 1) break;
  }
  throw new SyncVaultError(
    'ambiguous_accounts',
    platform.slug,
    active.map((account) => account.label),
  );
}

export interface CatalogCredentials {
  /** `env` o `vault:<slug>/<etiqueta>`: lo que dice el log. Nunca el usuario. */
  readonly source: string;
  readonly tbo: TboHotelsConfig;
  /** Para el ACL: la huella (`accountRef`) de una cuenta de la bóveda es la misma que usa el api. */
  readonly context: TboAccountContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Un texto con algo, sin tocarlo; cualquier otra cosa cuenta como ausente (como el factory). */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Descifra y valida la cuenta elegida.
 *
 * @throws SyncConfigError sin `PROVIDER_CREDENTIALS_KEY` o con una que no es base64 de 32 bytes.
 * @throws SyncVaultError si la cuenta no se puede abrir o no le sirve al ACL.
 */
export function openCatalogAccount(
  chosen: Extract<VaultSelection, { kind: 'chosen' }>,
  env: SyncEnv,
): CatalogCredentials {
  const { platform, account } = chosen;
  const ref = `${platform.slug}/${account.label}`;

  const rawKey = env['PROVIDER_CREDENTIALS_KEY'] ?? '';
  if (rawKey.trim() === '') throw new SyncConfigError(['PROVIDER_CREDENTIALS_KEY:required']);
  const key = parseCredentialsKey(rawKey);
  if (key === undefined) {
    throw new SyncConfigError(['PROVIDER_CREDENTIALS_KEY:not_base64_32_bytes']);
  }

  if (account.credentialsEnc === null) throw new SyncVaultError('unreadable_credentials', ref);
  let plaintext: string;
  try {
    plaintext = openCredentials(account.credentialsEnc, key);
  } catch {
    throw new SyncVaultError('undecryptable', ref);
  }
  let credentials: unknown;
  try {
    credentials = JSON.parse(plaintext);
  } catch {
    // Sin el mensaje de `JSON.parse`: cita un trozo del texto, que es la credencial.
    credentials = undefined;
  }
  if (!isRecord(credentials)) throw new SyncVaultError('unreadable_credentials', ref);
  const config = isRecord(account.config) ? account.config : {};

  let tbo: TboHotelsConfig;
  try {
    tbo = parseTboConfig({
      environment: config['environment'],
      baseUrl: text(config['baseUrl']),
      username: text(credentials['username']),
      password: text(credentials['password']),
    });
  } catch (err) {
    if (err instanceof TboConfigError) throw new SyncVaultError('invalid_config', ref, err.issues);
    throw err;
  }
  const missing = missingTboCredentials(tbo);
  if (missing.length > 0) throw new SyncVaultError('incomplete', ref, missing);

  return { source: `vault:${ref}`, tbo, context: { ownerTenantId: platform.id } };
}

export type CatalogCredentialsResolution =
  | { readonly kind: 'none'; readonly reason: string }
  | ({ readonly kind: 'found' } & CatalogCredentials);

export interface ResolveCatalogCredentialsInput {
  readonly override: SyncCredentialOverride;
  readonly env: SyncEnv;
  readonly providerCode: string;
  /** Perezosa: con el override, la base no se toca para esto. */
  readonly vault: () => Promise<CatalogVault>;
}

export async function resolveCatalogCredentials(
  input: ResolveCatalogCredentialsInput,
): Promise<CatalogCredentialsResolution> {
  const { override } = input;
  if (override.kind === 'env') {
    return {
      kind: 'found',
      source: 'env',
      tbo: override.tbo,
      context: { credentialSource: 'env' },
    };
  }

  const vault = await input.vault();
  const selection = selectCatalogAccount(
    await vault.platformAccounts(input.providerCode),
    input.providerCode,
  );
  if (selection.kind === 'none') {
    return {
      kind: 'none',
      reason: `${override.missing.join(', ')} not set and ${selection.reason}`,
    };
  }
  return { kind: 'found', ...openCatalogAccount(selection, input.env) };
}
