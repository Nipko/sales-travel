import { createDecipheriv } from 'node:crypto';

/**
 * De dónde saca el sync la clave de Despegar: la cuenta que el superadmin cargó en la plataforma
 * (la misma con la que el api busca y reserva), no una variable suelta en el `.env`.
 * `DESPEGAR_API_KEY` sigue valiendo como override explícito.
 *
 * El formato de `provider_accounts.credentials_enc` es el del api (AES-256-GCM,
 * `[ iv(12) | authTag(16) | ciphertext ]`, apps/api/src/provider-credentials/credentials-cipher.ts),
 * repetido aquí como en tools/sync-tbo-hotel-inventory/src/vault-crypto.ts porque una herramienta no
 * importa código de `apps/api`. Sólo descifra: nunca escribe la cuenta.
 */

export const DEFAULT_BASE_URL = 'https://api-dev.despegar.com/v3';

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface VaultAccountRow {
  readonly label: string;
  readonly credentials_enc: Uint8Array | null;
  readonly config: unknown;
}

export interface Queryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export type ResolvedCredentials =
  | { readonly kind: 'none'; readonly reason: string }
  | {
      readonly kind: 'chosen';
      readonly source: 'env' | 'vault';
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly label?: string;
    };

/** La clave con la regla del api: base64 que decodifica a 32 bytes. */
export function parseCredentialsKey(raw: string): Buffer | undefined {
  const key = Buffer.from(raw, 'base64');
  return key.length === KEY_LEN ? key : undefined;
}

/** @throws Error si el blob no es de esta clave o está truncado. */
export function openCredentials(blob: Uint8Array, key: Buffer): string {
  const bytes = Buffer.from(blob);
  if (bytes.length < IV_LEN + TAG_LEN) throw new Error('blob cifrado demasiado corto');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_LEN));
  decipher.setAuthTag(bytes.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_LEN + TAG_LEN)),
    decipher.final(),
  ]).toString('utf8');
}

function stringField(obj: unknown, field: string): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[field];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Sólo https: la clave viaja en un header a esa URL. */
function baseUrlOf(config: unknown, fallback: string): string {
  const raw = stringField(config, 'baseUrl');
  if (raw === undefined) return fallback;
  return /^https:\/\/[^\s/]+(\/\S*)?$/.test(raw) ? raw.replace(/\/+$/, '') : fallback;
}

/**
 * Las cuentas ACTIVAS de Despegar del tenant raíz de la plataforma. Con el superusuario, porque
 * `provider_accounts` tiene RLS y `app_user` no vería ninguna.
 */
export async function platformAccounts(
  db: Queryable,
  providerCode: string,
): Promise<{ platforms: number; accounts: VaultAccountRow[] }> {
  const platforms = (
    await db.query<{ id: string }>(
      `SELECT id::text AS id FROM tenants
        WHERE tenant_type = 'platform' AND parent_tenant_id IS NULL
        LIMIT 2`,
    )
  ).rows;
  const root = platforms[0];
  if (root === undefined || platforms.length > 1)
    return { platforms: platforms.length, accounts: [] };
  const accounts = (
    await db.query<VaultAccountRow>(
      `SELECT label, credentials_enc, config
         FROM provider_accounts
        WHERE tenant_id = $1::uuid AND provider_code = $2 AND status = 'active'
        ORDER BY created_at, label`,
      [root.id, providerCode],
    )
  ).rows;
  return { platforms: platforms.length, accounts };
}

/**
 * La clave con que corre el sync. Nunca devuelve ni registra el valor fuera de `apiKey`.
 * Con varias cuentas activas toma la más antigua: la de la plataforma es una sola en la práctica.
 */
export function chooseCredentials(
  env: Readonly<Record<string, string | undefined>>,
  vault: { platforms: number; accounts: readonly VaultAccountRow[] },
): ResolvedCredentials {
  const fallbackUrl = baseUrlOf({ baseUrl: env['DESPEGAR_BASE_URL'] }, DEFAULT_BASE_URL);
  const envKey = env['DESPEGAR_API_KEY']?.trim();
  if (envKey) return { kind: 'chosen', source: 'env', apiKey: envKey, baseUrl: fallbackUrl };

  if (vault.platforms !== 1) {
    return { kind: 'none', reason: `platform tenants: ${vault.platforms} (expected 1)` };
  }
  const account = vault.accounts[0];
  if (account === undefined)
    return { kind: 'none', reason: 'no active despegar account in platform' };
  if (account.credentials_enc === null) {
    throw new Error(`account "${account.label}" has no stored credentials`);
  }
  const key = parseCredentialsKey(env['PROVIDER_CREDENTIALS_KEY'] ?? '');
  if (key === undefined) {
    throw new Error('PROVIDER_CREDENTIALS_KEY missing or not base64 of 32 bytes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(openCredentials(account.credentials_enc, key));
  } catch {
    throw new Error(`account "${account.label}": credentials cannot be opened with this key`);
  }
  const apiKey = stringField(parsed, 'apiKey');
  if (apiKey === undefined) throw new Error(`account "${account.label}" has no apiKey`);
  return {
    kind: 'chosen',
    source: 'vault',
    apiKey,
    baseUrl: baseUrlOf(account.config, fallbackUrl),
    label: account.label,
  };
}
