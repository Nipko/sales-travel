import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from './credentials-cipher.js';

describe('credentials-cipher (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('round-trips a JSON credential payload', () => {
    const secret = JSON.stringify({ apiKey: 'abc', apiSecret: 's3cr3t', pcc: 'BOG1A' });
    const blob = encryptCredentials(secret, key);
    expect(decryptCredentials(blob, key)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptCredentials('same-plaintext', key);
    const b = encryptCredentials('same-plaintext', key);
    expect(a.equals(b)).toBe(false);
    expect(decryptCredentials(a, key)).toBe('same-plaintext');
    expect(decryptCredentials(b, key)).toBe('same-plaintext');
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptCredentials('top-secret', key);
    expect(() => decryptCredentials(blob, randomBytes(32))).toThrow();
  });

  it('fails to decrypt a tampered blob (auth tag mismatch)', () => {
    const blob = encryptCredentials('top-secret', key);
    const tampered = Buffer.from(blob);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff; // flip last byte of ciphertext
    expect(() => decryptCredentials(tampered, key)).toThrow();
  });

  it('rejects a blob that is too short', () => {
    expect(() => decryptCredentials(Buffer.alloc(4), key)).toThrow(/too short/);
  });
});
