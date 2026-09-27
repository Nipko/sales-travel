import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Lo que el seed cifra lo descifra el api, así que el formato es el suyo y no uno propio:
 *
 * - Cuenta BYOC (`provider_accounts.credentials_enc`): AES-256-GCM con la clave maestra,
 *   `[ iv(12) | authTag(16) | ciphertext ]` (apps/api/src/provider-credentials/credentials-cipher.ts).
 * - Documento del cliente (`customers.document_number_enc` y `_hash`): el mismo AES-256-GCM con una
 *   subclave HKDF-SHA256 de la maestra, más un HMAC-SHA256 del valor normalizado como índice ciego
 *   (apps/api/src/customers/pii-cipher.ts).
 *
 * Una herramienta no puede importar código de `apps/api`, por eso se repite aquí.
 * `crypto.contract.test.ts` cifra con este módulo y descifra con los del api: si uno de los dos
 * cambia de formato, falla ese test y no el login de un tester de TBO.
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** `info` de HKDF del api. Cambiarlos deja ilegibles los documentos ya guardados. */
const PII_ENC_INFO = 'pii-enc-v1';
const PII_INDEX_INFO = 'pii-index-v1';

/** Base64 de exactamente 32 bytes, como exige `getCredentialsKey()` del api; si no, `undefined`. */
export function parseMasterKey(raw: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return undefined;
  const key = Buffer.from(raw, 'base64');
  return key.length === KEY_LEN ? key : undefined;
}

export function seal(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** @throws Error si el blob no es de esta clave: GCM autentica, no devuelve basura. */
export function open(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('blob cifrado demasiado corto');
  const decipher = createDecipheriv(ALGO, key, blob.subarray(0, IV_LEN));
  decipher.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([
    decipher.update(blob.subarray(IV_LEN + TAG_LEN)),
    decipher.final(),
  ]).toString('utf8');
}

export interface PiiKeys {
  readonly encryption: Buffer;
  readonly index: Buffer;
}

export function derivePiiKeys(master: Buffer): PiiKeys {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), KEY_LEN));
  return { encryption: derive(PII_ENC_INFO), index: derive(PII_INDEX_INFO) };
}

export function blindIndex(value: string, indexKey: Buffer): string {
  return createHmac('sha256', indexKey).update(value.trim().toUpperCase()).digest('hex');
}
