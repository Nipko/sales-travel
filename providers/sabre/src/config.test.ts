import { describe, expect, it } from 'vitest';
import {
  SABRE_DEFAULT_DOMAIN,
  SABRE_HOSTS,
  hasUsableSabreCredentials,
  missingSabreCredentials,
  parseSabreConfig,
  sabreHostEnvironment,
  sabreUrl,
  type SabreConfig,
} from './config';
import { SabreConfigError } from './errors';

function fullConfig(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    password: 'Pa55w0rd!',
    homePcc: 'ZZZZ',
    ...overrides,
  };
}

describe('hasUsableSabreCredentials', () => {
  it('con las tres credenciales presentes la config sirve', () => {
    expect(hasUsableSabreCredentials(fullConfig())).toBe(true);
  });

  // Las tres que construyen el clientId: sin una sola no hay secret y por tanto no hay token.
  it.each([['epr'], ['password'], ['homePcc']] as const)('sin %s no sirve', (field) => {
    const cfg = fullConfig();
    delete cfg[field];
    expect(hasUsableSabreCredentials(cfg)).toBe(false);
    expect(missingSabreCredentials(cfg)).toEqual([field]);
  });

  it('una credencial vacía cuenta como ausente', () => {
    expect(hasUsableSabreCredentials(fullConfig({ homePcc: '' }))).toBe(false);
  });

  it('la config parseada no conserva ningún interruptor de simulación', () => {
    // `mock: true` era el único campo que podía convertir una cuenta completa en una fuente de
    // tarifas inventadas. Zod descarta lo que el esquema no declara: llega y se cae por el
    // desagüe, no queda latente en el objeto que ve el adapter.
    const cfg = parseSabreConfig({ ...fullConfig(), mock: true });
    expect(cfg).not.toHaveProperty('mock');
    expect(hasUsableSabreCredentials(cfg)).toBe(true);
  });
});

describe('parseSabreConfig', () => {
  it('aplica los defaults del contrato', () => {
    const cfg = parseSabreConfig({ host: SABRE_HOSTS.prod.rest });
    expect(cfg.domain).toBe(SABRE_DEFAULT_DOMAIN);
    expect(cfg.tokenTtlSeconds).toBe(3600);
    expect(cfg.conversationIdPrefix).toBe('sales-travel');
  });

  it('normaliza la barra final del host', () => {
    expect(parseSabreConfig({ host: 'https://api.cert.platform.sabre.com/' }).host).toBe(
      'https://api.cert.platform.sabre.com',
    );
  });

  it('rechaza un host que no es URL', () => {
    expect(() => parseSabreConfig({ host: 'api.cert.platform.sabre.com' })).toThrow(
      SabreConfigError,
    );
  });

  // RNF-07: un password inválido no puede acabar en un stack trace.
  it('el mensaje de error NUNCA contiene el valor rechazado', () => {
    let message = '';
    try {
      parseSabreConfig({ host: SABRE_HOSTS.cert.rest, password: '' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('password');
    expect(message).toContain('too_small');
  });
});

describe('sabreUrl', () => {
  it('une host y path sin duplicar la barra', () => {
    expect(sabreUrl(fullConfig({ host: 'https://h.test/' }), '/v5/offers/shop')).toBe(
      'https://h.test/v5/offers/shop',
    );
    expect(sabreUrl(fullConfig({ host: 'https://h.test' }), 'v5/offers/shop')).toBe(
      'https://h.test/v5/offers/shop',
    );
  });
});

/**
 * El entorno que dice el HOST, sin mirar lo que la cuenta declara. Es la regla con la que el arnés de
 * certificación se niega a salir de CERT y con la que una cuenta que apunta a producción no puede
 * pasar por cuenta de pruebas.
 */
describe('sabreHostEnvironment', () => {
  it.each([[SABRE_HOSTS.cert.rest], [SABRE_HOSTS.cert.soap]])('%s es CERT', (url) => {
    expect(sabreHostEnvironment(url)).toBe('cert');
  });

  it.each([[SABRE_HOSTS.prod.rest], [SABRE_HOSTS.prod.soap]])('%s es producción', (url) => {
    expect(sabreHostEnvironment(url)).toBe('prod');
  });

  it('el host manda: ni la ruta, ni la barra final, ni las mayúsculas cambian el entorno', () => {
    expect(sabreHostEnvironment('https://API.CERT.platform.sabre.com/v1/offers/')).toBe('cert');
    expect(sabreHostEnvironment('https://api.cert.platform.sabre.com.')).toBe('cert');
    expect(sabreHostEnvironment('https://api.platform.sabre.com:443/v5')).toBe('prod');
  });

  it('cualquier otro host de sabre.com cuenta como producción, no como CERT', () => {
    // Un host dedicado o uno histórico también factura: la duda se resuelve hacia producción.
    expect(sabreHostEnvironment('https://agencia-x.platform.sabre.com')).toBe('prod');
    expect(sabreHostEnvironment('https://api.havail.sabre.com')).toBe('prod');
    expect(sabreHostEnvironment('https://sabre.com')).toBe('prod');
  });

  it('un host que sólo se parece a Sabre no es de Sabre', () => {
    expect(sabreHostEnvironment('https://api.cert.platform.sabre.com.evil.test')).toBeUndefined();
    expect(sabreHostEnvironment('https://evilsabre.com')).toBeUndefined();
    expect(sabreHostEnvironment('https://sabre.com.evil.test')).toBeUndefined();
  });

  it('sin URL http(s) de Sabre no hay entorno que leer', () => {
    expect(sabreHostEnvironment('http://127.0.0.1:4010')).toBeUndefined();
    expect(sabreHostEnvironment('api.cert.platform.sabre.com')).toBeUndefined();
    expect(sabreHostEnvironment('ftp://api.cert.platform.sabre.com')).toBeUndefined();
    expect(sabreHostEnvironment('')).toBeUndefined();
  });
});
