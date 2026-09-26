import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PAYLOADS_DEFAULT_RETENTION_DAYS,
  PROVIDER_PAYLOADS_MAX_RETENTION_DAYS,
  loadProviderPayloadsConfig,
} from './provider-payloads.config.js';
import { payloadKeyId } from './provider-payload-crypto.js';

/** Configuración de la bóveda de payloads desde el entorno (docs/tbo/09 PR-4.9). */

const CLAVE = randomBytes(32);
const ANTERIOR = randomBytes(32);

describe('loadProviderPayloadsConfig', () => {
  it('sin clave, la bóveda queda apagada y dice por qué; la retención por defecto es de 30 días', () => {
    for (const env of [{}, { PROVIDER_PAYLOADS_KEY: '' }, { PROVIDER_PAYLOADS_KEY: '   ' }]) {
      expect(loadProviderPayloadsConfig(env)).toEqual({
        retentionDays: PROVIDER_PAYLOADS_DEFAULT_RETENTION_DAYS,
        keyring: undefined,
        disabledReason: 'PROVIDER_PAYLOADS_KEY no configurada',
      });
    }
    expect(PROVIDER_PAYLOADS_DEFAULT_RETENTION_DAYS).toBe(30);
  });

  it('con clave válida, cifra con ella; con la anterior, también descifra con ésa', () => {
    const sola = loadProviderPayloadsConfig({ PROVIDER_PAYLOADS_KEY: CLAVE.toString('base64') });
    const rotada = loadProviderPayloadsConfig({
      PROVIDER_PAYLOADS_KEY: CLAVE.toString('base64'),
      PROVIDER_PAYLOADS_KEY_PREVIOUS: ANTERIOR.toString('base64'),
    });

    expect(sola.keyring?.current.id).toBe(payloadKeyId(CLAVE));
    expect([...(sola.keyring?.byId.keys() ?? [])]).toEqual([payloadKeyId(CLAVE)]);
    expect(rotada.keyring?.current.id).toBe(payloadKeyId(CLAVE));
    expect([...(rotada.keyring?.byId.keys() ?? [])]).toEqual([
      payloadKeyId(CLAVE),
      payloadKeyId(ANTERIOR),
    ]);
  });

  it('una clave mal formada apaga la bóveda sin repetir el valor en el motivo', () => {
    const mala = randomBytes(16).toString('base64');
    const actual = loadProviderPayloadsConfig({ PROVIDER_PAYLOADS_KEY: mala });
    const anteriorMala = loadProviderPayloadsConfig({
      PROVIDER_PAYLOADS_KEY: CLAVE.toString('base64'),
      PROVIDER_PAYLOADS_KEY_PREVIOUS: mala,
    });

    expect(actual.keyring).toBeUndefined();
    expect(actual.disabledReason).toBe('PROVIDER_PAYLOADS_KEY no es el base64 de 32 bytes');
    expect(anteriorMala.keyring).toBeUndefined();
    expect(anteriorMala.disabledReason).toBe(
      'PROVIDER_PAYLOADS_KEY_PREVIOUS no es el base64 de 32 bytes',
    );
    expect(JSON.stringify([actual, anteriorMala])).not.toContain(mala);
  });

  it('la clave es PROPIA: si repite la de la bóveda de credenciales, la bóveda queda apagada', () => {
    const credenciales = CLAVE.toString('base64');
    const repetida = loadProviderPayloadsConfig({
      PROVIDER_CREDENTIALS_KEY: credenciales,
      PROVIDER_PAYLOADS_KEY: credenciales,
    });
    const anteriorRepetida = loadProviderPayloadsConfig({
      PROVIDER_CREDENTIALS_KEY: credenciales,
      PROVIDER_PAYLOADS_KEY: ANTERIOR.toString('base64'),
      PROVIDER_PAYLOADS_KEY_PREVIOUS: credenciales,
    });
    const distinta = loadProviderPayloadsConfig({
      PROVIDER_CREDENTIALS_KEY: credenciales,
      PROVIDER_PAYLOADS_KEY: ANTERIOR.toString('base64'),
    });

    expect(repetida).toMatchObject({
      keyring: undefined,
      disabledReason: 'PROVIDER_PAYLOADS_KEY repite PROVIDER_CREDENTIALS_KEY',
    });
    expect(anteriorRepetida).toMatchObject({
      keyring: undefined,
      disabledReason: 'PROVIDER_PAYLOADS_KEY_PREVIOUS repite PROVIDER_CREDENTIALS_KEY',
    });
    expect(distinta.keyring?.current.id).toBe(payloadKeyId(ANTERIOR));
  });

  it('la retención es un entero entre 1 y 90; fuera de eso la bóveda no arranca a escribir', () => {
    const con = (dias: string) =>
      loadProviderPayloadsConfig({
        PROVIDER_PAYLOADS_KEY: CLAVE.toString('base64'),
        PROVIDER_PAYLOADS_RETENTION_DAYS: dias,
      });

    expect(PROVIDER_PAYLOADS_MAX_RETENTION_DAYS).toBe(90);
    expect(con('7').retentionDays).toBe(7);
    expect(con('90').retentionDays).toBe(90);
    expect(con('').retentionDays).toBe(30);
    for (const mala of ['0', '91', '365', '30.5', '-1', 'treinta', '1e1']) {
      expect(con(mala), mala).toMatchObject({
        keyring: undefined,
        disabledReason: 'PROVIDER_PAYLOADS_RETENTION_DAYS debe ser un entero entre 1 y 90',
      });
    }
  });
});
