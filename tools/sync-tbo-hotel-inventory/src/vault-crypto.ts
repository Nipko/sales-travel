import { createDecipheriv } from 'node:crypto';

/**
 * Lo que el api cifra en `provider_accounts.credentials_enc` lo abre el sync, así que el formato es
 * el suyo y no uno propio: AES-256-GCM con la clave maestra `PROVIDER_CREDENTIALS_KEY`,
 * `[ iv(12) | authTag(16) | ciphertext ]` (apps/api/src/provider-credentials/credentials-cipher.ts).
 *
 * Una herramienta no puede importar código de `apps/api`, por eso se repite aquí, como en
 * tools/seed-tbo-cert-tenant/src/crypto.ts. `vault-crypto.contract.test.ts` cifra con el módulo del
 * api y abre con éste: si el api cambia de formato, falla ese test y no el sync de las 06:17.
 *
 * Sólo descifra: el sync lee la cuenta que el superadmin cargó desde el panel y nunca la escribe.
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** Las variables de la bóveda que el workflow pasa al contenedor con `-e`. */
export const VAULT_ENV_VARIABLES: readonly string[] = Object.freeze(['PROVIDER_CREDENTIALS_KEY']);

/**
 * La clave con la misma regla que `getCredentialsKey()` del api: base64 que decodifica a 32 bytes.
 * Ni más estricta (una clave con la que el api funciona no puede dejar al sync sin cuenta) ni más
 * laxa. `undefined` si no vale.
 */
export function parseCredentialsKey(raw: string): Buffer | undefined {
  const key = Buffer.from(raw, 'base64');
  return key.length === KEY_LEN ? key : undefined;
}

/** @throws Error si el blob no es de esta clave o está truncado: GCM autentica, no devuelve basura. */
export function openCredentials(blob: Uint8Array, key: Buffer): string {
  const bytes = Buffer.from(blob);
  if (bytes.length < IV_LEN + TAG_LEN) throw new Error('blob cifrado demasiado corto');
  const decipher = createDecipheriv(ALGO, key, bytes.subarray(0, IV_LEN));
  decipher.setAuthTag(bytes.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_LEN + TAG_LEN)),
    decipher.final(),
  ]).toString('utf8');
}
