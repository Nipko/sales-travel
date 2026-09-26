import {
  TboStaticContentClient,
  parseTboConfig,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import type { SyncSettings, SyncStage } from './env.js';
import { JsonLogger } from './log.js';
import { canonicalHotelId } from './match-rules.js';
import { runSync, type SyncDeps, type SyncReport } from './sync.js';
import {
  fakeTbo,
  requestedHotelCodes,
  type FakeTbo,
  type FakeTboWorld,
} from './testing/fake-tbo.js';
import { MemoryCatalogStore } from './testing/memory-catalog-store.js';

/**
 * E6 dentro de una corrida (docs/tbo/09 PR-3.4): el catálogo que deja E3 con el cliente REAL del
 * ACL y un TBO falso, el de Despegar sembrado, y lo que queda en `hotel_match` y en
 * `hotel_destination_map`. Las reglas finas están en `match-rules.test.ts`; el SQL, en
 * `writer.test.ts` y `writer.integration.test.ts`.
 */

const USERNAME = 'catalogo-e6-demo';
const PASSWORD = 'Pa55-e6-catalogo';
const PROVIDER = 'tbo-hotels';
const DESPEGAR = 'despegar-hotels';
const T0 = Date.UTC(2026, 8, 25, 8, 0, 0);

const immediateLimiter: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

function settings(
  stages: readonly SyncStage[],
  overrides: Partial<SyncSettings> = {},
): SyncSettings {
  return {
    providerCode: PROVIDER,
    destinationSourceProvider: DESPEGAR,
    countries: ['AR'],
    stages: new Set(stages),
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

interface Point {
  readonly lat: number;
  readonly lng: number;
}

/** Plaza San Martín, Buenos Aires; 0,0002° de latitud son ~22 m. */
const RECOLETA: Point = { lat: -34.5883, lng: -58.3898 };
/** Un destino de Despegar entre dos ciudades de TBO, a 1 y a 1,5 km. */
const MARTINEZ: Point = { lat: -34.4905, lng: -58.5063 };
const at = (base: Point, dLat: number, dLng = 0): Point => ({
  lat: base.lat + dLat,
  lng: base.lng + dLng,
});

/**
 * Buenos Aires (900001) con cuatro hoteles, tres de ellos también en Despegar; Córdoba (900002) con
 * uno que Despegar tiene con otro nombre; y dos ciudades vecinas de TBO (900003, 900004) a 1 y
 * 1,5 km de un destino de Despegar sin ningún hotel en común.
 */
const WORLD: FakeTboWorld = {
  countries: ['AR'],
  cities: {
    AR: [
      { code: '900001', name: 'Buenos Aires' },
      { code: '900002', name: 'Córdoba' },
      { code: '900003', name: 'Martínez' },
      { code: '900004', name: 'Acassuso' },
    ],
  },
  hotels: {
    '900001': [
      { code: '1000001', name: 'Alvear Palace Hotel', ...RECOLETA },
      { code: '1000002', name: 'Faena Hotel', ...at(RECOLETA, -0.0243, 0.0273) },
      { code: '1000003', name: 'Palacio Duhau Park Hyatt', ...at(RECOLETA, -0.0006, 0.0024) },
      // A ~115 m del Faena de Despegar, con otro nombre.
      { code: '1000004', name: 'Hotel Madero', ...at(RECOLETA, -0.0244, 0.0261) },
    ],
    '900002': [{ code: '1000005', name: 'Quinto Centenario', lat: -31.4201, lng: -64.1888 }],
    '900003': [{ code: '1000006', name: 'Posada Martinez', ...at(MARTINEZ, 0.009) }],
    '900004': [{ code: '1000007', name: 'Rio Acassuso', ...at(MARTINEZ, -0.0135) }],
  },
};

/** El catálogo de Despegar: `city_id` es el destino de la UI y el espacio de ids del mapa. */
function seedDespegar(store: MemoryCatalogStore): void {
  const hotel = (
    hotelId: string,
    cityId: number,
    name: string,
    p: Point,
    stars: number | null = 3,
  ): void =>
    store.seedHotel({
      providerCode: DESPEGAR,
      hotelId,
      cityId,
      name,
      stars,
      latitude: p.lat,
      longitude: p.lng,
    });
  hotel('D-1', 6585, 'Hotel Alvear Palace', at(RECOLETA, 0.0002));
  hotel('D-2', 6585, 'Faena', at(RECOLETA, -0.0241, 0.0273));
  hotel('D-3', 6585, 'Palacio Duhau - Park Hyatt', at(RECOLETA, -0.0004, 0.0024));
  hotel('D-4', 6585, 'Casa Sur Recoleta', at(RECOLETA, 0.004, -0.006));
  // Córdoba: otro hotel a ~1 km del de TBO. No hay equivalencia; sólo el centroide.
  hotel('D-7', 7777, 'Windsor', { lat: -31.4135, lng: -64.1811 });
  // Entre dos ciudades de TBO parecidas en distancia: ambiguo.
  hotel('D-8', 8888, 'Hostería del Bajo', MARTINEZ);
}

interface Harness {
  readonly store: MemoryCatalogStore;
  readonly tbo: FakeTbo;
  readonly lines: string[];
  run(
    stages: readonly SyncStage[],
    overrides?: Partial<SyncSettings>,
    deps?: Partial<SyncDeps>,
  ): Promise<Extract<SyncReport, { action: 'sync' }>>;
}

function harness(world: FakeTboWorld = WORLD): Harness {
  const tbo = fakeTbo(world);
  const lines: string[] = [];
  const logger = new JsonLogger({ level: 'debug', sink: (line) => lines.push(line) });
  const store = new MemoryCatalogStore(PROVIDER, () => new Date(T0));
  const source = new TboStaticContentClient(
    parseTboConfig({ environment: 'test', username: USERNAME, password: PASSWORD }),
    {
      fetch: tbo.fetch,
      logger: logger.child({ component: 'tbo-http' }),
      limiter: immediateLimiter,
      sleep: () => Promise.resolve(),
    },
    { credentialSource: 'env' },
  );
  return {
    store,
    tbo,
    lines,
    run: async (stages, overrides = {}, deps = {}) => {
      const report = await runSync(settings(stages, overrides), {
        source,
        store,
        logger,
        now: () => T0,
        ...deps,
      });
      if (report.action !== 'sync') throw new Error(`esperaba una corrida, fue ${report.reason}`);
      return report;
    },
  };
}

function logged(lines: readonly string[], msg: string): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === msg);
}

describe('E6 en una corrida: del catálogo de E3 a equivalencias y mapa de destinos', () => {
  it('equivalencias accepted de los dos lados, destino por solapamiento y por centroide, sin llamar a TBO', async () => {
    const h = harness();
    seedDespegar(h.store);

    const report = await h.run(['E1', 'E2', 'E3', 'E6']);

    // E1 + E2 + cuatro ciudades de E3: E6 no agrega ni una llamada.
    expect(report.calls).toBe(6);
    expect(h.tbo.calls).toHaveLength(6);

    const canon = (id: string): string => canonicalHotelId(DESPEGAR, id);
    for (const [tbo, despegar] of [
      ['1000001', 'D-1'],
      ['1000002', 'D-2'],
      ['1000003', 'D-3'],
    ] as const) {
      expect(h.store.match(tbo)).toMatchObject({
        canonicalHotelId: canon(despegar),
        method: 'heuristic',
        status: 'accepted',
      });
      expect(h.store.match(despegar, DESPEGAR)).toMatchObject({
        canonicalHotelId: canon(despegar),
        status: 'accepted',
      });
    }
    // Madero está a ~110 m del Faena de Despegar, pero con otro nombre: sin fila.
    expect(h.store.match('1000004')).toBeUndefined();
    expect(h.store.match('D-4', DESPEGAR)).toBeUndefined();

    // Tres de cuatro hoteles en común: el destino 6585 es la ciudad 900001.
    expect(h.store.destination('6585', '900001')).toMatchObject({
      method: 'overlap',
      status: 'accepted',
      score: 0.75,
    });
    // Córdoba: sin hoteles en común, pero la ciudad de TBO está a ~1 km y no hay otra cerca.
    expect(h.store.destination('7777', '900002')).toMatchObject({
      method: 'centroid',
      status: 'accepted',
    });
    expect(report.e6.hotelMatch).toMatchObject({
      status: 'done',
      acceptedPairs: 3,
      reviewHotels: 0,
      written: 6,
    });
    expect(report.e6.destinationMap).toMatchObject({
      status: 'done',
      acceptedOverlap: 1,
      acceptedCentroid: 1,
      ambiguous: 1,
      incompleteCountries: [],
    });
    expect(
      logged(h.lines, 'tbo.sync.stage')
        .filter((line) => line['stage'] === 'E6')
        .map((line) => line['part']),
    ).toEqual(['hotel_match', 'destination_map']);
    expect(h.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('una segunda corrida sin cambios no reescribe nada', async () => {
    const h = harness();
    seedDespegar(h.store);
    await h.run(['E1', 'E2', 'E3', 'E6']);

    const again = await h.run(['E6']);

    expect(again.e6.hotelMatch).toMatchObject({ written: 0, demoted: 0, unchanged: 6 });
    expect(again.e6.destinationMap).toMatchObject({ written: 0, demoted: 0 });
  });

  it('criterio de PR-3.4: dos candidatos → review, y esas filas no cuentan para el mapa', async () => {
    const h = harness();
    seedDespegar(h.store);
    // Un segundo "Alvear" de Despegar a 40 m: el de TBO ya no tiene un único candidato.
    h.store.seedHotel({
      providerCode: DESPEGAR,
      hotelId: 'D-9',
      cityId: 6585,
      name: 'Alvear Palace Residence',
      stars: 3,
      latitude: RECOLETA.lat - 0.0003,
      longitude: RECOLETA.lng,
    });

    const report = await h.run(['E1', 'E2', 'E3', 'E6']);

    expect(h.store.match('1000001')?.status).toBe('review');
    expect(h.store.match('D-1', DESPEGAR)?.status).toBe('review');
    expect(h.store.match('D-9', DESPEGAR)?.status).toBe('review');
    expect(report.e6.hotelMatch).toMatchObject({ acceptedPairs: 2, reviewHotels: 3 });
    // El solapamiento cuenta sólo las dos equivalencias aceptadas: 2 de 4 (el lado más chico) sigue
    // superando el 20 % y el destino se acepta, pero con score 0,5 y no 0,75.
    expect(h.store.destination('6585', '900001')).toMatchObject({
      method: 'overlap',
      status: 'accepted',
      score: 0.5,
    });
  });

  it('criterio de PR-3.4: una fila manual no se pisa, ni en hotel_match ni en el mapa', async () => {
    const h = harness();
    seedDespegar(h.store);
    const curated = new Date(T0 - 86_400_000);
    h.store.seedMatch({
      canonicalHotelId: 'curado-alvear',
      providerCode: PROVIDER,
      hotelId: '1000001',
      method: 'manual',
      score: null,
      status: 'rejected',
      computedAt: curated,
    });
    h.store.seedDestination({
      sourceCityId: '6585',
      targetCityCode: '900003',
      method: 'manual',
      score: null,
      status: 'accepted',
      computedAt: curated,
    });
    // Una fila automática vieja de ese mismo destino: con la decisión humana, deja de valer.
    h.store.seedDestination({
      sourceCityId: '6585',
      targetCityCode: '900001',
      method: 'overlap',
      score: 0.9,
      status: 'accepted',
    });
    const manualMatch = h.store.match('1000001');
    const manualDestination = h.store.destination('6585', '900003');

    const report = await h.run(['E1', 'E2', 'E3', 'E6']);

    expect(h.store.match('1000001')).toEqual(manualMatch);
    expect(h.store.destination('6585', '900003')).toEqual(manualDestination);
    // Su pareja de Despegar queda para que la mire la misma persona.
    expect(h.store.match('D-1', DESPEGAR)?.status).toBe('review');
    expect(h.store.destination('6585', '900001')?.status).toBe('rejected');
    expect(report.e6.destinationMap.manualOwned).toBe(1);
  });

  it('criterio de PR-3.4: ambiguous no se usa; el mapa aceptado sí da demanda a E4 en la misma corrida', async () => {
    const h = harness();
    seedDespegar(h.store);
    h.store.searchesByDestination.set('6585', 5);
    h.store.searchesByDestination.set('8888', 9);

    const report = await h.run(['E1', 'E2', 'E3', 'E6', 'E4']);

    expect(h.store.destination('8888', '900003')).toMatchObject({
      method: 'centroid',
      status: 'ambiguous',
    });
    expect(h.store.destination('8888', '900004')).toMatchObject({ status: 'ambiguous' });
    // E4 (contenido sólo con demanda) pidió los hoteles del destino aceptado, no los del ambiguo.
    const requested = h.tbo.callsTo('hotelDetails').flatMap((c) => requestedHotelCodes(c.body));
    expect(new Set(requested)).toEqual(new Set(['1000001', '1000002', '1000003', '1000004']));
    expect(report.e4.hotelsDue).toBe(4);
    // El destino más buscado sin mapeo aceptado encabeza la lista de revisión.
    expect(report.e6.destinationMap.unmapped).toEqual([
      { destinationId: '8888', searches: 9, pendingReview: true },
    ]);
    expect(logged(h.lines, 'tbo.sync.unmapped_destinations')).toEqual([
      expect.objectContaining({
        provider: PROVIDER,
        destinations: [{ destinationId: '8888', searches: 9, pendingReview: true }],
      }),
    ]);
  });
});

describe('E6: cuándo corre y cuándo retiene', () => {
  it('corre aunque el presupuesto de llamadas se haya agotado: es sólo SQL', async () => {
    const h = harness();
    seedDespegar(h.store);
    await h.run(['E1', 'E2', 'E3']);

    // Una llamada: E1. E2 ya no sale, y E6 recalcula sobre lo que dejó la corrida anterior.
    const report = await h.run(['E1', 'E2', 'E3', 'E6'], { maxCalls: 1 });

    expect(report).toMatchObject({ outcome: 'partial', stopReason: 'budget' });
    expect(report.e6.hotelMatch).toMatchObject({ status: 'done', acceptedPairs: 3 });
    expect(report.e6.destinationMap.status).toBe('done');
  });

  it('con SIGTERM no empieza: el contenedor se está apagando', async () => {
    const h = harness();
    seedDespegar(h.store);
    const interrupt = new AbortController();
    interrupt.abort();

    const report = await h.run(['E1', 'E2', 'E3', 'E6'], {}, { interrupt: interrupt.signal });

    expect(report.e6.hotelMatch.status).toBe('skipped');
    expect(report.e6.destinationMap.status).toBe('skipped');
    expect(h.store.operations).not.toContain('listHotelMatchScope');
  });

  it('sólo E6: ninguna llamada a TBO', async () => {
    const h = harness();
    seedDespegar(h.store);
    const report = await h.run(['E6']);
    expect(h.tbo.calls).toEqual([]);
    expect(report.calls).toBe(0);
    expect(report.e6.hotelMatch.status).toBe('done');
  });

  it('si el catálogo de Despegar queda vacío, no desarma equivalencias ni mapa: retiene y avisa', async () => {
    const h = harness();
    // 25 hoteles de TBO emparejados en una ciudad, y el mapa de 25 destinos hacia esa ciudad.
    h.store.seedCity({
      code: '900001',
      countryCode: 'AR',
      syncedAt: new Date(T0),
      centroidLat: RECOLETA.lat,
      centroidLng: RECOLETA.lng,
      hotelCount: 25,
    });
    for (let i = 0; i < 25; i += 1) {
      const canonical = canonicalHotelId(DESPEGAR, `DX-${i}`);
      h.store.seedHotel({
        hotelId: `T-${i}`,
        providerCityCode: '900001',
        latitude: RECOLETA.lat,
        longitude: RECOLETA.lng,
      });
      h.store.seedMatch({
        canonicalHotelId: canonical,
        providerCode: PROVIDER,
        hotelId: `T-${i}`,
        method: 'heuristic',
        score: 1,
        status: 'accepted',
      });
      h.store.seedMatch({
        canonicalHotelId: canonical,
        providerCode: DESPEGAR,
        hotelId: `DX-${i}`,
        method: 'heuristic',
        score: 1,
        status: 'accepted',
      });
      h.store.seedDestination({
        sourceCityId: String(10_000 + i),
        targetCityCode: '900001',
        method: 'overlap',
        score: 0.8,
        status: 'accepted',
      });
    }
    // El sync de Despegar borró todo y no insertó nada: ningún hotel suyo en el inventario.
    const report = await h.run(['E6']);

    expect(report.e6.hotelMatch).toMatchObject({ status: 'held', written: 0, demoted: 0 });
    expect(report.e6.destinationMap).toMatchObject({ status: 'held', written: 0, demoted: 0 });
    expect(h.store.match('T-0')?.status).toBe('accepted');
    expect(h.store.destination('10000', '900001')?.status).toBe('accepted');
    expect(logged(h.lines, 'tbo.sync.e6_anomaly').map((line) => line['table'])).toEqual([
      'hotel_match',
      'hotel_destination_map',
    ]);
  });
});
