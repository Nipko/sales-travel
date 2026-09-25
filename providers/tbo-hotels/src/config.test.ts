import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  TBO_BASE_URLS,
  TBO_REDACTED,
  TboSecret,
  hasUsableTboCredentials,
  missingTboCredentials,
  parseTboConfig,
  requireUsableTboConfig,
  type TboHotelsConfig,
} from './config';
import { TboConfigError, TboCredentialsMissingError } from './errors';

// Valores con forma reconocible para poder buscarlos en cualquier salida. No son credenciales.
const USERNAME = 'agencia-demo';
const PASSWORD = ' Pa55 w0rd!é ';
const LIVE_URL = 'https://live.example.test/HotelAPI';

function testInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { environment: 'test', username: USERNAME, password: PASSWORD, ...overrides };
}

function liveInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: 'live',
    baseUrl: LIVE_URL,
    username: USERNAME,
    password: PASSWORD,
    ...overrides,
  };
}

/** El error de config que lanza `parseTboConfig`, para mirar `issues` y `message` juntos. */
function configError(input: unknown): TboConfigError {
  try {
    parseTboConfig(input);
  } catch (err) {
    if (err instanceof TboConfigError) return err;
    throw err;
  }
  throw new Error('parseTboConfig aceptó una config que debía rechazar');
}

describe('environment', () => {
  it('es obligatorio: sin él no hay forma de saber a qué host puede ir la credencial', () => {
    expect(configError({ username: USERNAME, password: PASSWORD }).issues).toEqual([
      'environment:invalid_type',
    ]);
  });

  it('sólo admite test y live', () => {
    expect(configError(testInput({ environment: 'prod' })).issues).toEqual([
      'environment:invalid_enum_value',
    ]);
  });
});

describe('baseUrl (RF-01 CA-1 y CA-2, D-TBO-30 A)', () => {
  it('en test, sin baseUrl, usa la constante de test', () => {
    expect(parseTboConfig(testInput()).baseUrl).toBe(TBO_BASE_URLS.test);
  });

  it('TBO_BASE_URLS no tiene entrada live: la URL live no se publica (p. 7)', () => {
    expect(Object.keys(TBO_BASE_URLS)).toEqual(['test']);
  });

  it('en live no hay valor por defecto: la cuenta queda incompleta, por nombre', () => {
    const cfg = parseTboConfig(liveInput({ baseUrl: undefined }));
    expect(cfg.baseUrl).toBeUndefined();
    expect(missingTboCredentials(cfg)).toEqual(['baseUrl']);
    expect(hasUsableTboCredentials(cfg)).toBe(false);
  });

  it('la puerta del cable rechaza la cuenta live sin baseUrl con los nombres y sin valores', () => {
    const cfg = parseTboConfig(liveInput({ baseUrl: undefined }));
    let error: unknown;
    try {
      requireUsableTboConfig(cfg);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TboCredentialsMissingError);
    const missing = error as TboCredentialsMissingError;
    expect(missing.missing).toEqual(['baseUrl']);
    expect(missing.message).toContain('baseUrl');
    expect(missing.message).not.toContain(USERNAME);
    expect(missing.message).not.toContain(PASSWORD);
  });

  it('acepta http sólo con environment test y el host exacto de test', () => {
    const cfg = parseTboConfig(testInput({ baseUrl: TBO_BASE_URLS.test }));
    expect(cfg.baseUrl).toBe(TBO_BASE_URLS.test);
  });

  it('rechaza http en live, aun contra un host desconocido', () => {
    expect(configError(liveInput({ baseUrl: 'http://live.example.test/HotelAPI' })).issues).toEqual(
      ['baseUrl:https_required'],
    );
  });

  it('rechaza http en test contra cualquier otro host', () => {
    expect(configError(testInput({ baseUrl: 'http://proxy.example.test/api' })).issues).toEqual([
      'baseUrl:http_only_on_test_host',
    ]);
  });

  it('el host se compara exacto: un subdominio o un puerto no son el host de test', () => {
    for (const baseUrl of [
      'http://evil.api.tbotechnology.in/TBOHolidays_HotelAPI',
      'http://api.tbotechnology.in.evil.test/TBOHolidays_HotelAPI',
      'http://api.tbotechnology.in:8080/TBOHolidays_HotelAPI',
    ]) {
      expect(configError(testInput({ baseUrl })).issues).toEqual([
        'baseUrl:http_only_on_test_host',
      ]);
    }
  });

  it('una credencial live nunca apunta al endpoint de test, ni por https', () => {
    for (const baseUrl of [
      TBO_BASE_URLS.test,
      'https://api.tbotechnology.in/TBOHolidays_HotelAPI',
      'https://API.tbotechnology.in/tboholidays_hotelapi/',
    ]) {
      expect(configError(liveInput({ baseUrl })).issues).toEqual(['baseUrl:live_on_test_endpoint']);
    }
  });

  it('en live, https contra otro path del mismo host se acepta: la URL live real no se conoce', () => {
    const cfg = parseTboConfig(liveInput({ baseUrl: 'https://api.tbotechnology.in/HotelAPI' }));
    expect(cfg.baseUrl).toBe('https://api.tbotechnology.in/HotelAPI');
  });

  it('https se acepta en test contra otro host (entorno de staging de la certificación)', () => {
    const cfg = parseTboConfig(testInput({ baseUrl: 'https://staging.example.test/api' }));
    expect(cfg.baseUrl).toBe('https://staging.example.test/api');
  });

  it('se normaliza sin barra final y con el host en minúsculas', () => {
    const cfg = parseTboConfig(liveInput({ baseUrl: 'https://Live.Example.TEST/HotelAPI//' }));
    expect(cfg.baseUrl).toBe('https://live.example.test/HotelAPI');
  });

  it('rechaza query, fragmento y credenciales embebidas en vez de recortarlos', () => {
    expect(configError(liveInput({ baseUrl: `${LIVE_URL}?k=v` })).issues).toEqual([
      'baseUrl:query_or_fragment',
    ]);
    expect(configError(liveInput({ baseUrl: `${LIVE_URL}#x` })).issues).toEqual([
      'baseUrl:query_or_fragment',
    ]);
    expect(
      configError(liveInput({ baseUrl: 'https://u:p@live.example.test/HotelAPI' })).issues,
    ).toEqual(['baseUrl:credentials_in_url']);
  });

  it('rechaza lo que no es URL o no es http(s)', () => {
    expect(configError(liveInput({ baseUrl: 'live.example.test/HotelAPI' })).issues).toEqual([
      'baseUrl:invalid_string',
    ]);
    expect(configError(liveInput({ baseUrl: 'ftp://live.example.test/HotelAPI' })).issues).toEqual([
      'baseUrl:unsupported_protocol',
    ]);
    expect(configError(liveInput({ baseUrl: '' })).issues).toEqual(['baseUrl:invalid_string']);
  });

  it('la puerta del cable reaplica la regla de transporte a una config armada a mano', () => {
    const handMade: TboHotelsConfig = {
      environment: 'live',
      baseUrl: 'http://live.example.test/HotelAPI',
      username: new TboSecret(USERNAME),
      password: new TboSecret(PASSWORD),
    };
    expect(() => requireUsableTboConfig(handMade)).toThrow(TboConfigError);
    expect(() => requireUsableTboConfig({ ...handMade, baseUrl: 'no es una url' })).toThrow(
      TboConfigError,
    );
  });
});

describe('credenciales (RF-01 CA-3)', () => {
  it('rechaza un usuario vacío', () => {
    expect(configError(testInput({ username: '' })).issues).toEqual(['username:too_small']);
  });

  it('rechaza un usuario con ":" (RFC 7617)', () => {
    expect(configError(testInput({ username: 'agencia:demo' })).issues).toEqual([
      'username:colon_in_username',
    ]);
  });

  it('rechaza una contraseña vacía', () => {
    expect(configError(testInput({ password: '' })).issues).toEqual(['password:too_small']);
  });

  it('la contraseña no se recorta: los espacios son parte de ella', () => {
    const cfg = parseTboConfig(testInput());
    expect(cfg.password?.reveal()).toBe(PASSWORD);
  });

  it('las credenciales ausentes no son un error de parseo: se reportan por nombre', () => {
    const cfg = parseTboConfig({ environment: 'test' });
    expect(missingTboCredentials(cfg)).toEqual(['username', 'password']);
    expect(() => requireUsableTboConfig(cfg)).toThrow(TboCredentialsMissingError);
  });

  it('con las tres piezas la cuenta es usable', () => {
    const cfg = parseTboConfig(liveInput());
    expect(hasUsableTboCredentials(cfg)).toBe(true);
    const usable = requireUsableTboConfig(cfg);
    expect(usable.baseUrl).toBe(LIVE_URL);
    expect(usable.username.reveal()).toBe(USERNAME);
    expect(usable.password.reveal()).toBe(PASSWORD);
  });

  it('un secreto vacío armado a mano cuenta como ausente', () => {
    const cfg: TboHotelsConfig = {
      environment: 'test',
      baseUrl: TBO_BASE_URLS.test,
      username: new TboSecret(USERNAME),
      password: new TboSecret(''),
    };
    expect(missingTboCredentials(cfg)).toEqual(['password']);
  });
});

describe('errores de configuración (RF-01 CA-4)', () => {
  it('llevan sólo ruta:código, nunca el valor rechazado', () => {
    const secretLooking = 'usuario:con-clave-S3cr3ta';
    const error = configError(
      testInput({ username: secretLooking, baseUrl: 'https://attacker.example.test/?token=abc' }),
    );
    expect(error.issues).toEqual(['baseUrl:query_or_fragment', 'username:colon_in_username']);
    expect(error.message).not.toContain(secretLooking);
    expect(error.message).not.toContain('attacker');
    expect(error.message).not.toContain('token=abc');
    expect(error.message).not.toContain(PASSWORD);
  });

  it('un enum inválido tampoco repite lo recibido', () => {
    const error = configError(testInput({ environment: 'produccion-secreta' }));
    expect(error.message).not.toContain('produccion-secreta');
  });

  it('una entrada que no es objeto se informa en la raíz', () => {
    expect(configError('texto').issues).toEqual(['<root>:invalid_type']);
    expect(configError(null).issues).toEqual(['<root>:invalid_type']);
  });
});

describe('serialización (RF-01 CA-5)', () => {
  it('JSON.stringify de la configuración no contiene la contraseña ni el usuario', () => {
    const cfg = parseTboConfig(liveInput());
    const json = JSON.stringify(cfg);
    expect(json).not.toContain(PASSWORD.trim());
    expect(json).not.toContain(USERNAME);
    expect(json).toContain(TBO_REDACTED);
    expect(json).toContain(LIVE_URL);
  });

  it('tampoco la config usable que recibe el cliente', () => {
    const json = JSON.stringify(requireUsableTboConfig(parseTboConfig(liveInput())));
    expect(json).not.toContain(PASSWORD.trim());
    expect(json).not.toContain(USERNAME);
  });

  it('ni util.inspect, ni String(), ni una plantilla', () => {
    const cfg = parseTboConfig(liveInput());
    const outputs = [
      inspect(cfg, { depth: 5, showHidden: true }),
      String(cfg.password),
      `usuario=${String(cfg.username)}`,
    ];
    for (const output of outputs) {
      expect(output).not.toContain(PASSWORD.trim());
      expect(output).not.toContain(USERNAME);
    }
  });

  it('el secreto no expone el valor por ninguna propiedad enumerable', () => {
    const secret = new TboSecret(PASSWORD);
    expect(Object.keys(secret)).toEqual([]);
    expect({ ...secret }).toEqual({});
  });
});

describe('forma de la config parseada', () => {
  it('descarta las claves que el esquema no declara', () => {
    const cfg = parseTboConfig(testInput({ mock: true, apiKey: 'x' }));
    expect(Object.keys(cfg).sort()).toEqual(['baseUrl', 'environment', 'password', 'username']);
  });

  it('queda congelada: nadie cambia el host después de validarlo', () => {
    const cfg = parseTboConfig(testInput());
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
