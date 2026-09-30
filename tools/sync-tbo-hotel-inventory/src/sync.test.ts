import {
  TboStaticContentClient,
  parseTboConfig,
  type TboHttpDeps,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import type { SyncSettings } from './env.js';
import { SyncAccountError } from './errors.js';
import { JsonLogger } from './log.js';
import { runSync, type SyncDeps, type SyncReport } from './sync.js';
import {
  fakeTbo,
  observedNoHotelsFoundMs,
  requestedHotelCodes,
  tboNoHotelsFound,
  tboStatus,
  type FakeTbo,
  type FakeTboWorld,
} from './testing/fake-tbo.js';
import { MemoryCatalogStore, type MemoryHotelRow } from './testing/memory-catalog-store.js';

/**
 * Una corrida entera con el cliente de contenido REAL del ACL y un `fetch` falso armado con sus
 * fixtures (docs/tbo/09 PR-3.2): lo que se prueba es lo que sale al cable, lo que queda en el
 * catálogo y lo que queda en el log. El escritor de Postgres se prueba aparte con la misma forma
 * de catálogo (`writer.test.ts`, `writer.integration.test.ts`).
 */

// Con forma reconocible para buscarlos en el log. No son credenciales.
const USERNAME = 'catalogo-plataforma-demo';
const PASSWORD = 'Pa55-catalogo-sync';
const BASIC = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
const PROVIDER = 'tbo-hotels';
const DESPEGAR = 'despegar-hotels';
const T0 = Date.UTC(2026, 8, 25, 8, 0, 0);
const LONG_AGO = new Date(T0 - 30 * 86_400_000);

const immediateLimiter: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

function settings(overrides: Partial<SyncSettings> = {}): SyncSettings {
  return {
    providerCode: PROVIDER,
    destinationSourceProvider: DESPEGAR,
    countries: ['AR', 'AL'],
    stages: new Set(['E1', 'E2', 'E3', 'E5'] as const),
    maxCalls: 1_000,
    maxDurationMs: 45 * 60_000,
    sweepMaxDrop: 0.5,
    maxConsecutiveThrottled: 3,
    maxConsecutiveErrors: 10,
    cadence: {
      demandMaxAgeMs: 20 * 3_600_000,
      regularMaxAgeMs: 7 * 86_400_000,
      emptyMaxAgeMs: 30 * 86_400_000,
      demandWindowMs: 14 * 86_400_000,
    },
    content: {
      scope: 'demand',
      demandLangs: ['es', 'pt', 'en'],
      regularLangs: ['es', 'pt'],
      batchSize: 10,
      maxAgeMs: 30 * 86_400_000,
    },
    ...overrides,
  };
}

/** Dos países del ejemplo de CountryList (p. 52), con ciudades y hoteles propios del escenario. */
const WORLD: FakeTboWorld = {
  countries: ['AL', 'AR', 'AW'],
  cities: {
    AR: [
      { code: '900001', name: 'Buenos Aires' },
      { code: '900002', name: 'Córdoba' },
    ],
    AL: [{ code: '800001', name: 'Tirana' }],
  },
  hotels: {
    '900001': [
      { code: '1000001', lat: -34.6, lng: -58.38 },
      { code: '1000002', lat: -34.61, lng: -58.39 },
      { code: '1000003', lat: -34.62, lng: -58.4 },
    ],
    '900002': [{ code: '1000004', lat: -31.42, lng: -64.18 }],
    '800001': [
      { code: '1000005', lat: 41.33, lng: 19.82 },
      { code: '1000006', lat: 41.32, lng: 19.81, rating: 'FiveStar' },
    ],
  },
  // Incluye el 1000098 que E3 va a barrer: así cada etapa se prueba por separado.
  codelist: ['1000001', '1000002', '1000003', '1000004', '1000005', '1000006', '1000098'],
};

interface Harness {
  readonly store: MemoryCatalogStore;
  readonly tbo: FakeTbo;
  readonly lines: string[];
  run(overrides?: Partial<SyncSettings>, deps?: Partial<SyncDeps>): Promise<SyncReport>;
}

/** `tboDeps` pisa las del cliente HTTP del ACL: p. ej. su reloj, que mide lo que tarda cada intento. */
function harness(
  world: FakeTboWorld = WORLD,
  clock: () => number = () => T0,
  tboDeps: Partial<TboHttpDeps> = {},
): Harness {
  const tbo = fakeTbo(world);
  const lines: string[] = [];
  const logger = new JsonLogger({ level: 'debug', sink: (line) => lines.push(line) });
  const store = new MemoryCatalogStore(PROVIDER, () => new Date(clock()));
  const source = new TboStaticContentClient(
    parseTboConfig({ environment: 'test', username: USERNAME, password: PASSWORD }),
    {
      fetch: tbo.fetch,
      logger: logger.child({ component: 'tbo-http' }),
      limiter: immediateLimiter,
      sleep: () => Promise.resolve(),
      ...tboDeps,
    },
    { credentialSource: 'env' },
  );
  return {
    store,
    tbo,
    lines,
    run: (overrides = {}, deps = {}) =>
      runSync(settings(overrides), { source, store, logger, now: clock, ...deps }),
  };
}

function synced(report: SyncReport): Extract<SyncReport, { action: 'sync' }> {
  if (report.action !== 'sync') throw new Error(`esperaba una corrida, fue ${report.reason}`);
  return report;
}

/** Ciudad 900001 ya sincronizada hace un mes: tres hoteles que siguen y uno que TBO dejó de listar. */
function seedBuenosAires(store: MemoryCatalogStore): void {
  store.seedCity({
    code: '900001',
    countryCode: 'AR',
    name: 'Buenos Aires',
    syncedAt: LONG_AGO,
    hotelCount: 4,
  });
  for (const id of ['1000001', '1000002', '1000003', '1000098']) {
    store.seedHotel({
      hotelId: id,
      providerCityCode: '900001',
      lastSeenAt: LONG_AGO,
      countryCode: 'AR',
    });
  }
  // El mismo id en Despegar: otro espacio de ids, otra fila, que nadie de aquí puede tocar.
  store.seedHotel({ providerCode: DESPEGAR, hotelId: '1000098', cityId: 6585, name: 'Despegar' });
}

function logText(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('Salida de PR-3.2: dos países con fetch falso', () => {
  it('upsert y barrido sin borrar filas, Despegar intacto y sin Authorization en los logs', async () => {
    const h = harness();
    seedBuenosAires(h.store);
    const despegarBefore = h.store.hotel('1000098', DESPEGAR);
    const rowsBefore = h.store.hotels.size;

    const report = synced(await h.run());

    expect(report.outcome).toBe('complete');
    expect(report.stopReason).toBeNull();
    // E1 + E2 (dos países) + E5 + E3 (tres ciudades).
    expect(report.calls).toBe(7);
    expect(report.e1).toEqual({ status: 'done', countries: ['AR', 'AL'], unknownCountries: [] });
    expect(report.e2).toMatchObject({ countriesRequested: 2, citiesReceived: 3 });
    expect(report.e3).toMatchObject({
      status: 'done',
      citiesDue: 3,
      cities: 3,
      hotelsUpserted: 6,
      hotelsDeactivated: 1,
      sweepAnomalies: 0,
    });

    // Ciudades: nombre normalizado, país de la request, conteo, centroide y checkpoint.
    expect(h.store.city('900002')).toMatchObject({
      countryCode: 'AR',
      name: 'Córdoba',
      nameNorm: 'cordoba',
      hotelCount: 1,
      lastStatusCode: 200,
      syncedAt: new Date(T0),
    });
    const ba = h.store.city('900001');
    expect(ba).toMatchObject({ hotelCount: 3, lastStatusCode: 200, syncedAt: new Date(T0) });
    expect(ba?.centroidLat).toBeCloseTo(-34.61, 10);
    expect(ba?.centroidLng).toBeCloseTo(-58.39, 10);

    // Hoteles: la ciudad es la de la request, visto en esta corrida, país del hotel.
    expect(h.store.hotel('1000006')).toMatchObject({
      providerCityCode: '800001',
      countryCode: 'AL',
      stars: 5,
      active: true,
      lastSeenAt: new Date(T0),
      latitude: 41.32,
      longitude: 19.81,
    });
    // El que TBO dejó de listar: baja LÓGICA, la fila sigue.
    expect(h.store.hotel('1000098')).toMatchObject({ active: false, lastSeenAt: LONG_AGO });
    expect(h.store.hotels.size).toBe(rowsBefore + 3);
    expect(h.store.hotel('1000098', DESPEGAR)).toEqual(despegarBefore);

    // La credencial viaja a TBO (Basic) y nunca al log.
    expect(h.tbo.calls.every((call) => call.headers['authorization'] === `Basic ${BASIC}`)).toBe(
      true,
    );
    const log = logText(h.lines);
    expect(log).not.toMatch(/authorization/i);
    expect(log).not.toContain(BASIC);
    expect(log).not.toContain(USERNAME);
    expect(log).not.toContain(PASSWORD);
    expect(h.store.locked).toBe(false);
  });

  it('las llamadas al cable son las del contrato: CityList por país, TBOHotelCodeList por ciudad', async () => {
    const h = harness();
    await h.run();
    expect(h.tbo.callsTo('cityList').map((c) => c.body)).toEqual([
      { CountryCode: 'AR' },
      { CountryCode: 'AL' },
    ]);
    expect(
      h.tbo
        .callsTo('tboHotelCodeList')
        .map((c) => c.body?.['CityCode'])
        .sort(),
    ).toEqual(['800001', '900001', '900002']);
    expect(h.tbo.callsTo('tboHotelCodeList')[0]?.body?.['IsDetailedResponse']).toBe('true');
  });

  it('una segunda corrida inmediata no vuelve a pedir ciudades al día', async () => {
    const h = harness();
    await h.run();
    const report = synced(await h.run({ stages: new Set(['E3']) }));
    expect(report.e3).toMatchObject({ citiesDue: 0, cities: 0 });
    expect(report.calls).toBe(0);
  });
});

describe('RF-30 CA 1: una corrida cortada deja intacto el catálogo anterior', () => {
  function seedThreeCities(store: MemoryCatalogStore): Map<string, MemoryHotelRow> {
    store.seedCity({
      code: '900001',
      countryCode: 'AR',
      syncedAt: new Date(T0 - 10 * 86_400_000),
      hotelCount: 1,
    });
    store.seedCity({
      code: '900002',
      countryCode: 'AR',
      syncedAt: new Date(T0 - 9 * 86_400_000),
      hotelCount: 1,
    });
    store.seedCity({
      code: '800001',
      countryCode: 'AL',
      syncedAt: new Date(T0 - 8 * 86_400_000),
      hotelCount: 1,
    });
    store.seedHotel({ hotelId: '1000001', providerCityCode: '900001', lastSeenAt: LONG_AGO });
    store.seedHotel({ hotelId: '1000004', providerCityCode: '900002', lastSeenAt: LONG_AGO });
    store.seedHotel({ hotelId: '1000005', providerCityCode: '800001', lastSeenAt: LONG_AGO });
    return new Map(store.hotels);
  }

  it('un SIGTERM a mitad: la ciudad en vuelo y las siguientes quedan como estaban', async () => {
    const interrupt = new AbortController();
    const h = harness({
      ...WORLD,
      // La respuesta de la segunda ciudad empieza a llegar y nunca termina: el corte la agarra
      // en vuelo, que es el caso que importa.
      override: (op, body) => {
        if (op !== 'tboHotelCodeList' || body?.['CityCode'] !== '900002') return undefined;
        interrupt.abort();
        return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const before = seedThreeCities(h.store);

    const report = synced(
      await h.run({ stages: new Set(['E3']) }, { interrupt: interrupt.signal }),
    );

    expect(report.outcome).toBe('partial');
    expect(report.stopReason).toBe('interrupted');
    expect(report.e3).toMatchObject({ cities: 1, citiesFailed: 0 });
    // La primera ciudad terminó; la cortada y la que no se alcanzó quedan idénticas a antes.
    expect(h.store.city('900001')?.syncedAt).toEqual(new Date(T0));
    for (const id of ['1000004', '1000005']) {
      expect(h.store.hotel(id)).toEqual(before.get(`${PROVIDER}|${id}`));
    }
    expect(h.store.city('900002')?.syncedAt).toEqual(new Date(T0 - 9 * 86_400_000));
    expect(h.store.city('800001')?.syncedAt).toEqual(new Date(T0 - 8 * 86_400_000));
    expect(h.store.operations).not.toContain('writeCityHotels:900002');
    expect(h.store.operations).not.toContain('recordCityFailure:900002:0');
    expect(h.tbo.callsTo('tboHotelCodeList')).toHaveLength(2);
    expect(h.store.locked).toBe(false);
  });

  it('presupuesto de llamadas agotado: sale "ok parcial" y lo pendiente sigue pendiente', async () => {
    const h = harness();
    const before = seedThreeCities(h.store);

    const report = synced(await h.run({ stages: new Set(['E3']), maxCalls: 2 }));

    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'budget', calls: 2 });
    expect(report.e3).toMatchObject({ citiesDue: 3, cities: 2 });
    expect(h.store.hotel('1000005')).toEqual(before.get(`${PROVIDER}|1000005`));
    expect(h.store.city('800001')?.syncedAt).toEqual(new Date(T0 - 8 * 86_400_000));
  });

  it('presupuesto de tiempo agotado: no lanza una llamada más', async () => {
    let now = T0;
    const h = harness(
      {
        ...WORLD,
        override: () => {
          now += 20 * 60_000;
          return undefined;
        },
      },
      () => now,
    );
    seedThreeCities(h.store);

    const report = synced(await h.run({ stages: new Set(['E3']), maxDurationMs: 30 * 60_000 }));

    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'budget' });
    expect(h.tbo.callsTo('tboHotelCodeList')).toHaveLength(2);
  });

  it('la base falla a mitad de una ciudad: la corrida falla, la ciudad queda como estaba y el lock se libera', async () => {
    const h = harness();
    const before = seedThreeCities(h.store);
    h.store.failNextWrite = true;

    await expect(h.run({ stages: new Set(['E3']) })).rejects.toThrow('simulated database failure');

    expect(h.store.hotels).toEqual(before);
    expect(h.store.city('900001')?.syncedAt).toEqual(new Date(T0 - 10 * 86_400_000));
    expect(h.store.locked).toBe(false);
  });
});

describe('RF-30 CA 2: una ciudad que pierde más hoteles que el umbral no se barre', () => {
  it('registra la anomalía, no desactiva nada y deja la ciudad pendiente', async () => {
    const h = harness({ ...WORLD, hotels: { ...WORLD.hotels, '900001': [{ code: '1000001' }] } });
    seedBuenosAires(h.store);

    const report = synced(await h.run({ stages: new Set(['E3']), countries: ['AR'] }));

    expect(report.e3).toMatchObject({ sweepAnomalies: 1, hotelsDeactivated: 0 });
    for (const id of ['1000001', '1000002', '1000003', '1000098']) {
      expect(h.store.hotel(id)?.active).toBe(true);
    }
    expect(h.store.city('900001')?.syncedAt).toEqual(LONG_AGO);
    const anomaly = h.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['msg'] === 'tbo.sync.sweep_anomaly');
    expect(anomaly).toMatchObject({
      level: 'warn',
      stage: 'E3',
      city: '900001',
      verdict: 'drop-exceeded',
      previouslyActive: 4,
      missing: 3,
      received: 1,
    });

    // Sigue pendiente: la próxima corrida la vuelve a pedir.
    const again = synced(await h.run({ stages: new Set(['E3']), countries: ['AR'] }));
    expect(again.e3.citiesDue).toBeGreaterThanOrEqual(1);
  });

  it('una respuesta vacía de una ciudad con hoteles nunca barre', async () => {
    const h = harness({ ...WORLD, hotels: { ...WORLD.hotels, '900001': [] } });
    seedBuenosAires(h.store);
    const report = synced(
      await h.run({ stages: new Set(['E3']), countries: ['AR'], sweepMaxDrop: 1 }),
    );
    expect(report.e3.sweepAnomalies).toBe(1);
    expect(h.store.hotel('1000098')?.active).toBe(true);
  });

  it('un hotel ilegible hace la lista incompleta: se escribe lo legible y no se barre', async () => {
    const h = harness({
      ...WORLD,
      hotels: {
        ...WORLD.hotels,
        '900001': [...(WORLD.hotels['900001'] ?? []), { code: 'x', raw: { HotelCode: '' } }],
      },
    });
    seedBuenosAires(h.store);
    const report = synced(await h.run({ stages: new Set(['E3']), countries: ['AR'] }));
    expect(report.e3).toMatchObject({
      incompleteResponses: 1,
      sweepAnomalies: 0,
      hotelsDeactivated: 0,
    });
    expect(h.store.hotel('1000098')?.active).toBe(true);
    expect(h.store.city('900001')?.syncedAt).toEqual(new Date(T0));
  });
});

describe('RF-30 CA 3: si hotelcodelist falla, E5 se desactiva sin afectar E1-E4', () => {
  it('404 (el método no existe): E5 "disabled", el resto completo y nada dado de baja por E5', async () => {
    const h = harness({ ...WORLD, codelist: undefined });
    seedBuenosAires(h.store);
    const report = synced(await h.run());
    expect(report.outcome).toBe('complete');
    expect(report.e5).toEqual({ status: 'disabled', code: 'CLIENT_BUG' });
    expect(report.e3).toMatchObject({ cities: 3, hotelsDeactivated: 1 });
    expect(h.store.operations).not.toContain('deactivateMissing');
  });

  it('un cuerpo ilegible o un 401 de ese método: igual, E5 se apaga y E3 sigue', async () => {
    for (const bad of [
      () => new Response('{"HotelCodes": "todos"}', { status: 200 }),
      () => tboStatus(401, 'Access Credentials is incorrect'),
    ]) {
      const h = harness({
        ...WORLD,
        override: (op) => (op === 'hotelCodeList' ? bad() : undefined),
      });
      const report = synced(await h.run());
      expect(report.e5.status).toBe('disabled');
      expect(report.e3.cities).toBe(3);
    }
  });

  it('su fallo no suma a las rachas de la puerta: con umbrales de 1, E3 corre igual', async () => {
    for (const bad of [
      undefined,
      () => tboStatus(500, 'Unexpected Error'),
      () => tboStatus(429, 'QPS Exceeded'),
    ]) {
      const h = harness({
        ...WORLD,
        codelist: undefined,
        ...(bad === undefined
          ? {}
          : { override: (op) => (op === 'hotelCodeList' ? bad() : undefined) }),
      });
      seedBuenosAires(h.store);
      const report = synced(await h.run({ maxConsecutiveErrors: 1, maxConsecutiveThrottled: 1 }));
      expect(report.e5.status).toBe('disabled');
      expect(report).toMatchObject({ outcome: 'complete', stopReason: null });
      expect(report.e3).toMatchObject({ cities: 3, citiesFailed: 0, hotelsDeactivated: 1 });
      // Sigue a la vista en los contadores aunque no cuente para cortar.
      expect(Object.values(report.errorsByCode).reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  it('cuando responde: da de baja lo que ya no está, con la misma guarda', async () => {
    const h = harness({ ...WORLD, codelist: ['1000001', '1000002', '1000003'] });
    seedBuenosAires(h.store);
    const report = synced(await h.run({ stages: new Set(['E5']) }));
    expect(report.e5).toMatchObject({
      status: 'done',
      codesReceived: 3,
      previouslyActive: 4,
      missing: 1,
      verdict: 'swept',
      deactivated: 1,
    });
    expect(h.store.hotel('1000098')?.active).toBe(false);
    expect(h.store.hotel('1000098', DESPEGAR)?.active).toBe(true);
  });

  it('lo que su ciudad listó dentro del ciclo no lo da de baja la lista global (Q-61 e)', async () => {
    const h = harness({ ...WORLD, codelist: ['1000001', '1000002', '1000003'] });
    seedBuenosAires(h.store);
    // E3 lo vio ayer en su ciudad; `hotelcodelist` todavía no lo trae (un alta reciente).
    h.store.seedHotel({
      hotelId: '1000099',
      providerCityCode: '900001',
      lastSeenAt: new Date(T0 - 86_400_000),
      countryCode: 'AR',
    });
    const report = synced(await h.run({ stages: new Set(['E5']) }));
    // Los dos faltan en la lista global (la guarda los cuenta a ambos); sólo se apaga el que
    // ninguna ciudad respalda desde hace más de un ciclo.
    expect(report.e5).toMatchObject({ previouslyActive: 5, missing: 2, deactivated: 1 });
    expect(h.store.hotel('1000099')?.active).toBe(true);
    expect(h.store.hotel('1000098')?.active).toBe(false);
  });

  it('una lista global que dejaría fuera a más de la mitad no desactiva nada', async () => {
    const h = harness({ ...WORLD, codelist: ['1000001'] });
    seedBuenosAires(h.store);
    const report = synced(await h.run({ stages: new Set(['E5']) }));
    expect(report.e5).toMatchObject({ verdict: 'drop-exceeded', deactivated: 0 });
    expect([...h.store.hotels.values()].every((row) => row.active)).toBe(true);
  });
});

describe('RF-30 CA 4: ninguna línea de log contiene Authorization', () => {
  it('ni en una corrida llena de errores, con el log en debug', async () => {
    const h = harness({
      ...WORLD,
      override: (op, body) => {
        if (op === 'tboHotelCodeList' && body?.['CityCode'] === '900001') {
          return tboStatus(500, 'Unexpected Error');
        }
        if (op === 'tboHotelCodeList' && body?.['CityCode'] === '900002') {
          return new Response('<html>502</html>', { status: 502 });
        }
        return undefined;
      },
    });
    const report = synced(await h.run());
    expect(report.e3.citiesFailed).toBe(2);
    expect(h.lines.length).toBeGreaterThan(10);
    const log = logText(h.lines);
    expect(log).not.toMatch(/authorization/i);
    expect(log).not.toContain(BASIC);
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(USERNAME);
  });
});

describe('Exclusión mutua (05 §6.4)', () => {
  it('con el lock tomado por otra corrida, sale sin llamar a TBO ni escribir', async () => {
    const h = harness();
    h.store.lockedElsewhere = true;
    const report = await h.run();
    expect(report).toEqual({ action: 'skip', reason: 'locked' });
    expect(h.tbo.calls).toHaveLength(0);
    expect(h.store.operations).toEqual(['tryLock']);
  });
});

describe('Corte ordenado ante 429 (05 §6.4)', () => {
  it('N 429 seguidos → "ok parcial"; las ciudades tocadas anotan 429 y las demás quedan igual', async () => {
    const cities = Array.from({ length: 5 }, (_, i) => ({
      code: `70000${i}`,
      name: `Ciudad ${i}`,
    }));
    const h = harness({
      ...WORLD,
      cities: { AR: cities },
      override: (op) => (op === 'tboHotelCodeList' ? tboStatus(429, 'QPS Exceeded') : undefined),
    });

    const report = synced(await h.run({ countries: ['AR'], stages: new Set(['E2', 'E3']) }));

    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'throttled', status429: 3 });
    expect(report.errorsByCode).toEqual({ THROTTLED: 3 });
    const touched = cities.filter((c) => h.store.city(c.code)?.lastStatusCode === 429);
    expect(touched).toHaveLength(3);
    const untouched = cities.filter((c) => h.store.city(c.code)?.lastStatusCode === null);
    expect(untouched).toHaveLength(2);
    // Cada llamada lógica ya agotó los reintentos con backoff del cliente HTTP (5 intentos).
    expect(h.tbo.callsTo('tboHotelCodeList')).toHaveLength(15);
    expect([...h.store.cities.values()].every((c) => c.syncedAt === null)).toBe(true);
  });

  it('un 429 aislado no corta: la racha se reinicia con la siguiente respuesta buena', async () => {
    const h = harness({
      ...WORLD,
      override: (op, body) =>
        op === 'tboHotelCodeList' && body?.['CityCode'] === '900001'
          ? tboStatus(429, 'QPS Exceeded')
          : undefined,
    });
    const report = synced(await h.run());
    expect(report).toMatchObject({ outcome: 'complete', status429: 1 });
    expect(report.e3).toMatchObject({ cities: 2, citiesFailed: 1 });
  });
});

describe('Errores por ciudad y errores de cuenta', () => {
  it('una ciudad que falla anota su código y la corrida sigue', async () => {
    const h = harness({
      ...WORLD,
      override: (op, body) =>
        op === 'tboHotelCodeList' && body?.['CityCode'] === '900002'
          ? tboStatus(500, 'Unexpected Error')
          : undefined,
    });
    const report = synced(await h.run());
    expect(report).toMatchObject({ outcome: 'complete', errorsByCode: { UPSTREAM: 1 } });
    expect(h.store.city('900002')).toMatchObject({ lastStatusCode: 500, syncedAt: null });
    expect(h.store.city('800001')?.syncedAt).toEqual(new Date(T0));
  });

  it('una racha de errores corta la corrida en "ok parcial"', async () => {
    const h = harness({
      ...WORLD,
      override: (op) =>
        op === 'tboHotelCodeList' ? tboStatus(500, 'Unexpected Error') : undefined,
    });
    const report = synced(await h.run({ maxConsecutiveErrors: 2 }));
    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'errors' });
    expect(report.e3.citiesFailed).toBe(2);
  });

  it('401 en CountryList: la cuenta no sirve, se corta todo con error tipado y se libera el lock', async () => {
    const h = harness({
      ...WORLD,
      override: (op) =>
        op === 'countryList' ? tboStatus(401, 'Access Credentials is incorrect') : undefined,
    });
    const failure = h.run();
    await expect(failure).rejects.toBeInstanceOf(SyncAccountError);
    await expect(failure).rejects.toMatchObject({ code: 'CREDENTIALS_INVALID', stage: 'E1' });
    expect(h.tbo.calls).toHaveLength(1);
    expect(h.store.locked).toBe(false);
  });

  it('402 en una ciudad: también corta', async () => {
    const h = harness({
      ...WORLD,
      override: (op) =>
        op === 'tboHotelCodeList' ? tboStatus(402, 'Agent is blocked') : undefined,
    });
    await expect(h.run()).rejects.toMatchObject({ code: 'ACCOUNT_BLOCKED', stage: 'E3' });
  });
});

describe('Ciudad sin hoteles: "No Hotels Found" (01 §8.5; producción, 2026-09-29)', () => {
  const DAY = 86_400_000;
  const answersEmpty =
    (cityCode: string): FakeTboWorld['override'] =>
    (op, body) =>
      op === 'tboHotelCodeList' && body?.['CityCode'] === cityCode ? tboNoHotelsFound() : undefined;

  function callsFor(h: Harness, cityCode: string): number {
    return h.tbo.callsTo('tboHotelCodeList').filter((call) => call.body?.['CityCode'] === cityCode)
      .length;
  }

  function logLines(h: Harness): Record<string, unknown>[] {
    return h.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('una llamada y queda al día con hotel_count 0: ni fallo, ni error, ni racha', async () => {
    const h = harness({ ...WORLD, override: answersEmpty('900002') });
    // Con un umbral de 1, una ciudad vacía contada como error habría cortado la corrida.
    const report = synced(await h.run({ maxConsecutiveErrors: 1 }));

    expect(report).toMatchObject({ outcome: 'complete', stopReason: null });
    expect(report.errorsByCode).toEqual({});
    expect(report.e3).toMatchObject({ cities: 3, citiesEmpty: 1, citiesFailed: 0 });
    expect(callsFor(h, '900002')).toBe(1);
    expect(h.store.city('900002')).toMatchObject({
      hotelCount: 0,
      centroidLat: null,
      centroidLng: null,
      lastStatusCode: 200,
      syncedAt: new Date(T0),
    });
    const lines = logLines(h);
    expect(lines.filter((line) => line['msg'] === 'tbo.http.error')).toEqual([]);
    expect(lines.find((line) => line['msg'] === 'tbo.static.city_without_hotels')).toMatchObject({
      level: 'info',
      cityCode: '900002',
      tboCode: 500,
      attempt: 1,
    });
    expect(
      lines.find((line) => line['msg'] === 'tbo.sync.stage' && line['stage'] === 'E3'),
    ).toMatchObject({ citiesEmpty: 1, citiesFailed: 0 });
  });

  it('vuelve con la cadencia de las vacías (TBO_SYNC_EMPTY_REFRESH_DAYS), no en cada corrida', async () => {
    let now = T0;
    const h = harness({ ...WORLD, override: answersEmpty('900002') }, () => now);
    const onlyE3 = { stages: new Set(['E3'] as const), countries: ['AR'] };

    synced(await h.run(onlyE3));
    expect(callsFor(h, '900002')).toBe(1);

    // A la hora, nada vence: ni la ciudad con hoteles ni la vacía.
    now = T0 + 3_600_000;
    expect(synced(await h.run(onlyE3)).e3).toMatchObject({ citiesDue: 0 });

    // A los 8 días vence la cadencia semanal de la ciudad con hoteles; la vacía espera a los 30.
    now = T0 + 8 * DAY;
    expect(synced(await h.run(onlyE3)).e3).toMatchObject({ citiesDue: 1, citiesEmpty: 0 });
    expect(callsFor(h, '900002')).toBe(1);

    now = T0 + 30 * DAY;
    expect(synced(await h.run(onlyE3)).e3).toMatchObject({ citiesEmpty: 1 });
    expect(callsFor(h, '900002')).toBe(2);
    expect(h.store.city('900002')?.syncedAt).toEqual(new Date(T0 + 30 * DAY));
  });

  it('una ciudad CON hoteles que contesta "No Hotels Found" no se barre: anomalía y pendiente', async () => {
    const h = harness({ ...WORLD, override: answersEmpty('900001') });
    seedBuenosAires(h.store);
    const report = synced(await h.run({ stages: new Set(['E3']), countries: ['AR'] }));

    expect(report.e3).toMatchObject({
      sweepAnomalies: 1,
      citiesEmpty: 0,
      citiesFailed: 0,
      hotelsDeactivated: 0,
    });
    for (const id of ['1000001', '1000002', '1000003', '1000098']) {
      expect(h.store.hotel(id)?.active).toBe(true);
    }
    expect(h.store.city('900001')).toMatchObject({ syncedAt: LONG_AGO, hotelCount: 4 });
    expect(logLines(h).find((line) => line['msg'] === 'tbo.sync.sweep_anomaly')).toMatchObject({
      city: '900001',
      verdict: 'empty-response',
      previouslyActive: 4,
    });
  });

  it('cualquier otro 500 sigue siendo una ciudad fallida, con sus reintentos y pendiente', async () => {
    const h = harness({
      ...WORLD,
      override: (op, body) =>
        op === 'tboHotelCodeList' && body?.['CityCode'] === '900002'
          ? tboStatus(500, 'Unexpected Error')
          : undefined,
    });
    const report = synced(await h.run());
    expect(report).toMatchObject({ errorsByCode: { UPSTREAM: 1 } });
    expect(report.e3).toMatchObject({ citiesEmpty: 0, citiesFailed: 1 });
    expect(callsFor(h, '900002')).toBe(5);
    expect(h.store.city('900002')).toMatchObject({ lastStatusCode: 500, syncedAt: null });
  });
});

describe('"No Hotels Found" lento: el plazo de TBO vencido, no una ciudad vacía (01 §8.5)', () => {
  /**
   * La ciudad contesta "No Hotels Found" con las duraciones de una llamada del log del 2026-09-29,
   * adelantando el reloj del cliente HTTP lo que tardó cada intento. Pasados esos intentos, TBO
   * contesta lo del mundo: el hotel 1000004 de Córdoba.
   */
  function slowNoHotelsFound(
    cityCode: string,
    requestId: string,
  ): { readonly world: FakeTboWorld; readonly tboDeps: Partial<TboHttpDeps> } {
    const durationsMs = observedNoHotelsFoundMs(requestId);
    let clock = 0;
    return {
      world: {
        ...WORLD,
        override: (op, body, attempt) => {
          if (op !== 'tboHotelCodeList' || body?.['CityCode'] !== cityCode) return undefined;
          const ms = durationsMs[attempt - 1];
          if (ms === undefined) return undefined;
          clock += ms;
          return tboNoHotelsFound();
        },
      },
      tboDeps: { now: () => clock },
    };
  }

  function callsFor(h: Harness, cityCode: string): number {
    return h.tbo.callsTo('tboHotelCodeList').filter((call) => call.body?.['CityCode'] === cityCode)
      .length;
  }

  function logLines(h: Harness): Record<string, unknown>[] {
    return h.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('lento y después con hoteles (d121e5da: 5.088 y 5.092 ms): se reintenta y se escriben', async () => {
    const { world, tboDeps } = slowNoHotelsFound('900002', 'd121e5da');
    const h = harness(world, () => T0, tboDeps);
    const report = synced(await h.run());

    expect(report).toMatchObject({ outcome: 'complete', errorsByCode: {} });
    expect(report.e3).toMatchObject({ cities: 3, citiesEmpty: 0, citiesFailed: 0 });
    expect(callsFor(h, '900002')).toBe(3);
    expect(h.store.hotel('1000004')?.active).toBe(true);
    expect(h.store.city('900002')).toMatchObject({
      hotelCount: 1,
      lastStatusCode: 200,
      syncedAt: new Date(T0),
    });
    const lines = logLines(h);
    expect(
      lines
        .filter((line) => line['msg'] === 'tbo.http.error')
        .map((line) => [line['reason'], line['durationMs'], line['kind']]),
    ).toEqual([
      ['slow_no_hotels_found', 5_088, 'UPSTREAM'],
      ['slow_no_hotels_found', 5_092, 'UPSTREAM'],
    ]);
    expect(lines.map((line) => line['msg'])).not.toContain('tbo.static.city_without_hotels');
  });

  it('lento en los 5 intentos (57ed77c7): UPSTREAM y la ciudad fallida, que la próxima corrida vuelve a pedir', async () => {
    const { world, tboDeps } = slowNoHotelsFound('900002', '57ed77c7');
    const h = harness(world, () => T0, tboDeps);
    const first = synced(await h.run());

    expect(first).toMatchObject({ errorsByCode: { UPSTREAM: 1 } });
    expect(first.e3).toMatchObject({ citiesEmpty: 0, citiesFailed: 1 });
    expect(callsFor(h, '900002')).toBe(5);
    expect(h.store.city('900002')).toMatchObject({ lastStatusCode: 500, syncedAt: null });
    expect(h.store.hotel('1000004')).toBeUndefined();
    const lines = logLines(h);
    expect(
      lines.filter((line) => line['msg'] === 'tbo.http.error').map((line) => line['reason']),
    ).toEqual(Array.from({ length: 5 }, () => 'slow_no_hotels_found'));
    expect(lines.map((line) => line['msg'])).not.toContain('tbo.static.city_without_hotels');

    // El log no tiene un sexto intento: en la corrida siguiente TBO contesta con el hotel.
    const second = synced(await h.run({ stages: new Set(['E3'] as const), countries: ['AR'] }));
    expect(second.e3).toMatchObject({ citiesDue: 1, cities: 1, citiesFailed: 0 });
    expect(callsFor(h, '900002')).toBe(6);
    expect(h.store.hotel('1000004')?.active).toBe(true);
    expect(h.store.city('900002')).toMatchObject({ lastStatusCode: 200, syncedAt: new Date(T0) });
  });
});

describe('E1 y E2', () => {
  it('un país configurado que TBO no lista no gasta CityList', async () => {
    const h = harness();
    const report = synced(await h.run({ countries: ['AR', 'ZZ'] }));
    expect(report.e1).toEqual({ status: 'done', countries: ['AR'], unknownCountries: ['ZZ'] });
    expect(h.tbo.callsTo('cityList').map((c) => c.body)).toEqual([{ CountryCode: 'AR' }]);
  });

  it('si CountryList falla, se sigue con los países configurados', async () => {
    const h = harness({
      ...WORLD,
      override: (op) => (op === 'countryList' ? tboStatus(500, 'Unexpected Error') : undefined),
    });
    const report = synced(await h.run());
    expect(report.e1).toEqual({ status: 'failed', countries: ['AR', 'AL'], unknownCountries: [] });
    expect(report.e3.cities).toBe(3);
  });

  it('una corrida sólo E3 pide CityList únicamente de los países sin ciudades guardadas', async () => {
    const h = harness();
    seedBuenosAires(h.store);
    const report = synced(await h.run({ stages: new Set(['E3']) }));
    expect(h.tbo.callsTo('countryList')).toHaveLength(0);
    expect(h.tbo.callsTo('cityList').map((c) => c.body)).toEqual([{ CountryCode: 'AL' }]);
    expect(report.e2).toMatchObject({ countriesRequested: 1, countriesSkipped: 1 });
  });

  it('un refresco de CityList no reinicia el checkpoint ni el centroide de E3', async () => {
    const h = harness();
    seedBuenosAires(h.store);
    await h.run({ stages: new Set(['E2']) });
    expect(h.store.city('900001')).toMatchObject({ syncedAt: LONG_AGO, hotelCount: 4 });
  });
});

describe('TBO_SYNC_CITIES: una corrida acotada a unas ciudades (07 §7.3 punto 6)', () => {
  function logged(lines: readonly string[], msg: string): Record<string, unknown>[] {
    return lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['msg'] === msg);
  }

  it('E2 sigue por país; E3 sólo recorre las de la lista y avisa de las que no encuentra', async () => {
    const h = harness();
    const report = synced(await h.run({ cities: ['900002', '777777'] }));

    expect(h.tbo.callsTo('cityList').map((c) => c.body)).toEqual([
      { CountryCode: 'AR' },
      { CountryCode: 'AL' },
    ]);
    expect(h.tbo.callsTo('tboHotelCodeList').map((c) => c.body?.['CityCode'])).toEqual(['900002']);
    expect(report.outcome).toBe('complete');
    expect(report.e3).toMatchObject({ citiesDue: 1, cities: 1, hotelsUpserted: 1 });
    // Las demás quedan pendientes para una corrida sin lista, no marcadas como recorridas.
    expect(h.store.city('900001')).toMatchObject({ syncedAt: null, hotelCount: null });
    expect(h.store.city('800001')).toMatchObject({ syncedAt: null, hotelCount: null });
    expect(logged(h.lines, 'tbo.sync.cities_unknown')).toEqual([
      expect.objectContaining({ stage: 'E3', unknownCities: ['777777'] }),
    ]);
  });

  it('sin códigos desconocidos no avisa', async () => {
    const h = harness();
    await h.run({ cities: ['800001'] });
    expect(logged(h.lines, 'tbo.sync.cities_unknown')).toEqual([]);
  });

  it('E4 pide contenido sólo de los hoteles de esas ciudades', async () => {
    const h = harness();
    h.store.seedCity({ code: '900001', countryCode: 'AR', syncedAt: new Date(T0), hotelCount: 2 });
    h.store.seedCity({ code: '900002', countryCode: 'AR', syncedAt: new Date(T0), hotelCount: 1 });
    for (const id of ['1000001', '1000002']) {
      h.store.seedHotel({ hotelId: id, providerCityCode: '900001' });
    }
    h.store.seedHotel({ hotelId: '1000004', providerCityCode: '900002' });

    const report = synced(
      await h.run({
        stages: new Set(['E4']),
        countries: ['AR'],
        cities: ['900002'],
        content: { ...settings().content, scope: 'all', regularLangs: ['es'] },
      }),
    );

    expect(h.tbo.callsTo('hotelDetails').map((c) => requestedHotelCodes(c.body))).toEqual([
      ['1000004'],
    ]);
    expect(report.e4).toMatchObject({ hotelsDue: 1, contentsWritten: 1 });
    expect(h.store.content('1000001', 'es')).toBeUndefined();
  });
});

describe('Prioridad por demanda (05 §6.3)', () => {
  it('con presupuesto para una sola ciudad, va la de destinos más buscados', async () => {
    const h = harness();
    h.store.seedCity({ code: '900001', countryCode: 'AR' });
    h.store.seedCity({ code: '900002', countryCode: 'AR' });
    h.store.seedCity({ code: '800001', countryCode: 'AL' });
    h.store.demand.set('800001', 7);
    const report = synced(await h.run({ stages: new Set(['E3']), maxCalls: 1 }));
    expect(report.e3.cities).toBe(1);
    expect(h.tbo.callsTo('tboHotelCodeList').map((c) => c.body?.['CityCode'])).toEqual(['800001']);
  });
});

describe('PR-3.3: contenido de hotel (E4)', () => {
  const DAY = 86_400_000;
  const E4_ONLY = new Set(['E4'] as const);
  const hotelIds = (n: number, from = 1): string[] =>
    Array.from({ length: n }, (_, i) => String(1_000_000 + from + i));
  const onlySpanish = (): SyncSettings['content'] => ({
    ...settings().content,
    demandLangs: ['es'],
  });

  /** Una ciudad con demanda (900001) y otra sin (900002), ya en el catálogo: E4 no depende de E3. */
  function seedContentCatalog(
    store: MemoryCatalogStore,
    options: { readonly demandHotels: number; readonly regularHotels?: number },
  ): { readonly demand: string[]; readonly regular: string[] } {
    store.seedCity({ code: '900001', countryCode: 'AR', syncedAt: new Date(T0), hotelCount: 0 });
    store.seedCity({ code: '900002', countryCode: 'AR', syncedAt: new Date(T0), hotelCount: 0 });
    store.demand.set('900001', 5);
    const demand = hotelIds(options.demandHotels);
    const regular = hotelIds(options.regularHotels ?? 0, 500);
    for (const id of demand) store.seedHotel({ hotelId: id, providerCityCode: '900001' });
    for (const id of regular) store.seedHotel({ hotelId: id, providerCityCode: '900002' });
    return { demand, regular };
  }

  function detailsCalls(tbo: FakeTbo): { readonly lang: unknown; readonly codes: string[] }[] {
    return tbo
      .callsTo('hotelDetails')
      .map((call) => ({ lang: call.body?.['Language'], codes: requestedHotelCodes(call.body) }));
  }

  function logLines(lines: readonly string[], msg: string): Record<string, unknown>[] {
    return lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['msg'] === msg);
  }

  it('lotes de 10 por idioma, ES, PT y EN para los hoteles con demanda, y nada para el resto', async () => {
    const h = harness();
    const { demand, regular } = seedContentCatalog(h.store, {
      demandHotels: 12,
      regularHotels: 3,
    });

    const report = synced(await h.run({ stages: E4_ONLY, countries: ['AR'] }));

    expect(detailsCalls(h.tbo).map((c) => [c.lang, c.codes.length])).toEqual([
      ['ES', 10],
      ['ES', 2],
      ['PT', 10],
      ['PT', 2],
      ['EN', 10],
      ['EN', 2],
    ]);
    // El body es el del contrato: `Hotelcodes` CSV y `Language`; nunca `IsRoomDetailRequired` (N10).
    for (const call of h.tbo.callsTo('hotelDetails')) {
      expect(Object.keys(call.body ?? {}).sort()).toEqual(['Hotelcodes', 'Language']);
    }
    expect(report).toMatchObject({ outcome: 'complete', calls: 6 });
    expect(report.e4).toMatchObject({
      status: 'done',
      scope: 'demand',
      hotelsDue: 12,
      tasksDue: 36,
      batchesPlanned: 6,
      contentsReceived: 36,
      contentsWritten: 36,
      contentsUnchanged: 0,
      hotelsFailed: 0,
      splits: 0,
    });
    for (const id of demand) {
      for (const lang of ['es', 'pt', 'en'] as const) {
        expect(h.store.content(id, lang)).toMatchObject({
          source: 'details',
          name: `Hotel ${id} ${lang.toUpperCase()}`,
          fetchedAt: new Date(T0),
        });
      }
    }
    for (const id of regular) expect(h.store.content(id, 'es')).toBeUndefined();
    expect(logText(h.lines)).not.toMatch(/authorization/i);
    expect(logText(h.lines)).not.toContain(PASSWORD);
  });

  it('RF-32 al ingerir: HTML saneado sin script, imágenes https, horarios HH:mm y sin servicios negados', async () => {
    const [id = ''] = hotelIds(1);
    const h = harness({
      ...WORLD,
      details: {
        raw: {
          [id]: {
            Description:
              '<p>HeadLine : Cerca del mar</p><script>alert(1)</script><p onclick="x()">Rooms : 20</p>',
            Images: [
              'https://api.tbotechnology.in/imageresource.aspx?img=ok',
              'http://api.tbotechnology.in/imageresource.aspx?img=mixto',
            ],
          },
        },
      },
    });
    seedContentCatalog(h.store, { demandHotels: 1 });

    await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() });

    const row = h.store.content(id, 'es');
    expect(row?.descriptionHtml).not.toMatch(/script|alert|onclick/i);
    expect(row?.sections).toEqual(
      expect.arrayContaining([{ label: 'HeadLine', text: 'Cerca del mar' }]),
    );
    expect(row?.images).toEqual(['https://api.tbotechnology.in/imageresource.aspx?img=ok']);
    expect(row).toMatchObject({ checkInTime: '15:00', checkOutTime: '12:00' });
    expect(row?.facilities).toContain('Library');
    expect(row?.facilities.some((f) => /wheelchair/i.test(f))).toBe(false);
  });

  it('criterio de PR-3.3: un lote que falla se parte hasta aislar el código, y los demás reciben su contenido', async () => {
    const ids = hotelIds(10);
    const poison = ids[6] ?? '';
    const h = harness({
      ...WORLD,
      // Un 400 cada vez que el lote incluye el código envenenado: CLIENT_BUG no se reintenta, así
      // que cada llamada lógica es un solo request y la secuencia se lee directo.
      override: (op, body) =>
        op === 'hotelDetails' && requestedHotelCodes(body).includes(poison)
          ? tboStatus(400, 'Invalid request')
          : undefined,
    });
    seedContentCatalog(h.store, { demandHotels: 10 });

    const report = synced(
      await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() }),
    );

    // 10 → 5 + 5; el segundo 5 → 3 + 2; el 3 → 2 + 1; el 2 → 1 + 1: el 7.º queda solo.
    expect(detailsCalls(h.tbo).map((c) => c.codes)).toEqual([
      ids,
      ids.slice(0, 5),
      ids.slice(5, 10),
      ids.slice(5, 8),
      ids.slice(5, 7),
      [ids[5]],
      [poison],
      [ids[7]],
      ids.slice(8, 10),
    ]);
    expect(report).toMatchObject({
      outcome: 'complete',
      calls: 9,
      errorsByCode: { CLIENT_BUG: 5 },
    });
    expect(report.e4).toMatchObject({
      batchesAttempted: 1,
      splits: 4,
      hotelsFailed: 1,
      contentsWritten: 9,
    });
    for (const id of ids) {
      if (id === poison) expect(h.store.content(id, 'es')).toBeUndefined();
      else expect(h.store.content(id, 'es')?.source).toBe('details');
    }
    expect(logLines(h.lines, 'tbo.sync.content_failed')).toEqual([
      expect.objectContaining({
        level: 'warn',
        stage: 'E4',
        lang: 'es',
        hotel: poison,
        code: 'CLIENT_BUG',
        statusCode: 400,
      }),
    ]);
  });

  it('un 500 también parte, con menos intentos por lote que por código', async () => {
    const [ok = '', poison = ''] = hotelIds(2);
    const h = harness({
      ...WORLD,
      override: (op, body) =>
        op === 'hotelDetails' && requestedHotelCodes(body).includes(poison)
          ? tboStatus(500, 'Unexpected Error')
          : undefined,
    });
    seedContentCatalog(h.store, { demandHotels: 2 });

    const report = synced(
      await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() }),
    );

    // Lote: 2 intentos; el código bueno, 1; el envenenado, 3.
    expect(detailsCalls(h.tbo).map((c) => c.codes)).toEqual([
      [ok, poison],
      [ok, poison],
      [ok],
      [poison],
      [poison],
      [poison],
    ]);
    expect(report.calls).toBe(3);
    expect(report.e4).toMatchObject({ splits: 1, hotelsFailed: 1, contentsWritten: 1 });
  });

  it.each([
    [400, 'CLIENT_BUG'],
    [201, 'NO_AVAILABILITY'],
  ])(
    'varios códigos que TBO rechaza seguidos (Status %i) se aíslan todos y la corrida sigue',
    async (status, code) => {
      const ids = hotelIds(20);
      const poisoned = new Set(ids.slice(0, 6));
      const h = harness({
        ...WORLD,
        override: (op, body) =>
          op === 'hotelDetails' && requestedHotelCodes(body).some((id) => poisoned.has(id))
            ? tboStatus(status, 'Rejected')
            : undefined,
      });
      seedContentCatalog(h.store, { demandHotels: 20 });

      const report = synced(
        await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() }),
      );

      // Aislar seis códigos seguidos son más de diez fallos seguidos: sin `isolating`, la racha de
      // errores cortaba la corrida dentro del primer lote y nadie recibía contenido, corrida tras
      // corrida (05 §10: "un código que falla solo se marca y se sigue").
      expect(report).toMatchObject({ outcome: 'complete', stopReason: null, calls: 18 });
      expect(report.errorsByCode[code]).toBe(14);
      expect(report.e4).toMatchObject({ hotelsFailed: 6, contentsWritten: 14 });
      for (const id of ids) {
        expect(h.store.content(id, 'es')?.source).toBe(poisoned.has(id) ? undefined : 'details');
      }
    },
  );

  it.each([
    ['un TBO caído (Status 500)', (): Response => tboStatus(500, 'Unexpected Error')],
    [
      'un path equivocado (HTTP 404 sin sobre)',
      (): Response => new Response('Not Found', { status: 404 }),
    ],
  ])('%s sigue cortando la corrida: ahí las mitades sí cuentan en la racha', async (_, reply) => {
    const h = harness({
      ...WORLD,
      override: (op) => (op === 'hotelDetails' ? reply() : undefined),
    });
    seedContentCatalog(h.store, { demandHotels: 12 });

    const report = synced(
      await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() }),
    );

    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'errors', calls: 10 });
    expect(h.store.contents.size).toBe(0);
  });

  it('si TBO rechaza todos los lotes, los lotes enteros siguen contando en la racha', async () => {
    const h = harness({
      ...WORLD,
      override: (op) => (op === 'hotelDetails' ? tboStatus(400, 'Rejected') : undefined),
    });
    seedContentCatalog(h.store, { demandHotels: 30 });

    const report = synced(
      await h.run({
        stages: E4_ONLY,
        countries: ['AR'],
        maxConsecutiveErrors: 2,
        content: onlySpanish(),
      }),
    );

    // Primer lote: 19 llamadas (1 + la partición completa, que no alarga la racha); el segundo
    // lote entero completa la racha de 2 y corta antes de partirse.
    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'errors', calls: 20 });
    expect(report.e4).toMatchObject({ hotelsFailed: 10, contentsWritten: 0 });
  });

  it('un 429 no parte el lote: queda para la próxima corrida', async () => {
    const h = harness({
      ...WORLD,
      override: (op) => (op === 'hotelDetails' ? tboStatus(429, 'QPS Exceeded') : undefined),
    });
    seedContentCatalog(h.store, { demandHotels: 12 });

    const report = synced(
      await h.run({
        stages: E4_ONLY,
        countries: ['AR'],
        maxConsecutiveThrottled: 2,
        content: onlySpanish(),
      }),
    );

    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'throttled', calls: 2 });
    expect(report.e4).toMatchObject({ splits: 0, batchesDeferred: 1, contentsWritten: 0 });
    expect(h.store.contents.size).toBe(0);
  });

  it('pedidos que TBO no devuelve se cuentan, no se parten ni se inventan', async () => {
    const ids = hotelIds(3);
    const h = harness({ ...WORLD, details: { omit: [ids[1] ?? ''] } });
    seedContentCatalog(h.store, { demandHotels: 3 });

    const report = synced(
      await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() }),
    );

    // El que faltó en español se pide en inglés (05 CE-23); tampoco está: confirmado sin contenido.
    expect(detailsCalls(h.tbo)).toEqual([
      { lang: 'ES', codes: ids },
      { lang: 'EN', codes: [ids[1]] },
    ]);
    expect(report.calls).toBe(2);
    expect(report.e4).toMatchObject({
      hotelsMissing: 1,
      hotelsWithoutContent: 1,
      hotelsFromFallback: 0,
      fallbackCalls: 1,
      splits: 0,
      contentsWritten: 2,
    });
    expect(h.store.content(ids[1] ?? '', 'es')).toBeUndefined();
    expect(h.store.content(ids[1] ?? '', 'en')).toBeUndefined();
  });

  describe('"No Hotels Found" de HotelDetails (producción, 2026-09-30; 05 CE-23)', () => {
    it('H1 — sin español: el inglés se guarda como `en`, sin error ni racha, y no se repite', async () => {
      const ids = hotelIds(3);
      const h = harness({ ...WORLD, details: { languages: ['EN'] } });
      seedContentCatalog(h.store, { demandHotels: 3 });

      const report = synced(
        await h.run({ stages: E4_ONLY, countries: ['AR'], maxConsecutiveErrors: 1 }),
      );

      // ES vacío → EN de respaldo; PT vacío → el inglés ya está; el lote EN ya no hace falta.
      expect(detailsCalls(h.tbo)).toEqual([
        { lang: 'ES', codes: ids },
        { lang: 'EN', codes: ids },
        { lang: 'PT', codes: ids },
      ]);
      expect(report).toMatchObject({ outcome: 'complete', stopReason: null, calls: 3 });
      expect(report.errorsByCode).toEqual({});
      expect(report.e4).toMatchObject({
        hotelsMissing: 6,
        hotelsFromFallback: 6,
        hotelsWithoutContent: 0,
        fallbackCalls: 1,
        isolationCalls: 0,
        contentsWritten: 3,
      });
      for (const id of ids) {
        expect(h.store.content(id, 'en')).toMatchObject({
          source: 'details',
          name: `Hotel ${id} EN`,
        });
        expect(h.store.content(id, 'es')).toBeUndefined();
      }
      const lines = logLines(h.lines, 'tbo.sync.content_batch');
      expect(lines.map((line) => [line['level'], line['lang'], line['fallbackUsed']])).toEqual([
        ['info', 'es', true],
        ['info', 'pt', false],
      ]);
      expect(lines[0]).toMatchObject({ requested: 3, found: { en: 3 }, withoutContent: 0 });
      // En el log no hay códigos de hotel fuera de `debug`.
      expect(JSON.stringify(lines)).not.toContain(ids[0]);
    });

    it('H2 — un código sin contenido tumba el lote: se aísla y los demás reciben inglés y español', async () => {
      const ids = hotelIds(10);
      const poison = ids[6] ?? '';
      const h = harness({ ...WORLD, details: { poison: [poison] } });
      seedContentCatalog(h.store, { demandHotels: 10 });

      const report = synced(
        await h.run({
          stages: E4_ONLY,
          countries: ['AR'],
          maxConsecutiveErrors: 1,
          content: onlySpanish(),
        }),
      );

      const good = ids.filter((id) => id !== poison);
      expect(detailsCalls(h.tbo)).toEqual([
        { lang: 'ES', codes: ids },
        { lang: 'EN', codes: ids },
        { lang: 'EN', codes: ids.slice(0, 5) },
        { lang: 'EN', codes: ids.slice(5, 10) },
        { lang: 'EN', codes: ids.slice(5, 8) },
        { lang: 'EN', codes: ids.slice(8, 10) },
        { lang: 'EN', codes: ids.slice(5, 7) },
        { lang: 'EN', codes: [ids[7]] },
        { lang: 'EN', codes: [ids[5]] },
        { lang: 'EN', codes: [poison] },
        { lang: 'ES', codes: good },
      ]);
      expect(report).toMatchObject({ outcome: 'complete', stopReason: null, calls: 11 });
      expect(report.errorsByCode).toEqual({});
      expect(report.e4).toMatchObject({
        hotelsWithoutContent: 1,
        hotelsUnresolved: 0,
        fallbackCalls: 1,
        isolationCalls: 9,
        splits: 0,
        hotelsFailed: 0,
      });
      for (const id of good) {
        expect(h.store.content(id, 'es')?.source).toBe('details');
        expect(h.store.content(id, 'en')?.source).toBe('details');
      }
      expect(h.store.content(poison, 'es')).toBeUndefined();
      expect(h.store.content(poison, 'en')).toBeUndefined();
    });

    it('H1 — la corrida siguiente no vuelve a pedir en inglés lo que ya está guardado y vigente', async () => {
      let now = T0;
      const ids = hotelIds(10);
      const h = harness({ ...WORLD, details: { languages: ['EN'] } }, () => now);
      seedContentCatalog(h.store, { demandHotels: 10 });
      const run = (): Promise<SyncReport> => h.run({ stages: E4_ONLY, countries: ['AR'] });

      synced(await run());
      expect(detailsCalls(h.tbo).map((c) => [c.lang, c.codes.length])).toEqual([
        ['ES', 10],
        ['EN', 10],
        ['PT', 10],
      ]);

      // Un día después el inglés sigue vigente: el español y el portugués se vuelven a pedir (nada
      // guarda "sin contenido" entre corridas), pero ya sin respaldo.
      now = T0 + DAY;
      const second = synced(await run());
      expect(
        detailsCalls(h.tbo)
          .slice(3)
          .map((c) => [c.lang, c.codes.length]),
      ).toEqual([
        ['ES', 10],
        ['PT', 10],
      ]);
      expect(second.e4).toMatchObject({ fallbackCalls: 0, hotelsFromFallback: 20 });
      for (const id of ids) expect(h.store.content(id, 'en')?.fetchedAt).toEqual(new Date(T0));
    });

    it('H2 con ES, PT y EN: el que tumba el lote no va en el lote en portugués', async () => {
      const ids = hotelIds(10);
      const poison = ids[6] ?? '';
      const good = ids.filter((id) => id !== poison);
      const h = harness({ ...WORLD, details: { poison: [poison] } });
      seedContentCatalog(h.store, { demandHotels: 10 });

      const report = synced(await h.run({ stages: E4_ONLY, countries: ['AR'] }));

      const calls = detailsCalls(h.tbo);
      // ES entero, EN entero, 8 de aislamiento, la vuelta en español sin el malo, y el portugués
      // en UNA llamada sin él. El lote en inglés ya no hace falta.
      expect(calls).toHaveLength(12);
      expect(calls.at(-2)).toEqual({ lang: 'ES', codes: good });
      expect(calls.at(-1)).toEqual({ lang: 'PT', codes: good });
      expect(report.errorsByCode).toEqual({});
      expect(report.e4).toMatchObject({
        batchBreakers: 1,
        hotelsWithoutContent: 1,
        hotelsUnconfirmed: 0,
        hotelsUnresolved: 0,
      });
      for (const id of good) {
        for (const lang of ['es', 'pt', 'en'] as const) {
          expect(h.store.content(id, lang)?.source).toBe('details');
        }
      }
      expect(h.store.content(poison, 'pt')).toBeUndefined();
      const [first] = logLines(h.lines, 'tbo.sync.content_batch');
      expect(first).toMatchObject({ lang: 'es', batchBreakers: 1, withoutContent: 1 });
    });

    it('el aislamiento tiene techo por corrida: lo que no alcanza queda para la próxima', async () => {
      const ids = hotelIds(10);
      const poison = ids[6] ?? '';
      const h = harness({ ...WORLD, details: { poison: [poison] } });
      seedContentCatalog(h.store, { demandHotels: 10 });

      // Con 20 llamadas de presupuesto, el aislamiento tiene 4 (el 20 %).
      const report = synced(
        await h.run({ stages: E4_ONLY, countries: ['AR'], maxCalls: 20, content: onlySpanish() }),
      );

      expect(report).toMatchObject({ outcome: 'complete', calls: 6 });
      expect(report.e4).toMatchObject({
        isolationCalls: 4,
        hotelsFromFallback: 7,
        hotelsWithoutContent: 0,
        hotelsUnresolved: 3,
      });
      const [line] = logLines(h.lines, 'tbo.sync.content_batch');
      expect(line).toMatchObject({ level: 'info', isolationLimited: true, unresolved: 3 });
    });

    it('lo lento (≥ 4.500 ms) sigue siendo un error: se reintenta y, agotado, cuenta como antes', async () => {
      let clock = T0;
      const h = harness(
        {
          ...WORLD,
          override: (op) => {
            if (op !== 'hotelDetails') return undefined;
            clock += 5_090;
            return tboNoHotelsFound();
          },
        },
        () => clock,
        { now: () => clock },
      );
      seedContentCatalog(h.store, { demandHotels: 1 });

      const report = synced(
        await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() }),
      );

      // Un código solo: 3 intentos, todos lentos → UPSTREAM, marcado y la corrida sigue.
      expect(h.tbo.callsTo('hotelDetails')).toHaveLength(3);
      expect(report.errorsByCode).toEqual({ UPSTREAM: 1 });
      expect(report.e4).toMatchObject({ hotelsFailed: 1, fallbackCalls: 0 });
    });
  });

  it('criterio de PR-3.3: el hash evita reescribir; sólo lo que cambió se reescribe', async () => {
    let now = T0;
    const raw: Record<string, Record<string, unknown>> = {};
    const h = harness({ ...WORLD, details: { raw } }, () => now);
    const ids = seedContentCatalog(h.store, { demandHotels: 3 }).demand;
    const run = (): Promise<SyncReport> =>
      h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() });

    const first = synced(await run());
    expect(first.e4).toMatchObject({ contentsWritten: 3, contentsUnchanged: 0 });
    expect(h.store.contentRewrites).toBe(3);

    // Al día: ni siquiera se pide.
    now = T0 + DAY;
    expect(synced(await run()).calls).toBe(0);

    // Vencido y sin cambios en TBO: se pide, no se reescribe y sólo avanza `fetched_at`.
    now = T0 + 31 * DAY;
    const same = synced(await run());
    expect(same.calls).toBe(1);
    expect(same.e4).toMatchObject({ contentsWritten: 0, contentsUnchanged: 3 });
    expect(h.store.contentRewrites).toBe(3);
    expect(h.store.content(ids[0] ?? '', 'es')?.fetchedAt).toEqual(new Date(now));

    // Uno cambió en TBO: sólo ese se reescribe.
    raw[ids[2] ?? ''] = { HotelName: 'Renombrado' };
    now = T0 + 62 * DAY;
    const changed = synced(await run());
    expect(changed.e4).toMatchObject({ contentsWritten: 1, contentsUnchanged: 2 });
    expect(h.store.contentRewrites).toBe(4);
    expect(h.store.content(ids[2] ?? '', 'es')?.name).toBe('Renombrado');
  });

  it('TBOHotelCodeList queda como respaldo en inglés y nunca pisa a HotelDetails', async () => {
    let now = T0;
    const h = harness(WORLD, () => now);

    // E3: la ciudad trae su texto `listing`, en inglés y sin imágenes.
    const listed = synced(await h.run({ stages: new Set(['E3']), countries: ['AR'] }));
    expect(listed.e3.listingContentsWritten).toBe(4);
    expect(h.store.content('1000001', 'en')).toMatchObject({ source: 'listing', images: [] });
    expect(h.store.content('1000001', 'en')?.descriptionHtml).toContain('HeadLine');

    // E4 con demanda en la ciudad: HotelDetails en inglés reemplaza al `listing`.
    h.store.demand.set('900001', 3);
    const details = synced(await h.run({ stages: E4_ONLY, countries: ['AR'] }));
    expect(details.e4.contentsWritten).toBe(9);
    const en = h.store.content('1000001', 'en');
    expect(en?.source).toBe('details');
    expect(en?.images.length).toBeGreaterThan(0);

    // Un nuevo E3 de la ciudad no pisa el `details`: sólo el hotel sin HotelDetails se reescribe.
    now = T0 + 8 * DAY;
    const again = synced(await h.run({ stages: new Set(['E3']), countries: ['AR'] }));
    expect(again.e3).toMatchObject({ listingContentsWritten: 0, listingContentsKept: 4 });
    expect(h.store.content('1000001', 'en')).toEqual(en);
  });

  it('alcance `all`: el resto recibe ES y PT detrás de la demanda, y el presupuesto corta en orden', async () => {
    const h = harness();
    const { demand, regular } = seedContentCatalog(h.store, {
      demandHotels: 2,
      regularHotels: 2,
    });

    const report = synced(
      await h.run({
        stages: E4_ONLY,
        countries: ['AR'],
        maxCalls: 2,
        content: { ...settings().content, scope: 'all' },
      }),
    );

    // Lote ES (2 de demanda + 2 del resto), lote PT (ídem); el EN de la demanda queda pendiente.
    expect(detailsCalls(h.tbo)).toEqual([
      { lang: 'ES', codes: [...demand, ...regular] },
      { lang: 'PT', codes: [...demand, ...regular] },
    ]);
    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'budget' });
    expect(report.e4).toMatchObject({ tasksDue: 10, batchesPlanned: 3, batchesAttempted: 2 });
    for (const id of regular) expect(h.store.content(id, 'en')).toBeUndefined();
  });

  it('E4 va después de E3 con lo que quede del presupuesto; sin presupuesto no llama', async () => {
    const h = harness();
    seedBuenosAires(h.store);
    h.store.seedCity({ code: '900002', countryCode: 'AR', syncedAt: LONG_AGO });
    h.store.demand.set('900001', 2);
    const report = synced(
      await h.run({ stages: new Set(['E3', 'E4']), countries: ['AR'], maxCalls: 2 }),
    );
    expect(report.e3.cities).toBe(2);
    // Los tres hoteles que E3 dejó activos en la ciudad con demanda, por tres idiomas: pendientes.
    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'budget', calls: 2 });
    expect(report.e4).toMatchObject({ status: 'done', tasksDue: 9, batchesAttempted: 0 });
    expect(h.tbo.callsTo('hotelDetails')).toHaveLength(0);
  });

  it('401 en HotelDetails: la cuenta no sirve, se corta con error tipado en E4', async () => {
    const h = harness({
      ...WORLD,
      override: (op) =>
        op === 'hotelDetails' ? tboStatus(401, 'Access Credentials is incorrect') : undefined,
    });
    seedContentCatalog(h.store, { demandHotels: 3 });
    await expect(h.run({ stages: E4_ONLY, countries: ['AR'] })).rejects.toMatchObject({
      code: 'CREDENTIALS_INVALID',
      stage: 'E4',
    });
    expect(h.store.locked).toBe(false);
  });

  it('un contenedor de habitaciones que TBO mande igual sólo se registra por su clave (N10)', async () => {
    const [id = ''] = hotelIds(1);
    const h = harness({
      ...WORLD,
      details: { raw: { [id]: { Rooms: [{ RoomId: 197354, RoomName: 'Deluxe' }] } } },
    });
    seedContentCatalog(h.store, { demandHotels: 1 });
    const report = synced(
      await h.run({ stages: E4_ONLY, countries: ['AR'], content: onlySpanish() }),
    );
    expect(report.e4.unknownKeys).toEqual([expect.stringContaining('Rooms')]);
    expect(logText(h.lines)).not.toContain('Deluxe');
  });

  it('sin E4 en las etapas no se pide contenido', async () => {
    const h = harness();
    seedContentCatalog(h.store, { demandHotels: 3 });
    const report = synced(await h.run({ stages: new Set(['E3']), countries: ['AR'] }));
    expect(report.e4.status).toBe('skipped');
    expect(h.tbo.callsTo('hotelDetails')).toHaveLength(0);
  });
});
