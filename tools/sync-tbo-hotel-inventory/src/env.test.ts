import {
  TBO_BASE_URLS,
  TBO_HOTELS_PROVIDER_CODE,
  type TboHotelsConfig,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_COUNTRIES,
  MAX_SYNC_CITIES,
  readLogLevel,
  resolveSyncEnv,
  type SyncCredentialOverride,
  type SyncEnv,
} from './env.js';
import { SyncConfigError } from './errors.js';

/** E0 (05 §6.3): las `TBO_SYNC_*` validadas con Zod antes de gastar una sola llamada. */

// Con forma reconocible para buscarla en cualquier mensaje. No es una credencial.
const PASSWORD = 'Pa55-sync-catalogo';
const BASE: SyncEnv = { TBO_SYNC_USERNAME: 'catalogo-plataforma', TBO_SYNC_PASSWORD: PASSWORD };

function run(env: SyncEnv): Extract<ReturnType<typeof resolveSyncEnv>, { kind: 'run' }> {
  const resolution = resolveSyncEnv(env);
  if (resolution.kind !== 'run') throw new Error(`esperaba run, fue ${resolution.reason}`);
  return resolution;
}

function envAccount(override: SyncCredentialOverride): TboHotelsConfig {
  if (override.kind !== 'env') throw new Error('esperaba el override por entorno');
  return override.tbo;
}

function configIssues(env: SyncEnv): readonly string[] {
  try {
    resolveSyncEnv(env);
  } catch (err) {
    expect(err).toBeInstanceOf(SyncConfigError);
    expect((err as Error).message).not.toContain(PASSWORD);
    return (err as SyncConfigError).issues;
  }
  throw new Error('esperaba SyncConfigError');
}

describe('resolveSyncEnv: kill-switch y override', () => {
  it('TBO_SYNC_ENABLED=false es un kill-switch aunque el resto esté roto', () => {
    for (const value of ['false', 'FALSE', '0', 'off', ' no ']) {
      expect(
        resolveSyncEnv({ ...BASE, TBO_SYNC_ENABLED: value, TBO_SYNC_MAX_CALLS: 'muchas' }),
      ).toEqual({ kind: 'skip', reason: 'TBO_SYNC_ENABLED=false' });
    }
  });

  it('con usuario y contraseña en el entorno, el override manda (la bóveda ni se mira)', () => {
    const tbo = envAccount(run(BASE).override);
    expect(tbo.username?.reveal()).toBe('catalogo-plataforma');
    expect(tbo.password?.reveal()).toBe(PASSWORD);
  });

  it('sin credenciales en el entorno ya no es skip: la cuenta sale de la bóveda (D-TBO-04, 2026-09-29)', () => {
    expect(run({}).override).toEqual({
      kind: 'absent',
      missing: ['TBO_SYNC_USERNAME', 'TBO_SYNC_PASSWORD'],
      ignored: [],
    });
  });

  it('un override a medias no vale: se sigue con la bóveda y se nombra lo que queda sin usar', () => {
    expect(run({ TBO_SYNC_USERNAME: '  ', TBO_SYNC_PASSWORD: PASSWORD }).override).toEqual({
      kind: 'absent',
      missing: ['TBO_SYNC_USERNAME'],
      ignored: ['TBO_SYNC_PASSWORD'],
    });
    expect(run({ TBO_SYNC_USERNAME: 'x', TBO_SYNC_PASSWORD: '' }).override).toEqual({
      kind: 'absent',
      missing: ['TBO_SYNC_PASSWORD'],
      ignored: ['TBO_SYNC_USERNAME'],
    });
  });

  it('sin override, el entorno y la URL no se usan (la cuenta de la bóveda trae los suyos)', () => {
    // `live` sin URL es un error sólo para el override; aquí la regla la aplica la bóveda.
    expect(run({ TBO_SYNC_ENVIRONMENT: 'live' }).override).toEqual({
      kind: 'absent',
      missing: ['TBO_SYNC_USERNAME', 'TBO_SYNC_PASSWORD'],
      ignored: ['TBO_SYNC_ENVIRONMENT'],
    });
    expect(
      run({ TBO_SYNC_BASE_URL: 'https://live.example.test/HotelAPI', TBO_SYNC_ENVIRONMENT: ' ' })
        .override,
    ).toMatchObject({ kind: 'absent', ignored: ['TBO_SYNC_BASE_URL'] });
  });

  it('sin override, una variable mal escrita sigue siendo un error, antes de tocar la base', () => {
    expect(configIssues({ TBO_SYNC_MAX_CALLS: 'muchas' })).toEqual([
      'TBO_SYNC_MAX_CALLS:invalid_type',
    ]);
  });

  it('la contraseña no se recorta: un espacio puede ser parte de ella (01 §1.2)', () => {
    const tbo = envAccount(run({ ...BASE, TBO_SYNC_PASSWORD: ' con espacio ' }).override);
    expect(tbo.password?.reveal()).toBe(' con espacio ');
  });
});

describe('resolveSyncEnv: valores por defecto de 05 §6.4 y §10', () => {
  it('cuenta de test, países de D-TBO-12 A, todas las etapas, 1 req/s, caída máxima 50 %', () => {
    const { settings, client, override } = run(BASE);
    const tbo = envAccount(override);
    expect(tbo.environment).toBe('test');
    expect(tbo.baseUrl).toBe(TBO_BASE_URLS.test);
    expect(settings.providerCode).toBe(TBO_HOTELS_PROVIDER_CODE);
    expect(settings.countries).toEqual([...DEFAULT_SYNC_COUNTRIES]);
    expect([...settings.stages]).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
    expect(settings.destinationSourceProvider).toBe('despegar-hotels');
    expect(settings.maxCalls).toBe(2_500);
    expect(settings.maxDurationMs).toBe(45 * 60_000);
    expect(settings.sweepMaxDrop).toBe(0.5);
    expect(settings.maxConsecutiveThrottled).toBe(3);
    expect(settings.maxConsecutiveErrors).toBe(10);
    expect(settings.cadence).toEqual({
      demandMaxAgeMs: 20 * 3_600_000,
      regularMaxAgeMs: 7 * 86_400_000,
      emptyMaxAgeMs: 30 * 86_400_000,
      demandWindowMs: 14 * 86_400_000,
    });
    expect(client).toEqual({
      requestsPerSecond: 1,
      detailedCityHotels: true,
      codelistTimeoutMs: undefined,
    });
  });

  it('E4 (PR-3.3): sólo demanda, ES/PT/EN y ES/PT para el resto, lotes de 10, refresco de 30 días', () => {
    const { settings } = run(BASE);
    expect(settings.content).toEqual({
      scope: 'demand',
      demandLangs: ['es', 'pt', 'en'],
      regularLangs: ['es', 'pt'],
      batchSize: 10,
      maxAgeMs: 30 * 86_400_000,
    });
  });

  it('las credenciales quedan envueltas: la config no se vuelca con la contraseña', () => {
    const tbo = envAccount(run(BASE).override);
    expect(JSON.stringify(tbo)).not.toContain(PASSWORD);
  });

  it('una variable vacía vale lo mismo que ausente', () => {
    const { settings } = run({ ...BASE, TBO_SYNC_MAX_CALLS: '', TBO_SYNC_COUNTRIES: ' ' });
    expect(settings.maxCalls).toBe(2_500);
    expect(settings.countries).toEqual([...DEFAULT_SYNC_COUNTRIES]);
  });
});

describe('resolveSyncEnv: lo configurado', () => {
  it('países y etapas en CSV, en mayúsculas y sin repetir', () => {
    const { settings } = run({
      ...BASE,
      TBO_SYNC_COUNTRIES: ' co, pe ,CO,br ',
      TBO_SYNC_STAGES: 'e3',
    });
    expect(settings.countries).toEqual(['CO', 'PE', 'BR']);
    expect([...settings.stages]).toEqual(['E3']);
  });

  it('TBO_SYNC_CITIES: sin lista por defecto; con ella, los CityCode sin espacios ni repetidos', () => {
    expect(run(BASE).settings.cities).toBeUndefined();
    expect(run({ ...BASE, TBO_SYNC_CITIES: '  ' }).settings.cities).toBeUndefined();
    expect(run({ ...BASE, TBO_SYNC_CITIES: ' 130443, 150184 ,130443' }).settings.cities).toEqual([
      '130443',
      '150184',
    ]);
  });

  it('números, fracción y banderas', () => {
    const { settings, client } = run({
      ...BASE,
      TBO_SYNC_MAX_CALLS: '120',
      TBO_SYNC_MAX_MINUTES: '10',
      TBO_SYNC_RPS: '2',
      TBO_SYNC_SWEEP_MAX_DROP: '0.25',
      TBO_SYNC_MAX_CONSECUTIVE_429: '5',
      TBO_SYNC_DETAILED_RESPONSE: 'false',
      TBO_SYNC_CODELIST_TIMEOUT_MS: '90000',
      TBO_SYNC_DEMAND_REFRESH_HOURS: '6',
    });
    expect(settings.maxCalls).toBe(120);
    expect(settings.maxDurationMs).toBe(600_000);
    expect(settings.sweepMaxDrop).toBe(0.25);
    expect(settings.maxConsecutiveThrottled).toBe(5);
    expect(settings.cadence.demandMaxAgeMs).toBe(6 * 3_600_000);
    expect(client).toEqual({
      requestsPerSecond: 2,
      detailedCityHotels: false,
      codelistTimeoutMs: 90_000,
    });
  });

  it('E4: alcance, idiomas en cualquier casing y sin repetir, lote hasta 13', () => {
    const { settings } = run({
      ...BASE,
      TBO_SYNC_CONTENT_SCOPE: ' ALL ',
      TBO_SYNC_LANGS: 'es, en ,ES',
      TBO_SYNC_LANGS_REGULAR: 'pt',
      TBO_SYNC_DETAILS_BATCH: '13',
      TBO_SYNC_CONTENT_REFRESH_DAYS: '7',
    });
    expect(settings.content).toEqual({
      scope: 'all',
      demandLangs: ['es', 'en'],
      regularLangs: ['pt'],
      batchSize: 13,
      maxAgeMs: 7 * 86_400_000,
    });
  });

  it('live con su URL https (el entorno y el nivel de log no distinguen mayúsculas)', () => {
    const tbo = envAccount(
      run({
        ...BASE,
        TBO_SYNC_ENVIRONMENT: ' LIVE ',
        TBO_SYNC_LOG_LEVEL: 'DEBUG',
        TBO_SYNC_BASE_URL: 'https://live.example.test/HotelAPI/',
      }).override,
    );
    expect(tbo.environment).toBe('live');
    expect(tbo.baseUrl).toBe('https://live.example.test/HotelAPI');
  });
});

describe('resolveSyncEnv: con credenciales, lo inválido es un error y nunca repite el valor', () => {
  it('números fuera de rango o que no son números', () => {
    expect(configIssues({ ...BASE, TBO_SYNC_MAX_CALLS: 'muchas' })).toEqual([
      'TBO_SYNC_MAX_CALLS:invalid_type',
    ]);
    expect(configIssues({ ...BASE, TBO_SYNC_RPS: '10' })).toEqual(['TBO_SYNC_RPS:too_big']);
    expect(configIssues({ ...BASE, TBO_SYNC_SWEEP_MAX_DROP: '1.5' })).toEqual([
      'TBO_SYNC_SWEEP_MAX_DROP:too_big',
    ]);
    expect(configIssues({ ...BASE, TBO_SYNC_MAX_MINUTES: '2.5' })).toEqual([
      'TBO_SYNC_MAX_MINUTES:invalid_type',
    ]);
  });

  it('un país que no es ISO2 o una etapa que no existe', () => {
    expect(configIssues({ ...BASE, TBO_SYNC_COUNTRIES: 'CO,COL' })).toEqual([
      'TBO_SYNC_COUNTRIES.1:invalid_string',
    ]);
    // E6 (mapa de destinos y equivalencias, PR-3.4) se puede correr sola: no llama a TBO.
    expect([...run({ ...BASE, TBO_SYNC_STAGES: 'e6' }).settings.stages]).toEqual(['E6']);
    expect(configIssues({ ...BASE, TBO_SYNC_STAGES: 'E3,E7' })).toEqual([
      'TBO_SYNC_STAGES.1:invalid_enum_value',
    ]);
    expect(configIssues({ ...BASE, TBO_SYNC_ENABLED: 'quizás' })).toEqual([
      'TBO_SYNC_ENABLED:not_a_boolean',
    ]);
  });

  it('una ciudad que no es un CityCode, una lista de sólo comas o una lista demasiado larga', () => {
    expect(configIssues({ ...BASE, TBO_SYNC_CITIES: '130443,Bogota' })).toEqual([
      'TBO_SYNC_CITIES.1:invalid_string',
    ]);
    // Vacía = sin lista; sólo comas no: correría el país entero creyendo que se acotó.
    expect(configIssues({ ...BASE, TBO_SYNC_CITIES: ' , ,' })).toEqual([
      'TBO_SYNC_CITIES:too_small',
    ]);
    const tooMany = Array.from({ length: MAX_SYNC_CITIES + 1 }, (_, i) => String(100_000 + i));
    expect(configIssues({ ...BASE, TBO_SYNC_CITIES: tooMany.join(',') })).toEqual([
      'TBO_SYNC_CITIES:too_big',
    ]);
  });

  it('E4: nunca más de 13 códigos por llamada (Q-62), idiomas que TBO no tiene y alcances que no existen', () => {
    expect(configIssues({ ...BASE, TBO_SYNC_DETAILS_BATCH: '14' })).toEqual([
      'TBO_SYNC_DETAILS_BATCH:too_big',
    ]);
    expect(configIssues({ ...BASE, TBO_SYNC_LANGS: 'ES,FR' })).toEqual([
      'TBO_SYNC_LANGS.1:invalid_enum_value',
    ]);
    expect(configIssues({ ...BASE, TBO_SYNC_CONTENT_SCOPE: 'todo' })).toEqual([
      'TBO_SYNC_CONTENT_SCOPE:invalid_enum_value',
    ]);
  });

  it('la regla de transporte del ACL, con el nombre de la variable', () => {
    expect(
      configIssues({
        ...BASE,
        TBO_SYNC_ENVIRONMENT: 'live',
        TBO_SYNC_BASE_URL: 'http://live.example.test/HotelAPI',
      }),
    ).toEqual(['TBO_SYNC_BASE_URL:https_required']);
    expect(configIssues({ ...BASE, TBO_SYNC_USERNAME: 'con:dos-puntos' })).toEqual([
      'TBO_SYNC_USERNAME:colon_in_username',
    ]);
  });

  it('live sin URL: un despliegue a medias, no una cuenta sin configurar', () => {
    expect(configIssues({ ...BASE, TBO_SYNC_ENVIRONMENT: 'live' })).toEqual([
      'TBO_SYNC_BASE_URL:required',
    ]);
  });
});

describe('readLogLevel', () => {
  it('lee el nivel sin lanzar; lo desconocido cae en info', () => {
    expect(readLogLevel({ TBO_SYNC_LOG_LEVEL: 'DEBUG' })).toBe('debug');
    expect(readLogLevel({ TBO_SYNC_LOG_LEVEL: 'verbose' })).toBe('info');
    expect(readLogLevel({})).toBe('info');
  });
});
