import { randomBytes } from 'node:crypto';
import type { HotelSearchCriteria } from '@sales-travel/canonical';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { PricingService } from '../pricing/pricing.service.js';
import {
  StubHotelProviderFactory,
  stubHotelOffer,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { HotelSearchPagingStore } from './hotel-search-paging.store.js';
import { HotelAvailabilityInputSchema } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * La búsqueda por tramos contra Postgres real, COMO `app_user` (docs/tbo/02 §4.4).
 *
 * Lo que la base de mentira no puede probar es el SQL del catálogo: que el orden por relevancia
 * ponga primero las estrellas, después los hoteles con foto en `hotel_content` y al final el id;
 * que sólo cuente los activos; que `count(*) over ()` dé el total del destino ANTES del `limit`; y
 * que los tramos salgan de los códigos que guardó la búsqueda, aunque el catálogo cambie mientras
 * el vendedor carga más.
 *
 * El proveedor es el stub de los tests (tramos de 2 para que 6 hoteles sean 3 tramos), con ids
 * propios y ciudades propias. Proveedor, ciudad y hoteles son sintéticos y únicos por corrida. Se
 * SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('búsqueda por tramos contra Postgres, como app_user', () => {
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `it-pg-${sfx}`;
  const CIUDAD = `PGC${sfx}`;
  const OTRA_CIUDAD = `PGO${sfx}`;
  const H = (n: number): string => `PG${sfx}H${n}`;
  const TENANT = '11111111-1111-4111-8111-111111111111';

  const admin = new pg.Pool();
  const comoApp = new pg.Pool();
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const database = { db } as unknown as DatabaseService;

  /**
   * H2 y H1 tienen 5 estrellas y H2 foto; H3 y H4 tienen 4, H3 con foto y H4 con la lista vacía;
   * H7 tiene 3; H5 no informa estrellas (va al final aunque tenga foto); H6 está inactivo y H8 es
   * de otra ciudad.
   */
  const ORDEN = [H(2), H(1), H(3), H(4), H(7), H(5)];

  function montar(): { service: HotelsService; pedidos: string[][] } {
    const pedidos: string[][] = [];
    const factory = new StubHotelProviderFactory({
      code: PROVEEDOR,
      searchProfile: { idSpace: 'provider', maxHotelsPerSearch: 2, catalogOrder: 'relevance' },
      searchImpl: (criteria: HotelSearchCriteria) => {
        pedidos.push([...criteria.hotelIds]);
        return Promise.resolve(
          criteria.hotelIds.map((hotelId) => stubHotelOffer(PROVEEDOR, { hotelId })),
        );
      },
    });
    const service = new HotelsService(
      hotelRegistry([factory], hotelFlags(true)),
      database,
      { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
      {
        assertWithinQuota: () => Promise.resolve(),
        instrument: (_meta: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as SearchTelemetryService,
      new CircuitBreakerService(),
      new HotelSearchContextStore(new MemoryCacheAdapter()),
      undefined,
      new HotelSearchPagingStore(new MemoryCacheAdapter()),
    );
    return { service, pedidos };
  }

  const entrada = HotelAvailabilityInputSchema.parse({
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [{ adults: 2, childrenAges: [] }],
    destinationId: `${PROVEEDOR}:${CIUDAD}`,
    guestNationality: 'CO',
  });

  async function conFoto(hotelId: string, images: string): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_content (provider_code, hotel_id, lang, source, content_hash, images)
       VALUES ($1, $2, 'es', 'details', 'x', $3::jsonb)`,
      [PROVEEDOR, hotelId, images],
    );
  }

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await admin.query(
      `INSERT INTO hotel_inventory (provider_code, hotel_id, provider_city_code, name, stars, active)
       VALUES ($1, $3, $9, 'Cinco sin foto', 5, true),
              ($1, $4, $9, 'Cinco con foto', 5, true),
              ($1, $5, $9, 'Cuatro con foto', 4, true),
              ($1, $6, $9, 'Cuatro lista vacía', 4, true),
              ($1, $7, $9, 'Sin estrellas con foto', NULL, true),
              ($1, $8, $9, 'Inactivo', 5, false),
              ($1, $2, $9, 'Tres', 3, true),
              ($1, $11, $10, 'Otra ciudad', 5, true)`,
      [PROVEEDOR, H(7), H(1), H(2), H(3), H(4), H(5), H(6), CIUDAD, OTRA_CIUDAD, H(8)],
    );
    await conFoto(H(2), '["https://img.example/2.jpg"]');
    await conFoto(H(3), '["https://img.example/3.jpg"]');
    await conFoto(H(4), '[]');
    await conFoto(H(5), '["https://img.example/5.jpg"]');
  });

  afterAll(async () => {
    await admin.query('DELETE FROM hotel_content WHERE provider_code = $1', [PROVEEDOR]);
    await admin.query('DELETE FROM hotel_inventory WHERE provider_code = $1', [PROVEEDOR]);
    await db.destroy();
    await admin.end();
    vi.restoreAllMocks();
  });

  it('el catálogo sale por estrellas, después con foto y después por id; sólo activos y con el total antes del límite', async () => {
    const { service } = montar();

    expect(await service.resolveProviderCityHotelIds(PROVEEDOR, [CIUDAD], 3, 'relevance')).toEqual({
      hotelIds: ORDEN.slice(0, 3),
      total: 6,
    });
    expect(await service.resolveProviderCityHotelIds(PROVEEDOR, [CIUDAD], 50, 'relevance')).toEqual(
      { hotelIds: ORDEN, total: 6 },
    );
  });

  it('tres tramos de 2: cada uno pide los que siguen, sin repetir ni saltar, hasta "6 de 6"', async () => {
    const { service, pedidos } = montar();

    const primero = await service.searchAvailability(TENANT, entrada);
    expect(primero.paging).toMatchObject({ page: 0, consulted: 2, total: 6, hasMore: true });
    const sessionId = primero.paging?.sessionId ?? '';
    const segundo = await service.searchMoreAvailability(TENANT, { sessionId, page: 1 });
    const tercero = await service.searchMoreAvailability(TENANT, { sessionId, page: 2 });

    expect(pedidos).toEqual([ORDEN.slice(0, 2), ORDEN.slice(2, 4), ORDEN.slice(4)]);
    expect([primero, segundo, tercero].flatMap((r) => r.hotels.map((h) => h.hotelId))).toEqual(
      ORDEN,
    );
    expect(tercero.paging).toEqual({ page: 2, consulted: 6, total: 6, hasMore: false });
  });

  it('los tramos salen de lo que guardó la búsqueda aunque el catálogo cambie entre uno y otro', async () => {
    const { service, pedidos } = montar();
    const primero = await service.searchAvailability(TENANT, entrada);

    // El sync agrega un cinco estrellas: con `offset`, el tramo 1 lo traería y se saltaría H4.
    await admin.query(
      `INSERT INTO hotel_inventory (provider_code, hotel_id, provider_city_code, name, stars, active)
       VALUES ($1, $2, $3, 'Nuevo cinco', 5, true)`,
      [PROVEEDOR, H(9), CIUDAD],
    );
    try {
      await service.searchMoreAvailability(TENANT, {
        sessionId: primero.paging?.sessionId ?? '',
        page: 1,
      });
      expect(pedidos[1]).toEqual([H(3), H(4)]);

      // Una búsqueda nueva sí ve el catálogo de ahora.
      const nueva = await montar().service.resolveProviderCityHotelIds(
        PROVEEDOR,
        [CIUDAD],
        50,
        'relevance',
      );
      expect(nueva).toEqual({ hotelIds: [H(2), H(1), H(9), H(3), H(4), H(7), H(5)], total: 7 });
    } finally {
      await admin.query('DELETE FROM hotel_inventory WHERE provider_code = $1 AND hotel_id = $2', [
        PROVEEDOR,
        H(9),
      ]);
    }
  });
});
