import { describe, expect, it } from 'vitest';
import type { HotelProviderRoomContent } from '../providers/hotel-provider.types.js';
import { fakeHotelsDb, type HabitacionesBajoDemanda } from './__fixtures__/fake-hotels-db.js';
import { HOTEL_ROOM_CONTENT_MAX_ROOMS, HotelCatalogStore } from './hotel-catalog.store.js';

/**
 * Las tres consultas del contenido por habitación de `HotelCatalogStore` (0070), con el compilador
 * REAL de Postgres: el SQL y sus parámetros son los que recibiría la base, y lo que vuelve se lee
 * con la misma desconfianza que el resto del catálogo. Contra Postgres de verdad, como `app_user`,
 * lo prueba `hotel-room-content.integration.test.ts`.
 */

const PROVEEDOR = 'tbo-hotels';
const HOTEL = '1000000';

function tienda(habitaciones: HabitacionesBajoDemanda = {}) {
  const db = fakeHotelsDb({ catalogoBajoDemanda: { habitaciones } });
  return { db, store: new HotelCatalogStore(db.service) };
}

function habitacion(n: number): HotelProviderRoomContent {
  return {
    roomKey: String(197_350 + n),
    roomRef: String(197_350 + n),
    nameKey: `deluxe ${n}`,
    name: `Deluxe ${n}`,
    sizeText: '30 m2',
    description: 'Vista al mar',
    images: [`https://img.example/${n}.jpg`],
  };
}

describe('roomContentState: catálogo y lo que respondió el proveedor, por idioma', () => {
  it('una consulta marcada con proveedor, hotel e idiomas como parámetros', async () => {
    const { db, store } = tienda();

    await store.roomContentState(PROVEEDOR, HOTEL, ['es', 'en']);

    const [q] = db.consultasMarcadas('room-content-state');
    expect(q?.sql).toContain('hotel_room_content_fetch');
    expect(q?.sql).toContain('LEFT JOIN');
    expect(q?.parameters).toEqual([PROVEEDOR, HOTEL, ['es', 'en'], PROVEEDOR, HOTEL]);
  });

  it('lee cada idioma pedido; lo que no se pidió nunca no figura', async () => {
    const cuando = new Date('2026-10-01T12:00:00Z');
    const { store } = tienda({
      estado: [
        { lang: 'es', in_catalog: true, outcome: 'rooms', room_count: '3', fetched_at: cuando },
        {
          lang: 'en',
          in_catalog: true,
          outcome: 'none',
          room_count: 0,
          fetched_at: '2026-09-30T08:00:00Z',
        },
        { lang: 'pt', in_catalog: true, outcome: null, room_count: null, fetched_at: null },
      ],
    });

    const state = await store.roomContentState(PROVEEDOR, HOTEL, ['es', 'en', 'pt']);

    expect(state.inCatalog).toBe(true);
    expect([...state.fetches.entries()]).toEqual([
      ['es', { outcome: 'rooms', roomCount: 3, fetchedAt: cuando }],
      ['en', { outcome: 'none', roomCount: 0, fetchedAt: new Date('2026-09-30T08:00:00Z') }],
    ]);
  });

  it('desconfía de lo que vuelve: resultado, idioma o fecha raros no cuentan como pedidos', async () => {
    const { store } = tienda({
      estado: [
        { lang: 'es', in_catalog: false, outcome: 'quizas', room_count: 1, fetched_at: new Date() },
        { lang: 'fr', in_catalog: false, outcome: 'rooms', room_count: 1, fetched_at: new Date() },
        { lang: 'en', in_catalog: false, outcome: 'rooms', room_count: 1, fetched_at: 'ayer' },
        { lang: 'pt', in_catalog: false, outcome: 'rooms', room_count: 1, fetched_at: null },
      ],
    });

    const state = await store.roomContentState(PROVEEDOR, HOTEL, ['es', 'en', 'pt']);

    expect(state).toEqual({ inCatalog: false, fetches: new Map() });
  });

  it('sin filas, el hotel no está en el catálogo', async () => {
    const { store } = tienda();
    expect((await store.roomContentState(PROVEEDOR, HOTEL, ['en'])).inCatalog).toBe(false);
  });
});

describe('roomContents: las habitaciones guardadas, en el orden del proveedor', () => {
  it('una consulta marcada, ordenada por idioma y posición', async () => {
    const { db, store } = tienda();

    await store.roomContents(PROVEEDOR, HOTEL, ['es', 'en']);

    const [q] = db.consultasMarcadas('room-contents');
    expect(q?.sql).toMatch(/ORDER BY c\.lang, c\.position, c\.room_id/);
    expect(q?.parameters).toEqual([PROVEEDOR, HOTEL, ['es', 'en']]);
  });

  it('con los nombres del contrato; un texto que no es texto sale `null` y una fila rara no sale', async () => {
    const { store } = tienda({
      filas: [
        {
          lang: 'es',
          room_id: '197354',
          room_ref: '197354',
          name_key: 'deluxe',
          name: 'Deluxe',
          size_text: '1830 ft',
          description: 'Vista',
          images: ['https://img.example/1.jpg'],
        },
        {
          lang: 'en',
          room_id: 'n-0123456789abcdef',
          room_ref: null,
          name_key: 5,
          name: null,
          size_text: null,
          description: { html: true },
          images: null,
        },
        { lang: 'fr', room_id: 'x', images: [] },
        { lang: 'es', room_id: 42, images: [] },
      ],
    });

    expect(await store.roomContents(PROVEEDOR, HOTEL, ['es', 'en'])).toEqual([
      {
        lang: 'es',
        roomKey: '197354',
        roomRef: '197354',
        nameKey: 'deluxe',
        name: 'Deluxe',
        sizeText: '1830 ft',
        description: 'Vista',
        images: ['https://img.example/1.jpg'],
      },
      {
        lang: 'en',
        roomKey: 'n-0123456789abcdef',
        roomRef: null,
        nameKey: null,
        name: null,
        sizeText: null,
        description: null,
        images: null,
      },
    ]);
  });
});

describe('storeRoomContents: por la función de 0070', () => {
  it('manda proveedor, hotel, idioma, resultado y las habitaciones con los nombres del contrato', async () => {
    const { db, store } = tienda();

    const res = await store.storeRoomContents(PROVEEDOR, HOTEL, 'es', 'rooms', [habitacion(1)]);

    const [q] = db.consultasMarcadas('store-room-contents');
    expect(q?.sql).toContain('hotel_catalog_store_room_contents');
    expect(q?.parameters.slice(0, 4)).toEqual([PROVEEDOR, HOTEL, 'es', 'rooms']);
    expect(JSON.parse(String(q?.parameters[4]))).toEqual([habitacion(1)]);
    expect(res).toEqual({ stored: 1, rejected: 0 });
  });

  it('a lo sumo el tope de la función, y sin habitaciones si el resultado no es `rooms`', async () => {
    const { db, store } = tienda();
    const muchas = Array.from({ length: HOTEL_ROOM_CONTENT_MAX_ROOMS + 5 }, (_, i) =>
      habitacion(i),
    );

    await store.storeRoomContents(PROVEEDOR, HOTEL, 'en', 'rooms', muchas);
    await store.storeRoomContents(PROVEEDOR, HOTEL, 'en', 'none', muchas);

    const [rooms, none] = db.consultasMarcadas('store-room-contents');
    expect(JSON.parse(String(rooms?.parameters[4]))).toHaveLength(HOTEL_ROOM_CONTENT_MAX_ROOMS);
    expect(JSON.parse(String(none?.parameters[4]))).toEqual([]);
  });

  it('un emoji partido por un recorte o un `\\u0000` no tumban la llamada: salen del texto', async () => {
    const { db, store } = tienda();
    const partida = {
      ...habitacion(1),
      roomRef: null,
      nameKey: 'suite\u0000',
      name: `Suite ${'\uD83D'}`,
      sizeText: '30 m2 \uDE00',
      description: `Vista 😀 al mar ${'\uD83D'}`,
      images: ['https://img.example/1.jpg\u0000'],
    };

    await store.storeRoomContents(PROVEEDOR, HOTEL, 'es', 'rooms', [partida]);

    const [q] = db.consultasMarcadas('store-room-contents');
    const json = String(q?.parameters[4]);
    expect(json).not.toMatch(/\\u(d[89ab][0-9a-f]{2}|d[c-f][0-9a-f]{2}|0000)/i);
    expect(JSON.parse(json)).toEqual([
      {
        ...habitacion(1),
        roomRef: null,
        nameKey: 'suite',
        name: 'Suite ',
        sizeText: '30 m2 ',
        description: 'Vista 😀 al mar ',
        images: ['https://img.example/1.jpg'],
      },
    ]);
  });

  it('los conteos de la base se leen como números; sin fila, cero', async () => {
    expect(
      await tienda({ guardar: [{ stored: '2', rejected: '1' }] }).store.storeRoomContents(
        PROVEEDOR,
        HOTEL,
        'es',
        'rooms',
        [habitacion(1), habitacion(2), habitacion(3)],
      ),
    ).toEqual({ stored: 2, rejected: 1 });
    expect(
      await tienda({ guardar: [] }).store.storeRoomContents(PROVEEDOR, HOTEL, 'es', 'none', []),
    ).toEqual({ stored: 0, rejected: 0 });
  });
});
