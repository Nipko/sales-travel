import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealCredentials } from './testing/memory-vault.js';
import { openCredentials, parseCredentialsKey } from './vault-crypto.js';

/**
 * El api cifra la cuenta que el superadmin carga en el panel y el sync la abre: se prueba contra el
 * módulo del api, no contra una copia de sus constantes. Se importa por ruta en tiempo de ejecución
 * porque una herramienta no depende de `apps/api` (y `tsc` no lo dejaría: queda fuera de
 * `rootDir`); vitest lo transpila igual. Es el patrón de tools/seed-tbo-cert-tenant/src/
 * crypto.contract.test.ts. Si el api cambia de formato, falla aquí y no el sync de las 06:17.
 */
const API_SRC = new URL('../../../apps/api/src/', import.meta.url);

interface ApiCredentialsCipher {
  getCredentialsKey(): Buffer;
  encryptCredentials(plaintext: string, key?: Buffer): Buffer;
  decryptCredentials(blob: Buffer, key?: Buffer): string;
}

const MASTER = randomBytes(32);
let previousKey: string | undefined;
let api: ApiCredentialsCipher;

beforeAll(async () => {
  previousKey = process.env['PROVIDER_CREDENTIALS_KEY'];
  api = (await import(
    new URL('provider-credentials/credentials-cipher.ts', API_SRC).href
  )) as ApiCredentialsCipher;
});

afterAll(() => {
  if (previousKey === undefined) delete process.env['PROVIDER_CREDENTIALS_KEY'];
  else process.env['PROVIDER_CREDENTIALS_KEY'] = previousKey;
});

describe('formato de la bóveda compartido con el api', () => {
  it('la cuenta que cifra el api la abre el sync, espacios y no-ASCII incluidos', () => {
    const json = JSON.stringify({ username: 'tbo-catalogo', password: ' p@ss wörd:ñ ' });
    expect(openCredentials(api.encryptCredentials(json, MASTER), MASTER)).toBe(json);
  });

  it('también desde un Uint8Array, que es como llega el bytea por otros drivers', () => {
    const blob = api.encryptCredentials('{"username":"u","password":"p"}', MASTER);
    expect(openCredentials(new Uint8Array(blob), MASTER)).toBe('{"username":"u","password":"p"}');
  });

  it('los fixtures de los tests (`sealCredentials`) los abre el api: no se separan del formato real', () => {
    const json = JSON.stringify({ username: 'u', password: 'p' });
    expect(api.decryptCredentials(sealCredentials(json, MASTER), MASTER)).toBe(json);
  });

  it('otra clave o un blob truncado no abren: GCM autentica', () => {
    const blob = api.encryptCredentials('x', MASTER);
    expect(() => openCredentials(blob, randomBytes(32))).toThrow();
    expect(() => openCredentials(blob.subarray(0, 20), MASTER)).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => openCredentials(tampered, MASTER)).toThrow();
  });

  it('la clave vale para el sync exactamente cuando vale para el api', () => {
    const cases = [
      MASTER.toString('base64'),
      randomBytes(16).toString('base64'),
      randomBytes(48).toString('base64'),
      'no es base64 !',
    ];
    for (const raw of cases) {
      process.env['PROVIDER_CREDENTIALS_KEY'] = raw;
      let apiKey: Buffer | undefined;
      try {
        apiKey = api.getCredentialsKey();
      } catch {
        apiKey = undefined;
      }
      expect(parseCredentialsKey(raw)?.toString('hex')).toBe(apiKey?.toString('hex'));
    }
    expect(parseCredentialsKey(MASTER.toString('base64'))?.equals(MASTER)).toBe(true);
  });
});
