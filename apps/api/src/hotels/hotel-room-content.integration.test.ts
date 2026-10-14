import { randomBytes } from 'node:crypto';
import type { SearchContext } from '@sales-travel/domain';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelContentFetchOptions,
  HotelContentLanguage,
  HotelProviderRoomContent,
  HotelRoomContentFetch,
} from '../providers/hotel-provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { HotelCatalogStore } from './hotel-catalog.store.js';
import { HOTEL_IMAGE_PROXY_PATH } from './hotel-image-proxy.js';
import { HotelRoomContentService } from './hotel-room-content.service.js';

/**
 * El contenido por habitación contra Postgres real, COMO `app_user` (migración 0070):
 *
 * - la app no escribe `hotel_room_content` ni `hotel_room_content_fetch`: sólo por
 *   `hotel_catalog_store_room_contents`, que valida cada habitación y reemplaza el set del idioma;
 * - el servicio lee lo que guardó y no vuelve a llamar al proveedor mientras está vigente.
 *
 * Proveedor y hoteles sintéticos y únicos por corrida. Nada llama a TBO. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('contenido por habitación contra Postgres, como app_user (0070)', () => {
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `it-rc-${sfx}`;
  const H = (n: number): string => `RC${sfx}H${n}`;
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const HOST = 'img.example';

  const admin = new pg.Pool();
  const comoApp = new pg.Pool();
  comoApp.on('connect', (client) => {
    void client.query('SET ROLE app_user');
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: comoApp }) });
  const store = new HotelCatalogStore({ db } as unknown as DatabaseService);

  function habitacion(n: number, extra: Partial<HotelProviderRoomContent> = {}) {
    return {
      roomKey: String(197_350 + n),
      roomRef: String(197_350 + n),
      nameKey: `deluxe room ${n}`,
      name: `Deluxe Room ${n}`,
      sizeText: '1830 ft',
      description: 'Vista al jardín; cama king',
      images: [`https://${HOST}/r/${n}.jpg`],
      ...extra,
    };
  }

  /** Llama a la función como `app_user` con una habitación cruda, sin pasar por el store. */
  async function guardarCrudo(
    hotelId: string,
    lang: string,
    outcome: string,
    rooms: unknown,
  ): Promise<{ stored: number; rejected: number }> {
    const { rows } = await comoApp.query<{ stored: number; rejected: number }>(
      'SELECT * FROM hotel_catalog_store_room_contents($1, $2, $3, $4, $5::jsonb)',
      [PROVEEDOR, hotelId, lang, outcome, JSON.stringify(rooms)],
    );
    return rows[0] as { stored: number; rejected: number };
  }

  async function codigoDe(promesa: Promise<unknown>): Promise<string> {
    try {
      await promesa;
      return 'ok';
    } catch (err) {
      return String((err as { code?: unknown }).code);
    }
  }

  beforeAll(async () => {
    await admin.query(
      `INSERT INTO hotel_inventory (provider_code, hotel_id, name, active)
       VALUES ($1, $2, 'Uno', true), ($1, $3, 'Dos', true), ($1, $4, 'Tres', true),
              ($1, $5, 'Cuatro', true)`,
      [PROVEEDOR, H(1), H(2), H(3), H(4)],
    );
  });

  afterAll(async () => {
    await admin.query('DELETE FROM hotel_room_content WHERE provider_code = $1', [PROVEEDOR]);
    await admin.query('DELETE FROM hotel_room_content_fetch WHERE provider_code = $1', [PROVEEDOR]);
    await admin.query('DELETE FROM hotel_inventory WHERE provider_code = $1', [PROVEEDOR]);
    // `destroy` cierra también el pool de `app_user`.
    await db.destroy();
    await admin.end();
  });

  it('la app lee las tablas pero no las escribe directamente: 42501', async () => {
    expect(
      await codigoDe(
        comoApp.query(
          `INSERT INTO hotel_room_content (provider_code, hotel_id, room_id, lang) VALUES ($1, $2, 'r1', 'es')`,
          [PROVEEDOR, H(1)],
        ),
      ),
    ).toBe('42501');
    expect(
      await codigoDe(
        comoApp.query(
          `INSERT INTO hotel_room_content_fetch (provider_code, hotel_id, lang, outcome) VALUES ($1, $2, 'es', 'none')`,
          [PROVEEDOR, H(1)],
        ),
      ),
    ).toBe('42501');
    expect(
      await codigoDe(
        comoApp.query('DELETE FROM hotel_room_content_fetch WHERE provider_code = $1', [PROVEEDOR]),
      ),
    ).toBe('42501');
    expect(
      await codigoDe(
        comoApp.query('UPDATE hotel_room_content SET name = $2 WHERE provider_code = $1', [
          PROVEEDOR,
          'x',
        ]),
      ),
    ).toBe('42501');
    expect(await codigoDe(comoApp.query('SELECT count(*) FROM hotel_room_content_fetch'))).toBe(
      'ok',
    );
    // La validación de una habitación no es una puerta: sólo la ejecuta la función.
    expect(await codigoDe(comoApp.query(`SELECT hotel_catalog_room_ok('{}'::jsonb)`))).toBe(
      '42501',
    );
  });

  it('la tabla nueva es catálogo de plataforma: sin RLS ni tenant_id', async () => {
    const { rows } = await admin.query<{ rls: boolean; tenant: boolean }>(
      `SELECT c.relrowsecurity AS rls,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant
         FROM pg_class c WHERE c.relname = 'hotel_room_content_fetch' AND c.relkind = 'r'`,
    );
    expect(rows).toEqual([{ rls: false, tenant: false }]);
  });

  it('guarda el set en el orden del proveedor y lo REEMPLAZA entero en el próximo', async () => {
    const primero = await store.storeRoomContents(PROVEEDOR, H(1), 'es', 'rooms', [
      habitacion(2),
      habitacion(1, { roomRef: null, roomKey: 'n-0123456789abcdef', sizeText: null }),
    ]);
    expect(primero).toEqual({ stored: 2, rejected: 0 });
    expect(await store.roomContents(PROVEEDOR, H(1), ['es'])).toEqual([
      {
        lang: 'es',
        roomKey: '197352',
        roomRef: '197352',
        nameKey: 'deluxe room 2',
        name: 'Deluxe Room 2',
        sizeText: '1830 ft',
        description: 'Vista al jardín; cama king',
        images: [`https://${HOST}/r/2.jpg`],
      },
      {
        lang: 'es',
        roomKey: 'n-0123456789abcdef',
        roomRef: null,
        nameKey: 'deluxe room 1',
        name: 'Deluxe Room 1',
        sizeText: null,
        description: 'Vista al jardín; cama king',
        images: [`https://${HOST}/r/1.jpg`],
      },
    ]);
    const estado = await store.roomContentState(PROVEEDOR, H(1), ['es', 'en']);
    expect(estado.inCatalog).toBe(true);
    expect(estado.fetches.get('es')).toMatchObject({ outcome: 'rooms', roomCount: 2 });
    expect(estado.fetches.get('es')?.fetchedAt).toBeInstanceOf(Date);
    expect(estado.fetches.has('en')).toBe(false);

    await store.storeRoomContents(PROVEEDOR, H(1), 'en', 'rooms', [habitacion(9)]);
    await store.storeRoomContents(PROVEEDOR, H(1), 'es', 'rooms', [habitacion(3)]);
    expect(
      (await store.roomContents(PROVEEDOR, H(1), ['es', 'en'])).map((r) => [r.lang, r.roomKey]),
    ).toEqual([
      ['en', '197359'],
      ['es', '197353'],
    ]);

    // Un `none` deja ese idioma sin habitaciones y no toca el otro.
    await store.storeRoomContents(PROVEEDOR, H(1), 'es', 'none', [habitacion(4)]);
    expect(
      (await store.roomContents(PROVEEDOR, H(1), ['es', 'en'])).map((r) => [r.lang, r.roomKey]),
    ).toEqual([['en', '197359']]);
    expect((await store.roomContentState(PROVEEDOR, H(1), ['es'])).fetches.get('es')).toMatchObject(
      { outcome: 'none', roomCount: 0 },
    );
  });

  it('rechaza cada habitación fuera de contrato y guarda las demás', async () => {
    const res = await guardarCrudo(H(2), 'es', 'rooms', [
      habitacion(1),
      habitacion(2, { roomKey: '0' }),
      habitacion(3, { roomRef: '0' }),
      habitacion(4, { roomKey: 'con espacio' }),
      habitacion(5, { description: '<p>HTML</p>' }),
      habitacion(6, { images: ['http://img.example/plano.jpg'] }),
      { ...habitacion(7), images: 'https://img.example/no-lista.jpg' },
      habitacion(8, { name: '   ', roomRef: null, roomKey: 'n-sinnombre' }),
      habitacion(9, { name: 'x'.repeat(301) }),
      habitacion(10, { sizeText: 'x'.repeat(61) }),
      { ...habitacion(11), name: 11 },
      habitacion(1),
      'no es un objeto',
      // Con el id del proveedor, el nombre puede faltar: las fotos se enlazan por id.
      habitacion(12, { name: '' }),
    ]);

    expect(res).toEqual({ stored: 2, rejected: 12 });
    const filas = await store.roomContents(PROVEEDOR, H(2), ['es']);
    expect(filas.map((f) => [f.roomKey, f.name])).toEqual([
      ['197351', 'Deluxe Room 1'],
      ['197362', null],
    ]);
  });

  it('un emoji partido por el recorte del ACL no tumba el guardado de todo el hotel', async () => {
    const res = await store.storeRoomContents(PROVEEDOR, H(2), 'en', 'rooms', [
      habitacion(1, { description: `Vista al jardín ${'\uD83D'}`, name: `Deluxe ${'\uDE00'}` }),
      habitacion(2),
    ]);

    expect(res).toEqual({ stored: 2, rejected: 0 });
    const filas = await store.roomContents(PROVEEDOR, H(2), ['en']);
    expect(filas.map((f) => [f.name, f.description])).toEqual([
      ['Deluxe', 'Vista al jardín'],
      ['Deluxe Room 2', 'Vista al jardín; cama king'],
    ]);
  });

  it('si llegaron habitaciones y no entró ninguna, queda `unreadable`, no `rooms` con cero', async () => {
    expect(await guardarCrudo(H(3), 'pt', 'rooms', [habitacion(1, { roomKey: '0' })])).toEqual({
      stored: 0,
      rejected: 1,
    });
    expect((await store.roomContentState(PROVEEDOR, H(3), ['pt'])).fetches.get('pt')).toMatchObject(
      { outcome: 'unreadable', roomCount: 0 },
    );
  });

  it('rechaza la llamada entera con datos fuera de contrato, sin citarlos', async () => {
    const llamadas: [string, string, string, unknown][] = [
      ['NOEXISTE', 'es', 'rooms', [habitacion(1)]],
      [H(1), 'fr', 'none', []],
      [H(1), 'es', 'quizas', []],
      [H(1), 'es', 'none', [habitacion(1)]],
      [H(1), 'es', 'rooms', { no: 'lista' }],
      [H(1), 'es', 'rooms', Array.from({ length: 101 }, (_, i) => habitacion(i))],
      ['con espacio', 'es', 'none', []],
    ];
    for (const [hotel, lang, outcome, rooms] of llamadas) {
      let error: { code?: string; message?: string } | undefined;
      try {
        await guardarCrudo(hotel, lang, outcome, rooms);
      } catch (err) {
        error = err as { code?: string; message?: string };
      }
      expect(error?.code, `${hotel} ${lang} ${outcome}`).toBe('22023');
      expect(error?.message).not.toContain(hotel === 'NOEXISTE' ? 'NOEXISTE' : sfx);
    }
  });

  it('dos guardados a la vez del mismo hotel e idioma no chocan', async () => {
    const [a, b] = await Promise.all([
      store.storeRoomContents(PROVEEDOR, H(4), 'en', 'rooms', [habitacion(1), habitacion(2)]),
      store.storeRoomContents(PROVEEDOR, H(4), 'en', 'rooms', [habitacion(2), habitacion(3)]),
    ]);
    expect(a.stored + b.stored).toBe(4);
    expect(await store.roomContents(PROVEEDOR, H(4), ['en'])).toHaveLength(2);
  });

  it('el servicio guarda lo que trae, lo sirve por el proxy y no vuelve a llamar mientras vale', async () => {
    const fetchRooms = vi.fn(
      (
        _hotelId: string,
        lang: HotelContentLanguage,
        _ctx: SearchContext,
        _options: HotelContentFetchOptions,
      ) =>
        Promise.resolve<HotelRoomContentFetch>(
          lang === 'en'
            ? { lang, outcome: 'rooms', rooms: [habitacion(1), habitacion(2)] }
            : { lang, outcome: 'none', rooms: [] },
        ),
    );
    const factory = new StubHotelProviderFactory({
      code: PROVEEDOR,
      callPolicy: 'opt-in',
      searchProfile: { idSpace: 'provider', contentFromCatalog: true, imageHosts: [HOST] },
    });
    const adapter = factory.adapterFor(TENANT);
    Object.assign(adapter, { fetchHotelRoomContent: fetchRooms });
    vi.spyOn(factory, 'adapterFor').mockReturnValue(adapter);
    const service = new HotelRoomContentService(
      hotelRegistry([factory], hotelFlags(true)),
      store,
      new CircuitBreakerService(),
      new MemoryCacheAdapter(),
      'on',
    );
    await admin.query(
      `INSERT INTO hotel_inventory (provider_code, hotel_id, name, active) VALUES ($1, $2, 'Cinco', true)`,
      [PROVEEDOR, H(5)],
    );

    const primera = await service.getRoomContent(TENANT, {
      providerCode: PROVEEDOR,
      hotelId: H(5),
      lang: 'es',
    });
    const segunda = await service.getRoomContent(TENANT, {
      providerCode: PROVEEDOR,
      hotelId: H(5),
      lang: 'es',
    });

    expect(fetchRooms.mock.calls.map((c) => c[1])).toEqual(['es', 'en']);
    expect(primera).toEqual(segunda);
    expect(primera).toMatchObject({ status: 'ready', lang: 'en', langFallback: true });
    expect(primera.rooms.map((r) => [r.roomKey, r.sizeM2])).toEqual([
      ['197351', 170],
      ['197352', 170],
    ]);
    expect(primera.rooms[0]?.images).toEqual([
      `${HOTEL_IMAGE_PROXY_PATH}${Buffer.from(`https://${HOST}/r/1.jpg`, 'utf8').toString('base64url')}`,
    ]);
  });
});
