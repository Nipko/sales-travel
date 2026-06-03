import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de credenciales de proveedor (BYOC) con AES-256-GCM (autenticado).
 * La clave maestra vive fuera de la DB (env / vault), nunca en Postgres.
 * Formato del blob almacenado en `provider_accounts.credentials_enc`:
 *   [ iv (12 bytes) | authTag (16 bytes) | ciphertext ]
 * Ver docs/platform/12-modelo-consolidador-y-plan.md §3.2 (seguridad).
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function getCredentialsKey(): Buffer {
  const raw = process.env['PROVIDER_CREDENTIALS_KEY'];
  if (!raw) {
    throw new Error('PROVIDER_CREDENTIALS_KEY is not set (base64 of a 256-bit key)');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`PROVIDER_CREDENTIALS_KEY must decode to ${KEY_LEN} bytes; got ${key.length}`);
  }
  return key;
}

export function encryptCredentials(plaintext: string, key: Buffer = getCredentialsKey()): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptCredentials(blob: Buffer, key: Buffer = getCredentialsKey()): string {
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new Error('credentials blob too short');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
