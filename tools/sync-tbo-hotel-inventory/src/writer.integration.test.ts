import { randomBytes, randomUUID } from 'node:crypto';
import {
  TboStaticContentClient,
  parseTboConfig,
  type TboCatalogHotel,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SyncSettings } from './env.js';
import { JsonLogger } from './log.js';
import { trigramSimilarity } from './match-rules.js';
import { runSync } from './sync.js';
import { fakeTbo, type FakeTboWorld } from './testing/fake-tbo.js';
import { PgCatalogStore } from './writer.js';

/**
 * El escritor contra Postgres real, con las tablas de la migración 0041 (08 RF-30 y RF-31).
 *
 * Se SALTA sin `PGHOST`/`PGUSER`/`PGPASSWORD`, como los demás `*.integration.test.ts`; en CI corre
 * contra la base migrada y con el superusuario, que es como corre el sync en el VPS.
 *
 * Los códigos de proveedor son sintéticos y únicos por corrida: el escritor sólo toca filas de su
 * `provider_code`, así que quien corra esto contra su base local no pierde su catálogo real, y los
 * tests de `apps/api` que siembran `tbo-hotels` en paralelo no se cruzan con estos.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const SUFFIX = randomBytes(4).toString('hex');
const TBO = `tbo-it-${SUFFIX}`;
const OTHER = `desp-it-${SUFFIX}`;
// Relativo al reloj del proceso: vencido para la cadencia semanal y anterior a cualquier
// `runStart` de estos tests.
const LONG_AGO = new Date(Date.now() - 30 * 86_400_000);

const immediateLimiter: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

function settings(overrides: Partial<SyncSettings> = {}): SyncSettings {
  return {
    providerCode: TBO,
    destinationSourceProvider: OTHER,
    countries: ['AR', 'AL'],
    stages: new Set(['E1', 'E2', 'E3', 'E5'] as const),
    maxCalls: 100,
    maxDurationMs: 5 * 60_000,
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

interface InventoryRow {
  provider_code: string;
  hotel_id: string;
  city_id: string | null;
  country_code: string | null;
  name: string | null;
  stars: string | null;
  latitude: number | null;
  longitude: number | null;
  provider_city_code: string | null;
  active: boolean;
  last_seen_at: Date | null;
}

interface CityRow {
  provider_city_code: string;
  country_code: string;
  name: string;
  name_norm: string;
  hotel_count: number | null;
  centroid_lat: number | null;
  centroid_lng: number | null;
  synced_at: Date | null;
  last_status_code: number | null;
}

d('PgCatalogStore contra Postgres (0041)', () => {
  let db: pg.Client;

  beforeAll(async () => {
    db = new pg.Client();
    await db.connect();
  });

  afterAll(async () => {
    if (db === undefined) return;
    // Limpieza del TEST (no del escritor, que nunca borra): sólo lo sintético de esta corrida.
    await db.query('DELETE FROM hotel_inventory WHERE provider_code = ANY($1::text[])', [
      [TBO, OTHER],
    ]);
    await db.query('DELETE FROM hotel_provider_city WHERE provider_code = $1', [TBO]);
    await db.query('DELETE FROM hotel_content WHERE provider_code = $1', [TBO]);
    await db.query('DELETE FROM hotel_destination_map WHERE target_provider_code = $1', [TBO]);
    await db.query('DELETE FROM hotel_match WHERE provider_code = ANY($1::text[])', [[TBO, OTHER]]);
    await db.query('DELETE FROM search_logs WHERE provider_code = $1', [OTHER]);
    await db.end();
  });

  async function inventory(provider = TBO): Promise<Map<string, InventoryRow>> {
    const res = await db.query<InventoryRow>(
      `SELECT provider_code, hotel_id, city_id::text AS city_id, country_code, name, stars::text AS stars,
              latitude, longitude, provider_city_code, active, last_seen_at
         FROM hotel_inventory WHERE provider_code = $1`,
      [provider],
    );
    return new Map(res.rows.map((row) => [row.hotel_id, row]));
  }

  async function city(code: string): Promise<CityRow | undefined> {
    const res = await db.query<CityRow>(
      `SELECT provider_city_code, country_code, name, name_norm, hotel_count, centroid_lat,
              centroid_lng, synced_at, last_status_code
         FROM hotel_provider_city WHERE provider_code = $1 AND provider_city_code = $2`,
      [TBO, code],
    );
    return res.rows[0];
  }

  async function seedCity(code: string, country: string, syncedAt: Date | null): Promise<void> {
    await db.query(
      `INSERT INTO hotel_provider_city
         (provider_code, provider_city_code, country_code, name, name_norm, synced_at, hotel_count)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [TBO, code, country, `Ciudad ${code}`, `ciudad ${code}`, syncedAt],
    );
  }

  async function seedHotel(
    provider: string,
    hotelId: string,
    cityCode: string | null,
  ): Promise<void> {
    await db.query(
      `INSERT INTO hotel_inventory
         (provider_code, hotel_id, city_id, name, provider_city_code, active, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [
        provider,
        hotelId,
        provider === OTHER ? 6585 : null,
        `Sembrado ${hotelId}`,
        cityCode,
        cityCode === null ? null : LONG_AGO,
      ],
    );
  }

  function catalogHotel(hotelId: string, extra: Partial<TboCatalogHotel> = {}): TboCatalogHotel {
    return {
      hotelId,
      name: `Hotel ${hotelId}`,
      stars: 4,
      location: { lat: 10, lng: 20 },
      address: null,
      zipcode: null,
      countryCode: 'AR',
      cityCode: null,
      ...extra,
    };
  }

  it('una corrida sobre dos países: upsert, barrido lógico, centroide y la otra fuente intacta', async () => {
    await seedCity('900001', 'AR', LONG_AGO);
    for (const id of ['1000001', '1000002', '1000003', '1000098'])
      await seedHotel(TBO, id, '900001');
    await seedHotel(OTHER, '1000098', null);
    const otherBefore = await inventory(OTHER);
    const countBefore = (await inventory()).size;

    const world: FakeTboWorld = {
      countries: ['AR', 'AL'],
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
        '800001': [{ code: '1000005', lat: 41.33, lng: 19.82, rating: 'FiveStar' }],
      },
      codelist: ['1000001', '1000002', '1000003', '1000004', '1000005', '1000098'],
    };
    const tbo = fakeTbo(world);
    const lines: string[] = [];
    const logger = new JsonLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const source = new TboStaticContentClient(
      parseTboConfig({ environment: 'test', username: 'it-user', password: 'it-password' }),
      { fetch: tbo.fetch, logger, limiter: immediateLimiter, sleep: () => Promise.resolve() },
    );
    const runStartMs = Date.now();

    const report = await runSync(settings(), {
      source,
      store: new PgCatalogStore(db, { providerCode: TBO }),
      logger,
    });

    expect(report).toMatchObject({ action: 'sync', outcome: 'complete' });
    const after = await inventory();
    expect(after.size).toBe(countBefore + 2);
    expect(after.get('1000098')).toMatchObject({ active: false, last_seen_at: LONG_AGO });
    for (const id of ['1000001', '1000002', '1000003', '1000004', '1000005']) {
      const row = after.get(id);
      expect(row?.active).toBe(true);
      expect(row?.last_seen_at?.getTime()).toBeGreaterThanOrEqual(runStartMs - 1_000);
    }
    expect(after.get('1000005')).toMatchObject({
      provider_city_code: '800001',
      country_code: 'AL',
      stars: '5.0',
      city_id: null,
      latitude: 41.33,
      longitude: 19.82,
    });
    expect(await inventory(OTHER)).toEqual(otherBefore);

    const ba = await city('900001');
    expect(ba).toMatchObject({
      country_code: 'AR',
      name: 'Buenos Aires',
      name_norm: 'buenos aires',
      hotel_count: 3,
      last_status_code: 200,
    });
    expect(ba?.centroid_lat).toBeCloseTo(-34.61, 10);
    expect(ba?.centroid_lng).toBeCloseTo(-58.39, 10);
    expect(ba?.synced_at?.getTime()).toBeGreaterThan(LONG_AGO.getTime());
    expect(await city('900002')).toMatchObject({ name_norm: 'cordoba', hotel_count: 1 });
    expect(lines.join('\n')).not.toMatch(/authorization/i);
  });

  it('RF-30 CA 2: una ciudad que pierde más del umbral no se barre ni avanza su checkpoint', async () => {
    await seedCity('IT-DROP', 'AR', LONG_AGO);
    for (const id of ['d1', 'd2', 'd3', 'd4']) await seedHotel(TBO, id, 'IT-DROP');
    const store = new PgCatalogStore(db, { providerCode: TBO });

    const result = await store.writeCityHotels({
      cityCode: 'IT-DROP',
      hotels: [catalogHotel('d1')],
      unreadable: 0,
      runStart: new Date(),
      maxDrop: 0.5,
    });

    expect(result).toMatchObject({
      verdict: 'drop-exceeded',
      deactivated: 0,
      checkpointAdvanced: false,
    });
    const rows = await inventory();
    for (const id of ['d1', 'd2', 'd3', 'd4']) expect(rows.get(id)?.active).toBe(true);
    expect((await city('IT-DROP'))?.synced_at).toEqual(LONG_AGO);
  });

  it('RF-30 CA 1: un fallo a mitad de la ciudad hace ROLLBACK y deja todo como estaba', async () => {
    await seedCity('IT-RB', 'AR', LONG_AGO);
    for (const id of ['r1', 'r2']) await seedHotel(TBO, id, 'IT-RB');
    const before = await inventory();
    const cityBefore = await city('IT-RB');
    // 500 hoteles válidos (el primer lote entra) y uno con un país de 3 letras, que CHAR(2)
    // rechaza en el segundo lote: lo del primero tiene que desaparecer con el ROLLBACK.
    const hotels = [
      ...Array.from({ length: 500 }, (_, i) => catalogHotel(`rb-${i}`)),
      catalogHotel('rb-bad', { countryCode: 'ARG' }),
    ];

    await expect(
      new PgCatalogStore(db, { providerCode: TBO }).writeCityHotels({
        cityCode: 'IT-RB',
        hotels,
        unreadable: 0,
        runStart: new Date(),
        maxDrop: 0.5,
      }),
    ).rejects.toThrow();

    expect(await inventory()).toEqual(before);
    expect(await city('IT-RB')).toEqual(cityBefore);
  });

  it('lock consultivo: una segunda sesión no lo obtiene hasta que la primera lo suelta', async () => {
    const other = new pg.Client();
    await other.connect();
    try {
      const first = new PgCatalogStore(db, { providerCode: TBO });
      const second = new PgCatalogStore(other, { providerCode: TBO });
      expect(await first.tryLock()).toBe(true);
      expect(await second.tryLock()).toBe(false);
      await first.unlock();
      expect(await second.tryLock()).toBe(true);
      await second.unlock();
    } finally {
      await other.end();
    }
  });

  it('demanda: búsquedas recientes de destinos con mapa ACEPTADO, contadas por búsqueda', async () => {
    await seedCity('IT-DEM', 'AL', null);
    await seedCity('IT-AMB', 'AL', null);
    const destination = String(900_000_000 + Math.floor(Math.random() * 1_000_000));
    await db.query(
      `INSERT INTO hotel_destination_map
         (source_provider_code, source_city_id, target_provider_code, target_city_code, method, status)
       VALUES ('despegar-hotels', $1, $2, 'IT-DEM', 'manual', 'accepted'),
              ('despegar-hotels', $1, $2, 'IT-AMB', 'centroid', 'ambiguous')`,
      [destination, TBO],
    );
    // Una búsqueda en fan-out (dos filas, un grupo) y otra anterior a la columna de grupo.
    const group = randomUUID();
    for (const groupId of [group, group, null]) {
      await db.query(
        `INSERT INTO search_logs (vertical, provider_code, duration_ms, outcome, criteria, search_group_id)
         VALUES ('hotels', $1, 10, 'ok', $2::jsonb, $3)`,
        [OTHER, JSON.stringify({ destinationId: Number(destination) }), groupId],
      );
    }

    const candidates = await new PgCatalogStore(db, { providerCode: TBO }).listCityCandidates({
      countries: ['AL'],
      demandSince: new Date(Date.now() - 3_600_000),
    });

    const byCode = new Map(candidates.map((c) => [c.code, c]));
    expect(byCode.get('IT-DEM')?.demand).toBe(2);
    expect(byCode.get('IT-AMB')?.demand).toBe(0);
    expect(byCode.get('IT-DEM')).toMatchObject({ countryCode: 'AL', syncedAt: null });
  });

  it('E4: contenido details por idioma, JSONB y TIME reales, y el hash evita reescribir', async () => {
    // Un país que ningún otro test de este archivo usa: con alcance `all`, E4 toma todos sus hoteles.
    await seedCity('IT-E4', 'PE', null);
    // Alfanuméricos: el builder de HotelDetails rechaza cualquier otro código antes de llamar.
    for (const id of ['e4a', 'e4b']) await seedHotel(TBO, id, 'IT-E4');
    const tbo = fakeTbo({ cities: {}, hotels: {} });
    const logger = new JsonLogger({ level: 'error', sink: () => undefined });
    const source = new TboStaticContentClient(
      parseTboConfig({ environment: 'test', username: 'it-user', password: 'it-password' }),
      { fetch: tbo.fetch, logger, limiter: immediateLimiter, sleep: () => Promise.resolve() },
    );
    const store = new PgCatalogStore(db, { providerCode: TBO });
    const t1 = Date.now();
    const run = (now: number): ReturnType<typeof runSync> =>
      runSync(
        settings({
          stages: new Set(['E4']),
          countries: ['PE'],
          content: { ...settings().content, scope: 'all', regularLangs: ['es'] },
        }),
        { source, store, logger, now: () => now },
      );

    const first = await run(t1);
    expect(first).toMatchObject({ action: 'sync', outcome: 'complete', calls: 1 });
    const read = () =>
      db.query<{
        hotel_id: string;
        lang: string;
        source: string;
        name: string;
        sections_type: string;
        images_type: string;
        first_image: string;
        check_in_time: string;
        content_hash: string;
        fetched_at: Date;
      }>(
        `SELECT hotel_id, lang, source, name, jsonb_typeof(sections) AS sections_type,
                jsonb_typeof(images) AS images_type, images->>0 AS first_image,
                check_in_time::text AS check_in_time, content_hash, fetched_at
           FROM hotel_content WHERE provider_code = $1 AND hotel_id LIKE 'e4_'
          ORDER BY hotel_id, lang`,
        [TBO],
      );
    const written = (await read()).rows;
    expect(written).toHaveLength(2);
    for (const row of written) {
      expect(row).toMatchObject({
        lang: 'es',
        source: 'details',
        sections_type: 'array',
        images_type: 'array',
        check_in_time: '15:00:00',
      });
      expect(row.first_image).toMatch(/^https:\/\//);
      expect(row.fetched_at.getTime()).toBe(t1);
    }

    // Vencido y sin cambios: se pide otra vez, no se reescribe y sólo avanza `fetched_at`.
    const t2 = t1 + 31 * 86_400_000;
    const second = await run(t2);
    expect(second).toMatchObject({ action: 'sync', calls: 1 });
    if (second.action !== 'sync') throw new Error('esperaba una corrida');
    expect(second.e4).toMatchObject({ contentsWritten: 0, contentsUnchanged: 2 });
    const touched = (await read()).rows;
    expect(touched.map((row) => row.content_hash)).toEqual(written.map((row) => row.content_hash));
    for (const row of touched) expect(row.fetched_at.getTime()).toBe(t2);

    // Un listing sobre un details no lo pisa; uno sobre nada entra.
    const [base] = await store
      .listContentCandidates({ countries: ['PE'], demandSince: new Date(t2), onlyDemand: false })
      .then((rows) => rows.filter((row) => row.hotelId === 'e4a'));
    expect(base?.detailsFetchedAt.es?.getTime()).toBe(t2);
    const listing = {
      hotelId: 'e4a',
      lang: 'es' as const,
      source: 'listing' as const,
      name: 'Texto del listado',
      descriptionHtml: null,
      descriptionText: null,
      sections: [],
      facilities: [],
      unavailableFacilities: [],
      attractionsHtml: null,
      images: [],
      phone: null,
      websiteUrl: null,
      checkInTime: null,
      checkOutTime: null,
    };
    const guarded = await store.writeHotelContents({
      contents: [listing, { ...listing, lang: 'en' }],
      fetchedAt: new Date(t2),
    });
    expect(guarded).toMatchObject({ protected: 1, inserted: 1 });
    const after = (await read()).rows.filter((row) => row.hotel_id === 'e4a');
    expect(after.map((row) => [row.lang, row.source])).toEqual([
      ['en', 'listing'],
      ['es', 'details'],
    ]);
  });

  it('E4: candidatos con la demanda del mapa aceptado y sólo el contenido details', async () => {
    await seedCity('IT-C4D', 'CL', null);
    await seedCity('IT-C4R', 'CL', null);
    await seedHotel(TBO, 'c4demand', 'IT-C4D');
    await seedHotel(TBO, 'c4regular', 'IT-C4R');
    const destination = String(800_000_000 + Math.floor(Math.random() * 1_000_000));
    await db.query(
      `INSERT INTO hotel_destination_map
         (source_provider_code, source_city_id, target_provider_code, target_city_code, method, status)
       VALUES ('despegar-hotels', $1, $2, 'IT-C4D', 'manual', 'accepted')`,
      [destination, TBO],
    );
    await db.query(
      `INSERT INTO search_logs (vertical, provider_code, duration_ms, outcome, criteria)
       VALUES ('hotels', $1, 10, 'ok', $2::jsonb)`,
      [OTHER, JSON.stringify({ destinationId: Number(destination) })],
    );
    const fetched = new Date(Date.now() - 86_400_000);
    await db.query(
      `INSERT INTO hotel_content (provider_code, hotel_id, lang, source, content_hash, fetched_at)
       VALUES ($1, 'c4demand', 'pt', 'details', 'h', $2),
              ($1, 'c4demand', 'en', 'listing', 'h', $2)`,
      [TBO, fetched],
    );
    const store = new PgCatalogStore(db, { providerCode: TBO });
    const since = new Date(Date.now() - 3_600_000);

    const all = await store.listContentCandidates({
      countries: ['CL'],
      demandSince: since,
      onlyDemand: false,
    });
    expect(new Map(all.map((c) => [c.hotelId, c]))).toEqual(
      new Map([
        ['c4demand', { hotelId: 'c4demand', demand: 1, detailsFetchedAt: { pt: fetched } }],
        ['c4regular', { hotelId: 'c4regular', demand: 0, detailsFetchedAt: {} }],
      ]),
    );
    const demandOnly = await store.listContentCandidates({
      countries: ['CL'],
      demandSince: since,
      onlyDemand: true,
    });
    expect(demandOnly.map((c) => c.hotelId)).toEqual(['c4demand']);
  });

  it('E5: da de baja lo que ya no está en la lista global, y sólo de este proveedor', async () => {
    await seedHotel(TBO, 'e5-keep', 'IT-E5');
    await seedHotel(TBO, 'e5-gone', 'IT-E5');
    await seedHotel(OTHER, 'e5-gone', null);
    const active = [...(await inventory()).values()]
      .filter((row) => row.active)
      .map((r) => r.hotel_id);
    const listed = active.filter((id) => id !== 'e5-gone');

    const result = await new PgCatalogStore(db, { providerCode: TBO }).deactivateMissing({
      hotelCodes: listed,
      unreadable: 0,
      seenSince: new Date(),
      maxDrop: 0.5,
    });

    expect(result).toMatchObject({ missing: 1, verdict: 'swept', deactivated: 1 });
    expect((await inventory()).get('e5-gone')?.active).toBe(false);
    expect((await inventory()).get('e5-keep')?.active).toBe(true);
    expect((await inventory(OTHER)).get('e5-gone')?.active).toBe(true);
  });

  it('E6: equivalencias y mapa de destinos en SQL real; lo manual intacto y ambiguous sin demanda', async () => {
    // Un país que ningún otro test de este archivo usa: E6 recalcula el país entero.
    const country = 'UY';
    const base = 700_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const [centro, curado, ambiguo] = [base + 1, base + 2, base + 3];
    const MVD = { lat: -34.9058, lng: -56.1913 };
    const CARRASCO = { lat: -34.88, lng: -56.08 };
    const off = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({
      lat: p.lat + dLat,
      lng: p.lng + dLng,
    });

    const tboCity = async (code: string, p: { lat: number; lng: number }, hotels: number) =>
      db.query(
        `INSERT INTO hotel_provider_city
           (provider_code, provider_city_code, country_code, name, name_norm, hotel_count,
            centroid_lat, centroid_lng, synced_at, last_status_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 200)`,
        [
          TBO,
          code,
          country,
          `Ciudad ${code}`,
          `ciudad ${code.toLowerCase()}`,
          hotels,
          p.lat,
          p.lng,
        ],
      );
    const hotel = async (
      provider: string,
      hotelId: string,
      name: string,
      p: { lat: number; lng: number },
      place: { readonly cityId?: number; readonly cityCode?: string },
    ) =>
      db.query(
        `INSERT INTO hotel_inventory
           (provider_code, hotel_id, city_id, name, stars, latitude, longitude, provider_city_code,
            active, last_seen_at)
         VALUES ($1, $2, $3, $4, 4, $5, $6, $7, true, $8)`,
        [
          provider,
          hotelId,
          place.cityId ?? null,
          name,
          p.lat,
          p.lng,
          place.cityCode ?? null,
          place.cityCode === undefined ? null : new Date(),
        ],
      );

    await tboCity('IT-E6-A', MVD, 5);
    await tboCity('IT-E6-B', off(CARRASCO, 0.009), 1);
    await tboCity('IT-E6-C', off(CARRASCO, -0.0135), 1);
    const inA = { cityCode: 'IT-E6-A' };
    await hotel(TBO, 'e6-t1', 'Radisson Victoria Plaza', MVD, inA);
    await hotel(TBO, 'e6-t2', 'Esplendor Cervantes', off(MVD, 0.004, 0.004), inA);
    await hotel(TBO, 'e6-t3', 'Palladium Business Hotel', off(MVD, -0.004, 0.006), inA);
    await hotel(TBO, 'e6-t4', 'Sheraton Montevideo', off(MVD, 0.008, -0.004), inA);
    await hotel(TBO, 'e6-t5', 'Alma Historica', off(MVD, -0.006, -0.006), inA);
    const inCentro = { cityId: centro };
    await hotel(OTHER, 'e6-d1', 'Hotel Radisson Victoria Plaza', off(MVD, 0.0002), inCentro);
    await hotel(OTHER, 'e6-d2', 'Esplendor Cervantes', off(MVD, 0.0042, 0.004), inCentro);
    await hotel(OTHER, 'e6-d3', 'Palladium Business', off(MVD, -0.0038, 0.006), inCentro);
    // Dos candidatos para el Sheraton de TBO, a ~30 m de cada lado: review.
    await hotel(OTHER, 'e6-d4a', 'Sheraton Montevideo Hotel', off(MVD, 0.0083, -0.004), inCentro);
    await hotel(OTHER, 'e6-d4b', 'The Sheraton Montevideo', off(MVD, 0.0077, -0.004), inCentro);
    await hotel(OTHER, 'e6-d5', 'Alma Historica Boutique', off(MVD, -0.0058, -0.006), inCentro);
    await hotel(OTHER, 'e6-d6', 'Casa Curada', off(MVD, 0.01, 0.01), { cityId: curado });
    await hotel(OTHER, 'e6-d7', 'Posada Carrasco', CARRASCO, { cityId: ambiguo });

    const curatedAt = new Date(Date.now() - 86_400_000);
    await db.query(
      `INSERT INTO hotel_match
         (canonical_hotel_id, provider_code, hotel_id, method, score, status, computed_at)
       VALUES ('curado-e6', $1, 'e6-t5', 'manual', NULL, 'accepted', $2)`,
      [TBO, curatedAt],
    );
    await db.query(
      `INSERT INTO hotel_destination_map
         (source_provider_code, source_city_id, target_provider_code, target_city_code, method,
          score, status, computed_at)
       VALUES ($1, $2, $3, 'IT-E6-B', 'manual', NULL, 'accepted', $4),
              ($1, $2, $3, 'IT-E6-A', 'overlap', 0.9, 'accepted', $4)`,
      [OTHER, String(curado), TBO, curatedAt],
    );

    const logger = new JsonLogger({ level: 'error', sink: () => undefined });
    const source = new TboStaticContentClient(
      parseTboConfig({ environment: 'test', username: 'it-user', password: 'it-password' }),
      { fetch: fakeTbo({ cities: {}, hotels: {} }).fetch, logger, limiter: immediateLimiter },
    );
    const store = new PgCatalogStore(db, { providerCode: TBO, destinationSourceProvider: OTHER });
    const run = () =>
      runSync(settings({ countries: [country], stages: new Set(['E6'] as const) }), {
        source,
        store,
        logger,
      });

    const report = await run();
    expect(report).toMatchObject({ action: 'sync', calls: 0 });

    const matches = new Map(
      (
        await db.query<{
          provider_code: string;
          hotel_id: string;
          canonical_hotel_id: string;
          method: string;
          score: number | null;
          status: string;
          computed_at: Date;
        }>(
          `SELECT provider_code, hotel_id, canonical_hotel_id, method, score::float8 AS score,
                  status, computed_at
             FROM hotel_match WHERE provider_code = ANY($1::text[])`,
          [[TBO, OTHER]],
        )
      ).rows.map((row) => [`${row.provider_code === TBO ? 't' : 'd'}:${row.hotel_id}`, row]),
    );
    for (const [t, d] of [
      ['e6-t1', 'e6-d1'],
      ['e6-t2', 'e6-d2'],
      ['e6-t3', 'e6-d3'],
    ]) {
      expect(matches.get(`t:${t}`)).toMatchObject({
        canonical_hotel_id: `${OTHER}:${d}`,
        method: 'heuristic',
        status: 'accepted',
      });
      expect(matches.get(`d:${d}`)).toMatchObject({
        canonical_hotel_id: `${OTHER}:${d}`,
        status: 'accepted',
      });
    }
    for (const key of ['t:e6-t4', 'd:e6-d4a', 'd:e6-d4b', 'd:e6-d5']) {
      expect(matches.get(key)?.status).toBe('review');
    }
    expect(matches.get('t:e6-t5')).toMatchObject({
      canonical_hotel_id: 'curado-e6',
      method: 'manual',
      score: null,
      status: 'accepted',
      computed_at: curatedAt,
    });

    const destinations = new Map(
      (
        await db.query<{
          source_city_id: string;
          target_city_code: string;
          method: string;
          score: number | null;
          status: string;
          computed_at: Date;
        }>(
          `SELECT source_city_id, target_city_code, method, score::float8 AS score, status,
                  computed_at
             FROM hotel_destination_map
            WHERE source_provider_code = $1 AND target_provider_code = $2`,
          [OTHER, TBO],
        )
      ).rows.map((row) => [`${row.source_city_id}>${row.target_city_code}`, row]),
    );
    // Tres equivalencias aceptadas de cinco hoteles de TBO: 3 / 5.
    expect(destinations.get(`${centro}>IT-E6-A`)).toMatchObject({
      method: 'overlap',
      score: 0.6,
      status: 'accepted',
    });
    expect(destinations.get(`${curado}>IT-E6-B`)).toMatchObject({
      method: 'manual',
      status: 'accepted',
      computed_at: curatedAt,
    });
    expect(destinations.get(`${curado}>IT-E6-A`)?.status).toBe('rejected');
    expect(destinations.get(`${ambiguo}>IT-E6-B`)).toMatchObject({
      method: 'centroid',
      status: 'ambiguous',
    });
    expect(destinations.get(`${ambiguo}>IT-E6-C`)?.status).toBe('ambiguous');

    // La demanda (E3 y E4) sólo pasa por el mapa aceptado: la del destino ambiguo no llega.
    for (const [destination, searches] of [
      [centro, 2],
      [ambiguo, 3],
    ] as const) {
      for (let i = 0; i < searches; i += 1) {
        await db.query(
          `INSERT INTO search_logs (vertical, provider_code, duration_ms, outcome, criteria)
           VALUES ('hotels', $1, 10, 'ok', $2::jsonb)`,
          [OTHER, JSON.stringify({ destinationId: destination })],
        );
      }
    }
    const since = new Date(Date.now() - 3_600_000);
    const demand = new Map(
      (await store.listCityCandidates({ countries: [country], demandSince: since })).map((c) => [
        c.code,
        c.demand,
      ]),
    );
    expect(demand).toEqual(
      new Map([
        ['IT-E6-A', 2],
        ['IT-E6-B', 0],
        ['IT-E6-C', 0],
      ]),
    );
    const unmapped = await store.listUnmappedDestinations({ since, limit: 1_000 });
    expect(unmapped).toContainEqual({
      destinationId: String(ambiguo),
      searches: 3,
      pendingReview: true,
    });
    expect(unmapped.map((u) => u.destinationId)).not.toContain(String(centro));

    // Sin cambios, la segunda corrida no reescribe nada.
    const again = await run();
    expect(again).toMatchObject({
      e6: {
        hotelMatch: { status: 'done', written: 0, demoted: 0 },
        destinationMap: { status: 'done', written: 0, demoted: 0 },
      },
    });
  });

  it('E6: la similitud trigram de TypeScript es la similarity() de pg_trgm', async () => {
    for (const [a, b] of [
      ['word', 'two words'],
      ['alvear palace', 'alvear palace residence'],
      ['ibis bogota museo', 'ibis budget bogota museo'],
      ['sheraton montevideo', 'palladium business'],
    ] as const) {
      const res = await db.query<{ s: number }>('SELECT similarity($1, $2)::float8 AS s', [a, b]);
      expect(trigramSimilarity(a, b)).toBeCloseTo(res.rows[0]?.s ?? -1, 5);
    }
  });
});
