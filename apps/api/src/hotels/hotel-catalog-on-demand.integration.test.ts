import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TBO_IMAGE_HOST_SUFFIXES,
  TboStaticContentClient,
  parseTboConfig,
  tboHotelContentHash,
  type TboFetch,
  type TboHotelContent,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  TboHotelProviderAdapter,
  type TboHotelsAcl,
} from '../providers-tbo/tbo-hotel-provider.adapter.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelContentBatch,
  HotelContentLanguage,
  HotelContentRecord,
} from '../providers/hotel-provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { HotelCatalogStore } from './hotel-catalog.store.js';
import { HotelContentService } from './hotel-content.service.js';
import { HOTEL_IMAGE_PROXY_PATH } from './hotel-image-proxy.js';

/**
 * El catálogo bajo demanda contra Postgres real, COMO `app_user` (migración 0054):
 *
 * - la app sigue sin `INSERT`/`UPDATE` sobre las tablas del catálogo, y escribe SÓLO por
 *   `hotel_catalog_store_contents` y `hotel_catalog_import_city`, que validan cada campo y aplican
 *   las reglas del sync (huella, `listing` nunca sobre `details`, nunca desactivar);
 * - las fotos de un hotel salen de su contenido o del de un hotel equivalente (`hotel_match`
 *   aceptado), y el contenido por lote de los resultados guarda lo que trae y lo devuelve.
 *
 * Proveedores, ciudades y hoteles sintéticos y únicos por corrida. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('catálogo bajo demanda contra Postgres, como app_user (0054)', () => {
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `it-od-${sfx}`;
  const OTRO = `it-od2-${sfx}`;
  const CIUDAD = `ODC${sfx}`;
  const CIUDAD_VACIA = `ODV${sfx}`;
  const H = (n: number): string => `OD${sfx}H${n}`;
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const HOST = 'img.example';

  const admin = new pg.Pool();
  const comoApp = new pg.Pool();
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const database = { db } as unknown as DatabaseService;
  const store = new HotelCatalogStore(database);

  function contenido(hotelId: string, extra: Partial<TboHotelContent> = {}): HotelContentRecord {
    const base: TboHotelContent = {
      hotelId,
      lang: 'es',
      source: 'details',
      name: `Hotel ${hotelId}`,
      descriptionHtml: '<p>Cerca del centro &amp; del mar</p>',
      descriptionText: 'Cerca del centro & del mar',
      sections: [{ label: 'HeadLine', text: 'Cerca' }],
      facilities: ['Piscina'],
      unavailableFacilities: [],
      attractionsHtml: null,
      images: [`https://${HOST}/${hotelId}/1.jpg`, `https://${HOST}/${hotelId}/2.jpg`],
      phone: null,
      websiteUrl: null,
      checkInTime: '15:00',
      checkOutTime: '12:00',
      ...extra,
    };
    const { descriptionText: _t, unavailableFacilities: _u, ...columnas } = base;
    return { ...columnas, contentHash: tboHotelContentHash(base) };
  }

  beforeAll(async () => {
    await admin.query(
      `INSERT INTO hotel_provider_city (provider_code, provider_city_code, country_code, name, name_norm)
       VALUES ($1, $2, 'AW', 'Oranjestad', 'oranjestad'), ($1, $3, 'AW', 'Noord', 'noord')`,
      [PROVEEDOR, CIUDAD, CIUDAD_VACIA],
    );
    await admin.query(
      `INSERT INTO hotel_inventory (provider_code, hotel_id, name, active, provider_city_code)
       VALUES ($1, $2, 'Cargado', true, NULL), ($1, $3, 'Sin foto', true, NULL),
              ($4, $5, 'Del otro', true, NULL)`,
      [PROVEEDOR, H(10), H(11), OTRO, H(20)],
    );
  });

  afterAll(async () => {
    await admin.query('DELETE FROM hotel_content WHERE provider_code = ANY($1::text[])', [
      [PROVEEDOR, OTRO],
    ]);
    await admin.query('DELETE FROM hotel_match WHERE provider_code = ANY($1::text[])', [
      [PROVEEDOR, OTRO],
    ]);
    await admin.query('DELETE FROM hotel_inventory WHERE provider_code = ANY($1::text[])', [
      [PROVEEDOR, OTRO],
    ]);
    await admin.query('DELETE FROM hotel_provider_city WHERE provider_code = $1', [PROVEEDOR]);
    await db.destroy();
    await admin.end();
  });

  it('la app no escribe las tablas del catálogo directamente: 42501', async () => {
    await expect(
      comoApp.query(
        `INSERT INTO hotel_content (provider_code, hotel_id, lang, source, content_hash)
         VALUES ($1, $2, 'es', 'details', 'x')`,
        [PROVEEDOR, H(10)],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      comoApp.query(`UPDATE hotel_inventory SET active = false WHERE provider_code = $1`, [
        PROVEEDOR,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('una ciudad nunca cargada: se carga UNA vez, con conteo y centroide como E3', async () => {
    expect(await store.city(PROVEEDOR, CIUDAD)).toEqual({ countryCode: 'AW', neverLoaded: true });

    const hoteles = [
      {
        hotelId: H(1),
        name: 'Uno',
        stars: 4,
        location: { lat: 12.5, lng: -70 },
        address: 'Calle 1',
        zipcode: null,
        countryCode: 'AW',
      },
      {
        hotelId: H(2),
        name: 'Dos',
        stars: 3.5,
        location: { lat: 12.6, lng: -70.1 },
        address: null,
        zipcode: null,
        countryCode: null,
      },
      {
        hotelId: H(3),
        name: 'Tres',
        stars: null,
        location: null,
        address: null,
        zipcode: null,
        countryCode: 'AW',
      },
    ];
    expect(await store.importCity(PROVEEDOR, CIUDAD, hoteles)).toEqual({
      outcome: 'loaded',
      activeHotels: 3,
    });
    // Otra petición que llega tarde no la vuelve a cargar.
    expect(await store.importCity(PROVEEDOR, CIUDAD, hoteles)).toEqual({
      outcome: 'already-loaded',
      activeHotels: 3,
    });

    const { rows } = await admin.query<{ hotel_count: number; lat: number; lng: number }>(
      `SELECT hotel_count, centroid_lat AS lat, centroid_lng AS lng FROM hotel_provider_city
        WHERE provider_code = $1 AND provider_city_code = $2`,
      [PROVEEDOR, CIUDAD],
    );
    expect(rows[0]?.hotel_count).toBe(3);
    expect(rows[0]?.lat).toBeCloseTo(12.55, 5);
    expect(rows[0]?.lng).toBeCloseTo(-70.05, 5);
    const { rows: inv } = await admin.query<{
      hotel_id: string;
      country_code: string;
      stars: string | null;
    }>(
      `SELECT hotel_id, country_code, stars::text AS stars FROM hotel_inventory
        WHERE provider_code = $1 AND provider_city_code = $2 ORDER BY hotel_id`,
      [PROVEEDOR, CIUDAD],
    );
    // Sin país en el hotel, el de la ciudad.
    expect(inv.map((r) => [r.hotel_id, r.country_code, r.stars])).toEqual([
      [H(1), 'AW', '4.0'],
      [H(2), 'AW', '3.5'],
      [H(3), 'AW', null],
    ]);
    expect(await store.city(PROVEEDOR, CIUDAD)).toEqual({ countryCode: 'AW', neverLoaded: false });
  });

  it('una ciudad que TBO da vacía queda marcada, y una desconocida no se crea', async () => {
    expect(await store.importCity(PROVEEDOR, CIUDAD_VACIA, [])).toEqual({
      outcome: 'empty',
      activeHotels: 0,
    });
    expect(await store.city(PROVEEDOR, CIUDAD_VACIA)).toEqual({
      countryCode: 'AW',
      neverLoaded: false,
    });
    expect(await store.importCity(PROVEEDOR, `NO${sfx}`, [])).toEqual({
      outcome: 'unknown-city',
      activeHotels: 0,
    });
    expect(await store.city(PROVEEDOR, `NO${sfx}`)).toBeUndefined();
  });

  it('el contenido: insert, touch con la misma huella, protected, rewrite, y lo inválido rechazado', async () => {
    const fila = contenido(H(10));
    expect(await store.storeContents(PROVEEDOR, [fila])).toMatchObject({
      inserted: 1,
      rejected: 0,
    });
    expect(await store.storeContents(PROVEEDOR, [fila])).toMatchObject({ touched: 1 });
    expect(
      await store.storeContents(PROVEEDOR, [{ ...contenido(H(10)), source: 'listing' }]),
    ).toMatchObject({ protected: 1 });
    expect(
      await store.storeContents(PROVEEDOR, [contenido(H(10), { name: 'Otro nombre' })]),
    ).toMatchObject({ rewritten: 1 });

    const rechazadas = await store.storeContents(PROVEEDOR, [
      // HTML fuera de la lista blanca del saneador.
      { ...contenido(H(11)), descriptionHtml: '<p onclick="x()">hola</p>' },
      // Imágenes que no son https.
      { ...contenido(H(11)), images: ['http://img.example/1.jpg'] },
      // Un hotel que no está en el catálogo de ese proveedor.
      contenido(`OD${sfx}FANTASMA`),
    ]);
    expect(rechazadas).toMatchObject({ inserted: 0, rejected: 3 });

    // Un campo que no es lista (o una sección sin etiqueta) rechaza ESA fila, no la llamada: la
    // fila buena del mismo lote se procesa igual.
    const fueraDeForma = (extra: Record<string, unknown>): HotelContentRecord =>
      Object.assign({}, contenido(H(11)), extra);
    const mezcla = await store.storeContents(PROVEEDOR, [
      contenido(H(10), { name: 'Otro nombre' }),
      fueraDeForma({ images: 'https://img.example/1.jpg' }),
      fueraDeForma({ sections: { label: 'HeadLine', text: 'Cerca' } }),
      fueraDeForma({ sections: [{ text: 'sin etiqueta' }] }),
      fueraDeForma({ facilities: 'Piscina' }),
    ]);
    expect(mezcla).toMatchObject({ touched: 1, rejected: 4 });

    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM hotel_content WHERE provider_code = $1 AND hotel_id = $2`,
      [PROVEEDOR, H(11)],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('fotos candidatas: las propias primero y, si no hay, las del hotel equivalente', async () => {
    // H(11) no tiene fotos; su equivalente del otro proveedor (H(20)) sí.
    await admin.query(
      `INSERT INTO hotel_match (canonical_hotel_id, provider_code, hotel_id, method, status)
       VALUES ($1, $2, $3, 'manual', 'accepted'), ($1, $4, $5, 'manual', 'accepted')`,
      [`canon-${sfx}`, PROVEEDOR, H(11), OTRO, H(20)],
    );
    await store.storeContents(OTRO, [contenido(H(20))]);

    const filas = await store.imageCandidates(
      [
        { providerCode: PROVEEDOR, hotelId: H(10) },
        { providerCode: PROVEEDOR, hotelId: H(11) },
      ],
      'es',
    );

    expect(filas.map((f) => [f.wantHotel, f.providerCode, f.imageCount])).toEqual([
      [H(10), PROVEEDOR, 2],
      [H(11), OTRO, 2],
    ]);
    expect(filas[0]?.firstImages[0]).toBe(`https://${HOST}/${H(10)}/1.jpg`);

    const estado = await store.contentState([
      { providerCode: PROVEEDOR, hotelId: H(10) },
      { providerCode: PROVEEDOR, hotelId: H(11) },
      { providerCode: PROVEEDOR, hotelId: `OD${sfx}FANTASMA` },
    ]);
    expect([...estado.values()]).toEqual([
      { inCatalog: true, hasDetails: true },
      { inCatalog: true, hasDetails: false },
      { inCatalog: false, hasDetails: false },
    ]);
  });

  it('el contenido por lote: trae lo que falta, lo guarda como app_user y lo devuelve', async () => {
    const factory = new StubHotelProviderFactory({
      code: PROVEEDOR,
      callPolicy: 'opt-in',
      searchProfile: { idSpace: 'provider', contentFromCatalog: true, imageHosts: [HOST] },
    });
    const adapter = factory.adapterFor(TENANT);
    const fetchHotelContents = vi.fn(
      (ids: readonly string[], lang: HotelContentLanguage): Promise<HotelContentBatch> =>
        Promise.resolve({
          contents: ids.map((id) => ({ ...contenido(id), lang })),
          missingHotelIds: [],
        }),
    );
    Object.assign(adapter, { fetchHotelContents, contentBatchSize: 10 });
    vi.spyOn(factory, 'adapterFor').mockReturnValue(adapter);
    const service = new HotelContentService(
      hotelRegistry([factory], hotelFlags(true)),
      database,
      new CircuitBreakerService(),
      new MemoryCacheAdapter(),
    );
    // H(1) es de la ciudad recién cargada: está en el catálogo y sin contenido.
    const res = await service.getContentBatch(TENANT, {
      lang: 'es',
      hotels: [{ providerCode: PROVEEDOR, hotelId: H(1) }],
    });

    expect(fetchHotelContents).toHaveBeenCalledTimes(1);
    expect(res.items[0]).toEqual({
      providerCode: PROVEEDOR,
      hotelId: H(1),
      status: 'ready',
      mainImage: {
        url: `${HOTEL_IMAGE_PROXY_PATH}${Buffer.from(`https://${HOST}/${H(1)}/1.jpg`).toString('base64url')}`,
      },
      imageCount: 2,
    });
    const { rows } = await admin.query<{ source: string; content_hash: string }>(
      `SELECT source, content_hash FROM hotel_content WHERE provider_code = $1 AND hotel_id = $2`,
      [PROVEEDOR, H(1)],
    );
    expect(rows).toEqual([{ source: 'details', content_hash: contenido(H(1)).contentHash }]);

    // La próxima pantalla lo lee del catálogo, sin llamar al proveedor.
    await service.getContentBatch(TENANT, {
      lang: 'es',
      hotels: [{ providerCode: PROVEEDOR, hotelId: H(1) }],
    });
    expect(fetchHotelContents).toHaveBeenCalledTimes(1);
  });

  it('TBO en ES "No Hotels Found" (2026-09-30): el inglés se guarda como `en` y da la foto', async () => {
    // El ejemplo de HotelDetails de p. 59 del ACL, con el código pedido.
    const p59 = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          'providers',
          'tbo-hotels',
          'src',
          '__fixtures__',
          'pdf',
          'hotel-details.p59.json',
        ),
        'utf8',
      ),
    ) as { Status: unknown; HotelDetails: Record<string, unknown>[] };
    const plantilla = p59.HotelDetails[0] ?? {};
    const CON_INGLES = H(30);
    const SIN_NADA = H(31);
    await admin.query(
      `INSERT INTO hotel_inventory (provider_code, hotel_id, name, active, provider_city_code)
       VALUES ($1, $2, 'Solo inglés', true, NULL), ($1, $3, 'Sin contenido', true, NULL)`,
      [PROVEEDOR, CON_INGLES, SIN_NADA],
    );
    const noHotelsFound = (): Response =>
      new Response(JSON.stringify({ Status: { Code: 500, Description: 'No Hotels Found' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    // TBO según lo observado: nada en español; en inglés, sólo el hotel que tiene contenido.
    const fetch = vi.fn<TboFetch>((_url, init) => {
      const body = JSON.parse(init.body as string) as { Hotelcodes: string; Language: string };
      const codes = body.Hotelcodes.split(',').filter((code) => code === CON_INGLES);
      if (body.Language !== 'EN' || codes.length === 0) return Promise.resolve(noHotelsFound());
      return Promise.resolve(
        new Response(
          JSON.stringify({
            Status: p59.Status,
            HotelDetails: codes.map((code) => ({ ...plantilla, HotelCode: code })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const inmediato: TboRateLimiter = {
      acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
      reportThrottled: () => undefined,
    };
    const tbo = new TboHotelProviderAdapter(
      {} as TboHotelsAcl,
      { accountId: 'acc-it', updatedAt: '2026-09-01T00:00:00.000Z' },
      'test',
      new TboStaticContentClient(
        parseTboConfig({ environment: 'test', username: 'it-demo', password: 'it-no-es-clave' }),
        { fetch, limiter: inmediato },
      ),
    );
    // El proveedor sintético de la corrida, con el lote real del adapter de TBO detrás.
    const factory = new StubHotelProviderFactory({
      code: PROVEEDOR,
      callPolicy: 'opt-in',
      searchProfile: {
        idSpace: 'provider',
        contentFromCatalog: true,
        imageHosts: [...TBO_IMAGE_HOST_SUFFIXES],
      },
    });
    const adapter = factory.adapterFor(TENANT);
    Object.assign(adapter, {
      fetchHotelContents: tbo.fetchHotelContents.bind(tbo),
      contentBatchSize: tbo.contentBatchSize,
    });
    vi.spyOn(factory, 'adapterFor').mockReturnValue(adapter);
    const service = new HotelContentService(
      hotelRegistry([factory], hotelFlags(true)),
      database,
      new CircuitBreakerService(),
      new MemoryCacheAdapter(),
    );
    const pedido = {
      lang: 'es' as const,
      hotels: [
        { providerCode: PROVEEDOR, hotelId: CON_INGLES },
        { providerCode: PROVEEDOR, hotelId: SIN_NADA },
      ],
    };

    const res = await service.getContentBatch(TENANT, pedido);

    expect(res.items.map((i) => [i.hotelId, i.status])).toEqual([
      [CON_INGLES, 'ready'],
      [SIN_NADA, 'none'],
    ]);
    expect(res.items[0]?.mainImage?.url.startsWith(HOTEL_IMAGE_PROXY_PATH)).toBe(true);
    // Guardado por la función de 0054 COMO app_user, en inglés y de detalle; del otro, nada.
    const { rows } = await admin.query<{ hotel_id: string; lang: string; source: string }>(
      `SELECT hotel_id, lang, source FROM hotel_content
        WHERE provider_code = $1 AND hotel_id = ANY($2::text[]) ORDER BY hotel_id, lang`,
      [PROVEEDOR, [CON_INGLES, SIN_NADA]],
    );
    expect(rows).toEqual([{ hotel_id: CON_INGLES, lang: 'en', source: 'details' }]);
    const llamadas = fetch.mock.calls.length;

    // La próxima pantalla no vuelve a TBO: uno tiene detalle, el otro está confirmado sin contenido.
    const otra = await service.getContentBatch(TENANT, pedido);
    expect(otra.items.map((i) => i.status)).toEqual(['ready', 'none']);
    expect(fetch.mock.calls.length).toBe(llamadas);

    // La ficha en español sirve el inglés guardado y lo marca.
    const ficha = await service.getContent(TENANT, {
      providerCode: PROVEEDOR,
      hotelId: CON_INGLES,
      lang: 'es',
    });
    expect(ficha).toMatchObject({
      requestedLang: 'es',
      lang: 'en',
      langFallback: true,
      origin: 'catalog',
    });
    expect(ficha.images.length).toBeGreaterThan(0);
  });
});
