import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blindIndex, derivePiiKeys, open, parseMasterKey, seal } from './crypto.js';

/**
 * El seed cifra y el api descifra: se prueba contra los módulos del api, no contra una copia de
 * sus constantes. Se importan por ruta en tiempo de ejecución porque una herramienta no depende de
 * `apps/api` (y `tsc` no lo dejaría: queda fuera de `rootDir`); vitest los transpila igual. Si el
 * api cambia de formato, falla aquí antes de que un tester de TBO vea una cuenta ilegible.
 */
const API_SRC = new URL('../../../apps/api/src/', import.meta.url);

interface ApiCredentialsCipher {
  encryptCredentials(plaintext: string, key?: Buffer): Buffer;
  decryptCredentials(blob: Buffer, key?: Buffer): string;
}

interface ApiPiiCipher {
  encryptPii(plaintext: string, key?: Buffer): Buffer;
  decryptPii(blob: Buffer, key?: Buffer): string;
  blindIndex(value: string, key?: Buffer): string;
}

const MASTER = randomBytes(32);
let previousKey: string | undefined;
let api: { credentials: ApiCredentialsCipher; pii: ApiPiiCipher };

beforeAll(async () => {
  // Las subclaves de PII el api las deriva de la maestra del entorno, sin parámetro: es justo lo
  // que se quiere comprobar.
  previousKey = process.env['PROVIDER_CREDENTIALS_KEY'];
  process.env['PROVIDER_CREDENTIALS_KEY'] = MASTER.toString('base64');
  api = {
    credentials: (await import(
      new URL('provider-credentials/credentials-cipher.ts', API_SRC).href
    )) as ApiCredentialsCipher,
    pii: (await import(new URL('customers/pii-cipher.ts', API_SRC).href)) as ApiPiiCipher,
  };
});

afterAll(() => {
  if (previousKey === undefined) delete process.env['PROVIDER_CREDENTIALS_KEY'];
  else process.env['PROVIDER_CREDENTIALS_KEY'] = previousKey;
});

describe('formato de cifrado compartido con el api', () => {
  it('la cuenta que sella el seed la abre la bóveda del api', () => {
    const json = JSON.stringify({ username: 'tbo-user', password: ' p@ss wörd ' });
    expect(api.credentials.decryptCredentials(seal(json, MASTER), MASTER)).toBe(json);
  });

  it('y el seed lee lo que guardó el api (para no reescribir una cuenta que no cambió)', () => {
    const json = JSON.stringify({ username: 'u', password: 'p' });
    expect(open(api.credentials.encryptCredentials(json, MASTER), MASTER)).toBe(json);
  });

  it('el documento del cliente lo descifra el api con SU derivación de la clave maestra', () => {
    const { encryption } = derivePiiKeys(MASTER);
    expect(api.pii.decryptPii(seal('TBOCERT0001', encryption))).toBe('TBOCERT0001');
  });

  it('el índice ciego es el mismo que calcula el api, así el alta desde el panel deduplica', () => {
    const { index } = derivePiiKeys(MASTER);
    expect(blindIndex(' tbocert0001 ', index)).toBe(api.pii.blindIndex('TBOCERT0001'));
  });

  it('otra clave no abre el blob: GCM autentica', () => {
    expect(() => open(seal('x', MASTER), randomBytes(32))).toThrow();
  });

  it('la clave maestra es base64 de 32 bytes, como exige el api', () => {
    expect(parseMasterKey(MASTER.toString('base64'))?.equals(MASTER)).toBe(true);
    expect(parseMasterKey(randomBytes(16).toString('base64'))).toBeUndefined();
    expect(parseMasterKey('no base64 !')).toBeUndefined();
  });
});
