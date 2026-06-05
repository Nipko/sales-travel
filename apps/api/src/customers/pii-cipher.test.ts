import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blindIndex, decryptPii, encryptPii } from './pii-cipher.js';

describe('pii-cipher (AES-256-GCM + blind index)', () => {
  const key = randomBytes(32);
  const idxKey = randomBytes(32);

  it('round-trips a document number (encrypt/decrypt)', () => {
    const doc = 'AB1234567';
    expect(decryptPii(encryptPii(doc, key), key)).toBe(doc);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptPii('X1234', key).equals(encryptPii('X1234', key))).toBe(false);
  });

  it('blind index is deterministic and normalized (enables equality lookup/dedup)', () => {
    // mismo valor (normalizado) ⇒ mismo hash → se puede indexar/buscar
    expect(blindIndex('ab1234567', idxKey)).toBe(blindIndex('  AB1234567 ', idxKey));
    // valores distintos ⇒ hashes distintos
    expect(blindIndex('A1', idxKey)).not.toBe(blindIndex('A2', idxKey));
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptPii('secret-doc', key);
    expect(() => decryptPii(blob, randomBytes(32))).toThrow();
  });

  it('fails to decrypt a tampered blob (GCM auth)', () => {
    const blob = Buffer.from(encryptPii('secret-doc', key));
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff;
    expect(() => decryptPii(blob, key)).toThrow();
  });
});
