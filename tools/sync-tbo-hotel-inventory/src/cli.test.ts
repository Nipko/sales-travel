import type { TboRateLimiter } from '@sales-travel/tbo-hotels';
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo, type DbSession } from './cli.js';
import type { SyncEnv } from './env.js';
import { fakeTbo, tboStatus, type FakeTboWorld } from './testing/fake-tbo.js';
import { MemoryCatalogStore } from './testing/memory-catalog-store.js';

/**
 * El proceso entero, como lo corre el contenedor: variables de entorno → código de salida y líneas
 * JSON. El sync de Despegar es el modelo de las salidas (skip con 0 sin credenciales, 1 si falla).
 */

// Con forma reconocible para buscarlos en la salida. No son credenciales.
const USERNAME = 'catalogo-cli-demo';
const PASSWORD = 'Pa55-cli-catalogo';
const BASIC = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
const ENV: SyncEnv = {
  TBO_SYNC_USERNAME: USERNAME,
  TBO_SYNC_PASSWORD: PASSWORD,
  TBO_SYNC_COUNTRIES: 'AR',
  TBO_SYNC_LOG_LEVEL: 'debug',
};

const WORLD: FakeTboWorld = {
  countries: ['AR'],
  cities: { AR: [{ code: '900001', name: 'Buenos Aires' }] },
  hotels: { '900001': [{ code: '1000001', lat: -34.6, lng: -58.38 }] },
  codelist: ['1000001'],
};

const immediateLimiter: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

interface Run {
  readonly code: number;
  readonly lines: readonly Record<string, unknown>[];
  readonly raw: string;
}

async function cli(io: Partial<CliIo> & { readonly env: SyncEnv }, world = WORLD): Promise<Run> {
  const raw: string[] = [];
  const tbo = fakeTbo(world);
  const code = await runCli({
    fetch: tbo.fetch,
    sleep: () => Promise.resolve(),
    limiter: immediateLimiter,
    sink: (line) => raw.push(line),
    ...io,
  });
  return {
    code,
    lines: raw.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: raw.join('\n'),
  };
}

function result(run: Run): Record<string, unknown> | undefined {
  return run.lines.find((line) => line['msg'] === 'tbo.sync.result');
}

describe('runCli: skip con salida 0', () => {
  it('sin credenciales avisa y no toca la base', async () => {
    const connect = vi.fn<(env: SyncEnv) => Promise<DbSession>>();
    const run = await cli({ env: {}, connect });
    expect(run.code).toBe(0);
    expect(run.lines).toHaveLength(1);
    expect(result(run)).toMatchObject({
      level: 'warn',
      ok: true,
      action: 'skip',
      reason: 'TBO_SYNC_USERNAME, TBO_SYNC_PASSWORD not set',
      job: 'sync-tbo-hotel-inventory',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('kill-switch TBO_SYNC_ENABLED=false', async () => {
    const run = await cli({ env: { ...ENV, TBO_SYNC_ENABLED: 'false' } });
    expect(run.code).toBe(0);
    expect(result(run)).toMatchObject({ action: 'skip', reason: 'TBO_SYNC_ENABLED=false' });
  });

  it('otra corrida tiene el lock: sale con 0 sin llamar a TBO', async () => {
    const store = new MemoryCatalogStore('tbo-hotels');
    store.lockedElsewhere = true;
    const run = await cli({ env: ENV, store });
    expect(run.code).toBe(0);
    expect(result(run)).toMatchObject({ ok: true, action: 'skip', reason: 'locked' });
  });
});

describe('runCli: corrida', () => {
  it('termina con 0 y una línea de resultado con contadores; la credencial no aparece en la salida', async () => {
    const store = new MemoryCatalogStore('tbo-hotels');
    const run = await cli({ env: ENV, store });
    expect(run.code).toBe(0);
    expect(result(run)).toMatchObject({
      level: 'info',
      ok: true,
      action: 'sync',
      outcome: 'complete',
      stopReason: null,
      provider: 'tbo-hotels',
      calls: 4,
      countries: ['AR'],
      cities: 1,
      hotelsUpserted: 1,
      // El texto de TBOHotelCodeList queda como respaldo en inglés; sin destinos con demanda
      // todavía (sin mapa de E6), E4 no tiene hoteles que pedir con el alcance por defecto.
      listingContentsWritten: 1,
      contentsWritten: 0,
      contentTasksDue: 0,
      // E6 corre por defecto; sin catálogo de Despegar no hay nada que emparejar.
      hotelMatchesAccepted: 0,
      destinationsAccepted: 0,
      e4: 'done',
      e5: 'done',
      e6: 'done',
    });
    expect(store.content('1000001', 'en')?.source).toBe('listing');
    expect(store.hotel('1000001')?.active).toBe(true);
    expect(run.raw).not.toMatch(/authorization/i);
    expect(run.raw).not.toContain(BASIC);
    expect(run.raw).not.toContain(PASSWORD);
    expect(run.raw).not.toContain(USERNAME);
  });

  it('"ok parcial" también sale con 0: la próxima corrida sigue desde ahí', async () => {
    const store = new MemoryCatalogStore('tbo-hotels');
    const run = await cli(
      { env: { ...ENV, TBO_SYNC_MAX_CONSECUTIVE_429: '1' }, store },
      {
        ...WORLD,
        override: (op) => (op === 'tboHotelCodeList' ? tboStatus(429, 'QPS Exceeded') : undefined),
      },
    );
    expect(run.code).toBe(0);
    expect(result(run)).toMatchObject({ ok: true, outcome: 'partial', stopReason: 'throttled' });
  });
});

describe('runCli: una racha de errores deja lo escrito pero sale con 1', () => {
  it('TBO caído a mitad: las ciudades anteriores quedan y el workflow se pone en rojo', async () => {
    const store = new MemoryCatalogStore('tbo-hotels');
    const run = await cli(
      { env: { ...ENV, TBO_SYNC_MAX_CONSECUTIVE_ERRORS: '1' }, store },
      {
        ...WORLD,
        override: (op) =>
          op === 'tboHotelCodeList' ? tboStatus(500, 'Unexpected Error') : undefined,
      },
    );
    expect(run.code).toBe(1);
    expect(result(run)).toMatchObject({
      level: 'error',
      ok: false,
      outcome: 'partial',
      stopReason: 'errors',
      errorsByCode: { UPSTREAM: 1 },
    });
    expect(store.city('900001')?.lastStatusCode).toBe(500);
  });
});

describe('runCli: salida 1', () => {
  it('configuración inválida: los nombres de las variables, nunca sus valores', async () => {
    const run = await cli({
      env: { ...ENV, TBO_SYNC_RPS: 'rápido', TBO_SYNC_ENVIRONMENT: 'prod' },
    });
    expect(run.code).toBe(1);
    expect(result(run)).toMatchObject({
      level: 'error',
      ok: false,
      errorClass: 'SyncConfigError',
      issues: ['TBO_SYNC_ENVIRONMENT:invalid_enum_value', 'TBO_SYNC_RPS:invalid_type'],
    });
    expect(run.raw).not.toContain(PASSWORD);
    expect(run.raw).not.toContain('rápido');
  });

  it('sin PG* no intenta conectar', async () => {
    const run = await cli({ env: ENV });
    expect(run.code).toBe(1);
    expect(result(run)).toMatchObject({
      errorClass: 'SyncConfigError',
      issues: ['PGHOST:required', 'PGUSER:required', 'PGPASSWORD:required'],
    });
  });

  it('TBO rechaza la cuenta del catálogo', async () => {
    const run = await cli(
      { env: ENV, store: new MemoryCatalogStore('tbo-hotels') },
      {
        ...WORLD,
        override: (op) =>
          op === 'countryList' ? tboStatus(401, 'Access Credentials is incorrect') : undefined,
      },
    );
    expect(run.code).toBe(1);
    expect(result(run)).toMatchObject({
      ok: false,
      errorClass: 'SyncAccountError',
      code: 'CREDENTIALS_INVALID',
      stage: 'E1',
    });
    expect(run.raw).not.toContain(BASIC);
  });

  it('la base falla: 1, y la conexión se cierra igual', async () => {
    const end = vi.fn(() => Promise.resolve());
    const session: DbSession = {
      query: () => Promise.reject(new Error('connection terminated unexpectedly')),
      end,
    };
    const run = await cli({ env: ENV, connect: () => Promise.resolve(session) });
    expect(run.code).toBe(1);
    expect(result(run)).toMatchObject({
      ok: false,
      error: 'connection terminated unexpectedly',
      errorClass: 'Error',
    });
    expect(end).toHaveBeenCalledOnce();
  });
});
