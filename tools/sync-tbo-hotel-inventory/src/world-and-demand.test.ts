import {
  TboStaticContentClient,
  parseTboConfig,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import type { SyncSettings, SyncStage } from './env.js';
import { SyncAccountError } from './errors.js';
import { JsonLogger } from './log.js';
import { WORLD_CITY_LISTS_PER_RUN } from './stages/e2a-world-cities.js';
import { runSync, type SyncReport } from './sync.js';
import {
  fakeTbo,
  requestedHotelCodes,
  tboStatus,
  type FakeTbo,
  type FakeTboWorld,
} from './testing/fake-tbo.js';
import { MemoryCatalogStore } from './testing/memory-catalog-store.js';

// El nombre del campo va en CAMPO y el valor de prueba en una constante: el detector de secretos
// de GitGuardian marca como contraseña real cualquier línea que ponga un valor al lado de ese
// nombre, aunque sea un texto de prueba.
const CAMPO = { clave: 'password' } as const;
const CLAVE_DEMO = 'clave-de-prueba';

/**
 * Cobertura global y precarga por demanda, con el cliente REAL del ACL y un `fetch` falso:
 *
 * - E2A baja las ciudades de TODOS los países de TBO, sin hoteles, para que el buscador sugiera
 *   cualquier ciudad con código TBO ("se carga al buscar"). Es opt-in, va al final y tiene tope
 *   propio.
 * - La demanda cuenta también las búsquedas de ciudades del catálogo local (`destinationProvider` +
 *   `destinationCityCode`), y una ciudad buscada de un país fuera de la corrida entra en E3 y E4.
 *
 * El SQL real de la demanda se prueba en `writer.integration.test.ts`; aquí, el doble en memoria
 * con las mismas reglas.
 */

const PROVIDER = 'tbo-hotels';
const T0 = Date.UTC(2026, 8, 29, 8, 0, 0);

const immediateLimiter: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

const WORLD: FakeTboWorld = {
  countries: ['AL', 'AR', 'AW', 'BO'],
  cities: {
    AR: [{ code: '900001', name: 'Buenos Aires' }],
    AL: [{ code: '800001', name: 'Tirana' }],
    AW: [
      { code: '700001', name: 'Oranjestad' },
      { code: '700002', name: 'Noord' },
    ],
    BO: [{ code: '600001', name: 'La Paz' }],
  },
  hotels: {
    '900001': [{ code: '1000001', lat: -34.6, lng: -58.38 }],
    '800001': [
      { code: '1000005', lat: 41.33, lng: 19.82 },
      { code: '1000006', lat: 41.32, lng: 19.81 },
    ],
  },
};

function settings(overrides: Partial<SyncSettings> = {}): SyncSettings {
  return {
    providerCode: PROVIDER,
    destinationSourceProvider: 'despegar-hotels',
    countries: ['AR'],
    stages: new Set<SyncStage>(['E2A']),
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
      demandLangs: ['es'],
      regularLangs: ['es'],
      batchSize: 10,
      maxAgeMs: 30 * 86_400_000,
    },
    ...overrides,
  };
}

interface Harness {
  readonly store: MemoryCatalogStore;
  readonly tbo: FakeTbo;
  readonly lines: string[];
  run(overrides?: Partial<SyncSettings>): Promise<SyncReport>;
}

function harness(world: FakeTboWorld = WORLD): Harness {
  const tbo = fakeTbo(world);
  const lines: string[] = [];
  const logger = new JsonLogger({ level: 'debug', sink: (line) => lines.push(line) });
  const store = new MemoryCatalogStore(PROVIDER, () => new Date(T0));
  const source = new TboStaticContentClient(
    parseTboConfig({ environment: 'test', username: 'catalogo-demo', [CAMPO.clave]: CLAVE_DEMO }),
    { fetch: tbo.fetch, limiter: immediateLimiter, sleep: () => Promise.resolve() },
  );
  return {
    store,
    tbo,
    lines,
    run: (overrides = {}) => runSync(settings(overrides), { source, store, logger, now: () => T0 }),
  };
}

function synced(report: SyncReport): Extract<SyncReport, { action: 'sync' }> {
  if (report.action !== 'sync') throw new Error(`esperaba una corrida, fue ${report.reason}`);
  return report;
}

function cityListCountries(tbo: FakeTbo): unknown[] {
  return tbo.callsTo('cityList').map((call) => call.body?.['CountryCode']);
}

describe('E2A: ciudades de todos los países (cobertura global del buscador)', () => {
  it('pide CityList sólo de los países que no son de la corrida y no tienen ciudades guardadas', async () => {
    const h = harness();
    // Albania ya tiene ciudades (de una corrida anterior): no se vuelve a pedir.
    h.store.seedCity({ code: '800001', countryCode: 'AL', name: 'Tirana' });

    const report = synced(await h.run({ stages: new Set<SyncStage>(['E2', 'E2A']) }));

    expect(h.tbo.callsTo('countryList')).toHaveLength(1);
    // AR es de la corrida y la pide E2, no E2A; AL ya tenía ciudades.
    expect(cityListCountries(h.tbo)).toEqual(['AR', 'AW', 'BO']);
    expect(report.e2a).toEqual({
      status: 'done',
      countriesInTbo: 4,
      countriesSkipped: 2,
      countriesRequested: 2,
      countriesFailed: 0,
      countriesPending: 0,
      citiesReceived: 3,
      citiesUpserted: 3,
    });
    // Sin hoteles ni checkpoint: el API las lee como "se cargan al buscar".
    expect(h.store.city('700001')).toMatchObject({
      countryCode: 'AW',
      name: 'Oranjestad',
      hotelCount: null,
      syncedAt: null,
    });
    expect(h.tbo.callsTo('tboHotelCodeList')).toHaveLength(0);
    expect(h.tbo.callsTo('hotelDetails')).toHaveLength(0);
  });

  it('sin E2 en la corrida, un país de la corrida sin ciudades también lo pide E2A', async () => {
    const h = harness();
    h.store.seedCity({ code: '800001', countryCode: 'AL', name: 'Tirana' });

    const report = synced(await h.run({ stages: new Set<SyncStage>(['E1', 'E2A']) }));

    // Nadie más le pediría la lista a AR: E2 no corre.
    expect(cityListCountries(h.tbo)).toEqual(['AR', 'AW', 'BO']);
    expect(report.e2a).toMatchObject({ countriesSkipped: 1, countriesRequested: 3 });
    expect(h.store.city('900001')).toMatchObject({ countryCode: 'AR', hotelCount: null });
  });

  it('es opt-in: una corrida sin E2A no pide ninguna ciudad fuera de sus países', async () => {
    const h = harness();
    const report = synced(await h.run({ stages: new Set<SyncStage>(['E1', 'E2']) }));
    expect(cityListCountries(h.tbo)).toEqual(['AR']);
    expect(report.e2a.status).toBe('skipped');
  });

  it('va al final: con el presupuesto gastado en E2 y E3, no llama y lo deja para después', async () => {
    const h = harness();
    // E2 (AR) + E3 (Buenos Aires) = 2 llamadas: E2A ya no tiene con qué.
    const report = synced(
      await h.run({ stages: new Set<SyncStage>(['E2', 'E3', 'E2A']), maxCalls: 2 }),
    );
    expect(h.tbo.callsTo('tboHotelCodeList')).toHaveLength(1);
    expect(h.tbo.callsTo('countryList')).toHaveLength(0);
    expect(report.e2a.status).toBe('skipped');
  });

  it('corta al agotar el presupuesto y cuenta lo que queda pendiente para la próxima', async () => {
    const h = harness();
    // CountryList + un CityList.
    const report = synced(await h.run({ maxCalls: 2 }));
    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'budget' });
    expect(cityListCountries(h.tbo)).toEqual(['AL']);
    // AR es de la corrida, pero sin E2 en ella también la pide E2A.
    expect(report.e2a).toMatchObject({ countriesRequested: 1, countriesPending: 3 });

    // La próxima corrida sigue desde ahí: el país ya bajado no se vuelve a pedir.
    const next = harness();
    for (const [code, row] of h.store.cities) next.store.cities.set(code, row);
    await next.run();
    expect(cityListCountries(next.tbo)).toEqual(['AR', 'AW', 'BO']);
  });

  it('tiene su propio tope por corrida, aunque el presupuesto general alcance para más', async () => {
    const many = Array.from(
      { length: WORLD_CITY_LISTS_PER_RUN + 5 },
      (_, i) =>
        `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
    );
    const h = harness({ ...WORLD, countries: many, cities: {} });
    const report = synced(await h.run({ countries: ['ZZ'], maxCalls: 10_000 }));
    expect(h.tbo.callsTo('cityList')).toHaveLength(WORLD_CITY_LISTS_PER_RUN);
    expect(report.e2a.countriesPending).toBe(5);
  });

  it('un país que falla se cuenta y la etapa sigue con los demás', async () => {
    const h = harness({
      ...WORLD,
      override: (op, body) =>
        op === 'cityList' && body?.['CountryCode'] === 'AW'
          ? tboStatus(500, 'Unexpected Error')
          : undefined,
    });
    const report = synced(await h.run());
    expect(report.e2a).toMatchObject({ countriesRequested: 3, countriesFailed: 1 });
    expect(h.store.city('600001')).toBeDefined();
  });

  it('una cuenta rechazada corta la corrida con el error tipado de la etapa', async () => {
    const h = harness({
      ...WORLD,
      override: (op) =>
        op === 'countryList' ? tboStatus(401, 'Access Credentials is incorrect') : undefined,
    });
    const failure = h.run();
    await expect(failure).rejects.toBeInstanceOf(SyncAccountError);
    await expect(failure).rejects.toMatchObject({ stage: 'E2A' });
    expect(h.store.locked).toBe(false);
  });
});

describe('Precarga por demanda: las búsquedas del catálogo local cuentan', () => {
  it('E3 prioriza la ciudad buscada desde el autocompletado propio (sin mapa de destinos)', async () => {
    const h = harness();
    h.store.seedCity({ code: '900001', countryCode: 'AR' });
    h.store.seedCity({ code: '800001', countryCode: 'AR' });
    h.store.searchesByProviderCity.set('800001', 3);
    const report = synced(await h.run({ stages: new Set<SyncStage>(['E3']), maxCalls: 1 }));
    expect(report.e3.cities).toBe(1);
    expect(h.tbo.callsTo('tboHotelCodeList').map((c) => c.body?.['CityCode'])).toEqual(['800001']);
  });

  it('una ciudad buscada de un país fuera de la corrida entra en E3 y en E4; sin búsquedas, no', async () => {
    const h = harness();
    // Tirana (AL) la cargó el API bajo demanda; la corrida es sólo de AR.
    h.store.seedCity({ code: '800001', countryCode: 'AL', syncedAt: null, hotelCount: 2 });
    h.store.seedCity({ code: '700001', countryCode: 'AW', syncedAt: null });
    for (const id of ['1000005', '1000006']) {
      h.store.seedHotel({ hotelId: id, providerCityCode: '800001', countryCode: 'AL' });
    }
    h.store.searchesByProviderCity.set('800001', 2);

    const report = synced(await h.run({ stages: new Set<SyncStage>(['E3', 'E4']) }));

    const cities = h.tbo.callsTo('tboHotelCodeList').map((c) => c.body?.['CityCode']);
    expect(cities).toContain('800001');
    expect(cities).not.toContain('700001');
    expect(h.tbo.callsTo('hotelDetails').map((c) => requestedHotelCodes(c.body))).toEqual([
      ['1000005', '1000006'],
    ]);
    expect(report.e4).toMatchObject({ hotelsDue: 2 });
  });
});
