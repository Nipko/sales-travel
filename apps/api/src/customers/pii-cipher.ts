import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { getCredentialsKey } from '../provider-credentials/credentials-cipher.js';

/**
 * Cifrado de PII de clientes (document_number) con AES-256-GCM + blind index determinístico
 * para búsqueda/dedup por igualdad. Las sub-claves se derivan por HKDF-SHA256 de la clave
 * maestra (PROVIDER_CREDENTIALS_KEY) con domain separation — no requiere un secret nuevo.
 * Formato del blob: [ iv(12) | authTag(16) | ciphertext ].
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let encKeyCache: Buffer | null = null;
let indexKeyCache: Buffer | null = null;

function deriveKey(info: string): Buffer {
  const master = getCredentialsKey();
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}
function encKey(): Buffer {
  return (encKeyCache ??= deriveKey('pii-enc-v1'));
}
function indexKey(): Buffer {
  return (indexKeyCache ??= deriveKey('pii-index-v1'));
}

export function encryptPii(plaintext: string, key: Buffer = encKey()): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptPii(blob: Buffer, key: Buffer = encKey()): string {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('pii blob too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Blind index determinístico (HMAC-SHA256 del valor normalizado) para lookup/dedup por igualdad. */
export function blindIndex(value: string, key: Buffer = indexKey()): string {
  return createHmac('sha256', key).update(value.trim().toUpperCase()).digest('hex');
}
