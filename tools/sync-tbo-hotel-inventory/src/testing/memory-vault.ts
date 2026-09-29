import { createCipheriv, randomBytes } from 'node:crypto';
import type { CatalogVault, VaultAccount, VaultPlatform, VaultSnapshot } from '../vault.js';

/**
 * Dobles de la bóveda para los tests. `sealCredentials` cifra como el api
 * (`[ iv(12) | authTag(16) | ciphertext ]`, AES-256-GCM); `vault-crypto.contract.test.ts` comprueba
 * que el api abre lo que sella, así los fixtures no pueden separarse del formato real.
 */
export function sealCredentials(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export interface MemoryAccountInput {
  readonly label?: string;
  readonly status?: 'active' | 'sandbox' | 'disabled';
  /** Lo que el panel guarda cifrado: `{ username, password }` salvo que el test quiera otra cosa. */
  readonly credentials?: unknown;
  readonly config?: unknown;
  /** Sella con esta clave en lugar de la del doble: una cuenta que no se abre. */
  readonly sealWith?: Buffer;
}

/** La raíz `platform` y sus cuentas, como las devolvería `PgCatalogVault`. */
export class MemoryCatalogVault implements CatalogVault {
  readonly calls: string[] = [];
  readonly #platforms: VaultPlatform[];
  readonly #accounts: VaultAccount[];

  constructor(
    readonly key: Buffer,
    accounts: readonly MemoryAccountInput[] = [],
    platforms: readonly VaultPlatform[] = [
      { id: '00000000-0000-4000-8000-000000000001', slug: 'platform' },
    ],
  ) {
    this.#platforms = [...platforms];
    this.#accounts = accounts.map((input, index) => {
      const status = input.status ?? 'active';
      const plaintext = JSON.stringify(input.credentials ?? {});
      return {
        id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        label: input.label ?? 'default',
        status,
        credentialsEnc:
          status === 'active' ? sealCredentials(plaintext, input.sealWith ?? key) : null,
        config: input.config ?? { environment: 'test' },
      };
    });
  }

  platformAccounts(providerCode: string): Promise<VaultSnapshot> {
    this.calls.push(providerCode);
    return Promise.resolve({
      platforms: this.#platforms,
      accounts: this.#platforms.length === 1 ? this.#accounts : [],
    });
  }
}
